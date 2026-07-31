# PIPELINE_CONTRACT.md — Contrato del pipeline de postprocesado del Consigliere

> Autor: AG01 (Arquitecto) · 2026-07-22
> Alcance: todo lo que ocurre en `src/app/api/chat/route.ts` **después** de que el
> LLM devuelve `llmResult.content` y **antes** de persistir/devolver `finalContent`.
> Este documento es normativo: define el **orden fijo**, la **responsabilidad única**
> de cada capa y las **invariantes de salida** verificables. Diseño, no código.

---

## 0. Por qué existe este contrato

El postprocesado creció por parches sucesivos (Piezas 1–5). Cada parche resolvió su
caso de QA puertas adentro, pero **ninguna capa conoce lo que hacen las demás**. El
resultado son tres defectos publicados en QA real que ninguna capa aislada puede
prevenir, porque nacen de la **interacción** entre capas:

1. **Déficit fantasma** — "déficit mensual de 9500 €" con sobrante real de +500.
2. **Contradicción de simulación** — "(sin considerar la TAE)" junto a la cláusula
   canónica "(simulación con TAE de referencia…)".
3. **Doble cierre de TAE** — se pide la TAE dos veces (la del modelo + la canónica),
   pese al "resolutor único" `resolveClosing`.

La causa raíz común: **la garantía de calidad está repartida en 3–5 sitios que
insertan/eliminan texto en el tramo final, sin una autoridad única ni una
post-condición verificable**. Este contrato centraliza esa garantía.

---

## 1. Orden fijo de capas (el diagrama REAL, no el teórico)

Traza exacta desde `route.ts` (verificada línea a línea, no la documentación de cada módulo):

```
LLM (call1 / call2)  ──►  llmResult.content
        │
        ▼
┌───────────────────────────────────────────────────────────────────────┐
│ RAMA POR CARRIL (classifyTurn → 'META' | 'FINANCIERO' | 'MIXTO')        │
└───────────────────────────────────────────────────────────────────────┘
        │
        ├─ META ──────────────────────────────────────────────┐
        │    finalContent = llmResult.content                  │
        │    detectInjection (solo log, no muta)               │
        │                                                      │
        └─ FINANCIERO / MIXTO ────────────────────────────────┤
             (1) runGuardrail(...)            [route.ts:320]    │
                  └─ detectInjection          (index.ts:82)     │
                  └─ extractInputFacts        (index.ts:98)     │
                  └─ parseModelOutput         (index.ts:102)    │
                  └─ validateGrounding        (index.ts:107) ◄── PIEZA 2
                  └─ applyPolicy              (index.ts:111) ◄── ⚠ INSERTA cierre
                       └─ removeBlockedSentences (elimina/corrige)
                       └─ appendClosing          (policy.ts:802/782) ⚠
                  → finalContent = guardrail.texto_final
             (2) enforceSimulationHonesty     [route.ts:338] ◄── ⚠ INSERTA cláusula
                  (solo si scenario.credito.tae_es_referencia)
        ├──────────────────────────────────────────────────────┘
        ▼
   (3) validateConsigliereOutput             [route.ts:364]  ── branding: REESCRIBE
        finalContent = validation.text
   (4) enforceOutputPolicy                    [route.ts:367] ◄── ⚠ INSERTA cierre
        (solo si severity === 'block')          (output-validator.ts:366)
        └─ elimina oraciones infractoras + appendClosing estándar
   (5) disclaimer de producto                 [route.ts:385] ── APPEND condicional
        (si product sobrevivió y falta disclaimer)
   (6) ensureSubstance                        [route.ts:400] ◄── ⚠ REEMPLAZA todo
        (SOLO carril FINANCIERO)                (policy.ts:669)
        └─ si no hay sustancia → safeAsk (una pregunta)
   (7) resolveClosing                         [route.ts:416] ◄── "resolutor único"
        (TODOS los carriles)                    (policy.ts:503)
        └─ META    → intacto
        └─ MIXTO   → stripDelegativeClosing (solo elimina)
        └─ FINANCIERO + missing → enforceMissingClosing(strip(...))  ⚠ INSERTA cierre
        └─ FINANCIERO sin missing → rewriteDelegativeClosing         ⚠ INSERTA cierre
        ▼
   finalContent  ──►  persistir + devolver
```

**Las capas marcadas `⚠ INSERTA` son cinco** (`applyPolicy`, `enforceSimulationHonesty`,
`enforceOutputPolicy`, `ensureSubstance`, `resolveClosing`). Cuatro de ellas pueden
**añadir una pregunta al final**. Solo la última (`resolveClosing`) se diseñó para ser
"única", pero corre **después** de que otras dos (`applyPolicy`, `enforceOutputPolicy`)
ya insertaron su propio cierre, y **no las revierte** salvo que `enforceMissingClosing`
las reconozca por casualidad como bloque de cierre con la keyword correcta.

**Este es el defecto estructural nº 1.**

---

## 2. Responsabilidad ÚNICA por capa (quién puede insertar, quién solo elimina)

Regla del contrato: **una sola capa puede AÑADIR texto de cierre/pregunta**. El resto
solo puede **eliminar, corregir en su sitio o reescribir sin cambiar el número de
preguntas**. Estado objetivo:

| # | Capa | Responsabilidad única | Puede INSERTAR | Puede ELIMINAR | Puede CORREGIR |
|---|------|------------------------|:---:|:---:|:---:|
| 1 | `validateGrounding` | Clasificar cada cifra (grounded / bloqueada). **No muta texto.** | ✗ | ✗ | ✗ |
| 2 | `applyPolicy` (grounding) | Eliminar/corregir cifras sin respaldo. | **✗ (quitar)** | ✓ | ✓ |
| 3 | `enforceSimulationHonesty` | Coherencia de la simulación de crédito. | **✗ (quitar)** | ✓ | ✓ |
| 4 | `validateConsigliereOutput` | Branding + detección de infracciones. Reescribe términos, no añade cierres. | ✗ | ✗ | ✓ (branding) |
| 5 | `enforceOutputPolicy` | Eliminar oraciones infractoras (garantías, producto). | **✗ (quitar)** | ✓ | ✗ |
| 6 | disclaimer de producto | Adjuntar disclaimer legal si el producto sobrevive. | ✓ (disclaimer, no cierre) | ✗ | ✗ |
| 7 | `ensureSubstance` | Rescatar respuesta vacía. | ✓ (reemplazo total) | ✗ | ✗ |
| 8 | **`resolveClosing`** | **ÚNICA autoridad de cierre.** Decide la pregunta final. | ✓ (cierre) | ✓ | ✗ |
| 9 | **`assertOutputInvariants`** *(nuevo)* | Post-condición. Verifica/corrige/loguea. | ✓ (última red) | ✓ | ✗ |

**Cambios normativos frente al estado actual (para AG08):**

- **`applyPolicy` deja de añadir cierre** (`appendClosing`, policy.ts:782 y 802). Su
  trabajo es sanear cifras; el cierre lo decide la capa 8. Hoy inserta `buildClosingRequest`
  y `resolveClosing` no siempre lo revierte → doble cierre.
- **`enforceOutputPolicy` deja de añadir cierre** (`standardClosingRequest`,
  output-validator.ts:366). Elimina oraciones infractoras y nada más; si vacía la
  respuesta, deja que la capa 7/8 decidan.
- **`enforceSimulationHonesty` no debe pedir la TAE** ni referenciar "el banco te dará
  la tasa real" en términos que dupliquen el cierre de la capa 8. Su cláusula debe ser
  una **etiqueta declarativa** ("simulación con TAE de referencia"), sin pregunta ni
  promesa que colisione con `enforceMissingClosing`.
- El **cierre por `missing` y la cláusula de simulación deben coordinarse**: si
  `missing` incluye `tae` y ya hay cláusula de simulación, el cierre de TAE de la capa 8
  es el ÚNICO que pregunta por la TAE (la cláusula solo etiqueta).

---

## 3. Invariantes de salida (post-condición verificable)

`finalContent` debe satisfacer **todas** estas invariantes en el punto de retorno.
Son verificables de forma determinista sobre el texto final, sin estado del LLM:

| ID | Invariante | Verificación determinista |
|----|-----------|---------------------------|
| **(a)** | **Máx. 1 pregunta final** | En el bloque de cierre (frases finales que son pregunta/propuesta, vía `PROPOSAL_RE` + `?`), a lo sumo **una** interrogación. Dos "?" en el bloque de cierre = violación. |
| **(b)** | **0 contradicciones tasa/simulación** | El texto no puede contener a la vez un negador de intereses/TAE (`sin incluir intereses`, `sin considerar la TAE`, `sin tener en cuenta la TAE`, …) y la cláusula de simulación. Tampoco dos cláusulas de simulación. |
| **(c)** | **0 conceptos afirmados sin cálculo** | Ninguna frase puede afirmar un **concepto derivado** (`deficit`, `sobrante`, `cuota`, `recorte`, `capacidad_anual`) con una cifra si el motor **no lo calculó** (`conceptos[concepto]` ausente) o lo calculó con **signo contrario** (déficit afirmado con `sobrante > 0`). |
| **(d)** | **0 términos de proveedor** | Ninguna fuga de identidad de modelo/proveedor (`gpt`, `openai`, `mistral`, `vllm`, `language model`, …). Ya cubierto parcialmente por Pieza 5c; se ratifica como invariante. |
| **(e)** | **0 cierres delegativos** | La última frase no puede delegar el análisis en el usuario (`DELEGATIVE_RE`: "¿qué gastos podrías reducir?", "¿cómo deseas proceder?"…). |

Notas de verificación:
- (a) reutiliza `PROPOSAL_RE` / `endsWithRequestOrProposal` / el colector de bloque de
  cierre de `enforceMissingClosing` — no se inventa un splitter nuevo.
- (b) amplía `FALSE_NO_INTEREST_RE` (policy.ts:529) para cubrir los negadores de TAE, y
  cuenta ocurrencias de `SIMULATION_CLAUSE`.
- (c) es la invariante nueva más importante; ver §4.
- (d)/(e) ya tienen detectores; la invariante solo obliga a **comprobarlos en un único
  sitio final** en lugar de confiar en que cada capa lo hizo.

---

## 4. `assertOutputInvariants()` — la garantía vive en UN solo lugar

**Propuesta central del contrato.** Un ÚNICO paso final, después de `resolveClosing`,
que recibe todo el contexto verificado y **corrige o loguea** cada violación. Ninguna
capa intermedia vuelve a ser responsable de la garantía global; su trabajo es no
introducir violaciones, y esta función es la red de seguridad determinista.

Firma propuesta (diseño, para AG08):

```ts
interface OutputInvariantContext {
  carril: Carril;
  lang: Language;
  missing: string[];
  conceptos: Record<string, number>;   // lo que el motor SÍ calculó
  esSimulacion: boolean;
}

interface InvariantReport {
  texto: string;                        // corregido
  violaciones: InvariantViolation[];    // {id:'a'|'b'|'c'|'d'|'e', accion:'corregido'|'logueado'}
}

function assertOutputInvariants(
  text: string,
  ctx: OutputInvariantContext,
): InvariantReport
```

Comportamiento por invariante:

- **(a) máx 1 pregunta**: si el bloque de cierre tiene >1 pregunta, conserva la de mayor
  prioridad (la de `missing[0]` si existe; si no, la última) y elimina las demás. Loguea.
- **(b) contradicción simulación**: elimina cualquier negador de intereses/TAE; colapsa
  cláusulas de simulación duplicadas a una. Loguea.
- **(c) concepto sin cálculo**: si una frase afirma un concepto derivado con cifra y el
  motor no lo respalda (o lo respalda con signo opuesto), **elimina la frase** (o la marca
  para bloqueo). Es la corrección del déficit fantasma. Loguea con `{concepto, valor}`.
- **(d)/(e)**: si sobrevive un término de proveedor o un cierre delegativo, elimina la
  frase/cierre. Loguea (no debería ocurrir si las capas anteriores hicieron su trabajo;
  el log de esta red es la señal de que una capa aguas arriba tiene un hueco).

Contrato de la función: **pura, nunca lanza, idempotente** (aplicarla dos veces da el
mismo resultado). Devuelve siempre un texto que satisface (a)–(e) o, si no puede
garantizarlo sin vaciar la respuesta, cae a la respuesta segura del carril.

**Dónde se cablea:** `route.ts`, inmediatamente después de `resolveClosing` (línea 416),
antes de persistir. Es el último paso del pipeline para TODOS los carriles.

---

## 5. Regla de oro para futuros parches

> Antes de añadir una capa que inserte o borre texto en el tramo final, pregúntate:
> ¿esto puede violar alguna de las invariantes (a)–(e), o depender de que otra capa no
> las viole? Si sí, la lógica va dentro de `assertOutputInvariants` o de la capa 8
> (`resolveClosing`), **no** en una capa nueva. La garantía vive en un solo lugar.

Ninguna capa nueva puede añadir un segundo punto de inserción de cierre. Si un caso de
QA parece necesitarlo, es señal de que la invariante correspondiente está mal definida —
se corrige la invariante, no se añade un parche lateral.

---

## 6. Enmienda 2026-07-30 (AG08) — "bloquear lo falso sin sustituir lo bueno"

**Principio aprobado por Luis, superior a cualquier regla de las secciones 1-5:**

> Los guardarraíles **BLOQUEAN lo falso. NUNCA sustituyen lo bueno.**
> Eliminar una frase mentirosa es legítimo. Reemplazar prosa del modelo por una
> plantilla nuestra, no. Se acepta que una respuesta quede más corta o con un
> hueco antes que con una plantilla que contradice lo que ya sabemos.

**Evidencia (telemetría real, no hipótesis).** De 27 turnos auditados en
`response_telemetry`, **13 (48%)** tuvieron el texto modificado por nuestras
capas. Tres casos verificados contra el código de `develop`:

| Caso | Qué hizo el modelo | Qué publicamos nosotros |
|---|---|---|
| A (21:03:40) | confirmó el registro y propuso el siguiente paso (`missing` VACÍO, conceptos completos) | la plantilla "…¿me compartes tus ingresos y gastos mensuales?" — pidiendo lo que el motor ya tenía, con `mutations: []` |
| B (20:55:55) | resolvió una digresión y volvió a la meta | la misma plantilla |
| C (21:02:58) | "Reserva de Imprevistos … al menos **3 meses** de gastos" | "… al menos **48 meses** de gastos" (el plazo del crédito) — absurdo financiero fabricado por nuestra capa |

### 6.1 Cambios normativos

1. **`ENFORCEMENT_MODE`** (`full` | `minimal`, por defecto `full`). En `minimal`
   siguen activos el guardarraíl de entrada, el grounding de **bloqueo puro**, el
   validador de seguridad y The Commandments; se desactivan `ensureSubstance`, la
   sustitución de cierres y la sustitución de cifras. Se registra por turno en
   `response_telemetry.enforcement_mode`.
2. **`ensureSubstance` es último recurso**, no destructor: solo actúa si la
   respuesta está realmente vacía (<30 chars, sin verbo, o puro relleno
   genérico). Confirmación, propuesta, redirección de digresión, explicación sin
   cifras, pregunta del modelo o mención a un concepto del estado cuentan como
   sustancia válida. **Con `missing` vacío tiene PROHIBIDO pedir datos.**
3. **La sustitución de cifras se restringe al contexto inequívoco**: el rol
   posicional `plazo` solo aplica si la MISMA frase contiene una keyword de
   crédito. Fuera de ahí, la cifra no se toca; y si no se puede verificar, la
   frase se elimina — jamás se reescribe.
4. **El cierre solo AÑADE, nunca pisa** (deroga la regla de prioridad del
   `missing` de la sección 3.a cuando el modelo ya cerró): si la respuesta
   termina con una pregunta o propuesta del modelo, queda INTACTA aunque no
   coincida con `missing[0]`. La única sustitución que sobrevive es la del cierre
   **delegativo**.
5. **Registro completo de mutaciones**: toda operación que modifique el texto
   (incluidas `ensureSubstance`, `resolveClosing`, `enforceOutputPolicy`, las
   eliminaciones del grounding y The Commandments) anota `{capa, regla, antes,
   despues}`. Invariante de auditoría, verificada en test:
   **`raw !== final` ⇒ `mutations.length > 0`**.

### 6.2 Dónde vive ahora la cadena

`src/lib/guardrail/pipeline.ts` → `applyEnforcement(raw, input)`. El orden de la
sección 1 no cambia; lo que cambia es que deja de estar duplicado dentro de
`route.ts` y que cada paso pasa por un envoltorio que **garantiza el registro de
la mutación**. `route.ts` solo decide el modo, el carril y el contexto.

### 6.3 Regla de oro, revisada

> Antes de añadir una capa que **reescriba** texto, demuestra que lo que
> reescribe es FALSO. Si solo es "mejorable", no se toca. Y si algo se toca, se
> registra.

---

## 7. Enmienda 2026-07-30 (AG08, 2ª tanda) — "validación cifra a cifra + plan fantasma"

**Caso real de producción** (telemetría, ENFORCEMENT_MODE=full): un plan de
4 pasos con conceptos verificados `{cuota:746.55, sobrante:550, brecha:196.55,
gastos:1750, ingreso:2300, monto:30000, plazo:48, capacidad_anual:6600,
aumento_necesario:196.55, recorte_necesario:196.55, ahorro_necesario_mensual:625}`
llegó con **todas las cifras correctas** y el guardarraíl las bloqueó una a una:

- "…reducir gastos en al menos 196,55 €" — el concepto textualmente más
  cercano a 196,55 era "gastos" (1750, no coincide); la frase también nombraba
  `aumento_necesario`/`recorte_necesario` (196,55 exacto), pero el validador
  solo comparaba contra el concepto MÁS CERCANO, nunca contra los demás
  nombrados en la misma frase.
- "1. Identificar y recortar… por 100 €" — una PROPUESTA de acción (100 € a
  recortar) se validaba como si fuera una AFIRMACIÓN sobre el gasto total
  (1750), y 100 ≠ 1750 la bloqueaba.
- Al eliminar los ítems 1 y 2, sus enumeradores ("1." "2.") sobrevivieron
  huérfanos —`isListEnumerator` los excluye de la validación, así que nunca
  aparecen en `blocked`— y quedaron pegados delante del ítem 3: **"1.2.3.
  Mantener la Reserva de Imprevistos intacta."** El usuario confirmó un plan
  vacío.

### 7.1 Cambios normativos

1. **Validación cifra a cifra** (`validate.ts`): cuando el concepto MÁS
   CERCANO de una cifra no coincide, se comprueba si coincide con OTRO
   concepto nombrado en la MISMA frase, salvo que ese concepto YA esté
   correctamente reclamado por OTRA cifra de la frase (guarda que preserva la
   regresión "ingreso/gastos/sobrante = 500 los tres" — HUECO QA).
2. **Cifras de propuesta** (`validate.ts`): una frase que empieza por un verbo
   en infinitivo/imperativo o es un ítem de lista numerada se valida como
   RECOMENDACIÓN, no como afirmación — única sanidad: no puede superar el
   concepto relacionado nombrado en la misma frase.
3. **Renumerar listas** (`policy.ts::renumberLists`): colapsa enumeradores
   huérfanos pegados y renumera 1..N las rachas contiguas que sobrevivieron.
   Corre dos veces en `pipeline.ts` — antes y después de The Commandments.
4. **Mandamiento 9 — PLAN FANTASMA** (`commandments.ts`): si el texto anuncia
   un plan y pide confirmación pero, tras el enforcement, no le queda ninguna
   cifra monetaria real, se revierte al `raw` original (con M4/M5/M1
   reaplicados sobre él, defensa mínima).
5. **`resolveClosing` reconoce CUALQUIER petición de dato concreto**, no solo
   `missing[0]` ni los patrones exactos de `PROPOSAL_RE`: un marcador
   interrogativo + el nombre de un campo conocido también cuenta como cierre
   ya resuelto.
6. **Textos canónicos propios inmunes** (`esTextoCanonico`): lo que NOSOTROS
   inyectamos (cierres canónicos, respuestas seguras) no vuelve a pasar por el
   filtro de "concepto sin cálculo" (Mandamiento 3) — las capas no pueden
   pelearse entre sí.
7. **Factor multiplicador** (`isMultiplierFactor`, `context.ts`): un número
   precedido de "×" es un factor aritmético, no un monto propio — mismo trato
   que un porcentaje o una unidad de tiempo.

### 7.2 Fixture de regresión

`tests/scenarios/plan_no_vaciado.json` reproduce el caso real exacto:
ingreso 2300, gastos 1750, crédito 30000 a 48 meses con TAE 9% → conceptos
verificados idénticos a los de producción. `expectContains: ["746,55",
"196,55", "100 €"]`, `expectNotContains: ["1.2.3."]`.

---

## 8. Enmienda 2026-07-30 (AG08, 4ª tanda) — "persona cálida + auto-chequeo + factibilidad + M9 estricto"

**Evidencia de producción** (telemetría, ENFORCEMENT_MODE=full): cuatro
fallos reales. Los tres primeros (tono hostil) NO los causa ninguna capa de
enforcement — salen directo del system prompt, corregido en
`consigliere.ts`. Los otros dos sí son capas deterministas.

### 8.1 Cambios normativos

1. **Persona cálida** (`consigliere.ts`): IDENTIDAD deja de decir "frío";
   bloque TONO nuevo prohibe explícitamente "Saludo registrado", "No es
   relevante", "No." como apertura, con 4 ejemplos ANTES/DESPUÉS anclados en
   frases reales de producción.
2. **Auto-chequeo antes de responder**: bloque VERIFICACIÓN OBLIGATORIA en el
   prompt (3 preguntas: ¿cifra en DATOS VERIFICADOS?, ¿plan sin desglose?,
   ¿cabe en la realidad del usuario?) + refuerzo determinista
   (`notaSinCifrasDePlan`, scenario.ts): si el playbook activo implica
   cifras de plan (hay crédito o meta) y falta un dato, se inyecta "NO
   propongas cifras de plan en este turno: falta {dato}."
3. **Regla de factibilidad** (`validate.ts`): una propuesta de ahorrar/
   destinar/reservar que supere `conceptos.sobrante`, o de recortar que
   supere `conceptos.gastos`, se bloquea — el verbo puede estar en
   CUALQUIER posición de la frase, no solo al inicio.
4. **Mandamiento 9 endurecido** (`commandments.ts`): además del "sin ninguna
   cifra monetaria" (plan fantasma), ahora también dispara si el `raw` era
   una lista numerada de N ítems y el final tiene MENOS de N — "no basta con
   que quede alguna cifra o algún ítem". Ambos chequeos exigen `nRaw > 0`
   (el raw tiene que HABER SIDO una lista numerada): sin esa guarda, M9
   confundía una pregunta de cierre corta y correctamente saneada por el
   grounding ("¿Confirmamos el plan?", tras eliminar una hallucinación) con
   un plan vaciado, y revertía al raw — resucitando la mentira que el
   grounding acababa de bloquear con razón.
5. **Espacio garantizado entre frases** (`policy.ts::cleanup`): al eliminar
   una frase, las que sobreviven a los lados a veces quedaban pegadas
   ("justa.Confirma"). Se inserta un espacio tras `.!?` cuando sigue
   mayúscula/¿/¡ sin espacio — nunca toca separadores de miles (dígito tras
   el punto).
6. **`esTextoCanonico` se extiende** a la respuesta segura de
   `output-validator.ts` (garantías prohibidas): sin esto, esa respuesta
   ("…tu PLAN…¿Cuál es tu META?" — menciona "plan", cierra en pregunta, sin
   cifra) calzaba con la forma de un plan fantasma y el Mandamiento 9 la
   revertía, resucitando la garantía prohibida que la propia capa de
   seguridad acababa de eliminar. Duplicado literal en `policy.ts` (no
   importado) para evitar un ciclo con `output-validator.ts`, que ya importa
   de `policy.ts`.
7. **Mandamiento 3 exige una cifra en la frase** para considerar un concepto
   derivado "afirmado sin cálculo": "¿me recuerdas para la cuota?" (sin
   ningún número) ya no se elimina — nombrar el concepto de pasada no es
   citar una cifra sin respaldo.

### 8.2 El harness de regresión ahora ejecuta The Commandments

Hasta esta tanda, `scripts/regression-harness.ts` se detenía en
`resolveClosing` (paso 12) y nunca ejecutaba Mandamientos — el Mandamiento 9
no se podía probar ahí. Se añadieron los pasos 13-15
(`renumberLists → enforceCommandments → renumberLists`), en el mismo orden
que `pipeline.ts::applyEnforcement`. Conectar esto reveló tres defectos
latentes preexistentes (no introducidos por esta tanda, pero invisibles
hasta ahora porque el harness nunca los ejercitaba):

- La respuesta segura de `output-validator.ts` (garantías) activaba
  falsamente el Mandamiento 9 → corregido en §8.1.6.
- El mismo falso positivo se repetía cuando el grounding saneaba
  correctamente una hallucinación y dejaba una pregunta de cierre corta →
  corregido con la guarda `nRaw > 0` en §8.1.4.
- Mandamiento 3 eliminaba una mención de "cuota" sin ninguna cifra → corregido
  en §8.1.7.
- `detectLanguage("hi")` detecta español (gap preexistente de `language.ts`,
  fuera de alcance de esta tanda) — con el Mandamiento 7 ahora ejercitado en
  el harness, un saludo de 2 caracteres en inglés se borraba entero. El
  fixture `saludo_simple_en.json` se ajustó a "hello" (detecta correctamente).

### 8.3 Fixtures de regresión nuevos

- `saludo_calido.json` — turno social ("Hola, ¿cómo estás?" / "me pareces
  grosero") → respuesta cálida intacta, sin fórmulas robóticas.
- `factibilidad_ahorro.json` — propuesta de ahorro que excede el sobrante →
  bloqueada; dentro del sobrante → aprobada.
- `plan_mutilado.json` — raw de 3 pasos (uno infeasible, uno sin respaldo,
  uno con cifra real) → 2 se bloquean legítimamente → Mandamiento 9 detecta
  el plan mutilado (1 de 3 pasos) y revierte al raw completo.

**Tradeoff explícito de M9** (ya existente desde su creación, reafirmado
aquí): revertir al `raw` puede reintroducir una propuesta imperfecta (en
`plan_mutilado.json`, el paso 1 sigue proponiendo algo infeasible). Es una
decisión de producto deliberada: un plan completo con un paso discutible es
preferible a un plan mutilado que el usuario confirma sin saber que faltan
partes.
