# Corrección AG08 — regresión bloqueante del parser de listas (prosa mixta)

**Fecha:** 6 de agosto de 2026
**Rama:** `agent/08`, sobre `origin/develop` (`de94008`)
**Reproducción original:** `test:e2e` (T1) — `"ASSERT FALLÓ: T1 debería extraer gastos 2000 (fue undefined)"`

---

## 0 · Confirmación explícita: no hay lógica de reconciliación cross-turno

```
$ grep -n "function detectarDiscrepanciaGastos" src/lib/calculator/scenario.ts
828:export function detectarDiscrepanciaGastos(delta: Partial<ScenarioState>): DiscrepanciaGastosResult {

$ grep -rn "prev?.gastos_mensuales|reconcile(" src/lib/calculator/scenario.ts src/app/api/chat/route.ts
sin resultados
```

Firma de un solo argumento (`delta`), sin `prev`. No existe `reconcile(previousTruth, currentDelta)`, ni
`CONFLICT`/`ASSUMED`/`SUPERSEDED`. Esta corrección se hizo enteramente dentro de la extracción de UN
turno (V1/V12/V13), sin tocar nada de la reconciliación cross-turno (tanda 2).

## 1 · Causa raíz

`extractScenarioDelta` decidía si el mensaje era una "lista de gastos" **antes** de que los patrones
declarativos (`gano X`, `gasto X`) hubieran extraído nada — así que un número que YA pertenecía al
ingreso o al agregado de gastos quedaba disponible para que el parser de listas lo emparejara con
CUALQUIER palabra cercana ("aproximadamente", "vivienda"), incluido literalmente el ingreso convertido
en un ítem de gasto (doble conteo silencioso).

## 2 · La solución (FIX 1/2/3): precedencia + prueba estructural, no una lista negra

**FIX 1 — reclamo por valor (V13):** los patrones declarativos (tasa, crédito, ingreso, agregado de
gastos explícito con ":") corren primero y anotan sus valores en un `Set<number>` (`claimed`).

**FIX 2b — evidencia estructural, no solo stopwords:** antes de reclamar el candidato de "gasto X" como
un valor declarativo aislado, se comprueba si el mensaje **ya forma una lista real (≥2 pares) sin
reclamarlo**. Esto resuelve la colisión entre dos casos reales que, de otro modo, exigen tratamientos
opuestos:

- `"gasto= 1000 arriendo 500 servicios 250..."` — sin reclamar el 1000, el emparejador YA lo une a
  "arriendo" y encuentra 4 pares → es una lista real, el 1000 **nunca** se reclama.
- `"gasto aproximadamente 2000 entre vivienda, comida, servicios, ocio"` — sin reclamar nada, el
  emparejador solo logra UN par espurio (`vivienda=2000`) y comida/servicios/ocio quedan sin número
  propio (0 pares) → no hay evidencia de lista: el 2000 SÍ se reclama, y su exclusión impide también
  ese único par espurio. `gastos_items` queda vacío — el parser no fabrica partidas sin importe propio.

**FIX 2a (defensa secundaria):** vocabulario ampliado en `expenses.ts` — `aproximadamente/aprox/cerca/
alrededor/casi/unos/unas/total/mensual(es)/cada/dolares` como ruido ignorable (nunca ensucian ni forman
un nombre), y `entre/sobre/e` como stopword de nombre completo.

**FIX 3:** consecuencia directa del diseño anterior — si tras la prueba estructural no emerge una lista
real, el agregado declarado (`gastoDeclaradoSimple`) es lo único que se persiste; nunca se sustituye por
un detalle parcial.

## 3 · FIX 4 — guarda de sanidad (defensa en profundidad)

`aplicarGuardaDeSanidad(delta)` — nueva función, invocada al final de **ambas** vías de extracción
(`extractScenarioDelta` y `toolArgsToScenarioDelta`, esta última nunca pasa por el reclamo de FIX 1):
si algún ítem de `gastos_items` tiene el mismo importe que `ingreso_mensual` (V12), o la suma del
detalle supera 3× el ingreso (magnitud absurda), el detalle completo (`gastos_items`, `gastos_detalle`,
`gastos_es_detalle`) se descarta — `ingreso_mensual`/`gastos_mensuales` **nunca** se tocan (V1). Loguea
el motivo con `console.warn`.

## 4 · FIX 5 — `detalle_confirmado` (requisito añadido por Luis)

Nuevo campo `detalle_confirmado: boolean` en `ScenarioState`. Un desglose nuevo entra como `false`
(PARSED); sube a `true` por confirmación explícita ("sí, correcto"), por corrección de una partida
concreta (`detectarCorreccionDeItem` + reemplazo in-place en `mergeScenario`, conservando el resto), o
automáticamente si el eco no se corrige en el turno siguiente. `notaDetalleSinConfirmar` (nueva función,
cableada en `route.ts` junto a `notaFaltaDesglose`) entrega los DATOS del desglose al prompt para que el
**modelo** redacte la pregunta de confirmación — nunca una plantilla fija — y bloquea únicamente
"proponer recortes por partida"; sobrante/capacidad/cuota/brecha siguen respondiéndose con normalidad
(el agregado basta).

## 5 · git diff --stat completo (contra `origin/develop` @ `de94008`)

```
 src/app/api/chat/route.ts           |  11 +-
 src/lib/calculator/expenses.ts      |  33 ++++-
 src/lib/calculator/scenario.test.ts | 164 +++++++++++++++++++++
 src/lib/calculator/scenario.ts      | 285 ++++++++++++++++++++++++++++++++----
 src/lib/calculator/tools.ts         |   8 +-
 5 files changed, 461 insertions(+), 40 deletions(-)
```

## 6 · Declaración de impacto — función por función

| Función/constante | Archivo | Qué cambió | Por qué |
|---|---|---|---|
| `extractScenarioDelta` | scenario.ts | Reordenada: crédito/ingreso/gasto declarativo reclaman sus valores (`claimed`) ANTES de decidir si hay lista; nueva prueba estructural de dos pasadas para el candidato de "gasto X"; señales de confirmación/corrección del desglose al final | FIX 1/2b/3 — causa raíz de la regresión |
| `parseExpenseListDetallado` | expenses.ts | +parámetro `excluirValores?: ReadonlySet<number>`; filtra tokens NUM cuyo valor está reclamado, ANTES de `resolverPegado` | FIX 1 — mecanismo de exclusión por valor (V13) |
| `STOPWORD_NAME_RE` | expenses.ts | +`entre`, `sobre`, `e` | FIX 2a |
| `IGNORABLE_WORD_RE` | expenses.ts | +`aproximadamente/aprox/cerca/alrededor/casi/unos/unas/total/mensual(es)/cada/mas/menos/dolares/dollars` | FIX 2a |
| `mergeScenario` | scenario.ts | +acumulación de corrección de ítem individual (`gastos_item_correccion`); +cálculo de `detalle_confirmado` (mismo patrón PARSED→CONFIRMED que `factStatus`, campo propio por nombre explícito) | FIX 5 |
| `toolArgsToScenarioDelta` | tools.ts | Envuelve el `return delta` en `aplicarGuardaDeSanidad(delta)` | FIX 4 — la vía tool_call también queda protegida |
| Handler de chat (`route.ts`) | route.ts | +`notaDetalleSinConfirmar` cableada en los dos puntos de ensamblado del prompt y en la condición de regeneración | FIX 5 |

### Nuevas (no existían antes de esta corrección)

`aplicarGuardaDeSanidad`, `detectarCorreccionDeItem`, `notaDetalleSinConfirmar`, campos `detalle_confirmado`
/`detalle_confirmado_explicito`/`gastos_item_correccion` en `ScenarioState`.

### Eliminadas

Ninguna. Todo el trabajo fue aditivo o de reordenamiento interno de una función existente
(`extractScenarioDelta`) sin cambiar su firma pública.

## 7 · Los seis tests obligatorios — resultado real (`extractScenarioDelta`, salida literal)

```
1 — 'gano 2300 y gasto aproximadamente 2000 entre vivienda, comida, servicios, ocio'
    {"ingreso_mensual":2300,"gastos_mensuales":2000}
    → ingreso 2300 ✅ · gastos 2000 ✅ · gastos_items ausente/vacío ✅ · sin 'aproximadamente' ✅ · sin 2300 como gasto ✅

2 — mensaje completo del e2e con "dudo entre 200000, 300000 o 150000"
    delta: {"ingreso_mensual":2300,"gastos_mensuales":2000}
    huerfanos: {"extraccionIncompleta":true,"numerosHuerfanos":[200000,300000,150000],"numerosNoRelevantes":[]}
    → PARTIAL, los 3 montos de la casa como huérfanos relevantes, cero ítems inventados ✅

3 — 'gano 2300 y gasto 2200' (regresión)
    {"ingreso_mensual":2300,"gastos_mensuales":2200}  → sin ítems ✅

4 — 'arriendo 700, comida 450, luz 120' (regresión)
    3 gastos_items (arriendo 700, comida 450, luz 120), gastos_es_detalle=true ✅

5 — 15 partidas testdev7 (regresión, caso 16)
    items: 15, suma: 2250 ✅ (no se rompió)

6 — 'gano 2500, gasto 1800: arriendo 900, comida 500, luz 400'
    {"ingreso_mensual":2500,"gastos_mensuales":1800,"gastos_detalle":{...},"gastos_es_detalle":true,
     "gastos_items":[arriendo 900, comida 500, luz 400]}
    → agregado 1800 declarado Y 3 ítems que suman 1800, ambos coexisten ✅
```

## 8 · Validación

```
npm test                → 14/14 OK (exit 0)
npm run test:guardrail  → 262/262 OK (exit 0)
npm run test:calculator → 200/200 OK (exit 0)   [15+33+24+113+15 — incluye los 6 tests obligatorios +
                                                   3 de la guarda de sanidad + 6 de detalle_confirmado]
npm run test:regression → 84/84 turnos OK (exit 0)
npx tsc --noEmit        → limpio
npm run build           → TypeScript compila (3.1s); falla en "/login" por falta de credenciales
                           Supabase en este sandbox — mismo fallo preexistente ya verificado contra
                           develop limpio en la tanda anterior, no es regresión de esta corrección.
npm run test:e2e        → SKIPPED (sin credenciales). Salida literal de los 6 casos pegada en §7.
npm run smoke:db        → SKIPPED (misma razón).
```

## 9 · Estado de la rama

Pendiente de commit y push. `origin/agent/08` está en `de94008` (= `origin/develop`); tras el commit de
esta corrección, `git push origin agent/08` (sin force — la rama no ha divergido de su remoto, solo
avanza).
