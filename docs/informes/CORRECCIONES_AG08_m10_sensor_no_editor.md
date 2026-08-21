# Corrección AG08 — Mandamiento 10 pasa de editor a sensor (V18)

**Fecha:** 18 de agosto de 2026
**Rama:** `agent/08`, sobre `origin/agent/08` (`8d6adad`)
**Motivado por:** diagnóstico ejecutado con el pipeline completo (`applyEnforcement`),
casos A-D reproducidos abajo
**Contrato:** `docs/CONTRATO_TRUTH_ENGINE.md` §9 (V17/V18) · §15

---

## 0 · Resumen

La tanda anterior (`8d6adad`) dejó M10 sin volver al RAW (V17) pero seguía **editando** el texto
ya validado: insertaba la cifra pedida en sitio de una anáfora, o eliminaba la frase sin
respaldo. Con el grounding ya corregido (V15 + anclaje específico, tanda de la regla estructural
del agregado), esa edición ya no tenía casi ningún caso legítimo al que aplicarse — y cuando SÍ
encontraba una frase con demostrativo+verbo, la mitad de las veces no era una anáfora rota sino
prosa legítima del modelo. Diagnóstico con el pipeline completo, `conceptos = {sobrante: 250,
gastos: 2250}`:

| # | RAW | Comportamiento anterior (editor) | Diagnóstico |
|---|---|---|---|
| A | `"Te quedan 250 €. Ese es tu punto de partida, y es más de lo que crees."` | la segunda frase (prosa cálida) **se borraba** | falso positivo — el 250 ya estaba en la primera frase, nada que reparar |
| B | `"Esta es una buena pregunta. Tus gastos son 2250 €."` | `"250 € es una buena pregunta. Tus gastos son 2250 €."` | **disparate publicado** — "Esta" no era una anáfora rota |
| C | `"Te quedan 250 € al mes para tu meta."` | intacta, 0 mutaciones | control — confirma que el grounding YA NO borra cifras verificadas |
| D | `"Esa es tu capacidad real para destinar a ahorro o pago de deudas."` | reinserción correcta (`"250 € es tu capacidad real..."`) | el único caso donde la edición acertaba — y el reintento de `route.ts` ya lo cubre igual |

**Conclusión:** la premisa de "M10 repara la frase" ya no se sostiene, y sus falsos positivos (A,
B) son peores que el problema que resolvía (D, ya cubierto por el reintento de `route.ts`).

---

## 1 · V18 (nuevo invariante) — ningún mandamiento edita prosa

Los mandamientos corrigen cifras/estructura con evidencia del registro de mutaciones, o
**detectan y delegan** al reintento (`route.ts`, que sí puede pedir al modelo que reescriba — el
modelo redacta, nunca esta capa). Insertar, borrar o reescribir frases del modelo está prohibido
en `enforceCommandments`.

### El fix — M10 pasa de editor a sensor

`repararAnaforasSinAntecedente` (editaba) se sustituye por `detectarAnaforaSinAntecedente`
(`src/lib/guardrail/commandments.ts`), que **nunca toca `text`**. Devuelve
`{detectada, fraseAfectada?, conceptoEsperado?, cifraEsperada?}`.

**Condición de detección — las TRES a la vez** (mata los falsos positivos A/B sin perder el caso D):

1. **(a)** el usuario preguntó por un concepto identificable que existe en `conceptos`
   (`cifraPedidaAusente`, `guardrail/context.ts` — función pura, compartida con `route.ts`).
2. **(b)** la respuesta final NO contiene esa cifra.
3. **(c)** el registro de `mutations` muestra que **alguna capa anterior — nunca un mandamiento de
   este propio módulo** — eliminó contenido este turno: una mutación con `capa` que NO empieza por
   `"commandment"` y cuyo `despues` es más corto que su `antes` (`huboEliminacionDeOtraCapa`).

Sin (c), nadie borró nada: la respuesta es tal cual la quiso el modelo (los casos A y B) —
"arreglarla" es exactamente el error que esta corrección elimina.

Cuando las tres se cumplen: `enforceCommandments` registra la violación con
`accion: "logueado"` (nunca `"corregido"` — el texto no cambia) y dos capas separadas quedan
disponibles para telemetría/depuración (`conceptoEsperado`, `cifraEsperada`, `fraseAfectada`,
esta última solo informativa — identifica qué frase PARECE la anáfora, vía el mismo regex
demostrativo+verbo de la tanda anterior, ahora sin poder de decisión ni de edición).

### Código de edición eliminado por completo

- La rama de sustitución de la anáfora por la cifra (`seg.text.replace(...)`).
- La rama de eliminación de la frase sin respaldo.
- `esNum` (formateo del número insertado) — sin inserción, sin uso.
- El bucle `for (const seg of segmentSentences(text))` que reconstruía `partes.join("")`.

### Cableado verificado — `route.ts` es la única vía de corrección real

`route.ts:815` calcula `cifraPedidaAusente(cleanMessage, finalContent, verified.conceptos)` de
forma **totalmente independiente** de M10 — ya lo hacía antes de esta tanda (compartían la misma
función pura, pero cada uno la invocaba por su cuenta). El cambio en M10 no rompe ese cableado:
al no editar nada, `finalContent` llega a `route.ts` exactamente como lo dejó el resto del
pipeline, y el reintento acotado (regenera vía LLM con la instrucción de incluir la cifra
exacta) sigue disparando en las mismas condiciones que antes. Verificado leyendo el código
(`route.ts:804-839`) y confirmando que ninguna variable que consume depende de la rama de edición
que se eliminó.

---

## 2 · Los 6 tests requeridos — resultado real

Todos con `applyEnforcement` (pipeline completo) salvo donde se indica que se fabrica
`mutations` a propósito para aislar la condición (c) — declarado explícitamente en cada test.

| # | Test | Resultado |
|---|---|---|
| 1 | A — prosa cálida sin evidencia de eliminación | ✅ `r.texto === raw` (intacta), 0 violaciones de M10 |
| 2 | B — pregunta transicional sin evidencia de eliminación | ✅ `r.texto === raw` (intacta), nunca el disparate "250 € es una buena pregunta" |
| 3 | C — respuesta completa, sin mutaciones | ✅ intacta, `mutations = []`, `violaciones = []` |
| 4 | D CON mutación previa de eliminación (`enforceCommandments` directo, `ctx.mutations` fabricado) | ✅ detecta, `accion: "logueado"`, `cifraPedidaAusente(...).ausente === true`, **`r.texto === textoD` byte a byte** |
| 5 | D SIN mutación previa (`applyEnforcement`, pipeline real) | ✅ M10 no dispara — `violaciones` sin mandamiento 10 |
| 6 | Fixture canónica repuesta (V11) — frase exacta del QA testdev8, ahora como test del SENSOR | ✅ pasa (mismo test que el #4, mismo fixture literal que motivó M10) |

Más cobertura de detección (informativa, no obligatoria pero mantiene la profundidad de la tanda
anterior): 5 variantes ES/PT de demostrativo+verbo y la forma PT con verbo acentuado ("é") —
las 6 se **detectan** (violación logueada) sin editar una sola de ellas, con `mutations`
fabricadas para aislar la condición (c).

---

## 3 · Regresión — confirmado intacto

| Área | Resultado |
|---|---|
| M1 — regla estructural del agregado (10 fraseos, `scenario.test.ts`) | ✅ sin tocar, todos pasan |
| Mandamiento 3 (concepto sin cálculo) con el pipeline completo | ✅ sigue bloqueando el déficit fantasma |
| Mandamiento 9 (plan fantasma) | ✅ `plan-fantasma.test.ts`, 24/24 |
| G1c (reconciliación cross-turno bidireccional) | ✅ cubierto en `scenario.test.ts`, sin cambios en `reconciliarGastos` |
| `"gasto 2 500 €"` → 2500 | ✅ cubierto en `scenario.test.ts` |
| 15 partidas de testdev7 | ✅ cubierto en `scenario.test.ts` |

Ningún archivo de `scenario.ts`/`orchestrator.ts`/`tools.ts` se tocó en esta tanda — el diff
completo vive en `commandments.ts` (el mandamiento en sí), `commandments.test.ts` (sus tests) y
un comentario en `route.ts` (documentación, sin cambio de lógica).

---

## 4 · Declaración de impacto — funciones tocadas y por qué

`git diff --stat` (contra `origin/agent/08` previo, `8d6adad`):

```
 src/app/api/chat/route.ts              |  15 ++-
 src/lib/guardrail/commandments.test.ts | 231 ++++++++++++++++++++-------------
 src/lib/guardrail/commandments.ts      | 198 ++++++++++++++--------------
 3 files changed, 252 insertions(+), 192 deletions(-)
```

| Función/símbolo | Archivo | Cambio | Motivo |
|---|---|---|---|
| `repararAnaforasSinAntecedente` | `commandments.ts` | **eliminada** | editaba prosa — prohibido por V18 |
| `esNum` | `commandments.ts` | **eliminada** | solo la usaba la rama de inserción, ahora inexistente |
| `detectarAnaforaSinAntecedente` (nueva) | `commandments.ts` | añadida | sensor puro, nunca edita `text` |
| `huboEliminacionDeOtraCapa` (nueva) | `commandments.ts` | añadida | condición (c) — evidencia de eliminación por otra capa |
| `ANAFORA_SIN_ANTECEDENTE_RE` / `fraseConAnaforaSinAntecedente` | `commandments.ts` | se conservan, uso reducido a informativo (`fraseAfectada`) | ya no deciden si M10 dispara ni editan nada |
| llamada a M10 dentro de `enforceCommandments` | `commandments.ts` | reemplazada: registra `accion: "logueado"`, nunca reasigna `out` | V18 |
| comentarios de `CommandmentContext.raw`/`.userMessage` | `commandments.ts` | actualizados | ya no describen una capa que revierte/edita |
| comentario del bloque "CIFRA PEDIDA AUSENTE" | `route.ts` | actualizado (sin cambio de lógica) | reflejar que M10 detecta, no repara |

### Tests modificados — ninguno debilitado (V11)

Los tests que existían para la rama de EDICIÓN (`OBLIGATORIO 2`, `OBLIGATORIO 3`, las 2 pruebas
"CANÓNICO — variantes" y "CANÓNICO — forma PT") **no podían seguir pasando tal cual**: afirmaban
que M10 insertaba o borraba texto, comportamiento que este mismo encargo ordena eliminar por
diseño ("3. ELIMINA la rama de inserción de cifra y la rama de borrado de frase de M10. El
código de edición se va entero."). Mantenerlos habría significado reescribir código correcto
para que un test obsoleto siguiera en verde — la violación inversa de V11. Se **reponen** con el
mismo espíritu (misma cobertura de fraseos, mismos fixtures donde aplica, incluida la frase
canónica exacta) verificando el comportamiento que el sensor SÍ debe tener: detecta + señala,
nunca edita. El test `OBLIGATORIO 1` (déficit fantasma) y `OBLIGATORIO 4` (regresión M3) no
dependían de la edición de M10 — se conservan sin cambios de fondo. Ningún test de otro archivo
(`scenario.test.ts`, `tools.test.ts`, `orchestrator.test.ts`, etc.) fue tocado.

---

## 5 · Validación

| Comando | Resultado |
|---|---|
| `npx tsc --noEmit` | limpio |
| `npm run build` | TypeScript compila limpio; falla después en el prerender de `/login` por falta de credenciales de Supabase — entorno, no código (idéntico en ramas anteriores sin tocar) |
| `npm test` | 0 fallos |
| `npm run test:guardrail` | 0 fallos (commandments: 33 → 36) |
| `npm run test:calculator` | 0 fallos (sin cambios: scenario 198, tools 17) |
| `npm run test:regression` | 84/84 turnos · 47 escenarios · enforcement=full |
| `npm run test:e2e` / `npm run smoke:db` | sin credenciales — no verificable en este entorno (igual que en todas las tandas anteriores) |
