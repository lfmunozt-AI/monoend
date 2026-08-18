# Corrección AG08 — la estructura es el ancla, sin requerir keyword de gasto

**Fecha:** 18 de agosto de 2026
**Rama:** `agent/08`, sobre `origin/develop` (`b166b22`)
**Motivado por:** medición ejecutada con el pipeline real (`extractScenarioDelta`), 7 fraseos
fallando (5 marcados `COMPLETE` con el doble del gasto real)
**Rondas previas relevantes:** `REVISION_AG01_qa_testdev8_ronda4.md` (P1: "la regla estructural
sustituyó la enumeración de *conectores* pero conservó una enumeración de *keywords* como
ancla")
**Contrato:** `docs/CONTRATO_TRUTH_ENGINE.md` §5.2/§9(E9)/§13/§15

---

## 0 · Resumen

La tanda de la regla estructural del agregado (`detectarAgregadoEstructural`, `scenario.ts`)
eliminó la enumeración de *conectores* entre la keyword de gasto y la cifra, pero conservó
`GASTO_CTX.exec(n)` como ANCLA OBLIGATORIA: sin una palabra de la lista cerrada (`gasto`,
`gastos`, `gastando`... — nunca completa), la función devolvía `null` sin más y el mensaje caía
al parser de listas, duplicando el gasto real exactamente como antes de esa tanda. El punto único
de fallo no desapareció: subió un nivel, de "conector" a "keyword".

Medición real, 7 fraseos con la misma estructura (`cifra + ':' + lista de ≥2 partidas`):

| Fraseo | Antes de esta tanda |
|---|---|
| `"gastando 1200 al mes: internet 300, agua 400, gas 500"` | ❌ 2400 `COMPLETE` |
| `"mis desembolsos son 1200: …"` | ❌ 2100 |
| `"mis salidas mensuales 1200: …"` | ❌ 2400 `COMPLETE` |
| `"pago 1200 en total: …"` | ❌ 2400 `COMPLETE` |
| `"se me van 1200: …"` | ❌ 2400 `COMPLETE` |
| `"presupuesto mensual 1200: …"` | ❌ 2400 `COMPLETE` |
| `"mis gastos fueron 1200: …"` | ✅ 1200 (única con keyword reconocida) |

---

## 1 · El fix — eliminar el ancla léxica, no ampliarla

`detectarAgregadoEstructural` (`scenario.ts`) deja de exigir `GASTO_CTX.exec(n)`. La estructura
por sí sola es evidencia suficiente: **una cifra seguida de `:` y una lista real de ≥2 partidas
con importe propio ES el agregado de esa lista**, con o sin verbo de gasto reconocido. Ninguna
otra construcción del idioma tiene esa forma exacta. `GASTO_CTX` no desaparece del archivo (sigue
usándose en la rama de "gasto declarado simple" del parser de listas, sin cambios), pero deja de
ser un requisito para esta función.

### El bug que apareció al quitar el ancla — y su fix

Sin la keyword como punto de anclaje, la búsqueda de "la cifra antes del `:`" necesitaba una
frontera propia para no cruzar hacia una cláusula anterior no relacionada
(`"Mi ingreso es 3000. Gastos: internet 300, agua 400."` jamás debe leer 3000 como agregado de
gastos). El primer intento usó `segmentSentences` (el segmentador numeric-safe del guardarraíl,
que ya evita cortar "1.200" en dos) — y **rompió una batería real**:
`test:regression`, escenario `deficit_detalle_manda`:

```
"vitales: alquiler 2000, seguro 1000, comida 2000. no vitales: ocio 3000, ropa 1000, gimnasio 2000"
```

`segmentSentences` exige una MAYÚSCULA tras el punto para reconocer un límite de frase; el texto
real usa minúscula ("no vitales"), así que las dos mitades se leían como una sola frase, y el
"2000" de "comida" (el último ítem de la PRIMERA lista) se colaba como si fuera el agregado
declarado de "no vitales:" — duplicando exactamente el defecto que esta regla existe para cerrar,
solo que ahora entre dos listas del mismo mensaje en vez de entre keyword y cifra.

**Fix — `ultimoLimiteDeClausula` (nueva función, `scenario.ts`):** un límite de cláusula más
simple y deliberadamente SIN exigir mayúscula: cualquier `.`, `!` o `?` que no esté entre dígitos
(el mismo criterio numeric-safe, sin la condición de capitalización) cierra la cláusula anterior.
Con este límite, ninguna de las dos listas del ejemplo anterior ve la cifra de la otra — ninguna
tiene una cifra propia que declarar, así que ninguna produce un agregado, y las 6 partidas se
extraen igual como puro detalle (comportamiento correcto).

---

## 2 · Los 12 fraseos — resultado real (pegado íntegro)

```
✅ [1200] esperado 1200 — extraction_status=COMPLETE items=3 — "gastando 1200 al mes: internet 300, agua 400, gas 500"
✅ [1200] esperado 1200 — extraction_status=COMPLETE items=3 — "mis desembolsos son 1200: internet 300, agua 400, gas 500"
✅ [1200] esperado 1200 — extraction_status=COMPLETE items=3 — "mis salidas mensuales 1200: internet 300, agua 400, gas 500"
✅ [1200] esperado 1200 — extraction_status=COMPLETE items=3 — "pago 1200 en total: internet 300, agua 400, gas 500"
✅ [1200] esperado 1200 — extraction_status=COMPLETE items=3 — "se me van 1200: internet 300, agua 400, gas 500"
✅ [1200] esperado 1200 — extraction_status=COMPLETE items=3 — "presupuesto mensual 1200: internet 300, agua 400, gas 500"
✅ [1200] esperado 1200 — extraction_status=COMPLETE items=3 — "mis gastos fueron 1200: internet 300, agua 400, gas 500"
✅ [1200] esperado 1200 — extraction_status=COMPLETE items=3 — "1200: internet 300, agua 400, gas 500"
✅ [1300] esperado 1300 — extraction_status=COMPLETE items=3 — "estoy gastando 1300 mensuales: renta 700, comida 400, transporte 200"
✅ [1600] esperado 1600 — extraction_status=COMPLETE items=3 — "he acabado gastando 1600 este mes: hipoteca 900, super 450, gasolina 250"
✅ [1600] esperado 1600 — extraction_status=COMPLETE items=3 — "gastándome 1600 al mes: hipoteca 900, super 450, gasolina 250"
✅ [1600] esperado 1600 — extraction_status=COMPLETE items=3 — "mis egresos son 1600: hipoteca 900, super 450, gasolina 250"

12/12 OK
```

Los primeros 7 son los fraseos del diagnóstico de esta tanda (5 antes rotos, 2 ya correctos). Los
5 siguientes son nuevos, incluida `"1200: internet 300, agua 400, gas 500"` — **sin ninguna
palabra de gasto en absoluto** — que confirma que la estructura basta por sí sola.

---

## 3 · Regresión — resultado real

| Verificación | Resultado |
|---|---|
| `"gasto 2 500 €"` → 2500 | ✅ (sin `:`, no pasa por esta regla) |
| 15 partidas de testdev7 → 15 ítems, suma 2250 | ✅ sin `:` en el mensaje, no afectado |
| Lista SIN cifra previa (`"internet 300, agua 400"`) → solo detalle | ✅ `gastos_mensuales: undefined`, 2 ítems |
| Dos listas seguidas (`deficit_detalle_manda`, el caso que rompió la primera versión) | ✅ sin agregado inventado, 6 ítems, suma 11000 |
| G1c bidireccional (agregado→detalle y detalle→agregado) | ✅ mismo conflicto `[2200, 2250]` en ambos sentidos |
| Los 4 casos de M10 (A/B/C/D — sensor, no editor) | ✅ intactos, `commandments.test.ts` 36/36 |
| Suite completa `test:calculator` / `test:guardrail` | ✅ 0 fallos (scenario 198 → 215) |
| `test:regression` | ✅ **84/84** (antes de este fix: 83/84 — `deficit_detalle_manda` fallaba con el primer intento vía `segmentSentences`) |

---

## 4 · Declaración de impacto — funciones tocadas y por qué

`git diff --stat` (contra `origin/develop`, `b166b22`):

```
 src/lib/calculator/scenario.test.ts | 84 +++++++++++++++++++++++++++++++++++++
 src/lib/calculator/scenario.ts      | 73 +++++++++++++++++++++++++++-----
 2 files changed, 146 insertions(+), 11 deletions(-)
```

| Función | Cambio | Motivo |
|---|---|---|
| `detectarAgregadoEstructural` | ya no exige `GASTO_CTX.exec(n)`; itera TODOS los `:` del mensaje sin anclarse a una keyword | P1 — la estructura es evidencia suficiente |
| `ultimoLimiteDeClausula` (nueva) | añadida | acota la búsqueda de la cifra a la cláusula que contiene el `:`, sin exigir mayúscula tras el punto (a diferencia de `segmentSentences`) |
| import de `segmentSentences` | añadido y luego **retirado** (se probó, rompió `test:regression`, se sustituyó por `ultimoLimiteDeClausula`) | ver §1 |

### Tests — ninguno modificado, todos nuevos (V11)

No se tocó ni un assert existente. Se añadieron 17 tests a `scenario.test.ts`: 12 parametrizados
(los fraseos de la tabla) + 5 de regresión explícita (dos-listas-seguidas, `gasto 2 500 €`, lista
sin cifra previa, testdev7, G1c bidireccional). El regression harness (`tests/scenarios/*.json`)
tampoco se tocó — el fixture `deficit_detalle_manda.json` ya declaraba el comportamiento correcto
esperado (`missing: ["gastos"]`); lo que estaba mal era el código, no el test, que detectó el
defecto exactamente como debía.

---

## 5 · Validación

| Comando | Resultado |
|---|---|
| `npx tsc --noEmit` | limpio |
| `npx eslint` (archivos tocados) | 0 problemas |
| `npm run build` | TypeScript compila limpio; falla después en el prerender de `/login` por falta de credenciales de Supabase — entorno, no código (confirmado idéntico en tandas anteriores vía `git stash`) |
| `npm test` | 0 fallos |
| `npm run test:guardrail` | 0 fallos (commandments 36, sin cambios — M10 no se tocó) |
| `npm run test:calculator` | 0 fallos (scenario 198 → 215) |
| `npm run test:regression` | **84/84** turnos · 47 escenarios · enforcement=full |
| `npm run test:e2e` / `npm run smoke:db` | sin credenciales — no verificable en este entorno (igual que en todas las tandas anteriores) |
