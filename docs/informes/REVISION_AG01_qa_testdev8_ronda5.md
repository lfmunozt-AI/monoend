# RECHAZADO — revisión adversarial AG01 · ronda 5 (`agent/08` @ `db7803c`)

**Revisor:** AG01 (Arquitecto) · **Implementador:** AG08 · **Fecha:** 2026-08-18
**Base:** `origin/develop` (`b166b22`) · **Rama juzgada:** `origin/agent/08` (`db7803c`), sin mergear
**Rondas previas:** 1 RECHAZADO · 2 APROBADO CON RESERVAS · 3 RECHAZADO · 4 APROBADO CON RESERVAS
**Reporte Fase 4 de AG08:** `docs/informes/CORRECCIONES_AG08_estructura_sin_keyword.md`
**Contrato:** `docs/CONTRATO_TRUTH_ENGINE.md` (§5.1, §5.2, §9 con E1-E10, §13, §14, §15)

> **Nota sobre el nombre del archivo.** Quinta ronda consecutiva que se entrega en archivo propio
> en vez de sobrescribir `REVISION_AG01_tanda1_truth_engine.md`, que el contrato cita como
> evidencia en **E2** y **E6**.

---

## 1 · Veredicto

**RECHAZADO** — por el riesgo espejo que el propio encargo mandaba comprobar (**O.3**) y que la
entrega no probó ni una sola vez.

**Lo que la tanda consigue es exactamente lo que se le pidió, y lo consigue entero.** El ancla
léxica desapareció de verdad: **17/17 fraseos correctos**, incluidos los 7 del diagnóstico, mis 6
inventados y —lo importante— los dos que **no contienen ninguna palabra de gasto**
(`"este mes 1200: internet 300, agua 400, gas 500"`, `"reparto de mis 1600 mensuales: …"`).
Cero "seguro y equivocado" en O.1 y O.2. La condición de piloto que arrastrábamos desde E9 queda
cerrada en su dirección de ida.

**Lo que lo bloquea es la dirección de vuelta:**

> Al quitar el ancla, la regla se volvió golosa. `ultimoLimiteDeClausula` solo corta en `.`, `!`,
> `?` y salto de línea — **la coma no corta** —, así que "la última cifra antes de los dos
> puntos" alcanza hacia atrás toda la frase y se lleva la cifra del campo que sea.
> `"tengo 2 hijos: colegio 900, comida 500"` toma **2** como el total de gastos mensuales.
> `"tengo 43 años: arriendo 900, comida 500"` toma **43**. `"gano 2300: arriendo 900, comida 500"`
> toma **2300**. En los tres, el gasto real (1400 €) se **destruye** y el usuario recibe una
> pregunta de aclaración absurda.

**Cinco de esos casos son regresión frente a `develop`**, donde hoy salen **correctos**. No es un
hueco heredado: es valor que esta tanda rompe.

Y hay un incumplimiento de proceso encima: **ninguno de los 4 casos que el encargo enumera en
O.3 está en la batería de AG08** (verificado con `grep`), y la tabla de regresión de su informe
no los menciona. Se probó a fondo la dirección de ida y no se probó la de vuelta, que era la
mitad explícita del encargo.

**Lo bueno que hay que registrar:** **V11 limpio por segunda ronda consecutiva** — cero líneas
eliminadas en tests, todo aditivo. El informe declara incluso un intento fallido propio
(`segmentSentences` rompiendo `deficit_detalle_manda`) en vez de esconderlo. Eso es exactamente
el comportamiento que la serie llevaba cinco tandas pidiendo.

Batería completa en verde: TypeScript limpio, 84/84 turnos, scenario 198→215, commandments 36
sin cambios.

---

## 2 · Hallazgos priorizados

### 🔴 B1 · BLOQUEANTE — el agregado falso: cualquier cifra de la frase se convierte en total de gastos

`src/lib/calculator/scenario.ts:657-669` (`ultimoLimiteDeClausula`) · `:671-705`
(`detectarAgregadoEstructural`), en particular la elección en `:686-691`

**Qué pasa.** La función ya no exige keyword. Para acotar la búsqueda usa
`ultimoLimiteDeClausula`, que solo reconoce `.`, `!`, `?` y `\n` como frontera. Dentro de una
frase normal —donde los usuarios encadenan datos con comas y con "y"— el tramo abarca todo, y se
elige **el último número antes de los dos puntos** sin comprobar a qué campo pertenece.

**Medición con el pipeline real** (`extractScenarioDelta` → `mergeScenario`), con `develop` como
control. La columna "agregado crudo" es lo que `detectarAgregadoEstructural` decide:

| Mensaje | Gastos reales | agregado crudo | `develop` | `agent/08` |
|---|---|---|---|---|
| `"gano 2300: arriendo 900, comida 500"` | 1400 | **2300** (ingreso) | **1400 `COMPLETE`** ✅ | `undefined` `AMBIGUOUS` ✗ **REGRESIÓN** |
| `"tengo 43 años: arriendo 900, comida 500"` | 1400 | **43** (edad) | **1400 `COMPLETE`** ✅ | `undefined` `AMBIGUOUS` ✗ **REGRESIÓN** |
| `"tengo 2 hijos: colegio 900, comida 500"` | 1400 | **2** (nº de hijos) | **1400 `COMPLETE`** ✅ | `undefined` `AMBIGUOUS` ✗ **REGRESIÓN** |
| `"mi sueldo es 2500 y mis gastos: arriendo 900, comida 500"` | 1400 | **2500** (sueldo) | **1400 `COMPLETE`** ✅ | `undefined` `AMBIGUOUS` ✗ **REGRESIÓN** |
| `"quiero financiar un carro de 30000 a 48 meses: cuota 700, seguro 100"` | 800 | **48** (plazo) | **800 `COMPLETE`** ✅ | `undefined` `AMBIGUOUS` ✗ **REGRESIÓN** |
| `"quiero una casa de 150000: arriendo 900, comida 500"` | 1400 | **150000** (meta) | 150500 ✗ | `undefined` ✗ *(ambas mal)* |
| `"a 48 meses: cuota 900, seguro 50"` | 950 | **48** (plazo) | 98 ✗ | `undefined` ✗ *(ambas mal)* |
| `"mi meta son 200000 en 240 meses: arriendo 900, comida 500"` | 1400 | **240** (meses) | 740 ✗ | `undefined` ✗ *(ambas mal)* |
| `"gano 2300 y ahorro 400: arriendo 900, comida 500"` | 1400 | **400** (ahorro) | 900 ✗ | `undefined` ✗ *(ambas mal)* |
| `"gano 2300. Gastos: arriendo 900, comida 500"` | 1400 | — | ✅ | ✅ *(el punto sí corta)* |

**Cinco regresiones netas.** En los otros cuatro `develop` también fallaba, pero eso no las
convierte en aceptables: son el mismo defecto.

**Por qué importa, más allá del número.** El §5.1 del contrato clasifica explícitamente
`años`, `hijos`, `meses` como **huérfanos no relevantes**, y da la razón textual:
*"sin esta clasificación, 'gano 2.300, tengo 43 años y 2 hijos, gasto 2.200' paralizaría el
sistema preguntando por la edad del usuario"*. Esta tanda va un paso más allá de lo que §5.1
temía: no pregunta por la edad, **declara que la edad es el gasto mensual** y luego pide al
usuario que aclare si gasta 2 € o 1.400 € al mes. Un usuario del piloto no vuelve de una
conversación así.

Además incumple §13 (*"conflictos falsos por error de parseo: 0"*) y vacía un campo extraído con
confianza (V1 en espíritu): los 1.400 € estaban perfectamente parseados y acaban en `undefined`.

**Atenuante que lo mantiene lejos de "seguro y equivocado":** el sistema **pregunta**, no afirma
—la discrepancia entre el agregado falso y la suma del detalle dispara `AMBIGUOUS`—. La línea
roja de O.1 no se cruza. Pero O.3 fija la suya con la misma claridad: *"Un falso agregado es tan
grave como el doble conteo"*.

**Corrección exigida — dos filtros, ambos con las piezas ya en el repo.** No hace falta rediseñar
nada ni volver al ancla léxica:

1. **Descartar los números ya reclamados por otro patrón declarativo.** `rangosReclamados`
   (`scenario.ts:867`) ya está poblado por ingreso, crédito, meta y precio en las líneas
   **888, 904, 935 y 955** — todas **antes** de la llamada a la regla estructural (`:972`).
   Hoy la función no lo consulta: basta elegir el último número **no reclamado**, y si no queda
   ninguno, no disparar. Es la misma corrección que recomendé como M1 en la ronda 3 y que quedó
   sin aplicar; sin ancla léxica ya no es "recomendada", es la condición que hace segura esta
   tanda.
2. **Descartar los números seguidos de sustantivo no monetario** (§5.1). Los detectores ya
   existen y están probados: `SUSTANTIVO_NO_MONETARIO_AFTER_RE` (`scenario.ts:1436`) y
   `TIEMPO_AFTER_RE` (`:1438`). Cierra `años`, `hijos`, `meses` de un golpe.

**Tests que deben acompañar la corrección** (hoy fallarían los 10): los 4 casos literales de O.3
del encargo, mis 6 vectores de esta tabla, y un control de que `"1200: internet 300, agua 400,
gas 500"` sigue dando 1200.

---

### 🟠 M1 · MAYOR — los casos obligatorios de O.3 no están en la batería

`docs/informes/CORRECCIONES_AG08_estructura_sin_keyword.md` §3

El encargo enumera cuatro casos concretos bajo *"O.3 — QUE NO SE ROMPA LO CONTRARIO (el riesgo
espejo de este fix)"*. Verificado con `grep -rl` sobre `src/`, `scripts/` y `tests/`: **ninguno de
los cuatro aparece**. La tabla de regresión del informe cubre solo dos escenarios ajenos a esa
lista (lista sin cifra previa, y dos listas seguidas) y declara la regresión "confirmada intacta".

No es mala fe —el informe es de los más honestos de la serie, hasta documenta un intento fallido
propio— pero es el patrón que esta revisión existe para cortar: **la batería mide con detalle la
dirección que el implementador quería arreglar y no mide la que podía romper**. Es la quinta
tanda en que un defecto real convive con una batería 100% verde.

**Corrección:** los 4 casos de O.3 como tests parametrizados, al mismo nivel que los 12 de la
dirección de ida.

---

### 🟡 m1 · MENOR — `ultimoLimiteDeClausula` no reconoce `;` ni `—`

`scenario.ts:657-669`. Solo corta en `.`, `!`, `?` y `\n`. El punto y coma y la raya son
separadores de cláusula frecuentes en texto real. Medido: `"gano 2300; gastos: arriendo 900,
comida 500"` toma **2300** como agregado y sale `AMBIGUOUS`. Con los dos filtros de B1 aplicados
el impacto se reduce mucho, pero ampliar el conjunto de cortes es barato y ortogonal.

### 🟡 m2 · MENOR — el rango reclamado abarca la cláusula entera

`scenario.ts:702` devuelve `{ start: inicioClausula, end: colonIdx + 1 }`. Al no haber ancla, el
rango reclamado empieza al principio de la cláusula, no en la cifra: puede cubrir texto que no
tiene nada que ver con el agregado. En las pruebas no vi pérdidas (ingreso y crédito siguieron
extrayéndose correctamente en los casos de B1), pero es una frontera más ancha de lo necesario y
convive con V13, que existe precisamente para que las fronteras sean quirúrgicas.

---

## 3 · Verificación del encargo (BLOQUE O)

### O.1 — los 7 fraseos medidos ✅ **7/7**

Todos `1200`, 3 ítems, `COMPLETE`. Ninguno "seguro y equivocado".

| Fraseo | Antes | Ahora |
|---|---|---|
| `"mis gastos fueron 1200: …"` | 1200 | **1200** ✅ |
| `"gastando 1200 al mes: …"` | 2400 | **1200** ✅ |
| `"mis desembolsos son 1200: …"` | 2100 | **1200** ✅ |
| `"mis salidas mensuales 1200: …"` | 2400 | **1200** ✅ |
| `"pago 1200 en total: …"` | 2400 | **1200** ✅ |
| `"se me van 1200: …"` | 2400 | **1200** ✅ |
| `"presupuesto mensual 1200: …"` | 2400 | **1200** ✅ |

### O.2 — mis 6 fraseos propios ✅ **6/6**

Verificados con `grep` como ausentes de `src/`, `scripts/` y `tests/` antes de escribirlos.

| # | Fraseo | Resultado |
|---|---|---|
| 1 | `"lo que pago cada mes son 1400: hipoteca 800, comida 400, luz 200"` | **1400** ✅ |
| 2 | `"el resumen del mes da 1350: renta 700, super 400, gasolina 250"` | **1350** ✅ |
| 3 | `"cierre de mes con 1500 en total: casa 800, comida 450, agua 250"` | **1500** ✅ |
| 4 | `"las cuentas del hogar suman 1250: alquiler 650, comida 400, luz 200"` | **1250** ✅ |
| 5 | **`"este mes 1200: internet 300, agua 400, gas 500"`** *(sin palabra de gasto)* | **1200** ✅ |
| 6 | **`"reparto de mis 1600 mensuales: hipoteca 900, super 450, gasolina 250"`** *(sin palabra de gasto)* | **1600** ✅ |

Los dos sin palabra de gasto son la prueba real de que el ancla léxica desapareció. Además, las
cuatro formas verbales que fallaban en mi ronda 4 (`"estoy gastando"`, `"he acabado gastando"`,
`"gastándome"`, `"mis egresos"`) ahora aciertan las cuatro.

### O.3 — riesgo espejo ❌ **10/10 mal, 5 de ellas regresión**

Ver B1. Los 4 casos del encargo más 6 vectores propios.

### O.4 — M10 sigue siendo sensor ✅ **4/4 intactas**

Con el pipeline completo y `conceptos = {sobrante: 250, gastos: 2250}`, las cuatro frases salen
**byte a byte iguales** y M10 ni siquiera dispara (no hay evidencia de eliminación previa en
`mutations`). Ninguna edición, ninguna inserción de cifra: el `"250 € es una buena pregunta"` de
la ronda 3 no puede volver. `commandments.ts` no se toca en este diff, y su suite sigue en 36/36.

### O.5 — sin regresiones ✅ (fuera de B1)

31 verificaciones, todas verdes: G1c bidireccional · `"gasto 2 500 €"` → 2500 · 15 partidas de
testdev7 (15 ítems, 2250) · dedup (5, no 11) con suma ítems = buckets = 2200 · V13 independencia
de orden (1090/1090) · los 6 mensajes de V15/V16 · casos 9-17 · E5-24 · desglose sin confirmar
(sin recorte, con sobrante) · B2 bloque coherente (1550/1450) · cuota derivada del estado
(881,25 sin datos nuevos) · V9 entre sesiones · cap §8 · `tool_call` de un ítem · detector de
pegado en ambos sentidos · **dos listas seguidas** (el caso que rompió su primer intento):
6 ítems, 11000, sin agregado inventado.

**Declaración de impacto como artefacto:** ✅ presente y contrastada contra el diff — coincide,
incluida la mención del intento descartado con `segmentSentences`.

---

## 4 · Tabla de invariantes

| # | Invariante | Estado | Evidencia |
|---|---|---|---|
| **V1** | Un dato con confianza no se descarta | ❌ **violado** | 1.400 € correctamente parseados acaban en `undefined` en 5 casos — B1 |
| **V5** | Nada inferido por el LLM entra en `conceptos` | ✅ verificado | M10 sigue sin escribir nada; el diff no toca el guardarraíl |
| **V8** | El cero se rechaza como placeholder | ✅ verificado | `agregado <= 0` descarta el candidato (`:691`); caso 17 intacto |
| **V9** | El estado sobrevive re-lectura desde BD | ✅ verificado | Desglose de 5 partidas recuperado entre sesiones |
| **V10** | `raw !== final` ⟹ ≥1 mutación | ✅ verificado | Pipeline sin cambios |
| **V11** | Prohibido reescribir un test para que afirme lo contrario | ✅ **limpio, 2ª ronda seguida** | **0 líneas eliminadas** en `*.test.ts`; 17 tests nuevos |
| **V12** | El ingreso nunca como ítem de gasto | ⚠️ **respetado en la letra, roto en el espíritu** | El ingreso no entra como *ítem*, pero sí se adopta como **agregado de gastos** (`"gano 2300: …"` → agregado 2300) |
| **V13** | Token reclamado = frontera con offsets | ✅ verificado | `expenses.ts:249` `interface Rango`; independencia de orden byte a byte. Ver m2 sobre la anchura del rango |
| **V14** | Conservación · `extraction_status` nunca `undefined` | ✅ verificado | ~45 mensajes, ninguno `undefined` |
| **V15** | Atribución correcta | ⚠️ **parcial** | 17/17 en la dirección de ida ✅; 10/10 mal en la de vuelta ✗ |
| **V16** | No doble conteo | ✅ verificado | L1/L2/L3/L5 correctos; el doble conteo de la ronda 4 cerrado |
| **V17** *(ronda 1)* | Ninguna capa reintroduce una cifra eliminada | ✅ verificado | M10 sin cambios |
| **V18** *(ronda 1)* | Bloque de datos verificados internamente consistente | ✅ verificado | B2 sigue cerrado |
| — | §5.1 · huérfanos no relevantes (años/hijos/meses) | ❌ **violado** | `detectarAgregadoEstructural` ignora `SUSTANTIVO_NO_MONETARIO_AFTER_RE` y `TIEMPO_AFTER_RE`, que ya existen |
| — | §13 · conflictos falsos por parseo = 0 | ❌ **violado** | 9 ambigüedades falsas |
| — | §13 · intervención sobre prosa → 0 | ✅ verificado | O.4: 4/4 intactas |
| — | `scenario_state` · `response_telemetry` · `runGuardrail` · `persistTurn` | ✅ verificado | Sin cambios en el pipeline |
| — | `llm.ts` NO tocado (dominio AG01) | ✅ verificado | ausente del diff |
| — | Tabla de puntos del ICA no redefinida (dominio AG06) | ✅ verificado | ausente del diff |
| — | Sin reconciliación/CONFLICT/ASSUMED nuevos (BLOQUE C) | ✅ verificado | `reconciliarGastos` sin tocar |
| — | Eco sin plantilla (BLOQUE G) | ✅ verificado | `renderDatosRecienEntendidos` sin tocar |
| — | Migración (BLOQUE F) | **no aplica** | El diff no toca `supabase/` |
| — | `test:e2e` · `smoke:db` | **no verificable por mí** | Requieren credenciales |

### Casos de aceptación 9-17 + extras

| # | Caso | Test | Ruta real | Pasa |
|---|---|---|---|---|
| 9 | `"Telecomunicaciones_Necesario 60 100 Pañales_Bebe_Vital"` | sí | sí | ✅ `AMBIGUOUS`, ítem sospechoso expuesto |
| 10 | `"gasto 2 500 €"` | sí | sí | ✅ 2500 |
| 11 | `"gano 2300, tengo 43 años, 2 hijos, gasto 2200"` | sí | sí | ✅ `COMPLETE` |
| 12 | `"gano 2300 y gasto 2200 y 450"` | sí | sí | ✅ `PARTIAL` |
| 13 | `"Diezmo_Vital 225, Casa_Vital 700"` | sí | sí | ✅ 2 ítems |
| 14 | `"alquiler 700 comida 450 luz 120"` | sí | sí | ✅ 3 ítems |
| 15 | `"Alquiler: 700, Comida: 450, Luz: 120"` | sí | sí | ✅ 3 ítems, 1270 |
| 16 | 15 partidas de testdev7 | sí | sí | ✅ 15 ítems, 2250 |
| 17 | Crédito con monto sin plazo | sí | sí | ✅ plazo nunca 0 |
| E5-24 | `"gasto aproximadamente 2000 entre vivienda, comida"` | sí | sí | ✅ 2000, ítems vacío |
| extra | Desglose sin confirmar: sin recorte, con sobrante | sí | sí | ✅ |
| I.1 | Fronteras como rangos `[start,end)` | sí | sí | ✅ `expenses.ts:249` — no es un set de strings |
| I.2 | Los 3 mensajes del bloqueante | sí | sí | ✅ 1200 · 1090 · idéntico |
| L 1-6 | V15/V16 | sí | sí | ✅ los 6 |

*Nota sobre el caso 11:* `"gano 2300, tengo 43 años, 2 hijos, gasto 2200"` sigue `COMPLETE` porque
**no lleva dos puntos**. Medido: la misma frase con `:` —`"gano 2300, tengo 43 años, 2 hijos:
arriendo 900, comida 500"`— toma **2** (el nº de hijos) como agregado y sale `AMBIGUOUS` con
`gastos = undefined`. El caso de la matriz sobrevive por la forma, no porque §5.1 se esté
aplicando en la ruta nueva.

---

## 5 · Riesgos latentes

**R1 — el péndulo.** Quinta tanda con el mismo patrón: cada corrección resuelve su dirección y
abre la contraria. Conectores → keyword → estructura sin filtro. La causa común es que
`detectarAgregadoEstructural` decide **con una sola señal cada vez** (antes léxica, ahora
posicional) en lugar de combinar las señales que el repo ya tiene (rangos reclamados, sustantivo
no monetario, coherencia con la suma del detalle). Merece una decisión de diseño explícita:
*ninguna señal única basta para adoptar una cifra como agregado*.

**R2 — la coma es el separador real del castellano hablado.** `ultimoLimiteDeClausula` asume
puntuación fuerte. Los usuarios del piloto escriben "gano 2300 y gasto 1200: ...". Mientras la
frontera sea solo `. ! ?`, cualquier filtro que se añada tendrá que hacer todo el trabajo.

**R3 — dos listas en el mismo mensaje sí funcionan hoy, pero por accidente.** El caso
`deficit_detalle_manda` pasa porque ninguna de las dos listas tiene cifra propia. Si el usuario
escribe `"vitales 5000: alquiler 2000, seguro 1000. no vitales 3000: ocio 2000, ropa 1000"`, cada
`:` verá su propia cláusula solo gracias al punto intermedio. Con coma en vez de punto, la
segunda lista tomaría la cifra de la primera. No lo cuento como hallazgo porque cae dentro de
B1, pero conviene un test explícito cuando se corrija.

**R4 — colisión de numeración de invariantes, aún abierta.** AG08 usó **V18** en la ronda 4 para
"ningún mandamiento edita prosa"; en mi informe de la ronda 1, V18 es "el bloque de datos
verificados es internamente consistente". Ni V17 ni V18 están todavía en §9 pese a estar
implementados y verificados en cuatro rondas. Es el mismo lío que E7/E8 tuvieron que cerrar para
V11-V13, y sigue creciendo.

---

## 6 · Recomendación a Luis

**Devolver a AG08.** Con dos filtros, no con un rediseño.

Insisto en el reconocimiento antes de la lista: esta tanda hace bien lo que se le pidió. El ancla
léxica está genuinamente eliminada —17/17, incluidos dos fraseos sin ninguna palabra de gasto—,
V11 está limpio por segunda ronda seguida, el informe declara un intento fallido propio en vez de
esconderlo, y la declaración de impacto coincide con el diff. El problema no es el enfoque: es
que se soltó el freno sin poner el filtro.

### Obligatorio antes de un nuevo PR

1. **B1 · Filtrar el candidato a agregado por dos criterios, ambos con las piezas ya en el repo:**
   - **descartar los números dentro de un rango ya reclamado** por ingreso/crédito/meta/precio
     (`rangosReclamados`, `scenario.ts:867`, poblado en `:888/904/935/955`, todas antes de
     `:972`); quedarse con el último **no reclamado** y, si no queda ninguno, **no disparar**;
   - **descartar los números seguidos de sustantivo no monetario** (§5.1), con
     `SUSTANTIVO_NO_MONETARIO_AFTER_RE` (`:1436`) y `TIEMPO_AFTER_RE` (`:1438`).
2. **M1 · Los 4 casos de O.3 como tests parametrizados**, más los 6 vectores de la tabla de B1.
   Criterio de cierre: los 10 en verde **y** los 17 de O.1/O.2 sin tocar.

### Recomendado en la misma tanda

3. **m1** — añadir `;` y `—` a `ultimoLimiteDeClausula`.
4. **m2** — que el rango reclamado empiece en la cifra, no al principio de la cláusula.
5. **R3** — test de dos listas con cifra propia cada una, separadas por coma.

### Enmiendas al contrato — quinta tanda arrastrándolas

- **V17** y **V18**, implementadas y verificadas en cuatro rondas consecutivas, siguen fuera de
  §9. **Resolver antes la colisión de numeración** (el invariante de AG08 "ningún mandamiento
  edita prosa" necesita número propio, **V19**).
- **§5.3** sigue describiendo solo el parser numérico. La regla estructural del agregado —ya en
  su tercera versión— debería quedar registrada en el cuerpo del contrato **con sus dos filtros
  como parte de la regla**, no como detalle de implementación. Si esta ronda enseña algo es que
  la regla sin filtros no es la regla: es media regla.

---

*Revisión ejecutada sobre `origin/agent/08` (`db7803c`) en worktree aislado, con `origin/develop`
(`b166b22`) como control para separar regresión de defecto preexistente. Ningún código de AG08
fue modificado; esta entrega es solo el informe.*
