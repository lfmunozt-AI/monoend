# Corrección AG08 — la aritmética decide el agregado

**Fecha:** 18 de agosto de 2026
**Rama:** `agent/08`, sobre `origin/agent/08` (`db7803c`)
**Motivado por:** medición ejecutada con el pipeline real, 3 fraseos rotos en dirección inversa —
la regla estructural (tanda anterior) dejó de exigir keyword, pero seguía siendo "golosa hacia
atrás": leía la última cifra antes de `:` en TODA la frase, sin frontera de coma, y podía robar un
número que en realidad pertenecía a ingreso, meta o plazo.
**Rondas previas relevantes:** `CORRECCIONES_AG08_estructura_sin_keyword.md` (elimina el ancla
léxica, introduce `ultimoLimiteDeClausula`)
**Contrato:** `docs/CONTRATO_TRUTH_ENGINE.md` §5.2 (parser) · §6 (`MATERIALIDAD_MAX_PCT`) · §9
(V13/V19) · §13 · §15

---

## 0 · Resumen

| Fraseo | Antes de esta tanda |
|---|---|
| `"gano 2300: arriendo 900, comida 500"` | ❌ `gastos_mensuales` no se extrae (AMBIGUOUS) — "2300" (ingreso) robaba el rol de agregado |
| `"quiero una casa de 150000: arriendo 900, comida 500"` | ❌ nada se extrae — "150000" (meta) quedaba libre, el parser de listas lo emparejaba con "arriendo" |
| `"a 48 meses: cuota 900, seguro 50"` | ❌ `cuota=48` (absurdo) — "48" (plazo) tomado como importe de la primera partida |

Causa raíz común: `ultimoLimiteDeClausula` solo cortaba en `. ! ? \n`, nunca en coma. "La última
cifra antes del `:`" podía así alcanzar por encima de una coma hacia un número perteneciente a
OTRA declaración de la misma frase. Tres diseños previos (conectores enumerados → keyword de gasto
→ solo posición) fallaron todos por el mismo patrón: intentar deducir "qué es" una cifra por su
contexto textual. Este turno cambia de enfoque: **la aritmética decide**, con tres compuertas en
orden.

---

## 1 · Las tres compuertas — `detectarAgregadoEstructural` y `ultimoLimiteDeClausula`

### Compuerta 1 — la coma corta la cláusula
`ultimoLimiteDeClausula` (`scenario.ts`) añade `,` y `;` a la lista de fronteras (antes solo
`. ! ? \n`). El candidato a agregado es la última cifra antes del `:` **dentro de su propia
cláusula**, no de toda la frase. `"gano 2300, arriendo 900: comida 500, luz 120"` ya no puede leer
"2300" como agregado — la coma cierra la cláusula del ingreso antes de llegar al `:`.

### Compuerta 2 — no reclamada (V13)
Nuevo parámetro `rangosReclamados` en `detectarAgregadoEstructural`. Si el candidato ya fue
reclamado por otro patrón declarativo (ingreso, plazo bare, meta), **no es candidato a agregado de
gastos** — pertenece a ese otro campo. Crítico: descartar el candidato aquí **nunca** descarta el
resto del delta del mismo mensaje (V19, ver §3).

### Compuerta 3 — reconciliación aritmética (decisiva)
`S = suma(items de la lista tras ":")`. Si `|candidato − S| / S × 100 ≤ MATERIALIDAD_MAX_PCT`
(5%, el umbral YA vigente en §6 — no se inventó otro), el candidato ES el agregado (consistente, o
en conflicto material — `reconciliarGastos` ya sabe resolver ambos casos con lo que esta función
devuelve). Por encima del 5%, el candidato **no** es el agregado: se descarta sin reclamar nada,
cae al parser de listas, y si tenía un nombre adyacente ("arriendo 900:") se incorpora como una
partida más — nunca se pierde.

`GASTO_CTX` deja de consultarse por completo dentro de esta función (antes ya no era obligatorio,
pero seguía presente como remanente; ahora ni se evalúa — la estructura + la aritmética bastan).

---

## 2 · Los dos gaps de orden que aparecieron al aplicar las compuertas — y su fix

Compuerta 2 solo funciona si el campo que legítimamente posee el número **ya lo reclamó** antes de
que Gastos corra. Dos gaps:

1. **Meta corría DESPUÉS de Gastos.** `"quiero una casa de 150000: ..."` — "150000" llegaba libre a
   Gastos, Compuerta 3 lo rechazaba (no reconcilia con 1400), y el parser de listas de respaldo
   emparejaba mal el número huérfano con la siguiente palabra válida. **Fix:** todo el bloque Meta
   se reubicó para correr ANTES de Gastos (justo después de Ingreso), y ahora también empuja su
   monto reclamado a `rangosReclamados` (antes solo a `rangosParaMeta`, que es de uso exclusivo de
   Meta para su propia exclusión, no visible para Gastos).
2. **Ningún patrón reclamaba un plazo SIN contexto de crédito.** `"a 48 meses: cuota 900, seguro
   50"` no dispara `PRECIO_CTX` (no hay "financiar"/"préstamo"/...), así que "48" nunca se
   reclamaba y sufría el mismo bug de huérfano. **Fix:** bloque nuevo, deliberadamente angosto —
   solo dispara cuando un `PLAZO` está pegado a `:` seguido de una lista real de ≥2 partidas.
   Angosto a propósito: una versión sin esa restricción abriría un `credito` fantasma
   (`missing: ['monto','tae']`) ante cualquier mención suelta de duración ("vuelvo en 3 meses").

Verificado que el reorden de Meta no introduce doble-lectura: `"quiero comprar algo, mis gastos
son 2200: arriendo 900, comida 500"` (caso contrived, fuera del alcance de esta tanda) atribuye
2200 a la meta bajo el nuevo orden — pero el mismo resultado ya ocurría bajo el orden ANTERIOR,
porque Compuerta 3 rechaza "2200" como agregado de gastos de cualquier forma (no reconcilia con
1400, diff muy por encima del 5%), dejándolo sin reclamar en ambos órdenes. No es una regresión de
esta tanda.

---

## 3 · V19 (nuevo invariante) — un agregado ambiguo nunca descarta el resto

> Nunca se pierde un dato que SÍ era extraíble: si el agregado es ambiguo, el resto del delta
> (meta, ingreso, plazo, ítems) se persiste igual. Degradar a AMBIGUOUS no autoriza a descartar
> nada.

Compuerta 2 y Compuerta 3 solo hacen `continue` sobre el candidato a agregado — nunca tocan
`delta.ingreso_mensual`, `delta.meta`, `delta.credito` ni el resto del pipeline. Verificado
explícitamente en los tres casos del §0: en los tres, el campo que reclamó el número (ingreso,
meta o plazo) se persiste, Y ADEMÁS los ítems de la lista se extraen con normalidad.

---

## 4 · Los 18 mensajes — resultado real (pegado íntegro)

Los 12 de la tanda anterior (regresión, deben seguir en verde) + 6 fraseos nuevos de esta tanda (2
de ellos sin ninguna palabra de la familia "gasto"):

```
gastos_mensuales=1200 ingreso=— meta=— plazo=— extraction_status=COMPLETE — "gastando 1200 al mes: internet 300, agua 400, gas 500"
gastos_mensuales=1200 ingreso=— meta=— plazo=— extraction_status=COMPLETE — "mis desembolsos son 1200: internet 300, agua 400, gas 500"
gastos_mensuales=1200 ingreso=— meta=— plazo=— extraction_status=COMPLETE — "mis salidas mensuales 1200: internet 300, agua 400, gas 500"
gastos_mensuales=1200 ingreso=— meta=— plazo=— extraction_status=COMPLETE — "pago 1200 en total: internet 300, agua 400, gas 500"
gastos_mensuales=1200 ingreso=— meta=— plazo=— extraction_status=COMPLETE — "se me van 1200: internet 300, agua 400, gas 500"
gastos_mensuales=1200 ingreso=— meta=— plazo=— extraction_status=COMPLETE — "presupuesto mensual 1200: internet 300, agua 400, gas 500"
gastos_mensuales=1200 ingreso=— meta=— plazo=— extraction_status=COMPLETE — "mis gastos fueron 1200: internet 300, agua 400, gas 500"
gastos_mensuales=1200 ingreso=— meta=— plazo=— extraction_status=COMPLETE — "1200: internet 300, agua 400, gas 500"
gastos_mensuales=1300 ingreso=— meta=— plazo=— extraction_status=COMPLETE — "estoy gastando 1300 mensuales: renta 700, comida 400, transporte 200"
gastos_mensuales=1600 ingreso=— meta=— plazo=— extraction_status=COMPLETE — "he acabado gastando 1600 este mes: hipoteca 900, super 450, gasolina 250"
gastos_mensuales=1600 ingreso=— meta=— plazo=— extraction_status=COMPLETE — "gastándome 1600 al mes: hipoteca 900, super 450, gasolina 250"
gastos_mensuales=1600 ingreso=— meta=— plazo=— extraction_status=COMPLETE — "mis egresos son 1600: hipoteca 900, super 450, gasolina 250"
gastos_mensuales=1750 ingreso=2500 meta=— plazo=— extraction_status=COMPLETE — "sueldo 2500, alquiler 950: comida 600, ocio 200"
gastos_mensuales=700 ingreso=— meta=80000 plazo=— extraction_status=COMPLETE — "el objetivo es 80000: colegio 400, transporte 300"
gastos_mensuales=580 ingreso=— meta=— plazo=24 extraction_status=COMPLETE — "en 24 meses: cuota 500, mantenimiento 80"
gastos_mensuales=550 ingreso=1800 meta=— plazo=— extraction_status=COMPLETE — "cobro 1800, luz 300: agua 150, internet 100"
gastos_mensuales=2500 ingreso=— meta=— plazo=— extraction_status=COMPLETE — "2500: renta 1200, comida 700, transporte 300, ocio 300"
gastos_mensuales=800 ingreso=— meta=90000 plazo=60 extraction_status=COMPLETE — "mi meta es 90000 a 60 meses: hipoteca 700, seguro 100"

18/18 OK
```

Los fraseos 15 (`"en 24 meses: cuota 500, mantenimiento 80"`) y 17
(`"2500: renta 1200, comida 700, transporte 300, ocio 300"`) no contienen ninguna palabra de la
familia "gasto" — confirman que ni la keyword ni el ancla léxica son necesarias en ningún punto del
pipeline.

Los tres casos originales del diagnóstico (§0), verificados por separado (no forman parte de los
18 anteriores porque su agregado es AMBIGUO por diseño — la prueba es que el RESTO del delta
sobrevive, no el campo `gastos_mensuales` en solitario):

```
"gano 2300: arriendo 900, comida 500"                         → ingreso=2300  gastos=1400 items=2
"quiero una casa de 150000: arriendo 900, comida 500"         → meta=150000   gastos=1400 items=2
"a 48 meses: cuota 900, seguro 50"                             → plazo=48      gastos=950  items=2 (cuota=900, NUNCA 48)
```

---

## 5 · Regresión — resultado real

| Verificación | Resultado |
|---|---|
| `"gasto 2 500 €"` → 2500 | ✅ cubierto en `scenario.test.ts` (sin `:`, no pasa por esta regla) |
| 15 partidas de testdev7 → 15 ítems, suma 2250 | ✅ cubierto en `scenario.test.ts`, sin `:`, no afectado |
| Dedup testdev8 → 5 ítems (no 11), suma 2200 | ✅ nuevo test explícito esta tanda |
| `"gano 2300, arriendo 900: comida 500, luz 120"` (Compuerta 1+3 combinadas) | ✅ 900 no reconcilia (45%>5%), se incorpora como partida — `gastos_mensuales=1520` |
| `"gasto 2200: [ítems que suman 2250]"` (dentro del 5%, caso origen de `reconciliarGastos`) | ✅ `gastos_conflict={agregado:2200, detalle:2250}`, nunca doble conteo |
| `"internet 300, agua 400, gas 500"` (V19, sin cifra previa) | ✅ `gastos_mensuales=1200` como suma, sin agregado inventado |
| Los 4 casos de M10 (A/B/C/D — sensor, no editor) | ✅ intactos, `commandments.test.ts` 36/36 (archivo no tocado esta tanda) |
| M9 (plan fantasma) | ✅ `plan-fantasma.test.ts` 24/24 |
| M3 con pipeline completo | ✅ cubierto por `enforcement.test.ts` 33/33 |
| Los 12 fraseos de la tanda anterior | ✅ 12/12, sin regresión (ver §4) |
| Suite completa `test:calculator` | ✅ 0 fallos (scenario 215 → 228, +13 tests: 6 compuertas/V19 + 6 fraseos nuevos + 1 dedup) |
| Suite completa `test:guardrail` | ✅ 0 fallos, las 8 suites (120+6+11+27+36+33+24+18) |
| `npm test` | ✅ 0 fallos (5+8+4 y el resto de suites) |
| `test:regression` | ✅ **84/84** turnos · 47 escenarios · enforcement=full |

---

## 6 · Declaración de impacto — funciones tocadas y por qué

`git diff --stat` (contra `origin/agent/08` previo, `db7803c`):

```
 src/lib/calculator/scenario.test.ts |  88 ++++++++++++++++
 src/lib/calculator/scenario.ts      | 197 ++++++++++++++++++++++++++----------
 2 files changed, 230 insertions(+), 55 deletions(-)
```

| Función/símbolo | Cambio | Motivo |
|---|---|---|
| `ultimoLimiteDeClausula` | añade `,` y `;` como frontera de cláusula | Compuerta 1 |
| `detectarAgregadoEstructural` | nuevo parámetro `rangosReclamados`; añade Compuerta 2 (rango ya reclamado → `continue`) y Compuerta 3 (reconciliación aritmética contra `MATERIALIDAD_MAX_PCT` → `continue` si excede) | Compuertas 2 y 3 |
| bloque "PLAZO BARE + LISTA" (nuevo) | añadido, entre Crédito e Ingreso | reclama un plazo sin contexto de crédito cuando está pegado a `:` + lista real, para que Compuerta 2 lo proteja |
| bloque Meta | reubicado de después de Gastos a antes; ahora también empuja a `rangosReclamados` (antes solo `rangosParaMeta`) | Meta debe reclamar su monto ANTES de que Gastos lo vea (§2) |
| llamada a `detectarAgregadoEstructural` | pasa `rangosReclamados` como tercer argumento | cablea Compuerta 2 |

### Tests — ninguno modificado, todos nuevos (V11)

No se tocó ni un assert existente. Se añadieron 13 tests a `scenario.test.ts`: 6 de las
compuertas/V19 (los tres casos del diagnóstico + el caso Compuerta1+3 combinadas + el caso dentro
del 5% + la lista sin cifra previa) + 6 fraseos nuevos parametrizados + 1 de regresión explícita
del dedup. El regression harness (`tests/scenarios/*.json`) no se tocó.

---

## 7 · Validación

| Comando | Resultado |
|---|---|
| `npx tsc --noEmit` | limpio |
| `npm run build` | TypeScript compila limpio; falla después en el prerender de `/login` por falta de credenciales de Supabase — entorno, no código (idéntico en todas las tandas anteriores, confirmado vía `git stash`) |
| `npm test` | 0 fallos |
| `npm run test:guardrail` | 0 fallos, 8 suites (commandments 36/36 — M10 no tocado) |
| `npm run test:calculator` | 0 fallos (operations 15, orchestrator 33, expenses 24, scenario 228, tools 17) |
| `npm run test:regression` | **84/84** turnos · 47 escenarios · enforcement=full |
| `npm run test:e2e` / `npm run smoke:db` | sin credenciales — no verificable en este entorno (igual que en todas las tandas anteriores) |
