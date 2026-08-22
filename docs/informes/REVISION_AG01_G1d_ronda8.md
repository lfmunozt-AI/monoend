# APROBADO CON RESERVAS — revisión adversarial AG01 · ronda 8 (`agent/08` @ `92e91b8`)

**Revisor:** AG01 (Arquitecto) · **Implementador:** AG08 · **Fecha:** 2026-08-22
**Base:** `origin/develop` (`19ebf6c`) · **Rama juzgada:** `origin/agent/08` (`92e91b8`), sin mergear
**Reporte Fase 4:** `docs/informes/CORRECCIONES_AG08_G1d_fidelidad_extraccion.md`
**Contrato:** `docs/CONTRATO_TRUTH_ENGINE.md` (§5.1, §9 con E11-E14, §15)

---

## 1 · Veredicto

**APROBADO CON RESERVAS — mergear.** Pero **lo más urgente de este informe no está en el diff**:
está en lo que ha desaparecido del repositorio.

### El hallazgo que hay que atender antes que nada

> **La tanda 7 completa (`475bf8e`) no está ni en `develop` ni en `agent/08`.** El fix del
> **bloqueante G1b** que aprobé el 20 de agosto — el que impedía publicar la capacidad mezclada
> de "375 €" — **no está en ninguna rama viva**. `develop` y `agent/08` siguen ambas con
> `content: call1.content` en `messages2`.

AG08 lo declara con honestidad en §0 de su informe (reseteó a `develop` como pedía el encargo,
sin reconciliar), pero la consecuencia no está evaluada allí: **el bloqueante que Luis cree
cerrado sigue abierto en producción**. Detalle verificado en §2/P1.

### Sobre el trabajo de esta tanda

**El evento G1 está atendido y lo verifiqué con el caso real.** El mensaje de las 17 partidas
captura **las 17** y suma **2.205 €** con `COMPLETE` legítimo. Y la reproducción del incidente
—un delta con solo 11 de 17, igual que produjo el `tool_call` real— degrada a **PARTIAL** citando
exactamente los 6 importes perdidos. El diagnóstico de causa raíz de AG08 (pertenencia de valor
vs. multiset) es correcto y lo confirmé de forma independiente: con seis partidas de las que
cinco valen 50 €, `develop` certifica **COMPLETE** sin detectar ninguna pérdida y esta rama
degrada a **PARTIAL** detectando dos de tres. Es una mejora real y medible.

**La migración 024 está bien hecha:** `add column if not exists`, las tres columnas NULLABLE,
nota de retención explícita, índice parcial, sin ejecutar. Y los nombres coinciden **letra por
letra** entre `route.ts` → `telemetry.ts` → migración — que es justo el fallo que nos dejó ciegos
con la 016.

**V11 limpio por quinta ronda consecutiva:** cero líneas eliminadas en tests, 14 tests nuevos.

**Regresión: 33/33 verde**, más la batería completa (84/84, scenario 232→245).

### Las reservas

**La compuerta G1d todavía puede certificar `COMPLETE` con una partida perdida.** La tolerancia
`÷12/×12` del emparejamiento deja que el agregado "cubra" una pérdida cuyo valor sea exactamente
`agregado/12`: `"mis gastos son: renta 1000, comida 200, luz 100"` con dos capturadas de tres
devuelve **`COMPLETE`, sin detectar el 100 perdido**. Es **preexistente e idéntico en `develop`**
—esta tanda no lo introduce, y en el caso de valores repetidos lo mejora— pero una compuerta que
todavía puede certificar COMPLETE con una pérdida no está cerrada.

Y el **riesgo espejo (O.2) sigue sin medir**: 5 de mis 6 mensajes con números no monetarios
degradan a `PARTIAL` sin motivo. También preexistente e idéntico en `develop`.

---

## 2 · Hallazgos priorizados

### 🔴 P1 · BLOQUEANTE DE PROCESO — la tanda 7 se ha perdido, incluido el fix del bloqueante G1b

No es un defecto del código de esta entrega: es una pérdida de trabajo aprobado que el merge de
esta rama **no repara** y que conviene resolver antes de tocar nada más.

Verificado con `git merge-base` y `git grep` sobre las tres referencias:

| Pieza de la tanda 7 (`475bf8e`) | en `475bf8e` | en `develop` | en `agent/08` |
|---|---|---|---|
| **`content: ''` en `messages2`** *(fix del bloqueante G1b)* | ✅ | ❌ | ❌ |
| `esEstructuraRepetida` *(anti-repetición de estructura)* | ✅ | ❌ | ❌ |
| `gastos_conflict` en `valoresExtra` *(pregunta de aclaración con contexto)* | ✅ | ❌ | ❌ |
| `meta.titulo` sin relleno *(jerga)* | ✅ | ❌ | ❌ |
| `"meta (estado: …)"` en `summarizeScenario` | ✅ | ❌ | ❌ |
| bloque `JERGA INTERNA` en `consigliere.ts` | ✅ | ❌ | ❌ |
| `"compra financiada"` *(la cadena que se eliminó)* | eliminada | **sigue viva** | **sigue viva** |

`git merge-base --is-ancestor 475bf8e origin/develop` → **NO**. Sobre `origin/agent/08` → **NO**.
La línea concreta, comprobada en las dos ramas:
`{ role: 'assistant' as const, content: call1.content, toolCalls: [toolCall] }`.

**Por qué importa.** El bloqueante que motivó la ronda 7 fue una cifra publicada en producción
(375 € donde correspondía 325 €) que no correspondía a ningún estado consistente — una violación
de G1b. Ese fix está aprobado y verificado por mí con 12 turnos, y hoy no está en ninguna rama que
vaya a producción.

**Qué hacer, en este orden:** mergear primero `475bf8e` a `develop` (PR propio), y después esta
tanda. No hay conflicto de contenido entre ambas —tocan puntos distintos de `route.ts` y
`scenario.ts`—, pero el orden importa para que ninguna de las dos se pierda otra vez. Si se
prefiere una sola integración, que AG08 rebase `92e91b8` sobre `475bf8e` y se verifique que las
dos ediciones de `route.ts` coexisten.

### 🟠 M1 · MAYOR — G1d aún certifica `COMPLETE` con una partida perdida (tolerancia `÷12`)

`src/lib/calculator/scenario.ts:1669-1686` (`huerfanosPorMultiset`), en concreto la pasada 2:

```js
(a) => Math.abs(a - v) <= 1 || Math.abs(a - v / 12) <= 1 || Math.abs(a - v * 12) <= 1
```

`valoresAsignadosEnDelta` empuja `gastos_mensuales` (el **agregado**) al lado de los asignados,
así que el agregado puede consumir un candidato que valga `agregado/12`. Medido, con controles:

| Caso (2 de 3 capturadas) | agregado | perdida real | detectadas | estado |
|---|---|---|---|---|
| `"renta 1000, comida 200, luz 100"` | 1200 | `[100]` | **`[]`** | ✗✗ **`COMPLETE`** |
| `"renta 900, comida 300, luz 100"` | 1200 | `[100]` | **`[]`** | ✗✗ **`COMPLETE`** |
| `"renta 1000, comida 200, luz 150"` *(control)* | 1200 | `[150]` | `[150]` | ✓ `PARTIAL` |

**Idéntico en `develop`** — no es regresión, y en el caso de valores repetidos esta tanda **mejora
mucho**: `"alquiler 500, comida 50, luz 50, agua 50, gas 50, ocio 50"` con 3 capturadas pasa de
`COMPLETE` con **0** pérdidas detectadas (develop) a `PARTIAL` con **2 de 3** (esta rama).

**Por qué lo reporto como mayor pese a no ser regresión.** Es exactamente la clase de fallo del
22 de agosto: gasto por debajo del real, certificado con plena confianza. La magnitud del ejemplo
(100 € sobre 1.200) es comparable a la del incidente (125 € sobre 2.205). Y los ratios que lo
disparan —1200/100, 600/50, 2400/200— son cifras domésticas redondas y frecuentes.

**Corrección recomendada:** la tolerancia de anualización existe para que un extractor que
anualiza un mismo campo no se marque como huérfano; **no** tiene sentido entre el **agregado** y
una **partida**. Excluir `gastos_mensuales` de las dos ramas `÷12`/`×12` (conservando la de ±1 de
redondeo), o restringir la anualización a valores cuyo campo lleve marca anual explícita. Con los
tres casos de la tabla como test.

### 🟠 M2 · MAYOR — el riesgo espejo (O.2) sigue sin medir: 5 de 6 degradan sin motivo

`scenario.ts`, `esCandidataFinanciera` / §5.1

O.2 pedía inventar 6 mensajes con números no monetarios y comprobar que **ninguno** degrada.
Verifiqué con `grep` que ninguno está en su batería:

| Mensaje | Qué es la cifra | Resultado |
|---|---|---|
| `"gano 2400, cumplo 40 este año y gasto 1900"` | edad | ✗ `PARTIAL`, sin destino `[40]` |
| `"somos 5 en casa, gano 3200 y gasto 2600"` | nº de personas | ✗ `PARTIAL`, `[5]` |
| `"me ofrecen una rentabilidad del 3 por ciento, gano 2500 y gasto 1900"` | porcentaje en palabras | ✗ `PARTIAL`, `[3, 100]` |
| `"desde 2019 vivo aquí, gano 2600 y gasto 2000"` | un año | ✗ `PARTIAL`, `[2019]` |
| `"tenemos 3 coches, gano 4200 y gasto 3300"` | cantidad de objetos | ✗ `PARTIAL`, `[3]` |
| `"tengo una hipoteca a 25 años, gano 2800 y gasto 2100"` | plazo | ✅ `COMPLETE` |

**Los seis son idénticos en `develop`** — preexistente, no regresión. §5.1 cubre el sustantivo
*posterior* al número (`43 años`, `2 hijos`), y estas formas lo llevan antes, en palabras, o no lo
llevan.

**Nota de proceso (E11).** AG08 declara en §5 que su primer mensaje inventado degradaba y que
**lo sustituyó por uno limpio**. Declararlo es exactamente lo que E11 exige y lo valoro — pero el
efecto es que el Criterio B quedó 8/8 sobre mensajes que esquivan el hueco, y el riesgo que O.2
mandaba medir quedó sin medir. La consecuencia práctica es la que O.2 anticipa: el Consigliere se
vuelve interrogador y pide aclaración sobre la edad del usuario o el número de coches.

**Corrección recomendada:** ampliar §5.1 al sustantivo *anterior* (`somos N`, `tenemos N`,
`cumplo N`), a los años de 4 dígitos sin moneda, y a `N por ciento`. Con los 5 casos de la tabla
como test.

### 🟡 m1 · MENOR — el comentario de la columna se contradice consigo mismo

`supabase/migrations/024_telemetry_fidelidad.sql`, comentario de `importes_con_destino`:

> *"cuántos de esos importes terminaron en un destino declarado (campo asignado, ítem de gasto,
> huérfano no relevante, **o huérfano relevante**) = importes_en_mensaje −
> jsonb_array_length(importes_sin_destino)"*

Un **huérfano relevante** es precisamente lo que va en `importes_sin_destino`, así que la fórmula
lo **resta**: no cuenta como destino. La enumeración y la fórmula dicen cosas opuestas en la misma
frase. No afecta a los datos —la fórmula es la que se ejecuta y es la correcta— pero es la clase
de deriva documental que hace que un digest nocturno se lea al revés.

### 🟡 m2 · MENOR — efecto secundario de la regla de tasas, declarado

`scenario.ts`, `esTasaSinSigno`. AG08 lo declara con transparencia en §3: `"quiero un carro de
30000 con TAE 9"` (sin plazo) pasa de `PARTIAL` a `COMPLETE` sin que cambie el dato mal atribuido
(`meta.monto = 30000` en vez de `credito`). Es decir, **se pierde una señal de estado que, por
casualidad, avisaba de un problema real**. Verificado que la salvaguarda funciona: con `%` o con
moneda explícita (`"intereses de 500 euros"`) el número sigue contando como candidato normal.
Lo registro porque la deuda subyacente sigue viva y ahora es menos visible.

---

## 3 · Verificación del encargo (BLOQUE O)

### O.1 — el caso real ✅

| Prueba | Resultado |
|---|---|
| Mensaje con los 17 importes (920…30) | **17 ítems capturados, suma 2.205 €**, `COMPLETE` legítimo, 0 huérfanos |
| Reproducción del incidente (delta con 11 de 17) | **`PARTIAL`**, `importes_sin_destino = [20, 20, 10, 10, 50, 30]` — las 6 perdidas |
| Variante propia: 6 partidas con 5 valores repetidos de 50 | `PARTIAL` con 2 de 3 detectadas *(develop: `COMPLETE` con 0)* |

Nunca `COMPLETE` con 2.080 € en ninguna de las tres. El criterio literal de rechazo de O.1 no se
cumple. Queda el hueco de M1 (una única pérdida = agregado/12), fuera de este caso.

### O.2 — riesgo espejo ⚠️ **1/6**

Ver M2. Preexistente e idéntico en `develop`.

### O.3 — el sensor ✅

| Verificación | Resultado |
|---|---|
| Nombres payload ↔ columna | ✅ `importesEnMensaje`→`importes_en_mensaje`, `importesConDestino`→`importes_con_destino`, `importesSinDestino`→`importes_sin_destino`, verificados letra por letra en `route.ts:959-961`, `telemetry.ts:156-158` y la migración |
| Migración idempotente | ✅ `add column if not exists` |
| Columnas NULLABLE | ✅ las tres, sin `not null` ni default |
| No ejecutada desde el agente | ✅ declarado; la corre Luis antes del merge |
| Nota de retención | ✅ explícita, con el razonamiento (valores desnudos, sin nombres ni texto libre) |
| `persistTurn` sigue siendo punto único | ✅ `persistence.ts` no se toca; reenvía por spread |
| Cálculo del sensor | `route.ts:504-506`, sobre `cleanMessage` (mensaje original) — correcto |

Salvedad documental en m1.

### O.4 — alcance ✅ con extensión declarada

Archivos con lógica: `scenario.ts` y `route.ts` (la autorización literal), más `telemetry.ts` y la
migración 024. Los dos últimos están **fuera de la letra** de la ventana pero **son
imprescindibles** para el sensor que el propio encargo exige con nombres de columna exactos: sin
`telemetry.ts` los tres campos no tienen dónde aterrizar. AG08 lo razona en §0 y no toca
`persistence.ts`. Lo doy por dentro del alcance. **Ningún otro cambio lógico en el diff.**

### O.5 — sin regresiones ✅ **33/33**

G1a/G1b (M3, M9, déficit fantasma) · G1c bidireccional `[2200, 2250]` · M10 sensor: las 4 frases
intactas (V18) · los 7 fraseos de la reconciliación aritmética · V12 · V13 (independencia de
orden 1090/1090) · V16 (L2/L3/L5) · V19 (`"quiero una casa de 150000: …"` → meta 150000 **y**
gastos 1400) · las 15 partidas de testdev7 (2250) · dedup 5 con ítems = buckets = 2200 · memoria
entre sesiones · `"gasto 2 500 €"` → 2500 · casos 9-17 · E5-24 · desglose sin confirmar ·
detector de pegado en ambos sentidos.

---

## 4 · Tabla de invariantes

| # | Invariante | Estado | Evidencia |
|---|---|---|---|
| **V1** | Un dato con confianza no se descarta | ✅ verificado | Ninguna ruta nueva descarta; V19 verificado aparte |
| **V5** | Nada inferido por el LLM entra en `conceptos` | ✅ verificado | El diff no toca el guardarraíl ni `buildScenarioContext` |
| **V8** | El cero se rechaza como placeholder | ✅ verificado | caso 17 intacto |
| **V9** | El estado sobrevive re-lectura desde BD | ✅ verificado | Memoria entre sesiones, 5 partidas |
| **V10** | `raw !== final` ⟹ ≥1 mutación | ✅ verificado | Pipeline sin cambios |
| **V11** *(E2+E11)* | No se borra, debilita ni esquiva un test | ✅ **limpio, 5ª ronda seguida** | 0 líneas eliminadas en `*.test.ts`; 14 tests nuevos. La sustitución de fixture de §5 está **declarada**, como exige E11 |
| **V12** | El ingreso nunca como ítem de gasto | ✅ verificado | testdev7 |
| **V13** | Token reclamado = frontera con offsets | ✅ verificado | Independencia de orden byte a byte; el multiset consume 1:1 el valor reclamado (`"gano 2300 y gasto 1800"` → 0 huérfanos) |
| **V14** | Conservación · `extraction_status` nunca `undefined` | ⚠️ **parcial** | El anclaje al mensaje original es correcto y mejora mucho; el hueco `÷12` (M1) deja pasar una pérdida |
| **V15/V16** | Atribución / no doble conteo | ✅ verificado | Los 7 fraseos, L2/L3/L5 |
| **V17** *(E14: la aritmética decide el agregado)* | | ✅ verificado | Los 7 fraseos sin keyword |
| **V18** *(E14: ningún mandamiento edita prosa)* | | ✅ verificado | Las 4 frases de M10 intactas |
| **V19** *(E14: nunca se pierde un dato extraíble)* | | ✅ verificado | meta 150000 **y** gastos 1400 |
| **V20/V21** *(E14, renumerados)* | | ✅ verificado | G1b y bloque consistente, sin cambios |
| **G1a/G1b** | 0 errores aritméticos · 0 cifras no trazables | ✅ verificado *en este diff* | M3/M9/déficit fantasma. **Pero ver P1**: el fix de G1b de la tanda 7 no está en ninguna rama |
| **G1c** | Reconciliación bidireccional | ✅ verificado | `[2200, 2250]` en ambos sentidos |
| **G1d** *(nueva, esta tanda)* | Fidelidad de extracción | ⚠️ **no cerrada** | O.1 pasa; M1 la deja abierta en un caso reproducible |
| — | `scenario_state` · `response_telemetry` · `runGuardrail` · `persistTurn` | ✅ verificado | `route.static.test.ts` verde (8→10) |
| — | `llm.ts` NO tocado (dominio AG01) | ✅ verificado | ausente del diff |
| — | Tabla de puntos del ICA no redefinida (dominio AG06) | ✅ verificado | ausente del diff |
| — | Sin reconciliación/CONFLICT/ASSUMED nuevos (BLOQUE C) | ✅ verificado | `reconciliarGastos` sin tocar |
| — | Eco sin plantilla (BLOQUE G) | ✅ verificado | `renderDatosRecienEntendidos` sin tocar |
| — | Migración 019/024 (BLOQUE F) | ✅ verificado | Ver O.3 |
| — | `test:e2e` · `smoke:db` | **no verificable por mí** | Requieren credenciales |

### Casos de aceptación 9-17 + extras

| # | Caso | Test | Ruta real | Pasa |
|---|---|---|---|---|
| 9 | `"Telecomunicaciones_Necesario 60 100 Pañales_Bebe_Vital"` | sí | sí | ✅ `AMBIGUOUS`, ítem sospechoso expuesto |
| 10 | `"gasto 2 500 €"` | sí | sí | ✅ 2500 |
| 11 | `"gano 2300, tengo 43 años, 2 hijos, gasto 2200"` | sí | sí | ✅ `COMPLETE` |
| 12 | `"gano 2300 y gasto 2200 y 450"` | sí | sí | ✅ `PARTIAL` |
| 13 | `"Diezmo_Vital 225, Casa_Vital 700"` | sí | sí | ✅ 2 ítems |
| 14 | `"alquiler 700 comida 450 luz 120"` | sí | sí | ✅ 3 ítems |
| 15 | `"Alquiler: 700, Comida: 450, Luz: 120"` | sí | sí | ✅ 3 ítems, 1270 |
| 16 | 15 partidas de testdev7 | sí | sí | ✅ 15 ítems, 2250 |
| 17 | Crédito con monto sin plazo | sí | sí | ✅ plazo nunca 0 |
| E5-24 | `"gasto aproximadamente 2000 entre vivienda, comida"` | sí | sí | ✅ 2000, ítems vacío |
| extra | Desglose sin confirmar: sin recorte, con sobrante | sí | sí | ✅ |
| I.1 | Fronteras como rangos `[start,end)` | sí | sí | ✅ `expenses.ts:249` |
| I.2 | Los 3 mensajes del bloqueante | sí | sí | ✅ 1200 · 1090 · idéntico |
| L 1-6 | V15/V16 | sí | sí | ✅ |

**Batería:** TypeScript limpio · `npm test` 0 fallos · `test:guardrail` 0 fallos, 8 suites ·
`test:calculator` 0 fallos (scenario 232→245) · `test:regression` **84/84**. El build falla en el
prerender por credenciales de Supabase ausentes — entorno, no código.

---

## 5 · Riesgos latentes

**R1 — el proceso de ramas es hoy el mayor riesgo del proyecto.** No es una metáfora: una tanda
aprobada, con un bloqueante de producción cerrado y verificado, ha desaparecido de todas las ramas
vivas sin que nadie lo notara hasta esta revisión. La causa es estructural: el encargo estándar
manda `git reset --hard origin/develop`, y si el PR anterior no se ha mergeado, ese reset lo
descarta. Merece una regla explícita: **antes de resetear, comprobar que el trabajo anterior está
en `develop`**, y si no, mergearlo primero o rebasar encima.

**R2 — la tolerancia de anualización no distingue campos.** M1 es un síntoma de algo más general:
`huerfanosPorMultiset` compara **valores desnudos**, sin saber de qué campo viene cada uno. Un
agregado y una partida no deberían poder emparejarse por un factor 12. Cualquier tolerancia futura
heredará el mismo problema mientras el matcher no lleve la procedencia.

**R3 — §5.1 cubre el sustantivo posterior y nada más.** M2 muestra que las formas naturales
(`somos 5`, `cumplo 40`, `3 coches`, `2019`, `3 por ciento`) quedan fuera. Cada una convierte un
turno normal en un interrogatorio. Con el sensor de G1d recién instalado, además, estas
degradaciones **van a aparecer en la telemetría como fallos de fidelidad** y pueden enterrar los
casos reales.

**R4 — el sensor mide lo que el detector cree, no lo que el usuario dijo.** `importes_sin_destino`
sale de `huerfanos.numerosHuerfanos`, el mismo detector que M1 puede engañar. Cuando el detector
falla, el sensor falla con él y la fila queda en verde. Es una limitación aceptable —no hay
segunda fuente— pero conviene tenerla presente al leer el digest: **una tasa de fidelidad del 100%
no prueba fidelidad**, prueba que el detector no encontró nada.

---

## 6 · Recomendación a Luis

**Mergear esta tanda** — es una mejora neta, sin regresiones en 33 verificaciones, con el evento
del 22 de agosto atendido y verificado contra el caso real. Pero **antes**, y con prioridad sobre
todo lo demás:

### Primero — recuperar la tanda 7 (P1)

1. **Mergear `475bf8e` a `develop`** en su propio PR. Contiene el fix del bloqueante G1b (la
   capacidad mezclada de 375 €), la anti-repetición de estructura, la pregunta de aclaración con
   contexto y la limpieza de jerga. Hoy no está en ninguna rama viva.
2. **Después** mergear esta tanda (`92e91b8`). Tocan puntos distintos; si prefieres una sola
   integración, que AG08 rebase sobre `475bf8e` y verifique que las dos ediciones de `route.ts`
   coexisten.
3. **Ejecutar la migración 024** antes del merge, como marca el protocolo.

### Antes de declarar cerrada la compuerta G1d

4. **M1 — excluir el agregado de la tolerancia `÷12`/`×12`** (`scenario.ts:1680`),
   conservando la de ±1 de redondeo. Con los tres casos de la tabla de M1 como test. Mientras esto
   siga así, G1d **no puede darse por cerrada**: sigue habiendo una clase reproducible de
   `COMPLETE` con partida perdida, que es exactamente lo que la compuerta existe para impedir.

### Deuda con decisión explícita

5. **M2 — ampliar §5.1** al sustantivo anterior (`somos N`, `tenemos N`, `cumplo N`), años de 4
   dígitos y `N por ciento`. Sin esto, el sensor recién instalado va a reportar fidelidad rota en
   turnos perfectamente normales y va a costar distinguir el ruido de los casos reales (R3, R4).
6. **m1** — corregir el comentario de `importes_con_destino` en la migración antes de ejecutarla.
7. **m2** — la deuda de `"TAE 9"` sin plazo sigue viva y ahora es menos visible; que quede
   registrada, no olvidada.

### Proceso

8. **R1** — añadir al Protocolo de Entrega Estándar la comprobación previa al reset: *si el
   trabajo anterior del agente no está en `develop`, no se resetea — se mergea primero o se
   rebasa encima*. Esta ronda es la prueba de que sin esa regla se pierde trabajo aprobado.

---

*Revisión ejecutada sobre `origin/agent/08` (`92e91b8`) en worktree aislado, con `origin/develop`
(`19ebf6c`) como control para separar regresión de defecto preexistente. Ningún código de AG08
fue modificado; esta entrega es solo el informe.*
