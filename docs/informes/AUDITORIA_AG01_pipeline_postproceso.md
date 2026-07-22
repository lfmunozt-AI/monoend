# AUDITORÍA AG01 — Pipeline de postprocesado del Consigliere

> Agente: AG01 (Arquitecto) · Modo: análisis profundo (sin corrección de código)
> Fecha: 2026-07-22 · Base: `origin/develop` @ `0c812a3`
> Alcance auditado: `src/app/api/chat/route.ts` + `src/lib/guardrail/*` +
> `src/lib/llm/output-validator.ts` + `src/lib/calculator/{orchestrator,scenario}.ts`
> Documento hermano: `docs/PIPELINE_CONTRACT.md` (contrato normativo + invariantes).

---

## Resumen ejecutivo

Los tres defectos de QA real **no son bugs de una capa**: son consecuencia de que la
garantía de calidad está repartida en **cinco capas de postprocesado que se insertan/
eliminan texto sin conocerse entre sí**. En concreto, **cuatro capas distintas pueden
añadir una pregunta de cierre** y solo una (`resolveClosing`) fue diseñada como "única",
pero corre después de dos que ya insertaron la suya y no las revierte de forma fiable.

Recomendación: introducir `assertOutputInvariants()` como **post-condición única** del
pipeline (ver contrato §4) y **retirar la inserción de cierre de las capas 2, 4 y 5**,
dejando a `resolveClosing` (capa 8) como la única autoridad de cierre.

---

## Traza REAL del pipeline (post-LLM)

Orden exacto verificado en `route.ts` (no el teórico de cada módulo):

**META:** `llmResult.content` → `detectInjection` (log) → `validateConsigliereOutput` →
`enforceOutputPolicy` → disclaimer → `resolveClosing` (intacto).

**FINANCIERO / MIXTO:**
1. `runGuardrail` (route.ts:320) → internamente: `detectInjection` → `extractInputFacts`
   → `parseModelOutput` → `validateGrounding` → **`applyPolicy`** (⚠ inserta cierre vía
   `appendClosing`, policy.ts:782/802).
2. `enforceSimulationHonesty` (route.ts:338) — ⚠ inserta cláusula de simulación.
3. `validateConsigliereOutput` (route.ts:364) — branding (reescribe).
4. **`enforceOutputPolicy`** (route.ts:367) — ⚠ inserta cierre estándar (output-validator.ts:366).
5. disclaimer de producto (route.ts:385) — append condicional.
6. `ensureSubstance` (route.ts:400, **solo FINANCIERO**) — ⚠ reemplaza todo por `safeAsk`.
7. **`resolveClosing`** (route.ts:416) — el "resolutor único" de cierre.

El diagrama completo con referencias línea a línea está en `PIPELINE_CONTRACT.md §1`.

---

## Hallazgos priorizados

### 🔴 H1 — CRÍTICO · Concepto afirmado sin cálculo pasa el grounding (déficit fantasma)

**Síntoma QA:** "déficit mensual de 9500 €" con sobrante real de +500.

**Causa raíz (rama exacta en `validate.ts`):**
- `conceptsInSentence("déficit … 9500")` **sí** reconoce `deficit` (context.ts:189).
- Pero en `validateGrounding`, línea **262**:
  ```ts
  const knownConcepts = new Set(conceptsInSentence(sentenceText).filter((c) => c in conceptos));
  ```
  El `.filter((c) => c in conceptos)` **descarta `deficit`** porque el motor, al haber
  **sobrante > 0**, NO pobló `conceptos["deficit"]` (orchestrator.ts:398–406 solo empuja
  `deficit_mensual` cuando `s.valor < 0`).
- Con `knownConcepts` vacío → `conceptoCercano = null` (línea 267 no entra) → cae a la
  rama **(a)** genérica (línea **287**): `9500` coincide con `gastos` (dato del usuario)
  → se aprueba como `"hecho"`. **La etiqueta "déficit" nunca se coteja contra lo que el
  motor sabe.**

**Confirmación:** el grounding valida el **número**, no el **concepto** aplicado al
número. El motor SABE que hay superávit (`sobrante_mensual` en realidad, orchestrator.ts:388–390),
pero esa contradicción de signo se descarta en el `.filter`.

**Dónde va la regla "concepto sin cálculo → bloquear":**
En `validate.ts`, **antes** del fallthrough a la rama (a) (línea 287), tras calcular los
conceptos crudos de la frase. Distinguir:
- **Conceptos de entrada** (`ingreso`, `gastos`): pueden citarse aunque el motor no los
  haya "calculado" (son datos crudos) → no se bloquean por esta regla.
- **Conceptos DERIVADOS** (`deficit`, `sobrante`, `cuota`, `recorte`, `capacidad_anual`):
  si la frase los afirma con una cifra y `conceptos[concepto]` está **ausente** (o presente
  con **signo/antónimo contrario** — `deficit` afirmado con `sobrante` calculado, y
  viceversa) → **bloquear la frase** ("concepto afirmado sin cálculo que lo respalde").

Es una nueva rama determinista; no requiere LLM. Alternativamente puede vivir en
`assertOutputInvariants` como invariante (c), pero **la detección natural es en
`validate.ts`** porque ahí ya se tiene la frase, la cifra y el mapa `conceptos`.

---

### 🔴 H2 — CRÍTICO · Doble cierre de TAE (simulación + missing sin coordinar)

**Síntoma QA:** se pide la TAE dos veces (una del modelo, una canónica) pese a `resolveClosing`.

**Causa raíz — DOS capas piden la TAE sin conocerse:**
- Cuando `scenario.credito.tae_es_referencia === true`, ocurren **a la vez**:
  - `computeMissing` incluye `"tae"` (scenario.ts:328) → `resolveClosing` (FINANCIERO,
    missing) llama `enforceMissingClosing`, que inserta **"¿Qué TAE te ofrece tu banco?"**
    (policy.ts:370–374).
  - `enforceSimulationHonesty` inserta la cláusula **"(simulación con TAE de referencia —
    tu banco te dará la tasa real)"** (policy.ts:538) en la frase de la cuota.
- `enforceMissingClosing` colecta el **bloque de cierre** (frases finales que son
  pregunta/propuesta, policy.ts:449–453). La cláusula de simulación es **declarativa**
  (no es pregunta) → el colector **no la ve** → concluye que falta pedir la TAE → añade
  su pregunta. Resultado: la cláusula ya referencia "el banco te dará la tasa real" **y**
  el cierre pregunta "¿Qué TAE te ofrece tu banco?" → **doble petición de TAE**.
- Camino aún más duro: si `applyPolicy` (H3) ya añadió un cierre etiquetado `interes`
  ("necesito la tasa de interés…"), `enforceMissingClosing` lo reconoce como cierre con
  keyword `tae` (regex incluye `interes`, policy.ts:360) → devuelve el texto **intacto**
  → **ambos** cierres de TAE sobreviven, los dos canónicos.

**Confirmación:** `resolveClosing` es "único" solo dentro de su propia ejecución; no
coordina con `enforceSimulationHonesty` (que corrió antes) ni con `applyPolicy`.

---

### 🟠 H3 — ALTO · Tres capas insertan cierre; `resolveClosing` no las revierte

**Causa raíz estructural (defecto nº 1 del contrato):** pueden añadir pregunta de cierre:
1. `applyPolicy` → `appendClosing` (policy.ts:782 tercera vía; 802 tras eliminar).
2. `enforceOutputPolicy` → `standardClosingRequest` (output-validator.ts:366).
3. `resolveClosing` → `enforceMissingClosing` / `rewriteDelegativeClosing`.

`resolveClosing` (capa 8) solo **revierte** los cierres de 1 y 2 si `enforceMissingClosing`
los captura como bloque de cierre Y la keyword no coincide (entonces los sustituye). Si
coincide la keyword → los deja intactos (doble). Si quedan separados por una frase
declarativa (p. ej. la cláusula de simulación de H2, o una frase de análisis) → el
colector se detiene antes y **añade otro** → doble.

**Confirmación de duplicaciones concretas pedidas en el brief:**
- `rewriteDelegativeClosing` y `enforceMissingClosing` **ya NO se llaman sueltas** desde
  `route.ts`: solo se invocan **dentro** de `resolveClosing` (policy.ts:513/515). ✔ Esa
  coordinación puntual quedó bien resuelta.
- **Pero** la cláusula de simulación **sí** se inserta en más de un punto conceptual: el
  orchestrator la mete en el `tool_result` (orchestrator.ts:255/441) para que el modelo la
  verbalice, y `enforceSimulationHonesty` la vuelve a insertar si el marcador falta
  (policy.ts:562–577). Si el marcador del modelo y el canónico no normalizan igual →
  riesgo de **doble cláusula** (mitigado hoy por `SIMULATION_MARKER_RE`, pero frágil).
- `ensureSubstance` corre **solo en FINANCIERO** (route.ts:398), correcto; no se detectó
  que corra en carriles donde no debe.

---

### 🟠 H4 — ALTO · `enforceSimulationHonesty` no cubre los negadores de TAE (contradicción publicada)

**Síntoma QA:** "(sin considerar la TAE)" junto a "(simulación con TAE de referencia…)".

**Causa raíz:** `FALSE_NO_INTEREST_RE` (policy.ts:529) solo elimina variantes de
*intereses*: `sin incluir intereses | sin intereses | no incluye intereses | sem juros |
sem incluir juros | without interest | excluding interest`. **No cubre** los negadores de
**TAE**: "sin considerar la TAE", "sin tener en cuenta la TAE", "sin la TAE", "excluyendo
la TAE" (ni sus formas PT/EN). Ese negador **sobrevive**, y como `SIMULATION_MARKER_RE`
(policy.ts:532) no lo reconoce como marcador, `enforceSimulationHonesty` **añade además**
la cláusula canónica → las dos frases contradictorias se publican juntas.

---

### 🟡 H5 — MEDIO · La garantía global no tiene post-condición única

No existe un paso final que verifique el texto que sale. Cada capa "confía" en que las
demás no rompieron nada. Los cuatro hallazgos anteriores son manifestaciones de esta
ausencia. Es el argumento para `assertOutputInvariants` (contrato §4).

---

## Plan de remediación por archivo (para AG08, ejecutable sin ambigüedad)

> AG08 es owner de `guardrail/*`, `output-validator.ts` y prompts. AG01 entrega el
> contrato + esta auditoría; AG08 implementa en Sonnet. AG01 valida el resultado.

### `src/lib/guardrail/validate.ts` — resuelve **H1**
- Añadir, antes del fallthrough a la rama (a) (línea 287), una comprobación de
  **concepto derivado afirmado sin respaldo**:
  - Definir el conjunto `DERIVED_CONCEPTS = {deficit, sobrante, cuota, recorte, capacidad_anual}`.
  - Si `conceptsInSentence(sentenceText)` (SIN el `.filter`) contiene un concepto derivado
    `k` tal que `!(k in conceptos)` **o** su antónimo está en `conceptos` con signo
    contrario (`deficit` ⇄ `sobrante`), y la cifra `m` está en esa frase → **bloquear** con
    `motivo: "concepto afirmado sin cálculo que lo respalde"`, sin `correccion`.
  - Mantener intactos los conceptos de entrada (`ingreso`, `gastos`).
- Añadir tests: "déficit de 9500 con sobrante +500 → bloqueado"; "sobrante de X con déficit
  calculado → bloqueado"; "ingreso de X sin conceptos → NO bloqueado por esta regla".

### `src/lib/guardrail/policy.ts` — resuelve **H3** y **H4**
- **H3:** eliminar la inserción de cierre de `applyPolicy`:
  - Línea 782 (tercera vía) y 802 (tras eliminar frases): **no** llamar `appendClosing`.
    `applyPolicy` solo sanea cifras y devuelve el texto; el cierre lo pone `resolveClosing`.
  - Revisar los tests de `applyPolicy` que esperan el cierre y moverlos a `resolveClosing`.
- **H4:** ampliar `FALSE_NO_INTEREST_RE` (línea 529) para cubrir los negadores de TAE:
  `sin considerar (la )?tae | sin tener en cuenta (la )?tae | sin (la )?tae | excluyendo (la )?tae`
  y equivalentes PT (`sem considerar a taeg`, `sem a taxa`) / EN (`without the apr`,
  `excluding the apr`).
- **H2 (coordinación):** en `enforceMissingClosing`, cuando `field === "tae"` y el texto ya
  contiene la cláusula de simulación (`SIMULATION_CLAUSE`/marcador de referencia), **no**
  añadir "¿Qué TAE te ofrece tu banco?": la cláusula ya cumple la función de señalar que
  falta la TAE real. Alternativa preferible: delegar esta decisión a `assertOutputInvariants`
  (invariante a + b) para no volver a acoplar dos capas.

### `src/lib/llm/output-validator.ts` — resuelve **H3**
- En `enforceOutputPolicy` (línea 366): **no** añadir `standardClosingRequest`. La función
  elimina oraciones infractoras y devuelve el texto limpio; si queda sin sustancia, que la
  decida `ensureSubstance`/`resolveClosing`. Ajustar sus tests.

### `src/lib/guardrail/policy.ts` (o módulo nuevo `invariants.ts`) — resuelve **H2 + H5**
- Implementar `assertOutputInvariants(text, ctx)` según el contrato §4 (pura, idempotente,
  nunca lanza). Verifica y corrige (a) máx 1 pregunta, (b) sin contradicción tasa/simulación,
  (c) sin concepto sin cálculo (defensa en profundidad de H1), (d) sin proveedor, (e) sin
  cierre delegativo. Loguea cada violación con su `id` y acción.

### `src/app/api/chat/route.ts` — cablea la post-condición
- Tras `resolveClosing` (línea 416), añadir la llamada final única:
  ```ts
  const inv = assertOutputInvariants(finalContent, {
    carril, lang: userLang, missing: scenario.missing,
    conceptos: verified.conceptos, esSimulacion,
  })
  finalContent = inv.texto
  if (inv.violaciones.length) console.warn('[chat] invariants', JSON.stringify({ ... }))
  ```
- No añadir ninguna otra capa que inserte cierre (regla de oro del contrato §5).

---

## Verificación sugerida tras la remediación (AG08 → AG01 valida)
- `npm test` + `npm run test:regression` verdes.
- Casos nuevos: déficit fantasma (H1), doble TAE en simulación (H2), "(sin considerar la
  TAE)" (H4), y una prueba de idempotencia de `assertOutputInvariants`.
- Regresión de "resolutor único": un turno FINANCIERO con `applyPolicy` bloqueando cifras
  **y** `missing=["tae"]` debe terminar con **exactamente una** pregunta.
