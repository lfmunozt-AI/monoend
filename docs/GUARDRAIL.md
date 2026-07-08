# Guardarraíl de cifras — arquitectura de 5 capas

> **Principio rector: el código calcula, el modelo solo redacta.**
>
> Un LLM que produce un monto en euros que nadie le dio está alucinando, aunque
> suene razonable. El guardarraíl es una capa de **código puro** (regex +
> aritmética, sin llamadas a ningún LLM, edge-safe) que envuelve la respuesta ya
> generada y decide qué cifra sobrevive.

Migrado desde ModeloCFO en el sprint del 2026-07-06/08.

---

## 1. Las 5 capas y su estado real

Migrado ≠ cableado. Esta tabla es la verdad a día de hoy; el backlog de
`CLAUDE.md` tiene los pendientes de cableado.

| # | Capa | Archivos | ¿En el camino de la request? |
|---|------|----------|------------------------------|
| 1 | **Guardrail de entrada** | `src/lib/guardrail/injection.ts` | ❌ solo se reexporta |
| 2 | **Guardrail de salida** | `src/lib/guardrail/{extract,validate,policy,schema}.ts` | ✅ `api/chat/route.ts` |
| 3 | **Calculadora** | `src/lib/calculator/{operations,orchestrator}.ts` | ❌ solo en tests |
| 4 | **LLM Router** | `src/lib/llm/{router,types}.ts` + `providers/` | ❌ nadie lo importa |
| 5 | **Bitácora** | `supabase/migrations/009_guardrail.sql` | ✅ vía `runGuardrail()` |

Soporte compartido por las capas 1–2: `numbers.ts` (parsing numérico) y
`context.ts` (moneda, porcentaje, unidad de tiempo, etiqueta por proximidad).

---

## 2. Mapa de archivos

```
src/lib/guardrail/
  index.ts        ← runGuardrail(): orquesta las piezas 1-4
  extract.ts      ← PIEZA 1 · hechos verificados del mensaje del usuario
  validate.ts     ← PIEZA 2 · grounding de cada cifra de la respuesta
  policy.ts       ← PIEZA 3 · bloqueo, reescritura y entradas de log
  schema.ts       ← PIEZA 4 · parseo tolerante del output (Zod)
  injection.ts    ← detector de inyección de prompts (solo detecta, no bloquea)
  numbers.ts      ← findNumberMentions / parseDigitAmount / dedupeOverlaps
  context.ts      ← detectCurrency / detectLabel / isPercent / isTimeUnit

src/lib/calculator/
  index.ts        ← punto de entrada del paquete
  operations.ts   ← sobrante · porcentajeDe · regla503020 · fondoEmergencia
                    proyeccion · tiempoHastaMeta · ratioDeuda · interesCompuesto
  orchestrator.ts ← buildVerifiedContext() → { bloque, cifrasCalculadas }

src/lib/llm/
  router.ts       ← callLLM(req) despacha al provider, mide latencia
  types.ts        ← LLMRequest / LLMResponse / LLMError
  providers/      ← openai.ts (real) · together.ts · mistral.ts · custom.ts (stubs)

supabase/migrations/
  009_guardrail.sql  ← tabla guardrail_log + RLS
```

### Flujo de un turno

```
mensaje del usuario
      │
      ├─► extractInputFacts()          PIEZA 1 → VerifiedFact[]
      │
      ▼
respuesta del modelo
      │
      ├─► parseModelOutput()           PIEZA 4 → { consejo, structured }
      ├─► validateGrounding(consejo, hechos [, cifrasCalculadas])
      │                                PIEZA 2 → { aprobadas, bloqueadas }
      ├─► applyPolicy()                PIEZA 3 → texto_final + logEntries
      └─► logGuardrailEvents()         → guardrail_log (best-effort)
      ▼
  texto_final  (lo que se persiste y se muestra)
```

Todo salvo el hash y el `INSERT` es síncrono y cuesta milisegundos.

---

## 3. La tercera vía de cifras estándar

El validador clasifica **cada** cifra de la respuesta. Ante una cifra que el
usuario no aportó, el modelo no tiene dos vías (inventarla · callarse). Tiene tres:

| Categoría | Qué es | Ejemplo | Resultado |
|-----------|--------|---------|-----------|
| `hecho` | Coincide con un dato del usuario (±1%, piso de 1) | usuario dijo "gano 2500" → "tus 2500" | ✅ se mantiene |
| `calculo` | Se deriva de un hecho, o la produjo el motor financiero | 2500 − 1500 → "te sobran 1000" | ✅ se mantiene |
| `concepto` | **Tercera vía**: porcentaje o regla general del dominio | "el 20% del ingreso", "de 3 a 6 meses" | ✅ se mantiene |
| *(ninguna)* | Monto absoluto sin respaldo | "gastarás unos 1800 al mes" | 🚫 **bloqueado** |

La tercera vía es la salida honesta cuando falta el dato: **enunciar la regla, no
materializarla en euros que nadie dio.** "Reserva de 3 a 6 meses de gastos" es
correcto; "tu Reserva de Imprevistos debe ser de 9.000 €" — sin conocer sus gastos —
es una alucinación.

Implementación: `validate.ts` → `isPercent()` / `isTimeUnit()` (categoría
`concepto`), `approxEqual()` (categoría `hecho`), `isDerived()` + `exactMatch()`
contra `cifrasCalculadas` (categoría `calculo`).

**Precedencia**: una coincidencia exacta (±0.01) con una cifra del motor financiero
se aprueba **antes** de probar los multiplicadores heurísticos. El cálculo
verificado manda sobre la heurística.

---

## 4. Política `mvp` v2 — deduplicación

`policy.ts` expone dos modos:

- **`mvp`** (por defecto) — reescribe la respuesta.
- **`passthrough`** — no toca el texto, solo registra. Para medir el impacto sin
  alterar la UX.

### Qué hace `mvp` v2

1. **Elimina la frase entera** que contiene cada monto bloqueado
   (`removeBlockedSentences()`), no solo la cifra. Una frase mutilada
   ("Deberías ahorrar al mes") es peor que ninguna frase.
2. Añade **UNA SOLA** línea de cierre pidiendo el dato que falta.
3. Si lo que sobrevivió **ya termina** en pregunta o en propuesta
   (`endsWithRequestOrProposal()`), **no añade nada**.
4. Si no sobrevivió nada, la petición **es** la respuesta.

### Por qué v2 (el bug que corrige)

v1 sustituía **cada** frase bloqueada por la plantilla de petición. Una respuesta
con tres montos inventados terminaba así:

```
Para darte esa cifra primero necesito un dato…
Para darte esa cifra primero necesito un dato…
Para darte esa cifra primero necesito un dato…
```

El Consigliere cierra con **una** petición de dato, nunca con varias — es el ADN
del producto, no una preferencia de estilo.

### Especialización del cierre

La petición se adapta a la etiqueta de la cifra bloqueada (`gasto`, `ingreso`,
`meta`, `ahorro`, `deuda`, `interes`, `renta`) **solo si todas las cifras
bloqueadas comparten etiqueta**. Con etiquetas mezcladas → cierre genérico.
Precedencia: `dataHint` explícito → etiqueta única → genérico.

La etiqueta se busca **dentro de la frase de la cifra** (`labelWithinSentence()`).
`detectLabel()` mira una ventana de ±40 caracteres, que puede cruzar el punto y
robar una palabra de la frase siguiente. Mejor cierre genérico que una etiqueta
prestada del vecino.

---

## 5. Tabla `guardrail_log`

`supabase/migrations/009_guardrail.sql`. **Solo metadatos.**

| Columna | Tipo | Notas |
|---------|------|-------|
| `id` | `uuid` | PK, `gen_random_uuid()` |
| `user_id` | `uuid` | FK `auth.users`, `ON DELETE CASCADE` |
| `blocked_value` | `numeric` | valor numérico bloqueado |
| `blocked_text` | `text` | literal exacto (`"1500"`) |
| `reason` | `text` | motivo de la regla |
| `question_hash` | `text` | SHA-256 truncado a 16 chars |
| `created_at` | `timestamptz` | `now()` |

### Privacidad — no negociable

- **Nunca** se almacena el mensaje del usuario ni la respuesta del modelo.
- La pregunta se referencia por `question_hash` (`hashQuestion()`, Web Crypto,
  edge-safe). Permite correlacionar bloqueos sin guardar el texto.
- La `etiqueta` de la cifra existe en memoria (`GuardrailLogEntry`) pero **no se
  persiste**: no hay columna para ella.
- **RLS activa**: policy `guardrail_log_owner`, `auth.uid() = user_id` en `USING`
  y `WITH CHECK`. Índices por `user_id` y `(user_id, created_at desc)`.
- `logGuardrailEvents()` es **best-effort**: captura cualquier error y lo loguea
  por consola. Un fallo de la bitácora **nunca** tumba el chat.

---

## 6. Cómo correr los tests

Node puro vía `tsx`, sin framework. Cada archivo es ejecutable.

```bash
npm run test:guardrail    # guardrail.test.ts · numbers.test.ts · injection.test.ts
npm run test:calculator   # operations.test.ts · orchestrator.test.ts
npm test                  # ica · portugal · transactions · validator
```

Un archivo suelto:

```bash
npx tsx src/lib/guardrail/guardrail.test.ts
```

| Suite | Tests | Cubre |
|-------|-------|-------|
| `guardrail.test.ts` | 27 | extract → validate → policy end-to-end |
| `numbers.test.ts` | 6 | parsing es/LatAm, solapamientos |
| `injection.test.ts` | 3 | patrones de inyección, falsos positivos |
| `operations.test.ts` | 11 | las 8 operaciones financieras |
| `orchestrator.test.ts` | 4 | `buildVerifiedContext` + `cifrasCalculadas` |

---

## 7. Límites conocidos

- **Convención numérica es/LatAm** (`numbers.ts`): el punto es separador de miles
  y la coma decimal. `"1.200,50"` → `1200.5`; `"1.200"` → `1200`. Un usuario que
  escriba en convención anglosajona (`"1,200.50"`) será malinterpretado.
- **`schema.ts` importa `zod`, que NO está declarado en `package.json`.** Hoy se
  resuelve como dependencia transitiva de `openai` (`zod@4.4.3` en el lock). Si
  `openai` deja de arrastrarlo, el build rompe. **Declararlo explícitamente.**
- **`parseModelOutput()` es tolerante a propósito**: el chat emite texto libre, no
  JSON. Si el modelo devuelve `{consejo, cifras_usadas}` se valida con Zod; si
  devuelve texto plano, se envuelve como `consejo` y la vía regex sigue mandando.
  El esquema está listo para cuando el modelo pase a salida estructurada.
- **`detectInjection()` solo detecta, no bloquea.** Es deliberadamente conservador:
  prefiere no marcar consultas financieras normales (los falsos positivos son
  caros) antes que atrapar todo intento. La política de bloqueo es una fase
  posterior.
- **Streaming.** El guardarraíl necesita la respuesta **completa** antes de
  validarla, así que el chat bufferiza y la UX token-a-token queda aparcada
  (rama `feature/streaming-buffer`, local, sin subir).

---

## 8. Cableado en `api/chat/route.ts`

Orden exacto — el guardrail de cifras corre **primero**, el validador de política
**después**, ambos sobre el mismo texto:

```ts
const guardrail = await runGuardrail(cleanMessage, llmResult.content, {
  mode: 'mvp',
  supabase: admin,
  userId: user.id,
})
let finalContent = guardrail.texto_final

const validation = validateConsigliereOutput(finalContent)
finalContent = validation.text   // reescribe branding → "Reserva de Imprevistos"

if (validation.suggestedDisclaimer && !finalContent.includes(validation.suggestedDisclaimer)) {
  finalContent = `${finalContent}\n\n${validation.suggestedDisclaimer}`
}
```

El disclaimer se adjunta de forma **determinista**, sin una segunda llamada al LLM
y sin bloquear al usuario. `finalContent` es lo que se persiste en `messages` y lo
que se devuelve al cliente.
