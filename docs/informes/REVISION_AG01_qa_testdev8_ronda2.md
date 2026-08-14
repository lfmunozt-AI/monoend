# APROBADO CON RESERVAS — revisión adversarial AG01 · ronda 2 (`agent/08` @ `a97206e`)

**Revisor:** AG01 (Arquitecto) · **Implementador:** AG08 · **Fecha:** 2026-08-14
**Base:** `origin/develop` (`d32368d`) · **Rama juzgada:** `origin/agent/08` (`a97206e`), sin mergear
**Ronda anterior:** `REVISION_AG01_qa_testdev8.md` (RECHAZADO, `agent/01@704f907`)
**Contrato:** `docs/CONTRATO_TRUTH_ENGINE.md` (§1-§6, §9 con E1-E10, §10, §14)

> **Nota sobre el nombre del archivo.** El encargo pedía entregar en
> `REVISION_AG01_tanda1_truth_engine.md`. Ese archivo es el informe de la **tanda 1** y el
> contrato lo cita como evidencia en **E2** y **E6**; sobrescribirlo destruiría la prueba que
> sostiene dos enmiendas vigentes. Esta ronda se entrega en archivo propio, igual que la
> anterior. Ambos quedan intactos.

---

## 1 · Veredicto

**APROBADO CON RESERVAS.** Los dos bloqueantes que motivaron el rechazo están **cerrados**, y
lo están de verdad: lo verifiqué con el pipeline completo (`applyEnforcement`), con `develop`
y con `8a8f048` (la cabeza rechazada) como controles, no leyendo el reporte.

- **B1 cerrado** — M10 ya no vuelve al RAW. El caso decisivo del encargo (`"Te quedan 250 € al
  mes aunque arrastras un déficit de 9500 €"` con `conceptos = {sobrante: 250}`) **no publica
  el déficit fantasma**. Ninguno de los 11 vectores que construí republica una cifra no
  trazable. El Mandamiento 3 sigue bloqueando su fixture con el pipeline completo, también
  cuando la pregunta es por el sobrante — el vector exacto que antes lo anulaba.
- **B2 cerrado** — `gastos` = 1550 y `sobrante` = 1450 en el caso T1+T2, con el bloque
  internamente consistente. Y la guarda **bloquea de verdad**: forzando la incoherencia a mano,
  la clasificación por partida se suprime del bloque en vez de publicarse con un `console.warn`.
- **M2, M3 y m1 cerrados** — sin reservas.

Las reservas son tres y ninguna es de veracidad: una pérdida de cobertura del detector de
anáfora en la frase canónica del QA (con mitigación real en `route.ts`), la declaración de
impacto que sigue sin ser artefacto del repo, y el cap de `gastos_items`.

Aparte del veredicto de merge, esta ronda deja una **condición de piloto agravada** (§5): la
M1 de E9 es más ancha de lo que el contrato registra. No es regresión de esta tanda ni de la
anterior — es idéntica en `develop` — pero no debería abrirse el piloto con ella.

Batería completa en verde: build (TypeScript limpio), 7 + 8 + 5 suites, **84/84 turnos** de
regresión.

---

## 2 · Verificación de los bloqueantes (BLOQUE O)

### O.1 — M10 no revierte al RAW ✅

`src/lib/guardrail/commandments.ts:386-430, 552-561`

El rediseño es correcto y ataca la causa, no el síntoma: `repararAnaforasSinAntecedente` opera
sobre `out` (el texto **ya validado**), frase a frase, y solo puede escribir una cifra que ya
viva en `conceptos`. `ctx.raw` deja de leerse en M10 por completo. Es exactamente V17.

Once vectores con el pipeline completo (`enforcement: "full"`):

| Vector | RAW | Final | Cifra no trazable |
|---|---|---|---|
| **DECISIVO** | `"Te quedan 250 € al mes aunque arrastras un déficit de 9500 €"` · `{sobrante: 250}` | `"Tomo nota. Seguimos con tu plan."` | **no** ✅ |
| D (9.999 alucinado, misma frase) | `"Te quedan 250 € … ahorrar 9.999 € al año sin esfuerzo."` | `"Tomo nota. Seguimos con tu plan."` | **no** ✅ |
| A · caso (a) del rediseño | `"… 9.999 € … . Eso te deja margen."` | `"250 € te deja margen."` | **no** ✅ |
| B · caso (b) del rediseño | `"Tu situación es manejable. Eso te deja margen para tu meta."` | `"Tu situación es manejable."` | **no** ✅ |
| M3 fixture | `"Tienes un déficit mensual de 9500 €. ¿Confirmamos el plan?"` | `"¿Confirmamos el plan?"` | **no** ✅ |
| M3 fixture **+ pregunta por el sobrante** *(el vector que antes anulaba M3)* | ídem | `"¿Confirmamos el plan?"` | **no** ✅ |
| control (raw limpio) | `"Te quedan 250 € al mes libres para tu meta."` | intacto | — ✅ |

Comparado con `8a8f048`, donde los vectores D y M3-fixture publicaban `9.999 €` y `9.500 €`
respectivamente. **G1b restaurado.**

Verificado además: **V10** se cumple en los cuatro casos que probé (`auditarMutaciones` true;
2, 1, 1 y 0 mutaciones), y **M10 es idempotente** — aplicarlo dos veces da el mismo texto en
los tres casos que probé, tanto en la rama de sustitución como en la de eliminación.

### O.2 — los tests ejercitan la ruta real ✅

`src/lib/guardrail/commandments.test.ts:249-333`

Los cuatro tests obligatorios usan `applyEnforcement` (pipeline completo), no
`enforceCommandments` aislado, y `raw` va como primer argumento posicional, así que no puede
omitirse. Es la corrección directa del defecto que señalé (`raw`/`userMessage` opcionales y
omitidos ⇒ M10 nunca corría ⇒ batería verde sin probar nada).

Mérito que conviene registrar: el `OBLIGATORIO 1` **declara explícitamente** que M10 no
reconstruye el 250 en el caso decisivo, y en su lugar asserta que `cifraPedidaAusente` sí lo
señala. Es lo contrario de esconder el límite; el test documenta dónde termina la capa
determinista y empieza el reintento de `route.ts`.

Barrí el resto de la suite en busca del mismo patrón (invocar omitiendo argumentos opcionales
para que la ruta no se ejecute). El único test que ahora omite `userMessage` lo hace
**a propósito y lo asserta** (`"sin userMessage no hay nada que comprobar — nunca se activa"`).
No encontré otro caso.

### O.3 — deduplicación y guarda bloqueante ✅

`src/lib/calculator/scenario.ts:2141-2190` · `src/lib/calculator/orchestrator.ts:566-585`

```
T1 "gano 3000, arriendo 900, comida 500"   → gastos 1400
T2 "luz 100, internet 50"                  → gastos 1550 ✅   (antes: 150)
   items activos: arriendo 900, comida 500, luz 100, internet 50 = 1550
   sobrante en conceptos: 1450 ✅            (antes: 2850)

TU REALIDAD:
  - gastos_mensuales: 1550 €
  - sobrante_mensual: 1450 € (ingreso 3000 − gastos 1550)
  - gastos_vitales: 1550 € (arriendo 900, comida 500, luz 100, internet 50)   ← ya coherente
```

La rederivación está bien acotada: solo actúa con `gastos_es_detalle && !gastos_conflict &&
!gastos_assumed`, y corre **después** de `reconciliarGastos` (línea 2110 vs 2178), así que no
puede pisar una decisión de conflicto. Lo comprobé: testdev7 y G1c en ambos sentidos siguen
produciendo el conflicto 2200/2250 diff 50 sin alteración.

**La guarda bloquea de verdad.** Forzando `gastos_mensuales = 150` con cuatro ítems que suman
1550, el bloque emitido **no contiene** la línea `gastos_vitales`: solo el agregado. Es lo que
pedí — "loguear no es mitigar".

Mensaje real de testdev8: 5 ítems, ninguno `"fueron"`, `arriendo = 900`, suma de ítems = suma
de buckets = `gastos_mensuales` = 2200. ✅

**Precedencia `tool > regex`** ✅ en ambos sentidos: un ítem por regex no sustituye a uno
activo que llegó por `tool` (queda `ocio 150 tool`), y un `tool` posterior sí sustituye al
`regex` (queda `ocio 150 tool`). *(Mi primer intento de probarlo fue inválido: un
`gastos_detalle` de un solo elemento no produce delta en `toolArgsToScenarioDelta` — ver m3.)*

### O.4 — los tres mayores

| Mayor | Estado |
|---|---|
| `analizarExtraccion` respeta el rango reclamado | ✅ **cerrado.** `"mis gastos fueron 2 200: arriendo 900, …"` → `COMPLETE`, `itemSospechoso = null`, **sin pregunta de aclaración**. Igual `"gasto unos 2 000 al mes: …"` → `COMPLETE` (antes `AMBIGUOUS` con ítem fantasma `{name:"?", amount:2000}`). Y el caso 9 real (`60 100`) **sigue** dando `AMBIGUOUS` con el ítem sospechoso expuesto: el fix no anestesió el detector |
| `queda\|quedan` fuera del grounding de salida | ✅ **cerrado.** `"Te queda un saldo pendiente de 30000 € y te quedan 250 € al mes."` sobrevive **intacta**; también `"…Quedan 48 meses de crédito…"` y `"…quedan 18 meses para llegar a la meta."`. La tabla nueva `PREGUNTA_KEYWORDS_EXTRA` (`context.ts:253-256`) está anclada a 1ª/2ª persona + periodicidad y **solo** la consume `conceptosPedidosEnPregunta` sobre `userMessage`. Separación limpia |
| Declaración de impacto | ⚠️ **parcial** — ver m1 |

---

## 3 · Hallazgos priorizados

### 🟠 M1 · MAYOR — M10 no detecta la frase canónica del QA testdev8

`src/lib/guardrail/commandments.ts:386`

```js
const ANAFORA_SIN_ANTECEDENTE_RE =
  /\b(esa|ese|esta|este|esto|eso)\s+(cifra|cantidad|monto|numero|valor)\b|\beso\b/i;
```

El demostrativo solo cuenta si va seguido de un sustantivo de una lista cerrada
(`cifra|cantidad|monto|numero|valor`), o si es el `eso` desnudo. Un demostrativo seguido del
verbo — la construcción más natural en español — no matchea. Cobertura medida con el pipeline
completo, `conceptos = {sobrante: 250}`, pregunta `"¿cuánto me queda al mes?"`:

| Frase | M10 | Resultado |
|---|---|---|
| **`"Esa es tu capacidad real para destinar a ahorro o pago de deudas."`** | ✗ | **publicada tal cual** |
| `"Ese es el margen con el que cuentas cada mes."` | ✗ | publicada tal cual |
| `"Esta es tu capacidad real de ahorro."` | ✗ | publicada tal cual |
| `"Es lo que te queda para maniobrar."` | ✗ | publicada tal cual |
| `"Ahí tienes tu margen mensual."` | ✗ | publicada tal cual |
| `"Con ese monto puedes cubrir tu meta."` | ✓ | `"Con 250 € puedes cubrir tu meta."` |
| `"Esa cifra es la que necesitas."` | ✓ | `"250 € es la que necesitas."` |
| `"Eso te deja margen."` | ✓ | `"250 € te deja margen."` |

La primera fila **es la frase literal del QA testdev8** — la que el propio comentario de
`commandments.ts:356-360` cita como origen del Mandamiento 10. El mandamiento creado para
cazarla no la caza.

**Cómo se perdió la cobertura.** La versión anterior disparaba con
`cifraPedidaFueEliminada(...) || tieneAnaforaSinAntecedente(...)`; la primera condición cubría
esa frase aunque la regex no la reconociera. El rediseño estrechó el disparador a solo la
anáfora. El remedio nuevo es correcto (ese era el bloqueante); la **detección** es la que
retrocedió.

**Nota de proceso (BLOQUE I.4 / V11).** El test que fijaba esa frase — `"Mandamiento 10: cifra
pedida … eliminada por una capa anterior → revierte al RAW"`, cuyo fixture era exactamente
`"Esa es tu capacidad real para destinar a ahorro o pago de deudas."` — fue **eliminado** y
sustituido por fixtures que sí pasan (`"Eso te deja margen."`, `"Con ese monto…"`). Borrarlo
era legítimo: afirmaba el revertido al RAW, que es justo lo que exigí quitar. Lo que faltó es
reportar que el **requisito** que ese test codificaba (esa frase acaba conteniendo el 250) deja
de cumplirse en la capa determinista. V11: "un test que estorba está describiendo un
requisito".

**Atenuante real, no teórico.** Medí `cifraPedidaAusente` sobre el texto ya pasado por M10: da
`ausente = true` en las cinco frases no detectadas. `route.ts:814` dispara entonces el reintento
acotado y el usuario acaba recibiendo la cifra. El coste es una llamada extra al LLM en la
forma de respuesta más común, y que la red determinista — la que funciona sin LLM — no cubre su
caso fundacional. Por eso es mayor, no bloqueante.

**Corrección recomendada:** ampliar la regex al demostrativo seguido de cópula
(`\b(esa|ese|esta|este)\s+(?:es|son|ser[íi]a[n]?)\b`) y reponer un test con la frase canónica.

### 🟡 m1 · MENOR — la declaración de impacto sigue sin ser artefacto del repo

`git diff origin/develop...origin/agent/08 -- docs/` sigue vacío. El commit dice "MAYOR 5 —
declaración de impacto en el reporte de Fase 4 de este turno", pero ese reporte no existe como
archivo: el único soporte es el mensaje de commit.

Dicho eso, **el mensaje de commit sí cumple la sustancia** de §15 paso 3 esta vez: enumera cada
pieza tocada con su justificación, y lo contrasté contra el diff real. Coincide en todo salvo
un cambio trivial no declarado —`TOLERANCIA_REDONDEO_EUR` pasa de `const` a `export const`
(`scenario.ts:1803`) para que `orchestrator.ts` reutilice la tolerancia de §6 en vez de
duplicar un literal. Es un acierto, no una omisión de fondo.

Baja de mayor a menor: la regla de no-reemplazo está satisfecha, falta el soporte documental.

### 🟡 m2 · MENOR — `gastos_items` sigue creciendo sin tope

`scenario.ts:2141-2160`. Sin cambios desde la ronda 1. §8 fija cap de 5 versiones por campo
porque "sin cap, una conversación larga con correcciones infla el jsonb y la latencia sube con
él", y desde E10 ese jsonb es **de usuario**, no de conversación: no se recicla nunca. Un
desglose de 15 partidas re-enunciado cinco veces deja 75 entradas.

### 🟡 m3 · MENOR — un desglose de UN solo ítem por `tool_call` se descarta en silencio

`src/lib/calculator/tools.ts:118-135`. `toolArgsToScenarioDelta({gastos_detalle: [{nombre:
"ocio", monto: 150}]})` devuelve un delta **vacío**: ni `gastos_items`, ni `gastos_mensuales`,
ni `gastos_es_detalle`. Con dos o más ítems funciona con normalidad.

Preexistente y ajeno a esta tanda; lo encontré depurando mi propia prueba de precedencia. No es
grave (el modelo rara vez emite un desglose de una sola partida) pero es una pérdida silenciosa
de un dato que el usuario sí dio, y roza V14. Merece al menos un comentario en el código que
declare la regla como intencional.

### ⚪ Observación — el caso decisivo no publica el 250 en la capa determinista

`"Te quedan 250 € al mes aunque arrastras un déficit de 9500 €"` acaba en `"Tomo nota. Seguimos
con tu plan."`: el grounding elimina la frase entera (contiene una cifra sin respaldo) y no
queda anáfora que reparar. El encargo esperaba "publica 250 € **y** no publica el déficit
fantasma". La mitad crítica —y la única declarada como criterio de RECHAZO— se cumple; la otra
la resuelve el reintento de `route.ts`, y AG08 lo **declara y lo asserta** en su propio test en
vez de disimularlo.

No lo cuento como hallazgo. Reconstruir prosa a partir del mapa de conceptos no es trabajo de
una capa determinista, y delegarlo a un reintento acotado es la decisión correcta.

---

## 4 · Tabla de invariantes

| # | Invariante | Estado | Evidencia |
|---|---|---|---|
| **V1** | Un dato con confianza no se descarta por huérfanos | ✅ verificado | Caso 12 `PARTIAL` conserva ingreso 2300 + gastos 2200. Con `itemSospechoso` los gastos no se recortan |
| **V5** | Nada inferido por el LLM entra en `conceptos` | ✅ **restaurado** | M10 solo escribe valores de `conceptos`; ningún vector publica una cifra ausente del mapa. Era el efecto de B1 |
| **V8** | El cero se rechaza como placeholder | ✅ verificado | Caso 17: `plazo_meses` undefined, nunca 0 |
| **V9** | El estado sobrevive re-lectura desde BD | ✅ verificado | `splitScenarioState` → JSON → `mergeEstadoPersistido` → las 5 partidas en el bloque |
| **V10** | `raw !== final` ⟹ ≥1 mutación | ✅ verificado | `auditarMutaciones` true en los 4 vectores; M10 registra vía `anotar` |
| **V12** | El ingreso nunca como ítem de gasto | ✅ verificado | testdev7 con ingreso 2500: ningún ítem con ese importe |
| **V13** | Token reclamado = frontera con offsets | ✅ verificado | I.2 casos 2 y 3 idénticos byte a byte |
| **V14** | Conservación · `extraction_status` nunca `undefined` | ✅ verificado | ~35 mensajes, ninguno `undefined` |
| **V15** | Atribución correcta | ⚠️ **parcial** | Los 6 mensajes del Bloque L ✅; 1 de mis 4 formas inventadas ✅ — ver §5 (preexistente) |
| **V16** | No doble conteo | ⚠️ **parcial** | L1/L2/L3 ✅ y `aplicarGuardaV16` avisa del exceso; las formas de §5 siguen doblando |
| **V17** *(propuesta ronda 1)* | Ninguna capa de reparación reintroduce una cifra eliminada por falta de respaldo | ✅ **implementado** | M10 ya no lee `ctx.raw`; solo escribe desde `conceptos` |
| **V18** *(propuesta ronda 1)* | El bloque de datos verificados es internamente consistente | ✅ **implementado** | Rederivación + guarda bloqueante en `buildScenarioContext` |
| — | `scenario_state` se puebla · `response_telemetry` escribe · `runGuardrail` cableado · `persistTurn` punto único | ✅ verificado | `route.static.test.ts` en verde; `pipeline.ts` intacto salvo `userMessage` |
| — | `llm.ts` NO tocado (dominio AG01) | ✅ verificado | ausente del diff |
| — | Tabla de puntos del ICA no redefinida (dominio AG06) | ✅ verificado | ningún archivo de ICA en el diff |
| — | Umbral 50× · `meta.monto` · V12 sin cambios | ✅ verificado | `expenses.ts` solo tocó `STOPWORD_NAME_RE` en la ronda 1 |
| — | Sin reconciliación/CONFLICT/ASSUMED **nuevos** (BLOQUE C) | ✅ verificado | La rederivación solo fija el valor de **reposo** tras `reconciliarGastos`, y se inhibe con conflicto o supuesto activo |
| — | Eco sin plantilla (BLOQUE G) | ✅ verificado | `renderDatosRecienEntendidos` sigue entregando datos + instrucción ("con tu propia voz, no copies este formato"); ningún string fijo llega al usuario |

### Casos de aceptación

| # | Caso | Test | Ruta real | Pasa |
|---|---|---|---|---|
| 9 | `"Telecomunicaciones_Necesario 60 100 Pañales_Bebe_Vital"` | sí | sí | ✅ `AMBIGUOUS`, ítem sospechoso `60100` expuesto, sin conflicto |
| 10 | `"gasto 2 500 €"` | sí | sí | ✅ 2500, `COMPLETE` |
| 11 | `"gano 2300, tengo 43 años, 2 hijos, gasto 2200"` | sí | sí | ✅ `COMPLETE`, 2300/2200 |
| 12 | `"gano 2300 y gasto 2200 y 450"` | sí | sí | ✅ `PARTIAL`, usa 2300/2200 |
| 13 | `"Diezmo_Vital 225, Casa_Vital 700"` | sí | sí | ✅ 2 ítems con `_` |
| 14 | `"alquiler 700 comida 450 luz 120"` | sí | sí | ✅ 3 ítems |
| 15 | `"Alquiler: 700, Comida: 450, Luz: 120"` | sí | sí | ✅ 3 ítems |
| 16 | 15 partidas de testdev7 | sí | sí | ✅ 15 ítems, 2250, conflicto 2200/2250 diff 50 |
| 17 | Crédito con monto sin plazo | sí | sí | ✅ plazo nunca 0, monto sobrevive |
| E5-24 | `"gasto aproximadamente 2000 entre vivienda, comida"` | sí | sí | ✅ gastos 2000, `gastos_items` vacío |
| extra | desglose sin confirmar: sin recorte, con sobrante | sí | sí | ✅ recorte bloqueado, `sobrante = 250`, `recorte_propuesto_50pct` ausente |
| I.1 | Fronteras como **rangos** `[start,end)` | sí | sí | ✅ `expenses.ts:249-252` `interface Rango` · `excluirRangos` en `parseExpenseListDetallado` (`expenses.ts:563`) — **no** es un set de strings |
| I.2 | Los tres mensajes del bloqueante | sí | sí | ✅ 1200 · 1090 · idéntico en ambos órdenes |
| L 1-6 | V16 doble conteo + V15 atribución | sí | sí | ✅ 1200 · 950 · 1800 · `casa = 700` · 1500 `CONSISTENT` · ingreso 3000 / meta 200000 sin cruzar |
| O.3 | Cuota derivada del estado, sesión nueva | sí | sí | ✅ `cuota = 881.25` sin datos nuevos · `missing = ["ingreso","gastos"]`, **sin** `cuota` |
| O.4 | Desglose entre sesiones | sí | sí | ✅ las 5 partidas con importes en el bloque |
| G1c | Reconciliación bidireccional | sí | sí | ✅ `[2200, 2250, 50]` idéntico en ambos sentidos |

### Detector de pegado (BLOQUE E)

| Escenario | Resultado |
|---|---|
| Umbral `importe > agregado` | ✅ `"gasto 1000 en total: hipoteca 1200, …"` → `AMBIGUOUS` |
| Umbral por magnitud (50× tras E1) + suelo absoluto | ✅ implementado |
| Listas de 1 o 2 ítems | no se evalúa (sin mediana fiable) — correcto |
| **Falso positivo espejo**: hipoteca 1200 entre gastos de 40-60 | ✅ **no se marca** (`COMPLETE`). La recalibración de E1 funciona |
| Falso positivo que reporté en la ronda 1 (el agregado marcándose a sí mismo) | ✅ **cerrado** por MAYOR 3 |

### Migración 019 (BLOQUE F)

**No aplica.** El diff no toca `supabase/`; `019_telemetry_extraction.sql` es de una tanda
anterior. Ningún campo nuevo requiere DDL (`superseded` vive dentro del jsonb existente).
Riesgo asociado: m2.

### Batería

| Comando | Resultado |
|---|---|
| `npm install` · `npm run build` | ✅ TypeScript limpio. El build falla después en el prerender de `/login` por `@supabase/ssr` sin credenciales — **entorno, no código** |
| `npm test` | ✅ 0 fallos |
| `npm run test:guardrail` | ✅ 0 fallos (commandments: 27 → **30**) |
| `npm run test:calculator` | ✅ 0 fallos (scenario: 180 → **185**) |
| `npm run test:regression` | ✅ **84/84 turnos · 47 escenarios · enforcement=full** |
| `test:e2e` · `smoke:db` | **no verificable por mí** — requieren credenciales |

---

## 5 · Condición de piloto agravada — y una errata mía

**La M1 de E9 es más ancha de lo que el contrato registra.** E9 documenta dos fraseos que
fallan (`"mis gastos fueron 1200: …"`, `"gastamos 950 al mes: …"`) y ambos **ya están
arreglados**. Pero inventé cuatro fraseos naturales de "agregado + palabra intermedia +
detalle" y **tres fallan**:

| Mensaje | Esperado | Obtenido | `status` |
|---|---|---|---|
| `"mis gastos rondan los 1000 al mes: luz 300, agua 300, gas 400"` | 1000 | **1700** — `luz = 1000` | `COMPLETE` |
| `"este mes he gastado 900 en total: renta 500, comida 250, bus 150"` | 900 | **1800** — ítem `"este he gastado" = 900` | `COMPLETE` |
| `"mis gastos del mes pasado fueron de 1500: hipoteca 800, comida 400, luz 300"` | 1500 | **2200** — `hipoteca = 1500` | `PARTIAL` |
| `"gasto unos 2 000 al mes: alquiler 1000, comida 600, transporte 400"` | 2000 | 2000 ✅ | `COMPLETE` |

Ejecutados en los tres árboles: **`develop` (`d32368d`), `8a8f048` y `a97206e` dan resultados
idénticos.** No es regresión de esta tanda ni de la anterior — es el estado de `develop`.

Lo que agrava el diagnóstico es el `status`: dos de los tres salen **`COMPLETE`**. El sistema
no está dudando, está seguro y equivocado. No hay huérfano, no hay señal de ambigüedad, no hay
pregunta de aclaración: el usuario recibe un gasto casi el doble del real presentado como dato
verificado. Es literalmente lo que E9 describe y declara *condición antes del piloto*.

Causa: `CONECTOR_DECLARATIVO` (`scenario.ts:547-560`) absorbe una lista cerrada de conectores.
Cualquier complemento fuera de esa lista —`"rondan los"`, `"he gastado … en total"`,
`"del mes pasado fueron de"`— impide que `GASTO_AGREGADO_DETALLE_RE` matchee, el agregado cae al
parser de listas y se pega a la primera partida. La lista negra de cópulas de la ronda 1
(`expenses.ts:186`) es defensa en profundidad, no solución.

> **Errata de mi informe anterior.** En `REVISION_AG01_qa_testdev8.md` di las dos primeras
> filas como correctas (`✅ 1000` y `✅ 900`). **Estaban mal**: las anoté sin haber visto su
> salida — quedaron en la parte truncada del volcado de la sonda. Las he re-ejecutado y
> corregido allí con una nota de errata. El error es mío, no de AG08, y va en la dirección
> peligrosa: dije que funcionaba algo que no funciona.

**Recomendación:** que la resolución de esta M1 sea explícita y con criterio medible, no otra
ronda de parcheo de conectores. Dos vías, en orden de preferencia:

1. **Invertir la regla:** si en un mensaje hay una cifra seguida de `:` y luego una lista de
   partidas, esa cifra es el agregado —da igual qué palabras la separen del verbo de gasto—
   salvo que ella misma tenga nombre de partida. Cubre las tres formas de golpe.
2. **Red de seguridad (la que E9 ya propuso):** degradar a `AMBIGUOUS` en vez de `COMPLETE`
   cuando la suma de ítems ≈ 2× una cifra presente en el mensaje. No arregla la atribución,
   pero convierte "seguro y equivocado" en "pregunta" — que es el principio rector del §0.

Con una batería de al menos 10 fraseos, no los 2 de E9.

---

## 6 · Riesgos latentes

**R1 — el desglose acumulado no admite "ahora son solo estas".** La rederivación de B2 suma
todos los ítems activos. Si el usuario re-enuncia un desglose **más corto** ("ahora mis gastos
son solo arriendo 900 y comida 500"), las partidas del turno anterior que no repita siguen
activas y el total las incluye. Es consecuencia del diseño acumulativo, no un fallo nuevo, y no
lo cubre ningún caso de la matriz. Necesita una señal de reemplazo total, o una pregunta.

**R2 — `route.ts` carga cada vez más peso de corrección.** Tres reintentos acotados conviven
ya en el mismo turno (derivada de decisión vaciada · cifra pedida ausente · regeneración sin
tool), cada uno con su llamada al LLM. Ninguno es gratis en latencia, y M1 añade tráfico al
segundo. Conviene medir en telemetría cuántos turnos disparan reintento antes del piloto: si es
alto, el problema está aguas arriba.

**R3 — sustitución de la anáfora sin concordancia.** `"Eso te deja margen."` → `"250 € te deja
margen."` es correcto en cifra y torpe en prosa. No compromete ninguna garantía, pero contradice
el objetivo de naturalidad de la tanda. Con la ampliación de M1 el caso se volverá más
frecuente: convendría que M10 elimine la frase (rama b) cuando la sustitución no produzca una
oración bien formada, en vez de forzarla.

---

## 7 · Recomendación a Luis

**Mergear con condiciones.**

AG08 arregló lo que había que arreglar, por la vía correcta y sin efectos colaterales: el
rediseño de M10 ataca la causa (nunca volver a texto sin validar) en vez de parchear el
síntoma, la rederivación de gastos está bien acotada y no toca la reconciliación, la guarda
bloquea de verdad, y los tests obligatorios ahora corren por el pipeline completo. Las dos
invariantes que propuse en la ronda 1 (V17, V18) están implementadas. No encontré ninguna
regresión: los tres árboles dan resultados idénticos en todo lo que probé salvo donde el fix
mejora.

### Condición de merge (una sola, barata)

1. **M1 — ampliar `ANAFORA_SIN_ANTECEDENTE_RE` al demostrativo + cópula** y **reponer un test
   con la frase canónica** `"Esa es tu capacidad real para destinar a ahorro o pago de deudas."`
   → el texto final contiene 250. Es un cambio de una línea de regex más un test; no justifica
   otra ronda completa. Si prefieres no bloquear el merge por esto, es aceptable **siempre que
   entre en la tanda inmediatamente siguiente**: el reintento de `route.ts` cubre al usuario
   mientras tanto.

### Condición de piloto (bloqueante de piloto, no de merge)

2. **La M1 de E9 (§5)** — tres de cuatro fraseos naturales devuelven un gasto casi doble
   marcado `COMPLETE`. No abrir el piloto con esto. Prefiero la inversión de regla sobre el
   parcheo de conectores; si no da tiempo, al menos la red de `AMBIGUOUS`.

### Deuda registrada, sin bloquear

3. **m1** — mover la declaración de impacto del mensaje de commit a un artefacto del repo
   (§15 paso 3).
4. **m2** — cap de versiones en `gastos_items`, coherente con §8, ahora que el jsonb es de
   usuario.
5. **m3** — declarar en código que un `gastos_detalle` de un solo ítem se descarta a propósito,
   o dejar de descartarlo.
6. **R1** — decidir cómo se expresa "ahora son solo estas" sobre un desglose acumulado.

### Enmiendas al contrato que esta ronda deja listas

- **V17** y **V18**, propuestas en la ronda 1 y **ya implementadas y verificadas** en esta
  (`commandments.ts`, `orchestrator.ts`). Procede incorporarlas a §9 en esta misma tanda, según
  la nota de proceso de E7+E8.
- **E9** debería recoger que la M1 es más ancha de lo documentado (§5 de este informe), con los
  tres fraseos nuevos como casos de la matriz.

---

*Revisión ejecutada sobre `origin/agent/08` (`a97206e`) en worktree aislado, con `origin/develop`
(`d32368d`) y `8a8f048` como controles para separar regresión de defecto preexistente. Ningún
código de AG08 fue modificado; esta entrega es solo el informe.*
