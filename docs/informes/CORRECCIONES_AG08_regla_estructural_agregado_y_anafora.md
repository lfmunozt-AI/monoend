# Corrección AG08 — regla estructural del agregado (M1) + anáfora con verbo + cap de items

**Fecha:** 14 de agosto de 2026
**Rama:** `agent/08`, sobre `origin/develop` (`358c729`)
**Motivado por:** `docs/informes/REVISION_AG01_qa_testdev8_ronda2.md` (agent/01@e029734, APROBADO CON RESERVAS)
**Contrato:** `docs/CONTRATO_TRUTH_ENGINE.md` §5.2/§8/§9(E9)/§14/§15

---

## 0 · Resumen del veredicto que motiva esta tanda

La ronda 2 de AG01 aprobó con reservas la tanda anterior (`a97206e`): los dos bloqueantes
(M10 revertía al RAW, el bloque "TU REALIDAD" se contradecía) quedaron cerrados y verificados
con el pipeline completo. Quedaron tres reservas (M1 mayor de anáfora, cap de `gastos_items`,
desglose de un solo ítem) y, aparte del veredicto de merge, una **condición de piloto agravada**:
la regla de atribución del agregado de gastos (E9 del contrato) es más estrecha de lo que el
contrato documenta — 3 de 4 fraseos naturales nuevos devolvían casi el doble del gasto real,
2 de ellos marcados `COMPLETE` (seguro y equivocado). Esta tanda cierra las tres reservas y la
condición de piloto.

---

## 1 · BLOQUEANTE DE PILOTO — regla estructural del agregado (M1)

### Causa raíz

`GASTO_AGREGADO_DETALLE_RE` (`scenario.ts`) reconoce el agregado seguido de `:` y una lista solo
si las palabras entre la keyword de gasto y la cifra están en `CONECTOR_DECLARATIVO`, una lista
cerrada de conectores. Cualquier fraseo natural fuera de esa lista ("del mes pasado fueron de",
"he gastado … en total", "rondan los … al mes") no matchea: el mensaje cae al parser de listas,
que atribuye el agregado completo a la PRIMERA partida como si fuera su importe, y el total sale
casi el doble del real — sin ninguna señal de ambigüedad, marcado `COMPLETE`.

### Solución — `detectarAgregadoEstructural` (`scenario.ts`)

Se invierte la regla: en vez de enumerar conectores, se busca estructuralmente una cifra seguida
de `:` cuyo texto posterior parsea a una lista real de ≥2 partidas con importe propio. La keyword
de gasto solo ancla DÓNDE empezar a buscar; ninguna palabra entre la keyword y la cifra, ni entre
la cifra y los dos puntos, participa en el patrón — el validador es el propio éxito del parseo de
la lista, no una enumeración. La cifra elegida es el ÚLTIMO número entre la keyword y el `:`
(descarta duraciones/plazos mencionados antes, como "en los últimos 3 meses gasté 1200:").

`GASTO_AGREGADO_DETALLE_RE` (enumeración de conectores) queda como **respaldo**: se prueba
después, solo si la detección estructural no encuentra nada. El rango de la cifra reclamada se
marca como frontera (V13), igual que antes.

Además, `GASTO_CTX`/`GASTO_AGREGADO_DETALLE_RE` ganan la forma verbal "gastado"/"gastada"
(participio, "he gastado 900 en total…"), ausente de la lista y necesaria para que la keyword se
reconozca en dos de los cuatro fraseos de la matriz.

### Tests — 10 fraseos, todos con el agregado correcto

`scenario.test.ts`, `CASOS_AGREGADO_ESTRUCTURAL` (10 fraseos parametrizados) + 2 tests dedicados:

| # | Fraseo | Agregado esperado | Resultado |
|---|---|---|---|
| conocido 1 | "mis gastos fueron 1200: internet 300, agua 400, gas 500" | 1200 | ✅ |
| conocido 2 | "mis gastos del mes son 1200: internet 300, agua 400, gas 500" | 1200 | ✅ |
| conocido 3 | "gastamos 950 al mes: mercado 500, gasolina 250, farmacia 200" | 950 | ✅ |
| conocido 4 | "gasté 1800: renta 900, comida 500, luz 400" | 1800 | ✅ |
| nuevo 1 | "en mi casa gasto normalmente 1300: comida 500, transporte 400, ocio 400" | 1300 | ✅ |
| nuevo 2 | "el total que gasto se ubica en 1100: renta 600, luz 300, agua 200" | 1100 | ✅ |
| nuevo 3 | "gasté, calculando todo, 1700 el mes pasado: hipoteca 900, super 500, gasolina 300" | 1700 | ✅ |
| nuevo 4 | "gasto, sin contar imprevistos, 1450: arriendo 800, comida 450, internet 200" | 1450 | ✅ |
| nuevo 5 | "mis gastos terminan siendo 2100 cada mes: colegio 1200, mercado 600, seguro 300" | 2100 | ✅ |
| nuevo 6 | "gastamos, entre todos los del hogar, 1600 mensuales: agua 300, gas 300, internet 1000" | 1600 | ✅ |

Más, con la redacción EXACTA de la tabla §5 de la ronda 2 (verificado aparte, no solo aproximado):

| Fraseo (AG01, ronda 2, §5) | Esperado | Antes | Ahora |
|---|---|---|---|
| "mis gastos rondan los 1000 al mes: luz 300, agua 300, gas 400" | 1000 | 1700 (`luz=1000`) `COMPLETE` | **1000** ✅ |
| "este mes he gastado 900 en total: renta 500, comida 250, bus 150" | 900 | 1800 (`"este he gastado"=900`) `COMPLETE` | **900** ✅ |
| "mis gastos del mes pasado fueron de 1500: hipoteca 800, comida 400, luz 300" | 1500 | 2200 (`hipoteca=1500`) `PARTIAL` | **1500** ✅ |
| "gasto unos 2 000 al mes: alquiler 1000, comida 600, transporte 400" | 2000 | 2000 ✅ (ya arreglado por MAYOR 3) | **2000** ✅ |

Test de respaldo: `"mis gastos fueron 1200: no sé bien en qué"` (sin lista real tras `:`) no fija
un desglose — la regla estructural nunca inventa un agregado sin partidas que lo respalden.

---

## 2 · MAYOR — la anáfora canónica del QA no se detectaba

### Causa raíz

`ANAFORA_SIN_ANTECEDENTE_RE` solo reconocía demostrativo + SUSTANTIVO (`esa cifra`, `ese monto`)
o `eso` desnudo. Demostrativo + VERBO — la construcción real del incidente que originó el
Mandamiento 10 (`"Esa es tu capacidad real…"`) — no matcheaba. 5 de 8 formas probadas por AG01 se
escapaban (2 de ellas, sin demostrativo — `"Es lo que te queda…"`, `"Ahí tienes…"` — quedan fuera
del alcance de este encargo, que pide específicamente demostrativo + verbo).

### Violación V11 de la tanda anterior (reconocida, no repetida)

El test que fijaba la frase canónica (`"Esa es tu capacidad real para destinar a ahorro o pago de
deudas."`) existía cuando M10 revertía al RAW y se **eliminó** en el rediseño, sustituido por
fixtures que sí pasaban con la regex estrecha. Borrar el mecanismo de revertir-al-RAW era
correcto (era el bloqueante); sustituir el fixture sin arreglar la detección no lo era — V11:
"si el test fallaba, el código estaba mal, no el test".

### Solución

`ANAFORA_SIN_ANTECEDENTE_RE` (`commandments.ts`) se amplía a demostrativo (ES/PT/EN: esa, ese,
esta, este, esto, eso, essa, esse, isso, isto, that, this) seguido, opcionalmente, de un clítico
(me/te/le/se/nos/os/lhe/lhes) y luego un verbo de la familia copulativa/resultativa (es, son,
sería, fue, queda, deja, permite, da, corresponde… y sus formas PT/EN) — no "cualquier verbo": una
lista abierta dispararía sobre prosa legítima sin cifras que no tiene relación con una anáfora
rota. El verbo va en un *lookahead* (`(?=...)`), así que la sustitución solo reemplaza el
demostrativo — la frase sigue leyéndose natural ("Esa es tu capacidad…" → "250 € es tu
capacidad…").

**Fix adicional descubierto al verificar la forma PT**: `\b` en JS solo reconoce
`[A-Za-z0-9_]` como carácter de palabra — el verbo PT "é" (con tilde) queda FUERA de esa
definición y `\bé\b` nunca matchea. Se sustituyen las fronteras `\b` por lookaround Unicode
(`(?<![\p{L}\p{N}_])…(?![\p{L}\p{N}_])`, flag `u`) en toda la regex.

### Test canónico repuesto (V11) — PASA

`commandments.test.ts`: *"Mandamiento 10 · CANÓNICO (repuesto, V11) — 'Esa es tu capacidad real
para destinar a ahorro o pago de deudas.' (demostrativo + verbo) se repara con la cifra
verificada"* — usa `applyEnforcement` (pipeline completo), pasa `userMessage`/`raw` como en
producción, y asserta tanto que el 250 aparece como que el resto de la frase sobrevive intacto
(`/250\s*€\s+es\s+tu\s+capacidad\s+real/i`). **Pasa.**

Más dos tests adicionales: 5 variantes ES (Ese sería…, Eso te deja…, Esa te permite…, Esta es…,
Esto queda…) y 1 forma PT con verbo acentuado ("Essa é a tua margem mensal.").

### Cobertura medida (8 formas de la tabla §3 de la ronda 2, redacción exacta)

| Frase | Antes | Ahora |
|---|---|---|
| "Esa es tu capacidad real para destinar a ahorro o pago de deudas." | ✗ publicada tal cual | ✅ reparada |
| "Ese es el margen con el que cuentas cada mes." | ✗ | ✅ reparada |
| "Esta es tu capacidad real de ahorro." | ✗ | ✅ reparada |
| "Es lo que te queda para maniobrar." *(sin demostrativo — fuera de alcance)* | ✗ | ✗ (mitigado por el reintento de route.ts) |
| "Ahí tienes tu margen mensual." *(sin demostrativo — fuera de alcance)* | ✗ | ✗ (mitigado por el reintento de route.ts) |
| "Con ese monto puedes cubrir tu meta." | ✅ | ✅ |
| "Esa cifra es la que necesitas." | ✅ | ✅ |
| "Eso te deja margen." | ✅ | ✅ |

6/8 detectadas (antes 3/8). Las 2 restantes no llevan demostrativo — no es la construcción que
este encargo pide ampliar, y el reintento acotado de `route.ts` (`cifraPedidaAusente`) las sigue
cubriendo igual que antes.

---

## 3 · MENORES

### 3.1 — Cap de `gastos_items` (§8: máx. 5 versiones por campo)

`gastos_items` acumulaba sin tope desde la 13ª tanda (memoria a nivel de usuario): el jsonb es
del USUARIO, no de la conversación, y no se recicla nunca. Nuevo campo `gastos_items_colapsados`
(clasificado en `CAMPOS_HECHOS`) + `capGastoItemsPorNombre` (mismo patrón que
`gastos_superseded`/`CAP_SUPERSEDED`): por cada partida (nombre normalizado), máximo 5 versiones;
el ACTIVO (el más reciente) nunca se recorta, solo el historial más viejo.

Test: 8 versiones de la misma partida → nunca más de 5 en el estado, el activo es siempre la
última, el contador de colapsados crece.

### 3.2 — Desglose de UN SOLO ítem por `tool_call` (V14)

`toolArgsToScenarioDelta` (`tools.ts`) exigía ≥2 ítems para registrar cualquier cosa: un
`gastos_detalle` de un solo elemento (`[{nombre: "netflix", monto: 15}]`) devolvía un delta
completamente vacío — el dato que el usuario dio desaparecía sin dejar rastro (V14, ley de
conservación). Ahora un único ítem se registra en `gastos_items` (evidencia de partida) sin fijar
`gastos_detalle`/`gastos_es_detalle` (esa clasificación agregada sigue exigiendo ≥2 partidas
reales). Dos tests nuevos en `tools.test.ts`.

### 3.3 — Esta declaración, como artefacto del repo

Sustancia de §15 paso 3 en el mensaje de commit desde la ronda 1; a partir de esta tanda, también
como archivo — la reserva `m1` de la ronda 2.

---

## 4 · Declaración de impacto — funciones tocadas y por qué

`git diff --stat` (contra `origin/develop`, `358c729`):

```
 src/lib/calculator/scenario.test.ts    |  88 ++++++++++++++++++++++
 src/lib/calculator/scenario.ts         | 130 +++++++++++++++++++++++++++++++--
 src/lib/calculator/tools.test.ts       |  19 +++++
 src/lib/calculator/tools.ts            |  13 ++++
 src/lib/guardrail/commandments.test.ts |  66 +++++++++++++++++
 src/lib/guardrail/commandments.ts      |  41 ++++++++++-
 6 files changed, 351 insertions(+), 6 deletions(-)
```

| Función | Archivo | Cambio | Motivo |
|---|---|---|---|
| `detectarAgregadoEstructural` (nueva) | `scenario.ts` | añadida | M1 — regla estructural del agregado |
| flujo de gastos en `extractScenarioDelta` | `scenario.ts` | prueba estructural primero, `GASTO_AGREGADO_DETALLE_RE` como respaldo | M1 |
| `GASTO_CTX` / `GASTO_AGREGADO_DETALLE_RE` (keywords) | `scenario.ts` | +"gastado"/"gastada" | M1 (2 de 4 fraseos de la matriz lo necesitan) |
| `capGastoItemsPorNombre` (nueva) | `scenario.ts` | añadida | 3.1 — cap §8 |
| bloque de acumulación de `gastos_items` en `mergeScenario` | `scenario.ts` | aplica el cap tras deduplicar | 3.1 |
| `ScenarioState.gastos_items_colapsados` (campo nuevo) | `scenario.ts` | añadido, clasificado en `CAMPOS_HECHOS` | 3.1 |
| `ANAFORA_SIN_ANTECEDENTE_RE` | `commandments.ts` | demostrativo+verbo (ES/PT/EN), fronteras Unicode | MAYOR 1 |
| `toolArgsToScenarioDelta` | `tools.ts` | rama `items.length === 1` | 3.2 |
| fixture de `estado` en el test de partición hechos/diálogo | `scenario.test.ts` | +`gastos_items_colapsados: 2` | mantenimiento mecánico: el test exige que TODO campo de `CAMPOS_HECHOS` tenga valor en el fixture — no cambia ninguna aserción |

### Tests modificados (ninguno debilitado — V11)

- **`scenario.test.ts`** — el fixture `estado` del test *"split: cada campo de HECHOS va a
  `hechos`…"* gana `gastos_items_colapsados: 2`. El test es exhaustivo por diseño (itera
  `CAMPOS_HECHOS`); con un campo nuevo sin valor en el fixture, fallaba por ausencia, no por una
  aserción incorrecta. Su lógica no cambia una sola línea.
- **`commandments.test.ts`** — se **repone** (no se reemplaza) el test canónico con la frase
  exacta del QA testdev8 que la tanda anterior había eliminado. Es la corrección de la violación
  V11 que motiva este documento, no una modificación adicional.
- Ningún otro test existente fue tocado. Todo lo demás en este diff son tests **nuevos**.

---

## 5 · Validación

| Comando | Resultado |
|---|---|
| `npx tsc --noEmit` | limpio |
| `npm run build` | TypeScript compila limpio; falla después en el prerender de `/login` por falta de credenciales de Supabase — entorno, no código (idéntico en `develop` sin tocar, confirmado con `git stash`) |
| `npm test` | 0 fallos |
| `npm run test:guardrail` | 0 fallos (commandments: 30 → 33) |
| `npm run test:calculator` | 0 fallos (scenario: 185 → 198, tools: 15 → 17) |
| `npm run test:regression` | 84/84 turnos · 47 escenarios · enforcement=full |
| `npm run test:e2e` / `npm run smoke:db` | sin credenciales — no verificable en este entorno (igual que en todas las tandas anteriores) |
