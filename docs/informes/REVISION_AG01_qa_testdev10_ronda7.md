# APROBADO CON RESERVAS — revisión adversarial AG01 · ronda 7 (`agent/08` @ `475bf8e`)

**Revisor:** AG01 (Arquitecto) · **Implementador:** AG08 · **Fecha:** 2026-08-20
**Base:** `origin/develop` (`8fe8268`) · **Rama juzgada:** `origin/agent/08` (`475bf8e`), sin mergear
**Reporte Fase 4:** `docs/informes/CORRECCIONES_AG08_snapshot_y_tono.md`
**Alcance:** revisión ACOTADA (snapshot único + tono + regresión), según encargo — no re-auditoría de arquitectura
**Contrato:** `docs/CONTRATO_TRUTH_ENGINE.md` (§4/V4, §9, §13, §15)

---

## 1 · Veredicto

**APROBADO CON RESERVAS — mergear. Ningún bloqueante de piloto.**

**El bloqueante G1b está cerrado y lo verifiqué con secuencias que AG08 no probó.** Reproduje la
secuencia real de producción y construí dos propias (corrección a la baja durante conflicto; dos
correcciones encadenadas sin resolver): **12 turnos, 24 llamadas, cero capacidades mezcladas.**
Cada `nueva_capacidad` publicada es igual a `sobrante + recorte` **de su propia llamada**, y
durante el conflicto se omite (V4). El turno que en producción publicó **375** ahora da **325**.

Los tres defectos de tono están atacados en el origen, no solo en el prompt: `meta.titulo` deja de
rellenarse con `"compra financiada"`, `summarizeScenario` y `notaRetornoMeta` dejan de emitir
`"meta activa"`, y el prompt gana un bloque de jerga prohibida. La anti-repetición estructural
caza el síntoma reportado (4 aperturas idénticas seguidas → las 3 comparaciones disparan).

**V11 limpio por cuarta ronda consecutiva:** los dos únicos asertos modificados son exactamente
los que AG08 declara, y ambos codificaban el defecto que este encargo manda corregir.

**Regresión: 34/34 verde.** Los 7 fraseos de la reconciliación aritmética, los 4 casos de M10
sensor intactos, M3/M9/G1b, G1c bidireccional, las 15 partidas de testdev7, la dedup, la memoria
entre sesiones, `"gasto 2 500 €"` → 2500 y —confirmado— **el crédito fantasma no ha vuelto**.

**Las reservas, y su clasificación para mañana:**

> **Ninguna es bloqueante de piloto.** En todo lo que medí no hay una sola cifra corrompida ni un
> estado mezclado. Lo que queda degrada el **tono**, que es justo lo que esta tanda quería
> mejorar, y por eso lo reporto con precisión en vez de dejarlo pasar.

La más importante no es un defecto de esta tanda sino el motivo por el que **O.2c solo queda
medio resuelto**: el grounding trata un **numeral escrito con letras** ("dos", "tres") como un
monto sin respaldo y **borra la frase entera que lo contiene**. Es preexistente e idéntico en
`develop`, pero explica por qué la pregunta desnuda de 27 caracteres sigue siendo posible con la
redacción más natural, y además borra en silencio frases cálidas correctas como
`"Te quedan 250 € al mes y tienes dos caminos."`

---

## 2 · Hallazgos priorizados

### 🟠 M1 · MAYOR — un numeral en letra borra la frase entera (preexistente; el mejor arreglo siguiente)

`src/lib/guardrail/validate.ts:560` (rama (d), *"monto sin respaldo en los datos del usuario"*)

Medido con el pipeline completo, `conceptos = {ingreso 2500, gastos 2250, sobrante 250}`:

| Respuesta | Resultado |
|---|---|
| `"Tienes dos opciones claras para cerrar la brecha."` | **frase borrada** |
| `"Hay tres partidas que puedes recortar sin dolor."` | **frase borrada** |
| `"Te quedan 250 € al mes y tienes dos caminos."` | **frase borrada** — se pierde también el 250 correcto |
| `"Tienes opciones claras para cerrar la brecha."` *(sin el numeral)* | ✅ intacta |

**Idéntico en `develop`** — no es regresión de esta tanda.

**Por qué importa ahora y no antes.** Es el mecanismo que deja **O.2c a medias**. El fix de
`valoresExtra` (`route.ts:539`) **funciona**: con él, `"Tus gastos eran 2200 € y el desglose suma
2250 €. ¿Cuál es el valor correcto?"` sobrevive íntegra, y sin él se reduce a la pregunta
desnuda. Pero la redacción más natural para introducir una discrepancia empieza contando:

| Redacción | Con el fix | Sin el fix |
|---|---|---|
| `"Tus gastos eran 2200 € y el desglose suma 2250 €. ¿Cuál es el valor correcto?"` | ✅ íntegra | ✗ 27 caracteres |
| `"Me dijiste que tus gastos eran 2200 € y el desglose suma 2250 €. ¿…?"` | ✅ íntegra | ✗ 27 caracteres |
| `"Tengo **dos** cifras que no cuadran: … 2200 € … 2250 €. ¿…?"` | ✗ **27 caracteres** | ✗ 27 caracteres |

Lo aislé hasta la causa: sustituir `"Tengo dos cifras"` por `"Tengo cifras"` o `"Tengo un par de
cifras"` hace que la frase sobreviva; `"Tengo tres cifras: …"` vuelve a romperla. No es el
carácter `:` ni el conflicto — es el numeral.

**Corrección recomendada:** excluir del grounding monetario los numerales escritos con letra
(`uno…diez`, `un par`, `ambos`) cuando no van acompañados de moneda ni de unidad monetaria. Es un
predicado en `findNumberMentions`/`validate.ts`, no un rediseño. Es, con diferencia, el arreglo
de mayor retorno por línea tocada de los que quedan: hoy cualquier frase que cuente opciones en
palabras —el registro que el propio prompt pide desde la tanda de calidez— desaparece.

### 🟠 M2 · MAYOR — la anti-repetición estructural solo mira el turno inmediatamente anterior

`src/lib/calculator/scenario.ts:201` (`esEstructuraRepetida`) · cableado en `route.ts:666`

`esEstructuraRepetida(llmResult.content, lastAssistantMessage)` compara **solo** contra la
respuesta inmediatamente anterior. Es el mismo patrón que AG08 ya diagnosticó y corrigió para los
mensajes del usuario en una tanda anterior (`contarRepeticionesMensajeUsuario`, cuyo comentario
dice literalmente que *"comparar cada respuesta solo contra la INMEDIATA anterior nunca detecta
ese patrón"*). Aquí se reintroduce para la estructura propia.

Medido:

| Escenario | Resultado |
|---|---|
| 4 respuestas seguidas con la misma apertura (el síntoma reportado) | ✅ las 3 comparaciones disparan → regenera |
| Patrón **A-B-A** (misma construcción salteada) | ✗ **no dispara** — R3 se compara contra R2, que sí era distinta |

**Atenuante:** como cada par consecutivo sí regenera, el caso reportado (4 seguidas) queda
cubierto; lo que sobrevive es la alternancia A-B-A-B. Menor impacto que el síntoma original, pero
es el mismo error de diseño ya corregido en otro sitio del mismo archivo.

**Corrección recomendada:** comparar contra las últimas N respuestas del asistente (N=3 basta),
igual que `contarRepeticionesMensajeUsuario` hace con los mensajes del usuario.

### 🟡 m1 · MENOR — las etiquetas `snake_case` siguen viajando al modelo

`orchestrator.ts`, `render()`. El bloque "TU REALIDAD" sigue emitiendo `- ingreso_mensual:`,
`- gastos_vitales:`, `- gastos_no_vitales:`, `- nueva_capacidad:`. Verificado: **ninguna de las
frases prohibidas** (`"meta activa"`, `"compra financiada"`, `"dominio financiero"`) aparece ya
en el bloque ni en `summarizeScenario` — ese frente está cerrado en el origen. Pero la
traducción de las etiquetas técnicas a lenguaje natural sigue siendo **solo una instrucción de
prompt** (`consigliere.ts:104`), no una garantía. Para una semana de dogfooding es aceptable; si
reaparece jerga en las transcripciones, el origen está aquí.

### 🟡 m2 · MENOR — corregir un ítem por encima del 5% vacía todo el estado de gastos (preexistente)

`scenario.ts`, rama de `gastos_item_correccion` con divergencia > `MATERIALIDAD_MAX_PCT`.
Con gastos declarados 1800 y desglose 800/500/300/200, corregir `alquiler 800→700` (5,56%) deja
`gastos_mensuales`, `gastos_detalle` y `gastos_conflict` en `undefined` — los 4 ítems sobreviven,
pero el agregado desaparece. Es §6 aplicado ("se reinicia la captura de gastos") y **es idéntico
en `develop`**. Verifiqué la recuperación: `"mis gastos son 1700"` lo restaura; `"el total
correcto es 1800"` no (no hay patrón que lo capture). Aceptable para dogfooding — Luis sabrá
reformular—, pero conviene tenerlo presente si le ocurre.

### 🟡 m3 · MENOR — un falso positivo de estructura repetida

`"Con tus 2.300 € de ingreso, la meta llega en 14 meses."` seguida de `"Con tus 2.300 € de
ingreso, el crédito se te queda corto."` se marca como estructura repetida. Objetivamente **lo
es** (7 de las 8 primeras palabras idénticas), así que pedir variación es defendible; el coste es
una llamada extra al LLM. Lo registro como coste conocido, no como defecto. Las otras tres
aperturas naturales que probé no disparan.

---

## 3 · Verificación del encargo (BLOQUE O)

### O.1 — snapshot único ✅

`route.ts:607` — `{ role: 'assistant', content: '', toolCalls: [toolCall] }`. El borrador de
LLAMADA 1 (calculado sobre `seed`, el estado **anterior** al merge) deja de viajar al historial de
LLAMADA 2; el `tool_call` —la única parte que es autoridad— sí viaja.

Verifiqué además la afirmación de AG08 de que los otros dos caminos ya eran seguros: la rama de
regeneración existe y se dispara con conflicto activo (`route.ts:619`,
`} else if (notaAmbigua || notaEco || … || notaConflicto)`), y usa `allMessages`, sin el borrador.

**Secuencia real de producción** (la que publicó 375):

| Turno | conflicto | LLAMADA 1 (seed) | LLAMADA 2 (post-merge) |
|---|---|---|---|
| T1 `gastos 2200 … ocio 100` | — | omitida | **350** ✓ (= sobrante 300 + recorte 50) |
| T2 `el ocio en realidad es 150` | **[2200, 2250]** | 350 ✓ *(coherente, estado anterior)* | **omitida** ✓ (V4) |
| T3 `son 2250, el desglose es el correcto` | [2200, 2250] | omitida | omitida |
| T4 `¿qué pasa si recorto el ocio a la mitad?` | — | omitida | **325** ✓ (= sobrante 250 + recorte 75) |

**Mis dos secuencias propias** — corrección a la baja durante conflicto (A1-A4) y dos
correcciones encadenadas sin resolver (B1-B4) — dan el mismo resultado: **8 turnos más, ninguna
capacidad mezclada**. Total: **12 turnos, 24 llamadas, 0 incoherencias**.

### O.2 — tono

| Punto | Estado |
|---|---|
| **Jerga fuera de la salida** | ✅ en el origen. Sin objeto reconocible, `meta.titulo` queda `undefined` (`scenario.ts:2698`) — nunca `"compra financiada"`. `summarizeScenario` emite `"meta (estado: en curso, única)"` (`:3132`). `notaRetornoMeta` dice `"tu meta"` (`:2898`). Bloque nuevo JERGA INTERNA en `consigliere.ts:104`. Comprobado: ninguna frase prohibida en el bloque de datos. Residual: etiquetas `snake_case` (m1) |
| **Anti-repetición de estructura propia** | ⚠️ parcial. El síntoma reportado (4 seguidas) queda cubierto; A-B-A no (M2) |
| **Pregunta de aclaración con contexto** | ⚠️ parcial. `valoresExtra` (`route.ts:539`) **funciona** y salva 2 de 3 redacciones; la tercera cae por M1 |

### O.3 — regresión ✅ **34/34**

Los 7 fraseos de la reconciliación aritmética · los 4 casos de M10 sensor **intactos** (V18, M10
ni dispara) · M3 · M9 · G1b · G1c bidireccional `[2200, 2250]` · las 15 partidas de testdev7
(15 ítems, 2250) · dedup 5 con ítems = buckets = 2200 · memoria entre sesiones (5 partidas
recuperadas) · `"gasto 2 500 €"` → 2500 · **crédito fantasma no vuelve** (3/3 sin `credito`) ·
casos 9-17 · E5-24 · independencia de orden 1090/1090.

---

## 4 · Tabla de invariantes

| # | Invariante | Estado | Evidencia |
|---|---|---|---|
| **V1** | Un dato con confianza no se descarta | ✅ verificado | Ninguna ruta nueva descarta; el caso de m2 es §6 y preexistente |
| **V4** | Nunca se calcula una derivada que consume un campo en `CONFLICT` | ✅ **verificado a fondo** | 12 turnos: `nueva_capacidad` omitida en todas las llamadas post-merge con conflicto activo |
| **V5** | Nada inferido por el LLM entra en `conceptos` | ✅ verificado | `conceptos` sale de `buildScenarioContext`; el diff no lo toca |
| **V8** | El cero se rechaza como placeholder | ✅ verificado | caso 17 intacto |
| **V9** | El estado sobrevive re-lectura desde BD | ✅ verificado | Memoria entre sesiones, 5 partidas |
| **V10** | `raw !== final` ⟹ ≥1 mutación | ✅ verificado | Todas las mutaciones observadas quedan registradas (así aislé M1) |
| **V11** | Prohibido reescribir un test para que afirme lo contrario | ✅ **limpio, 4ª ronda seguida** | 2 asertos cambiados, ambos declarados en §3 del informe, ambos codificaban el defecto corregido |
| **V12** | El ingreso nunca como ítem de gasto | ✅ verificado | testdev7 |
| **V13** | Token reclamado = frontera con offsets | ✅ verificado | `expenses.ts:249` `interface Rango`; independencia de orden byte a byte |
| **V14** | Conservación · `extraction_status` nunca `undefined` | ✅ verificado | ~40 mensajes |
| **V15/V16** | Atribución / no doble conteo | ✅ verificado | Los 7 fraseos + casos 9-17 |
| **V18** *(M10 sensor)* | Ningún mandamiento edita prosa | ✅ verificado | Las 4 frases intactas; M10 ni dispara |
| **V19** *(agregado ambiguo no descarta el resto)* | | ✅ verificado | Sin cambios en esa ruta |
| **G1b** · 0 respuestas con cifras no trazables | | ✅ **restaurado** | El caso 375 da 325; ninguna cifra mezclada en 24 llamadas |
| **G1c** · reconciliación bidireccional | | ✅ verificado | `[2200, 2250]` en ambos sentidos |
| — | §13 · intervención sobre prosa → 0 | ⚠️ **empeora por M1** | El grounding sigue borrando frases correctas por un numeral en letra (preexistente) |
| — | `scenario_state` · `response_telemetry` · `runGuardrail` · `persistTurn` | ✅ verificado | `route.static.test.ts` verde (5→11 tests) |
| — | `llm.ts` NO tocado (dominio AG01) | ✅ verificado | ausente del diff |
| — | Tabla de puntos del ICA no redefinida (dominio AG06) | ✅ verificado | ausente del diff |
| — | Sin reconciliación/CONFLICT/ASSUMED nuevos (BLOQUE C) | ✅ verificado | `reconciliarGastos` sin tocar |
| — | Eco sin plantilla (BLOQUE G) | ✅ verificado | `renderDatosRecienEntendidos` sin tocar |
| — | Migración (BLOQUE F) | **no aplica** | El diff no toca `supabase/` |
| — | `test:e2e` · `smoke:db` | **no verificable por mí** | Requieren credenciales |

### Casos de aceptación 9-17 + extras

| # | Caso | Test | Ruta real | Pasa |
|---|---|---|---|---|
| 9 | `"Telecomunicaciones_Necesario 60 100 Pañales_Bebe_Vital"` | sí | sí | ✅ `AMBIGUOUS`, ítem sospechoso expuesto |
| 10 | `"gasto 2 500 €"` | sí | sí | ✅ 2500 |
| 11 | `"gano 2300, tengo 43 años, 2 hijos, gasto 2200"` | sí | sí | ✅ `COMPLETE` |
| 12 | `"gano 2300 y gasto 2200 y 450"` | sí | sí | ✅ `PARTIAL` |
| 13 | `"Diezmo_Vital 225, Casa_Vital 700"` | sí | sí | ✅ 2 ítems con `_` |
| 14 | `"alquiler 700 comida 450 luz 120"` | sí | sí | ✅ 3 ítems |
| 15 | `"Alquiler: 700, Comida: 450, Luz: 120"` | sí | sí | ✅ 3 ítems, 1270 |
| 16 | 15 partidas de testdev7 | sí | sí | ✅ 15 ítems, 2250 |
| 17 | Crédito con monto sin plazo | sí | sí | ✅ plazo nunca 0 |
| E5-24 | `"gasto aproximadamente 2000 entre vivienda, comida"` | sí | sí | ✅ 2000, ítems vacío |
| extra | Desglose sin confirmar: sin recorte, con sobrante | sí | sí | ✅ |
| I.1 | Fronteras como rangos `[start,end)` | sí | sí | ✅ `expenses.ts:249` |
| I.2 | Los 3 mensajes del bloqueante | sí | sí | ✅ 1200 · 1090 · idéntico |
| L 1-6 | V15/V16 | sí | sí | ✅ los 6 |

**Batería:** TypeScript limpio · `npm test` 0 fallos (route.static 5→11) · `test:guardrail` 0
fallos, 8 suites · `test:calculator` 0 fallos (orchestrator 33→35, scenario 232→235) ·
`test:regression` **84/84**. El build falla en el prerender de `/register` por credenciales de
Supabase ausentes — entorno, no código.

---

## 5 · Riesgos latentes

**R1 — el grounding es hoy el mayor enemigo del tono.** Tres tandas seguidas han encontrado
defectos de naturalidad cuya causa está en la capa de validación numérica, no en el prompt: M10
borrando prosa (ronda 3), la pregunta desnuda (esta), y ahora los numerales en letra. La capa
está calibrada para "ninguna cifra sin respaldo" y trata cualquier token numérico como cifra
financiera. Merece una distinción explícita entre **cifra monetaria** (con moneda, unidad o
concepto adyacente) y **numeral de prosa**.

**R2 — dos mecanismos de anti-repetición con criterios distintos.** `esRespuestaRepetida`
(Levenshtein, 90%, contra la inmediata anterior), `contarRepeticionesMensajeUsuario` (90%, contra
las N anteriores) y ahora `esEstructuraRepetida` (posicional por palabra, 70%, contra la
inmediata anterior). Tres umbrales y dos ventanas distintas en el mismo turno. Conviene
unificarlos antes de que un cuarto los contradiga.

**R3 — el snapshot es correcto por construcción, pero no hay guarda que lo imponga.** El fix
depende de que nadie vuelva a añadir prosa pre-merge a `messages2`. El test estático lo protege,
que es lo razonable aquí, pero conviene recordar que la garantía es un `grep`, no un invariante
ejecutable.

**R4 — invariantes del contrato, séptima ronda sin incorporar.** V17, V18 (el mío), el "V18" de
AG08 y V19 siguen fuera de §9, con la colisión de numeración sin resolver.

---

## 6 · Recomendación a Luis

**Mergear y arrancar el piloto mañana.** No hay bloqueante de piloto.

Los dos defectos del encargo están atendidos, el G1b está cerrado con verificación independiente
(12 turnos, incluidas dos secuencias que AG08 no probó), y la regresión está limpia en 34
verificaciones. Para una semana de dogfooding con tus propios datos, el riesgo de **cifra
incorrecta es el más bajo de toda la serie**: no encontré ni una.

### Deuda aceptable para la semana de dogfooding

Lo que queda degrada el tono, no las cifras. Concretamente, espera ver:

1. **Frases que desaparecen cuando cuentan en palabras** (M1). Si en la transcripción aparece una
   respuesta que empieza a media frase, o una pregunta de aclaración suelta, es esto. Anótalo con
   el texto crudo si puedes: es el arreglo de mayor retorno para la tanda siguiente.
2. **Alguna repetición de apertura salteada** (M2) — A, otra cosa, A de nuevo.
3. **Alguna etiqueta técnica** (`nueva_capacidad`, `gastos_no_vitales`) si el modelo copia el
   bloque literal (m1).
4. Si corriges un ítem y el sistema "olvida" tus gastos, reformula con `"mis gastos son X"`
   (m2) — está documentado, no es un cuelgue.

### Primera tanda después del piloto, por orden de retorno

1. **M1** — excluir los numerales escritos con letra del grounding monetario. Cierra de paso la
   mitad que falta de O.2c.
2. **M2** — comparar la estructura contra las últimas 3 respuestas, no solo la anterior.
3. **R2** — unificar los tres mecanismos de anti-repetición.
4. **R1** — separar "cifra monetaria" de "numeral de prosa" en la capa de validación; es la causa
   común de los tres últimos defectos de tono.

### Contrato

Incorporar de una vez **V17**, **V18** y **V19** a §9, resolviendo antes la colisión de
numeración (el invariante de AG08 "ningún mandamiento edita prosa" necesita número propio). Es la
séptima tanda que lo arrastra y ya son cuatro invariantes vivos que el contrato no recoge.

---

*Revisión ejecutada sobre `origin/agent/08` (`475bf8e`) en worktree aislado, con `origin/develop`
(`8fe8268`) como control para separar regresión de defecto preexistente. Ningún código de AG08
fue modificado; esta entrega es solo el informe.*
