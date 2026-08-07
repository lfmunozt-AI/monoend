# Corrección AG08 — Tanda 2: reconciliación cross-turno (Gate G1c) + ciclo de vida del conflicto + materialidad + escape ASSUMED + bloqueo granular + V15 atribución

**Fecha:** 7 de agosto de 2026
**Rama:** `agent/08` @ `155987f` (`origin/develop`) + esta tanda
**Base verificada:** `grep -n "rangosReclamados" src/lib/calculator/scenario.ts` da resultados (líneas 483, 484, 504…) — la tanda 1 (V14, fronteras posicionales + ley de conservación) está presente. El gate de arranque del protocolo se cumplió.

---

## 0 · Qué resuelve esta tanda

**CASO ORIGEN:** el usuario declara gastos de 2.200 € en un turno y en otro entrega un desglose que suma 2.250 €. Antes de esta tanda, `detectarDiscrepanciaGastos` solo miraba el delta del turno ACTUAL — comparaba agregado y desglose únicamente cuando ambos llegaban en el MISMO mensaje. La diferencia de 50 € entre dos turnos distintos nunca se detectaba.

Esta tanda implementa §2 completo, §4 paso 4, §6, §7 y §8 de `docs/CONTRATO_TRUTH_ENGINE.md`, y se juzga contra los casos 1-8 de §10 ("Reconciliación").

---

## 1 · Dónde vive cada pieza (archivo y línea)

| Pieza | Archivo | Qué es |
|---|---|---|
| Tipos (`FactStatus` extendido, `FuenteValor`, `ConflictoGastos`, `SupersededEntry`) | `scenario.ts` | Modelan el ciclo de vida CONFLICT/ASSUMED/SUPERSEDED por campo (§2) |
| Campos nuevos en `ScenarioState` (`turn`, `gastos_agregado_origen`, `gastos_detalle_origen`, `gastos_conflict`, `gastos_assumed`, `gastos_superseded`, `gastos_superseded_colapsados`, señales de turno `gastos_resolucion`/`gastos_assumed_confirmado`) | `scenario.ts` | Estado persistido + señales transitorias del turno |
| `reconciliarGastos(prev, delta, turnoActual)` | `scenario.ts` | Núcleo de la reconciliación — Gate G1c |
| `pushSuperseded` | `scenario.ts` | §8 — cap de 5 versiones, colapsa el resto a un contador |
| `detectarResolucionConflicto(message, conflict)` | `scenario.ts` | Detecta "usa 2250", "eran 2250", "el correcto es el desglose"… |
| `notaConflictoGastos(scenario)` | `scenario.ts` | Datos crudos al prompt — "el modelo redacta, el sistema decide" |
| Cableado en `mergeScenario` | `scenario.ts` | `base.turn`, llamada a `reconciliarGastos`, override de `factStatus.gastos_mensuales`, limpieza de señales transitorias |
| Bloqueo granular (§7) | `orchestrator.ts::buildScenarioContext` | `gastosEnConflicto` bloquea sobrante/déficit/capacidad anual/brecha/esfuerzo total/recorte propuesto/nueva capacidad; NO bloquea cuota de crédito ni clasificación vital/no-vital |
| Resolución robusta (tool-call y fallback-regex) + wiring del prompt | `route.ts` | `detectarResolucionConflicto`/confirmación calculados SIEMPRE, no solo en el carril regex; `notaConflicto` inyectado en ambas rutas de generación |
| Telemetría (`conflict_status`, `conflict_field`, `conflict_diff`, `conflict_attempts`, `assumed_fields`) | `telemetry.ts` + `supabase/migrations/020_telemetry_conflict.sql` | Columnas de primera clase, NULLABLE/IF NOT EXISTS — **no ejecutada, la corre Luis** |
| V15 — atribución + `meta.monto` no captura el ingreso | `scenario.ts` (`GASTO_AGREGADO_DETALLE_RE`), `expenses.ts` (`emparejarNombreMonto`) | Enmienda E8 del contrato |
| e2e cross-turno contra BD real | `scripts/e2e-turn.ts` (T5a-T5c) | Re-lectura desde `conversations.scenario_state` — SKIPPED en este sandbox (sin credenciales) |

---

## 2 · `reconciliarGastos` — diseño

`reconcile(previousTruth, currentDelta)`, no `reconcile(delta)`: compara SIEMPRE contra el ÚLTIMO valor conocido de CADA fuente (`gastos_agregado_origen`/`gastos_detalle_origen`), sea cual sea el turno en que llegó. Bidireccional por construcción: el resultado depende únicamente de los DOS valores en pugna y sus turnos de origen, nunca de en qué orden llegaron.

Precedencia (§4): la comparación solo se activa si ambas fuentes aportan datos — un delta `AMBIGUOUS`/`PARTIAL` por huérfanos o pegado no interfiere con esta pieza (esa precedencia ya la aplica `deltaSinGastosPorDiscrepancia` antes del merge para el caso mismo-turno; para el cross-turno, `reconciliarGastos` simplemente no encuentra "dos fuentes" si una de ellas nunca llegó a persistirse).

Materialidad (§6):
- `|diff| ≤ 1€` → CONSISTENT, el detalle manda (mismo criterio que el BUG 1 original, pero ahora con tolerancia de redondeo explícita).
- `diffPct ≤ 5%` → CONFLICT, elegible para escape. **V2: el valor NO se sobrescribe** — queda congelado en lo que había antes de que el conflicto empezara (o `undefined` si es la primera vez que se declaran gastos).
- `diffPct > 5%` → fallo de comprensión, NO elegible para escape. Se reinicia la captura: `gastos_mensuales`/`gastos_detalle`/`gastos_es_detalle`/ambos orígenes/el propio conflicto vuelven a `undefined`. Ninguna de las dos cifras queda como verdad.

Ciclo de vida (§2):
- Resolución explícita (`detectarResolucionConflicto`) → ganador `CONFIRMED`, perdedor `SUPERSEDED` (motivo `USER_CORRECTION`, turno), ambos orígenes se realinean al ganador.
- Escape: 2 intentos sin resolver + `detalleCompleta` + `diffPct ≤ 5%` → adopta el DETALLE (`gastos_assumed`), `ASSUMED`. Revocable: una confirmación corta (`esConfirmacionCorta`) lo cierra (V6).
- `factStatus.gastos_mensuales` se corrige explícitamente tras resolución/reinicio (bug atrapado en tests, ver §5) — sin este fix quedaba pegado en `"CONFLICT"` para siempre tras resolverse, porque `actualizarFactStatus` copia `prev.factStatus` como punto de partida y un turno de resolución no "toca" `gastos_mensuales` según `camposDelDelta`.

---

## 3 · Los 8 casos de aceptación (§10) — resultado real

Todos verificados con `npm run test:calculator` (ver `scenario.test.ts`, bloque "12ª TANDA — RECONCILIACIÓN CROSS-TURNO").

| # | Escenario | Resultado |
|---|---|---|
| 1 | declarado 2200 · detalle 2200 (mismo turno) | `gastos_mensuales=2200`, sin conflicto, `factStatus=PARSED` ✅ |
| 2 | mismo turno, 2200 + detalle 2250 | `gastos_conflict={agregado:2200, detalle:2250, diff:+50}`, sobrante/capacidad AUSENTES de `conceptos` ✅ |
| 3 | 2200 vs detalle 2150 | `gastos_conflict.diff=-50` ✅ |
| 4 | T1 agregado 2200 → T2 detalle 2250 | `gastos_conflict={agregado:2200(T1), detalle:2250(T2), diff:+50}` ✅ |
| 5 | T1 detalle 2250 → T2 agregado 2200 | `gastos_conflict={agregado:2200(T2), detalle:2250(T1), diff:+50}` — **`agregado`/`detalle`/`diff`/`diffPct` IDÉNTICOS al caso 4** (verificado con `assert.equal` campo a campo) ✅ **Gate G1c confirmado** |
| 6 | T1 2200 · T2 2250 · T3 "eran 2250" | `gastos_mensuales=2250`, `gastos_conflict=undefined`, `factStatus=CONFIRMED`, `gastos_superseded=[{valor:2200, motivo:"USER_CORRECTION"}]` ✅ |
| 7 | T1 2200 · T2 2250 · dos turnos sin resolver | intento 1: conflicto persiste, `attempts=1`; intento 2: escapa — `gastos_assumed={valor:2250, fuente:"detalle"}`, `factStatus=ASSUMED`, `notaConflictoGastos` expone "SUPUESTO ACTIVO" + el valor, sin frase enlatada ✅ |
| 8 | 2200 vs 6000 (>5%, mismo turno) | `gastos_conflict=undefined`, `gastos_assumed=undefined`, `gastos_mensuales=undefined` — reinicio limpio, NUNCA ASSUMED ✅ |

**Extras verificados** (mismo bloque de tests):
- Gastos en CONFLICT: la cuota del crédito SÍ se calcula (`conceptos.cuota` presente, `referencia_cuota_credito` en el bloque); sobrante/brecha SÍ siguen bloqueados.
- Clasificación vital/no-vital de una lista en el mensaje: NO se bloquea con gastos en conflicto.
- "gasto 1500 en total: casa 700, comida 300" → `casa=700`, `comida=300` (atribución correcta, V15/E8).
- "gano 2300 y quiero una casa" → `meta.monto` no es 2300.
- Regresión: V14 (fronteras posicionales, "casa" del crédito no destruye "casa 700" de gastos) y testdev7 (15 ítems, suma 2250) siguen verdes.

---

## 4 · Bug atrapado por los propios tests de esta tanda

Al escribir el CASO 6 (resolución), `s.factStatus.gastos_mensuales` daba `"CONFLICT"` en vez de `"CONFIRMED"` tras resolver. Causa: el override de `factStatus.gastos_mensuales` (CONFLICT/ASSUMED) solo tenía rama de ENTRADA, nunca de SALIDA — `actualizarFactStatus` copia `prev.factStatus` como base, y un turno de resolución no "toca" `gastos_mensuales` según `camposDelDelta` (el delta de una resolución solo trae `gastos_resolucion`), así que nada volvía a escribir el campo. Fix: tercera rama explícita que limpia el estado stale — `CONFIRMED` si la resolución/escape dejó un valor, `MISSING` si el reinicio (§6, >5%) lo vació. Verificado con el propio scratch de reproducción antes de tocar el test definitivo (no se "arregló el test para que pasara" — se corrigió la función y el test quedó como la prueba de que el fix es real).

Segundo ajuste encontrado por los propios casos: `detalleCompleta` (requisito de escape, §6) se calculaba como `extraction_status === "COMPLETE"`, pero una discrepancia MISMO-turno (agregado ≠ desglose en el mismo delta) ya pone `extraction_status` en `AMBIGUOUS` por sí sola (`computeExtractionStatus`) — eso hacía que TODO conflicto mismo-turno fuera tautológicamente inelegible para el escape para siempre. Corregido: `detalleCompleta` ahora solo se niega ante `PARTIAL`/`INVALID` (problemas reales del propio desglose — huérfanos, valores imposibles), no ante `AMBIGUOUS` causado por la discrepancia que este mismo mecanismo ya está gestionando.

---

## 5 · Regresión de fixtures — comportamiento intencionalmente cambiado

Dos escenarios del harness de regresión (`tests/scenarios/`) codificaban el comportamiento ANTERIOR ("BUG 1, 6ª tanda: el detalle pisa SIEMPRE al agregado, sin mirar la magnitud del salto"), que el contrato de esta tanda sustituye explícitamente por materialidad (§6):

- **`deficit_detalle_manda.json`**: agregado 10.000 vs. detalle 11.000 → salto del 10%, > 5% → ahora reinicia la captura en vez de "pisar" a 11.000. Actualizado `expectScenarioState` (`missing: ["gastos"]` en vez de `gastos_mensuales: 11000`) y el `fixtureResponse`/descripción para reflejar el nuevo comportamiento — sin citar cifras que ya no están respaldadas (el guardarraíl las habría bloqueado).
- **`entrega_gastos.json`**: agregado 2.372 vs. detalle 645 → salto del 72,8%. Mismo tratamiento: `expectScenarioState` ya no exige `gastos_mensuales: 645`.

Esto **no es "reescribir un test para tapar un bug"** (V11): el comportamiento nuevo es exactamente lo que esta tanda pide implementar (§6, PIEZA 2 del encargo), documentado en la propia descripción del fixture actualizado, y la comprobación central de cada escenario (clasificación vital/no-vital, recorte del 50%, que ningún dato se invente) sigue verificándose igual — mismo criterio aplicado en la corrección V14 anterior (§3 de `CORRECCIONES_AG08_v14_fronteras_posicionales.md`).

Detalle menor encontrado al reparar `deficit_detalle_manda`: el guardarraíl de cifras interpretaba la palabra "dos" (como en "cuál de las dos cifras") como el número 2 sin respaldo, bloqueando la respuesta. No es un bug de esta tanda — es una peculiaridad preexistente del extractor de números del guardarraíl (`hechos`/hallazgo de `renta`) — se evitó reformulando el `fixtureResponse` sin esa palabra, sin tocar el guardarraíl (fuera de alcance, dominio de otra pieza del sistema).

---

## 6 · §7 — Bloqueo granular, verificado

`buildScenarioContext` ahora calcula `gastosEnConflicto = !!scenario.gastos_conflict` y:
- Omite `gastos_mensuales`, `sobrante_mensual`/`deficit_mensual`, `capacidad_ahorro_anual`, `brecha_mensual`, `esfuerzo_total`, `recorte_propuesto_50pct`, `nueva_capacidad` de `TU REALIDAD`/`conceptos` mientras el conflicto esté activo (V4 — nunca calcular una derivada que consume un campo en CONFLICT).
- **NO** omite `cuota_credito`/`referencia_cuota_credito` (solo consume monto/plazo/TAE) ni `gastos_vitales`/`gastos_no_vitales` (consumen `gastos_items` del propio mensaje, no el agregado disputado).
- `ahorro_necesario_mensual` tampoco se bloquea — depende de `meta.monto`/`plazo`, nunca de gastos.

## 7 · §8 — Cap de historial

`pushSuperseded` mantiene un máximo de 5 entradas en `gastos_superseded`; la 6ª en adelante empuja la más vieja fuera del array y suma 1 a `gastos_superseded_colapsados`. La auditoría completa (todas las versiones, sin cap) vive en `response_telemetry` vía `merged_scenario`/`previous_scenario` (migración 019) — el cap solo aplica al estado que se re-lee en cada turno.

## 8 · Telemetría — coincidencia payload↔columna verificada

```
conflict_status    ↔ payload.conflictStatus
conflict_field     ↔ payload.conflictField
conflict_diff      ↔ payload.conflictDiff
conflict_attempts  ↔ payload.conflictAttempts
assumed_fields     ↔ payload.assumedFields
```

Los cinco pares confirmados por inspección exacta de `telemetry.ts` (interfaz + `insert()`). Migración `020_telemetry_conflict.sql` — NULLABLE, `IF NOT EXISTS`, con `comment on column` documentando retención (30 días, misma purga que `delta_raw`/`previous_scenario`/`merged_scenario` de la migración 019). **NO ejecutada** — la corre Luis.

---

## 9 · Validación

```
npx tsc --noEmit         → limpio
npm test                 → 14/14 OK (exit 0)
npm run test:guardrail   → 262/262 OK (exit 0)
npm run test:calculator  → 223/223 OK (exit 0)   [15+33+24+136+15 — 136 = 124 + 12 nuevos]
npm run test:regression  → 84/84 turnos OK (exit 0) · 47 escenarios
npm run build             → TypeScript compila; falla en "/login" por falta de credenciales
                             Supabase en este sandbox — mismo fallo preexistente documentado
                             desde la tanda V14, no es regresión.
npm run test:e2e          → SKIPPED (sin credenciales). scripts/e2e-turn.ts extendido con T5a-T5c
                             (agregado 2200 → desglose 2250 → conflicto persistido y re-leído desde
                             `conversations.scenario_state` → resolución "eran 2250" → 2250 CONFIRMED,
                             2200 SUPERSEDED, también re-leído desde BD). Compila limpio (tsc).
npm run smoke:db          → SKIPPED (misma razón).
```

## 10 · Confirmaciones explícitas pedidas por el protocolo

- **Bidireccionalidad (casos 4 y 5):** confirmado por assert directo campo a campo (`agregado`, `detalle`, `diff`, `diffPct` idénticos) en el test del caso 5 — no es una afirmación de intención, es una comparación numérica entre dos ejecuciones independientes con el orden de turnos invertido.
- **V14 y fronteras posicionales intactas:** test de regresión dedicado ("REGRESIÓN (12ª tanda)") reconstruye el caso B2 original (`"casa" del crédito no destruye "casa 700" de gastos`) y testdev7 (15 ítems, suma 2250) — ambos verdes. `rangosParaMeta`/`rangosReclamados` no se tocaron salvo la extensión aditiva de V15 (subconjunto SIN el rango del crédito, ya presente desde la tanda anterior).
- **Enmiendas E1-E8:** el contrato en la rama solo documenta E1-E6 explícitamente numeradas; E7/E8 no aparecen con ese rótulo pero el contenido de "V15 atribución" that el encargo describe como "enmienda E8" coincide con la nota de E3 (`meta.monto` puede capturar el ingreso, "se resuelve en la tanda 2 mediante el mecanismo de reclamación de V13") — implementado. Discrepancia de numeración señalada para que Luis la revise si hace falta actualizar el documento, sin que bloquee la entrega.

## 11 · Estado de la rama

Pendiente de commit y push tras este informe. `origin/agent/08` estaba en `155987f` (`= origin/develop`); el push será un avance normal (sin force) salvo que la rama haya divergido entre tanto.
