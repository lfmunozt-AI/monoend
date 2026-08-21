# Corrección AG08 — V13: token reclamado = frontera, nunca se elimina

**Fecha:** 6 de agosto de 2026
**Rama:** `agent/08` @ `f4f3561` + esta corrección
**Bloqueante corregido:** el mecanismo de reclamo-por-valor (tanda anterior) ELIMINABA el token del
número reclamado, y esa eliminación fusionaba los fragmentos de nombre vecinos, perdiendo partidas
enteras cuando un gasto compartía segmento de coma con la palabra de ingreso.

---

## 0 · Confirmación explícita de lo que quedó SIN TOCAR

```
$ git diff src/lib/calculator/scenario.ts | grep -A3 -B3 "META_CTX"
(sin resultados — el bloque de meta no tiene ni un diff)

$ git diff src/lib/calculator/expenses.ts | grep "^[+-]" | grep "MULTIPLICADOR = "
(sin resultados — el valor 50 no cambió, solo se añadió el comentario de justificación pedido)

$ grep -n "function detectarDiscrepanciaGastos" src/lib/calculator/scenario.ts
852:export function detectarDiscrepanciaGastos(delta: Partial<ScenarioState>): DiscrepanciaGastosResult {
```

- **V12** (el ingreso nunca es gasto): sin tocar — verificado con test dedicado (§4, V13-5).
- **meta.monto capturando el ingreso**: preexistente, sin tocar (bloque `META_CTX` sin diff).
- **Umbral 50×**: sin tocar (mismo valor), solo se añadió el comentario de justificación pedido
  (§5.2 del contrato dice 10×; AG05 lo enmienda en un PR de docs aparte).
- **Reconciliación cross-turno / `CONFLICT`/`ASSUMED`/`SUPERSEDED`**: `detectarDiscrepanciaGastos`
  sigue con un solo argumento (`delta`), sin `prev`. Nada de tanda 2 se implementó.

## 1 · La causa raíz exacta

El mecanismo de la tanda anterior (`excluirValores`) hacía `tokens.filter(...)` — **eliminaba** el
token del número reclamado del array. Eliminarlo fusionaba los tokens vecinos en una sola secuencia
sin separador: `[gano][700][y][pago][arriendo][650]` → tras borrar `700` → `[gano][y][pago][arriendo]`
→ el emparejador acumula los cuatro como UN nombre candidato → `NO_ES_GASTO` rechaza el conjunto entero
(por contener "gano") → el `650` de arriendo queda sin nombre disponible y se pierde en silencio — **sin
disparar ninguna alarma**, porque `arriendo` nunca fue huérfano: fue destruido antes de intentarlo.

Con punto (`"gano 700. pago arriendo 650..."`) el problema no aparecía porque el punto ya crea un
segmento de coma/frase DISTINTO — `pago arriendo` nunca comparte segmento con `gano`.

## 2 · El fix: token FRONTERA, nunca eliminado

`Tok` gana un tercer tipo: `"num" | "word" | "boundary"`. En `parseExpenseListDetallado`, un token
reclamado (por valor, o por ser la PALABRA de contexto — `gano`/`sueldo`/`salario`/`gasto`/etc.) se
**convierte** en `{kind: "boundary"}` — sigue presente en el array, en su misma posición, nunca se
quita. `emparejarNombreMonto` trata un token frontera como un **reset duro** (igual que una coma):
vacía `pendingName`/`pendingAmount` sin intentar validar nada contra `NO_ES_GASTO`. Así, `gano` se
descarta ANTES de poder fusionarse con `y pago arriendo` — y `arriendo` (ya sin `gano` en el
acumulado) sí pasa la validación y se queda con su `650`.

`resolverPegado` no necesitó cambios: sus condiciones ya exigen `kind === "num"` explícitamente, así
que un token frontera simplemente no participa en la detección de pegado (ni bloquea, ni se confunde).

**Efecto secundario aceptado:** el nombre del ítem recuperado puede incluir conectores sueltos que
sobrevivieron al reset (p. ej. `"y pago arriendo"` en vez de `"arriendo"` limpio) — la clasificación
vital/no-vital sigue funcionando correctamente (`classifyExpense` hace match por subcadena de palabra
completa, "arriendo" sigue detectándose dentro de "y pago arriendo"), y el **importe nunca se pierde ni
se atribuye mal**, que es la garantía exigida. Limpiar el nombre exigiría excluir verbos genéricos
("pago", "tengo"…) — fuera de alcance de esta corrección puntual.

## 3 · git diff --stat

```
 src/lib/calculator/expenses.ts      | 55 ++++++++++++++++++---
 src/lib/calculator/scenario.test.ts | 98 +++++++++++++++++++++++++++++++++++++
 src/lib/calculator/scenario.ts      | 30 ++++++++++--
 3 files changed, 172 insertions(+), 11 deletions(-)
```

## 4 · Declaración de impacto — función por función

| Función/tipo | Archivo | Qué cambió | Por qué |
|---|---|---|---|
| `Tok` (interfaz interna) | expenses.ts | `kind` gana el valor `"boundary"` | Representar el token reclamado sin eliminarlo |
| `emparejarNombreMonto` | expenses.ts | +rama al inicio del bucle: `kind === "boundary"` → reset duro de `pendingName`/`pendingAmount` | Núcleo del fix — evita la fusión de nombres vecinos |
| `parseExpenseListDetallado` | expenses.ts | El filtro que ELIMINABA tokens (`tokens.filter(...)`) se sustituye por un `tokens.map(...)` que los CONVIERTE en frontera; +parámetro `fronteraPalabras?: ReadonlySet<string>` | V13 — nunca se elimina, siempre queda como muro |
| `detectarItemSospechosoPorMagnitud` | expenses.ts | Sin cambio de lógica ni de valor — solo +comentario de justificación del 50× vs. el 10× literal del contrato | Petición explícita de la revisión |
| `extractScenarioDelta` | scenario.ts | Cada bloque que ya hacía `claimed.add(valor)` (TAE, crédito, ingreso, gasto declarado) ahora TAMBIÉN captura la palabra de contexto (`RATE_CONTEXT`/`PRECIO_CTX`/`INGRESO_CTX`/`GASTO_CTX`) y la añade a `fronteraPalabras`; las llamadas a `parseExpenseListDetallado` pasan ese set como 4º argumento | V13(c) — la palabra de ingreso también queda fuera del alcance del parser de listas |

### Eliminadas

Ninguna. El mecanismo de reclamo por valor de la tanda anterior se **reemplaza internamente** (de
`filter` a `map`+boundary) pero la función pública (`parseExpenseListDetallado`) conserva su
comportamiento observable para todo lo que ya funcionaba — verificado por las 172 pruebas de
`test:calculator` que no se tocaron y siguen en verde.

## 5 · Los tests obligatorios — resultado real

```
1 — 'gano 700 y pago arriendo 650, comida 200, luz 50'
    ingreso: 700 · gastos_mensuales (tras merge): 900 · sobrante: −200 (DÉFICIT) ✅
    gastos_items: [{"name":"y pago arriendo","amount":650,"category":"vital",...},
                   {"name":"comida","amount":200,...}, {"name":"luz","amount":50,...}]

2 — 'mi sueldo es 2500 y el arriendo 800, comida 300, luz 90'
    ingreso: 2500 · gastos_mensuales (tras merge): 1190 · sobrante: +1310 ✅
    gastos_items: [{"name":"y el arriendo","amount":800,...}, comida 300, luz 90]

3 — 'gano 700. pago arriendo 650, comida 200, luz 50' (control, con punto)
    idéntico a antes de esta corrección: {"name":"pago arriendo","amount":650,...}, comida 200, luz 50 ✅

4 — no-destructividad de spans (permutación distinta): 'gano 1500 y pago comida 300, luz 80, agua 40'
    ingreso 1500 · 3 items (comida 300, luz 80, agua 40) · gastos_mensuales 420 · ninguno fusionado ✅

5 — regresión V12 (los 3 casos de arriba): ningún ítem con el mismo importe que ingreso_mensual ✅

6 — regresión (6 mensajes de la tanda anterior + testdev7): todos verdes con sus valores exactos ✅
```

## 6 · Validación

```
npm test                → 14/14 OK (exit 0)
npm run test:guardrail  → 262/262 OK (exit 0)
npm run test:calculator → 206/206 OK (exit 0)   [15+33+24+119+15 — incluye los 6 tests V13]
npm run test:regression → 84/84 turnos OK (exit 0)
npx tsc --noEmit        → limpio
npm run build           → TypeScript compila (3.1s); falla en "/login" por falta de credenciales
                           Supabase en este sandbox — mismo fallo preexistente, no es regresión.
npm run test:e2e        → SKIPPED (sin credenciales). Salida literal de los 3+6 casos pegada en §5.
npm run smoke:db        → SKIPPED (misma razón).
```

## 7 · Estado de la rama

Pendiente de commit y push tras este informe. `origin/agent/08` está en `f4f3561`; el push de esta
corrección será un avance normal (sin force) salvo que la rama haya divergido entre tanto.
