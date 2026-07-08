# PROJECT_LOG — Sovereign CFO / andgcore

## 2026-05-19 — Día 5 (continuación)

### Decisiones de infraestructura
- Flujo 3 capas confirmado: agent/XX → develop → main
- Branch protection: control manual (GitHub Free no soporta
  en repos privados — activar cuando haya ingresos)
- Vercel: 2 ambientes configurados
  PRD: sovereign-cfo.vercel.app (rama main)
  QA: URL preview automática (rama develop)
- Ignored Build Step activo: solo main y develop
  generan deployments en Vercel
- Ramas sincronizadas: todas en bcf10df

### Comandos de merge aprobados por Luis
# Agente → QA:
git checkout develop
git merge agent/XX --no-ff -m "merge: agXX → develop"
git push origin develop

# QA → PRD (solo cuando Luis aprueba):
git checkout main
git merge develop --no-ff -m "release: develop → main"
git push origin main

### Pendientes
- develop URL de preview pendiente de confirmar en Vercel
- tmux + launch-swarm.sh pendiente de instalar
- Motor IDF pendiente de conectar al dashboard
- Migración 007 pendiente de ejecutar en Supabase

---

## 2026-05-26 — Migraciones IDF + persona del Consigliere

### AG02 — migraciones 007 / 008
- `007_goals_table.sql` (tabla `goals`, RLS `goals_user_isolation`) y
  `008_idf_function.sql` (`calcular_idf_dimensions(uuid)`, SECURITY DEFINER).
- Renumeradas: el prompt pedía 005/006, ya ocupados por `005_ica_trigger.sql`
  y `006_embeddings_search.sql`. Sobreescribirlos habría roto el trigger ICA y
  `match_embeddings()`.
- Validadas contra el proyecto Supabase real; ROLLBACK del test verificado.

### AG08 — prompt v2 + output validator
- `src/lib/prompts/consigliere.ts` reescrito; `buildSystemPrompt(context)`
  conserva su firma pública (el chat route no cambia).
- Nuevos: `src/lib/llm/validator-rules.ts`, `src/lib/llm/output-validator.ts`,
  `docs/consigliere-voice.md`.
- `validateConsigliereOutput()` → `severity: ok | flag | block`. Bloquea producto
  financiero sin disclaimer, garantías de rentabilidad y recomendaciones
  absolutas. Marca (`flag`) el lenguaje motivacional cliché.

---

## 2026-07-06 — Sprint migración 5 capas ModeloCFO → repo

Se traen a `sovereign-cfo` las cinco capas del guardarraíl de cifras diseñadas en
ModeloCFO. Principio rector: **el código calcula, el modelo solo redacta.**

### Capas migradas (AG02 → `8a96045`, AG01 → `7f64918`)
1. **Guardrail de entrada** — `src/lib/guardrail/injection.ts`, `detectInjection()`.
2. **Guardrail de salida** — `extract.ts` (hechos del usuario) → `validate.ts`
   (grounding de cada cifra) → `policy.ts` (bloqueo + reescritura) → `schema.ts`
   (parseo del output estructurado). Orquestados por `runGuardrail()`.
3. **Calculadora** — `src/lib/calculator/` (`operations.ts` + `orchestrator.ts`).
   `buildVerifiedContext()` devuelve `{bloque, cifrasCalculadas}`.
4. **LLM Router agnóstico** — `src/lib/llm/{router,types}.ts` + `providers/`
   (openai real; together, mistral, custom en stub).
   **Regla de credenciales**: las claves solo se leen de `process.env` dentro del
   provider. `LLMRequest` no lleva `apiKey`. Sin clave → `LLMError('AUTH')`.
5. **Bitácora** — `supabase/migrations/009_guardrail.sql`, tabla `guardrail_log`,
   RLS por `user_id`. Solo metadatos: la pregunta se guarda como `question_hash`
   (SHA-256 truncado), **nunca** el texto del usuario ni la respuesta del modelo.

### Cableado en el chat route (AG08 → `77426ae`, PR #3)
- `api/chat/route.ts` llama `runGuardrail(cleanMessage, llmResult.content, {mode:'mvp', supabase: admin, userId})`.
- Después, `validateConsigliereOutput()` sobre el texto ya saneado. Si falta el
  disclaimer, se adjunta de forma determinista — sin segunda llamada al LLM.
- Ambas capas son best-effort: nunca tumban el chat.

### ⚠️ Deuda de cableado detectada al documentar (2026-07-08)
Las 5 capas están **migradas**, pero solo el guardrail de salida está **en el
camino de la request**:
- `detectInjection()` — solo se reexporta; nadie la llama.
- `buildVerifiedContext()` — solo se usa en `orchestrator.test.ts`. El prompt no
  recibe el bloque de cifras verificadas, y `validateGrounding()` se invoca sin
  su tercer argumento `cifrasCalculadas`.
- `src/lib/llm/router.ts` — ningún módulo lo importa. `api/chat` y
  `api/transactions` siguen en el viejo `src/lib/llm.ts`.

Cada punto está ahora en el backlog de `CLAUDE.md` como pendiente explícito.

### 🔴 INCIDENTE — PR #1 y PR #2 mergeados a `main`
- Ambos PR se abrieron con base `main` en vez de `develop`. GitHub propone `main`
  por defecto y nadie lo cambió.
- `#1` (`agent/02` → `main`) y `#2` (`develop` → `main`) entraron directos a
  producción, saltándose QA.
- **Producción quedó sana**: el contenido era el mismo que iba a pasar por QA
  (capas guardrail + calculator + migración 009). No hubo rollback.
- **Regla nueva, permanente**: los PR de agentes van **SIEMPRE con base
  `develop`**. Hay que cambiar la base a mano en cada PR. Documentada en
  `CLAUDE.md` → REGLAS DE PROCESO.
- Regla acompañante: QA se valida **solo en el alias `git-develop`**, nunca en
  URLs de deployment con hash — son inmutables y devuelven un commit viejo.

---

## 2026-07-08 — Guardrail v2, ADN, terminología y latencia

### AG04 — contrato del chat y latencia (`251516b`, `63f795a`; PR #4, #5)
- **Fix `Invalid Date`**: el cliente esperaba un `createdAt` que el server nunca
  mandó. El endpoint devuelve `{ response, conversationId, tokensUsed }`; el
  timestamp lo pone el cliente al renderizar.
- **Latencia**: eliminado el `setTimeout` artificial de 1 s en la UI del chat.
  No reintroducir esperas cosméticas.
- Link "Chat CFO" y burbuja del dashboard corregidos.

### AG08 — guardrail mvp v2 + persona ADN v2.1 (`e43e3ec`, `0b04d78`, `81bf0a5`; PR #6)
- **Política `mvp` v2 — deduplicación.** v1 sustituía **cada** frase bloqueada por
  la plantilla de petición: una respuesta con tres montos inventados terminaba con
  *"Para darte esa cifra primero necesito un dato…"* incrustado tres veces.
  v2 **elimina la frase entera** que contiene el monto y añade **una sola** línea
  de cierre. Si lo que sobrevive ya termina en pregunta o propuesta, no se añade
  nada (`endsWithRequestOrProposal()`).
- La petición de cierre se especializa por etiqueta (`gasto`, `ingreso`, `meta`,
  `ahorro`, `deuda`, `interes`, `renta`) solo si **todas** las cifras bloqueadas
  comparten etiqueta; con etiquetas mezcladas, cierre genérico.
- La etiqueta se busca **dentro de la frase** de la cifra (`labelWithinSentence()`),
  no en una ventana de ±40 caracteres que saltaba el punto y robaba una palabra de
  la frase siguiente.
- **Persona ADN v2.1** del Consigliere.
- **`monoend` es el producto; `The Consigliere` es el nombre interno del modelo.**
  En UI solo aparece como badge, nunca en el cuerpo del mensaje.
- **ICA = "Índice de Certeza Algorítmica"**, unificado en todo el repo. Cierra
  cinco nombres en circulación.
- Validador reescribe el branding: "Reserva de Soberanía" → **"Reserva de
  Imprevistos"** (multiidioma).

### AG05 — documentación integral (esta entrada)
- `CLAUDE.md` reconstruido sobre la estructura post-pivot (`b4f24d5`, que nunca
  llegó a `develop`) con las decisiones de hoy sobreescritas encima:
  bloque `---ADN---`, ICA = Certeza Algorítmica, IDF sin expandir, Reserva de
  Imprevistos, regla 7 sin excepción, Consigliere interno, tercera vía, 5 capas.
- `docs/GUARDRAIL.md` creado.
- `INFORME.md` (raíz) → `docs/informes/`. **Regla nueva**: los informes van a
  `docs/informes/`, un archivo por agente y fecha. El `INFORME.md` de la raíz era
  un compuesto de tres informes (AG02, AG08, adenda AG08) pegados al resolver un
  conflicto add/add — exactamente lo que la regla evita.

### Pendientes tras este sprint
- Cablear router, calculadora y `detectInjection` (ver backlog `CLAUDE.md`).
- Renombrar el repo a `monoend`.
- `getICALevel()` devuelve `'soberania'` y lo persiste en `ica_history.level`:
  viola la regla absoluta 7. Migración + backfill → AG06.
- Streaming diferido en `feature/streaming-buffer` (local, sin subir): el
  guardarraíl necesita la respuesta completa antes de validar.
- Links 404 en el sidebar · markdown crudo en el chat.
