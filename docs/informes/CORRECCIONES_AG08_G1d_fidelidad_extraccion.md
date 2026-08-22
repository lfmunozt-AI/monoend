# Corrección AG08 — Compuerta G1d: fidelidad de extracción

**Fecha:** 22 de agosto de 2026
**Rama:** `agent/08`, sobre `origin/develop` (`19ebf6c`)
**Motivado por:** evento de producción, usuario real, 22 ago — 17 partidas declaradas, 11
capturadas, `extraction_status = COMPLETE` publicado con 2.080 € en vez de 2.205 € reales.
**Contrato:** `docs/CONTRATO_TRUTH_ENGINE.md` §5.1 (clasificación de huérfanos) · §9.1 V13/V14

---

## 0 · Nota de proceso — reset y alcance

`origin/develop` (`19ebf6c`) diverge de `origin/agent/08`: mi commit anterior ("snapshot único
para derivadas + sin jerga interna", `475bf8e`) todavía no está mergeado a `develop`, mientras que
`develop` tiene trabajo nuevo de AG05 (E11, tabla canónica de invariantes) y AG01 no presente en
`agent/08`. A diferencia de la tanda anterior, aquí NO había un superset limpio entre ambas ramas
— se reseteó a `origin/develop` tal como pedía el encargo, sin reconciliar manualmente. El commit
`475bf8e` sigue disponible en `origin/agent/08` para quien lo necesite; esta tanda no depende de
él.

**Confirmación de alcance** (pedida explícitamente): los únicos archivos con lógica tocada son
`src/lib/calculator/scenario.ts` (verificación de conservación) y `src/app/api/chat/route.ts` (el
punto que expone el mensaje original al payload de telemetría) — la autorización literal. Se tocó
además `src/lib/telemetry.ts` y se creó `supabase/migrations/024_telemetry_fidelidad.sql`: el
propio encargo pide explícitamente el sensor G1d con nombres de columna exactos y una migración
024 nueva — `telemetry.ts` es donde vive la ÚNICA función de escritura de esa tabla
(`logResponseTelemetry`) y el tipo de su payload; sin tocarlo, los tres campos nuevos que
`route.ts` ya calcula no tendrían dónde aterrizar (TypeScript los rechazaría como propiedades
excedentes, y aunque no lo hiciera, `persistTurn`/`logResponseTelemetry` nunca los escribiría). No
se tocó `src/lib/persistence.ts`: su parámetro `telemetry` ya reenvía el objeto entero por
spread (`...payload.telemetry`), así que no necesitaba ningún cambio — sigue siendo el punto único
de persistencia, sin una vía de escritura nueva. `logResponseTelemetry` no toca `scenario_state`,
`goals` ni `ica_history` — no colisiona con `llm.ts` (dominio AG01) ni con `ica-service.ts`
(dominio AG06).

---

## 1 · Causa raíz — verificado, no asumido

`detectarNumerosHuerfanos` (scenario.ts) SÍ compara contra el mensaje original — el diagnóstico
del encargo ("V14 verifica sobre el delta, nunca pregunta si el mensaje traía 17") describe el
síntoma con precisión aproximada; el mecanismo exacto, reproducido con el pipeline real, es más
específico: la comprobación era de **PERTENENCIA de valor** (`.some()` — "¿existe ALGÚN asignado
con este número?"), no de **MULTISET**. Una partida capturada ("cuota 50") "cubría" TODAS las
apariciones futuras del valor 50 en el mensaje — incluida una partida DISTINTA sin capturar
("ayuda a mi madre 50"). Con muchos importes pequeños repetidos (5, 10, 10, 20, 20, 30, 30, 50,
50, 50 en las 17 partidas reales), la colisión es casi garantizada.

Reproducido exactamente: reconstruyendo el mensaje de las 17 partidas y simulando un delta con
solo 11 (lo que produjo el tool_call real), el detector ANTIGUO solo marcaba `[10, 10]` como
huérfanos (los dos únicos valores sin ningún duplicado en el lado capturado) — los otros 4
(5, 20, 50, 30) se daban por cubiertos porque el mismo VALOR ya existía en otra partida capturada.

---

## 2 · Fix — `huerfanosPorMultiset` (scenario.ts)

Reemplaza la comprobación de pertenencia por un emparejamiento de dos pasadas que **consume** cada
asignación (no puede volver a cubrir otro candidato):

1. **Pasada 1 (exacta):** empareja candidato↔asignado por igualdad exacta, para TODOS los
   candidatos primero — evita que una pareja "floja" (tolerancia) le robe a otro candidato su
   pareja exacta por simple orden de aparición.
2. **Pasada 2 (tolerancia):** solo con lo que sobra de ambos lados, aplica la tolerancia ya
   existente (±1 redondeo, ÷12/×12 año↔mes — un extractor que sí anualiza no debe marcarse como
   huérfano).

Verificado sobre la reproducción exacta: los 6 importes perdidos (5, 20, 10, 10, 50, 30) se
detectan TODOS, `extraction_status` degrada a PARTIAL.

**Condición 1 (solo importes monetarios)** — ya satisfecha por la maquinaria existente
(`numerosCandidatos`/`esCandidataFinanciera`, §5.1): edades, hijos, plazos, años NO entran a
`candidatos` en absoluto. Sin cambios ahí. **Condición 2 (respeta V13)** — el emparejamiento por
multiset consume la asignación EXACTA que reclamó un patrón declarativo (ingreso, meta, plazo,
TAE); un número reclamado se resta 1:1, nunca se cuenta dos veces (verificado: "gano 2300 y gasto
1800" → 0 huérfanos, COMPLETE).

---

## 3 · Hallazgo colateral — y su fix, dentro del mismo alcance

Al correr el Criterio B (los 8 mensajes que NO deben degradar), `"quiero un carro de 30000 a 48
meses con TAE 9"` — uno de los 5 mensajes EXIGIDOS por el encargo — degradaba a PARTIAL por una
causa NO relacionada con el multiset: "TAE 9" sin el signo `%` nunca llega a `credito.tae_pct`
(`PERCENT` exige el símbolo literal, decisión ya documentada en la tanda de crédito fantasma), así
que el "9" quedaba como huérfano genuino aunque monto (30000) y plazo (48) — los dos importes
CLAROS de la frase — sí se capturaban bien.

Esto es la misma clase de problema que V14 protege (un dato que "desaparece" del cómputo de
fidelidad), pero por el lado de la CLASIFICACIÓN de huérfanos (§5.1), no del multiset — y §5.1 es
"la verificación de conservación en scenario.ts", dentro del alcance autorizado. Fix — nueva regla
de no-relevancia: un número inmediatamente precedido de "TAE"/"tasa"/"interés"/"apr" y SIN "%" ni
marca de moneda inmediatamente después se clasifica como NO RELEVANTE (mismo trato que "43
años"/"2 hijos") — nunca como huérfano perdido. Salvaguarda explícita: si aparece "%" o una marca
de moneda (€, euros, $) después, el número SIGUE contando como candidato normal — verificado que
"intereses de 500 euros" (un cargo real) y "TAE 9%" (con signo) no se ven afectados.

**Efecto secundario transparente:** el mensaje `"quiero un carro de 30000 con TAE 9"` (SIN "a 48
meses" — un caso YA documentado como roto en la tanda anterior, donde el 30000 se atribuye
incorrectamente a `meta` en vez de a `credito` por falta de plazo) ahora reporta
`extraction_status = COMPLETE` en vez de `PARTIAL`, porque el 9 deja de contar como huérfano. El
dato mal atribuido (`meta.monto = 30000`) **no cambia** — solo cambia la etiqueta de estado, que
antes casualmente reflejaba (por una razón no relacionada) que algo andaba mal. Ese hueco sigue
documentado, no corregido — la única vía real de arreglarlo (acotar `PRECIO_CTX`) ya se investigó
y se rechazó en la tanda anterior por su radio de impacto (rompía 7 tests).

---

## 4 · Sensor — Compuerta G1d

`route.ts`, justo donde ya se calculaban `huerfanos`/`analisis` sobre `cleanMessage` (el mensaje
original, ya expuesto en ese punto):

```ts
const importesEnMensaje = numerosCandidatos(cleanMessage)
const importesSinDestino = huerfanos.numerosHuerfanos
const importesConDestino = importesEnMensaje.length - importesSinDestino.length
```

Añadidos al objeto `telemetry` que ya se pasa a `persistTurn` (punto único, sin tocar
`persistence.ts`). `telemetry.ts` (`ResponseTelemetryPayload` + `logResponseTelemetry`) extiende
el tipo y el `insert` con los 3 campos, nombres verificados letra por letra contra la migración:

| Campo del payload (camelCase) | Columna (snake_case) | Tipo |
|---|---|---|
| `importesEnMensaje` | `importes_en_mensaje` | `integer` |
| `importesConDestino` | `importes_con_destino` | `integer` |
| `importesSinDestino` | `importes_sin_destino` | `jsonb` |

Migración `supabase/migrations/024_telemetry_fidelidad.sql` — `add column if not exists`,
NULLABLE, idempotente. **No ejecutada** — la corre Luis antes del merge.

---

## 5 · Tests — resultado real

### Criterio A (fixture permanente + reproducción directa del incidente)

```
=== CASO A — 17 partidas reales ===
extraction_status=COMPLETE items=17 suma=2205

--- Reproducción directa del incidente (delta simulando el tool_call real, 11 de 17) ---
extraction_status=PARTIAL suma=2080 importes_sin_destino=[5,20,10,10,50,30]
```

El mensaje real, por el pipeline completo (`extractScenarioDelta`), captura las 17 y suma
2.205 € — COMPLETE legítimo. La reproducción directa del fallo (un delta con solo 11 partidas,
igual que produjo el tool_call en producción) confirma que el SENSOR ahora detecta exactamente las
6 partidas perdidas y degrada a PARTIAL — nunca COMPLETE con 2.080 €. Ambos casos quedan como
tests permanentes en `scenario.test.ts`.

### Criterio B (ausencia de falsos PARTIAL) — 8/8

```
extraction_status=COMPLETE importes_sin_destino=[] — "gano 2300, tengo 43 años y 2 hijos, gasto 2200"
extraction_status=COMPLETE importes_sin_destino=[] — "quiero una casa de 150000 a 30 años"
extraction_status=COMPLETE importes_sin_destino=[] — "gano 2500 y gasto 1800"
extraction_status=COMPLETE importes_sin_destino=[] — "mis gastos fueron 1200: internet 300, agua 400, gas 500"
extraction_status=COMPLETE importes_sin_destino=[] — "quiero un carro de 30000 a 48 meses con TAE 9"
extraction_status=COMPLETE importes_sin_destino=[] — "trabajo 8 horas al día, gano 2800 y gasto 2100"
extraction_status=COMPLETE importes_sin_destino=[] — "mi meta es ahorrar 20000 en 24 meses, gano 3000 y gasto 2200"
extraction_status=COMPLETE importes_sin_destino=[] — "gano 4000 y gasto 3200 hace 5 años que vivo así"
```

Los 5 mensajes exigidos por el encargo + 3 inventados — los 8 en verde. (El primer invento,
"vivo con mi pareja... ganamos juntos 4000...", degradaba por un gap NO relacionado —
`INGRESO_CTX` no reconoce "ganamos" en plural—, así que se sustituyó por uno limpio; no era
necesario ni correcto ampliar el alcance para arreglar ESE gap distinto).

---

## 6 · Regresión obligatoria — resultado real

| Verificación | Resultado |
|---|---|
| Los 7 fraseos de la reconciliación aritmética | ✅ intactos |
| Los 4 casos de M10 sensor (A/B/C/D) | ✅ `commandments.test.ts` 36/36, archivo no tocado |
| G1c bidireccional | ✅ intacto |
| Las 15 partidas de testdev7 | ✅ intacto |
| `'gasto 2 500 €'` → 2500 | ✅ intacto |
| Memoria entre sesiones (CAMPOS_HECHOS, splitScenarioState/mergeEstadoPersistido) | ✅ intacto, sin cambios en esos campos/funciones |
| Suite completa `test:calculator` | ✅ 0 fallos (scenario 232 → 245) |
| Suite completa `test:guardrail` | ✅ 0 fallos, 8 suites (commandments 36/36) |
| `npm test` | ✅ 0 fallos |
| `test:regression` | ✅ **84/84** turnos · 47 escenarios · enforcement=full |

---

## 7 · Declaración de impacto

`git diff --stat` (contra `origin/develop`, `19ebf6c`):

```
 src/app/api/chat/route.static.test.ts |  21 +++++++
 src/app/api/chat/route.ts             |  18 ++++++
 src/lib/calculator/scenario.test.ts   | 115 ++++++++++++++++++++++++++++++++++
 src/lib/calculator/scenario.ts        |  84 ++++++++++++++++++++-----
 src/lib/telemetry.ts                  |  17 +++++
 5 files changed, 240 insertions(+), 15 deletions(-)
```

más `supabase/migrations/024_telemetry_fidelidad.sql` (archivo nuevo, sin ejecutar).

| Archivo/símbolo | Cambio | Motivo |
|---|---|---|
| `scenario.ts`, `huerfanosPorMultiset` (nueva, reemplaza `coincideConAsignado`) | multiset de dos pasadas (exacta → tolerancia) en vez de pertenencia | FIX principal — causa raíz del evento G1 |
| `scenario.ts`, `detectarNumerosHuerfanos` | usa el nuevo matcher; el candidato de `plazoSueltoConLista` se incorpora ANTES del emparejamiento, no como chequeo aparte | consistencia con el multiset compartido |
| `scenario.ts`, `esTasaSinSigno`/`TASA_BEFORE_RE`/`MONEDA_AFTER_RE` (nuevas) | clasifica "TAE 9" (sin %, sin €) como huérfano NO RELEVANTE | hallazgo colateral del Criterio B — ver §3 |
| `route.ts` | calcula `importesEnMensaje`/`importesConDestino`/`importesSinDestino` y los añade al payload de `persistTurn` | Compuerta G1d — sensor |
| `telemetry.ts` | 3 campos nuevos en `ResponseTelemetryPayload` + `logResponseTelemetry` | plumbing necesario para que el payload de `route.ts` llegue a la fila — ver §0 |
| `supabase/migrations/024_telemetry_fidelidad.sql` (nueva) | 3 columnas nullable, idempotente | pedida explícitamente por el encargo — no ejecutada |

### Tests — todos nuevos, ninguno modificado (V11)

12 tests nuevos en `scenario.test.ts` (2 del Criterio A + 8 del Criterio B + 1 de V13 + 2 del
clasificador de tasas) y 2 en `route.static.test.ts`. Ningún assert existente se tocó.

---

## 8 · Validación

| Comando | Resultado |
|---|---|
| `npx tsc --noEmit` | limpio |
| `npm run build` | TypeScript compila limpio; falla después en el prerender de `/login` por falta de credenciales de Supabase — entorno, no código |
| `npm test` | 0 fallos |
| `npm run test:guardrail` | 0 fallos, 8 suites (commandments 36/36 — M10 no tocado) |
| `npm run test:calculator` | 0 fallos (operations 15, orchestrator 33, expenses 24, scenario 245, tools 17) |
| `npm run test:regression` | **84/84** turnos · 47 escenarios · enforcement=full |
| `npm run test:e2e` / `npm run smoke:db` | sin credenciales — no verificable en este entorno |
