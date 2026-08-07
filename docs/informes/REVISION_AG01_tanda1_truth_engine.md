# APROBADO CON RESERVAS

> **VEREDICTO VIGENTE** — quinta revisión, `agent/08` @ `402589f`, 7 de agosto de 2026.
> Los dos bloqueantes de la cuarta revisión están cerrados (fronteras posicionales por rango).
> **Ir a [QUINTA REVISIÓN](#quinta-revisión--agent08--402589f--7-de-agosto-de-2026) para el informe vigente.**
>
> Este documento es acumulativo: conserva las cinco revisiones en orden cronológico, porque la
> trazabilidad de qué se rechazó y por qué es parte de la auditoría. Los veredictos de las
> revisiones 1-4 (todos RECHAZADO) son **históricos** y se refieren a commits ya superados.

| # | Commit revisado | Fecha | Veredicto |
|---|---|---|---|
| 1 | `23a5d6a` | 6 ago | RECHAZADO — rama anterior al contrato + regresión del caso 10 |
| 2 | (adenda) | 6 ago | RECHAZADO — hallazgo de proceso: la entrega real estaba sin publicar |
| 3 | `f4f3561` | 6 ago | RECHAZADO — B1: partida perdida al compartir segmento con el ingreso |
| 4 | `a83957a` | 6 ago | RECHAZADO — B1 residual (1 de 3) + B2: frontera global por palabra |
| **5** | **`402589f`** | **7 ago** | **APROBADO CON RESERVAS** — bloqueantes cerrados; 3 condiciones de proceso |

---
---

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


---
---

# ADENDA — segunda pasada de revisión · 6 de agosto de 2026

> Esta adenda es una **segunda revisión independiente**, ejecutada después del informe de
> arriba y conservada junto a él por petición de Luis. Coincide con la primera pasada en el
> veredicto (RECHAZADO) y en el hallazgo bloqueante del caso 10, pero **añade un hallazgo de
> proceso que la primera no detectó**: la rama que el encargo manda revisar (`origin/agent/08`)
> es anterior al contrato, y existe un commit local sin publicar (`a00ff11`) que sí implementa
> el Truth Engine — incluida la migración 019 que la primera pasada dio por inexistente.
> Donde ambas difieren sobre "la migración 019 no existe", manda esta adenda: no existe en
> `origin/agent/08`, sí existe en `a00ff11`.

---

# Revisión adversarial — AG01 sobre AG08, tanda 1 "Truth Engine"

**VEREDICTO: RECHAZADO** (la rama que el encargo pide revisar — `origin/agent/08` — no
contiene ninguna implementación del Truth Engine y no puede juzgarse contra el contrato).
**Nota crítica de proceso:** existe una entrega distinta, no publicada, que sí parece
implementar el contrato — ver §0. Recomendación operativa para Luis al final del documento.

---

## 0 · Hallazgo previo a cualquier otro: la rama a revisar no es la rama correcta

Antes de evaluar una sola línea de código, la cronología desmonta el encargo tal como está
planteado:

| Hito | Commit | Fecha |
|---|---|---|
| Base común (`merge-base`) | `8624a3c` | — |
| `docs/CONTRATO_TRUTH_ENGINE.md` se añade a `develop` | `74bc4e9` | **2026-08-05 23:48** |
| `origin/agent/08` (la rama que el encargo pide revisar) | `23a5d6a` | **2026-07-31 23:27** |
| Commit local sin publicar, en el worktree de AG08 (`wt-ag08-consigliere`) | `a00ff11` | **2026-08-06 00:21** |

**`origin/agent/08` (`23a5d6a`) fue commiteado 5 días ANTES de que el contrato existiera.**
No es una versión antigua del Truth Engine — es de OTRA tanda ("8ª tanda", fixes de
`testdev7`: parser de números, desglose irregular, mensaje repetido, meta única, ICA fuente
única), completada y cerrada antes de que Luis y AG08 acordaran el contrato el 5 de agosto.
El archivo del contrato ni siquiera existe en esa rama (`git show origin/agent/08:docs/CONTRATO_TRUTH_ENGINE.md`
→ `fatal: path does not exist`). Ninguno de los términos del contrato
(`EXTRACTION_STATUS`, `FACT_STATUS`, `item_sospechoso`, `gastos_items`, migración `019`,
columnas nuevas de `response_telemetry`) aparece en esa rama.

**Mientras tanto, existe un commit local, `a00ff11`** ("ag08: extracción honesta —
EXTRACTION_STATUS + huérfanos clasificados + detector de pegado + items preservados + eco
como promotor de confianza"), fechado **después** del contrato, que sí usa exactamente ese
vocabulario, sí añade `supabase/migrations/019_telemetry_extraction.sql`, y sí toca
`telemetry.ts`/`telemetry-purge.ts`. Vive únicamente en el worktree local
`/home/andgcore/projects/wt-ag08-consigliere` (rama local `agent/08`, que ha divergido de
`origin/agent/08` — comparte el mismo padre `8624a3c` pero **no** contiene el commit
`23a5d6a`). **Nunca se ha publicado a `origin`.**

Instrucción del encargo: `git fetch origin agent/08:refs/remotes/origin/agent/08`. Seguida
al pie de la letra, esa instrucción solo puede traer `23a5d6a` — la rama equivocada. Lo
seguí, y por eso el veredicto formal sobre "la rama a revisar" es RECHAZADO: no es una
entrega del Truth Engine, es un cuerpo de trabajo distinto que no se puede juzgar contra el
contrato de §1-§5.

**Dado que rechazar sin más habría sido inútil para Luis**, evalué también `a00ff11` con el
mismo rigor adversarial (mismo checklist, misma batería de tests, mismas verificaciones
empíricas) porque es, con alta probabilidad, la entrega real que este encargo pretendía que
yo revisara. Ambos análisis están documentados abajo, claramente separados.

---

## 1 · Revisión de `origin/agent/08` (`23a5d6a`) — la rama formalmente solicitada

No implementa nada del contrato (§1-§5 ausentes por completo: no hay `EXTRACTION_STATUS`,
no hay `FACT_STATUS`, no hay detector de pegado/mediana, no hay `gastos_items`, no hay
migración). Aun así, contiene un **hallazgo bloqueante concreto y verificado empíricamente**
que vale la pena documentar porque si esta rama llegara a mergearse por error, rompería
producción:

### BLOQUEANTE — Regresión del caso 10, exactamente la que el contrato prohíbe sacrificar

- **Archivo:** `src/lib/guardrail/numbers.ts:1031-1033` (`DIGIT_RE`), tanda `23a5d6a`.
- **Qué hace:** para arreglar el caso 9 ("60 100" pegándose en 60100), elimina por completo
  la alternativa de miles-con-espacio del regex. El propio commit reescribe el test
  histórico para afirmar el nuevo comportamiento (`numbers.test.ts:970-981`: *"el espacio YA
  NO es separador de miles"*).
- **Por qué importa:** lo verifiqué ejecutando el código real, no leyendo el test:
  ```
  extractScenarioDelta('gasto 2 500 €') → { gastos_mensuales: 2 }
  ```
  Un usuario que escribe "gasto 2 500 €" (separador de miles con espacio, uso común en ES/
  LatAm) ve su gasto registrado como **2 €** en vez de **2.500 €** — corrupción silenciosa
  de datos financieros, exactamente el tipo de fallo que el Truth Engine existe para evitar.
- El contrato (§10, caso 10) lo anticipa **por su nombre**: *"regresión crítica: el contrato
  prohíbe sacrificar este caso para arreglar el 9"*. `23a5d6a` hace precisamente eso — antes
  de que el contrato existiera, así que no es una violación consciente, pero el CÓDIGO tal
  como está en `origin/agent/08` hoy comete la regresión que el contrato luego prohibió
  explícitamente. Si esta rama se toca en algún momento, este es el primer bug a corregir.
- `a00ff11` (§2 más abajo) resuelve el mismo problema con el detector de pegado
  estructural, SIN sacrificar el caso 10 — verificado con test dedicado (`caso 10 (regresión)`,
  `scenario.test.ts`) y confirmado en mi propia ejecución de la suite.

### Otros hallazgos sobre `23a5d6a` (informativos, dado que no se recomienda usar esta rama)

- **Bloque E (detector de pegado) ausente por completo** — `grep -rn "sospechoso|mediana"
  src/` no devuelve nada. El único mecanismo de "ítem sospechoso" del contrato no existe en
  esta rama.
- **`derivadasSuprimidas` es un bloqueo global, no granular** — `orchestrator.ts:504`
  (`if (!derivadasSuprimidas && scenario.credito...)`) bloquea la cuota del crédito
  (que solo depende de monto/plazo/TAE) cuando la ambigüedad es de gastos. El propio
  `a00ff11` corrigió este patrón en una tanda anterior (6ª) precisamente por el incidente
  `testdev5` — ver `orchestrator.ts:377-388` de `a00ff11`, que lo documenta como "BUG
  BLOQUEANTE" ya resuelto. `23a5d6a` reintroduce el mismo patrón de supresión global.
- **Bloque G — eco como plantilla fija:** `scenario.ts` (`RESPUESTA_ACLARACION_DISCREPANCIA`,
  `RESPUESTA_ACLARACION_HUERFANOS`) son strings literales por idioma que se publican
  **verbatim** al usuario como respuesta completa cuando el guardarraíl determinista
  sustituye la respuesta del modelo (`pipeline.ts` paso 10). Es un último recurso (el modelo
  ya recibió la instrucción antes), pero cuando se dispara, el usuario recibe texto enlatado,
  no redactado por el modelo — contradice la letra de §0/Bloque G del contrato.
- **Tests que sí ejercitan la ruta real:** verificado — `regression-harness.ts` corre
  `extractScenarioDelta` → `detectarNumerosHuerfanos`/`detectarDiscrepanciaGastos` →
  `buildScenarioContext` → `runGuardrail` reales contra el `fixtureResponse`, no una
  heurística de comparación de texto. Única salvedad: el harness **reimplementa en línea**
  (pasos 6-16) la misma secuencia que `pipeline.ts::applyEnforcement` en vez de llamarla
  directamente — el test unitario de `enforcement.test.ts` sí llama a `applyEnforcement`
  real, pero los escenarios JSON (incluidos los nuevos de esta tanda) pasan por la copia
  duplicada del harness. Riesgo preexistente (no introducido por esta tanda), documentado en
  §5.

---

## 2 · Revisión de `a00ff11` — el commit local no publicado, probable entrega real

Evaluado con el mismo rigor: leí el diff completo contra `develop` (`74bc4e9`), ejecuté
`npm run build`, `npm test`, `npm run test:guardrail`, `npm run test:calculator` y
`npm run test:regression` en un worktree aislado (`git worktree add ... a00ff11 --detach`,
sin tocar el worktree real de AG08 ni el mío). `test:e2e` y `smoke:db` no se ejecutaron
(requieren credenciales que no tengo — no verificable por mí, tal como anticipa el encargo).

### Resultado de la batería

| Suite | Resultado |
|---|---|
| `npm run build` | TypeScript compila limpio; falla el prerender de `/login` por falta de credenciales Supabase — **falla igual en `develop` sin tocar nada**, confirmado comparando ambos builds. No es un defecto de esta tanda. |
| `npm test` | 14/14 |
| `npm run test:guardrail` | 262/262 |
| `npm run test:calculator` | 181/181 (incluye los 9 casos de aceptación con nombre explícito `caso 9`…`caso 17`) |
| `npm run test:regression` | 84/84 turnos, 47 escenarios — sin regresión sobre el corpus existente |
| `test:e2e` / `smoke:db` | No verificable por mí (credenciales) |

### Bloque A — Invariantes

| Invariante | Estado | Evidencia |
|---|---|---|
| V1 (huérfanos no descartan datos con confianza) | **Verificado** | `analizarExtraccion`/`notaExtraccionAmbigua` no tocan el delta; comentario explícito "el ítem SÍ se usa" (`scenario.ts:752-755`). Test `caso 12` confirma `ingreso_mensual`/`gastos_mensuales` se usan pese al huérfano 450. |
| V5 (LLM_INFERRED nunca en `conceptos`) | **No tocado, no regresado** | Diff no toca el mecanismo de grounding existente. |
| V8 (cero rechazado como placeholder) | **Verificado, reforzado** | `detectarValoresInvalidos` (`scenario.ts`) hace VISIBLE (vía `extraction_status=INVALID`) un rechazo que antes era silencioso — mejora, no regresión. |
| V9 (sobrevive re-lectura de BD) | **No verificable directamente en este diff** | Los campos nuevos (`gastos_items`, `factStatus`, `eco_pendiente`, `extraction_status`) son JSON plano dentro de `scenario_state` (mismo mecanismo de persistencia que el resto del estado, sin serialización especial) — debería heredar la garantía existente, pero no hay un test dedicado de round-trip para los campos nuevos en esta tanda. |
| V10 (`raw !== final` ⇒ entrada en `mutations`) | **No aplica — no se tocó** | Esta tanda no añade ninguna sustitución de texto nueva (a diferencia de `23a5d6a`). |
| `scenario_state` sigue poblándose / `response_telemetry` sigue escribiendo / `runGuardrail` cableado / `persistTurn` único punto de escritura | **Verificado** | `route.ts:731` (`persistTurn`), payload de telemetría extendido correctamente, sin escrituras paralelas nuevas. |
| `llm.ts` no tocado | **Verificado** | No aparece en el diff. |
| Tabla de puntos ICA se invoca, no se redefine | **Verificado** | `ica-service.ts` no aparece en el diff. |

### Bloque B — Compatibilidad hacia atrás

- `gastos_detalle` (buckets `vitales`/`noVitales`/`desconocidos`) **no cambia de forma**.
  Consumidores localizados (`turn-classifier.ts:138`, `tools.ts`, `orchestrator.ts` vía
  `parseExpenseList`) siguen intactos y con tests en verde.
- `gastos_items` es **puramente aditivo** (`ScenarioState.gastos_items?`).
- Flujo verificado como items → clasificación → buckets, nunca al revés: test explícito en
  `expenses.test.ts` ("caso 16") y `scenario.test.ts` que aserta que la suma de buckets
  coincide con la suma de items.

### Bloque C — Disciplina de alcance

`grep -rln "CONFLICT|ASSUMED|SUPERSEDED|EXTRACTION_STATUS|FACT_STATUS" src/` (más allá de
los propios tipos `ExtractionStatus`/`FactStatus` de esta tanda) no devuelve nada:
sin reconciliación cross-turno, sin `CONFLICT`/`ASSUMED`/`SUPERSEDED`, sin materialidad, sin
escape tras 2 intentos. El caso 16 se implementó exactamente como pide el contrato — "suma
disponible para reconciliar", no reconciliación en sí — con un test que verifica la suma
(2250) y los buckets, sin comparar contra un T1 previo. Alcance respetado con precisión.

### Bloque D — Los 9 casos de aceptación

Los nueve casos existen como tests **con el mismo número que el contrato** (`caso 9` …
`caso 17`), en `expenses.test.ts` (capa de parseo aislado) y `scenario.test.ts` (capa de
pipeline completo, `extractScenarioDelta` → `analizarExtraccion`). Ejecuté la suite real
(no leí solo el reporte): todos pasan.

| # | Caso | Test existe | Ejercita ruta real | Pasa |
|---|---|---|---|---|
| 9 | `"...60 100 Pañales_Bebe_Vital"` → AMBIGUOUS, item_sospechoso | Sí (`expenses.test.ts`, `scenario.test.ts`) | Sí — `parseExpenseListDetallado`/`analizarExtraccion` reales | ✅ |
| 10 | `"gasto 2 500 €"` → 2500, COMPLETE | Sí (`scenario.test.ts`) | Sí — `extractScenarioDelta` real | ✅ (verificado también por ejecución directa mía) |
| 11 | `"gano 2300, tengo 43 años, 2 hijos, gasto 2200"` → COMPLETE | Sí | Sí | ✅ |
| 12 | `"gano 2300 y gasto 2200 y 450"` → PARTIAL | Sí | Sí | ✅ |
| 13 | `"Diezmo_Vital 225, Casa_Vital 700"` → 2 ítems con `_` | Sí | Sí | ✅ |
| 14 | `"alquiler 700 comida 450 luz 120"` → 3 ítems | Sí | Sí | ✅ |
| 15 | `"Alquiler: 700, Comida: 450, Luz: 120"` → 3 ítems | Sí | Sí | ✅ |
| 16 | 15 partidas testdev7 → `items[]` + buckets, suma 2250 | Sí | Sí | ✅ |
| 17 | Crédito con monto sin plazo → `MISSING`, nunca 0 | Sí | Sí (usa `toolArgsToScenarioDelta`, la ruta real del tool-call del LLM) | ✅ |

### Bloque E — Detector de pegado

Ambos umbrales están implementados y **son dos mecanismos complementarios**, no uno solo:

1. **Estructural** (`resolverPegado`, `expenses.ts`): dos tokens NUM-NUM adyacentes por un
   solo espacio se separan si hay un nombre disponible para reclamar el segundo — cubre el
   caso 9 incluso con solo 2 ítems, donde no hay mediana fiable.
2. **Por magnitud** (`detectarItemSospechosoPorMagnitud`): `importe > agregado_declarado` **o**
   `importe > 10×mediana(otros)` con `items.length >= 3` — coincide exactamente con los dos
   umbrales del contrato (§5.2), y explícitamente exige ≥3 ítems antes de calcular mediana
   (`expenses.ts:482`), respondiendo directamente a la pregunta del encargo sobre listas de
   1-2 ítems.

**Riesgo de calibración que el encargo pide reportar, confirmado:** el umbral `10×mediana`
puede producir un falso positivo con un gasto legítimamente grande. Ejemplo del propio
encargo — una hipoteca de 1.200 entre partidas de 40-60 (mediana ≈ 50) es 24× la mediana →
se marca `item_sospechoso` aunque sea un dato real. **Mitigación ya presente:** el ítem
sospechoso **no bloquea** el cálculo (`notaExtraccionAmbigua` deja claro "el ítem SÍ se usa
con normalidad… solo se pregunta"), así que el falso positivo cuesta una pregunta de
confirmación innecesaria, no un bloqueo — es el diseño correcto dado el trade-off, pero vale
la pena que Luis lo sepa antes de calibrar el umbral con datos reales de piloto.

### Bloque F — Migración 019

- **Nullable:** las 5 columnas son `text`/`jsonb` sin `NOT NULL` ni default obligatorio — no
  rompe inserts existentes.
- **Idempotente:** `add column if not exists` en las 5, `create index if not exists`.
- **No se ejecutó desde el agente** — es un archivo `.sql` sin ejecutar; la ejecución queda
  para Luis según el protocolo del proyecto.
- **Nota de retención:** presente y explícita, tanto en el comentario de cabecera de la
  migración como en `comment on column` por columna, y coherente con
  `telemetry-purge.ts` actualizado en el mismo commit (las 4 columnas nuevas entran en la
  purga de 30 días, no en la retención indefinida de las métricas).
- **Coincidencia payload↔columna:** verificado carácter por carácter —
  `payload.extractionStatus → extraction_status`, `payload.deltaRaw → delta_raw`,
  `payload.previousScenario → previous_scenario`, `payload.mergedScenario → merged_scenario`,
  `payload.expenseItems → expense_items` (`telemetry.ts:106-113` vs `019_telemetry_extraction.sql:1343-1347`).
  Coincide exactamente — no hay riesgo del desajuste silencioso que ya ocurrió con la 016.

### Bloque G — El eco no es una plantilla

`notaExtraccionAmbigua` con `itemSospechoso` (`scenario.ts`) devuelve una **instrucción de
prompt** ("POSIBLE CIFRA PEGADA: {sugerencia}. Pregunta con calidez…"), no un string que se
publique tal cual. A diferencia de `23a5d6a`, esta tanda **no añade ningún mecanismo de
sustitución determinista de la respuesta completa** — el modelo sigue siendo quien redacta
la frase en todos los casos. Cumple la letra y el espíritu del principio.

### Bloque H — Declaración de impacto

**No existe un documento de "Declaración de Impacto" separado** — ni en el commit, ni como
archivo adjunto, igual que en `23a5d6a`. Es un incumplimiento del paso 3 de §15 del
contrato en sentido estricto. Mitigante parcial: el propio diff lleva comentarios
extensos y específicos justificando cada modificación de lógica existente (por ejemplo, por
qué se eliminaron `parseExpenseListNameFirst`/`parseExpenseListAmountFirst` y se
reemplazaron por el pipeline `tokenizeSegment → resolverPegado → emparejarNombreMonto`), y
la función pública `parseExpenseList` mantiene su firma y comportamiento de compatibilidad
(verificado por los tests de los casos 13-16). No es el documento que pide el proceso, pero
tampoco es un reemplazo silencioso sin justificación.

---

## 3 · Riesgos latentes no cubiertos por el contrato (ambas ramas)

1. **El desajuste de ramas del §0 es el riesgo más grave del informe.** Si alguien mergea
   `origin/agent/08` pensando que es "la tanda 1 del Truth Engine" porque así lo llama el
   encargo, se lleva a producción la regresión del caso 10 (dato financiero silenciosamente
   truncado) y ninguna pieza del contrato. El riesgo no es hipotético: es exactamente el tipo
   de error que un merge apresurado, basado en el nombre de la rama en vez de su contenido,
   produciría.
2. **Duplicación de la cadena de enforcement en `regression-harness.ts`** (aplica a
   `23a5d6a`, preexistente y no evaluado en `a00ff11` porque esa tanda no toca el harness):
   los escenarios JSON no llaman a `pipeline.ts::applyEnforcement` real, reimplementan sus
   pasos. Si `pipeline.ts` cambia y el harness no se actualiza en paralelo, los escenarios
   pueden dar falsos verdes. No es un defecto de esta tanda, pero es deuda que crece con cada
   tanda que añade lógica a ambos lados.
3. **`a00ff11` no tiene test de round-trip de BD para los campos nuevos de `scenario_state`**
   (V9). El mecanismo de persistencia es el mismo JSON existente, así que el riesgo es bajo,
   pero "debería funcionar por herencia" no es lo mismo que "se verificó".
4. **Calibración del umbral `10×mediana`** (Bloque E) — riesgo de falso positivo con partidas
   grandes legítimas (hipoteca, colegiatura). Mitigado por diseño (no bloquea, solo pregunta),
   pero merece revisión con datos reales de piloto antes de confiar en el umbral a ciegas.

---

## 4 · Recomendación explícita a Luis

1. **No mergear `origin/agent/08` (`23a5d6a`) bajo ningún concepto** en su estado actual —
   contiene la regresión del caso 10 y no implementa el contrato. Si se quiere conservar el
   trabajo de la "8ª tanda" (parser sin pegado, desglose irregular, mensaje repetido, meta
   única, ICA fuente única — todo verificado como funcional y bien testeado en su propio
   alcance), debe reincorporarse por separado, DESPUÉS de corregir la regresión del espacio
   como separador de miles, idealmente adoptando el detector de pegado de `a00ff11` en vez
   de la eliminación total del caso 10.
2. **Pedir a AG08 que publique `a00ff11`** (`git push origin agent/08` desde
   `/home/andgcore/projects/wt-ag08-consigliere`, coordinando con Luis si hace falta
   `--force-with-lease` dado que diverge de `origin/agent/08`) y que entregue junto con
   ese push una Declaración de Impacto explícita (Bloque H) antes de solicitar el merge
   formal a `develop`.
3. **Sobre el contenido de `a00ff11` en sí**: si se publica tal cual, mi lectura adversarial
   no encuentra bloqueantes — pasa los 9 casos con tests que ejercitan la ruta real, respeta
   el alcance parcial de la tanda, no introduce plantillas de eco, la migración 019 está bien
   construida y coincide con la telemetría. Lo calificaría **APROBADO CON RESERVAS**
   condicionado a: (a) añadir la Declaración de Impacto formal, (b) un test de round-trip de
   BD para los campos nuevos de `scenario_state` (V9), y (c) que Luis ejecute `test:e2e` y
   `smoke:db` (fuera de mi alcance por credenciales) antes del merge final a `develop`.
4. Independientemente de cuál rama avance: la causa raíz de este informe — un agente
   trabajando sobre una base que quedó desactualizada respecto al contrato sin que nadie lo
   notara hasta esta revisión — vale la pena resolverla en el protocolo de entrega: exigir que
   cada tanda declare explícitamente contra qué commit de `develop` se rebasó por última vez
   antes de pedir revisión.


---
---

# TERCERA REVISIÓN — `agent/08` @ `f4f3561` · 6 de agosto de 2026

## VEREDICTO: RECHAZADO

> **Revisión adversarial — AG08 `f4f3561` ("precedencia declarativo>lista + stopwords + el ingreso
> nunca es gasto + agregado no se destruye")**
> Revisor: AG01 (Arquitecto) · Base: `origin/develop` @ `de94008`
> Contexto: las dos revisiones anteriores (arriba) ya se mergearon (PR #45), y AG08 respondió con
> `8fbe6b5` (PR #46, ya en `develop`). Esta tercera revisión juzga **solo** el único commit que
> `agent/08` tiene por delante de `develop`.
> Método: **cada afirmación del reporte de AG08 se re-ejecutó contra el código real**, y cada
> resultado se contrastó contra `develop` para separar regresión nueva de defecto preexistente.
> No se tocó código de AG08, no se mergeó nada, no se pusheó código.

---

## Resumen ejecutivo

La entrega llega **verde en toda la batería** (14 + 262 + 200 unit · 84/84 regresión · `tsc` limpio),
y esa cifra es real: la reproduje entera. Los **6 mensajes obligatorios pasan**, los **9 casos del
contrato pasan**, los **2 casos nuevos que añadió Luis pasan**, la disciplina de alcance es impecable
y la declaración de impacto es la primera de esta serie que se puede auditar línea a línea contra el
diff.

**Y aun así hay que rechazarla**, por la misma razón por la que existe esta revisión: la batería
verde tiene un punto ciego con la forma exacta de un bug. El FIX 1 (reclamo por valor, V13)
**elimina el token del número reclamado**, y ese borrado hace que un ítem de gasto legítimo situado
en el **mismo segmento** que la declaración de ingreso **desaparezca en silencio**. El sistema
**subestima los gastos** y llega a decirle *"te sobran 450 €"* a un usuario que está **en déficit de
250 €**.

Ninguno de los 6 mensajes obligatorios ni de los 16 tests nuevos tiene esa forma. La luz verde es
correcta y el bug también: conviven.

**Lo importante: la dirección del fix es la correcta.** V12 (el ingreso ya no se cuenta como gasto)
está genuinamente resuelto — en `develop` el mismo mensaje producía la partida fantasma `pago: 700`.
No hay que revertir esta tanda; hay que corregir el efecto colateral del borrado del token.

---

## 1 · Hallazgos priorizados

### 🔴 BLOQUEANTE B1 — Un ítem de gasto en el mismo segmento que el ingreso se pierde en silencio

**Archivos:** `src/lib/calculator/expenses.ts:105-107` (filtro de tokens reclamados) ·
`src/lib/calculator/scenario.ts:391-460` (`claimed`, FIX 1/V13)

**Mecanismo** (reconstruido leyendo `emparejarNombreMonto`, no inferido): al filtrarse el token
numérico reclamado, los fragmentos de nombre que ese número separaba se **fusionan en un solo nombre
largo**. `"gano 700 y pago arriendo 650"` deja de tokenizarse como
`[gano][700][y][pago][arriendo][650]` y pasa a `[gano][y][pago][arriendo][650]`: el emparejador
acumula `"gano y pago arriendo"` como un único nombre candidato, `NO_ES_GASTO` lo invalida por
contener `"gano"`, y el importe que venía detrás (**650**) queda huérfano y se descarta.

**Medición real — mismos mensajes, ambas ramas (`extractScenarioDelta` + `buildScenarioContext`):**

| Mensaje | `develop` (gastos · sobrante) | `agent/08` (gastos · sobrante) | Real |
|---|---|---|---|
| `"gano 700 y pago arriendo 650, comida 200, luz 50"` | 1600 · −900 | **250 · +450** ❌ | 900 · **−200** |
| `"gano 2000 y gasto en arriendo 800, comida 300, luz 100"` | 2400 · −400 | **400 · +1600** ❌ | 1200 · +800 |
| `"mi sueldo es 2500 y el arriendo 800, comida 300, luz 90"` | 2890 · −390 | **390 · +2110** ❌ | 1190 · +1310 |
| `"gano 3000, arriendo 900, comida 400, luz 100"` (coma) | 1400 · +1600 ✅ | 1400 · +1600 ✅ | ✅ |
| `"gano 2500. arriendo 800, comida 300, luz 90"` (punto) | 1190 · +1310 ✅ | 1190 · +1310 ✅ | ✅ |

**Disparador exacto:** el ítem de gasto comparte segmento (sin coma ni punto que los separe) con la
palabra declarativa de ingreso. Si hay coma o punto, el parser acierta — por eso los tests, que usan
todos esa forma, no lo ven.

**Por qué es bloqueante y no mayor:** en `develop` el error **sobreestimaba** los gastos (alarma
falsa). Aquí los **subestima**, y la subestimación produce la única frase que este producto no puede
permitirse: decirle *"te sobran 450 €"* a alguien que está perdiendo 250 € al mes. Un usuario en
apuros que recibe esa respuesta no vuelve — es literalmente el coste que el encargo pone como listón.
Además `gastos_mensuales` queda **persistido** con el valor truncado (250), así que el error
contamina los turnos siguientes, no solo la respuesta de este.

**Nota justa:** en las dos primeras filas `develop` tampoco acertaba (contaba el ingreso como gasto —
la partida fantasma `pago: 700`, o `arriendo: 2000` tomando el valor del ingreso). Esta tanda **sí
arregla eso**. El defecto es el efecto colateral del remedio, no el problema original.

---

### 🟠 MAYOR M1 — La batería obligatoria tiene un punto ciego con la forma exacta del bug

**Archivo:** `src/lib/calculator/scenario.test.ts` (16 tests nuevos) + §7 del informe de AG08.

Ninguno de los 6 mensajes obligatorios ni de los 16 tests nuevos contiene un ítem de gasto en el
mismo segmento que la declaración de ingreso:

- msg 1 (`"...gasto aproximadamente 2000 entre vivienda, comida..."`) — sin ítems con importe propio.
- msg 3 (`"gano 2300 y gasto 2200"`) — sin lista.
- msg 4 (`"arriendo 700, comida 450, luz 120"`) — sin ingreso en el mensaje.
- msg 6 (`"gano 2500, gasto 1800: arriendo 900..."`) — la coma y los dos puntos separan.

Verificado con `grep -iE "gano [0-9]+ y (pago|gasto en) |sueldo es [0-9]+ y "` sobre el diff de
tests: **cero coincidencias**. No es que el test fallara; es que la forma no se probó. Mismo patrón
que el "60100": la suite bendice el estado actual en vez de interrogarlo.

---

### 🟡 MENOR m1 — `detectarCorreccionDeItem` acepta por subcadena y produce falsos positivos

**Archivo:** `src/lib/calculator/scenario.ts:349-353`

`n2.includes(nombreMencionado) || nombreMencionado.includes(n2)` — ejecutado:

```
"la luz del coche es 150"  → {"name":"luz","amount":150}       ← corrige la factura de la luz
"el arriendo es 900"       → {"name":"arriendo","amount":900}  ✅ correcto
"mi hermana son 150"       → null                              ✅ correcto
```

Además la corrección **promueve `detalle_confirmado` a `true`**, así que un falso positivo no solo
cambia un importe: da por confirmado un desglose que el usuario nunca revisó. Probabilidad baja en
una conversación financiera, impacto medio. Recomendación: coincidencia por palabra completa.

---

### 🟡 MENOR m2 — `meta.monto` se rellena con el ingreso (PREEXISTENTE, no de esta tanda)

```
"gano 2300, quiero comprar una casa"  →  {"ingreso_mensual":2300,"meta":{"monto":2300}}
```

El ingreso se convierte en el importe de la meta. **Idéntico en `develop`** — no es regresión de esta
tanda y no bloquea, pero es la misma clase de fuga que V12 prohíbe (un valor ya reclamado
reapareciendo en otro campo) y el `claimed` de FIX 1 **no cubre `meta`**. Ticket propio: extender el
reclamo por valor a la extracción de meta.

---

### ⚪ Desviación documentada — el umbral del detector de pegado es 50×, el contrato dice 10×

**Archivo:** `src/lib/calculator/expenses.ts:412` (`UMBRAL_MEDIANA_MULTIPLICADOR = 50`)

Llegó en la tanda anterior (`8fbe6b5`, **ya en `develop`**) como respuesta a mi revisión previa sobre
el falso positivo de la hipoteca, y está bien razonada y medida contra ambos casos reales
(hipoteca ≈25× no marca · 60100 ≈668× sí marca), con un suelo adicional de `3× agregado`. No la
introduce esta tanda y no la objeto técnicamente. **Pero el contrato §5.2 sigue diciendo "10 ×
mediana": código y contrato se contradicen por escrito.** Actualizar el contrato o revertir — decisión
de Luis, no de un agente.

---

### ⚪ Nota de proceso — V12 y V13 no existen en el contrato

El encargo pide verificar V12 y V13, y el informe de AG08 los invoca por número, pero
`docs/CONTRATO_TRUTH_ENGINE.md` **solo define V1-V10** (`grep` sobre `docs/` y `src/`: cero
coincidencias). Los verifiqué por su contenido deducido del código y del informe (V12 = el ingreso
nunca es un ítem de gasto · V13 = reclamo por valor de los campos declarativos), y **ambos se
cumplen**. Recomiendo escribirlos en §9 del contrato: un invariante que solo vive en un prompt no es
auditable por el siguiente revisor.

---

## 2 · Los 9 casos de aceptación (ejecutados por mí, no leídos del reporte)

| # | Caso | Test existe | Ejercita ruta real | Pasa |
|---|---|---|---|---|
| 9 | `"...60 100 Pañales_Bebe_Vital"` → AMBIGUOUS + sospechoso | Sí | Sí | ✅ `AMBIGUOUS`, sospechoso `60100`, discrepancia `false` |
| 10 | `"gasto 2 500 €"` → 2500 | Sí | Sí | ✅ `2500`, `COMPLETE` |
| 11 | `"gano 2300, tengo 43 años, 2 hijos, gasto 2200"` | Sí | Sí | ✅ `COMPLETE`, huérfanos `[]` |
| 12 | `"gano 2300 y gasto 2200 y 450"` → PARTIAL | Sí | Sí | ✅ `PARTIAL`, huérfanos `[450]`, usa 2300/2200 |
| 13 | `"Diezmo_Vital 225, Casa_Vital 700"` | Sí | Sí | ✅ 2 ítems con `_` |
| 14 | `"alquiler 700 comida 450 luz 120"` | Sí | Sí | ✅ 3 ítems |
| 15 | `"Alquiler: 700, Comida: 450, Luz: 120"` | Sí | Sí | ✅ 3 ítems |
| 16 | 15 partidas testdev7 | Sí | Sí | ✅ 15 ítems · suma 2250 · **buckets suman 2250** |
| 17 | Crédito con monto sin plazo | Sí | Sí (`toolArgsToScenarioDelta`) | ✅ plazo `undefined`, `missing` incluye plazo |

**Los 6 mensajes obligatorios (V12/V13):** los 6 reproducen exactamente la salida declarada en §7 del
informe de AG08. Sin discrepancias entre lo declarado y lo ejecutado.

**Los 2 casos nuevos de Luis:**

| Caso | Resultado |
|---|---|
| Desglose sin confirmar → no propone recorte pero sí responde sobrante | ✅ `detalle_confirmado=false` · `notaDetalleSinConfirmar` se dispara con "¿qué puedo recortar?" y **no** con "¿cuánto me queda?" · `sobrante = 1030` se sigue calculando |
| `"gasto aproximadamente 2000 entre vivienda, comida"` → `gastos_items` vacío | ✅ `{"gastos_mensuales":2000}`, sin ítems |

---

## 3 · Invariantes

| # | Estado | Evidencia |
|---|---|---|
| **V1** | ✅ Verificado | `"gano 2300 y gasto 2200 y 450"` → PARTIAL y el estado conserva `{ing:2300, gas:2200}`. Ningún camino pone el delta a `undefined` por ambigüedad. **La guarda de sanidad respeta V1**: descarta el detalle pero nunca toca `ingreso_mensual`/`gastos_mensuales`. |
| **V5** | ✅ No tocado | El diff no roza el grounding ni `conceptos`. |
| **V8** | ✅ Verificado | `"gano 0"` → `{}` · `"gasto 0"` → `{}` · `toolArgsToScenarioDelta({credito_monto:0, plazo:0, tae:0})` → `{}`. |
| **V9** | ⚠️ Parcial | `detalle_confirmado` es un booleano plano dentro del `scenario_state` jsonb → hereda la persistencia existente. Las señales de turno (`detalle_confirmado_explicito`, `gastos_item_correccion`) se `delete`an antes de persistir — correcto. **Sigue sin haber test de round-trip de BD.** |
| **V10** | ✅ No aplica | Esta tanda no añade ninguna sustitución de texto. |
| **V12** | ✅ Verificado | El ingreso ya no aparece como ítem (`develop` producía `pago: 700`; aquí no). `aplicarGuardaDeSanidad` cubre además la vía `tool_call`. |
| **V13** | ✅ Verificado (con el coste de B1) | El reclamo por valor funciona; el efecto colateral es B1. |
| `scenario_state` · `response_telemetry` · `runGuardrail` · `persistTurn` | ✅ | `persistTurn` sigue siendo el único punto de escritura (`route.ts:736`). |
| `llm.ts` no tocado | ✅ | No aparece en el diff. |
| Tabla de puntos ICA no redefinida | ✅ | `ica-service.ts` no aparece en el diff. |

**Bloque B — compatibilidad:** `gastos_detalle` conserva forma y consumidores (`turn-classifier.ts:138`,
`tools.ts`, orquestador); `gastos_items` es aditivo; flujo **items → clasificación → buckets**
verificado ejecutando el caso 16 (ítems 2250 = buckets 2250; no pueden divergir porque los buckets se
derivan de los mismos ítems en la misma llamada).

**Bloque C — alcance:** impecable. `detectarDiscrepanciaGastos(delta)` mantiene firma de **un solo
argumento** (`scenario.ts:828`) — la reconciliación cross-turno que la tanda anterior había colado
sigue revertida. Cero `CONFLICT`/`ASSUMED`/`SUPERSEDED` fuera de un comentario. Nada de materialidad
ni escape tras 2 intentos.

**Bloque F — migración 019:** esta tanda **no la toca** (ya está en `develop` desde `8fbe6b5`).

**Bloque G — el eco no es plantilla:** ✅ `notaDetalleSinConfirmar` (`scenario.ts:465-482`) entrega los
DATOS al prompt e instruye explícitamente *"con tu propia voz, nunca copies este formato literal"*.
No hay texto enlatado nuevo hacia el usuario.

**Bloque H — declaración de impacto:** ✅ **la primera auditable de esta serie.** Contrasté la tabla
función-por-función del §6 contra el diff real: coincide. Declara "Eliminadas: ninguna" — confirmado,
todo es aditivo o reordenamiento interno de `extractScenarioDelta` sin cambio de firma pública.

---

## 4 · Riesgos latentes que el contrato no cubre

1. **La guarda de sanidad solo actúa si el ingreso llega en el MISMO delta**
   (`scenario.ts:378`: `if (delta.ingreso_mensual === undefined) return delta`). Un desglose absurdo
   en el turno 2, con el ingreso declarado en el turno 1, **no se filtra**. Verificado:
   `aplicarGuardaDeSanidad({gastos_items:[{amount:2300}]})` sin ingreso → pasa intacto. Coherente con
   el alcance de un turno, pero deja la puerta abierta justo donde la tanda 2 (cross-turno) va a
   trabajar; conviene decidirlo a propósito, no por omisión.
2. **La guarda descarta el desglose ENTERO ante una sola coincidencia de importe.** Un caso real
   —alguien cuyo alquiler es exactamente igual a su ingreso— pierde todo el detalle, y solo queda un
   `console.warn`. Sugerencia: que ese descarte alimente una pregunta al usuario, no un silencio.
3. **`detalle_confirmado` se promueve solo por silencio.** Si el usuario ignora el eco y cambia de
   tema, el desglose queda `CONFIRMED` sin que nadie lo haya mirado. Es el mecanismo de eco del
   contrato (§3) y por tanto conforme — pero conviene saber que "confirmado" aquí significa
   "no desmentido".
4. **El reclamo por valor es global al mensaje, no posicional.** Si dos campos legítimos comparten
   importe (ingreso 1200 y alquiler 1200), el segundo desaparece. Es la causa raíz de B1 y seguirá
   ahí aunque se arregle la fusión de nombres.

---

## 5 · Recomendación explícita a Luis

**Devolver a AG08.** No revertir: la tanda va en la dirección correcta y V12/V13 están genuinamente
resueltos. Falta cerrar un efecto colateral. Lista exacta:

1. **Corregir B1 (bloqueante).** El problema no es reclamar el valor, es **borrar el token**: al
   desaparecer, los fragmentos de nombre se fusionan y `NO_ES_GASTO` invalida el nombre entero,
   llevándose por delante el importe siguiente. En vez de filtrar el token, **sustituirlo por un
   marcador que corte la acumulación de nombre** (que actúe de frontera, como una coma), de modo que
   `"gano [X] y pago arriendo 650"` siga produciendo `arriendo → 650`. Criterio de aceptación: las
   tres primeras filas de la tabla de B1 deben dar `gastos = 900 / 1200 / 1190`.
2. **Añadir a la batería obligatoria los tres mensajes de B1**, más un caso con ingreso y una partida
   del mismo importe (`"gano 1200, arriendo 1200, comida 300"`). Sin esos tests, este bug vuelve.
3. **m1:** coincidencia por palabra completa en `detectarCorreccionDeItem`, no por subcadena.
4. **Antes del merge:** que Luis ejecute `test:e2e` y `smoke:db` (no verificables por mí, sin
   credenciales) — y conviene, porque la regresión que originó esta tanda se detectó precisamente por
   un ASSERT de `test:e2e`.

**Decisiones que son de Luis, no de un agente:**

- **Contrato §5.2 dice 10× y el código dice 50×.** Actualizar el contrato (recomendado: la
  calibración de AG08 está medida y es correcta) o revertir el umbral.
- **Escribir V12 y V13 en §9 del contrato.** Hoy solo viven en el prompt del encargo.
- **m2 (`meta.monto` = ingreso)** es preexistente: decidir si entra en esta tanda o abre ticket.

**Lo que NO hay que tocar:** la disciplina de alcance, la declaración de impacto (por fin auditable)
y `notaDetalleSinConfirmar`, que es el mejor ejemplo hasta ahora de "el sistema entrega los datos, el
modelo redacta la frase".

---

*Nota de método: batería reproducida entera en worktrees aislados y desechables (`git worktree add
--detach`), sin tocar el worktree de AG08. Todas las cifras provienen de ejecutar
`extractScenarioDelta`, `mergeScenario`, `buildScenarioContext`, `analizarExtraccion` y
`aplicarGuardaDeSanidad` reales, en `agent/08` y en `develop`, con los mismos mensajes.
`test:e2e` y `smoke:db`: no verificables por mí (credenciales).*


---
---

# CUARTA REVISIÓN — `agent/08` @ `a83957a` · 6 de agosto de 2026

## VEREDICTO: RECHAZADO

> **Revisión adversarial — AG08 `f4f3561` + `a83957a` ("token reclamado es frontera con offsets
> preservados")**
> Revisor: AG01 (Arquitecto) · Base: `origin/develop` @ `de94008`
> Rama revisada: `origin/agent/08` @ `a83957a` (2 commits por delante de `develop`)
> Método: **cada afirmación del reporte se re-ejecutó contra el código real.** Los tres mensajes
> del bloqueante de mi revisión anterior se ejecutaron uno por uno.
> No se tocó código de AG08, no se mergeó nada, no se pusheó código.

---

## Resumen ejecutivo

AG08 implementó **exactamente el mecanismo que recomendé** (token reclamado convertido en frontera
en vez de eliminado) y la idea es correcta: `Tok.kind` gana `"boundary"`, `emparejarNombreMonto`
hace reset duro, `resolverPegado` no necesitó cambios. La batería está verde
(14 + 262 + **206** + 84/84, `tsc` limpio) y la reproduje entera.

**Pero el bloqueante B1 no está cerrado, y hay uno nuevo.**

1. **De los tres mensajes del bloqueante, dos pasan y uno sigue fallando.** El reporte de AG08 (§5)
   presenta los mensajes 1, 2 y un control con punto — **el mensaje que sigue roto no aparece en la
   lista**: fue sustituido por otro. Sus tests obligatorios `V13-1`…`V13-6` cubren dos de mis tres
   mensajes. El tercero no tiene test y sigue perdiendo la partida.
2. **El mecanismo de frontera introduce una regresión nueva**: la *palabra* de contexto se marca
   como frontera, y `PRECIO_CTX` incluye `carro|coche|auto|casa|piso|vivienda` — palabras que son
   nombres de gasto perfectamente normales. Con un crédito en el mismo mensaje, esa partida
   **desaparece**.

Ambos fallan en la misma dirección peligrosa que la vez anterior: **subestimar los gastos** y
anunciar un sobrante que no existe.

---

## 1 · Hallazgos priorizados

### 🔴 BLOQUEANTE B1-residual — 1 de los 3 mensajes sigue perdiendo la partida

**Archivo:** `src/lib/calculator/scenario.ts:546-551`

**Ejecución de los tres mensajes del bloqueante (`extractScenarioDelta` + `mergeScenario` + `buildScenarioContext`):**

| Mensaje | `gastos` obtenido | esperado | sobrante que cree | real |
|---|---|---|---|---|
| `"gano 700 y pago arriendo 650, comida 200, luz 50"` | 900 | 900 ✅ | −200 | −200 ✅ |
| **`"gano 2000 y gasto en arriendo 800, comida 300, luz 100"`** | **400** | **1200** ❌ | **+1600** | **+800** ❌ |
| `"mi sueldo es 2500 y el arriendo 800, comida 300, luz 90"` | 1190 | 1190 ✅ | +1310 | +1310 ✅ |

**Causa raíz exacta** (aislada ejecutando `parseExpenseListDetallado` con distintos sets):

```
A) como lo llama el código hoy  (claimed={2000}, frontera={gano}):
   [{"name":"comida","amount":300},{"name":"luz","amount":100}]          ← arriendo 800 PERDIDO
B) si 'gasto' TAMBIÉN fuera frontera:
   [{"name":"en arriendo","amount":800},{"name":"comida",300},{"luz",100}] ← correcto
```

La palabra de `GASTO_CTX` se añade a `fronteraPalabras` **solo dentro** de la rama de reclamo
(`scenario.ts:546`: `if (gastoDeclaradoSimple !== undefined && listResult.items.length < 2)`).
Cuando la lista ya tiene ≥2 ítems sin reclamar —que es justo este caso— esa rama no se toma, `gasto`
queda libre, `pendingName` acumula `"y gasto en arriendo"`, `NO_ES_GASTO` lo invalida por contener
`"gasto"`, y el **800 se pierde sin dejar huérfano** (nunca llega a serlo: se destruye antes).

Compárese con `ingresoWord` (`scenario.ts:482-483`), que sí se añade **incondicionalmente** en cuanto
hay ingreso — por eso los mensajes 1 y 3 sí se arreglaron. **La asimetría entre las dos palabras es
el bug.**

**Corrección:** mover `if (gastoWord) fronteraPalabras.add(norm(gastoWord))` fuera de la rama
condicional, junto a donde se calcula `gastoWord` (`scenario.ts:539`), con el mismo tratamiento
incondicional que `ingresoWord`. Verificado arriba (fila B): recupera el ítem.

---

### 🔴 BLOQUEANTE B2 (NUEVO, introducido por `a83957a`) — una partida cuyo nombre coincide con la palabra de contexto se destruye

**Archivos:** `src/lib/calculator/scenario.ts:461-462` (`PRECIO_CTX` → frontera) ·
`src/lib/calculator/expenses.ts:509-515` (conversión a `boundary`)

`fronteraPalabras.add(norm(creditoWord[0]))` mete en el set la **primera palabra que casó
`PRECIO_CTX`**, y ese regex (`scenario.ts:244`) incluye
`precio|cuesta|vale|financiar|credito|prestamo|…|carro|coche|auto|casa|piso|vivienda`.
Las seis últimas son nombres de gasto corrientes. Ejecutado, las **seis** se pierden:

```
"quiero un {P} de 30000 a 36 meses, {P} 100, comida 300, luz 90"
  carro    → PERDIDA ❌   items=["comida","luz"]
  coche    → PERDIDA ❌   items=["comida","luz"]
  auto     → PERDIDA ❌   items=["comida","luz"]
  casa     → PERDIDA ❌   items=["comida","luz"]
  piso     → PERDIDA ❌   items=["comida","luz"]
  vivienda → PERDIDA ❌   items=["comida","luz"]
```

**Impacto financiero del caso más plausible** (alguien con hipoteca que pide un crédito):

```
"quiero una casa de 200000 a 240 meses, casa 700, comida 300, luz 90"   (ingreso 1500)
  gastos registrados: 390   ·  real: 1090
  el sistema cree que sobran 1110 €  ·  realidad: 410 €
```

**Control:** sin crédito en el mensaje, las mismas listas se extraen enteras
(`"casa 700, comida 300, luz 90"` → 3 ítems ✅). Y con `"financiar"` delante, `PRECIO_CTX.exec`
casa primero con `"financiar"` y `carro` se salva — es decir, **el fallo depende del orden de las
palabras**, lo que lo hace intermitente y difícil de reproducir en QA manual.

**Por qué es bloqueante:** el patrón *"quiero financiar una casa … estos son mis gastos"* es
exactamente la conversación central del producto, y el resultado es la frase prohibida — "te
sobran 1.110 €" a alguien que tiene 410 €.

**Corrección sugerida:** no usar `match[0]` de un regex de contexto amplio como frontera. Marcar
frontera **por posición** (el token concreto que originó el reclamo, vía offsets — que el propio
commit dice preservar) en vez de por igualdad de texto; o restringir el set a las palabras
inequívocamente no-gasto (`precio|cuesta|vale|financiar|credito|prestamo|loan`), nunca a los
sustantivos de objeto.

---

### 🟠 MAYOR M1 — El reporte presenta como verificado un caso que no está en la batería

**Archivo:** `docs/informes/CORRECCIONES_AG08_v13_token_frontera.md` §5 · `scenario.test.ts` (`V13-1`…`V13-6`)

El §5 del reporte lista como "tests obligatorios — resultado real" los mensajes 1
(`gano 700 y pago arriendo…`), 2 (`mi sueldo es 2500…`), 3 (control con punto) y 4 (permutación).
**Mi mensaje `"gano 2000 y gasto en arriendo 800…"` no está**: fue sustituido por el de `sueldo`.
`grep -i "gasto en "` sobre el diff de tests: **cero coincidencias**.

No afirmo intención — es fácil perder un caso de una lista de tres. Pero el efecto es el que esta
revisión existe para evitar: **el bloqueante se declara cerrado, la batería lo confirma en verde, y
el caso que falla no está en la batería.** Mismo patrón que el "60100".

---

### 🟡 MENOR m1 — Los nombres de partida quedan sucios (efecto secundario declarado)

`"gano 700 y pago arriendo 650…"` → ítem `{name: "y pago arriendo", amount: 650}`.

AG08 lo declara abiertamente en §2 de su informe y afirma que la clasificación no se rompe.
**Lo verifiqué y es cierto:**

```
classifyExpense("y pago arriendo") = vital      classifyExpense("y el arriendo") = vital
classifyExpense("y pago comida")   = vital      buckets = 900 = suma de ítems ✅
```

El importe nunca se pierde ni se atribuye mal. Queda un detalle de presentación: ese nombre llega
al prompt vía `notaDetalleSinConfirmar` (`"y pago arriendo: 650 €"`) y podría asomar al usuario —
mitigado porque la nota instruye redactar con voz propia. Aceptable; conviene limpiarlo cuando se
toque el emparejador.

---

### 🟡 MENOR m2 — `detectarCorreccionDeItem` por subcadena (sin cambios desde mi revisión anterior)

`scenario.ts:349-353` — `"la luz del coche es 150"` sigue corrigiendo la partida `luz` **y**
promoviendo `detalle_confirmado` a `true`. Sigue pendiente de la lista anterior.

---

### ⚪ Desviación ya resuelta en proceso — umbral 50× vs. 10× del contrato

`expenses.ts:412` mantiene `UMBRAL_MEDIANA_MULTIPLICADOR = 50`, ahora **con el comentario de
justificación que pedí**, y el informe declara que la enmienda formal de §5.2 la hace AG05 en un PR
de documentación aparte, con el 50× aprobado por Luis. Correctamente encaminado; **hasta que ese PR
entre, contrato y código siguen contradiciéndose por escrito.** Ambos umbrales del contrato están
implementados (`importe > agregado` sin suelo, y `50× mediana` con suelo de `3× agregado` y mínimo
de 3 ítems; con 1-2 ítems solo actúa el detector estructural de pegado).

---

### ⚪ Nota de proceso — V12 y V13 siguen sin estar en el contrato

`docs/CONTRATO_TRUTH_ENGINE.md` define **V1-V10**. V12/V13 solo viven en el prompt del encargo y en
los informes de AG08. Los verifiqué por contenido y **ambos se cumplen** (V12: ningún ítem con el
importe del ingreso en los tres mensajes; V13: el reclamo funciona, con las dos fugas de B1/B2).
Deberían escribirse en §9.

---

## 2 · Los 9 casos de aceptación (ejecutados por mí)

| # | Caso | Test existe | Ejercita ruta real | Pasa |
|---|---|---|---|---|
| 9 | `"…60 100 Pañales_Bebe_Vital"` | Sí | Sí | ✅ `AMBIGUOUS`, sospechoso `60100`, conflicto `false` |
| 10 | `"gasto 2 500 €"` → 2500 | Sí | Sí | ✅ `2500`, `COMPLETE` |
| 11 | `"gano 2300, tengo 43 años, 2 hijos, gasto 2200"` | Sí | Sí | ✅ `COMPLETE`, huérfanos `[]` |
| 12 | `"gano 2300 y gasto 2200 y 450"` | Sí | Sí | ✅ `PARTIAL`, huérfanos `[450]`, usa 2300/2200 |
| 13 | `"Diezmo_Vital 225, Casa_Vital 700"` | Sí | Sí | ✅ 2 ítems con `_` |
| 14 | `"alquiler 700 comida 450 luz 120"` | Sí | Sí | ✅ 3 ítems |
| 15 | `"Alquiler: 700, Comida: 450, Luz: 120"` | Sí | Sí | ✅ 3 ítems |
| 16 | 15 partidas testdev7 | Sí | Sí | ✅ 15 ítems · suma 2250 · buckets 2250 |
| 17 | Crédito con monto sin plazo | Sí | Sí | ✅ plazo `undefined`, `missing` incluye plazo |

**Los dos casos de Luis:**

| Caso | Resultado |
|---|---|
| Desglose sin confirmar → no propone recorte pero sí responde sobrante | ✅ `detalle_confirmado=false` · bloquea "¿qué puedo recortar?" · **no** bloquea "¿cuánto me queda?" · `sobrante=1030` |
| `"gasto aproximadamente 2000 entre vivienda, comida"` → items vacío | ✅ `{"gastos_mensuales":2000}`, sin ítems |

**Test estructural de spans:** existe (`V13-1`…`V13-6`), ejercita la ruta real
(`extractScenarioDelta` → `mergeScenario` → `buildScenarioContext`, sin mocks) y pasa —
**pero cubre 2 de los 3 mensajes del bloqueante** (ver M1).

---

## 3 · Invariantes

| # | Estado | Evidencia |
|---|---|---|
| **V1** | ⚠️ **Violado en espíritu por B1-residual/B2** | Ningún camino descarta el delta por `extraction_status`, y la guarda de sanidad respeta `ingreso`/`gastos`. **Pero** una partida extraída con confianza se destruye antes de existir (B1-res, B2) — no por huérfanos, sino por el mecanismo de frontera. El efecto prohibido (un dato del usuario desaparece en silencio) es el mismo. |
| **V5** | ✅ No tocado | El diff no roza grounding ni `conceptos`. |
| **V8** | ✅ Verificado | `"gano 0"` → `{}` · `"gasto 0"` → `{}` · `toolArgsToScenarioDelta({monto:0,plazo:0,tae:0})` → `{}`. |
| **V9** | ⚠️ Parcial | Campos nuevos son escalares en el jsonb; señales de turno se `delete`an antes de persistir. **Sigue sin test de round-trip de BD.** |
| **V10** | ✅ No aplica | Esta tanda no añade sustituciones de texto. |
| **V12** | ✅ Verificado | Ningún ítem con el importe del ingreso en los tres mensajes. Guarda cubre también la vía `tool_call`. |
| **V13** | ⚠️ Parcial | El reclamo funciona; dos fugas (B1-residual, B2). |
| `scenario_state` · `response_telemetry` · `runGuardrail` · `persistTurn` | ✅ | `persistTurn` único punto de escritura (1 llamada), `applyEnforcement` cableado (1 llamada). |
| `llm.ts` no tocado | ✅ | No aparece en el diff. |
| Tabla ICA no redefinida | ✅ | `ica-service.ts` no aparece en el diff. |

**Bloque B — compatibilidad:** ✅ `gastos_detalle` conserva forma y consumidores
(`turn-classifier.ts:138`, `tools.ts`, orquestador). `gastos_items` es aditivo. Flujo
**items → clasificación → buckets** verificado: caso 16 → ítems 2250 = buckets 2250; y en el caso de
nombres sucios, buckets 900 = ítems 900. No pueden divergir: los buckets se derivan de los mismos
ítems en la misma llamada.

**Bloque C — alcance:** ✅ impecable. `detectarDiscrepanciaGastos(delta)` sigue con **un solo
argumento** (`scenario.ts:852`). Cero `CONFLICT`/`ASSUMED`/`SUPERSEDED` fuera de comentarios. Nada de
materialidad ni escape.

**Bloque F — migración 019:** ✅ esta tanda **no toca** `supabase/`, `telemetry.ts` ni
`persistence.ts` (verificado: diff vacío para esas rutas). Nada que re-auditar.

**Bloque G — el eco no es plantilla:** ✅ `notaDetalleSinConfirmar` entrega los DATOS e instruye
*"con tu propia voz, nunca copies este formato literal"*. Ningún texto enlatado nuevo al usuario.

**Bloque H — declaración de impacto:** ✅ en cuanto a **código**: contrasté la tabla función-por-función
del §4 contra el diff real y coincide; "Eliminadas: ninguna" es cierto (el `filter` se convierte en
`map`, misma firma pública). ❌ en cuanto a **resultados**: §5 declara verificado un conjunto de
mensajes que no coincide con el que se pidió (M1).

---

## 4 · Riesgos latentes que el contrato no cubre

1. **La frontera por igualdad de texto es intrínsecamente frágil.** Marca *todas* las apariciones de
   la palabra en el mensaje, no la que originó el reclamo. B2 es su primera manifestación; el mismo
   patrón afectará a cualquier futura palabra de contexto que también pueda nombrar un gasto. El
   commit dice "offsets preservados", pero el set es de **strings**, no de posiciones: la promesa del
   título no está implementada.
2. **`RATE_CONTEXT` no tiene `\b`** (`scenario.ts:224`): `/(tae|tasa|tipo|juros|…)/` casa dentro de
   palabras. Combinado con la frontera, cualquier partida que contenga esas subcadenas es candidata al
   mismo fallo que B2.
3. **Un ítem destruido no deja rastro.** Ni huérfano, ni `AMBIGUOUS`, ni telemetría: `extraction_status`
   sale `COMPLETE`. El sistema no puede saber que perdió algo — precisamente lo que el contrato
   quiere evitar ("el parser debe ser honesto sobre su propia confianza"). Sugerencia: contar tokens
   numéricos descartados por frontera y degradar a `PARTIAL` si alguno queda sin explicación.
4. **La guarda de sanidad solo actúa con el ingreso en el MISMO delta** (`scenario.ts:378`) — sin
   cambios desde mi revisión anterior.
5. **`detalle_confirmado` se promueve por silencio**: "confirmado" significa "no desmentido".

---

## 5 · Recomendación explícita a Luis

**Devolver a AG08.** La dirección sigue siendo correcta —el mecanismo de frontera es el adecuado y
resolvió 2 de los 3 casos— pero **no mergear**: dos de las conversaciones más comunes del producto
(*"gasto en alquiler X"* y *"quiero financiar una casa… mis gastos son…"*) registran gastos
incompletos y anuncian un sobrante inexistente. Lista exacta:

1. **B1-residual (bloqueante).** Mover `fronteraPalabras.add(norm(gastoWord))` **fuera** de la rama
   condicional de `scenario.ts:546-551`, al punto donde se calcula `gastoWord` (`:539`), igual que
   `ingresoWord` (`:482-483`). Criterio de aceptación:
   `"gano 2000 y gasto en arriendo 800, comida 300, luz 100"` → `gastos = 1200`, sobrante `+800`.
2. **B2 (bloqueante).** Que la frontera se marque **por posición del token reclamado**, no por
   igualdad de texto (los offsets que el commit dice preservar). Alternativa mínima: excluir del set
   los sustantivos de objeto de `PRECIO_CTX` (`carro|coche|auto|casa|piso|vivienda`). Criterio de
   aceptación: los seis mensajes de la tabla de B2 conservan la partida homónima.
3. **Tests obligatorios**: añadir **los tres** mensajes del bloqueante (no dos) y los seis de B2. Un
   caso que se declara corregido sin test en la batería vuelve.
4. **m2**: coincidencia por palabra completa en `detectarCorreccionDeItem`.
5. **Antes del merge**: `test:e2e` y `smoke:db` los ejecuta Luis (no verificables por mí, sin
   credenciales).

**Decisiones de Luis, no de un agente:**

- **Cerrar el PR de AG05** que enmienda §5.2 (10× → 50×): hasta entonces contrato y código se
  contradicen.
- **Escribir V12 y V13 en §9** del contrato.
- Considerar el riesgo latente 3 (un ítem destruido debería degradar a `PARTIAL`, no salir
  `COMPLETE`): es la diferencia entre un parser que falla y uno que **falla honestamente**, que es
  justo la tesis del contrato.

**Lo que NO hay que tocar:** el mecanismo `boundary` (es el correcto), la disciplina de alcance, la
declaración de impacto de código, y `notaDetalleSinConfirmar`.

---

*Nota de método: batería completa reproducida en worktree aislado y desechable (`git worktree add
--detach`, eliminado al terminar), sin tocar el worktree de AG08 —
`npm test` 14/14 · `test:guardrail` 262/262 · `test:calculator` 206/206 · `test:regression` 84/84 ·
`tsc --noEmit` limpio · `npm run build` falla solo en el prerender de `/login` por falta de
credenciales Supabase (preexistente, idéntico en `develop`). Todas las cifras provienen de ejecutar
`extractScenarioDelta`, `mergeScenario`, `buildScenarioContext`, `parseExpenseListDetallado`,
`classifyExpense` y `analizarExtraccion` reales. `test:e2e` y `smoke:db`: no verificables por mí.*


---
---

# QUINTA REVISIÓN — `agent/08` @ `402589f` · 7 de agosto de 2026

## VEREDICTO: APROBADO CON RESERVAS

> **Revisión adversarial — AG08 `f4f3561` + `a83957a` + `402589f` ("fronteras posicionales por rango
> + simetría ingreso/gasto + ley de conservación V14")**
> Revisor: AG01 (Arquitecto) · Base: `origin/develop` @ `de94008`
> Rama revisada: `origin/agent/08` @ `402589f` (3 commits por delante de `develop`)
> Método: batería reproducida entera; los 5 mensajes exigidos ejecutados uno por uno; **6 mensajes
> nuevos construidos por mí para intentar ROMPER la ley de conservación**; cada resultado contrastado
> contra `develop`.
> No se tocó código de AG08, no se mergeó nada, no se pusheó código.

---

## Resumen ejecutivo

**Los dos bloqueantes de mi revisión anterior están cerrados, y esta vez lo están de verdad.**

La causa raíz de los tres rechazos anteriores era conceptual: la frontera se guardaba como
**texto** (un valor o una palabra), lo que la convertía en una regla global que destruía partidas
homónimas en cualquier parte del mensaje. Esta tanda la sustituye por **rangos de caracteres
`[start, end)`** — la corrección estructural correcta, no un parche más.

Verifiqué el gate del Bloque I.1 **antes que nada**: las fronteras son posicionales
(`expenses.ts:221-238` — `Tok` con `start`/`end` absolutos e `interface Rango`;
`scenario.ts:404` — `rangosReclamados: Rango[]`; filtro por solape en
`parseExpenseListDetallado:558`). Los antiguos `Set<number>`/`Set<string>` han desaparecido de la
firma. **No hay rechazo automático.**

Los 5 mensajes exigidos pasan, la independencia de orden se cumple, la ley de conservación resistió
mis 6 intentos de rotura, y `extraction_status` nunca sale `undefined`. Batería verde y reproducida:
14 + 262 + **211** + 84/84, `tsc` limpio.

Las reservas que quedan son **menores y ninguna es regresión de esta tanda** — todas preexisten en
`develop` o son cosméticas. Por eso apruebo con reservas en vez de rechazar: rechazar aquí sería
castigar una corrección correcta por defectos que ya estaban en la rama base.

---

## 1 · Hallazgos priorizados

### ✅ Bloqueantes anteriores — CERRADOS (verificado ejecutando, no leyendo)

| Bloqueante | Estado | Evidencia |
|---|---|---|
| **B1** (asimetría ingreso/gasto) | ✅ Cerrado | `"gano 2000 y gasto en arriendo 800, comida 300, luz 100"` → ítems `[en arriendo 800, comida 300, luz 100]`, **gastos 1200**, sobrante +800. La palabra "gasto" ahora registra su rango de forma incondicional (`scenario.ts:527-568`), simétrico con "gano" (`:487-500`). |
| **B2** (regla global por palabra) | ✅ Cerrado | `"quiero una casa de 200000 a 240 meses, casa 700, comida 300, luz 90"` (ingreso 1500) → ítems `[casa 700, comida 300, luz 90]`, **gastos 1090**. La segunda "casa" cae fuera del rango del crédito y sobrevive. |
| **Intermitencia por orden** | ✅ Cerrada | La variante con `financiar` da **resultado idéntico** (1090). Al ser posicional, ya no depende de qué alternativa de `PRECIO_CTX` matcheó primero. |

**Los dos que ya pasaban siguen pasando** (sin regresión): `"gano 700 y pago arriendo 650…"` → 900 ·
`"mi sueldo es 2500 y el arriendo 800…"` → 1190.

**Bloque I.4 — sin sustitución de casos.** Los 5 mensajes exigidos están en la batería
(`grep` sobre `scenario.test.ts`: `gasto en arriendo 800` ×3 · `casa 700` ×8 · `financiar una casa`
×3 · `pago arriendo 650` ×6 · `sueldo es 2500` ×4). Corrige el incumplimiento que reporté en la
tanda anterior. Además ejecuté **la forma literal del prompt** (ingreso 1500 en turno *previo*, no
dentro del mensaje) por si la variante del informe de AG08 la enmascaraba: **también da 1090**.

---

### ✅ Ley de conservación (V14) — resistió mis 6 intentos de rotura

Construí 6 mensajes con formas que **no están en su batería** y comprobé el balance
`candidatos = asignados ∪ huérfanos ∪ no-relevantes`:

| Mensaje (nuevo, mío) | status | Sin destino |
|---|---|---|
| `"cobro 1800 al mes y el piso me cuesta 600, el coche 150, comida 250"` | COMPLETE | `[]` ✅ |
| `"mi salario 3200, tengo un auto que pago 300, seguro 90, auto 45, luz 60"` | COMPLETE | `[]` ✅ |
| `"gano 2200 y entre el alquiler 800 y la comida 400 se me va casi todo"` | COMPLETE | `[]` ✅ |
| `"el banco me ofrece 9% para un coche de 18000 a 48 meses, coche 200, gasolina 90, comida 300"` | COMPLETE | `[]` ✅ (48 clasificado como no-relevante) |
| `"gasto 1500 en total: casa 700, casa 300, comida 500"` | PARTIAL | `[]` ✅ (700 declarado huérfano) |
| `"gano 2000, pago 500 de arriendo y 500 de comida"` | COMPLETE | `[]` ✅ |

Especialmente notable: `"auto 45"` **sobrevive** junto a `"un auto que pago 300"`, y `"coche 200"`
sobrevive junto a un crédito de coche — exactamente los casos que B2 destruía.

`extraction_status` **nunca sale `undefined`**, ni en llamadas aisladas ni con entradas degeneradas
(`""`, `"hola"`, `"asdf 999 qwer"` → `PARTIAL`, `"gano 0"` → `INVALID`).

---

### 🟡 MENOR m1 — Nombres de partida sucios (sin cambios; efecto secundario ya declarado)

`"gano 2000 y gasto en arriendo 800…"` → ítem `{name: "en arriendo", amount: 800}`;
`"cobro 1800… el piso me cuesta 600"` → `{name: "y el piso me cuesta", amount: 600}`.

El **importe siempre es correcto** y la clasificación aguanta (verificado en la tanda anterior:
`classifyExpense("y pago arriendo") = vital`; buckets = suma de ítems). El riesgo es de
presentación: estos nombres llegan al prompt vía `notaDetalleSinConfirmar` (`"y el piso me cuesta:
600 €"`), mitigado porque la nota exige redactar con voz propia. Conviene limpiarlo cuando se toque
el emparejador, no ahora.

---

### 🟡 MENOR m2 — `detectarCorreccionDeItem` por subcadena (preexistente, sigue pendiente)

`scenario.ts` — `"la luz del coche es 150"` sigue corrigiendo la partida `luz` **y** promoviendo
`detalle_confirmado` a `true`. Reportado en la revisión anterior, no corregido, no empeorado.

---

### 🟡 MENOR m3 — El agregado declarado puede robarle el importe a una partida (PREEXISTENTE)

```
"gasto 1500 en total: casa 700, casa 300, comida 500"
  → ítems [casa=1500, casa=300, comida=500] · gastos 2300 · PARTIAL · huérfanos [700]
```

El `1500` (agregado declarado) se empareja con `"casa"` porque `"en"` es stopword y `"total"` es
palabra ignorable, y el `700` real queda huérfano. El total registrado (2300) sobrepasa el declarado
por el usuario (1500).

**Idéntico en `develop`** — no es regresión de esta tanda, y el sistema **lo señala** (`PARTIAL` con
el 700 como huérfano), así que no viola la ley de conservación ni miente en silencio. Merece ticket:
la conservación garantiza que ningún número desaparece, pero **no** que se atribuya al campo
correcto.

*Para ser justo con esta tanda: en las otras tres variantes de esa misma frase que probé, `agent/08`
es **mejor** que `develop` — p. ej. `"gasto 1500 en total, casa 700, comida 300, luz 500"` daba en
`develop` un ítem fantasma `total=1500` y `gastos 3000` marcado `COMPLETE` (silenciosamente falso);
ahora da `gastos 1500` marcado `PARTIAL`.*

---

### ⚪ Sobre los dos tests modificados — legítimo, y lo verifiqué

AG08 cambió `assert.deepEqual(extractScenarioDelta(…), {})` por
`{ extraction_status: "COMPLETE" | "PARTIAL" }` en dos tests preexistentes, y lo declara abiertamente
en §3 de su informe. **No es "reescribir un test para que afirme lo contrario"** (el patrón que
denuncié en el caso del "60100"):

- El cambio es **consecuencia directa** de un requisito que yo mismo pedí (`extraction_status`
  siempre definido).
- Sigue siendo `deepEqual` sobre el objeto **completo**: cualquier campo financiero inventado haría
  fallar el test. La garantía central —"de una frase ambigua no se extrae ningún dato"— se verifica
  exactamente igual, y ahora además se fija el estado.

---

### ⚪ Desviación pendiente de cerrar en proceso — umbral 50× vs. 10× del contrato

`expenses.ts:466` mantiene `UMBRAL_MEDIANA_MULTIPLICADOR = 50` (sin cambios en esta tanda, con el
comentario de justificación). Ambos umbrales del contrato están implementados:
`importe > agregado` (`:474`, sin suelo) y `50× mediana` con `≥3 ítems` (`:483`) más suelo de
`3× agregado`. Con 1-2 ítems solo actúa el detector estructural de pegado, que es el que cubre el
caso 9. **El contrato §5.2 sigue diciendo 10×**: hasta que entre el PR de documentación de AG05,
código y contrato se contradicen por escrito.

---

### ⚪ Nota de proceso — V12, V13 y V14 siguen sin estar en el contrato

`docs/CONTRATO_TRUTH_ENGINE.md` define **V1-V10**. V12 (el ingreso nunca es gasto), V13 (reclamo
posicional) y ahora V14 (ley de conservación) solo viven en los prompts y en los informes de AG08.
Los tres se cumplen, verificados por contenido. **V14 es el invariante más valioso que ha producido
esta serie** y merece estar en §9 del contrato, no en un informe suelto.

---

## 2 · Los 9 casos de aceptación (ejecutados por mí)

| # | Caso | Test existe | Ejercita ruta real | Pasa |
|---|---|---|---|---|
| 9 | `"…60 100 Pañales_Bebe_Vital"` | Sí | Sí | ✅ `AMBIGUOUS`, sospechoso `60100`, conflicto `false` |
| 10 | `"gasto 2 500 €"` → 2500 | Sí | Sí | ✅ `2500`, `COMPLETE` |
| 11 | `"gano 2300, tengo 43 años, 2 hijos, gasto 2200"` | Sí | Sí | ✅ 2300/2200, `COMPLETE` |
| 12 | `"gano 2300 y gasto 2200 y 450"` | Sí | Sí | ✅ `PARTIAL`, huérfanos `[450]` |
| 13 | `"Diezmo_Vital 225, Casa_Vital 700"` | Sí | Sí | ✅ 2 ítems con `_` |
| 14 | `"alquiler 700 comida 450 luz 120"` | Sí | Sí | ✅ 3 ítems |
| 15 | `"Alquiler: 700, Comida: 450, Luz: 120"` | Sí | Sí | ✅ 3 ítems |
| 16 | 15 partidas testdev7 | Sí | Sí | ✅ 15 ítems · suma 2250 · buckets 2250 |
| 17 | Crédito con monto sin plazo | Sí | Sí | ✅ plazo `undefined`, `missing` incluye plazo |

**Los dos casos de Luis:**

| Caso | Resultado |
|---|---|
| Desglose sin confirmar → no propone recorte, sí responde sobrante | ✅ `detalle_confirmado=false` · bloquea "¿qué puedo recortar?" · **no** bloquea "¿cuánto me queda?" · `sobrante=1030` |
| `"gasto aproximadamente 2000 entre vivienda, comida"` → items vacío | ✅ `gastos 2000`, 0 ítems |

**Test estructural de spans/conservación:** existe (`V14-1`, `V14-2`, `V14-3`, `V14-6` estructural,
`V14-7` regresiones), ejercita la ruta real (`extractScenarioDelta` → `mergeScenario` →
`buildScenarioContext`, sin mocks) y pasa. `V14-6` recorre los 5 mensajes + regresiones comprobando
que ningún número queda sin destino.

---

## 3 · Invariantes

| # | Estado | Evidencia |
|---|---|---|
| **V1** | ✅ Verificado | Ningún camino descarta el delta por `extraction_status`. Los datos con confianza sobreviven a `PARTIAL` (caso 12: 2300/2200 intactos con huérfano 450). La guarda de sanidad no toca `ingreso`/`gastos`. |
| **V5** | ✅ No tocado | El diff no roza grounding ni `conceptos`. |
| **V8** | ✅ Verificado (mejorado) | `"gano 0"` / `"gasto 0"` → sin campo financiero **y** `extraction_status: "INVALID"` (antes salía `{}` mudo). `toolArgsToScenarioDelta({monto:0,plazo:0,tae:0})` → `{}`. |
| **V9** | ⚠️ Parcial | Campos nuevos son escalares en el `scenario_state` jsonb; señales de turno se `delete`an antes de persistir. **Sigue sin test de round-trip de BD** (pendiente desde 3 tandas). |
| **V10** | ✅ No aplica | Esta tanda no añade sustituciones de texto. |
| **V12** | ✅ Verificado | `"gano 700 y pago arriendo 700…"` y `"gano 1200, arriendo 1200…"` → la guarda descarta el detalle, ningún ítem con el importe del ingreso. |
| **V13** | ✅ Verificado (ahora posicional) | Fronteras como rangos; las dos fugas anteriores cerradas. |
| **V14** | ✅ Verificado | 6 mensajes nuevos míos: cero números sin destino; `extraction_status` nunca `undefined`. |
| `scenario_state` · `response_telemetry` · `runGuardrail` · `persistTurn` | ✅ | `persistTurn` único punto de escritura (1 llamada); `applyEnforcement` cableado (1 llamada). |
| `llm.ts` no tocado | ✅ | No aparece en el diff. |
| Tabla ICA no redefinida | ✅ | `ica-service.ts` no aparece en el diff. |

**Bloque B — compatibilidad:** ✅ `gastos_detalle` conserva forma y consumidores
(`turn-classifier.ts:138`, `tools.ts:118-131`). `gastos_items` es aditivo. Flujo
**items → clasificación → buckets** verificado: caso 16 → ítems 2250 = buckets 2250. No pueden
divergir: los buckets se derivan de los mismos ítems en la misma llamada. **Mejora de esta tanda:**
`valoresAsignadosEnDelta` deja de re-derivar con `parseExpenseList(message)` (segunda pasada sin
rangos, que podía dar un conjunto distinto) y usa `delta.gastos_items` como fuente única — eso
elimina una divergencia latente que yo no había detectado.

**Bloque C — alcance:** ✅ impecable. `detectarDiscrepanciaGastos(delta)` sigue con **un solo
argumento** (`scenario.ts:884`). Cero `CONFLICT`/`ASSUMED`/`SUPERSEDED` fuera de comentarios. Nada
de materialidad ni escape.

**Bloque F — migración 019:** ✅ esta tanda **no toca** `supabase/`, `telemetry.ts`,
`telemetry-purge.ts` ni `persistence.ts` (diff vacío para esas rutas). Nada que re-auditar.

**Bloque G — el eco no es plantilla:** ✅ ningún texto enlatado nuevo al usuario.
`notaDetalleSinConfirmar` entrega los DATOS e instruye *"con tu propia voz, nunca copies este formato
literal"*.

**Bloque H — declaración de impacto:** ✅ contrastada función por función contra el diff real:
coincide. "Eliminadas: ninguna" es cierto (cambio de firma en `parseExpenseListDetallado`, no de
función). Y esta vez **declara explícitamente los dos tests modificados** con su justificación —
justo lo que faltó en la tanda anterior.

---

## 4 · Riesgos latentes que el contrato no cubre

1. **La conservación garantiza que ningún número desaparece, no que se atribuya bien.** m3 es el
   ejemplo: el 1500 acaba en `casa` y el 700 en huérfanos; el balance cuadra, la atribución no.
   Un `V15` de *atribución* (un importe declarado como agregado no puede acabar siendo un ítem)
   cerraría la última clase de error silencioso.
2. **`RATE_CONTEXT` no tiene `\b`** (`scenario.ts:224`): `/(tae|tasa|tipo|juros|…)/` casa dentro de
   palabras. Con fronteras posicionales el daño está acotado al rango, así que ya no es el peligro
   que era — pero el rango se calcula desde un match que puede empezar a mitad de palabra.
3. **Los nombres sucios acumulan conectores** (m1): hoy es cosmético, pero si algún día se usa el
   `name` como clave (agrupar por partida entre turnos, deduplicar), dejará de serlo.
4. **La guarda de sanidad solo actúa con el ingreso en el MISMO delta** — sin cambios; el detalle
   absurdo de un turno 2 contra un ingreso del turno 1 no se filtra.
5. **`detalle_confirmado` se promueve por silencio**: "confirmado" significa "no desmentido".

---

## 5 · Recomendación explícita a Luis

**Mergear, con tres condiciones — ninguna bloqueante del código de esta tanda.**

Los tres rechazos anteriores estaban justificados: en cada uno había una partida de gasto que
desaparecía en silencio y un usuario al que se le anunciaba un sobrante inexistente. **Esta vez no
lo encontré, y lo busqué activamente** con 6 mensajes nuevos diseñados para romper el mecanismo,
además de los 5 exigidos. El cambio a rangos posicionales es la corrección estructural correcta, y
la ley de conservación es una red que no existía en ninguna tanda anterior.

Condiciones (ninguna exige tocar este código):

1. **Ejecutar `test:e2e` y `smoke:db`** antes del merge — no verificables por mí (credenciales). Es
   la única parte de la batería que no he podido reproducir, y la regresión que originó toda esta
   serie se detectó precisamente por un ASSERT de `test:e2e`.
2. **Cerrar el PR de documentación de AG05** que enmienda §5.2 (10× → 50×). Hasta entonces el
   contrato y el código se contradicen por escrito, y el próximo revisor volverá a levantarlo.
3. **Escribir V12, V13 y V14 en §9 del contrato.** V14 (ley de conservación) es el mejor resultado
   de esta serie y hoy solo existe en un informe suelto.

**Tickets aparte, no bloqueantes** (todos preexistentes o cosméticos):
m3 (atribución del agregado — y considerar el `V15` del riesgo 1), m2 (subcadena en
`detectarCorreccionDeItem`), m1 (limpieza de nombres), el test de round-trip de BD para V9
(pendiente desde tres tandas), y el `\b` de `RATE_CONTEXT`.

**Lo que NO hay que tocar:** el mecanismo de rangos posicionales, la ley de conservación,
`valoresAsignadosEnDelta` como fuente única, la disciplina de alcance y `notaDetalleSinConfirmar`.

---

*Nota de método: batería completa reproducida en worktree aislado y desechable (`git worktree add
--detach`, eliminado al terminar), sin tocar el worktree de AG08 — `npm test` 14/14 ·
`test:guardrail` 262/262 · `test:calculator` 211/211 · `test:regression` 84/84 turnos ·
`tsc --noEmit` limpio · `npm run build` falla solo en el prerender de `/login` por falta de
credenciales Supabase (preexistente, idéntico en `develop`). Los 5 mensajes exigidos y los 6 de
rotura se ejecutaron contra `extractScenarioDelta`, `mergeScenario`, `buildScenarioContext`,
`analizarExtraccion` y `numerosCandidatos` reales, y se contrastaron contra `develop` con el mismo
script. `test:e2e` y `smoke:db`: no verificables por mí.*
