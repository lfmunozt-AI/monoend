# Correcciones AG08 — Tanda 2 rechazada por AG01: doble conteo (V16), G1c en la ruta de escape, ASSUMED revocable, cap verificado

**Fecha:** 8 de agosto de 2026
**Rama:** `agent/08` @ `f5f1dc9` (tanda 2 rechazada) + esta corrección
**Fuente:** `docs/informes/REVISION_AG01_tanda2_reconciliacion.md` (rama `agent/01`) — veredicto **RECHAZADO**
**Base verificada:** se reseteó a `origin/agent/08` (NO a `develop`) — la tanda 2 completa se conservó; esto son correcciones, no una tanda nueva.

---

## 0 · Qué quedó APROBADO y no se tocó

Confirmado antes de empezar y verificado de nuevo al final (§7): bloqueo granular (§7, cuota de crédito calculándose con conflicto activo), materialidad exacta en las tres fronteras (≤1€, ≤5%, >5%), migración `020_telemetry_conflict.sql` y su mapeo payload↔columna, `notaConflictoGastos`, y toda la tanda 1 (fronteras posicionales, V14 ley de conservación).

---

## 1 · BLOQUEANTE 1 — Doble conteo (V16)

**Causa real** (verificada empíricamente, no coincide del todo con la hipótesis inicial del encargo): "gasté" normaliza (NFD, sin acentos) a "gaste" — ninguna de las dos formas declarativas de gasto (`GASTO_CTX`, `GASTO_AGREGADO_DETALLE_RE`) cubría esa palabra. Sin cobertura, "gasté 1800: renta 900, comida 500, luz 400" no activaba NINGÚN patrón declarativo y el mensaje entero caía al parser de listas: "gasté" se emparejaba como NOMBRE de un ítem con 1800 de importe, y el agregado se sumaba una SEGUNDA vez dentro del propio detalle. ("gastó" ya normalizaba a "gasto" — la tilde de la 'ó' se elimina igual — y no necesitaba cambio.)

**Fix primario:** ambos patrones extendidos con "gaste" (`src/lib/calculator/scenario.ts` — `GASTO_CTX`, `GASTO_AGREGADO_DETALLE_RE`). Al ser el MISMO mecanismo de rango-reclamado de la tanda 1 el que decide la exclusión del parser de listas, cubrir la palabra basta — la exclusión se aplica automáticamente.

**Defensa en profundidad — V16 (`aplicarGuardaV16`, nueva):** antes de devolver el delta, si algún ítem del desglose tiene EXACTAMENTE el mismo importe que el agregado declarado en el mismo mensaje, se descarta como ítem fantasma y el detalle se recalcula sin él — quirúrgico (a diferencia de la guarda de sanidad existente, que descarta el detalle ENTERO ante ingreso duplicado/magnitud absurda).

### Salida literal — los 3 mensajes del bloqueante 1

```
gasté 1800: renta 900, comida 500, luz 400 =>
{"gastos_mensuales":1800,"gastos_detalle":{"vitales":900,"noVitales":0,"desconocidos":900},
 "gastos_es_detalle":true,
 "gastos_items":[{"name":"renta","amount":900,...},{"name":"comida","amount":500,...},{"name":"luz","amount":400,...}],
 "extraction_status":"COMPLETE"}
→ mergeScenario: {"gastos_mensuales":1800,"items":3}   ← NUNCA 3600, sin conflicto (CONSISTENT)

gasto 2200: renta 900, comida 500, luz 400 =>
{"gastos_mensuales":2200,"gastos_detalle":{...,"desconocidos":900},
 "gastos_items":[renta 900, comida 500, luz 400], "extraction_status":"AMBIGUOUS"}
→ mergeScenario: {}   ← 400/2200 = 18,18 % > 5 %: reinicia captura (ver nota de discrepancia abajo)

gastos 1500 en total: casa 700, comida 300 =>
{"gastos_mensuales":1500,"gastos_detalle":{"vitales":300,"noVitales":0,"desconocidos":700},
 "gastos_items":[{"name":"casa","amount":700,...},{"name":"comida","amount":300,...}],
 "extraction_status":"AMBIGUOUS"}
→ casa=700, comida=300 (NUNCA casa=1500) — atribución correcta
```

**Nota de discrepancia declarada (sobre el 2º mensaje):** el encargo describe este caso como *"agregado 2200, detalle 1800, CONFLICT −400"*. Verificado: 400/2200 = 18,18 %, muy por encima del 5 % de materialidad que esta misma corrección tiene EXPLÍCITAMENTE prohibido tocar ("no debes tocar... materialidad exacta en las tres fronteras" — ya validada por AG01 en la frontera exacta 5 %/5,045 %). Producir `CONFLICT` aquí exigiría debilitar ese umbral ya aprobado. Se prioriza la consistencia con lo aprobado: el resultado real es reinicio de captura (ninguna cifra queda como verdad), no `CONFLICT`. Declarado explícitamente para que Luis lo revise — no se silenció la discrepancia ni se forzó el resultado del encargo al costo de romper una pieza ya aprobada.

---

## 2 · BLOQUEANTE 2 — G1c falla en la ruta de escape

**Causa confirmada exactamente como la localizó AG01:** `detalleCompleta: true` hardcodeado en la rama `traeAgregado` de `reconciliarGastos` (antes en `scenario.ts:~1651`), con un comentario que afirmaba —falsamente— que `gastos_detalle_origen` solo se fijaba con extracción `COMPLETE`. Se fija SIN esa condición en las dos ramas `traeDetalle` (con y sin `traeAgregado` en el mismo turno). El resultado: un desglose `PARTIAL` en el orden "detalle → agregado" podía escapar a `ASSUMED`; en el orden "agregado → detalle" (que sí leía `detalleCompletaEsteTurno` real), no — el mismo par de hechos, en distinto orden, terminaba en estados distintos.

**Fix:** `FuenteValor` gana un campo `completa?: boolean`. Los tres puntos donde se fija `gastos_detalle_origen` (aggMatch mismo-turno, `traeDetalle` solo, y la rama de escape) ahora guardan la calidad REAL de esa extracción. La rama `traeAgregado` que crea el `CONFLICT` lee `detalleOrigen.completa ?? false` (falla cerrado) en vez del hardcode. Comentario falso corregido con la explicación completa del bug real.

### Salida literal — bidireccional con detalle PARTIAL

```
delta detalle-partial (extraction_status: PARTIAL):
{"gastos_detalle":{"vitales":2250,"noVitales":0,"desconocidos":300},
 "gastos_items":[arriendo 1200, comida 1050, "Quizas" 300], "extraction_status":"PARTIAL"}

SENTIDO A (detalle PARTIAL T1 → agregado 2500 T2 → 2 intentos):
  T1: {"gastos_mensuales":2550,"gastos_detalle_origen":{"valor":2550,"turn":1,"completa":false}}
  T2: {"gastos_conflict":{"agregado":2500,"detalle":2550,"diff":50,"diffPct":2,"attempts":0,"detalleCompleta":false}}
  intento1: {...,"attempts":1,"detalleCompleta":false}
  intento2: {...,"attempts":2,"detalleCompleta":false}   ← NO escapa

SENTIDO B (agregado 2500 T1 → detalle PARTIAL T2 → 2 intentos):
  T1: {"gastos_mensuales":2500}
  T2: {"gastos_conflict":{"agregado":2500,"detalle":2550,"diff":50,"diffPct":2,"attempts":0,"detalleCompleta":false}}
  intento1: {...,"attempts":1,"detalleCompleta":false}
  intento2: {...,"attempts":2,"detalleCompleta":false}   ← NO escapa tampoco
```

`detalleCompleta: false` en AMBOS sentidos, `attempts` idénticos, `agregado`/`detalle`/`diff`/`diffPct` idénticos — **G1c confirmado también en la ruta de escape**, no solo en el caso canónico COMPLETE que ya pasaba.

---

## 3 · BLOQUEANTE 3 — ASSUMED revocable

**Causa confirmada:** `detectarResolucionConflicto` solo se invocaba si `seed.gastos_conflict`/`prev?.gastos_conflict` existía (`route.ts:387`, `scenario.ts` dentro de `extractScenarioDelta`) — una vez que el escape cerraba el conflicto a `gastos_assumed`, ninguna corrección tenía referente. Además, sin ninguna guarda, un valor nuevo declarado sobre un ASSUMED activo (p. ej. "mis gastos son 2200") dejaba `gastos_assumed` **y** `gastos_conflict` activos a la vez — estado que §2 no define.

**Fix (a):** nueva función `parConflictoParaResolucion(prev)` — devuelve el `gastos_conflict` real si existe, o un par SINTÉTICO reconstruido desde `gastos_agregado_origen`/`gastos_detalle_origen` (que sobreviven al escape) cuando solo hay `gastos_assumed`. Usada en `extractScenarioDelta` y en `route.ts` (la ruta robusta que ya cubría tool-call vs. fallback-regex de la tanda 2).

**Fix (b):** paso 1 de `reconciliarGastos` ampliado a `if ((conflict || assumed) && delta.gastos_resolucion)` — la resolución explícita ahora también revoca un ASSUMED, archivando el valor asumido como `SUPERSEDED` (motivo `USER_CORRECTION`).

**Fix (c):** nueva guarda al inicio del paso 3 — si `assumed` sigue activo y este turno trae datos nuevos (agregado o detalle) que NO fueron una resolución explícita, el asumido se archiva (`SUPERSEDED`, motivo `ASSUMED_SUPERSEDED_BY_NEW_DATA`) y el resto del paso decide el estado desde cero — nunca coexisten `ASSUMED` y `CONFLICT`.

**Cobertura de fraseo ampliada:** `RESOLUCION_VALOR_RE` gana `no,?\s*son` y `corrig[eo]:?`/`correccion:?`. `CONFIRMACION_CORTA_RE` gana un prefijo opcional ("sí,"/"sim,"/"yes,") delante del token principal más las alternativas `confirmo`/`correcto`/`correto`/`correct`/`confirmed`/`es correcto`/`e correto`/`is correct`/`exacto`/`exato`/`exactly`/`asi es`/`assim e`/`that's right`/`thats right` — ANCLADO a `^…$` en todos los casos (sin falsos positivos sobre menciones sueltas).

### Salida literal — 8 correcciones + 8 confirmaciones + coexistencia

```
8 formas de corrección sobre ASSUMED {"valor":2250}, TODAS revocan a 2200:
"en realidad son 2200" | "no, son 2200" | "corrige: 2200" | "usa 2200" |
"eran 2200" | "me equivoque, son 2200" | "el correcto es el total" | "quedate con el agregado"
→ cada una: {"gastos_mensuales":2200,"superseded":[{"valor":2250,"motivo":"USER_CORRECTION","turn":5}],
             "factStatus":"CONFIRMED"}

8 formas de confirmación sobre el mismo ASSUMED, TODAS confirman:
"si" | "vale" | "ok" | "si, correcto" | "correcto" | "confirmo" | "exacto" | "asi es"
→ cada una: {"gastos_mensuales":2250,"factStatus":"CONFIRMED"}

"mis gastos son 2200" sobre ASSUMED (valor nuevo discrepante):
{"conflict":{"agregado":2200,"detalle":2250,"diff":50,"diffPct":2.27},
 "superseded":[{"valor":2250,"motivo":"ASSUMED_SUPERSEDED_BY_NEW_DATA","turn":5}]}
→ CONFLICT abierto, gastos_assumed=undefined — NUNCA los dos estados a la vez
```

---

## 4 · MAYOR 4 — Cap de historial (§8) verificado

AG01 no pudo ejercitarlo por la vía pública porque los ciclos derivaban a escape (`ASSUMED`) en vez de acumular `SUPERSEDED`. Con B3 corregido (resolución inmediata dentro del mismo turno, sin esperar 2 intentos), un ciclo CONFLICT→resolución nunca llega a escapar — se probó por la vía pública real (`mergeScenario`/`extractScenarioDelta`, sin exportar `pushSuperseded`: el camino de integración real es una prueba más significativa que una prueba unitaria de una función interna aislada).

```
8 ciclos "agregado 2200 → detalle 2250 → 'usa 2250'" sobre el MISMO campo:
ciclo 1: superseded_len=1, colapsados=0
ciclo 2: superseded_len=2, colapsados=0
ciclo 3: superseded_len=3, colapsados=0
ciclo 4: superseded_len=4, colapsados=0
ciclo 5: superseded_len=5, colapsados=0
ciclo 6: superseded_len=5, colapsados=1
ciclo 7: superseded_len=5, colapsados=2
ciclo 8: superseded_len=5, colapsados=3   ← cap de 5 sostenido, contador correcto (8−5=3)
```

---

## 5 · e2e — bidireccional con detalle PARTIAL contra BD real

`scripts/e2e-turn.ts` gana T6: dos conversaciones separadas (mismos dos hechos — agregado 2500, desglose con un huérfano genuino — en los dos órdenes), con RE-LECTURA desde `conversations.scenario_state` (nunca desde el objeto en memoria) verificando `detalleCompleta=false` en ambos sentidos, mismos `attempts`/`agregado`/`detalle`, y `gastos_assumed=undefined` en los dos — el Gate G1c de la ruta de escape verificado contra persistencia real, no solo en memoria. Cleanup en el `finally` de las dos conversaciones nuevas (`response_telemetry` + `conversations`), igual que las ya existentes.

SKIPPED en este sandbox (sin `NEXT_PUBLIC_SUPABASE_URL`/`SUPABASE_SERVICE_ROLE_KEY`) — mismo estado que toda la tanda anterior; el script compila limpio (`tsc --noEmit`) y su lógica se verificó en memoria con el mismo par de hechos (§2 de este informe).

---

## 6 · Validación

```
npx tsc --noEmit         → limpio
npm test                 → 14/14 OK
npm run test:guardrail   → 262/262 OK
npm run test:calculator  → 234/234 OK   [15+33+24+147+15 — 147 = 136 (tanda 2) + 11 nuevos de esta corrección]
npm run test:regression  → 84/84 turnos OK · 47 escenarios
npm run build             → TypeScript compila; falla en "/login" por falta de credenciales
                             Supabase en este sandbox — mismo fallo preexistente, no es regresión.
npm run test:e2e          → SKIPPED (sin credenciales). T6 añadido y verificado en memoria (§5).
npm run smoke:db          → SKIPPED (misma razón).
```

## 7 · Confirmación de lo APROBADO — sigue intacto

- **Bloqueo granular (§7):** sin cambios en `orchestrator.ts`; el test "PIEZA 4 (§7): gastos en CONFLICT NO bloquea la cuota del crédito ni la clasificación vital/no-vital" (ya existente de la tanda 2) sigue verde — cuota se calcula con conflicto activo, sobrante/brecha siguen bloqueados.
- **Materialidad exacta (≤1€/≤5%/>5%):** ni `TOLERANCIA_REDONDEO_EUR` ni `MATERIALIDAD_MAX_PCT` ni `calcularMaterialidad` se tocaron. La nota de discrepancia de §1 es precisamente la prueba de que se respetó el umbral en vez de doblarlo para encajar un ejemplo del encargo.
- **Migración 020 y `notaConflictoGastos`:** sin cambios — `git diff` no toca `supabase/migrations/020_telemetry_conflict.sql` ni la función `notaConflictoGastos`.
- **Tanda 1 (V14, fronteras posicionales):** el test "REGRESIÓN (12ª tanda): V14... siguen intactas" (ya existente) sigue verde; `rangosReclamados`/`rangosParaMeta` sin cambios de comportamiento — solo se AÑADIÓ "gaste" a los patrones que alimentan esos rangos (V16 amplía la cobertura, no cambia el mecanismo).

## 8 · Estado de la rama

Pendiente de commit y push tras este informe. `origin/agent/08` sigue en `f5f1dc9`; el push declarado como `--force-with-lease` autorizado por el encargo, aunque en la práctica es un avance normal (ningún commit se reescribe, solo se añade uno nuevo encima).
