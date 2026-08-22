# Corrección AG08 — fórmula canónica de G1d + notaAmbigua filtrada + respuesta corta anclada + porcentajes, conteos y unidades

**Fecha:** 22 de agosto de 2026
**Rama:** `agent/08`, sobre la punta `31af215` (sin reset — ver §0)
**Motivado por:** reclasificación del problema: el clasificador ruidoso NO afecta solo al digest.
`notaAmbigua` se inyecta en `systemPrompt2` (`route.ts`) y en el prompt de regeneración — es un
defecto VIVO de cara al usuario, con datos reales entrando. Impacta G2, G3 y G7.
**Contrato:** `docs/CONTRATO_TRUTH_ENGINE.md` §5.1 · §9.1 (V11/V13/V14)

---

## 0 · Verificación previa al reset (regla de proceso)

```
$ git log --oneline origin/agent/08 --not origin/develop
31af215 ag08: tolerancia año↔mes solo con marca anual explícita — cierra G1d
2c7486d ag08: G1d fidelidad de extracción — V14 anclado al mensaje original + sensor de importes sin destino
```

Ambos commits presentes. **No se reseteó nada**: se trabajó sobre la punta `31af215`. La rama de
respaldo `respaldo/tanda8-g1d` (publicada la tanda anterior) sigue viva como red hasta que el
merge esté hecho.

---

## 1 · Reclasificación confirmada — el ruido llega al usuario

Verificado leyendo el código antes de tocar nada: `notaAmbigua` entra en `systemPrompt2`
(`route.ts:603`) y en `systemPromptRegen` (`route.ts:639`). Un falso positivo del clasificador no
se queda en la telemetría: hace que **el Consigliere pregunte al usuario por su edad, por un
porcentaje o por un conteo como si fueran gastos sin asignar**.

**Baseline medido (código en `31af215`, antes de esta tanda), 16 mensajes reales del dogfooding:
7/16 degradaban y 7/16 inyectaban `notaAmbigua`** — reproduciendo exactamente la medición del
encargo.

---

## 2 · FIX 1 — fórmula canónica de G1d

El comentario de la migración 024 describe **V14** correctamente y NO se ha tocado. Lo que se
corrige es la fórmula, que no implementaba la definición acordada.

| | Qué mide | Un huérfano relevante |
|---|---|---|
| **V14** | CONSERVACIÓN: ¿el número dejó rastro? | **SÍ es destino declarado** |
| **G1d** | FIDELIDAD: ¿la cifra publicada refleja todo el dinero, y el estado era honesto? | destino legítimo, pero su **precio obligatorio es PARTIAL** |

La implementación anterior contaba TODO huérfano como "importe sin destino", con lo que un sistema
honesto se marcaba a sí mismo como violación. **El delito nunca fue tener un huérfano relevante —
fue tenerlo y declarar COMPLETE**, que es lo ocurrido el 22 de agosto.

Nueva función pura `medirFidelidadExtraccion` (`scenario.ts`). **G1d dispara si:**
(a) existe un importe monetario sin NINGÚN destino, **o**
(b) existe un huérfano relevante **y** `extraction_status` es `COMPLETE`.

**Caso de verificación obligatorio — resultado real:**

```
11 de 17 → status=PARTIAL huerfanos=[5,20,10,10,50,30] sinDestino=[] violaG1d=false   ✓ PASA
mismos huerfanos con COMPLETE                                → violaG1d=true          ✓ VIOLA
```

Un sistema que captura 11 partidas, degrada a PARTIAL y pregunta por los seis números restantes
**pasa** la compuerta. El mismo estado declarando COMPLETE la viola, con
`motivo: "huerfano_con_complete"`.

---

## 3 · FIX 2 — cerrar la vía de `notaAmbigua`

`detectarNumerosHuerfanos` y `analizarExtraccion` reciben ahora el estado PREVIO (`seed`). Las
exclusiones ocurren **POR CONSTRUCCIÓN** — el número nunca llega a ser candidato — no por un
filtro posterior sobre una lista ya contaminada. Como `notaAmbigua` se deriva de esa misma lista,
queda limpia sin ninguna lógica adicional en `route.ts`.

---

## 4 · FIX 3 — respuesta corta anclada al contexto (causa dominante)

Patrón dominante del ruido medido: el sistema pide un dato y el usuario contesta con la cifra
pelada; el extractor no la ancla a ningún campo y el sensor la marcaba como dinero perdido — con
lo que el Consigliere volvía a preguntar por la cifra que el usuario **acaba de darle**.

`esRespuestaCortaAnclada` exige **las dos** condiciones: (1) el turno anterior pedía algo concreto
(`missing` no vacío o propuesta pendiente), y (2) el mensaje es mayoritariamente esa cifra — sin
ninguna palabra de contenido más allá de números, moneda, unidades de plazo, conectores y
vocabulario de tasa. La condición (2) es la que impide que un mensaje largo y narrativo se tome
por una respuesta corta (verificado con los tres mensajes emocionales del dogfooding).

Se aplica el mínimo autorizado: la cifra **no cuenta como huérfana ni genera `notaAmbigua`**. No se
fuerza la asignación al campo pedido — eso sería ampliar la extracción, fuera de la ventana.

---

## 5 · FIX 4 — porcentajes, conteos y unidades

| Regla | Cubre | Salvaguarda |
|---|---|---|
| Porcentaje (`%` o escrito) | `"para TDC un 18%"`, `"10% de mi salario"` | El `\b` va solo en las alternativas de palabra: `%\b` nunca casaba (ambos lados no-word) |
| Conteo con sustantivo DESPUÉS | `"14 gastos"`, `"3 hab"` | `"gastos"` solo cuenta tras el número — `"gastos 2200"` sigue siendo declaración monetaria |
| Conteo con verbo ANTES | `"somos 5 en casa"` | **NO** incluye `entre` ni la cópula `son` — ver §6 |
| Unidades | metros, m2, km, kilos, litros | |
| Años de 4 dígitos en contexto temporal | `"desde 2019"`, `"en 2024"` | Exige rango 1900-2100 **y** preposición temporal delante |
| Dígito soldado a letra | el `"2"` de `"m2"` | Acotado a 1-2 dígitos, para no tocar formas tipo `EUR1000` |

**No sobredisparar (transversal):** una cifra con marca de moneda adyacente (€, EUR, euros, $) es
SIEMPRE un importe monetario y se comprueba ANTES que cualquier exclusión de FIX 4.

`numerosCandidatos` (la lista que autoriza al guardarraíl a que el modelo CITE un número) se deja
**intacta**: allí interesa que el modelo pueda mencionar un porcentaje sin que se le bloquee. La
clasificación nueva vive en una ruta aparte (`importesMonetarios`), cuya pregunta es distinta:
*¿esto es dinero del usuario que puede haberse perdido?*

---

## 6 · Dos sobredisparos propios, detectados y corregidos en el proceso

Se documentan porque son exactamente el riesgo espejo que el encargo advierte:

1. **`entre` en el conteo-antes** rompió 3 tests reales de rangos (`"gano entre 2000 y 2500"` debe
   conservar AMBOS extremos como huérfanos). Retirado.
2. **`son` en el conteo-antes** habría silenciado `"mis gastos son 2200"` — la forma MÁS común de
   declarar un importe. Dejaría a G1d ciego ante la pérdida de ese número, justo lo que la
   compuerta existe para ver. Retirado, con test de regresión propio en positivo.

---

## 7 · Calibración en frío — CERO en ambos criterios

| # | G1d | notaAmbigua | status | mensaje |
|---|-----|-------------|--------|---------|
| 1 | ✓ pasa | ✓ ninguna | COMPLETE | tengo 43 años y 2 hijos |
| 2 | ✓ pasa | ✓ ninguna | COMPLETE | si puedo, como estas tu, aveces me siento frustrado poque tengo 43 anos… |
| 3 | ✓ pasa | ✓ ninguna | COMPLETE | sabes, ese tema me frustra porque tengo 43 anos dos hijos… |
| 4 | ✓ pasa | ✓ ninguna | COMPLETE | para TDC un 18% |
| 5 | ✓ pasa | ✓ ninguna | COMPLETE | maximo 1 ano |
| 6 | ✓ pasa | ✓ ninguna | COMPLETE | 10% de mi salario |
| 7 | ✓ pasa | ✓ ninguna | COMPLETE | quiero comprar un carro de 30.000 a 48 meses |
| 8 | ✓ pasa | ✓ ninguna | COMPLETE | gano 2 500 y gasto 2 200 |
| 9 | ✓ pasa | ✓ ninguna | COMPLETE | gano 2000 y gasto 1500 |
| 10 | ✓ pasa | ✓ ninguna | COMPLETE | quiero una casa de 200000 a 30 anos |
| 11 | ✓ pasa | ✓ ninguna | COMPLETE | 150000 a 30 anos |
| 12 | ✓ pasa | ✓ ninguna | COMPLETE | 30000 en 48 meses |
| 13 | ✓ pasa | ✓ ninguna | COMPLETE | 2300 euros |
| 14 | ✓ pasa | ✓ ninguna | COMPLETE | 10000 euros en 48 cuotas con una tasa TAEG de 9% |
| 15 | ✓ pasa | ✓ ninguna | COMPLETE | debo 2400 euros, pago mensual 90 euros y tengo un TAE de 18% |
| 16 | ✓ pasa | ✓ ninguna | COMPLETE | En la lista solo estas contenplando 14 gastos y en total son 17 |

**falsos positivos G1d: 0/16 · inyecciones espurias de notaAmbigua: 0/16**
(baseline antes de esta tanda: **7/16 y 7/16**)

---

## 8 · Tests actualizados bajo V11

Tres asertos actualizados **con autorización explícita (acuerdo 27)**, tras detener la entrega y
reportar. Ninguno es un debilitamiento: los tres afirman el comportamiento correcto **en positivo**.

### 8.1 · `scenario.test.ts` — "ambiguo → no extrae nada"

**Aserto anterior:**
```js
assert.deepEqual(extractScenarioDelta("me gusta el 20% de las cosas"), { extraction_status: "PARTIAL" });
```

**Por qué el requisito viejo era incorrecto:** codificaba como especificación que un porcentaje
suelto es un huérfano RELEVANTE que degrada el turno. Un porcentaje **no es un importe monetario**:
no puede faltar en la suma de gastos, no desaparece del patrimonio del usuario, y no admite la
pregunta "¿a qué corresponde?". Ese requisito es precisamente el comportamiento ruidoso que esta
tanda corrige.

**Asertos nuevos (en positivo):**
```js
assert.deepEqual(deltaPct, { extraction_status: "COMPLETE" });
assert.ok(huerfanosPct.numerosNoRelevantes.includes(20));   // V14: CONSERVA destino declarado
assert.deepEqual(huerfanosPct.numerosHuerfanos, []);        // pero NO como huérfano relevante
assert.equal(notaExtraccionAmbigua(...), null);             // y no se le pregunta al usuario
```

### 8.2 · `scenario.test.ts` — "FIX 2: SIN crédito previo + '18%'"

**Asertos anteriores:**
```js
assert.deepEqual(extractScenarioDelta("18%", "es"), { extraction_status: "PARTIAL" });
assert.deepEqual(extractScenarioDelta("18%", "es", {}), { extraction_status: "PARTIAL" });
```

**Por qué el requisito viejo era incorrecto:** mismo eje que 8.1. Lo que este test SÍ protege —que
sin crédito previo un "18%" no fabrique una TAE— **se conserva y se refuerza** con un aserto
explícito (`delta.credito === undefined`), que antes solo estaba implícito en el `deepEqual`.

**Asertos nuevos:** `credito === undefined` · `COMPLETE` · `18 ∈ numerosNoRelevantes` ·
`numerosHuerfanos === []` · `notaExtraccionAmbigua === null`, para ambos valores de `prev`.

### 8.3 · `route.static.test.ts` — payload de telemetría G1d

**Refactor, no inversión.** El requisito (los tres campos proceden del MENSAJE ORIGINAL, no del
output del calculador) se conserva íntegro; cambia el punto de medición.

**Asertos anteriores:** `/const importesEnMensaje = numerosCandidatos\(cleanMessage\)/` ·
`/const importesSinDestino = huerfanos\.numerosHuerfanos/`
**Asertos nuevos:** contra `medirFidelidadExtraccion(cleanMessage, delta, analisis.extraction_status, seed)`
y sus tres campos derivados.

### Alcance de la autorización — respetado

Se aplicó **exclusivamente al eje porcentaje/no-monetario**. Ningún aserto sobre un importe
monetario se ha modificado. Al contrario: los dos sobredisparos propios de §6 se resolvieron
**retirando mi regla** para que los asertos monetarios existentes siguieran protegiendo su
requisito, en vez de invocar "corrección de requisito".

---

## 9 · Tests permanentes nuevos (los tres obligatorios, más cobertura)

| Test | Resultado |
|---|---|
| (a) 17 partidas reales → 2.205 €, nunca COMPLETE con 2.080 | ✅ `COMPLETE items=17 suma=2205` |
| (b) edad + plazo → NO genera `notaAmbigua` | ✅ |
| (c) derivadas: sobrante 300 + ocio 150 → **325**, nunca 375 | ✅ `sobrante=250 recorte=75 nueva_capacidad=325` |
| 11 de 17 + PARTIAL + preguntar por las 6 → **PASA G1d** | ✅ `violaG1d=false` |
| Los mismos huérfanos con COMPLETE → **VIOLA G1d** | ✅ `motivo=huerfano_con_complete` |
| 4 respuestas cortas ancladas → sin huérfanos | ✅ |
| Sin pregunta pendiente, la misma cifra pelada SÍ es huérfana | ✅ |
| Mensaje largo narrativo nunca es "respuesta corta" | ✅ |
| 6 mensajes no-monetarios (porcentajes, conteos, unidades, años) | ✅ |
| No sobredisparar: moneda adyacente · rangos · `"mis gastos son 2200"` | ✅ |

---

## 10 · Regresión obligatoria

| Verificación | Resultado |
|---|---|
| Los 7 fraseos de la reconciliación aritmética | ✅ |
| Los 4 casos de M10 sensor | ✅ `commandments.test.ts` 36/36 |
| G1c en ambos sentidos | ✅ |
| Las 15 partidas de testdev7 | ✅ |
| `'gasto 2 500 €'` → 2500 | ✅ |
| Memoria entre sesiones | ✅ sin cambios en CAMPOS_HECHOS / split / merge |
| AG01: `renta 1000, comida 200, luz 100` con 2 de 3 → PARTIAL citando 100 | ✅ |
| `'gano 27600 al año'` con `ingreso_mensual` 2300 → COMPLETE | ✅ |

---

## 11 · Declaración de impacto — alcance

**Confirmación explícita: NO se tocó el prompt del Consigliere.** `src/lib/prompts/consigliere.ts`
no aparece en el diff. La jerga interna y la anti-repetición de estructura quedan para la tanda 3,
post-veredicto, como se acordó. Tampoco se tocó guardrail, orquestador ni persistencia.

| Archivo | Cambio | Dentro del alcance |
|---|---|---|
| `src/lib/calculator/scenario.ts` | clasificación semántica (FIX 3/4) + `medirFidelidadExtraccion` (FIX 1) | (a) verificación de conservación ✅ |
| `src/app/api/chat/route.ts` | `seed` al detector (FIX 2) + fórmula canónica + log de violación | (a) punto del route que expone el mensaje original ✅ |
| `src/lib/calculator/scenario.test.ts` | tests nuevos + 2 asertos bajo V11 (acuerdo 27) | ✅ |
| `src/app/api/chat/route.static.test.ts` | tests nuevos + 1 aserto bajo V11 (acuerdo 27) | ✅ |

`ScenarioState` sin cambios de forma. `persistTurn` sigue siendo el punto único (`persistence.ts`
no se tocó). `llm.ts` (AG01) e `ica-service.ts` (AG06) intactos. La migración 024 no se ejecuta —
la corre Luis antes del merge; su comentario sobre V14 se deja como está, por ser correcto.

---

## 12 · Validación

| Comando | Resultado |
|---|---|
| `npx tsc --noEmit` | limpio |
| `npm run build` | TypeScript compila limpio; falla en el prerender de `/login` por credenciales de Supabase — entorno, no código |
| `npm test` | 0 fallos |
| `npm run test:guardrail` | 0 fallos, 8 suites (commandments 36/36 — M10 intacto) |
| `npm run test:calculator` | 0 fallos (operations 15, orchestrator 35, expenses 24, scenario **269**, tools 17) |
| `npm run test:regression` | **84/84** turnos · 47 escenarios · enforcement=full |
| `npm run test:e2e` / `npm run smoke:db` | sin credenciales — no verificable en este entorno |
