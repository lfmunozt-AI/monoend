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
