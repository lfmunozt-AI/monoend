# Auditoría de coherencia post-migración — AG01 (Arquitecto)

Fecha: 2026-07-08 · Rama auditada: `develop` @ `c10c511` · Alcance: solo lectura.
**No se corrigió nada** (por instrucción). Este informe prioriza hallazgos y
propone acciones; la implementación va en ramas aparte tras aprobación de Luis.

## Método
- Lectura completa de: `src/lib/guardrail/*`, `src/lib/calculator/*`, `src/lib/llm.ts`,
  `src/lib/llm/*` (router, types, output-validator, validator-rules, providers/*),
  `src/lib/prompts/consigliere.ts`, `src/app/api/chat/route.ts`, migración `009_guardrail.sql`.
- `npx tsc --noEmit` → **0 errores** (no hay imports rotos ni desajustes de tipos).
- `npm run test:guardrail` → 3/3 OK · `npm run test:calculator` → 4/4 OK.
- Rastreo de wiring con grep para detectar código exportado pero no consumido.

## Resumen ejecutivo
El código nuevo es de **alta calidad interna** (puro, edge-safe, bien documentado,
con tests). El problema no son bugs locales sino **cableado**: tres piezas
importantes están construidas y probadas pero **no conectadas al flujo real**, y
el validador de política **no se hace cumplir** en el route para sus casos más
graves. No hay imports rotos ni código duplicado que rompa el build.

| # | Severidad | Hallazgo | Efecto |
|---|-----------|----------|--------|
| C1 | **Crítico** | El route ignora `severity:'block'` del validator salvo para adjuntar disclaimer de producto | Garantías de rentabilidad y recomendaciones absolutas llegan al usuario |
| M1 | Mayor | Motor `calculator` (`buildVerifiedContext`) desconectado | El grounding por cálculo verificado nunca ocurre; el modelo improvisa cifras |
| M2 | Mayor | `src/lib/llm/router.ts` es una abstracción paralela no usada | Dos `callLLM` divergentes; riesgo de mantenimiento y de cablear el equivocado |
| M3 | Mayor | `detectInjection` no está cableado | La señal anti-inyección de prompts nunca se evalúa ni loguea |
| m1 | Menor | Referencias a `docs/GUARDRAIL.md` y `streamChat` inexistentes | Doc drift; guía engañosa para el próximo agente |
| m2 | Menor | Deriva del significado de "ICA" entre CLAUDE.md y código | Terminología incoherente de cara a mantenimiento |
| m3 | Menor | `localStorage` guarda el contenido íntegro del chat financiero | Dato sensible fuera de la BD con RLS (GDPR) |
| m4 | Menor | `cifras_usadas` del JSON estructurado (Pieza 4) se descartan | El esquema queda a medio integrar |

---

## CRÍTICO

### C1 — El validador de política detecta bloqueos pero el route no los hace cumplir
**Archivos:** `src/app/api/chat/route.ts:218-227`, `src/lib/llm/output-validator.ts:117-180`.

`validateConsigliereOutput` define un contrato de tres severidades y documenta que
`block` significa *"no enviar al usuario tal cual; regenerar o adjuntar disclaimer"*.
Devuelve `passed:false` / `severity:'block'` para:
- Regla 1: producto específico sin disclaimer → **sí** activa `suggestedDisclaimer`.
- Regla 2: garantía de rentabilidad ("vas a ganar 12%") → `block`, **sin** `suggestedDisclaimer`.
- Regla 3: recomendación absoluta + producto → `block`, **sin** `suggestedDisclaimer`.

El route, en cambio, **no lee `validation.passed` ni `validation.severity`** salvo
para un `console.warn`. Solo actúa si existe `validation.suggestedDisclaimer`. Por
tanto:
- Producto sin disclaimer → mitigado (se adjunta el disclaimer canónico). ✅
- **Garantía de rentabilidad → NINGUNA mitigación**: el texto llega íntegro al usuario. ❌
- **Recomendación absoluta sobre producto → NINGUNA mitigación**. ❌

**Escenario concreto:** el modelo responde *"Mete todo en Bitcoin, vas a ganar un
20% asegurado"*. El validator marca `block` (garantía + recomendación absoluta +
producto), el route emite un `console.warn` y **envía la frase tal cual** (el
disclaimer solo se adjunta por la rama de producto, que aquí sí aplicaría — pero
la garantía "20% asegurado" no se neutraliza con un disclaimer). Riesgo
regulatorio y de marca directo; es el hallazgo más grave.

**Acción propuesta:** en el route, ante `severity:'block'` no mitigable por
disclaimer, o bien (a) regenerar una vez con instrucción de corrección, o (b)
sustituir por una respuesta segura de reintento, o (c) como mínimo, eliminar la
frase infractora (equivalente a la política del guardrail de cifras). Decisión de
producto para Luis. No tocar hasta acordar la política.

---

## MAYOR

### M1 — El motor `calculator` está construido y probado pero desconectado
**Archivos:** `src/lib/calculator/orchestrator.ts` (`buildVerifiedContext`),
`src/lib/guardrail/index.ts:57-82`, `src/lib/guardrail/validate.ts:116-166`.

`grep` confirma que **nadie importa `buildVerifiedContext`** fuera del propio
paquete. Consecuencias en cadena:
1. El bloque *"DATOS VERIFICADOS DE ESTA CONSULTA…"* que debería inyectarse en el
   system prompt para que el modelo use cifras exactas **nunca se inyecta**. El
   modelo genera sin ese anclaje → más propenso a inventar (justo lo que el
   guardrail luego bloquea).
2. `validateGrounding(consejo, hechos, cifrasCalculadas?)` acepta un tercer
   parámetro con las cifras exactas del motor, pero `runGuardrail` la invoca con
   **dos** argumentos (`index.ts:71`). La rama de aprobación por "cálculo
   verificado por el motor financiero" (`validate.ts:158`, branch c0) es
   **inalcanzable** en producción.

Es código muerto de alto valor: la arquitectura "el código calcula, el modelo
redacta" está a un cable de funcionar. **Acción:** cablear `buildVerifiedContext`
en el route (inyectar `bloque` al prompt y pasar `cifrasCalculadas` a
`runGuardrail` → `validateGrounding`). Diseño y wiring en rama aparte.

### M2 — Router LLM multiprovider paralelo y sin consumidores
**Archivos:** `src/lib/llm/router.ts`, `src/lib/llm/types.ts`, `src/lib/llm/providers/*`.

Coexisten dos abstracciones de LLM con el **mismo nombre de función** y semántica
opuesta:
- `src/lib/llm.ts` (AG08): `callLLM/callLLMJson/callLLMWithHistory`, patrón
  **"nunca lanza"** (fallback resiliente), consumido por `chat/route.ts` y
  `transactions/route.ts`.
- `src/lib/llm/router.ts`: `callLLM(req: LLMRequest)` que **`throws LLMError`**,
  multiprovider. `together`, `mistral`, `custom` son stubs `NOT_IMPLEMENTED`; solo
  `openai` es real. `grep` confirma **cero importaciones** de `@/lib/llm/router`.

No rompe el build (nadie importa ambos), pero es deuda arquitectónica: un agente
futuro puede cablear el router equivocado, y las dos `callLLM` confunden. Es
exactamente la fusión que la tarea previa de AG01 perseguía. **Acción/decisión:**
consolidar en una sola capa — recomendación: conservar `llm.ts` (tiene
consumidores y el patrón resiliente) e injertarle el patrón agnóstico de
proveedor del router; luego retirar `llm/router.ts` + stubs o degradarlos a
`docs/`. Requiere decisión de Luis por el alcance.

### M3 — Detección de inyección de prompts inerte
**Archivos:** `src/lib/guardrail/injection.ts`, `src/lib/guardrail/index.ts:133`.

`detectInjection` está implementado y testeado, pero `grep` muestra que solo lo
usan su test y el re-export de `index.ts`. **`runGuardrail` no lo llama** y el
route tampoco. La señal (ignore instructions, cambio de rol, `system:`/`assistant:`
falsos, "desactiva el guardrail") **nunca se evalúa ni se registra**. El archivo
existe pero es un placebo de seguridad. **Acción:** invocar `detectInjection`
sobre `userMessage` en `runGuardrail` y persistir la señal (columna/campo nuevo o
en `guardrail_log`). Conservador por diseño (no bloquea), así que el riesgo de
falsos positivos es bajo.

---

## MENOR

### m1 — Referencias colgantes en comentarios
- `docs/GUARDRAIL.md` se cita en `schema.ts:12`, `numbers.ts:6`, `index.ts:8`
  pero **no existe** (`ls` lo confirma).
- `streamChat` se cita en `guardrail/index.ts:10` como punto de enganche, pero no
  existe tal función; el route usa `callLLMWithHistory` en modo no-stream.

Doc drift inofensivo hoy, pero engaña al próximo agente. Crear `docs/GUARDRAIL.md`
real o corregir las referencias.

### m2 — "ICA" significa dos cosas distintas
El código es la fuente de verdad: `consigliere.ts:78` fija **"Índice de Certeza
Algorítmica"**. CLAUDE.md mezcla ese término con el antiguo "Índice de Control
Autónomo" en su sección técnica interna. Unificar CLAUDE.md al término del código.
(No corregido, per instrucción.)

### m3 — Contenido del chat en `localStorage`
`chat/page.tsx` (`saveMessages`) persiste el contenido íntegro de la conversación
financiera en `localStorage` del navegador, fuera de la BD con RLS. Considerar:
no persistir contenido (solo `conversationId`) y rehidratar desde
`/api/chat/history`, o cifrar/expirar. Relevante GDPR aunque de bajo riesgo.

### m4 — `cifras_usadas` de la Pieza 4 se descartan
Cuando el modelo emite JSON estructurado (`schema.ts`), `parseModelOutput`
extrae `consejo` y `cifras_usadas`, pero `runGuardrail` solo pasa `consejo` al
validador; `cifras_usadas` (con su `fuente` declarada) **no se usan**. Hoy inocuo
(el modelo emite texto plano), pero la Pieza 4 queda a medias. Cerrar cuando se
migre el modelo a salida estructurada.

---

## Sobre el orden guardrail → validator en el route (auditoría específica)
El orden es **correcto** para el diseño actual:
1. `runGuardrail` (cifras): opera sobre la respuesta cruda, elimina frases con
   montos sin respaldo y añade UNA petición de cierre. Produce `texto_final`.
2. `validateConsigliereOutput` (política/branding): corre **después**, sobre el
   texto ya saneado; reescribe branding de forma determinista y detecta bloqueos.

Ambos operan sobre la respuesta **completa antes de responder al cliente** — el
invariante arquitectónico (nada se muestra sin validar) **se cumple** hoy, porque
el route es no-stream y devuelve JSON tras ambas capas. No hay condición de
carrera ni orden invertido.

La única grieta del orden es **C1**: la etapa 2 calcula un veredicto `block` que
la etapa 3 (persistir/responder) ignora. El orden es bueno; lo que falta es
*enforcement*.

## Lo que está sólido (para no romperlo)
- Código puro edge-safe, sin NaN silenciosos (calculator devuelve `CalcError`
  tipado; numbers/context bien acotados).
- `009_guardrail.sql`: RLS por `user_id`, índices correctos, grants a
  `authenticated` y `service_role`; el log es **solo metadatos** (pregunta por
  hash, nunca texto) — privacidad bien resuelta.
- `tsc --noEmit` limpio; suites guardrail/calculator en verde.
- Patrón "nunca lanza" en `llm.ts` y best-effort en logging/embeddings: el chat no
  se cae si una pieza secundaria falla.

## Prioridad de remediación sugerida (para planificar sprints)
1. **C1** (enforcement de bloqueos) — riesgo regulatorio, primero.
2. **M1** (cablear calculator) — sube la calidad del grounding de raíz.
3. **M3** (cablear injection) — cierre de gap de seguridad, barato.
4. **M2** (consolidar capa LLM) — deuda arquitectónica, requiere decisión.
5. Menores m1–m4 — higiene, agrupar en una pasada.
