# AG08 — Memoria a nivel de usuario: hechos en `user_financial_state`, diálogo por conversación (migración 021)

**Fecha:** 11 de agosto de 2026
**Rama:** `agent/08` reseteada a `origin/develop` @ `7c246c4` + esta tanda
**Gate de arranque:** verificado antes de tocar nada — `'mis gastos fueron 1200: internet 300, agua 400, gas 500'` → **1200** (no 2400). V15/V16 está en develop; el merge anterior sí ocurrió.

---

## 0 · El problema que cierra

`scenario_state` se leía de `conversations` filtrando por `conversationId` y se escribía en `conversations`. Cada conversación nueva arrancaba **vacía**: amnesia entre sesiones por diseño. Contradice el ADN ("seguimiento constante") y era incoherente con `goals`, que ya vivía a nivel de usuario. Un usuario del piloto que abriera la app el día 2 se habría encontrado a monoend preguntándole otra vez su ingreso, su meta y su desglose.

**Decisión de arquitectura (Luis, opción A):** los HECHOS financieros son del USUARIO; el estado de DIÁLOGO es de la CONVERSACIÓN.

---

## 1 · Confirmación de la restricción de diseño central

> **La FORMA del objeto `ScenarioState` en memoria NO CAMBIA.** Cambian solo el ORIGEN y el DESTINO de la persistencia.

- **Cero campos añadidos, renombrados o eliminados** en la interfaz `ScenarioState`. El `git diff` sobre la interfaz es vacío.
- Lo que se añadió son tres **listas de clasificación** (`CAMPOS_HECHOS`, `CAMPOS_DIALOGO`, `CAMPOS_TRANSITORIOS`) y dos funciones puras (`splitScenarioState`, `mergeEstadoPersistido`) que parten y reconstruyen ese mismo objeto.
- El pipeline recibe exactamente el mismo objeto que antes: `route.ts` fusiona las dos mitades **antes** de que nada aguas abajo lo vea.
- Test de ida y vuelta sin pérdida: `split + merge es IDEMPOTENTE` (comparado sobre el round-trip JSON, que es lo que hace `jsonb` — ver §5).

**Archivos que NO se tocaron, verificado con `git diff --quiet` uno a uno:**

```
SIN TOCAR  src/lib/calculator/orchestrator.ts
SIN TOCAR  src/lib/guardrail/validate.ts
SIN TOCAR  src/lib/guardrail/policy.ts
SIN TOCAR  src/lib/guardrail/commandments.ts
SIN TOCAR  src/lib/calculator/expenses.ts
SIN TOCAR  scripts/regression-harness.ts
```

---

## 2 · Declaración de impacto

| Archivo | Qué cambió | Por qué |
|---|---|---|
| `supabase/migrations/021_user_financial_state.sql` (nuevo) | Tabla `user_financial_state` + RLS + GRANTs a `service_role` + política de lectura propia + columna `user_state_persist_failed` + backfill idempotente | PIEZA 1 |
| `src/lib/calculator/scenario.ts` | +`CAMPOS_HECHOS`/`CAMPOS_DIALOGO`/`CAMPOS_TRANSITORIOS`, +`splitScenarioState`, +`mergeEstadoPersistido`. **La interfaz `ScenarioState` no se tocó.** | PIEZA 3 |
| `src/lib/persistence.ts` | +`persistUserFinancialState`; `persistTurn` parte el estado y escribe las dos mitades; `writesTotal` 4→5; +`userStateOk` en el resultado | PIEZA 3 |
| `src/app/api/chat/route.ts` | Lectura de `user_financial_state` por `user_id` + fusión con el diálogo de la conversación | PIEZA 2 |
| `src/lib/telemetry.ts` | +`userStatePersistFailed` → columna `user_state_persist_failed` | PIEZA 4 |
| `scripts/e2e-turn.ts` | +`leerEstadoPersistido`/`leerSoloDialogo`, +T7 (dos conversaciones), lectura de T6-A adelantada, cleanup de la fila de usuario | Tests |
| `src/lib/calculator/scenario.test.ts` | +8 tests unitarios de la partición | Tests |

**Eliminado:** nada. `conversations.scenario_state` se conserva (estado de diálogo + respaldo del backfill).

### La partición

- **HECHOS** (21 campos, viajan): `ingreso_mensual`, `gastos_mensuales`, `gastos_detalle`, `gastos_es_detalle`, `gastos_items`, `tiene_agregado_gastos`, `tiene_detalle_gastos`, `credito`, `meta`, `meta_derivada`, `goals_cerradas`, `extraction_status`, `factStatus`, `detalle_confirmado`, `gastos_conflict`, `gastos_assumed`, `gastos_superseded`, `gastos_superseded_colapsados`, `gastos_agregado_origen`, `gastos_detalle_origen`, `turn`.
- **DIÁLOGO** (6 campos, no viajan): `propuesta_pendiente`, `plan_confirmado`, `meta_cerrada`, `digresiones_seguidas`, `eco_pendiente`, `missing`.
- **TRANSITORIOS** (5, no se persisten en ningún lado): `meta_cambio_explicito`, `detalle_confirmado_explicito`, `gastos_item_correccion`, `gastos_resolucion`, `gastos_assumed_confirmado`.

**Dos clasificaciones que justifico explícitamente porque no venían dadas en el encargo:**

- **`turn` → HECHO.** Es el reloj que fecha los hechos: los orígenes, el historial SUPERSEDED y el conflicto guardan el turno en que ocurrieron. Si se reiniciara al abrir una conversación, esos turnos ya grabados quedarían en el futuro y la auditoría dejaría de ser legible.
- **`missing` → DIÁLOGO.** Es derivado (`computeMissing` lo recalcula entero en cada merge), no un dato aportado por el usuario. Clasificarlo como hecho lo haría viajar como si lo fuera.

`attempts` viaja dentro de `gastos_conflict`, es decir, como HECHO — tal como pide el encargo: abrir un chat nuevo no reinicia el contador ni permite esquivar el escape de §6.

### La garantía anti-reincidencia

`splitScenarioState` **lanza** si encuentra un campo que no está en ninguna de las tres listas. No asume un lado por defecto. En producción `persistTurn` captura ese throw, lo registra como fallo crítico y deja que el turno del usuario continúe (la conversación se guarda igual; lo que se pierde es la promoción de los hechos, y la telemetría lo deja visible). En los tests revienta de inmediato — que es donde debe reventar.

---

## 3 · Salida del caso de dos conversaciones

Ejecutado en memoria por el mismo camino que producción (`e2e` hace SKIP sin credenciales Supabase en este sandbox; T7 replica esto contra BD real con re-lectura):

```
── FILA user_financial_state (hechos) ──
{
  "ingreso_mensual": 2300,
  "gastos_mensuales": 2200,
  "meta": { "titulo": "casa", "monto": 150000 },
  "items": 15,
  "conflict": { "agregado": 2200, "detalle": 2250, "diff": 50,
                "diffPct": 2.272727272727273, "attempts": 0, "detalleCompleta": true }
}

── FILA conversations.scenario_state de A (solo diálogo) ──
{"missing":["plazo"],"eco_pendiente":{"fields":["gastos_detalle"]},
 "digresiones_seguidas":2,"plan_confirmado":true,"propuesta_pendiente":{"fields":["plan"]}}

── ESTADO QUE VE LA CONVERSACIÓN B (chat NUEVO, scenario_state vacío) ──
{
  "ingreso_mensual": 2300,           ← recuerda
  "gastos_mensuales": 2200,          ← recuerda
  "meta_monto": 150000,              ← recuerda
  "gastos_items": 15,                ← recuerda las 15 partidas
  "conflict_attempts": 0,
  "conflict": "2200 vs 2250",        ← el conflicto sigue abierto
  "digresiones_seguidas": undefined, ← el diálogo de A NO se filtra
  "propuesta_pendiente": undefined,
  "plan_confirmado": undefined
}
missing en B: ["plazo"]              ← NO pide 'ingreso' ni 'gastos'
```

Los seis puntos del encargo quedan cubiertos: (1) A declara todo, (2) B es una conversación nueva del mismo usuario, (3) B trae ingreso/gastos/meta/15 partidas, (4) `missing` no contiene `ingreso` ni `gastos`, (5) el diálogo de A no se filtra, (6) el conflicto sigue abierto con sus `attempts` intactos. Y la contraparte que T7 también afirma: los hechos **ya no** están en `conversations.scenario_state`.

---

## 4 · Validación

```
npx tsc --noEmit         → limpio
npm test                 → 14/14 OK
npm run test:guardrail   → 262/262 OK
npm run test:calculator  → 260/260 OK   [15+33+24+173+15 — 173 = 165 previos + 8 nuevos]
npm run test:regression  → 84/84 turnos OK · 47 escenarios
npm run build             → TypeScript compila; falla en el prerender de /login por
                             credenciales Supabase ausentes en el sandbox. Preexistente,
                             no es regresión.
npm run test:e2e          → SKIPPED (sin credenciales). T7 añadido y verificado en memoria (§3).
npm run smoke:db          → SKIPPED (misma razón).
```

### Regresiones confirmadas

```
G1c sentido 1 (agregado→detalle): {"agregado":2200,"detalle":2250,"diff":50,"diffPct":2.272727272727273}
G1c sentido 2 (detalle→agregado): {"agregado":2200,"detalle":2250,"diff":50,"diffPct":2.272727272727273}
G1c IDÉNTICOS: true
testdev7: 15 ítems, suma 2250
'gasto 2 500 €' → 2500
'mis gastos fueron 1200: …' → 1200        (V16)
'sueldo 3000, quiero un piso de 200000' → ingreso 3000, meta 200000   (V15)
```

`V14` (conservación), `V15` (atribución) y `V16` (no doble conteo) siguen verdes vía el test estructural de atribución única de la tanda anterior, intacto. `V2/V3/V4/V6/V7` sin cambios: `reconciliarGastos` no se tocó. `persistTurn` sigue siendo el único punto de escritura (ahora con cinco escrituras en vez de cuatro, todas contabilizadas).

---

## 5 · Dos decisiones que conviene que Luis vea

**a) Un test de idempotencia se afirmó sobre el round-trip JSON, no sobre el objeto crudo.** `mergeScenario` deja algunas claves presentes con valor `undefined` (p. ej. `gastos_assumed` cuando no hay supuesto activo); `mergeEstadoPersistido` no las reconstruye. Da igual: `jsonb` no distingue "clave ausente" de "clave con `undefined`" — `JSON.stringify` elimina las segundas. Exigir que sobrevivan sería afirmar una fidelidad que la BD no da. El test compara por el camino real y lo dice en un comentario.

**b) Varias afirmaciones del `e2e` cambiaron de DÓNDE leen, no de QUÉ afirman.** T1/T3/T4/T5 leían hechos de `conversations.scenario_state`; esos hechos ahora viven en `user_financial_state`. Se introdujo `leerEstadoPersistido`, que hace exactamente la misma lectura fusionada que `route.ts`, y las afirmaciones quedaron **literalmente iguales**. No es reescribir un test para que afirme lo contrario (V11): el requisito ("estos hechos sobreviven a un ciclo real de escritura→re-lectura") es idéntico; lo que esta tanda mueve a propósito es su ubicación. Leer por el mismo camino que producción es lo que mantiene el test honesto.

Además, en T6 la lectura del sentido A se **adelantó** para hacerse justo tras su secuencia: al ser los hechos ahora por usuario, leerla al final habría devuelto los hechos de la secuencia B y el test habría comparado B contra B sin probar nada.

---

## 6 · Pendiente de Luis

**La migración 021 NO se ejecutó** (así lo pide el protocolo) y **debe correrse ANTES del merge**: la lectura de `route.ts` y la escritura de `persistTurn` la asumen. Sin ella, la lectura degrada al estado de la conversación con un `console.error` explícito (comportamiento anterior a esta tanda, nunca en silencio), pero la escritura de hechos fallaría y quedaría marcada en telemetría como `user_state_persist_failed`.

Los GRANTs a `service_role` van **en la misma migración que crea la tabla** — la 018 existió porque a `goals` le faltaban y solo se detectó cuando `test:e2e` intentó escribir. Ese fallo no se repite aquí.
