# RECHAZADO — revisión adversarial AG01 · tanda QA testdev8 (`agent/08` @ `8a8f048`)

**Revisor:** AG01 (Arquitecto) · **Implementador:** AG08 · **Fecha:** 2026-08-14
**Base:** `origin/develop` (`d32368d`) · **Rama juzgada:** `origin/agent/08` (`8a8f048`), sin mergear
**Contrato:** `docs/CONTRATO_TRUTH_ENGINE.md` (§1-§5, §9 con E1-E10, §10, §14)

> **Nota sobre el nombre del archivo.** El prompt pedía entregar en
> `REVISION_AG01_tanda1_truth_engine.md`. Ese archivo es el informe de la **tanda 1** y el
> contrato lo cita como evidencia en **E2** (motivo de V11) y **E6** (motivo de la revisión
> cruzada obligatoria). Sobrescribirlo destruiría la prueba que sostiene dos enmiendas
> vigentes, así que esta revisión — que juzga la tanda de **QA testdev8**, no la tanda 1 — se
> entrega en archivo propio. El de la tanda 1 queda intacto.

---

## 1 · Veredicto

**RECHAZADO.** Dos bloqueantes, ambos **regresiones nuevas de esta tanda** verificadas
ejecutando el código real contra `develop` como control:

1. El **Mandamiento 10 republica cifras que el grounding había eliminado** — vuelve a poner
   en boca del Consigliere el déficit fantasma que el Mandamiento 3 existe para matar.
   Viola el gate **G1b**, vigente y bloqueante de piloto (§14).
2. El **bloque "TU REALIDAD" puede contradecirse a sí mismo**: `gastos_mensuales: 150 €` y
   `gastos_vitales: 1550 €` en el mismo bloque de "datos verificados", con el sobrante y la
   capacidad anual calculados sobre la cifra equivocada.

La dirección del trabajo es correcta y **cuatro de los cinco bloqueantes del QA quedan
realmente resueltos** (lo verifiqué ejecutando, no leyendo el informe). El problema es el
mecanismo elegido para el bloqueante 1: revertir al RAW sin re-aplicar el grounding cambia un
defecto de comunicación por un defecto de veracidad. Ese cambio es el que no puede pasar.

La batería completa está en **verde** (84/84 turnos de regresión, 0 fallos en las 5 suites).
Ninguno de los dos bloqueantes lo detecta esa batería: los dos salieron de mensajes que
construí yo, no de los casos de AG08. Es la cuarta tanda consecutiva en que ocurre.

---

## 2 · Hallazgos priorizados

### 🔴 B1 · BLOQUEANTE — el Mandamiento 10 reintroduce cifras no trazables (G1b)

`src/lib/guardrail/commandments.ts:522-540`

M10 revierte al RAW del modelo y solo re-aplica `stripProviderLeaks`,
`isDelegativeClosing` y `maxOneClosingQuestion` (líneas 528-532). **Nunca re-aplica el
grounding numérico** (M1/M3/M4/M5, ni la capa `validate.ts`). Si el grounding había borrado
una frase por contener una cifra sin respaldo, y esa misma frase contenía la cifra pedida,
M10 la resucita **con la cifra inventada dentro**.

Ejecutado con el pipeline completo (`applyEnforcement`, `enforcement: "full"`,
`conceptos = {ingreso: 2500, gastos: 2250, sobrante: 250}`, pregunta `"¿cuánto me queda al mes?"`):

| # | RAW del modelo | `develop` | `agent/08` |
|---|---|---|---|
| D | `"Te quedan 250 € al mes y podrías ahorrar 9.999 € al año sin esfuerzo."` | `"Tomo nota. Seguimos con tu plan."` | **el RAW íntegro — con los 9.999 €** |
| E | `"Te quedan 250 € al mes aunque arrastras un déficit de 9500 € que hay que cerrar."` | `"Tomo nota. Seguimos con tu plan."` | **el RAW íntegro — con el déficit de 9.500 €** |

El caso E es literalmente el fixture del test `"caso real: déficit fantasma que se coló hasta
el final → eliminado (Mandamiento 3)"` (`commandments.test.ts:27`). Ese test sigue en verde
porque no pasa `userMessage` ni `raw`: **M10 lo esquiva por la puerta de atrás**. En cuanto el
turno real trae los dos campos —y `pipeline.ts:249` los pasa siempre—, M3 queda anulado.

**Por qué importa:** §14 declara G1b ("0 respuestas con cifras no trazables") vigente y
bloqueante de piloto. §0 dice que el LLM nunca es fuente de una cifra financiera. Esto pone
una cifra inventada por el LLM delante del usuario, con `violaciones: [10]` registrado — es
decir, el sistema sabe que lo está haciendo.

**Corrección exigida:** el revertido de M10 debe pasar por el mismo grounding numérico que la
respuesta original (o, como mínimo, revertir solo si el RAW no contiene ninguna cifra ausente
de `conceptos`). Un revertido a ciegas no puede ser la red de seguridad de la capa que
precisamente garantiza la trazabilidad de las cifras.

---

### 🔴 B2 · BLOQUEANTE — el bloque de "datos verificados" se contradice a sí mismo

`src/lib/calculator/orchestrator.ts:559`

El fix del bloqueante 4 cambió la fuente del desglose de `parseExpenseList(userMessage)` a
`itemsGastoActivos(scenario.gastos_items)`. Correcto en intención (§10 caso 27, E10). Pero
`gastos_items` **acumula entre turnos** mientras `gastos_detalle`/`gastos_mensuales` se
**reemplazan** con la última lista recibida. Cuando el usuario entrega el desglose en dos
tandas con nombres distintos, las dos cifras divergen y **ahora ambas viajan al modelo en el
mismo bloque**.

Secuencia real ejecutada (T1 `"gano 3000, arriendo 900, comida 500"` → T2 `"luz 100, internet 50"`):

```
TU REALIDAD (datos verificados — usa EXCLUSIVAMENTE estas cifras, no inventes ni redondees a otras):
- ingreso_mensual: 3000 €
- gastos_mensuales: 150 €                     ← solo la lista del T2
- sobrante_mensual: 2850 € (ingreso 3000 − gastos 150)
- capacidad_ahorro_anual: 34200 €
- gastos_vitales: 1550 € (arriendo 900, comida 500, luz 100, internet 50)   ← las 4 partidas
```

En `develop` el mismo estado produce un bloque **sin** la línea `gastos_vitales` — el total
seguía mal (150), pero el bloque no se contradecía. Esta tanda convierte un error silencioso
en una contradicción explícita dentro del bloque que dice "usa EXCLUSIVAMENTE estas cifras".
El usuario tiene 1.450 € de sobrante real y se le dirá que tiene 2.850 €.

AG08 **detectó esta condición**: la guarda de sanidad que añadió en `scenario.ts:2318` la
caza y emite `console.warn(...)` — y sigue adelante. Un invariante que el propio código
declara roto no puede publicarse como "dato verificado".

**Corrección exigida:** o `gastos_detalle`/`gastos_mensuales` se derivan **siempre** de
`itemsGastoActivos` (items → clasificación → buckets → agregado, la dirección que exige el
Bloque B del encargo), o el bloque no expone el desglose cuando la guarda de sanidad detecta
divergencia. Loguear no es mitigar.

---

### 🟠 M1 · MAYOR — M10 no dispara en la forma más probable del bloqueante 1

`src/lib/guardrail/commandments.ts:391-402`

`esRespuestaRotaCifraPedida` exige `rawTeniaLoQueHaceFalta`, que incluye
`!tieneAnaforaSinAntecedente(raw)`. Como el texto enforced es un **subconjunto de frases** del
RAW, cualquier RAW que contenga una frase sin dígitos con "eso"/"esa cifra" se
autodescalifica para el revertido.

Pipeline completo, pregunta `"¿cuánto me queda al mes?"`:

| RAW | Final publicado | M10 |
|---|---|---|
| `"Te quedan 250 € al mes y podrías ahorrar 9.999 € al año sin esfuerzo. Eso te deja margen."` | `"Eso te deja margen."` | **no dispara** (`violaciones: []`) |
| `"Te quedan 250 € al mes, pero tienes un déficit mensual de 9500 €. Eso hay que corregirlo."` | `"Eso hay que corregirlo."` | **no dispara** |

Es exactamente el síntoma del bloqueante 1 del QA — anáfora huérfana, cifra pedida ausente — y
la capa determinista creada para cazarlo se queda callada. Los cuatro tests de M10 pasan
porque los cuatro usan RAW de una sola frase sin anáfora.

**Atenuante:** el reintento de `route.ts:816` sí lo caza (`conceptsInSentence` detecta
`sobrante`, no aparece 250 → reintento acotado). El usuario probablemente acaba recibiendo la
cifra, a coste de una llamada extra al LLM en una forma de respuesta muy común. Por eso es
mayor y no bloqueante — pero la red determinista no está haciendo su trabajo.

---

### 🟠 M2 · MAYOR — el bloqueante 5 sigue terminando en pregunta de aclaración fantasma

`src/lib/calculator/scenario.ts:1587-1588`

`analizarExtraccion` re-parsea el mensaje con
`parseExpenseListDetallado(message, delta.gastos_mensuales)` **sin `excluirRangos`** — sin las
fronteras posicionales que el camino real de extracción sí aplica. El detector de pegado
juzga, por tanto, una lista **distinta** de la que se persiste.

Con el mensaje textual del bloqueante 5:

```
"mis gastos fueron 2 200: arriendo 900, comida 500, luz 400, internet 300, ocio 100"

items persistidos     : arriendo 900, comida 500, luz 400, internet 300, ocio 100   ✅ (el fix funciona)
items que ve el detector: arriendo 200, comida 500, luz 400, internet 300, ocio 100  ← re-parseo sin fronteras
→ extraction_status = AMBIGUOUS
→ notaExtraccionAmbigua = "POSIBLE CIFRA PEGADA: «2 200» — ¿son dos partidas separadas (2 y 200)
   o una sola cifra (2200)?"
```

El prompt del Consigliere ordena, ante una nota de extracción ambigua: *"tu respuesta de este
turno es SOLAMENTE la pregunta de aclaración. PROHIBIDO calcular"*. El usuario que escriba el
mensaje del bloqueante 5 recibirá una pregunta sobre si "2 200" son dos partidas — sobre una
cifra que el motor ya leyó bien, y atribuida a un ítem (`arriendo`) que no le corresponde.

El bloqueante 5 está resuelto en la mitad que AG08 midió (5 ítems limpios, sin "fueron",
`arriendo=900`, suma 2200 = buckets) y **abierto** en la mitad que no midió: la conversación.
El test de AG08 (`scenario.test.ts`, "BLOQUEANTE 5a") **no asserta `extraction_status`** — es
un test verde que no prueba el resultado que el QA pedía.

Mecanismo preexistente (idéntico en `develop`), no regresión. Se reporta porque la entrega
declara el caso cerrado. Mismo patrón en `"gasto unos 2 000 al mes: alquiler 1000, comida 600,
transporte 400"` → `AMBIGUOUS` con ítem sospechoso `{name: "?", amount: 2000}`.

---

### 🟠 M3 · MAYOR — `queda|quedan` en `CONCEPT_KEYWORDS` rompe frases correctas

`src/lib/guardrail/context.ts:213`

Añadir `queda|quedan` al concepto `sobrante` no afecta solo a la **pregunta** del usuario:
`CONCEPT_KEYWORDS` alimenta también el grounding de la **respuesta** (`validate.ts:326/417/512`,
`commandments.ts:141`, `policy.ts:902/914`). Cualquier frase de la respuesta con "te queda(n)" +
un importe se interpreta como si nombrara el sobrante.

Pipeline completo, `conceptos = {ingreso 2500, gastos 2250, sobrante 250, cuota 881.25, plazo 48, monto 30000}`:

| RAW | `develop` | `agent/08` |
|---|---|---|
| `"Te queda un saldo pendiente de 30000 € y te quedan 250 € al mes."` | intacto | **borrado** → `"Tomo nota. Seguimos con tu plan."` |

Mutación registrada: `"no coincide con el concepto verificado por el motor (sobrante)"`. Los
30.000 € son `monto`, un concepto verificado; la frase era correcta. Las variantes con unidad
de tiempo ("quedan 48 meses") sobreviven porque `isTimeUnit` las protege — las de dinero, no.

"Te queda / te quedan" + importe es fraseo natural para saldo pendiente, deuda restante o
plazo restante en euros. Recomiendo restringir la ampliación a la **detección de la pregunta**
(que es lo que M10 necesita) sin tocar la tabla que usa el grounding de salida — p. ej. una
tabla aparte para `conceptsInSentence` sobre `userMessage`.

---

### 🟠 M4 · MAYOR — no hay declaración de impacto (§15 paso 3, Bloque H)

El diff **no incluye ningún documento**: `git diff origin/develop...origin/agent/08 -- docs/`
está vacío. El único reporte es el mensaje de commit. §15 paso 3 exige "qué funciones
existentes se tocaron y por qué (`git diff --stat` justificado)" y §15 paso 8 la regla de
no-reemplazo.

Contrastando el diff real contra el mensaje de commit, encuentro **tres cambios de
comportamiento sobre funciones existentes que el mensaje no declara**:

| Cambio no declarado | Archivo | Efecto |
|---|---|---|
| `CONCEPT_KEYWORDS` gana `queda\|quedan` | `context.ts:213` | altera el **grounding de salida**, no solo la lectura de la pregunta (→ M3) |
| `buildScenarioContext` deja de leer el mensaje | `orchestrator.ts:559` | cambia la fuente del desglose para **todos** los llamantes (→ B2) |
| corregir un ítem puede **abrir un conflicto** | `scenario.ts:2143-2186` | una corrección explícita del usuario ahora puede bloquear derivadas |

El mensaje de commit describe el tercero de pasada ("abre el ciclo de conflicto") pero ninguno
de los dos primeros. Los dos primeros son la causa de un bloqueante y un mayor.

---

### 🟡 m1 · MENOR — la precedencia `tool` > `regex` no está implementada

`src/lib/calculator/scenario.ts:2118-2127`

El encargo (O.5) pide que `source: "tool"` tenga precedencia sobre `"regex"`. La dedup es
**solo "el más reciente gana"**, sin mirar `source`. Verificado:

```
T1 (tool) : ocio 150 (tool), casa 900 (tool)
T2 (regex): ocio 100 (regex), casa 900 (regex)      ← el regex pisa al tool
```

La dedup en sí funciona bien (5 categorías activas, log completo de 10, `superseded` conservado,
suma coherente). Solo falta la regla de precedencia.

### 🟡 m2 · MENOR — `gastos_items` crece sin tope

`scenario.ts:2118-2127` archiva (`superseded: true`) pero nunca colapsa. §8 fija un **cap de 5
versiones por campo** en `scenario_state` precisamente porque "el estado se lee y escribe en
cada turno; sin cap, una conversación larga con correcciones infla el jsonb y la latencia sube
con él". Un usuario que re-enuncie un desglose de 15 partidas cinco veces deja 75 entradas en
el jsonb, y ahora ese jsonb es **de usuario** (E10), no de conversación: no se recicla nunca.

### 🟡 m3 · MENOR — tests estáticos que son `grep`, no comportamiento

`src/app/api/chat/route.static.test.ts:70-87`. Los tres tests nuevos comprueban que ciertos
identificadores existen en el fuente (`assert.match(src, /cifraAusente/)`). Detectan un borrado
accidental, que es su propósito declarado y es legítimo — pero **no** ejercitan la ruta real, y
son la única cobertura de los bloqueantes 1 y 2 a nivel de `route.ts`. Conviene no contarlos
como cobertura de comportamiento en el próximo reporte.

### 🟡 m4 · MENOR — la preposición se cuela en el nombre de la partida

`"gano 2000 y gasto en arriendo 800, comida 300, luz 100"` → ítem `"en arriendo"`. Cosmético,
pero ese nombre se enumera literalmente en el bloque "TU REALIDAD" y ahora también entre
sesiones (B2), así que llega al usuario.

---

## 3 · Riesgos latentes que el contrato no cubre

**R1 — V15 sigue rota con cópula + complemento intermedio (condición de piloto de E9, abierta).**
Inventé cuatro fraseos de "agregado + palabra intermedia + detalle" que no están en los tests
de AG08. Tres salen bien; el cuarto falla, **idéntico en `develop` y en `agent/08`**:

```
"mis gastos del mes pasado fueron de 1500: hipoteca 800, comida 400, luz 300"
→ items: hipoteca 1500 (!), comida 400, luz 300 · gastos_mensuales = 2200 · PARTIAL
```

El agregado 1.500 se atribuye como importe de la primera partida, la hipoteca real de 800
desaparece y el total sale 2.200 en vez de 1.500. Es la misma clase de fallo que E9 describe
para V15, con `CONECTOR_DECLARATIVO` incapaz de absorber `"del mes pasado fueron de"`. **No es
regresión de esta tanda** — pero E9 lo declaró *condición antes del piloto*, y esta tanda toca
justo ese regex (`GASTO_AGREGADO_DETALLE_RE`) sin cerrarlo. La lista negra de cópulas
(`fueron|fue|eran|era|seran|sera` en `expenses.ts:186`) es defensa en profundidad, no solución:
se rompe en cuanto hay un complemento entre la cópula y la cifra.

**R2 — la corrección de un ítem puede abrir un conflicto contra un agregado derivado.**
`scenario.ts:2143-2186` compara el nuevo total contra `gastos_agregado_origen`. Verifiqué que
**no** se dispara cuando el agregado solo se derivó de la lista (`gastos_agregado_origen`
queda `undefined` → la corrección se acepta limpia, total 2250, eco correcto). El caso está
bien resuelto. Queda el riesgo de diseño: con agregado declarado, `"me equivoqué, el ocio son
150"` produce **conflicto**, no aceptación. Es defendible por §6, pero significa que una
corrección explícita del usuario bloquea sus derivadas hasta que resuelva. Merece decisión
explícita de Luis, no quedar como efecto colateral.

**R3 — cobertura del guardarraíl de cifra pedida por nombre de concepto.**
`"¿cuánto tengo que recortar?"` no detecta ningún concepto (`CONCEPT_KEYWORDS` mapea el
sustantivo `recorte`, y el motor publica `recorte_necesario`), así que el reintento de
`route.ts:816` nunca cubre esa pregunta. Preexistente y de bajo impacto. *(Verifiqué el caso
`brecha`, que el encargo pedía comprobar: **funciona** — el motor publica la clave `brecha` y
`conceptsInSentence` la detecta.)*

---

## 4 · Tabla de casos de aceptación

Todos ejecutados sobre el código de `agent/08` con `extractScenarioDelta` / `mergeScenario` /
`buildScenarioContext` reales.

| # | Caso | ¿Existe test? | ¿Ejercita ruta real? | ¿Pasa? |
|---|---|---|---|---|
| 9 | `"Telecomunicaciones_Necesario 60 100 Pañales_Bebe_Vital"` → AMBIGUOUS, ítem sospechoso expuesto, no conflicto | sí (preexistente) | sí | ✅ `AMBIGUOUS`, `itemSospechoso {60100}`, sin conflicto |
| 10 | `"gasto 2 500 €"` → 2500 | sí | sí | ✅ 2500, `COMPLETE` |
| 11 | `"gano 2300, tengo 43 años, 2 hijos, gasto 2200"` | sí | sí | ✅ `COMPLETE`, no pregunta por 43 ni 2 |
| 12 | `"gano 2300 y gasto 2200 y 450"` → PARTIAL | sí | sí | ✅ `PARTIAL`, usa 2300/2200 |
| 13 | `"Diezmo_Vital 225, Casa_Vital 700"` | sí | sí | ✅ 2 ítems con `_` |
| 14 | `"alquiler 700 comida 450 luz 120"` | sí | sí | ✅ 3 ítems |
| 15 | `"Alquiler: 700, Comida: 450, Luz: 120"` | sí | sí | ✅ 3 ítems |
| 16 | 15 partidas de testdev7 | sí | sí | ✅ 15 ítems, suma 2250, conflicto 2200/2250 diff 50 |
| 17 | Crédito con monto sin plazo | sí | sí | ✅ `PARTIAL`, plazo nunca 0, el monto sobrevive |
| E5-24 | `"gasto aproximadamente 2000 entre vivienda, comida"` | sí | sí | ✅ gastos 2000, `gastos_items` vacío |
| extra | desglose sin confirmar: no propone recorte pero sí responde sobrante | sí | sí | ✅ `notaDetalleSinConfirmar` bloquea el recorte · `sobrante = 250` disponible · `recorte_propuesto_50pct` ausente |
| I.1 | Fronteras posicionales como **rangos**, no set de strings | sí | sí | ✅ `expenses.ts:249-252` `interface Rango {start,end}` · `excluirRangos` en `parseExpenseListDetallado` (`expenses.ts:563`) |

### Bloque I.2 — los tres mensajes del bloqueante

| Mensaje | Esperado | Obtenido |
|---|---|---|
| `"gano 2000 y gasto en arriendo 800, comida 300, luz 100"` | gastos 1200 | ✅ 1200 (nombre `"en arriendo"`, ver m4) |
| `"quiero una casa de 200000 a 240 meses, casa 700, comida 300, luz 90"` (ingreso 1500) | gastos 1090 | ✅ 1090, meta 200000/240 |
| `"quiero financiar una casa de 200000 a 240 meses, …"` | idéntico | ✅ **byte a byte idéntico** — independencia de orden |

### Bloque L — V15/V16, los seis mensajes

| # | Mensaje | Esperado | Obtenido |
|---|---|---|---|
| 1 | `"mis gastos fueron 1200: internet 300, agua 400, gas 500"` | 1200 · 3 ítems | ✅ 1200, 3 ítems, `COMPLETE` |
| 2 | `"gastamos 950 al mes: mercado 500, gasolina 250, farmacia 200"` | 950 · 3 ítems | ✅ 950, 3 ítems, `COMPLETE` |
| 3 | `"gasté 1800: renta 900, comida 500, luz 400"` | 1800 · 3 ítems | ✅ 1800, 3 ítems |
| 4 | `"gasto 1500 en total: casa 700, comida 300"` | casa=700, el 700 no queda huérfano | ✅ casa=700, comida=300; agregado 1500 vs detalle 1000 (33% > 5%) → `AMBIGUOUS`, gastos no se fija — coherente con §6 |
| 5 | `"gasto 1500 en total: casa 700, comida 300, luz 500"` | suma exacta → CONSISTENT | ✅ 1500, `COMPLETE`, sin conflicto |
| 6 | `"sueldo 3000, quiero un piso de 200000"` | ingreso 3000 · meta 200000, nunca cruzados | ✅ ingreso 3000, meta.monto 200000 |

**Mis cuatro formas inventadas** (agregado + palabra intermedia + detalle):

> **ERRATA (AG01, ronda 2 — 2026-08-14).** Las dos primeras filas de esta tabla estaban
> **mal**: las anoté como correctas sin haber visto su salida (quedaron en la parte truncada
> del volcado de la sonda). Re-ejecutadas en la ronda 2 sobre `develop`, `8a8f048` y
> `a97206e` — las tres idénticas — **fallan**: `"…rondan los 1000…"` → 1700 con `luz = 1000`,
> y `"…he gastado 900 en total…"` → 1800 con un ítem `"este he gastado" = 900`. Ambas
> `COMPLETE`. No es regresión de ninguna tanda; agrava el alcance de R1. Detalle y
> consecuencias en `REVISION_AG01_qa_testdev8_ronda2.md` §5.

| Mensaje | Resultado |
|---|---|
| `"mis gastos rondan los 1000 al mes: luz 300, agua 300, gas 400"` | ❌ *(ver errata arriba)* — 1700, `luz = 1000` |
| `"este mes he gastado 900 en total: renta 500, comida 250, bus 150"` | ❌ *(ver errata arriba)* — 1800, ítem `"este he gastado" = 900` |
| `"mis gastos del mes pasado fueron de 1500: hipoteca 800, comida 400, luz 300"` | ❌ **hipoteca 1500, total 2200** — ver R1 (preexistente) |
| `"gasto unos 2 000 al mes: alquiler 1000, comida 600, transporte 400"` | ⚠️ 2000 y 3 ítems correctos (**mejora** sobre `develop`, que daba `alquiler 2` / total 1002) pero `AMBIGUOUS` con ítem sospechoso fantasma — ver M2 |

### Bloque O — QA de go-live

| # | Verificación | Resultado |
|---|---|---|
| O.1 | Con `{sobrante: 250}`, la cifra pedida no se borra; anáfora sin antecedente → revierte al RAW | ⚠️ **parcial.** Mis 3 respuestas rotas (`"Esa es tu capacidad real…"`, `"Con ese monto…"`, `"Eso es lo que te queda…"`) se detectan las 3 y devuelven el 250 ✅ — pero en el pipeline completo M10 **no dispara** si el RAW contiene la misma anáfora (M1) |
| O.2 | `"cuantos son mis gastos en total?"` → 2250, no el sobrante | ⚠️ `conceptsInSentence` detecta bien `gastos`/`ingreso`/`cuota`/`sobrante`/`brecha` ✅; el enforcement **no** interviene (por diseño: `raw === text`). La única defensa es el reintento de `route.ts:816`, **no verificable por mí** (necesita LLM) |
| O.3 | Sesión nueva, crédito 30000/48/18 CONFIRMED, sin datos nuevos → cuota disponible, `cuota` no en `missing` | ✅ `conceptos.cuota = 881.25` desde `user_financial_state` sin aportar nada · `missing = ["ingreso","gastos"]`, **sin `cuota`** |
| O.4 | Desglose sobrevive entre sesiones; el bloque enumera las partidas | ✅ camino completo `splitScenarioState` → JSON → `mergeEstadoPersistido` → `buildScenarioContext`: las 5 partidas con sus importes aparecen en "TU REALIDAD". `summarizeScenario` solo da el agregado — el desglose llega por `notaDatosCalculados`, que es justo el fix |
| O.5 | 5 ítems, ninguno "fueron", arriendo=900, suma ítems = buckets = 2200 | ✅ los cuatro asertos (`develop` daba 6 ítems, `"fueron": 2`, `arriendo: 200`, total 1502). Dedup entre turnos ✅ (5 activos, log 10, `superseded`) · precedencia `tool > regex` ❌ (m1) · **`extraction_status = AMBIGUOUS`** ❌ (M2) |
| O.6 | Corrección acusada + anti-repetición | ✅ la corrección se enuncia siempre, con el nuevo total (2250) cuando no hay conflicto y con instrucción de señalar la divergencia cuando lo hay. `contarRepeticionesMensajeUsuario` cuenta el **mensaje del usuario** (0/1/≥2 → tres notas distintas), leído del historial **antes** de insertar el turno actual (`route.ts:248` vs `:391`) ✅ |
| O.7 | Calidez | **no verificable por mí** — requiere generación real del LLM. Juicio sobre el prompt: ver §5 |
| O.8 | Sin regresiones | ✅ G1c en ambos sentidos (idéntico: 2200/2250/diff 50) · V14 (`extraction_status` nunca `undefined` en ninguna de las ~30 sondas) · V16 (1200 ✅) · fronteras por rango ✅ · `"gasto 2 500 €"` → 2500 ✅ · 15 partidas testdev7 ✅ · el ingreso nunca como ítem ✅. **Regresiones nuevas fuera de esa lista: B1, B2, M3** |

---

## 5 · Tabla de invariantes

| # | Invariante | Estado | Evidencia |
|---|---|---|---|
| **V1** | Un dato extraído con confianza no se descarta por huérfanos | ✅ verificado | Caso 12: `PARTIAL` y aun así ingreso 2300 + gastos 2200 persisten. Con `itemSospechoso` los gastos **no** se descartan (solo `deltaSinGastosPorDiscrepancia` recorta, y solo ante discrepancia) |
| **V5** | Nada inferido por el LLM entra en `conceptos` | ❌ **violado en efecto** | No por `conceptos` (intacto) sino por la salida: B1 republica una cifra del LLM ausente de `conceptos` |
| **V8** | El cero se rechaza como placeholder | ✅ verificado | `detectarValoresInvalidos` intacto; caso 17 → plazo `MISSING`, nunca 0 |
| **V9** | El estado sobrevive re-lectura desde BD | ✅ verificado | O.4 recorre `splitScenarioState` → `JSON.parse(JSON.stringify())` → `mergeEstadoPersistido`; test de idempotencia ida y vuelta en verde |
| **V10** | `raw !== final` ⟹ ≥1 entrada en `mutations` | ✅ verificado | Todas las sondas del pipeline: cuando el texto cambió hubo ≥1 mutación (`auditarMutaciones` intacto) |
| **V12** | El ingreso nunca como ítem de gasto | ✅ verificado | testdev7 con ingreso 2500: ningún ítem con ese importe |
| **V13** | Token reclamado = frontera con offsets preservados | ✅ verificado | Bloque I.2 caso 2 vs 3: `"casa"` del crédito no destruye `"casa 700"` del gasto; resultado idéntico en ambos órdenes |
| **V14** | Ley de conservación · `extraction_status` nunca `undefined` | ✅ verificado | ~30 mensajes distintos, incluidos 4 inventados: siempre `COMPLETE`/`PARTIAL`/`AMBIGUOUS` |
| **V15** | Atribución correcta | ⚠️ **parcial** | 5 de 6 mensajes del Bloque L ✅ y 3 de mis 4 inventados ✅; falla `"…del mes pasado fueron de 1500: hipoteca 800…"` (R1, preexistente) |
| **V16** | No doble conteo | ✅ verificado | L1 (1200), L2 (950), L3 (1800) correctos; `aplicarGuardaV16` avisa cuando el detalle excede el agregado |
| — | `scenario_state` se sigue poblando | ✅ verificado | todas las sondas |
| — | `response_telemetry` sigue escribiendo | ✅ verificado | `route.static.test.ts` (verde): `logResponseTelemetry` solo desde `persistence.ts` |
| — | `runGuardrail` sigue cableado · `persistTurn` punto único de escritura | ✅ verificado | `pipeline.ts` intacto salvo el paso de `userMessage`; `persistTurn` sin cambios |
| — | `llm.ts` NO tocado (dominio AG01) | ✅ verificado | ausente del diff |
| — | Tabla de puntos del ICA invocada, no redefinida (dominio AG06) | ✅ verificado | ningún archivo de ICA en el diff |
| — | Umbral 50× del detector de pegado sin tocar | ✅ verificado | `expenses.ts` solo cambia `STOPWORD_NAME_RE` |
| — | `meta.monto` sin cambios | ✅ verificado | ausente del diff |
| — | Sin reconciliación cross-turno / CONFLICT / ASSUMED / SUPERSEDED **nuevos** | ✅ verificado | ya existían en `develop` (tanda 2, mergeada). Lo único nuevo es reutilizar el ciclo existente en la corrección de ítem (`scenario.ts:2143-2186`) — declarado en el commit; ver R2 |

### Detector de pegado (Bloque E)

| Escenario | Resultado |
|---|---|
| Umbral `importe > agregado` | ✅ implementado (`"gasto 1000 en total: hipoteca 1200, …"` → `AMBIGUOUS`) |
| Umbral por magnitud (50× tras E1) | ✅ implementado, con suelo absoluto |
| Listas de 1 ítem | no se evalúa (sin mediana) — correcto |
| Listas de 2 ítems | no se evalúa — correcto |
| **Falso positivo espejo**: hipoteca 1200 entre gastos de 40-60 | ✅ **no se marca** (`"hipoteca 1200, comida 60, luz 50, agua 40, internet 45, ocio 55"` → `COMPLETE`, sin ítem sospechoso). La recalibración de E1 hace su trabajo |
| **Falso positivo real encontrado** | ❌ el agregado con miles-con-espacio se marca a sí mismo como pegado — ver M2. No es un problema de umbral: es que el detector mira una lista mal parseada |

### Migración 019 (Bloque F)

**No aplica a esta tanda.** El diff no contiene ninguna migración
(`git diff … -- supabase/` vacío); `019_telemetry_extraction.sql` es de una tanda anterior y no
se toca. El campo nuevo `superseded?: boolean` vive dentro del jsonb ya existente, así que no
requiere DDL. Riesgo asociado: m2 (crecimiento sin tope del jsonb, que sí entra en la purga de
retención documentada en `docs/TELEMETRIA_RETENCION.md`).

### Eco sin plantilla (Bloque G)

✅ **Sin violación.** `renderDatosRecienEntendidos` sigue devolviendo **datos + instrucción**
al modelo, no texto publicable: *"Tu PRIMERA línea devuelve esto de forma compacta y natural
(con tu propia voz, no copies este formato)"*. La rama nueva de corrección (`scenario.ts:1670-1677`)
mantiene el patrón: entrega `nombre`, `importe` y `total nuevo`, y ordena acusarlo con palabras
propias. Los ejemplos añadidos al prompt están explícitamente marcados *"no los copies literal,
son ilustraciones de registro"*. Ningún string fijo llega al usuario.

### Calidez (O.7) — juicio cualitativo

No puedo generar respuestas reales (sin credenciales de LLM), así que juzgo el instrumento.
Las tres reglas nuevas de `consigliere.ts:71-78` atacan exactamente los tres síntomas del
mayor 8 y están bien formuladas: *acompañar antes de dirigir*, *no repetir la construcción de
cierre*, *cerrar con algo accionable y no administrativo*. Los tres pares ANTES→DESPUÉS son
buenos y concretos ("Confirmas que arrancamos" → "empecemos por los 150 € de ocio, ¿te
parece?").

Dos reservas:

1. **Riesgo de molde nuevo.** Los ejemplos comparten la misma arquitectura de tres tiempos
   (normalizar el sentimiento → dar la cifra → proponer el primer paso). Con tres ejemplos tan
   parecidos, lo probable es que el modelo aprenda *esa* plantilla. La instrucción anti-molde
   existe dos párrafos más arriba y ahora compite con tres ejemplos que la contradicen en la
   práctica.
2. **Tensión sin resolver con "Resultado primero".** `PRINCIPIOS DE RESPUESTA — INNEGOCIABLES`
   sigue exigiendo *"la cifra clave va en la PRIMERA frase"*, y la regla nueva pide acompañar
   **antes** de dar el número. En una brecha o un déficit las dos reglas se contradicen
   literalmente. Merece una frase que zanje la precedencia (p. ej. "en turno de mala noticia,
   la calidez precede a la cifra; en el resto, resultado primero").

Es una mejora neta del prompt. **Medible solo en QA manual**, no aquí.

---

## 6 · Ejecución de la batería

| Comando | Resultado |
|---|---|
| `npm install` | ✅ 388 paquetes |
| `npm run build` | ⚠️ **TypeScript compila sin errores** (`Finished TypeScript in 3.1s`). El build falla después, en el prerender de `/register`, por `@supabase/ssr: Your project's URL and API key are required` — **credenciales ausentes, no código de AG08** |
| `npm test` | ✅ 7 suites, 0 fallos |
| `npm run test:guardrail` | ✅ 8 suites (120+6+11+27+27+33+24+18), 0 fallos |
| `npm run test:calculator` | ✅ 5 suites (15+33+24+180+15), 0 fallos |
| `npm run test:regression` | ✅ **84/84 turnos · 47 escenarios · enforcement=full** |
| `npm run test:e2e` | **no verificable por mí** — requiere credenciales de Supabase/OpenAI |
| `npm run smoke:db` | **no verificable por mí** — requiere credenciales de Supabase |

Verde total. Ninguno de los dos bloqueantes aparece en esa batería.

---

## 7 · Recomendación a Luis

**Devolver a AG08.** No mergear.

El trabajo es bueno y va en la dirección correcta: los bloqueantes 3, 4 y 5 del QA están
realmente resueltos, la memoria entre sesiones funciona (verificada por el camino completo de
BD, no de memoria), la dedup de ítems funciona, y el mayor 6 (corrección acusada) y el mayor 7
(anti-repetición sobre el mensaje del usuario) están bien planteados. El único fallo de fondo
es **el mecanismo elegido para el bloqueante 1**.

### Obligatorio antes de un nuevo PR

1. **B1 · El revertido de M10 debe pasar por el grounding numérico.** Hoy republica cifras
   inventadas y anula el Mandamiento 3, con G1b vigente. Añadir el test que falta: RAW con la
   cifra pedida **y** una cifra ausente de `conceptos`, en la misma frase → el resultado no
   puede contener la cifra ausente. Ese test hoy falla.
2. **B2 · `gastos_mensuales`/`gastos_detalle` derivados de `itemsGastoActivos`, o no exponer el
   desglose cuando la guarda de sanidad detecta divergencia.** El bloque de "datos verificados"
   no puede contener dos cifras de gasto incompatibles. Test: T1 lista parcial → T2 lista
   parcial con nombres nuevos → `suma(items activos) == suma(buckets) == gastos_mensuales`.
3. **M3 · Revertir `queda|quedan` en `CONCEPT_KEYWORDS`** y resolver la detección de la
   pregunta por una vía que no toque el grounding de salida. Test de regresión con
   `"Te queda un saldo pendiente de 30000 € y te quedan 250 € al mes."` → intacta.
4. **M4 · Entregar la declaración de impacto de §15 paso 3**, con las tres funciones existentes
   modificadas que el commit no declara.

### Recomendado en la misma tanda (barato y evita otra vuelta)

5. **M1 · Relajar la condición de anáfora sobre el RAW** en `esRespuestaRotaCifraPedida`: basta
   con exigir que el RAW **contenga la cifra pedida**; que además tenga una frase con "eso" no
   debería descalificar el revertido. Con los dos casos que documento en M1 como test.
6. **M2 · Pasar `excluirRangos` al re-parseo de `analizarExtraccion`** (`scenario.ts:1587-1588`)
   para que el detector de pegado juzgue la **misma** lista que se persiste. Cierra el
   bloqueante 5 en su mitad conversacional. Test: el mensaje del bloqueante 5 →
   `extraction_status === "COMPLETE"`.
7. **m1 · Precedencia `tool > regex`** en la dedup.

### Diferible con decisión explícita

- **R1 (V15 con cópula + complemento)** — condición de piloto abierta desde E9. Preexistente,
  pero el piloto no debería abrirse con `"mis gastos del mes pasado fueron de 1500: …"`
  devolviendo 2.200. Si se difiere, que sea decisión tuya registrada, no olvido.
- **R2** — ¿una corrección explícita del usuario debe abrir conflicto contra un agregado
  anterior, o superarlo? Hoy abre conflicto. Es defendible por §6; conviene que lo decidas tú.
- **m2** — cap de versiones en `gastos_items`, coherente con §8.

### Enmiendas al contrato que esta revisión deja pendientes

Siguiendo la nota de proceso de E7+E8 (*"toda invariante que un revisor usa para aprobar o
rechazar se incorpora a §9 en la misma tanda"*), esta revisión ha juzgado con dos reglas que
el contrato no contiene formalmente y que propongo incorporar:

- **V17 — Ninguna capa de reparación puede reintroducir una cifra que una capa anterior eliminó
  por falta de respaldo.** Un revertido al RAW re-aplica siempre el grounding numérico.
  *(Motivo: B1.)*
- **V18 — El bloque de datos verificados es internamente consistente.** Dos cifras del mismo
  campo (agregado y suma del desglose) no pueden coexistir en él con valores incompatibles.
  *(Motivo: B2.)*

---

*Revisión ejecutada sobre `origin/agent/08` en worktree aislado, con `origin/develop` como
control para separar regresión de defecto preexistente. Ningún código de AG08 fue modificado;
esta entrega es solo el informe.*
