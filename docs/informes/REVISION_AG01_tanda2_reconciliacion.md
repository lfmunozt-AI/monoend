# APROBADO CON RESERVAS

> **VEREDICTO VIGENTE** — segunda revisión de la tanda 2, `agent/08` @ `986980e`, 8 de agosto de 2026.
> Los tres bloqueantes de la primera revisión están cerrados y **G1c queda cerrado** (canónico y
> ruta de escape). **Ir a [SEGUNDA REVISIÓN](#segunda-revisión--agent08--986980e--8-de-agosto-de-2026).**
>
> Documento acumulativo: conserva las dos revisiones en orden cronológico. El veredicto de la
> primera (RECHAZADO) es **histórico** y se refiere a un commit ya superado.

| # | Commit revisado | Fecha | Veredicto |
|---|---|---|---|
| 1 | `f5f1dc9` | 7 ago | RECHAZADO — G1c asimétrico en el escape · ASSUMED no revocable · cap sin verificar |
| **2** | **`986980e`** | **8 ago** | **APROBADO CON RESERVAS** — los 3 bloqueantes cerrados; 3 condiciones |

---
---

# RECHAZADO

> **Revisión adversarial — AG08, tanda 2: reconciliación cross-turno (Gate G1c)**
> Revisor: AG01 (Arquitecto) · 7 de agosto de 2026
> Rama revisada: `origin/agent/08` @ `f5f1dc9` (1 commit por delante de `develop` @ `155987f`)
> Contrato: `docs/CONTRATO_TRUTH_ENGINE.md` §2, §4 paso 4, §6, §7, §8 + casos 1-8 de §10 + E1-E6
> Método: batería reproducida entera; **G1c ejecutado en los dos sentidos contra el código real**;
> 7 formas de resolución, 8 de confirmación y 3 mensajes nuevos de diseño propio para intentar
> romper V14; cada hallazgo contrastado contra `develop` para separar regresión de defecto
> preexistente.
> No se tocó código de AG08, no se mergeó nada, no se pusheó código.

---

## 1 · G1c — ¿PASA?

### **PASA en el caso canónico (casos 4 y 5 del contrato). NO PASA en la ruta de escape.**

**Caso canónico — ambas fuentes `COMPLETE`** (ejecutado con `mergeScenario` real, deltas explícitos):

```
Sentido 1 (T1 agregado 2200 → T2 desglose 2250):
  {"agregado":2200,"detalle":2250,"diff":50,"diffPct":2.272727272727273}
Sentido 2 (T1 desglose 2250 → T2 agregado 2200):
  {"agregado":2200,"detalle":2250,"diff":50,"diffPct":2.272727272727273}
                                        → IDÉNTICOS ✅
```

Además, verificado más allá de lo que pide el bloque A:

- **Sobrevive re-lectura**: tras `JSON.parse(JSON.stringify(state))` (round-trip jsonb, el mismo
  que hace `scenario_state`), el conflicto se conserva íntegro **y sigue bloqueando** las derivadas
  (`sobrante` ausente de `conceptos` en ambos sentidos).
- **V2**: `gastos_mensuales` queda congelado durante el conflicto y no se sobrescribe ni cuando un
  turno posterior toca otro campo.
- `factStatus.gastos_mensuales = "CONFLICT"` en ambos sentidos.

### Pero la bidireccionalidad se rompe cuando el desglose no es `COMPLETE`

```
A (T1 desglose PARTIAL → T2 agregado):  detalleCompleta = true   → tras 2 intentos: ASSUMED 2250
B (T1 agregado → T2 desglose PARTIAL):  detalleCompleta = false  → tras 2 intentos: sin ASSUMED
```

**Los mismos dos hechos, en distinto orden, terminan en estados distintos.** Eso es exactamente lo
que G1c existe para impedir. Y el sentido A **viola §6**, que exige las tres condiciones para el
escape — la primera es *"extracción del detalle `COMPLETE`"*: el sistema adopta como supuesto una
cifra proveniente de una extracción incompleta.

**Causa raíz**, `src/lib/calculator/scenario.ts:~1576` (rama `traeAgregado` de `reconciliarGastos`):

```ts
detalleCompleta: true,   // ← hardcodeado
// comentario: "El desglose se resolvió en un turno YA pasado con COMPLETE
//              (única vía por la que `gastos_detalle_origen` se fija)"
```

**Ese comentario es falso.** `gastos_detalle_origen` se fija en la rama `traeDetalle`
(`scenario.ts:~1539`) **sin condicionar a `extraction_status`** — un desglose `PARTIAL` fija el
origen igual. Por eso el hardcode convierte en "completo" algo que nunca se comprobó.

---

## 2 · Hallazgos priorizados

### 🔴 BLOQUEANTE B1 — Escape asimétrico: se asume una cifra de extracción incompleta

**Archivo:** `src/lib/calculator/scenario.ts:~1576` (`detalleCompleta: true`), origen fijado sin
condición en `:~1539`.

Detallado arriba. **Por qué es bloqueante:** (a) rompe G1c, el gate de piloto que esta tanda venía
a cerrar; (b) viola la precondición explícita de §6; (c) el resultado es que el sistema **adopta
como verdad de trabajo** un total derivado de un desglose con huérfanos sin asignar — el modelo lo
declarará como supuesto, pero la cifra ya está mal.

**Corrección:** persistir la calidad de la extracción junto al origen (p. ej.
`gastos_detalle_origen: { valor, turn, completa }`) y leer ese flag en la rama `traeAgregado`, en
vez de asumir `true`. Criterio de aceptación: los dos sentidos de la tabla A/B deben coincidir en
`detalleCompleta` y en el estado final tras 2 intentos.

---

### 🔴 BLOQUEANTE B2 — `ASSUMED` no es revocable (§6 dice "revocable siempre", V6)

**Archivo:** `src/lib/calculator/scenario.ts` — `reconciliarGastos`, bloque 0: la única salida de
`ASSUMED` es `delta.gastos_assumed_confirmado`; **no existe rama de revocación/corrección**.

Ejecutado contra un estado con `ASSUMED {valor: 2250}`, **7 formas de corrección, las 7 ignoradas**:

```
"en realidad son 2200"    → delta {}      → assumed sigue 2250, gastos 2250
"no, son 2200"            → delta {}      → assumed sigue 2250
"corrige: 2200"           → delta {}      → assumed sigue 2250
"usa 2200"                → delta {}      → assumed sigue 2250   ← funciona con CONFLICT, no con ASSUMED
"eran 2200"               → delta {}      → assumed sigue 2250
"me equivoqué, son 2200"  → delta {}      → assumed sigue 2250
"mis gastos son 2200"     → delta {agg}   → assumed 2250 Y conflict activo a la vez (estado incoherente)
```

`detectarResolucionConflicto` solo se invoca si `seed.gastos_conflict` existe
(`route.ts:387`) — cuando el conflicto ya escapó a `ASSUMED`, **ninguna corrección del usuario se
reconoce**. El usuario que dice "en realidad son 2200" es ignorado y el sistema sigue calculando
sobre 2250 indefinidamente.

Además, el último caso deja `gastos_assumed` **y** `gastos_conflict` activos simultáneamente — un
estado que ninguna de las dos máquinas de §2 contempla.

**Corrección:** invocar `detectarResolucionConflicto` también con `gastos_assumed` activo
(reconstruyendo el par agregado/detalle desde los orígenes), y añadir la rama de revocación en
`reconciliarGastos`. Criterio: las 7 frases de arriba deben revocar el supuesto.

---

### 🟠 MAYOR M1 — Confirmar el supuesto solo funciona con 3 de 8 frases naturales

**Archivo:** `scenario.ts` — `esConfirmacionCorta`, usada para `gastos_assumed_confirmado`.

```
"sí" ✅   "vale" ✅   "ok" ✅
"sí, correcto" ❌   "correcto" ❌   "confirmo" ❌   "exacto" ❌   "sí, es correcto" ❌
```

El informe de AG08 (§2) afirma *"Revocable: una confirmación corta (`esConfirmacionCorta`) lo
cierra (V6)"*. Es cierto solo para la forma escueta. **"sí, correcto" — la confirmación más
natural — no cierra el supuesto**, que queda `ASSUMED` para siempre y obliga al modelo a
declararlo en cada respuesta relevante. Combinado con B2 (no revocable), el supuesto es
prácticamente **absorbente**: difícil de confirmar, imposible de corregir.

---

### 🟠 MAYOR M2 — El cap de historial (§8) no está verificado por ninguna prueba

**Archivo:** `scenario.ts` (`pushSuperseded`, no exportado) · `scenario.test.ts:1394-1396`.

El único aserto sobre `gastos_superseded` comprueba `length === 1` tras una resolución. **No hay
test del cap de 5 ni del contador `gastos_superseded_colapsados`.** Intenté ejercitarlo por la vía
pública con 8 ciclos conflicto→resolución y el array se quedó en 1 entrada (los ciclos derivaban a
escape `ASSUMED` en vez de acumular supersededs), y `pushSuperseded` no está exportado para
probarlo directamente.

**No afirmo que el cap esté roto** — la lógica existe y se lee correcta. Afirmo que **es la única
pieza de §8 que nadie ha ejercitado**, ni AG08 ni yo. Dado que §8 existe para impedir que el jsonb
crezca sin límite y suba la latencia de cada turno, merece un test antes del piloto.

---

### 🟡 MENOR m1 — Formas de resolución no reconocidas (riesgo de bucle)

**Las 4 formas exigidas por el bloque C.2 funcionan**: `"usa 2250"` ✅ · `"el correcto es el
desglose"` ✅ · `"me equivoqué, son 2250"` ✅ · `"quédate con el total"` ✅. También `"eran 2250"`,
`"usa el agregado"`, `"quédate con el desglose"`, `"usa 2200"`.

No reconocidas (invención mía, no exigidas): `"el bueno es el 2200"`, `"el bueno es el 2250"`,
`"son 2200"`. Con el conflicto activo, esas frases dejan la conversación repitiendo la pregunta.
No es asimetría agregado/detalle (falla con ambos valores) sino cobertura de fraseo.

---

### 🟡 MENOR m2 — Doble conteo con "gasté" (PREEXISTENTE, idéntico en `develop`)

```
"gasto 1800: renta 900, mercado 450, transporte 200, cine 250"  → gastos 1800 ✅
"gasté 1800: renta 900, mercado 450, transporte 200, cine 250"  → gastos 3600 ❌  (COMPLETE)
```

`GASTO_CTX` (`scenario.ts:238`) no cubre el pretérito acentuado `gasté`, así que el total declarado
se convierte en un ítem más **y** el desglose se suma aparte: los gastos se duplican, y el turno
sale `COMPLETE` sin ninguna señal. **Idéntico en `develop`** → no es regresión de esta tanda.

Es la demostración de que **V14 (conservación) no cubre la atribución**: ningún número desaparece
—por eso el balance cuadra y nada se marca— pero el total es el doble del real. Misma familia que
V15, que esta tanda sí resolvió para `"gasto 1500 en total:"`.

---

### ⚪ Nota de proceso — E7/E8 y V14/V15 no existen en el contrato

El encargo cita "las enmiendas E1-E8" y "V15 (enmienda E8)". El contrato en la rama contiene
**E1-E6** y **V1-V13**: no hay E7 ni E8, y **V14 (conservación) y V15 (atribución) no están
escritos**. AG08 lo señala honestamente en §10 de su informe en vez de fingir que cumplía una
enmienda inexistente — correcto por su parte.

Los juzgué por contenido: **V15 se cumple** (`"gasto 1500 en total: casa 700, comida 300"` →
`casa=700`, `comida=300`, agregado 1500 ✅) y **E3 queda resuelta** (`"gano 2300 y quiero una
casa"` → `meta` ahora `undefined`, ya no captura el ingreso ✅). Pero es la tercera tanda seguida
en que un invariante vive solo en un prompt: **hay que escribir V14 y V15 en §9.**

---

## 3 · Casos 1-8 de §10 (§ "Reconciliación") + extras

| # | Escenario | Test existe | Ejercita ruta real | Pasa (mi ejecución) |
|---|---|---|---|---|
| 1 | 2200 · detalle 2200 | Sí | Sí | ✅ sin conflicto |
| 2 | mismo turno 2200 + detalle 2250 | Sí | Sí | ✅ conflict +50, derivadas ausentes |
| 3 | 2200 vs 2150 | Sí | Sí | ✅ diff −50 |
| 4 | T1 2200 → T2 detalle 2250 | Sí | Sí | ✅ conflict +50 |
| 5 | T1 detalle 2250 → T2 2200 | Sí | Sí | ✅ **idéntico al 4** (G1c canónico) |
| 6 | T3 "eran 2250" | Sí | Sí | ✅ 2250 CONFIRMED, 2200 SUPERSEDED |
| 7 | dos turnos sin resolver → ASSUMED | Sí | Sí | ✅ ASSUMED 2250 · ⚠️ pero ver B1/B2 |
| 8 | 2200 vs 6000 (>5%) | Sí | Sí | ✅ reinicio, **jamás ASSUMED** |
| **Materialidad — fronteras exactas (mías)** | | | | |
| — | diff 0.5 € | — | Sí | ✅ CONSISTENT |
| — | diff **exactamente 1 €** | — | Sí | ✅ CONSISTENT (frontera correcta) |
| — | diff 1.5 € | — | Sí | ✅ CONFLICT |
| — | diff **exactamente 5%** (110/2200) | — | Sí | ✅ CONFLICT elegible → escapa |
| — | 5.045% (111/2200) | — | Sí | ✅ reinicio |
| **Regresión tanda 1 (bloque E)** | | | | |
| — | `"gano 2000 y gasto en arriendo 800…"` | Sí | Sí | ✅ 1200 |
| — | `"quiero una casa … casa 700…"` | Sí | Sí | ✅ 1090 |
| — | idem con `financiar` | Sí | Sí | ✅ 1090 (idéntico) |
| — | testdev7 | Sí | Sí | ✅ 15 ítems, suma 2250 |
| — | `"gasto 2 500 €"` | Sí | Sí | ✅ 2500 |
| — | V14 con 3 mensajes nuevos míos | — | Sí | ✅ 0 sin destino, status nunca `undefined` |
| — | Fronteras posicionales (`rangosReclamados: Rango[]`) | Sí | Sí | ✅ siguen siendo rangos, no `Set` |

---

## 4 · Invariantes V1-V15

| # | Estado | Evidencia |
|---|---|---|
| **V1** | ✅ | Ningún camino descarta datos con confianza; el conflicto congela, no borra. |
| **V2** | ✅ | `gastos_mensuales` no se sobrescribe durante `CONFLICT`, ni al tocar otros campos. |
| **V3** | ⚠️ **Parcial** | Con detalle `PARTIAL` **sí se declara** `CONFLICT` (el contrato dice no declararlo si alguna fuente no es `COMPLETE`). Se mitiga porque marca `detalleCompleta: false` e impide el escape… **salvo en el sentido A de B1**, donde el hardcode lo permite. |
| **V4** | ✅ | Bloqueadas: `gastos_mensuales`, sobrante/déficit, capacidad anual, brecha, esfuerzo total, recorte 50%, nueva capacidad. No bloqueadas: cuota (`548.22` con conflicto activo), clasificación vital/no-vital, `ahorro_necesario_mensual`. Verificado en `conceptos`. |
| **V5** | ✅ | No tocado. |
| **V6** | ❌ **Violado** | `ASSUMED` no es revocable (B2) y solo confirmable con 3 de 8 frases (M1). Sí es *re-emergente*: `notaConflictoGastos` declara el supuesto mientras siga activo. |
| **V7** | ✅ | `superseded = [{valor:2200, motivo:"USER_CORRECTION", turn:3}]` — valor, motivo y turno. |
| **V8** | ✅ | `"gano 0"`/`"gasto 0"` → `INVALID`, sin campo financiero. |
| **V9** | ✅ (round-trip) / ⚠️ (BD) | El conflicto sobrevive round-trip jsonb y sigue bloqueando. Contra BD real: `e2e-turn.ts` extendido con T5a-T5c, **no verificable por mí** (credenciales). |
| **V10** | ✅ | No aplica: esta tanda no añade sustituciones de texto. |
| **V11** | ✅ | Los 2 fixtures modificados (`deficit_detalle_manda`, `entrega_gastos`) codificaban el comportamiento que §6 **sustituye explícitamente** (el detalle pisaba al agregado sin mirar magnitud). Está declarado en §5 del informe, con la descripción del fixture actualizada. No es tapar un bug: es el requisito nuevo. |
| **V12** | ✅ | Sin regresión. |
| **V13** | ✅ | `rangosReclamados: Rango[]` intacto — siguen siendo rangos posicionales. |
| **V14** | ✅ | 3 mensajes nuevos míos: 0 números sin destino, `extraction_status` nunca `undefined`. |
| **V15** | ✅ | `"gasto 1500 en total: casa 700, comida 300"` → atribución correcta. *(Pero ver m2: `"gasté"` sigue duplicando — preexistente.)* |

**Bloque I — sin texto enlatado:** ✅ `notaConflictoGastos` entrega **datos** (`valor_agregado`,
`valor_detalle`, `diferencia`, `intentos_previos`) e instruye literalmente *"Redacta tú, con tu
propia voz … no copies este formato ni uses una frase fija"*. Incluye además qué se puede y qué no
se puede calcular. Es el mejor ejemplo del principio §0 en todo el repo.

**Bloque J — migración 020:** ✅ las 5 columnas son NULLABLE (`text`, `numeric`, `integer`,
`text[]`, sin `NOT NULL`); `add column if not exists` + `create index if not exists`; **no
ejecutada** (archivo `.sql`, la corre Luis); nota de retención en cabecera y en `comment on column`
de las cinco. **Payload ↔ columna verificado uno a uno**: `conflictStatus→conflict_status`,
`conflictField→conflict_field`, `conflictDiff→conflict_diff`,
`conflictAttempts→conflict_attempts`, `assumedFields→assumed_fields`. Sin desajustes (el fallo de
la 016 no se repite).

**Bloque K — declaración de impacto:** ✅ contrastada contra el diff real, coincide íntegra
(scenario.ts, orchestrator.ts, route.ts, expenses.ts, telemetry.ts, migración 020, e2e-turn.ts, 2
fixtures). El cambio de `expenses.ts` (descarte de `pendingAmount` en un encabezado con `:`) está
declarado como V15. "Eliminadas: ninguna" es cierto. `persistTurn` sigue siendo el **único** punto
de escritura (1 llamada); `notaConflicto` está inyectado en **ambas** rutas de generación
(`systemPrompt2` y `systemPromptRegen`).

---

## 5 · Riesgos de DEADLOCK (bloque C)

**Lo bueno — el bloqueo NO es global**, que era el riesgo mayor:

```
con gastos en CONFLICT → conceptos = ["cuota","ingreso","monto","plazo","tae","ahorro_necesario_mensual"]
  cuota = 548.22 ✅ (sigue calculándose)   sobrante ✅ bloqueado   capacidad_anual ✅ bloqueada
  clasificación vital/no-vital ✅ no bloqueada
```

monoend **no se queda mudo** con un conflicto activo: sigue respondiendo cuota, ingreso y ahorro
necesario. §7 está bien implementado.

**Los deadlocks reales que sí encontré**, en orden de gravedad:

1. **`ASSUMED` absorbente (B2 + M1).** Difícil de confirmar (3 de 8 frases), **imposible de
   corregir** (0 de 7). Un usuario que quiere rectificar el supuesto no tiene salida: el sistema
   seguirá calculando sobre una cifra que él ya desmintió. Es el deadlock más grave porque afecta
   al estado *después* de que el sistema haya decidido por su cuenta.
2. **Estado incoherente `ASSUMED` + `CONFLICT` simultáneos** (`"mis gastos son 2200"` sobre un
   supuesto activo). Ninguna máquina de §2 contempla esa combinación; el comportamiento posterior
   no está definido por el contrato.
3. **Fraseos de resolución no cubiertos (m1)** — bucle de pregunta repetida mientras el conflicto
   sigue activo. Menor, porque las 4 formas exigidas funcionan.

---

## 6 · Recomendación explícita a Luis

**Devolver a AG08.** No revertir: el núcleo es sólido y G1c canónico **pasa de verdad** — lo
verifiqué en los dos sentidos, con round-trip, y el bloqueo granular evita el deadlock global que
era el gran riesgo de diseño. La materialidad está exacta en las tres fronteras, incluido el
`2200 vs 6000 → jamás ASSUMED`. La telemetría y la migración están impecables, y
`notaConflictoGastos` es el mejor ejemplo de "el sistema decide, el modelo redacta" del repo.

Pero **G1c es gate bloqueante de piloto** y tiene una asimetría real, y el ciclo de vida del
conflicto no se cierra: se puede entrar en `ASSUMED` y no se puede salir. Lista exacta:

1. **B1 (bloqueante).** Persistir la calidad del desglose junto al origen
   (`gastos_detalle_origen: { valor, turn, completa }`) y leerla en la rama `traeAgregado` de
   `reconciliarGastos` (`scenario.ts:~1576`), en vez del `detalleCompleta: true` hardcodeado.
   *Aceptación:* los dos sentidos con desglose `PARTIAL` deben coincidir en `detalleCompleta` y en
   el estado tras 2 intentos; ningún escape con extracción no-`COMPLETE` (§6).
2. **B2 (bloqueante).** Hacer `ASSUMED` revocable (V6/§6): invocar `detectarResolucionConflicto`
   también con `gastos_assumed` activo y añadir la rama de revocación.
   *Aceptación:* las 7 frases de corrección del hallazgo B2 revocan el supuesto; y `ASSUMED` +
   `CONFLICT` no pueden coexistir.
3. **M1 (mayor).** Ampliar `esConfirmacionCorta` (o usar un detector propio para el supuesto) a
   "sí, correcto", "correcto", "confirmo", "exacto", "sí, es correcto".
4. **M2 (mayor).** Añadir test del cap de 5 de §8 y del contador de colapsados — hoy nadie lo ha
   ejercitado. Exportar `pushSuperseded` o probarlo por la vía pública.
5. **Antes del merge:** ejecutar `test:e2e` (incluye los nuevos T5a-T5c, que son la única prueba de
   V9 contra BD real) y `smoke:db` — **no verificables por mí**, sin credenciales.

**Tickets aparte, no bloqueantes:** m1 (fraseos de resolución), m2 (`"gasté"` duplica — preexistente
e idéntico en `develop`, pero es un doble conteo silencioso que V14 no puede detectar; sugiero un
**V16 de atribución agregado↔ítems**: la suma de los ítems no puede exceder un agregado declarado en
el mismo mensaje sin marcar el turno).

**Decisión de Luis, no de un agente:** escribir **V14 y V15 en §9** del contrato y aclarar la
numeración E7/E8 (el encargo las cita, el documento tiene E1-E6). Tercera tanda seguida con
invariantes viviendo solo en prompts.

**Lo que NO hay que tocar:** `reconciliarGastos` como `reconcile(prev, delta)`, el bloqueo granular
de §7, la materialidad y sus fronteras, `notaConflictoGastos`, la migración 020 y la telemetría.

---

*Nota de método: batería reproducida en worktree aislado y desechable (`git worktree add --detach`,
eliminado al terminar), sin tocar el worktree de AG08 — `npm test` 14/14 · `test:guardrail` 262/262
· `test:calculator` 223/223 · `test:regression` 84/84 turnos · `tsc --noEmit` limpio · `npm run
build` falla solo en el prerender de `/login` por credenciales Supabase ausentes (preexistente,
idéntico en `develop`). G1c, materialidad, ciclo de vida del conflicto, deadlock y V14 se
ejecutaron contra `mergeScenario`, `reconciliarGastos`, `extractScenarioDelta`,
`buildScenarioContext`, `notaConflictoGastos` y `analizarExtraccion` reales, y los hallazgos se
contrastaron contra `develop` con el mismo script. `test:e2e` y `smoke:db`: no verificables por mí.*


---
---

# SEGUNDA REVISIÓN — `agent/08` @ `986980e` · 8 de agosto de 2026

## VEREDICTO: APROBADO CON RESERVAS

> **Revisión adversarial — AG08, correcciones a la tanda 2** (`f5f1dc9` + `986980e`)
> Revisor: AG01 (Arquitecto) · Base: `origin/develop` @ `155987f`
> Método: batería reproducida entera; **los 3 bloqueantes de mi revisión anterior re-ejecutados
> uno por uno**; 16 formulaciones de mi propio diseño para ASSUMED; 3 formas propias de
> "agregado: detalle"; 3 mensajes nuevos contra V14; cap de §8 ejercitado por la vía pública.
> Cada hallazgo contrastado contra `develop`.
> No se tocó código de AG08, no se mergeó nada, no se pusheó código.

---

## 1 · G1c — **PASA**, ahora también en la ruta de escape

**Canónico (ambas fuentes `COMPLETE`):**

```
A (T1 agg 2200 → T2 det 2250): {agregado:2200, detalle:2250, diff:50, diffPct:2.2727…, detalleCompleta:true}
B (T1 det 2250 → T2 agg 2200): {agregado:2200, detalle:2250, diff:50, diffPct:2.2727…, detalleCompleta:true}
                                                                            → IDÉNTICOS ✅
round-trip jsonb conserva el conflicto ✅ · sigue bloqueando `sobrante` tras la re-lectura ✅
```

**Ruta de escape (detalle `PARTIAL`) — el bloqueante que rechacé:**

```
A (det PARTIAL T1 → agg T2): detalleCompleta = false → tras 2 intentos: assumed = undefined
B (agg T1 → det PARTIAL T2): detalleCompleta = false → tras 2 intentos: assumed = undefined
                                        → SIMÉTRICO ✅ · NINGUNO escapa ✅
```

`agregado`, `detalle`, `diff`, `diffPct`, `attempts` y `detalleCompleta` coinciden en ambos
sentidos. *(Los únicos campos que difieren son `agregadoTurn`/`detalleTurn` — correcto: los turnos
de origen son genuinamente distintos, y el contrato exige conservarlos.)*

**Corrección verificada en el código, no en el informe:** `FuenteValor` gana `completa?: boolean`
(`scenario.ts:67-75`), los tres puntos que fijan `gastos_detalle_origen` guardan la calidad real, y
la rama `traeAgregado` lee `detalleOrigen.completa ?? false` (`scenario.ts:1730`) — **falla
cerrado**. El comentario falso que denuncié está reescrito con la explicación del bug real
(`:1724-1729`). El hardcode `detalleCompleta: true` ya no existe.

---

## 2 · Los tres bloqueantes anteriores — **los tres cerrados**

| Bloqueante (revisión anterior) | Estado | Evidencia (ejecución propia) |
|---|---|---|
| **B1** G1c asimétrico en el escape | ✅ Cerrado | Tabla de arriba; `detalleCompleta` derivado del `extraction_status` real |
| **B2** `ASSUMED` no revocable | ✅ Cerrado | **8/8** formas de corrección revocan (ver abajo) |
| **M1** confirmación solo con 3 de 8 frases | ✅ Cerrado | **8/8** formas de confirmación cierran el supuesto |
| **M2** cap de §8 sin verificar | ✅ Cerrado | Cap ejercitado por la vía pública: se sostiene en 5, `colapsados` correcto |

**ASSUMED revocable — 8 correcciones de mi diseño, sobre `ASSUMED {valor:2250}`:**

```
✅ "en realidad son 2200"  ✅ "no, son 2200"        ✅ "corrige: 2200"   ✅ "usa 2200"
✅ "el correcto es el total" ✅ "quédate con el agregado" ✅ "me equivoqué, son 2200" ✅ "eran 2200"
   → todas: gastos=2200 · assumed=undefined · factStatus=CONFIRMED
   · superseded=[{2250, "USER_CORRECTION"}]
```

**8 confirmaciones de mi diseño:** `"sí"`, `"vale"`, `"ok"`, `"sí, correcto"`, `"correcto"`,
`"confirmo"`, `"exacto"`, `"así es"` → **las 8** cierran el supuesto (2250 `CONFIRMED`).

**Coexistencia `ASSUMED` + `CONFLICT` — resuelta.** Un dato nuevo discrepante sobre un supuesto
activo lo archiva (`ASSUMED_SUPERSEDED_BY_NEW_DATA`) antes de decidir el estado nuevo:

```
"mis gastos son 2200" → assumed=undefined, conflict=sí   (nunca los dos)
"gasto 2100"          → assumed=undefined, conflict=no   (6.8% > 5% → reinicio, correcto)
"mis gastos son 2400" → assumed=undefined, conflict=no   (6.25% > 5% → reinicio, correcto)
```

**Cap §8 ejercitado de verdad** (8 ciclos conflicto→resolución sobre el mismo campo, vía
`mergeScenario`/`extractScenarioDelta` reales):

```
ciclo 1..5 → superseded 1,2,3,4,5 · colapsados 0
ciclo 6..8 → superseded 5,5,5     · colapsados 1,2,3     ← cap sostenido, contador 8−5=3 ✅
motivo y turno presentes en todas las entradas ✅
```

---

## 3 · Hallazgos

### 🟠 MAYOR M1 — El doble conteo sobrevive en cualquier fraseo con una palabra intermedia (PREEXISTENTE)

**Archivo:** `src/lib/calculator/scenario.ts` — `GASTO_AGREGADO_DETALLE_RE` (exige la cifra
inmediatamente tras la palabra clave) y la prueba probatoria de `extractScenarioDelta`.

**El caso exigido está corregido** (bloque L.1 — sin rechazo automático):

```
"gasté 1800: renta 900, comida 500, luz 400"
   develop  → 3600 ❌ (4 ítems, "gasté"=1800 fantasma)
   agent/08 → 1800 ✅ · 3 ítems · CONSISTENT · COMPLETE
```

Pero probé **3 formas propias de "agregado: detalle"** (como pide el bloque L.1) y las tres fallan:

| Mensaje | Real | `agent/08` | `develop` |
|---|---|---|---|
| `"mis gastos fueron 1200: internet 300, agua 400, gas 500"` | 1200 | **2400** ❌ (`fueron`=1200 fantasma, `COMPLETE`) | 2400 |
| `"gastamos 950 al mes: mercado 500, gasolina 250, farmacia 200"` | 950 | **1900** ❌ (`gastamos`=950 fantasma) | 1900 |
| `"el total que gasté es 700: telefono 200, ropa 300, cafe 200"` | 700 | **1200** ❌ (700 mal atribuido a `telefono`) | 1200 |
| `"mis gastos son 1200: internet 300, agua 400, gas 500"` | 1200 | **2100** ❌ (`PARTIAL`) | 2100 |

**Idénticos en `develop`** → **no es regresión de esta corrección**, y por eso no bloquea: mergear
deja el sistema estrictamente mejor que no mergear (arregla `"gasté"` y los tres bloqueantes; no
empeora nada).

**Pero importa:** `"mis gastos fueron 1200: …"` es una frase perfectamente natural, el resultado es
el **doble** de los gastos reales, y sale `COMPLETE` — sin huérfano, sin `AMBIGUOUS`, sin señal
alguna. V14 (conservación) no puede verlo porque ningún número desaparece; el agregado
simplemente se cuenta dos veces.

**Causa:** el arreglo de V16 cubre la palabra (`gaste`) pero el patrón sigue exigiendo que la cifra
vaya **pegada** a la palabra clave. Con cualquier verbo o muletilla intermedia (`fueron`, `son`,
`es`, o un sujeto como `gastamos`) no se reconoce agregado alguno, la prueba probatoria concluye
"esto es una lista" y el total declarado entra como una partida más. La guarda `aplicarGuardaV16`
tampoco puede actuar: compara los ítems contra `delta.gastos_mensuales`, que aquí es `undefined`.

**Recomendación (ticket, no bloqueo):** un **V16 generalizado** — cuando una lista va precedida de
`GASTO_CTX` + una cifra y termina en `:`, esa cifra es agregado, no partida; y como red, si la
suma de los ítems ≈ 2× una cifra presente en el mensaje, degradar a `AMBIGUOUS` en vez de
`COMPLETE`.

---

### ⚪ Discrepancia declarada por AG08 — verificada y correcta

Su informe (§1) señala que el encargo describía `"gasto 2200: renta 900, comida 500, luz 400"` como
`CONFLICT −400`, pero 400/2200 = **18,18 %**, muy por encima del 5 % de materialidad. Lo verifiqué:
es exacto. Producir `CONFLICT` ahí exigiría debilitar un umbral **ya aprobado y verificado en su
frontera exacta**. AG08 prefirió declarar la discrepancia antes que forzar el resultado del
encargo rompiendo una pieza aprobada — es la conducta correcta, y lo dejo constar.

---

### ⚪ Nota de proceso (tercera vez) — V14/V15/V16 siguen fuera del contrato

`docs/CONTRATO_TRUTH_ENGINE.md` contiene **E1-E6** y **V1-V13**. El encargo cita "E1-E8" y "V15
(enmienda E8)": **E7 y E8 no existen**, y V14 (conservación), V15 (atribución) y ahora V16 (doble
conteo) viven solo en prompts e informes. Los juzgo por contenido y **los tres se cumplen** en lo
que cubren. Pero es la tercera tanda seguida con invariantes sin sede en el contrato.

---

## 4 · Casos 1-8 de §10 + extras

| # | Escenario | Test existe | Ejercita ruta real | Pasa (mi ejecución) |
|---|---|---|---|---|
| 1 | 2200 · detalle 2200 | Sí | Sí | ✅ |
| 2 | mismo turno 2200 + 2250 | Sí | Sí | ✅ conflict +50, derivadas ausentes |
| 3 | 2200 vs 2150 | Sí | Sí | ✅ diff −50 |
| 4 | T1 2200 → T2 det 2250 | Sí | Sí | ✅ |
| 5 | T1 det 2250 → T2 2200 | Sí | Sí | ✅ **idéntico al 4** |
| 6 | T3 "eran 2250" | Sí | Sí | ✅ CONFIRMED + SUPERSEDED |
| 7 | 2 turnos sin resolver → ASSUMED | Sí | Sí | ✅ (y ahora revocable) |
| 8 | 2200 vs 6000 | Sí | Sí | ✅ reinicio, **jamás ASSUMED** |
| **Materialidad — fronteras (mías)** | | | | |
| — | exactamente 1 € | — | Sí | ✅ CONSISTENT |
| — | 1,5 € | — | Sí | ✅ CONFLICT |
| — | exactamente 5 % (110/2200) | — | Sí | ✅ elegible → escapa |
| — | 5,045 % (111/2200) | — | Sí | ✅ reinicio |
| **Bloque L (esta corrección)** | | | | |
| L.1 | `"gasté 1800: …"` → 1800, 3 ítems | Sí | Sí | ✅ **sin rechazo automático** |
| L.1 | 3 formas propias de "agregado: detalle" | No | Sí | ❌ M1 (preexistente, ver §3) |
| L.2 | G1c con detalle PARCIAL, dos sentidos | Sí | Sí | ✅ simétrico, ninguno escapa |
| L.3 | 8 correcciones + 8 confirmaciones | Sí | Sí | ✅ 16/16 |
| L.3 | ASSUMED y CONFLICT nunca coexisten | Sí | Sí | ✅ |
| L.4 | Cap §8 con 8 correcciones | Sí | Sí | ✅ máx 5, colapsados 3 |
| **Regresión tanda 1 (bloque E)** | | | | |
| — | `"gano 2000 y gasto en arriendo 800…"` | Sí | Sí | ✅ 1200 |
| — | `"quiero una casa … casa 700…"` / con `financiar` | Sí | Sí | ✅ 1090 / 1090 |
| — | testdev7 | Sí | Sí | ✅ 15 ítems, 2250 |
| — | `"gasto 2 500 €"` | Sí | Sí | ✅ 2500 |
| — | V14 con 3 mensajes nuevos míos | — | Sí | ✅ 0 sin destino, status nunca `undefined` |
| — | Fronteras posicionales (`Rango[]`) | Sí | Sí | ✅ siguen siendo rangos |

---

## 5 · Invariantes V1-V16

| # | Estado | Evidencia |
|---|---|---|
| **V1** | ✅ | El conflicto congela, no borra. |
| **V2** | ✅ | `gastos_mensuales` = 2200 durante el conflicto, y sigue 2200 tras un turno que toca otro campo. |
| **V3** | ✅ **Corregido** | Con detalle `PARTIAL`, `detalleCompleta=false` en **ambos** sentidos ⇒ no elegible para escape. La fuga que reporté está cerrada. |
| **V4** | ✅ | Bloqueadas: gastos, sobrante/déficit, capacidad, brecha, esfuerzo, recorte, nueva capacidad. No bloqueadas: `cuota` (548.22 con conflicto activo), vital/no-vital, `ahorro_necesario_mensual`. |
| **V5** | ✅ | No tocado. |
| **V6** | ✅ **Corregido** | 8/8 revocaciones, 8/8 confirmaciones; re-emergente vía `notaConflictoGastos`. |
| **V7** | ✅ | `[{valor:2200, motivo:"USER_CORRECTION", turn:3}]` — valor, motivo, turno. |
| **V8** | ✅ | Sin regresión. |
| **V9** | ✅ (round-trip) / ⚠️ (BD) | Conflicto sobrevive round-trip y sigue bloqueando. Contra BD real: `e2e-turn.ts` T6 añadido — **no verificable por mí** (credenciales). |
| **V10** | ✅ | No aplica. |
| **V11** | ✅ | No se reescribió ningún test para tapar nada; los 2 fixtures modificados en la tanda 2 responden al requisito de §6 y están declarados. |
| **V12** · **V13** | ✅ | Sin regresión; `rangosReclamados: Rango[]` intacto. |
| **V14** | ✅ | 3 mensajes nuevos míos: 0 sin destino, `extraction_status` nunca `undefined`. |
| **V15** | ✅ | `"gasto 1500 en total: casa 700, comida 300"` → `casa=700`, `comida=300`, agregado 1500. `meta.monto` ya no captura el ingreso. |
| **V16** | ⚠️ **Parcial** | Cubre el caso exigido (`"gasté 1800:"`); **no** cubre fraseos con palabra intermedia (M1, preexistente). |

**Bloque I — sin texto enlatado:** ✅ `notaConflictoGastos` entrega datos e instruye *"Redacta tú,
con tu propia voz … no copies este formato ni uses una frase fija"*. Sin cambios en esta corrección.

**Bloque J — migración 020:** ✅ **no tocada** por esta corrección (`git diff f5f1dc9..986980e`
no la incluye). Lo verificado en la revisión anterior sigue vigente: 5 columnas NULLABLE,
`if not exists`, no ejecutada, nota de retención, payload↔columna exacto.

**Bloque K — declaración de impacto:** ✅ el diff toca exactamente lo declarado
(`scenario.ts`, `scenario.test.ts`, `route.ts`, `e2e-turn.ts`, informe). Nada eliminado.
`persistTurn` sigue siendo el **único** punto de escritura (1 llamada) y `notaConflicto` sigue
inyectado en ambas rutas de generación (5 referencias).

---

## 6 · Riesgos de DEADLOCK (bloque C)

**El sistema no se queda mudo y ya no se queda atrapado.**

```
con gastos en CONFLICT → conceptos = ["cuota","ingreso","monto","plazo","tae","ahorro_necesario_mensual"]
  cuota 548.22 ✅ se calcula · sobrante ✅ bloqueado · capacidad ✅ bloqueada · vital/no-vital ✅ libre
```

Las 4 formas de resolución exigidas funcionan (`"usa 2250"`, `"el correcto es el desglose"`,
`"me equivoqué, son 2250"`, `"quédate con el total"`), y el `ASSUMED` absorbente que reporté —el
deadlock más grave de la revisión anterior— **está resuelto**: 16/16 salidas, y ya no puede
coexistir con un `CONFLICT`.

**Riesgo residual (no deadlock, pero peor en cierto sentido):** M1 no bloquea la conversación —
**la deja avanzar con el doble de gastos y sin ninguna señal**. Un deadlock es visible; esto no.
Por eso lo pongo como condición antes del piloto aunque no bloquee el merge.

---

## 7 · Recomendación explícita a Luis

**Mergear, con condiciones.** Los tres bloqueantes que rechacé están cerrados y lo verifiqué
ejecutando, no leyendo: G1c pasa en el caso canónico **y** en la ruta de escape, `ASSUMED` es
revocable y confirmable (16/16 formulaciones de mi diseño), `ASSUMED`+`CONFLICT` ya no coexisten,
y el cap de §8 está ejercitado de verdad. Nada de la tanda 1 se rompió. **G1c, gate bloqueante de
piloto, queda cerrado.**

Mergear deja el sistema estrictamente mejor que no mergear: arregla el doble conteo de `"gasté"`
(3600 → 1800) y los tres bloqueantes, sin introducir ninguna regresión.

**Condiciones:**

1. **Antes del merge:** ejecutar `test:e2e` (incluye T6, la única verificación de G1c con detalle
   parcial contra BD real) y `smoke:db` — **no verificables por mí**, sin credenciales. Es la
   única pieza de la entrega que no he podido reproducir.
2. **Antes del piloto (no del merge): V16 generalizado (M1).** El doble conteo con palabra
   intermedia es preexistente e idéntico en `develop`, pero registra el **doble** de los gastos
   reales y lo marca `COMPLETE`. Con usuarios reales, `"mis gastos fueron 1200: …"` no es un caso
   raro. *Aceptación:* los 4 mensajes de la tabla de M1 deben dar 1200 / 950 / 700 / 1200; y
   ninguna cifra declarada como agregado puede aparecer además como ítem.
3. **Ejecutar la migración 020** (no ejecutada por el agente, correcto) antes de que la telemetría
   de conflictos sirva de algo.

**Decisión de Luis, no de un agente:** incorporar **V14, V15 y V16 a §9** del contrato y aclarar la
numeración E7/E8. Tercera tanda seguida en que el revisor juzga invariantes que no están escritos.

**Lo que NO hay que tocar:** `reconciliarGastos` (`reconcile(prev, delta)`), `FuenteValor.completa`
y el fallo-cerrado de `detalleCompleta`, el bloqueo granular de §7, la materialidad y sus fronteras,
el ciclo de vida del conflicto con sus tres salidas, `notaConflictoGastos`, la migración 020 y la
telemetría.

---

*Nota de método: batería reproducida en worktree aislado y desechable (`git worktree add --detach`,
eliminado al terminar), sin tocar el worktree de AG08 — `npm test` 14/14 · `test:guardrail` 262/262
· `test:calculator` 234/234 · `test:regression` 84/84 turnos · `tsc --noEmit` limpio · `npm run
build` falla solo en el prerender de `/login` por credenciales Supabase ausentes (preexistente,
idéntico en `develop`). G1c (ambos sentidos, canónico y escape), materialidad, ciclo de vida del
conflicto, cap de §8, deadlock, V14/V15/V16 y las regresiones de la tanda 1 se ejecutaron contra
`mergeScenario`, `reconciliarGastos`, `extractScenarioDelta`, `buildScenarioContext`,
`notaConflictoGastos`, `analizarExtraccion` y `numerosCandidatos` reales, y los hallazgos se
contrastaron contra `develop` con el mismo script. `test:e2e` y `smoke:db`: no verificables por mí.*
