# Corrección AG08 — cierre de G1d: tolerancia año↔mes solo con marca anual explícita

**Fecha:** 22 de agosto de 2026
**Rama:** `agent/08`, rebaseada sobre `origin/develop` (`f4a1414` — incluye la tanda 7 recuperada,
PR #66)
**Motivado por:** reserva de AG01 sobre la tanda anterior (G1d, fidelidad de extracción).
**Contrato:** `docs/CONTRATO_TRUTH_ENGINE.md` §9.1 V13/V14

---

## 0 · Recuperación de la tanda 7 y rebase

Antes de esta tanda: verificación obligatoria (`git log --oneline origin/agent/08 --not
origin/develop`) mostró `92e91b8` (el G1d de la tanda anterior) como único commit sin mergear —
`475bf8e` (tanda 7, "snapshot único para derivadas") ya NO aparecía en ninguna rama, tras haberlo
reemplazado con `--force-with-lease` al cierre de esa tanda. Recuperado: el objeto seguía intacto
(`git cat-file -t 475bf8e` → `commit`), se publicó `recuperacion/tanda7` apuntando a ese commit, y
Luis lo mergeó a `develop` (PR #66) antes de continuar. `git fetch && git rebase origin/develop`
sobre el G1d de esta rama produjo UN conflicto (`route.static.test.ts`, ambas tandas añadían tests
al final del archivo) — resuelto conservando los DOS bloques de tests (tanda 7: G1b/tono; tanda 8:
G1d), sin descartar ni debilitar ninguno. Confirmado tras el rebase: 13 tests en
`route.static.test.ts` (todos los de ambas tandas), suite completa en verde.

---

## 1 · La reserva de AG01 — verificada, no asumida

Reproducido con el pipeline real ANTES de tocar código:

```
"renta 1000, comida 200, luz 100" con 2 de 3 partidas capturadas (agregado=1200)
→ extraction_status = COMPLETE, numerosHuerfanos = []   ❌ (debía ser PARTIAL con [100])
```

Causa exacta: el fix de multiset de la tanda anterior (`huerfanosPorMultiset`) cierra la puerta de
"pertenencia de valor" (una partida capturada cubriendo cualquier otra del mismo importe), pero
deja abierta OTRA puerta trasera equivalente por la vía de la tolerancia ÷12/×12: el candidato
huérfano "100" (luz, perdida) se comparaba contra el AGREGADO asignado (1200, la suma de las 2
partidas SÍ capturadas) con `Math.abs(1200 - 100*12) = 0 <= 1` → coincidencia. El agregado no tiene
NINGUNA relación real con la partida perdida — es aritmética coincidente (1200 = 100×12), no una
conversión año↔mes legítima.

---

## 2 · Fix — la marca ANUAL como condición, no la aritmética sola

`tieneMarcaAnual(text, m)` (nueva) — ¿el número trae "al año"/"anual"/"por año"/"yearly"/"per
year" pegado en el propio texto (15 caracteres antes o después)? `numerosCandidatosConMarca`
(nueva) — como `numerosCandidatos`, pero conserva esa marca por candidato.
`huerfanosPorMultiset` ahora exige `candidato.anual === true` para intentar la rama ÷12/×12 en la
pasada de tolerancia; el redondeo ±1 sigue aplicando siempre, sin condición.

`numerosCandidatos` (la función pública, usada por `route.ts` para `importesEnMensaje`/
`valoresExtra`) no cambia — sigue devolviendo `number[]`; la marca solo vive en la ruta interna de
`detectarNumerosHuerfanos`, que es la única que la necesita.

---

## 3 · Tests — resultado real (pegado íntegro)

```
AG01 caso 1 (debe ser PARTIAL, huerfano 100): {"extraction_status":"PARTIAL","huerfanos":{"extraccionIncompleta":true,"numerosHuerfanos":[100],"numerosNoRelevantes":[]},"discrepancia":{"discrepancia":false},"itemSospechoso":null,"camposInvalidos":[]}
AG01 control (debe ser PARTIAL): {"extraction_status":"PARTIAL","huerfanos":{"extraccionIncompleta":true,"numerosHuerfanos":[150],"numerosNoRelevantes":[]},"discrepancia":{"discrepancia":false},"itemSospechoso":null,"camposInvalidos":[]}
anual (debe seguir COMPLETE, sin huerfanos): {"extraction_status":"COMPLETE","huerfanos":{"extraccionIncompleta":false,"numerosHuerfanos":[],"numerosNoRelevantes":[]},"discrepancia":{"discrepancia":false},"itemSospechoso":null,"camposInvalidos":[]}
```

```
CASO 17 PARTIDAS: status=COMPLETE items=17 suma=2205

--- Criterio B ---
OK status=COMPLETE — "gano 2300, tengo 43 años y 2 hijos, gasto 2200"
OK status=COMPLETE — "quiero una casa de 150000 a 30 años"
OK status=COMPLETE — "gano 2500 y gasto 1800"
OK status=COMPLETE — "mis gastos fueron 1200: internet 300, agua 400, gas 500"
OK status=COMPLETE — "quiero un carro de 30000 a 48 meses con TAE 9"
OK status=COMPLETE — "trabajo 8 horas al día, gano 2800 y gasto 2100"
OK status=COMPLETE — "mi meta es ahorrar 20000 en 24 meses, gano 3000 y gasto 2200"
OK status=COMPLETE — "gano 4000 y gasto 3200 hace 5 años que vivo así"
```

4 tests nuevos y permanentes en `scenario.test.ts`: los dos casos de AG01 (fallo + control), el
mensaje anual con delta simulado, y un quinto (mismo importe SIN "al año") que confirma que la
marca es una condición real, no un adorno — sin ella, 27600 no se cubre con 2300.

**Verificación explícita de "capacidad mezclada"** (el bug de la tanda 7, ya recuperada): la
secuencia real T1 (gastos 2200, ocio 100) → T2 (corrige ocio a 150, dispara conflicto) → T3
(pregunta durante el conflicto) → T4 (resuelve) sigue cubierta por
`"G1b: secuencia real..."` en `orchestrator.test.ts` (recuperada con la tanda 7, sin tocar en esta
tanda) — verificada en verde tras el rebase: ninguna llamada mezcla sobrante viejo con ocio nuevo,
T4 da 325 €, nunca 375 €.

---

## 4 · Regresión obligatoria — resultado real

| Verificación | Resultado |
|---|---|
| Los 2 casos de AG01 (fallo → PARTIAL, control → PARTIAL) | ✅ |
| `'gano 27600 al año'` con delta simulado → COMPLETE, sin huérfanos | ✅ |
| El mensaje real de 17 partidas → 2.205 € (COMPLETE), nunca 2.080 € | ✅ |
| Los 8 mensajes del criterio B → COMPLETE, sin falsos PARTIAL | ✅ |
| Secuencia G1b (capacidad mezclada) — no reaparece | ✅ `orchestrator.test.ts`, recuperada con tanda 7 |
| Los 4 casos de M10 sensor | ✅ `commandments.test.ts` 36/36 |
| G1c bidireccional | ✅ intacto |
| Suite completa `test:calculator` | ✅ 0 fallos (scenario 248 → 252, orchestrator 35 sin cambios) |
| Suite completa `test:guardrail` | ✅ 0 fallos, 8 suites |
| `npm test` | ✅ 0 fallos |
| `test:regression` | ✅ **84/84** turnos · 47 escenarios · enforcement=full |

---

## 5 · Declaración de impacto

`git diff --stat` (contra `origin/develop`, `f4a1414` — YA incluye la tanda 7):

```
 src/app/api/chat/route.static.test.ts           |  21 ++
 src/app/api/chat/route.ts                       |  18 ++
 src/lib/calculator/scenario.test.ts             | 170 +++++++++++++++
 src/lib/calculator/scenario.ts                  | 118 +++++++++--
 src/lib/telemetry.ts                            |  17 ++
 supabase/migrations/024_telemetry_fidelidad.sql |  55 +++++
 7 files changed, 614 insertions(+), 16 deletions(-)
```

(El diff completo incluye TODO el trabajo de G1d — tanda anterior + este cierre — porque
`origin/develop` ya absorbió la tanda 7 por separado; el trabajo NUEVO de esta tanda específica es
`tieneMarcaAnual`/`numerosCandidatosConMarca`/la restricción en `huerfanosPorMultiset`, más los 4
tests nuevos.)

| Archivo/símbolo | Cambio de ESTA tanda | Motivo |
|---|---|---|
| `scenario.ts`, `tieneMarcaAnual`/`MARCA_ANUAL_RE` (nuevas) | detecta "al año"/"anual"/etc. pegado a un número | condición de la reserva de AG01 |
| `scenario.ts`, `numerosCandidatosConMarca` (nueva) | como `numerosCandidatos`, conserva la marca por candidato | plumbing interno — `numerosCandidatos` pública no cambia |
| `scenario.ts`, `huerfanosPorMultiset` | la rama ÷12/×12 exige `candidato.anual === true`; el ±1 sigue incondicional | cierra la puerta trasera del agregado/12 |
| `scenario.ts`, `detectarNumerosHuerfanos` | usa `numerosCandidatosConMarca`; el candidato de `plazoSueltoConLista` se marca `anual: false` | consistencia con el nuevo tipo |

### Alcance — confirmado dentro de la excepción de congelación

Solo `scenario.ts` (verificación de conservación) y `route.ts`/`telemetry.ts`/la migración (el
punto que expone el mensaje original al sensor G1d — ya justificado en el informe de la tanda
anterior). Ningún archivo fuera de ese perímetro. `persistTurn` sigue siendo el punto único
(`persistence.ts` no se tocó). `llm.ts` (dominio AG01) e `ica-service.ts` (dominio AG06) no se
tocaron.

### Tests — todos nuevos, ninguno modificado (V11)

4 tests nuevos en `scenario.test.ts`. Ningún assert existente se tocó.

---

## 6 · Validación

| Comando | Resultado |
|---|---|
| `npx tsc --noEmit` | limpio |
| `npm run build` | TypeScript compila limpio; falla después en el prerender de `/login` por falta de credenciales de Supabase — entorno, no código |
| `npm test` | 0 fallos |
| `npm run test:guardrail` | 0 fallos, 8 suites (commandments 36/36 — M10 no tocado) |
| `npm run test:calculator` | 0 fallos (operations 15, orchestrator 35, expenses 24, scenario 252, tools 17) |
| `npm run test:regression` | **84/84** turnos · 47 escenarios · enforcement=full |
| `npm run test:e2e` / `npm run smoke:db` | sin credenciales — no verificable en este entorno |
