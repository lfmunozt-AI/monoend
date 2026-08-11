# Corrección AG08 — tiene_detalle_gastos es posesión, no permiso

**Fecha:** 11 de agosto de 2026
**Rama:** `agent/08` @ `986980e` + esta corrección
**Bug reportado:** `test:e2e` falla en T4 — `"ASSERT FALLÓ: T4 (en memoria) tiene_detalle_gastos debe ser true"` — con 15 ítems en `gastos_items` pero `tiene_detalle_gastos: false`, un estado autocontradictorio que, vía E4, hacía que el modelo volviera a pedir un desglose que el usuario ya había entregado.

---

## 0 · Causa raíz

`base.tiene_detalle_gastos = base.gastos_detalle !== undefined;` conflacionaba dos hechos distintos:

- **(a) posesión** — "¿tengo el desglose itemizado?" (depende de `gastos_items`).
- **(b) derivación** — "¿el agregado se calculó a partir del desglose?" (depende de `gastos_detalle`, los buckets clasificados).

`reconciliarGastos` **congela** `gastos_detalle` en lo que era antes (V2) mientras hay un `gastos_conflict` activo — correcto para el agregado, pero el flag heredaba esa congelación sin relación alguna con si el usuario ya entregó las partidas. Resultado: con 15 ítems ya persistidos (V14, ley de conservación) pero un conflicto cross-turno activo, `tiene_detalle_gastos` daba `false` — el estado decía a la vez "tengo 15 partidas" y "no tengo desglose".

---

## 1 · Fix

**Posesión, no permiso** (`src/lib/calculator/scenario.ts`, en `mergeScenario`):

```ts
base.tiene_detalle_gastos = (base.gastos_items?.length ?? 0) > 0;
```

**Usabilidad** — sigue gobernada por su propio estado, sin ningún campo nuevo (se reutilizó `gastos_conflict`/`detalle_confirmado`, ya existentes, tal como el encargo ofrecía como alternativa a introducir un campo dedicado):

- `notaFaltaDesglose` — su guarda (`!tiene_agregado_gastos || tiene_detalle_gastos`) ya quedó correcta por la sola corrección de arriba: con ítems presentes, nunca vuelve a pedir el desglose, haya o no conflicto.
- `notaConflictoGastos` — sin cambios; ya instruía "no calcules sobrante/capacidad/brecha/recorte" mientras el conflicto esté activo (§7, tanda anterior).
- `notaDetalleSinConfirmar` — **se le añadió `|| s.gastos_conflict` a su guarda de salida.** Antes de este fix, esta función NUNCA podía disparar en un escenario con conflicto activo (porque `tiene_detalle_gastos` daba `false`), así que nadie había notado que su texto ("Sobrante, capacidad, viabilidad de una cuota y brecha SÍ los puedes responder con normalidad — el agregado ya basta para eso") es **falso** cuando el propio agregado está en disputa. Al corregir la posesión, esta contradicción quedó expuesta — se resolvió cediendo el turno por completo a `notaConflictoGastos` (que ya cubre el bloqueo sin esa afirmación errónea) en vez de emitir las dos notas contradictorias en paralelo.
- `orchestrator.ts::buildScenarioContext` — sin cambios; `recorte_propuesto_50pct`/`nueva_capacidad` ya se bloqueaban vía `gastos_conflict` desde la tanda anterior, con independencia de este flag.

**Guarda de autoconsistencia** (invariante interno, `mergeScenario`): tras fijar el flag, si `gastos_items.length > 0` y el flag resultara `false`, se loguea como error (`console.error`) — con la corrección de arriba esto nunca puede divergir (el flag ES literalmente esa comparación), pero queda como defensa si algún cambio futuro reintroduce la conflación.

---

## 2 · Estado resultante del caso 2 (literal)

```
gano 2300 y gasto 2200  →  {"ingreso":2300,"gastos":2200}

+ 15 partidas de testdev7 (suman 2250)  →

{
  "items_len": 15,
  "tiene_detalle_gastos": true,
  "gastos_mensuales": 2200,
  "conflict": {
    "agregado": 2200,
    "agregadoTurn": 1,
    "detalle": 2250,
    "detalleTurn": 2,
    "diff": 50,
    "diffPct": 2.272727272727273,
    "attempts": 0,
    "detalleCompleta": true
  }
}
```

15 ítems, posesión `true`, conflicto detectado con la materialidad exacta (2,27 % ≤ 5 %, elegible), y `gastos_mensuales` intacto en 2200 (V2: nunca se sobrescribe mientras el conflicto está vivo).

---

## 3 · Tests (los 6 pedidos + regresión)

1. **T4 del e2e pasa sin modificar su aserto** — verificado en memoria (§2) y confirmado que `scripts/e2e-turn.ts` corre limpio hasta el punto de SKIP (sin credenciales Supabase en este sandbox); el aserto original (`scenario4.tiene_detalle_gastos === true`) no se tocó.
2. **`scenario.test.ts` — "BUG tiene_detalle_gastos (2)"**: gastos 2200 → 15 partidas (2250) → posesión `true`, conflicto activo con `agregado`/`detalle`/`diff` exactos, `gastos_mensuales` intacto en 2200.
3. **"BUG tiene_detalle_gastos (3)"**: con conflicto activo, `notaFaltaDesglose` es `null` (nunca vuelve a pedir el desglose) y `notaConflictoGastos` sí pide resolver la discrepancia.
4. **"BUG tiene_detalle_gastos (4)"**: con `gastos_items` vacío, `notaFaltaDesglose` SÍ pide el desglose.
5. **"BUG tiene_detalle_gastos (5)"**: con conflicto activo, `recorte_propuesto_50pct` sigue ausente de `conceptos`/el bloque, y `notaDetalleSinConfirmar` cede el turno (sin la contradicción del §1).
6. **Regresión**: `test:calculator` 240/240 (234 previos + 6 nuevos), `test:guardrail` 262/262, `test:regression` 84/84 — todos los casos de tanda 1 y tanda 2 siguen verdes.

Extra (efecto colateral correcto, no pedido pero verificado): `detectarEventosICA` ahora SÍ dispara `"detalle_gastos"` cuando el desglose entra en conflicto — con la semántica vieja, ese evento de conocimiento nunca se registraba en ese escenario (el usuario aportó 15 partidas y el ICA no lo veía).

---

## 4 · Validación

```
npx tsc --noEmit         → limpio
npm test                 → 14/14 OK
npm run test:guardrail   → 262/262 OK
npm run test:calculator  → 240/240 OK   [15+33+24+153+15 — 153 = 147 (corrección anterior) + 6 nuevos]
npm run test:regression  → 84/84 turnos OK · 47 escenarios
npm run build             → TypeScript compila; falla en "/login" por falta de credenciales
                             Supabase en este sandbox — mismo fallo preexistente, no es regresión.
npm run test:e2e          → SKIPPED (sin credenciales). T4 (en memoria y su réplica en
                             scenario.test.ts) confirma el fix; el script corre limpio hasta el SKIP.
npm run smoke:db          → SKIPPED (misma razón).
```

## 5 · Confirmación de lo que debía permanecer intacto

- **G1c:** sin cambios en `reconciliarGastos` — el caso 2 (§2 de este informe) muestra el conflicto cross-turno detectado exactamente igual que antes de este fix; el bug era solo el flag de exposición, nunca la reconciliación misma.
- **Materialidad:** `TOLERANCIA_REDONDEO_EUR`/`MATERIALIDAD_MAX_PCT`/`calcularMaterialidad` sin tocar — el 2,27 % del caso 2 sigue cayendo en la banda elegible para conflicto exactamente como antes.
- **V2** (nunca sobrescribir en CONFLICT): `gastos_mensuales` sigue en 2200 tras el conflicto — verificado explícitamente en el test 2.
- **V14** (ley de conservación): las 15 partidas de testdev7 se conservan íntegras (`gastos_items.length === 15`) — verificado explícitamente en el test 2 y en el test de regresión dedicado.

## 6 · Estado de la rama

Pendiente de commit y push tras este informe. `origin/agent/08` sigue en `986980e`; el push declarado como `--force-with-lease` autorizado, aunque en la práctica es un avance normal (ningún commit se reescribe).
