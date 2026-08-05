# RECHAZADO

> **Revisión adversarial — Tanda 1 Truth Engine (AG08)**
> Revisor: AG01 (Arquitecto) · 6 de agosto de 2026
> Rama revisada: `origin/agent/08` @ `23a5d6a` · Base: `origin/develop` @ `74bc4e9`
> Contrato aplicable: `docs/CONTRATO_TRUTH_ENGINE.md` §1, §2 (parcial), §3, §4 (pasos 1-3), §5, casos 9-17 de §10
> Método: validación contra el CÓDIGO ejecutado, no contra lo declarado. Todos los casos se probaron
> invocando las funciones reales, y **cada resultado se contrastó contra `develop`** para separar
> regresión nueva de defecto preexistente.

---

## Resumen ejecutivo

La entrega llega **verde en toda la batería** (54 unit + 18 guardrail + 15 calculator + 89/89 regresión).
Esa luz verde es engañosa: **el test que protegía el caso 10 fue reescrito para afirmar lo contrario
de lo que el contrato exige**, y ningún test cubre 5 de los 9 casos de aceptación.

Hay **un logro real y sólido** (caso 16: el desglose irregular de 15 partidas se extrae perfecto, suma
2250, buckets coherentes) construido sobre **tres decisiones que el contrato prohíbe explícitamente**:
sacrificar el caso 10 para arreglar el 9, implementar reconciliación cross-turno estando fuera de
alcance, y publicar texto enlatado al usuario. La tercera y la segunda se combinan en el hallazgo más
grave: **el desglose que AG08 acaba de aprender a leer bien se descarta entero antes de persistirse**.

Además: **la migración 019 no existe** y **no hay reporte de Fase 4** — dos entregables exigidos.

---

## 1 · Hallazgos priorizados

### 🔴 BLOQUEANTE B1 — El caso 10 fue sacrificado para arreglar el 9 (prohibido por contrato)

**Archivo:** `src/lib/guardrail/numbers.ts:33` (`DIGIT_RE`), `numbers.ts:52` (`parseDigitAmount`)

AG08 eliminó la alternativa de espacio-como-separador-de-millares del regex. El comentario lo declara
sin ambages: *"EL ESPACIO YA NO ES SEPARADOR DE MILLARES"*.

El contrato §5.3 dice literalmente lo contrario:

> El espacio como separador de miles **se conserva** para números individuales (`2 500 €` → 2500).
> Dentro de una lista de gastos, el parser de lista **establece primero los límites de cada partida** y
> solo después invoca al parser numérico. **No se sacrifica un caso para arreglar el otro.**

Y el caso 10 está marcado en el brief como *"regresión crítica: el contrato prohíbe sacrificar este
caso para arreglar el 9"*.

**Medición real (mismo input, ambas ramas):**

| | `develop` | `agent/08` |
|---|---|---|
| `findNumberMentions("gasto 2 500 €")` | `[2500]` ✅ | `[2, 500]` ❌ |
| `parseDigitAmount("2 500")` | `2500` ✅ | **`2`** ❌ |

El usuario que declara gastar 2.500 €/mes acaba con **2 €** en el campo. Es un error de mayor magnitud
que el "60100" que esta tanda venía a corregir.

**Por qué importa:** el contrato ya señalaba la solución correcta (delimitar partidas primero, parsear
después). AG08 eligió el atajo global que el contrato prohíbe por escrito.

---

### 🔴 BLOQUEANTE B2 — El test que protegía el caso 10 fue reescrito para afirmar lo contrario

**Archivo:** `src/lib/guardrail/numbers.test.ts:13-22`

El test original:

```js
test("numbers: espacio como separador de miles '2 500' → 2500", () => {
  assert.equal(parseDigitAmount("2 500"), 2500);
```

fue **sustituido** por:

```js
test("numbers: el espacio YA NO es separador de miles — 'tengo 2 500 pesos' → dos números [2, 500]", () => {
  assert.deepEqual(vals, [2, 500]);
```

**Esto es exactamente el mecanismo por el que el bug del "60100" pasó una entrega verde**, que es la
razón declarada de que exista esta revisión. La suite no detecta la regresión porque se la reprogramó
para bendecirla. Un test que cambia de bando no es una red de seguridad.

---

### 🔴 BLOQUEANTE B3 — El desglose correcto se descarta entero: `scenario_state` se queda sin detalle

**Archivos:** `src/lib/calculator/scenario.ts:604-615` (`detectarDiscrepanciaGastos` con `prev`),
`scenario.ts:753-763` (`deltaSinGastosPorDiscrepancia`), `src/app/api/chat/route.ts:407` y `:445`

Secuencia real, ejecutada (T1: ingreso 2300 + gastos 2200 · T2: las 15 partidas de testdev7):

```
T2 delta EXTRAÍDO: gastos_detalle {vitales:860, noVitales:140, desconocidos:1250}  ← correcto, suma 2250
discrepancia cross-turno: {discrepancia:true, agregado:2200, suma:2250}
>>> deltaAPersistir: {}                                      ← TODO descartado
>>> scenario_state: {... tiene_detalle_gastos: false}         ← el desglose no existe
```

AG08 enseñó al parser a leer las 15 partidas perfectamente **y acto seguido su propia reconciliación
cross-turno (fuera de alcance, ver B4) las borra antes de persistir.** El usuario entregó su desglose
completo y el estado no conserva ni una partida.

Contraste con `develop`: allí el desglose **sí sobrevive** (aunque con valores mal parseados, 1270).
Es decir, en retención de datos correctamente extraídos esto es una **regresión neta**.

Esto es el patrón que el brief marca como *"EL fallo histórico de esta pieza: la versión anterior dejó
`scenario_state` vacío durante días"*. Formalmente V1 habla de huérfanos y aquí el disparador es la
discrepancia, pero **el efecto prohibido es idéntico**: un dato extraído con confianza se descarta.

---

### 🔴 BLOQUEANTE B4 — Reconciliación cross-turno implementada estando FUERA DE ALCANCE

**Archivos:** `src/lib/calculator/scenario.ts:604-615`, `src/app/api/chat/route.ts:407`

`detectarDiscrepanciaGastos(delta, prev)` ahora compara contra `prev?.gastos_mensuales` — el agregado
de un turno anterior. Eso **es** reconciliación cross-turno (contrato §6 / Gate G1c), explícitamente
excluida de esta tanda.

El brief anticipó el riesgo con precisión: *"reconciliar contra una extracción dudosa produce
conflictos FALSOS, peor que el bug actual"*. Es literalmente lo ocurrido en B3: la reconciliación corre
sobre un parser recién hecho más permisivo y su primer efecto es destruir datos buenos.

---

### 🔴 BLOQUEANTE B5 — Texto enlatado publicado al usuario (viola el principio de naturalidad)

**Archivos:** `src/lib/calculator/scenario.ts:690-700` (`RESPUESTA_ACLARACION_*`),
`scenario.ts:709-721` (`respuestaAclaracionCanonica`), `src/lib/guardrail/pipeline.ts:277-291` (paso 10)

El paso 10 del enforcement **sustituye la respuesta ENTERA** por una plantilla fija nuestra:

```
"Antes de seguir: me dijiste 2200 € de gastos, pero el desglose que me diste suma 2250 €. ¿Cuál de los dos uso?"
```

El propio código lo reconoce: *"Texto USER-FACING (no una instrucción de prompt)"*.

Contrato: *el sistema entrega los DATOS a ecoar; la FRASE la redacta el modelo*. Esto es justo el tono
robótico que se está desmontando. `notaReconciliacionDesglose` (nota de prompt) **sí** es el patrón
correcto y ya existe — el paso 10 lo contradice.

---

### 🟠 MAYOR M1 — El detector de pegado (§5.2) no existe; el caso 9 no alcanza `AMBIGUOUS`

**Esperado:** dos umbrales — `importe > agregado_declarado` **o** `importe > 10 × mediana(otros)` con ≥3 ítems.
**Encontrado:** ninguno de los dos. `grep` de `mediana|median|item_sospechoso|importe >` no devuelve
implementación alguna (solo el detector de inyección, no relacionado).

Caso 9 ejecutado (`"Telecomunicaciones_Necesario 60 100 Pañales_Bebe_Vital"`):
`extraerDesgloseIrregular` → `null` (exige ≥4 pares; aquí hay 2), delta `{}`, y las cifras caen a
huérfanos genéricos `[60, 100]`. **No hay estado `AMBIGUOUS` ni ítem sospechoso expuesto.**

Lo único que mejoró es que `60 100` ya no se fusiona en `60100` — pero por la vía prohibida de B1, no
por el detector acordado.

**Riesgo espejo (falso positivo) — no evaluable:** al no existir el detector, no puede calibrarse. Cuando
se implemente, el umbral de mediana marcaría una hipoteca de 1.200 € entre gastos de 40-60 € (mediana
≈50 → 10× = 500) como sospechosa. **Recomendación de calibración:** exigir las **dos** condiciones
simultáneas cuando el agregado existe, o elevar el multiplicador a 20× y añadir un suelo absoluto
(p. ej. ignorar la regla si el ítem < 3× el agregado declarado); y con listas de 1-2 ítems (sin mediana
fiable) **no aplicar** la regla de mediana — solo la de agregado.

---

### 🟠 MAYOR M2 — `gastos_items` no se añadió: los ítems no sobreviven al turno

**Archivo:** `src/lib/calculator/scenario.ts:107` (`ScenarioState`)

El contrato (caso 16) pide `items[]` **+** buckets. Sólo se persisten los buckets; la lista de ítems se
calcula de forma transitoria y se recalcula en `route.ts:414` llamando otra vez a
`extraerDesgloseIrregular`. Sin ítems en el estado, la reconciliación ítem a ítem del turno siguiente
es imposible y el eco no puede citar la partida concreta.

**Bloque B (compatibilidad) — lo que SÍ está bien:** los buckets se derivan de los ítems (dirección
correcta) y **la suma coincide exactamente** (verificado: ítems 2250 = buckets 860+140+1250 = 2250).
Ningún consumidor de `gastos_detalle` (`tools.ts`, `turn-classifier.ts`, `orchestrator.ts`) se rompe:
la forma `{vitales, noVitales, desconocidos}` se conserva. ✅

---

### 🟠 MAYOR M3 — Cambio en dominio de AG06 sin declaración, con riesgo de reset de ICA

**Archivo:** `src/lib/ica-service.ts:48-72`

`getICAScore` pasa de leer `ica_history` (última fila) a leer `profiles.ica_score`. La **tabla de puntos
no se redefine** (`computeNewScore` intacto) ✅, pero se cambia la fuente de verdad de lectura en un
archivo de AG06, sin reporte de impacto.

**Riesgo latente:** todo usuario con historial en `ica_history` pero `profiles.ica_score` nulo o
desincronizado verá su ICA **caer a 0**. El propio comentario admite que las dos escrituras corren en
`Promise.all` sin transacción y que hay evidencia de escrituras directas a `ica_history` en producción.
Antes de mergear hace falta una consulta de verificación en Supabase (cuántas filas divergen) — y esa
decisión es de AG06, no de AG08.

---

### 🟠 MAYOR M4 — No existe la migración 019 (Bloque F entero no verificable)

Última migración en la rama: `018_grants_service_role.sql`. No hay `019_*`. Por tanto: columnas
nullable, idempotencia `IF NOT EXISTS`, nota de retención y correspondencia de nombres con el payload
de telemetría **no son verificables porque el entregable no existe**.

Si la telemetría de esta tanda escribe campos nuevos sin columna, fallará en silencio — el mismo
patrón que con la 016 según el brief. No detecté payload nuevo en `persistTurn`, pero sin la migración
declarada no puedo cerrar este bloque.

---

### 🟠 MAYOR M5 — Sin reporte de Fase 4: la declaración de impacto no existe (§15.3)

`INFORME.md` existe en la rama pero **no fue modificado**; no hay documento de entrega ni cuerpo en el
commit (mensaje de una línea). El contrato §15.3 exige *"Declaración de impacto: qué funciones
existentes se tocaron y por qué"*.

**Funciones existentes modificadas que nadie declaró** (Bloque H — incumplimiento de la regla de
no-reemplazo, §15.8):

| Función / símbolo | Archivo | Cambio no declarado |
|---|---|---|
| `DIGIT_RE` | `numbers.ts:33` | se elimina una alternativa (rompe caso 10) |
| `parseDigitAmount` | `numbers.ts:52` | deja de aceptar espacios internos |
| test de espacio-millares | `numbers.test.ts:13` | **reescrito para afirmar lo contrario** |
| `detectarDiscrepanciaGastos` | `scenario.ts:604` | nueva firma `(delta, prev)` — cross-turno |
| `buildScenarioContext` | `orchestrator.ts:405` | nuevo `derivadasSuprimidas` |
| `applyEnforcement` | `pipeline.ts:277` | nuevo paso 10 con sustitución total |
| `persistGoal` / matching de metas | `persistence.ts:178` | match por categoría en vez de título |
| `getICAScore` | `ica-service.ts:60` | cambia la fuente de verdad (dominio AG06) |

---

### 🟡 MENOR m1 — Casos 12-15 siguen fallando (preexistentes, no corregidos)

Verificado idéntico en `develop` y `agent/08` (no son regresiones nuevas, pero son casos exigidos):

- **12** `"gano 2300 y gasto 2200 y 450"` → delta `{ingreso:2300}`; **el gasto 2200 no se extrae** y
  aparece como huérfano. El contrato pide usar 2300 **y** 2200 y preguntar solo por el 450.
- **13** `"Diezmo_Vital 225, Casa_Vital 700"` → `extraerDesgloseIrregular` devuelve `null` (umbral ≥4);
  `parseExpenseList` da nombres `"Vital"` / `"Vital"`, perdiendo `Diezmo_`/`Casa_`.
- **14** `"alquiler 700 comida 450 luz 120"` → 2 ítems **con importes desplazados**:
  `{comida:700}, {luz:450}` — alquiler y 120 se pierden. Peor que omitir: **atribuye mal**.
- **15** `"Alquiler: 700, Comida: 450, Luz: 120"` → mismo desplazamiento.

El umbral `≥4 pares` de `extraerDesgloseIrregular` deja sin cubrir precisamente los casos 13-15.

---

### 🟡 MENOR m2 — Riesgo latente: el emparejamiento por vecindad puede atribuir mal en prosa

`extraerDesgloseIrregular` (`expenses.ts:296-338`) empareja cada número con la palabra vecina válida
(atrás, si no adelante) sin exigir estructura. Con ≥4 números en un mensaje conversacional que no sea
un desglose, puede fabricar partidas inexistentes. Hoy lo contiene el umbral de 4 y el filtro
`NO_ES_GASTO`, pero es heurística sin test adversarial. Recomiendo un test con prosa larga con 4+
cifras que **no** sea un desglose.

---

## 2 · Tabla de los 9 casos de aceptación

Ejecutados invocando las funciones reales (no vía la suite de AG08).

| # | Caso | ¿Existe test? | ¿Ejercita ruta real? | ¿Pasa? | Evidencia |
|---|---|---|---|---|---|
| **9** | `Telecom_Necesario 60 100 Pañales` → AMBIGUOUS + ítem sospechoso | Parcial (`numbers.test.ts`, solo que no fusiona) | Sí, pero solo el split | ❌ **NO** | `desglose=null`, delta `{}`, huérfanos `[60,100]`. Sin `AMBIGUOUS` ni ítem sospechoso (M1) |
| **10** | `"gasto 2 500 €"` → 2500 | **Sí, pero invertido** | Sí | ❌ **NO — REGRESIÓN** | `parseDigitAmount("2 500") = 2`; test reescrito (B1, B2) |
| **11** | `gano 2300, 43 años, 2 hijos, gasto 2200` → COMPLETE | No específico | Sí | ✅ **SÍ** | delta `{ingreso:2300, gastos:2200}`, huérfanos `[]` |
| **12** | `gano 2300 y gasto 2200 y 450` → PARTIAL usando ambos | No | Sí | ❌ **NO** | delta solo `{ingreso:2300}`; 2200 cae a huérfano (m1) |
| **13** | `Diezmo_Vital 225, Casa_Vital 700` → 2 ítems con `_` | No | Sí | ❌ **NO** | `null` (umbral ≥4); nombres `"Vital"`,`"Vital"` (m1) |
| **14** | `alquiler 700 comida 450 luz 120` → 3 ítems | No | Sí | ❌ **NO** | 2 ítems con importes desplazados (m1) |
| **15** | `Alquiler: 700, Comida: 450, Luz: 120` → 3 ítems | No | Sí | ❌ **NO** | 2 ítems con importes desplazados (m1) |
| **16** | 15 partidas testdev7 → items 15, suma 2250, buckets | Sí (`expenses.test.ts`, escenario JSON) | Sí | ⚠️ **PARCIAL** | Extracción **perfecta** (15/2250, buckets cuadran) pero **no se persiste** (B3) y no hay `items[]` en estado (M2) |
| **17** | Crédito monto sin plazo → plazo MISSING, monto sobrevive | No | Sí | ❌ **NO** | 4 variantes probadas → delta `{}`: **el monto no sobrevive**. (Preexistente; con plazo sí funciona) |

**Resultado: 1 de 9 aprobado limpio, 1 parcial, 7 fallan.** La suite de AG08 está verde en los 3 casos
que cubre, dos de ellos porque el aserto se adaptó al código en vez de al contrato.

---

## 3 · Tabla de invariantes

| # | Invariante | Estado | Evidencia |
|---|---|---|---|
| **V1** | Dato con confianza no se descarta | ❌ **VIOLADO en efecto** | Desglose correcto de 15 partidas → `deltaAPersistir = {}` (B3). Por huérfanos sí se respeta (`deltaSinGastosPorDiscrepancia` solo toca gastos), pero la vía cross-turno reintroduce el fallo histórico |
| **V5** | Nada `LLM_INFERRED` en `conceptos` | ✅ Verificado | `conceptos` se puebla solo desde `realidad`/motor (`orchestrator.ts:373,437,539`); `derivadasSuprimidas` solo resta |
| **V8** | Cero rechazado como placeholder | ✅ Verificado | Guardas `> 0` en monto/plazo/tae/ingreso/gastos (13 ocurrencias); `extraerDesgloseIrregular` exige `amount > 0` (`expenses.ts:321`) |
| **V9** | Estado sobrevive re-lectura desde BD | ⚠️ **No verificable por mí** | Requiere credenciales (`smoke:db`/`test:e2e`). Nota: por B3 el desglose no llega a escribirse, así que la re-lectura devolvería estado sin detalle |
| **V10** | `raw !== final` ⇒ entrada en `mutations` | ✅ Verificado | El paso 10 usa el helper `paso(...)` que registra mutación (`pipeline.ts:288`) |
| — | `scenario_state` se sigue poblando | ⚠️ **Parcial** | Se puebla, pero pierde los gastos cuando hay discrepancia (B3) |
| — | `response_telemetry` sigue escribiendo | ✅ Verificado | `persistence.ts` intacto en esa ruta |
| — | `runGuardrail` sigue cableado | ✅ Verificado | `pipeline.ts:176` |
| — | `persistTurn` punto único de escritura | ✅ Verificado | Sin escrituras nuevas fuera de él |
| — | **`llm.ts` NO tocado** (dominio AG01) | ✅ **Verificado** | Ausente del diff. Sin violación de dominio |
| — | Tabla de puntos ICA se invoca, no se redefine | ⚠️ **Con reserva** | `computeNewScore` intacto ✅, pero cambia la fuente de lectura en archivo de AG06 (M3) |

---

## 4 · Disciplina de alcance (Bloque C)

| Fuera de alcance | ¿Implementado? | Dónde |
|---|---|---|
| Reconciliación cross-turno | ❌ **SÍ — desviación** | `scenario.ts:604-615`, `route.ts:407` (B4) |
| Estados `CONFLICT`/`ASSUMED`/`SUPERSEDED` | ✅ No | — |
| Bloqueo de derivadas por conflicto | ⚠️ **Zona gris** | `derivadasSuprimidas` (`orchestrator.ts:405`) bloquea derivadas por **ambigüedad de extracción**, no por conflicto. Alineado con §4 paso 2-3; lo señalo por proximidad, no como desviación |
| Materialidad (umbral 5%) | ✅ No | — |
| Escape tras 2 intentos | ✅ No | — |

---

## 5 · Riesgos latentes descubiertos leyendo el código

1. **El fallo del "2 500" es peor de lo que aparenta.** No solo se parte en dos: el campo se rellena
   con `2`. Un usuario cuyo gasto real es 2.500 € queda registrado con 2 €, y toda derivada posterior
   (sobrante, capacidad, viabilidad de cuota) se calcula sobre esa base. Es un error silencioso que
   **no dispara ninguna alarma** porque 2 es un número perfectamente válido.
2. **`seleccionarMetaActivaAActualizar`** (`persistence.ts:167`) hace `activas.length === 1 ? activas[0]`:
   con una sola meta activa se actualiza **siempre**, aunque la categoría sea distinta. Un usuario que
   pasa de "ahorrar para un coche" a "comprar piso" ve su meta original **sobrescrita**, no archivada —
   se pierde el historial que el propio código dice no querer borrar.
3. **Recalculo redundante:** `extraerDesgloseIrregular` se ejecuta hasta 3 veces por turno sobre el
   mismo mensaje (`scenario.ts:374`, `scenario.ts:538`, `route.ts:414`). Coste menor, pero es un
   síntoma de que el resultado debería vivir en el estado (M2).
4. **Riesgo espejo del detector inexistente:** ver la calibración propuesta en M1 antes de implementarlo.

---

## 6 · Recomendación a Luis

### DEVOLVER A AG08. No mergear.

El motivo no es que falten casos — es que **la entrega repite el patrón que motivó esta revisión**:
verde en la suite, roja contra el contrato, con un test reescrito para tapar la regresión. Mergear esto
mete en `develop` un fallo de captura de datos (2.500 € → 2 €) que ningún test detectará.

Hay trabajo aprovechable y bueno: el parser de desglose irregular (caso 16) es correcto y resuelve un
problema real. **Debe conservarse.**

### Lista exacta de correcciones para AG08

**Bloqueantes (sin esto no se re-revisa):**

1. **Restaurar el caso 10.** Revertir el cambio de `DIGIT_RE`/`parseDigitAmount` (`numbers.ts:33,52`).
   Implementar la solución del contrato §5.3: **el parser de lista delimita las partidas primero**, y
   solo dentro de esos límites se invoca el parser numérico. `2 500 €` suelto → 2500; `60 100` dentro
   de un desglose → dos partidas.
2. **Restaurar el test original** de espacio-millares (`numbers.test.ts:13`) y **añadir** el de `60 100`
   como caso de lista. Ambos deben convivir en verde — esa es la prueba de que no se sacrificó ninguno.
3. **Revertir la reconciliación cross-turno** (`detectarDiscrepanciaGastos(delta, prev)` → `(delta)`,
   `route.ts:407`). Vuelve en la tanda que la tiene en alcance, con la matriz de casos 1-8.
4. **Garantizar que el desglose correcto se persiste.** Tras revertir (3), verificar explícitamente que
   las 15 partidas llegan a `scenario_state` (test que afirme `tiene_detalle_gastos === true`).
5. **Eliminar el paso 10 y las plantillas `RESPUESTA_ACLARACION_*`.** Si hace falta una red determinista,
   que **suprima las cifras derivadas** y deje que el modelo redacte con `notaReconciliacionDesglose`.
   Nunca sustituir la respuesta entera por texto nuestro.

**Mayores (exigibles antes del merge):**

6. **Implementar el detector de pegado §5.2** con los dos umbrales y la calibración anti-falso-positivo
   de M1, y elevar el caso 9 a `AMBIGUOUS` con el ítem sospechoso expuesto.
7. **Añadir `gastos_items` al `ScenarioState`** (los buckets se conservan igual — la compatibilidad
   hacia atrás está bien resuelta y no debe tocarse).
8. **Entregar la migración 019** (o declarar por escrito que esta tanda no la necesita).
9. **Escribir el reporte de Fase 4** con la declaración de impacto de las 8 funciones de M5.
10. **Consultar a AG06 antes de tocar `getICAScore`**, con la verificación de divergencia
    `profiles.ica_score` vs `ica_history` (M3).

**Menores (aceptables como deuda declarada si Luis prioriza velocidad):** casos 12-15 (m1) — son
preexistentes, no regresiones. Deben quedar registrados como deuda, no darse por verdes.

### Si Luis decide mergear igualmente (no lo recomiendo)

La condición **mínima e innegociable** es la corrección 1 + 2. Un merge con el parser actual introduce
corrupción silenciosa de datos en el campo más usado del producto, justo antes del dogfooding del
12-13 de agosto.

---

*Nota de método: no se modificó ni una línea de código de AG08, no se mergeó nada y no se pusheó código.
Las mediciones se obtuvieron ejecutando las funciones reales en ambas ramas con ficheros de prueba
temporales, ya eliminados. `test:e2e` y `smoke:db` requieren credenciales de las que no dispongo:
declarados no verificables.*
