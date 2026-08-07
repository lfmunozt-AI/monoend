# Corrección AG08 — V14: fronteras posicionales por rango + ley de conservación

**Fecha:** 7 de agosto de 2026
**Rama:** `agent/08` @ `a83957a` + esta corrección
**Bloqueante corregido:** el conjunto de fronteras de la 10ª tanda (V13) guardaba STRINGS (valores y
palabras), no POSICIONES — una palabra-frontera se convertía en una regla GLOBAL que destruía cualquier
partida homónima del mensaje, sin relación con la que originó el reclamo.

---

## 0 · Fronteras POSICIONALES — dónde se registran (archivo y línea)

`src/lib/calculator/expenses.ts:221-238` — `Tok` gana `start`/`end` absolutos y se define
`export interface Rango { start: number; end: number }`. `tokenizeSegment` (línea 250) calcula esos
offsets con `RegExp.exec` sobre el segmento (no `.split()`, que pierde la posición). El filtro por
posición vive en `parseExpenseListDetallado` (línea ~558): `excluirRangos.some((r) => seSolapan(t, r))`
— reemplaza por completo a los antiguos `excluirValores: Set<number>` / `fronteraPalabras: Set<string>`.

Los RANGOS se calculan en `src/lib/calculator/scenario.ts`, dentro de `extractScenarioDelta`, uno por
cada patrón declarativo que tiene éxito:
- TAE (líneas ~417-424): rango de la palabra de contexto + rango del porcentaje.
- Crédito (líneas ~465-485): rango desde la palabra de contexto (`casa`/`financiar`/…) hasta el final
  de lo último entre monto y plazo.
- Ingreso (líneas ~487-500): rango desde la palabra de ingreso hasta el final del número.
- Gasto (líneas ~527-568): la PALABRA "gasto" registra su rango de forma INCONDICIONAL (ver §2); el
  NÚMERO solo si la prueba probatoria determina que es declarativo, no parte de una lista.

## 1 · Confirmación de lo que quedó SIN TOCAR

```
$ git diff src/lib/calculator/scenario.ts | grep -c "META_CTX"
0   ← el bloque de meta no tiene ni un diff

$ git diff src/lib/calculator/expenses.ts | grep "^[+-]" | grep "MULTIPLICADOR = "
(sin resultados) ← el umbral 50× no cambió

$ grep -n "function detectarDiscrepanciaGastos" src/lib/calculator/scenario.ts
884:export function detectarDiscrepanciaGastos(delta: Partial<ScenarioState>): DiscrepanciaGastosResult {
```

Un solo argumento, sin `prev`. Cero reconciliación cross-turno, cero `CONFLICT`/`ASSUMED`/`SUPERSEDED`.

## 2 · Causas exactas y su corrección

### B1 — asimetría ingreso/gasto

La palabra "gano" se volvía frontera SIN CONDICIÓN (siempre que el ingreso se extraía con éxito), pero
la palabra "gasto" solo se volvía frontera DENTRO de la rama donde su número se confirmaba como
declarativo (`gastoDeclaradoSimple !== undefined && listResult.items.length < 2`). Cuando el número
candidato de "gasto" resultaba ser parte de una lista real (como en `"gasto en arriendo 800..."`, donde
la prueba probatoria ya encontraba ≥2 pares), la palabra "gasto" NUNCA se marcaba — "y gasto en arriendo"
se validaba como un solo nombre y `NO_ES_GASTO` lo rechazaba entero, perdiendo el 800.

**Fix:** la palabra "gasto" ahora registra su rango de forma incondicional, en AMBAS ramas de la
decisión (con o sin reclamar el número) — igual que "gano". Ver `scenario.ts:527-568` (comentario "FIX
V14-2, SIMETRÍA").

### B2 — regla global por palabra

`PRECIO_CTX` incluye `casa` entre sus alternativas. Con el mecanismo de la 10ª tanda, CUALQUIER
ocurrencia de "casa" en el mensaje se volvía frontera — incluida una "casa 700" completamente distinta,
30 caracteres más adelante, que era una partida de gasto legítima.

**Fix:** el rango del crédito es `[inicio de la PRIMERA "casa"/"financiar", fin del monto o plazo]` —
un tramo de caracteres, no una palabra. La segunda "casa" (en otra posición) nunca cae dentro de ese
rango y sigue siendo un token normal, libre de emparejarse con `700`.

### Intermitencia (orden financiar/casa)

Consecuencia directa de B2: al ser POSICIONAL, el resultado ya no depende de qué alternativa de
`PRECIO_CTX` matcheó primero — solo de DÓNDE cae esa ocurrencia. Verificado en el TEST OBLIGATORIO
V14-3: los dos órdenes producen resultados IDÉNTICOS.

## 3 · V14 — Ley de conservación

`valoresAsignadosEnDelta` (scenario.ts) dejó de RE-DERIVAR ítems con `parseExpenseList(message)` (una
segunda pasada, SIN los rangos reclamados, que podía producir un conjunto de ítems distinto al
realmente asignado) y ahora usa `delta.gastos_items` directamente — la fuente de verdad única.

`extractScenarioDelta` calcula `extraction_status` internamente (llamando a `analizarExtraccion` con el
delta ya limpio de la guarda de sanidad) antes de devolver — **nunca vuelve a salir `undefined`**,
incluso al llamarse de forma aislada, fuera de `route.ts`.

Dos tests preexistentes (`"ambiguo → no extrae nada"`, `"FIX 2: SIN crédito previo + '18%'"`) asumían
`assert.deepEqual(delta, {})` — con `extraction_status` siempre presente, ese `{}` ya no es el resultado
correcto. Se actualizaron para afirmar `{ extraction_status: "COMPLETE" }` / `{ extraction_status:
"PARTIAL" }` según corresponde (verificado empíricamente, no adivinado) — el resto de la aserción (cero
campos financieros) se mantiene intacto. **Esto no es "reescribir un test para que afirme lo
contrario"** (V11): el comportamiento nuevo fue pedido explícitamente por esta misma revisión
("extraction_status SIEMPRE definido"), y la comprobación central del test — que NINGÚN dato financiero
se inventa de una frase ambigua — sigue verificándose exactamente igual.

## 4 · git diff --stat

```
 src/lib/calculator/expenses.ts      | 111 ++++++++++++++++++------
 src/lib/calculator/scenario.test.ts | 142 +++++++++++++++++++++++++++++--
 src/lib/calculator/scenario.ts      | 164 +++++++++++++++++++++---------------
 3 files changed, 317 insertions(+), 100 deletions(-)
```

## 5 · Declaración de impacto — función por función

| Función/tipo | Archivo | Qué cambió | Por qué |
|---|---|---|---|
| `Tok` | expenses.ts | +`start`/`end` absolutos | Base de las fronteras posicionales |
| `Rango` (nuevo tipo, exportado) | expenses.ts | — | Reemplaza `Set<number>`/`Set<string>` |
| `tokenizeSegment` | expenses.ts | Firma `(segment, segmentStart)`; usa `RegExp.exec` en vez de `.split()` para conservar offsets | Cada token necesita su posición absoluta |
| `segmentarConOffset` (nueva) | expenses.ts | — | Segmenta `message` conservando el offset de cada segmento |
| `seSolapan` (nueva) | expenses.ts | — | Test de solape `[start,end)` |
| `resolverPegado` | expenses.ts | El token fusionado (miles-con-espacio) conserva `start`/`end` del rango combinado | Coherencia de offsets tras la fusión |
| `parseExpenseListDetallado` | expenses.ts | Firma: `excluirValores`/`fronteraPalabras` → `excluirRangos: ReadonlyArray<Rango>`; el filtro pasa de comparar valor/palabra a comparar solape de rango | Núcleo del fix V14-1 |
| `extractScenarioDelta` | scenario.ts | `claimed`/`fronteraPalabras` → `rangosReclamados: Rango[]`; cada bloque declarativo calcula su propio rango; la palabra "gasto" pasa a registrarse incondicionalmente (antes solo en la rama de reclamación); +cálculo final de `extraction_status` antes de retornar | V14-1, V14-2, V14-3 |
| `valoresAsignadosEnDelta` | scenario.ts | Usa `delta.gastos_items` directamente en vez de re-derivar con `parseExpenseList(message)` | V14-3 — fuente única, sin inconsistencia |

### Eliminadas

Ninguna función eliminada. `excluirValores`/`fronteraPalabras` (parámetros, no funciones) se sustituyen
por `excluirRangos` en la misma función (`parseExpenseListDetallado`) — cambio de firma, no de función.

### Tests preexistentes actualizados (no reescritos para "tapar" nada — ver §3)

`"ambiguo → no extrae nada (no corrompe el estado)"` y `"FIX 2: SIN crédito previo + '18%' → NO extrae
nada"` — ambos en `scenario.test.ts`.

## 6 · Los tests obligatorios — resultado real

```
1 — 'gano 2000 y gasto en arriendo 800, comida 300, luz 100' (bloqueante B1)
    ingreso 2000 · gastos_items: [en arriendo=800, comida=300, luz=100] · gastos 1200 · sobrante +800 ✅
    balance: candidatos=[2000,800,300,100] asignados=[2000,800,300,100] huerfanos=[] sinDestino=[] ✅

2 — 'gano 1500, quiero una casa de 200000 a 240 meses, casa 700, comida 300, luz 90' (bloqueante B2)
    ingreso 1500 · crédito 200000/240 intacto · gastos_items: [casa=700, comida=300, luz=90]
    gastos 1090 · sobrante +410 ✅
    balance: candidatos=[1500,200000,700,300,90] asignados=[1500,700,300,90,200000,240] sinDestino=[] ✅

3 — 'quiero FINANCIAR una casa...' → IDÉNTICO al caso 2 (independencia de orden) ✅

4 — 'gano 700 y pago arriendo 650, comida 200, luz 50' → gastos 900, sobrante −200 (sigue igual) ✅

5 — 'mi sueldo es 2500 y el arriendo 800, comida 300, luz 90' → gastos 1190, sobrante +1310 (sigue igual) ✅

6 — TEST DE CONSERVACIÓN (estructural): los 9 mensajes (5 de arriba + 4 regresiones de tandas
    anteriores) + testdev7 → extraction_status SIEMPRE definido, CERO números sin destino en los 9 ✅

7 — Regresiones: testdev7 (15 ítems, suma 2250) ✅ · 'gasto 2 500 €' → 2500 ✅ ·
    'aproximadamente' → gastos 2000, gastos_items vacío ✅
```

## 7 · Validación

```
npm test                → 14/14 OK (exit 0)
npm run test:guardrail  → 262/262 OK (exit 0)
npm run test:calculator → 211/211 OK (exit 0)   [15+33+24+124+15]
npm run test:regression → 84/84 turnos OK (exit 0)
npx tsc --noEmit        → limpio
npm run build           → TypeScript compila (3.3s); falla en "/login" por falta de credenciales
                           Supabase en este sandbox — mismo fallo preexistente, no es regresión.
npm run test:e2e        → SKIPPED (sin credenciales). Salida literal de los 5 casos pegada en §6.
npm run smoke:db        → SKIPPED (misma razón).
```

## 8 · Estado de la rama

Pendiente de commit y push tras este informe. `origin/agent/08` está en `a83957a`; el push será un
avance normal (sin force) salvo que la rama haya divergido entre tanto.
