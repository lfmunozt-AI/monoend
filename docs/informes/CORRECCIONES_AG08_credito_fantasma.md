# Corrección AG08 — un plazo suelto no crea crédito fantasma

**Fecha:** 18 de agosto de 2026
**Rama:** `agent/08`, sobre `origin/agent/08` (`b611393`)
**Nota de proceso:** `origin/develop` todavía NO incluye `b611393` (ni `db7803c`) en el momento
de esta tanda, a pesar de que el encargo asumía el merge hecho — el reset se hizo contra
`origin/agent/08` (superset exacto) para no perder el trabajo de reconciliación aritmética que
esta misma tanda da por aprobado. Ver el mensaje de entrega para el detalle.
**Motivado por:** medición de Claude sobre `b611393` — un plazo suelto pegado a una lista de
gastos ("a 48 meses: cuota 900, seguro 50") escribía `credito.plazo_meses=48` aunque no existiera
ningún crédito real, y ese plazo PERSISTE entre turnos y (desde la migración de memoria continua)
entre sesiones, contaminando un crédito real declarado después.
**Contrato:** `docs/CONTRATO_TRUTH_ENGINE.md` §9 (V14/G1b) · §13 · §15

---

## 0 · El bug — y el fix

`scenario.ts`, bloque "PLAZO BARE + LISTA" (introducido en la tanda de la reconciliación
aritmética para que "48" en `"a 48 meses: cuota 900, seguro 50"` no contaminara la primera partida
de gastos): reclamaba el rango y escribía `delta.credito = {..., plazo_meses: 48}`
**incondicionalmente**, sin comprobar que existiera algún monto/objeto/TAE que ese plazo
completara. Un `credito` es un HECHO de nivel usuario — persiste entre turnos y sesiones — así que
ese plazo fantasma podía sobrevivir y aparecer más tarde en un crédito real sin relación (G1b).

**Fix:** el plazo solo se escribe en `delta.credito` si el crédito **ya existe** — con monto, en
este mismo mensaje (`delta.credito?.monto`, si el bloque de Crédito lo capturó antes en el mismo
turno) o en el estado persistido (`prev.credito?.monto`). Si no hay crédito que completar, el
rango del plazo se sigue reclamando (como frontera, no como campo) para que el parser de listas no
lo confunda con el importe de la primera partida, pero **no se escribe nada en `credito`**.

---

## 1 · El hueco derivado — "el 48 huérfano" no caía solo

Al dejar de escribir `credito.plazo_meses`, la expectativa (V14, "ningún dato se pierde en
silencio, se pregunta") era que "48" apareciera como número huérfano vía el pipeline genérico
(`detectarNumerosHuerfanos`/`analizarExtraccion`, el MISMO cómputo que usa `route.ts` de forma
independiente sobre `(mensaje, delta)`). No fue así: `esCandidataFinanciera` excluye por diseño
**todo** número seguido de una unidad de tiempo (`TIEMPO_AFTER_RE`) — correcto para el caso
general (un crédito completo con "a 48 meses" no debe generar ruido), pero aquí filtraba también
el caso donde el plazo SÍ queda sin dueño.

**Fix:** nueva función pura `plazoSueltoConLista(message)` — único punto de verdad para el patrón
"PLAZO + ':' + lista real de ≥2 partidas", usada en dos sitios que debían estar de acuerdo:
el bloque de extracción (para decidir si el plazo completa un crédito) y `detectarNumerosHuerfanos`
(para registrar ese mismo plazo como huérfano explícitamente cuando `!delta.credito`, sin tocar el
filtro general de `esCandidataFinanciera` que usa el resto del sistema).

---

## 2 · El hueco "aparte" (TAE/monto sin plazo) — investigado, confirmado, y **revertido**

`"quiero un carro de 30000 con TAE 9"` no extrae ni monto ni TAE — **confirmado**, doble causa
independiente:

1. El bloque de Crédito exige `plazo && amount` **en el mismo match**: sin plazo, no escribe nada
   en `delta.credito`, y "30000" queda sin reclamar — el bloque de Meta (que corre después) se lo
   apropia (`meta.monto = 30000`, un carro leído como objetivo de ahorro).
2. `PERCENT` exige el símbolo `%` literal: "TAE 9" sin él nunca se lee como tasa.

Se implementó y probó un fix para (1) — relajar el bloque de Crédito a "el monto basta, el plazo
es opcional" (mismo patrón que ya usa el bloque de Meta). **Rompió 7 tests ya establecidos**:
`PRECIO_CTX` matchea las palabras "carro"/"casa"/"piso"/etc. en **cualquier posición** del mensaje,
incluido como **nombre de una partida** dentro de una lista de gastos (p. ej.
`"...servicios 250 carro 100 ropa"`, donde "carro" es el nombre de un ítem, no una declaración de
compra). El requisito `plazo && amount` no era solo "el caso normal soportado": era la red de
seguridad silenciosa que impedía que esa palabra genérica reclamara cualquier número cercano como
si fuera un crédito. Con la relajación, mensajes reales de la suite (escenarios de gastos, el
mensaje canónico del e2e con "dudo entre 200000, 300000 o 150000", el invariante de cierre
V14+V15+V16, la sustitución de un ítem por tool_call, el caso estructural M1 "en mi casa gasto
normalmente 1300…") empezaron a atribuir mal un monto a `credito`.

**Decisión:** revertido a su forma original (`if (plazo && amount)`). Este hueco queda
**documentado, no corregido**, con un test que fija el comportamiento actual y explica por qué
(`"documentado (no corregido): 'quiero un carro de 30000 con TAE 9' ..."`, `scenario.test.ts`).
Corregirlo de verdad requiere acotar `PRECIO_CTX` a una posición de declaración real (no cualquier
mención de la palabra objeto), un cambio de mayor alcance que merece su propia tanda con revisión
adversarial dedicada — no un añadido de última hora al fix de crédito fantasma, que es el único
mandatado esta tanda.

---

## 3 · Tests — resultado real

| Test | Resultado |
|---|---|
| `'a 48 meses: cuota 900, seguro 50'` → credito NULL, gastos 950, cuota=900 | ✅ |
| ídem, `analizarExtraccion` independiente (como route.ts) → `extraction_status=PARTIAL`, `48 ∈ numerosHuerfanos` | ✅ |
| `'quiero un carro de 30000 a 48 meses'` → credito {monto:30000, plazo:48} (caso normal intacto) | ✅ |
| T1 `'a 48 meses: cuota 900, seguro 50'` (credito NULL) + T2 `'quiero un carro de 30000 a 36 meses'` → credito usa SU propio plazo (36), nunca el 48 fantasma de T1 | ✅ |
| `'quiero un carro de 30000 con TAE 9'` — documentado (no corregido): credito NULL, 30000 cae en meta | ✅ (fija el comportamiento actual, con la razón) |
| 2 tests pre-existentes actualizados (V11) — ver §4 | ✅ |

---

## 4 · Tests pre-existentes actualizados — por qué no es una debilitación (V11)

Dos tests de la tanda anterior codificaban el bug como comportamiento esperado — no podían seguir
en verde sin deshacer el fix que este mismo encargo mandata:

| Test | Antes | Ahora |
|---|---|---|
| `"Compuerta 2: 'a 48 meses: ...' — 48 reclamado por el plazo bare (V19: plazo SÍ se persiste)"` | `assert.equal(s.credito?.plazo_meses, 48)` | `assert.equal(s.credito, undefined)` — el resto del test (Compuerta 2 protege "cuota" de la mala atribución) se conserva igual |
| `CASOS_NUEVOS_ARITMETICA`, fraseo `"en 24 meses: cuota 500, mantenimiento 80"` | esperaba `plazo: 24` | se retira esa expectativa (gastos/items se mantienen) |

Mantenerlos habría significado reescribir código correcto para que un test que codificaba el
defecto siguiera en verde — la violación inversa de V11 (mismo criterio aplicado en la tanda del
sensor M10). Ambos se actualizan con comentario explícito señalando el porqué, y la cobertura que
pierden queda repuesta por los tests nuevos de crédito fantasma (§3).

---

## 5 · Regresión obligatoria — resultado real

| Verificación | Resultado |
|---|---|
| Los 7 fraseos de la reconciliación aritmética (Compuertas 1/2/3, V19) | ✅ cubiertos en `scenario.test.ts`, sin tocar salvo los 2 casos de §4 |
| Los 4 casos de M10 sensor (A/B/C/D) | ✅ `commandments.test.ts` 36/36, archivo no tocado |
| G1c bidireccional (agregado→detalle y detalle→agregado) | ✅ intacto |
| Las 15 partidas de testdev7 (suma 2250) | ✅ intacto |
| Suite completa `test:calculator` | ✅ 0 fallos (scenario 228 → 232, +6 tests: 4 de crédito fantasma + 1 documentación del hueco aparte + 1 test pre-existente actualizado sin cambiar de número) |
| Suite completa `test:guardrail` | ✅ 0 fallos, las 8 suites |
| `npm test` | ✅ 0 fallos |
| `test:regression` | ✅ **84/84** turnos · 47 escenarios · enforcement=full |

---

## 6 · Declaración de impacto

`git diff --stat` (contra `origin/agent/08`, `b611393`):

```
 src/lib/calculator/scenario.test.ts | 78 ++++++++++++++++++++++++++++++++--
 src/lib/calculator/scenario.ts      | 83 ++++++++++++++++++++++++++++++++++++-
 2 files changed, 156 insertions(+), 5 deletions(-)
```

| Función/símbolo | Cambio | Motivo |
|---|---|---|
| bloque "PLAZO BARE + LISTA" | el plazo solo se escribe en `delta.credito` si `delta.credito?.monto ?? prev?.credito?.monto` existe; si no, el rango se reclama igual (frontera) pero no se escribe nada | FIX crédito fantasma (mandatorio) |
| `plazoSueltoConLista` (nueva) | añadida | único punto de verdad del patrón "PLAZO+':'+lista", compartido por el bloque de extracción y `detectarNumerosHuerfanos` |
| `detectarNumerosHuerfanos` | registra explícitamente el plazo suelto como huérfano cuando `!delta.credito`, sin tocar `esCandidataFinanciera` (uso general, no se toca) | V14 — el plazo se pregunta, no se pierde en silencio |
| bloque Crédito (`PRECIO_CTX`) | **investigado, relajado, y revertido** a `if (plazo && amount)` original | el hueco TAE/monto queda confirmado y documentado, no corregido — blast radius inaceptable (7 tests rotos), ver §2 |

### Tests — 2 actualizados con justificación explícita (V11), el resto nuevo

Ver §4 para el detalle de los 2 tests actualizados. El resto (5 tests) es nueva cobertura: 4 del
fix de crédito fantasma + 1 que documenta (no corrige) el hueco aparte con su razón exacta.

---

## 7 · Validación

| Comando | Resultado |
|---|---|
| `npx tsc --noEmit` | limpio |
| `npm run build` | TypeScript compila limpio; falla después en el prerender de `/login` por falta de credenciales de Supabase — entorno, no código (idéntico en todas las tandas anteriores) |
| `npm test` | 0 fallos |
| `npm run test:guardrail` | 0 fallos, 8 suites (commandments 36/36 — M10 no tocado) |
| `npm run test:calculator` | 0 fallos (operations 15, orchestrator 33, expenses 24, scenario 232, tools 17) |
| `npm run test:regression` | **84/84** turnos · 47 escenarios · enforcement=full |
| `npm run test:e2e` / `npm run smoke:db` | sin credenciales — no verificable en este entorno (igual que en todas las tandas anteriores) |
