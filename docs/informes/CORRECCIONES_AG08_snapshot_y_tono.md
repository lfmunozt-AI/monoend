# Corrección AG08 — snapshot único para derivadas + sin jerga interna + anti-repetición de estructura propia

**Fecha:** 19 de agosto de 2026
**Rama:** `agent/08`, sobre `origin/develop` (`8fe8268`)
**Motivado por:** QA de producción testdev10 (18 ago) — estado quedó PERFECTO (5 ítems, suma
2250 = agregado = buckets, crédito completo), memoria entre sesiones funcionó. Dos defectos.
**Contrato:** `docs/CONTRATO_TRUTH_ENGINE.md` §9 (V4/V14/G1b) · §13 · §15

---

## 0 · Resumen

| # | Severidad | Síntoma medido |
|---|---|---|
| 1 | BLOQUEANTE | "Reducir a la mitad el ocio liberaría 75 €, dejando una capacidad de 375 €" — 375 = sobrante VIEJO (300, de gastos 2200) + mitad del ocio NUEVO (75, de gastos 2250). No corresponde a ningún estado real (325 era el correcto). |
| 2a | MAYOR (tono) | Jerga interna filtrándose: "Tu meta activa es una compra financiada", "nueva capacidad". Solo 13% de 23 respuestas sonaban francamente cálidas. |
| 2b | MAYOR (tono) | Repetición de estructura propia: "Reducir a la mitad … liberaría X €, dejando una capacidad de Y" apareció 4 veces con cifras distintas — la anti-repetición (texto crudo, 90%) no lo detecta. |
| 2c | MAYOR (tono) | Pregunta de aclaración publicada sin contexto: "¿Cuál es el valor correcto?" (26 caracteres, 4 mutaciones) — el enforcement había eliminado las frases que citaban los dos valores en conflicto. |

---

## 1 · BLOQUEANTE — estado mezclado durante el conflicto (G1b)

### Diagnóstico — reproducido con el pipeline real

`route.ts` computa DOS veces `buildScenarioContext` por turno: `verifiedSeed` sobre `seed`
(estado ANTES de fusionar el delta de este turno — usado por LLAMADA 1, `notaDatosCalculados`) y
`verified` sobre `scenario` (estado YA fusionado — usado por LLAMADA 2, `notaDatosCalculadosPostMerge`).
Ambas llamadas son, cada una, internamente PURAS y consistentes (`buildScenarioContext` solo
recibe un `scenario`) — el bloqueo por conflicto (V4, `gastosEnConflicto`) ya funcionaba
correctamente DENTRO de cada llamada, confirmado reproduciendo la secuencia real:

```
T1 "gano 2500 y gastos 2200: ...ocio 100"  → verified: nueva_capacidad = 350 (300+50)
T2 "el ocio en realidad es 150"            → CREA el conflicto (2200 vs 2250)
                                              verifiedSeed (seed, SIN conflicto aún):
                                                nueva_capacidad = 350 (autoconsistente, ocio 100)
                                              verified (scenario, YA con conflicto):
                                                nueva_capacidad OMITIDA — correcto (V4)
```

El defecto NO está en `buildScenarioContext`: está en que `call1.content` — el texto que el
modelo generó en LLAMADA 1, bajo `systemPrompt1`, viendo el bloque de `verifiedSeed` (con
`nueva_capacidad: 350`, calculado sobre el ocio VIEJO=100) — se añadía TAL CUAL al historial de
mensajes de LLAMADA 2 (`messages2`):

```ts
{ role: 'assistant' as const, content: call1.content, toolCalls: [toolCall] },
```

`systemPrompt2` (LLAMADA 2) SÍ es correcto — `notaDatosCalculadosPostMerge` omite la capacidad
por el conflicto, y `notaConflicto` prohíbe explícitamente calcularla — pero el modelo, con su
PROPIO borrador de LLAMADA 1 ya en el historial, tiene una vía para "recordar" el sobrante VIEJO
(300, de un turno donde no había conflicto aún) y combinarlo con una cifra FRESCA de este mismo
turno (la mitad del ocio nuevo, 75) — produciendo una cifra que ningún snapshot real respalda.

### Fix — `route.ts`

`call1.content` se vacía en `messages2` cuando se usó tool_call — el tool_call en sí (los datos
extraídos) SÍ viaja igual, es la única parte de LLAMADA 1 que es autoridad; la prosa NO:

```ts
{ role: 'assistant' as const, content: '', toolCalls: [toolCall] },
```

LLAMADA 2 razona entonces SOLO con: (a) el historial REAL de turnos anteriores (turnos ya
persistidos, con sus propios snapshots consistentes en su momento) y (b) el snapshot fresco de
ESTE turno (`verified`, íntegro de `scenario` post-merge). Nunca con un borrador provisional
calculado sobre un estado que el propio turno ya superó.

Los otros dos caminos de generación (`systemPromptRegen`, la rama "sin datos nuevos") ya eran
seguros — verificado leyendo el código: `systemPromptRegen` usa `allMessages` (sin `call1.content`)
y la rama "sin datos nuevos" solo se alcanza cuando el delta está vacío (`seed` y `scenario`
serían el mismo estado, sin margen para divergir).

### Tests

`buildScenarioContext` es puro y no se puede hacer mentir por sí solo — los tests fijan (a) el
invariante estructural (`nueva_capacidad` siempre = sobrante+recorte DE LA MISMA llamada) y (b)
la secuencia real de 5 turnos completa, confirmando que CADA llamada, tomada sola, nunca mezcla
estados. La otra mitad del fix (que la prosa de LLAMADA 1 no sobreviva) es específica de
`route.ts`, que no se puede ejecutar en este entorno (depende del runtime de Next.js) — se cubre
con un test ESTÁTICO, mismo patrón que el resto de `route.static.test.ts`.

---

## 2a · Jerga interna filtrándose

### Causas concretas encontradas (no solo prompt-level)

1. `scenario.ts` — el título de una meta derivada de un crédito, sin objeto reconocible
   ("carro"/"casa"), caía en el literal `"compra financiada"` — esa cadena viajaba tal cual hasta
   `summarizeScenario` y de ahí al prompt como "el nombre de la meta". El modelo la citaba
   literal: "Tu meta activa es una compra financiada".
2. `scenario.ts`, `summarizeScenario` — la línea de estado interno usaba literalmente
   `"meta activa (única)"` / `"meta CERRADA (única)"` como etiqueta.
3. `scenario.ts`, `notaRetornoMeta` — el fallback sin título usaba `"la meta activa"`.
4. `orchestrator.ts`, `render()` — las etiquetas snake_case (`nueva_capacidad`,
   `gastos_no_vitales`…) se muestran tal cual en el bloque "TU REALIDAD"; el modelo a veces las
   copiaba literal en vez de traducirlas.
5. `consigliere.ts` — "Dominio Financiero" estaba en TERMINOLOGÍA OBLIGATORIA (instruyendo al
   modelo a USARLO activamente) — contradice directamente la prohibición.

### Fix

- `scenario.ts`: sin objeto reconocido, `meta.titulo` queda **sin valor** (antes: `"compra
  financiada"`) — el monto/plazo siguen disponibles; el modelo nombra la meta con su propia voz.
- `notaRetornoMeta`: fallback cambiado de `"la meta activa"` a `"tu meta"`.
- `summarizeScenario`: la etiqueta cambia de `"meta activa/CERRADA (única)"` a
  `"meta (estado: en curso/cerrada, única)"` — mismo propósito informativo, sin la frase prohibida.
- `consigliere.ts`: se retira "Dominio Financiero" de TERMINOLOGÍA OBLIGATORIA y se añade un
  bloque nuevo, JERGA INTERNA — PROHIBIDA EN LA SALIDA, con la lista exacta del encargo ("meta
  activa", "compra financiada", "dominio financiero", "nueva capacidad", "carril", "extracción",
  "agregado", "delta") más una regla GENERAL: nunca copiar literal una etiqueta snake_case del
  bloque de datos — traducirla siempre a lenguaje natural ("lo que te quedaría", "lo del carro").
  Se corrigieron además 3 menciones residuales de "meta activa"/"nueva capacidad" DENTRO del
  propio prompt (instrucciones internas que usaban la frase prohibida al describírsela al modelo).
- **No tocado, deliberadamente**: `validator-rules.ts` (`BRANDING_REWRITES`) sigue reescribiendo
  "soberanía financiera" → "Dominio Financiero" — es una red de seguridad DISTINTA y no relacionada
  (REGLAS ABSOLUTAS #6, CLAUDE.md: la palabra "soberanía" está absolutamente prohibida; "Dominio
  Financiero" es el sustituto de marca para ESE caso, no jerga conversacional). `reporte.ts`
  tampoco se tocó — es un prompt distinto para un documento distinto (no la conversación medida).

---

## 2b · Repetición de estructura propia

`esRespuestaRepetida` (existente) compara TEXTO CRUDO con Levenshtein, umbral 90% — con cifras
distintas cada vez, el texto cae bajo el umbral aunque la construcción sea idéntica.

**Fix — `esEstructuraRepetida` (nueva, `scenario.ts`)**: normaliza dígitos a un placeholder y
compara, PALABRA A PALABRA (no carácter a carácter), solo las primeras 8 palabras. Comparación por
palabra en vez de por carácter porque un ítem con nombre más largo/corto ("ocio" vs "transporte")
desplaza el resto de la frase y hunde una comparación por ventana de caracteres aunque la
construcción sea idéntica — verificado empíricamente: la primera versión (Levenshtein sobre los
primeros 60 caracteres) fallaba el caso real por esta razón exacta, antes de cambiar a comparación
posicional por palabra.

`route.ts`: se añade junto a `esRespuestaRepetida` en el mismo bloque de reintento (FIX C) — si
CUALQUIERA de las dos dispara, se regenera UNA vez, con la instrucción adecuada a cada causa
(repetir texto vs. repetir estructura).

---

## 2c · Pregunta de aclaración sin contexto

Mientras `gastos_conflict`/`gastos_assumed` sigue abierto en turnos POSTERIORES al que lo creó,
`discrepancia.suma` (la única señal que autorizaba esos valores para el guardarraíl) ya no existe
— es del delta de ESE turno, no del conflicto persistido. El modelo redacta su propia pregunta de
aclaración citando agregado/detalle (`notaConflictoGastos` se los da), pero el grounding, al no
reconocerlos como autorizados, **elimina la frase entera que los cita** — dejando publicada solo
la pregunta desnuda.

**Fix — `route.ts`**: `scenario.gastos_conflict.agregado`/`.detalle` y `scenario.gastos_assumed.valor`
se añaden a `valoresExtra` siempre que estén presentes, igual que ya hacía `discrepancia.suma`
para el primer turno.

---

## 3 · Tests — resultado real

| Test | Resultado |
|---|---|
| Estructural: `nueva_capacidad` siempre = sobrante+recorte de la MISMA llamada | ✅ |
| G1b: secuencia real de 5 turnos (T1-T4), ninguna llamada mezcla estados, T4 = 325 nunca 375 | ✅ |
| Estático: `call1.content` no sobrevive a `messages2` | ✅ |
| Estático: `gastos_conflict`/`gastos_assumed` autorizados en `valoresExtra` | ✅ |
| Estático: `esEstructuraRepetida` cableada en el reintento | ✅ |
| `esEstructuraRepetida`: misma apertura, cifras distintas → true (texto crudo no lo cazaría) | ✅ |
| `esEstructuraRepetida`: aperturas distintas → false | ✅ |
| BUG 3 actualizado (V11): sin objeto → sin título de relleno, nunca "compra financiada" | ✅ |
| `notaRetornoMeta` actualizado (V11): ya no dice "la meta activa" | ✅ |

### Tests pre-existentes actualizados — por qué no es debilitación (V11)

Dos tests codificaban el comportamiento ahora corregido como esperado — mismo criterio que en
tandas anteriores (M10 sensor, crédito fantasma): mantenerlos habría exigido reescribir código
correcto para que un test obsoleto siguiera en verde.

| Test | Antes | Ahora |
|---|---|---|
| BUG 3 (título genérico) | `assert.equal(s.meta?.titulo, "compra financiada")` | `assert.equal(s.meta?.titulo, undefined)` |
| PIEZA 7 (nota de reconducción) | `/3 turnos fuera de la meta activa 'Carro'/` | `/3 turnos fuera de 'Carro'/` |

---

## 4 · Regresión obligatoria — resultado real

| Verificación | Resultado |
|---|---|
| Los 7 fraseos de la reconciliación aritmética | ✅ intactos, `scenario.test.ts` |
| Los 4 casos de M10 sensor (A/B/C/D) | ✅ `commandments.test.ts` 36/36, archivo no tocado |
| G1c bidireccional | ✅ intacto |
| Las 15 partidas de testdev7 | ✅ intacto |
| Memoria entre sesiones (`splitScenarioState`/`mergeEstadoPersistido`, CAMPOS_HECHOS) | ✅ intacto, sin cambios en esos campos/funciones |
| Suite completa `test:calculator` | ✅ 0 fallos (orchestrator 33→35, scenario 232→235) |
| Suite completa `test:guardrail` | ✅ 0 fallos, 8 suites |
| `npm test` | ✅ 0 fallos |
| `test:regression` | ✅ **84/84** turnos · 47 escenarios · enforcement=full |

---

## 5 · Declaración de impacto

`git diff --stat` (contra `origin/develop`, `8fe8268`):

```
 src/app/api/chat/route.static.test.ts   | 34 +++++++++++++
 src/app/api/chat/route.ts               | 54 ++++++++++++++++++---
 src/lib/calculator/orchestrator.test.ts | 84 ++++++++++++++++++++++++++++++++-
 src/lib/calculator/scenario.test.ts     | 34 +++++++++++--
 src/lib/calculator/scenario.ts          | 61 ++++++++++++++++++++++--
 src/lib/prompts/consigliere.ts          | 13 +++--
 6 files changed, 262 insertions(+), 18 deletions(-)
```

| Archivo/símbolo | Cambio | Motivo |
|---|---|---|
| `route.ts`, `messages2` | `content: call1.content` → `content: ''` | BLOQUEANTE G1b — el borrador pre-merge de LLAMADA 1 no debe sobrevivir |
| `route.ts`, `valoresExtra` | añade `gastos_conflict.{agregado,detalle}` / `gastos_assumed.valor` | MAYOR 2c — pregunta de aclaración sin contexto |
| `route.ts`, bloque FIX C | añade `repiteEstructura`/`esEstructuraRepetida` junto a `esRespuestaRepetida` | MAYOR 2b |
| `scenario.ts`, `esEstructuraRepetida` (nueva) | añadida | MAYOR 2b |
| `scenario.ts`, meta derivada de crédito | `titulo` sin valor en vez de `"compra financiada"` | MAYOR 2a |
| `scenario.ts`, `notaRetornoMeta` | fallback `"tu meta"` en vez de `"la meta activa"` | MAYOR 2a |
| `scenario.ts`, `summarizeScenario` | etiqueta sin la frase "meta activa/CERRADA" | MAYOR 2a |
| `consigliere.ts` | nuevo bloque JERGA INTERNA — PROHIBIDA EN LA SALIDA; retira "Dominio Financiero" de TERMINOLOGÍA OBLIGATORIA; 3 menciones internas reformuladas | MAYOR 2a |

### Tests — 2 actualizados con justificación explícita (V11), el resto nuevo

Ver §3. Ningún assert existente se debilitó sin documentar por qué; ambos casos codificaban el
defecto que este encargo manda corregir.

---

## 6 · Validación

| Comando | Resultado |
|---|---|
| `npx tsc --noEmit` | limpio |
| `npm run build` | TypeScript compila limpio; falla después en el prerender de `/register` (esta vez, antes fue `/login` — mismo motivo: falta de credenciales de Supabase, entorno, no código) |
| `npm test` | 0 fallos |
| `npm run test:guardrail` | 0 fallos, 8 suites (commandments 36/36 — M10 no tocado) |
| `npm run test:calculator` | 0 fallos (operations 15, orchestrator 35, expenses 24, scenario 235, tools 17) |
| `npm run test:regression` | **84/84** turnos · 47 escenarios · enforcement=full |
| `npm run test:e2e` / `npm run smoke:db` | sin credenciales — no verificable en este entorno |
