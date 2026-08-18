# APROBADO CON RESERVAS — revisión adversarial AG01 · ronda 6 (`agent/08` @ `b611393`)

**Revisor:** AG01 (Arquitecto) · **Implementador:** AG08 · **Fecha:** 2026-08-18
**Base:** `origin/develop` (`b166b22`) · **Rama juzgada:** `origin/agent/08` (`b611393`), sin mergear
**Rondas previas:** 1 RECHAZADO · 2 APROBADO CON RESERVAS · 3 RECHAZADO · 4 APROBADO CON RESERVAS · 5 RECHAZADO
**Reportes Fase 4:** `CORRECCIONES_AG08_estructura_sin_keyword.md` · `CORRECCIONES_AG08_aritmetica_decide_agregado.md`
**Contrato:** `docs/CONTRATO_TRUTH_ENGINE.md` (§4, §5.1, §5.2, §6, §9 con E1-E10, §10, §13, §15)

> **Nota sobre el nombre del archivo.** Sexta ronda consecutiva en archivo propio en vez de
> sobrescribir `REVISION_AG01_tanda1_truth_engine.md`, que el contrato cita como evidencia en
> **E2** y **E6**.

---

## 1 · Veredicto

**APROBADO CON RESERVAS — mergear, con una condición de piloto de una línea.**

El encargo me pide clasificar el riesgo residual con precisión en vez de rechazar por precaución.
Lo he medido caso por caso contra `develop`, y el resultado es inequívoco: **esta rama es mejor
que `develop` en todo lo que medí y no es peor en nada, salvo un efecto secundario nuevo y
acotado.**

**Los cinco bloqueantes que rechacé en la ronda 5 están cerrados.** Las tres compuertas funcionan
y —lo importante— funcionan **por separado**, que era la condición del diseño:

- **C1** la coma corta cláusula: `"gano 2300, arriendo 900: comida 500, luz 120"` ya no puede
  leer 2300 como agregado.
- **C2** el candidato reclamado se descarta: `"gano 2300: arriendo 900, comida 500"` → gastos
  **1400**, ingreso **2300**, `COMPLETE`.
- **C3** la aritmética decide: un candidato que no reconcilia dentro del 5% no se adopta.

Y la ganancia va más allá de reparar la ronda 5: frente a `develop`, **5 casos preservados, 3
mejorados, 0 regresiones** en la matriz de riesgo espejo. `"quiero una casa de 150000: …"` pasa
de 150500 a **1400**; `"a 48 meses: cuota 900, seguro 50"` de 98 a **950**; `"mi meta son 200000
en 240 meses: …"` de 740 a **1400**. Los 9 fraseos sin keyword siguen en **9/9**, incluidos los
dos sin ninguna palabra de gasto. **V19 verificado**: en los tres casos de agregado ambiguo, el
ingreso, la meta y el plazo se persisten igual, y los ítems se extraen con normalidad.

**V11 limpio por tercera ronda consecutiva** — cero líneas eliminadas en tests.

**La reserva** es un efecto secundario **nuevo** del bloque "PLAZO BARE" (`scenario.ts:995-1006`):

> Cualquier mensaje con la forma `"N meses:"` seguida de una lista abre un **crédito fantasma**.
> `"en 3 meses: viaje 500, regalos 300"` produce `credito = {plazo_meses: 3}` con
> `missing = ["monto","tae","ingreso"]`. El Consigliere pedirá el **monto del préstamo** y la
> **TAE** a alguien que estaba presupuestando un viaje. 4 de 4 mensajes que probé lo disparan,
> incluidos los que no tienen nada que ver con financiación.

No corrompe ninguna cifra —los gastos salen correctos en los cuatro— y **el arreglo es de una
línea**: el bloque solo necesita empujar el rango a `rangosReclamados` para que C2 lo proteja;
escribir `delta.credito` es un efecto colateral innecesario para su propósito declarado.

Además dejo cuantificado, por primera vez en la serie, **el riesgo residual de fondo** (§4): una
cifra que no es un gasto, situada antes de los dos puntos y con un nombre adyacente, es absorbida
como **partida de gasto**. 4 de mis 5 mensajes de O.2 fallan por esa vía, 2 de ellos `COMPLETE`.
Lo verifiqué en `develop`: **idéntico, byte a byte. No es regresión de esta tanda** — es el techo
del enfoque actual, y creo que Luis necesita verlo con números antes del piloto.

Batería completa en verde: TypeScript limpio, 84/84 turnos, scenario 215→228, guardrail sin
cambios (36/36 en commandments).

---

## 2 · Hallazgos priorizados

### 🟠 M1 · MAYOR — crédito fantasma: `"N meses:"` + lista abre un préstamo inexistente

`src/lib/calculator/scenario.ts:995-1006` (bloque "PLAZO BARE + LISTA", **nuevo en esta tanda**),
en particular `:1002`

```js
delta.credito = { ...(delta.credito ?? { tae_es_referencia: true }), plazo_meses: meses };
```

Medido con el pipeline real. En los cuatro, los gastos salen **correctos** — el problema es el
`credito` que aparece de la nada y el `missing` que arrastra:

| Mensaje | gastos | `credito` | `missing` |
|---|---|---|---|
| `"a 48 meses: cuota 900, seguro 50"` | 950 ✅ | `{plazo_meses: 48}` | `["monto","tae","ingreso"]` |
| `"en 3 meses: viaje 500, regalos 300"` | 800 ✅ | `{plazo_meses: 3}` | `["monto","tae","ingreso"]` |
| `"para los próximos 12 meses: seguro 600, itv 100"` | 700 ✅ | `{plazo_meses: 12}` | `["monto","tae","ingreso"]` |
| `"el año que viene, en 6 meses: curso 400, libros 200"` | 600 ✅ | `{plazo_meses: 6}` | `["monto","tae","ingreso"]` |

En `develop` ninguno de los cuatro crea `credito` (y a cambio los gastos salían mal: 98, 303,
712). El intercambio es netamente positivo en las cifras y netamente negativo en la conversación.

**Por qué importa.** `missing` es lo que gobierna qué pregunta el Consigliere al cerrar. Un
usuario que escribe *"en 3 meses: viaje 500, regalos 300"* recibirá una pregunta por el importe
del crédito y por la TAE que le ofrece su banco. Es exactamente la clase de *non sequitur* que
abrió el QA de testdev8 (bloqueante 3: "pedir un dato que el motor ya puede calcular" — aquí es
peor: pedir un dato de algo que el usuario nunca mencionó).

**Incumplimiento de la declaración de impacto (BLOQUE H).** El propio informe Fase 4 justifica lo
angosto del bloque diciendo: *"una versión sin esa restricción abriría un `credito` fantasma
(`missing: ['monto','tae']`) ante cualquier mención suelta de duración"*. La medición demuestra
que **la versión entregada lo abre igual**: la restricción de "≥2 partidas tras el `:`" no evita
el fantasma, solo lo condiciona a que haya una lista. El reporte afirma una propiedad que el
código no tiene.

**Corrección exigida — una línea.** El propósito declarado del bloque (§2 de su informe) es que
Compuerta 2 proteja el número del plazo. Eso lo consigue **solo** con
`rangosReclamados.push(r)` (`:1003`). Eliminar la asignación de `delta.credito` en `:1002`
mantiene el beneficio (gastos 950/800/700/600 correctos) y borra el fantasma. Si se quiere
conservar el plazo como dato, que sea en un campo que **no** arrastre `monto`/`tae` a `missing`.

**Test que debe acompañarla:** `"en 3 meses: viaje 500, regalos 300"` → gastos 800 **y**
`credito === undefined` **y** `missing` sin `monto`/`tae`.

---

### 🟠 M2 · MAYOR — riesgo residual cuantificado (preexistente, **no** regresión)

`src/lib/calculator/scenario.ts:743` (Compuerta 3) en combinación con el parser de listas

Cuando C3 rechaza un candidato (`diffPct > 5%`), el número **cae al parser de listas** y, si
tiene un nombre adyacente, **se incorpora como una partida de gasto**. Es comportamiento
declarado y deliberado en el informe de AG08 (*"si tenía un nombre adyacente se incorpora como
una partida más — nunca se pierde"*), y resuelve V19. Pero tiene un coste que nadie había medido:

**Mis 5 mensajes de O.2** (verificados con `grep` como ausentes de su batería), donde la cifra
antes de los dos puntos **no** es un gasto:

| Mensaje | Qué es la cifra | Esperado | `develop` | `agent/08` |
|---|---|---|---|---|
| `"cobro 1900: arriendo 800, comida 400, luz 200"` | ingreso | 1400 | 1400 ✅ | **1400 ✅** |
| `"tengo ahorrado 40000: arriendo 800, comida 400, luz 200"` | patrimonio | 1400 | 41400 ✗ | 41400 ✗ `AMBIGUOUS` |
| `"somos 4 en casa: comida 600, colegio 400, ropa 200"` | nº de personas | 1200 | 1204 ✗✗ | 1204 ✗✗ **`COMPLETE`** |
| `"la TAE es del 12: cuota 700, seguro 100, mantenimiento 50"` | TAE | 850 | 162 ✗ | 162 ✗ `PARTIAL` |
| `"desde 2024: alquiler 800, comida 400, luz 200"` | un año | 1400 | 3424 ✗✗ | 3424 ✗✗ **`COMPLETE`** |

**Las cinco columnas coinciden byte a byte con `develop`.** Esta tanda no lo empeora ni lo
mejora: es el techo del enfoque. Dos de los cinco son "seguro y equivocado".

**Por qué lo reporto aunque no sea regresión.** El encargo me pide decir si lo que queda es
bloqueante de piloto o deuda aceptable. Mi lectura: **deuda aceptable para el merge, condición de
piloto para los casos `COMPLETE`**. `"somos 4 en casa: …"` da 1204 € de gasto con plena confianza,
y `"desde 2024: …"` da 3424 €. Un usuario del piloto puede escribir cualquiera de las dos.

**Corrección recomendada (no en esta tanda):** aplicar §5.1 también en el parser de listas antes
de aceptar un número como importe de partida — `SUSTANTIVO_NO_MONETARIO_AFTER_RE` y
`TIEMPO_AFTER_RE` (`scenario.ts:1436/1438`) ya cubren `años`/`hijos`/`meses`/`personas`, y para
`2024` y `40000` haría falta una señal distinta (año de 4 dígitos sin unidad, cifra sin nombre de
partida reconocible). Alternativa más barata y en el espíritu del §0: si el número rechazado por
C3 iba a convertirse en partida y su nombre adyacente **no** es una categoría de gasto conocida,
degradar a `AMBIGUOUS` en vez de sumarlo.

---

### 🟡 m1 · MENOR — C3 mide la materialidad contra la suma, §6 la mide contra el agregado

`scenario.ts:741-743` calcula `diffPct = |agregado − suma| / suma × 100`. La función canónica del
contrato, `calcularMaterialidad` (§6), usa el **agregado** como denominador:
`|diff| / |agregado| × 100`. Con divergencias pequeñas da casi lo mismo, pero en el borde del 5%
las dos fórmulas clasifican distinto (p. ej. agregado 1000 / suma 1053: 5,03% contra la suma,
5,3% contra el agregado). Dos umbrales con el mismo nombre y distinto denominador en el mismo
archivo es deuda técnica barata de cerrar: reutilizar `calcularMaterialidad`.

### 🟡 m2 · MENOR — el caso 8 de §10 no produce `CONFLICT` (preexistente)

`"mis gastos son 2200: arriendo 3000, comida 2000, luz 1000"` (declarado 2200 vs detalle 6000,
173%) → `AMBIGUOUS`, `gastos = undefined`, **`gastos_conflict = undefined`**. La matriz §10 caso 8
espera `CONFLICT` **no elegible** para escape. Verificado idéntico en `develop`: **no es
regresión**, y §4 paso 2 sanciona la precedencia de `AMBIGUOUS` sobre `CONFLICT`
(*"extraction_incomplete tiene precedencia sobre conflict. Siempre"*). Queda como divergencia
entre §10 y §4 que el contrato debería resolver, no como defecto de esta entrega.
El caso 2 (2200 vs 2250, 2,3%) **sí** registra `gastos_conflict = [2200, 2250]` ✅.

---

## 3 · Verificación del encargo (BLOQUE O)

### O.1 — las tres compuertas por separado ✅

| Compuerta | Prueba | Resultado |
|---|---|---|
| **C1** coma/`;` cortan cláusula | `"gano 2300, arriendo 900: comida 500, luz 120"` | candidato **no** es 2300 ✅ · ingreso 2300, gastos 1520 (900 se incorpora como partida, 45% no reconcilia) |
| **C2** candidato en `rangosReclamados` | `"gano 2300: arriendo 900, comida 500"` | gastos **1400**, ingreso **2300**, `COMPLETE` ✅ |
| **C3** la aritmética decide | `"otros 5000: internet 300, agua 400, gas 500"` (317%) | el 5000 **no** se adopta como agregado ✅ — pero se incorpora como partida (`gastos 6200`): ver M2 |

`ultimoLimiteDeClausula` en `scenario.ts:666-678` corta en `\n`, `,`, `;`, `.`, `!`, `?`, con la
excepción numeric-safe para `1.200`. `detectarAgregadoEstructural` (`:693`) recibe
`rangosReclamados` como tercer argumento (`:1094`) y aplica el solapamiento en `:726`; la
reconciliación en `:743`.

### O.2 — 5 mensajes inventados donde la cifra no es gasto ⚠️ **1/5**

Ver M2. **Idéntico a `develop` en los cinco** — no es regresión de esta tanda.

### O.3 — V19: un agregado ambiguo no descarta el resto ✅ **3/3**

| Mensaje | Resultado |
|---|---|
| `"quiero una casa de 150000: arriendo 900, comida 500"` | meta **150000** ✅ · gastos **1400** ✅ · 2 ítems ✅ *(develop: 150500 ✗)* |
| `"gano 2300: arriendo 900, comida 500"` | ingreso **2300** ✅ · gastos **1400** ✅ · 2 ítems ✅ |
| `"a 48 meses: cuota 900, seguro 50"` | plazo **48** ✅ · gastos **950** ✅ · `cuota = 900`, nunca 48 ✅ *(develop: 98 ✗)* |

La regresión que medí en la ronda 5 (*"devolvía NADA — ni la meta"*) está cerrada.

### O.4 — el caso origen sigue vivo ✅

`"gasto 2200: [ítems que suman 2250]"` → `gastos_conflict = {agregado: 2200, detalle: 2250,
diffPct: 2,27}` ✅. La reconciliación lo clasifica como agregado con conflicto material, no como
"no es el agregado". **G1c intacto**, y bidireccional (agregado→detalle y detalle→agregado dan el
mismo `[2200, 2250]`).

### O.5 — los 7 fraseos sin keyword + 2 propios ✅ **9/9**

Los 7 medidos (`"se me van 1200: …"`, `"presupuesto mensual 1200: …"`, `"gastando 1200 al mes:
…"`, `"mis desembolsos son 1200: …"`, `"mis salidas mensuales 1200: …"`, `"pago 1200 en total:
…"`, `"mis gastos fueron 1200: …"`) más mis dos sin ninguna palabra de gasto
(`"1200: internet 300, agua 400, gas 500"`, `"este mes 1200: internet 300, agua 400, gas 500"`):
**los nueve dan 1200, 3 ítems, `COMPLETE`**.

### O.6 — sin regresiones ✅ **31/31**

M10 sensor (las 4 intactas, M10 ni dispara — V18) · M3 · M9 · G1b · G1c bidireccional ·
`"gasto 2 500 €"` → 2500 · 15 partidas de testdev7 (2250) · dedup 5 (no 11) con ítems = buckets
= 2200 · V13 independencia de orden · los 6 mensajes de V15/V16 · casos 9-17 · E5-24 · desglose
sin confirmar · B2 bloque coherente · cuota derivada del estado · V9 entre sesiones · cap §8 ·
`tool_call` de un ítem · detector de pegado en ambos sentidos · dos listas seguidas (6 ítems,
11000, sin agregado inventado).

**Declaración de impacto como artefacto:** presente. Coincide con el diff salvo la afirmación
sobre el crédito fantasma (ver M1).

---

## 4 · Tabla de invariantes

| # | Invariante | Estado | Evidencia |
|---|---|---|---|
| **V1** | Un dato con confianza no se descarta | ✅ **restaurado** | La regresión de la ronda 5 está cerrada: los 1400 € sobreviven en los tres casos de O.3 |
| **V5** | Nada inferido por el LLM entra en `conceptos` | ✅ verificado | El diff no toca el guardarraíl; M10 sigue sin escribir |
| **V8** | El cero se rechaza como placeholder | ✅ verificado | `agregado <= 0` descarta el candidato; caso 17 intacto |
| **V9** | El estado sobrevive re-lectura desde BD | ✅ verificado | Desglose de 5 partidas recuperado entre sesiones |
| **V10** | `raw !== final` ⟹ ≥1 mutación | ✅ verificado | Pipeline sin cambios |
| **V11** | Prohibido reescribir un test para que afirme lo contrario | ✅ **limpio, 3ª ronda seguida** | **0 líneas eliminadas** en `*.test.ts`; 13 tests nuevos |
| **V12** | El ingreso nunca como ítem de gasto | ✅ **restaurado** | `"gano 2300: …"` → ingreso 2300, gastos 1400; testdev7 sin ítem de 2500 |
| **V13** | Token reclamado = frontera con offsets | ✅ verificado | `expenses.ts:249` `interface Rango`; C2 usa solapamiento de rangos; independencia de orden 1090/1090 |
| **V14** | Conservación · `extraction_status` nunca `undefined` | ✅ verificado | ~60 mensajes, ninguno `undefined` |
| **V15** | Atribución correcta | ⚠️ **parcial** | 9/9 sin keyword y 3/3 de O.3 ✅; 4/5 de O.2 ✗ (preexistente, M2) |
| **V16** | No doble conteo | ⚠️ **parcial** | L1/L2/L3/L5 ✅; el doble conteo residual de M2 es el mismo mecanismo (preexistente) |
| **V17** *(ronda 1)* | Ninguna capa reintroduce una cifra eliminada | ✅ verificado | M10 sin cambios |
| **V18** *(ronda 1)* | Bloque de datos verificados internamente consistente | ✅ verificado | B2 sigue cerrado (1550/1450) |
| **V19** *(nuevo, AG08)* | Un agregado ambiguo nunca descarta el resto del delta | ✅ **verificado** | O.3, 3/3 |
| — | §5.1 · huérfanos no relevantes (años/hijos/meses) | ✅ **restaurado en la ruta del agregado** | `"tengo 43 años: …"` y `"tengo 2 hijos: …"` → 1400. Sigue sin aplicarse en el parser de listas (M2) |
| — | §13 · conflictos falsos por parseo = 0 | ✅ **restaurado** | Las 9 ambigüedades falsas de la ronda 5 desaparecen |
| — | §13 · intervención sobre prosa → 0 | ✅ verificado | O.6: las 4 frases intactas |
| — | §10 caso 8 · `CONFLICT` con divergencia >5% | ⚠️ **divergente** | `AMBIGUOUS` sin `CONFLICT` — preexistente, ver m2 |
| — | `scenario_state` · `response_telemetry` · `runGuardrail` · `persistTurn` | ✅ verificado | Pipeline sin cambios |
| — | `llm.ts` NO tocado (dominio AG01) | ✅ verificado | ausente del diff |
| — | Tabla de puntos del ICA no redefinida (dominio AG06) | ✅ verificado | ausente del diff |
| — | Sin reconciliación/CONFLICT/ASSUMED nuevos (BLOQUE C) | ✅ verificado | `reconciliarGastos` sin tocar; C3 reutiliza `MATERIALIDAD_MAX_PCT` ya vigente |
| — | Eco sin plantilla (BLOQUE G) | ✅ verificado | `renderDatosRecienEntendidos` sin tocar |
| — | Migración (BLOQUE F) | **no aplica** | El diff no toca `supabase/` |
| — | `test:e2e` · `smoke:db` | **no verificable por mí** | Requieren credenciales |

### Casos de aceptación 9-17 + extras

| # | Caso | Test | Ruta real | Pasa |
|---|---|---|---|---|
| 9 | `"Telecomunicaciones_Necesario 60 100 Pañales_Bebe_Vital"` | sí | sí | ✅ `AMBIGUOUS`, ítem sospechoso expuesto, sin conflicto |
| 10 | `"gasto 2 500 €"` | sí | sí | ✅ 2500 |
| 11 | `"gano 2300, tengo 43 años, 2 hijos, gasto 2200"` | sí | sí | ✅ `COMPLETE`, no pregunta por 43 ni 2 |
| 12 | `"gano 2300 y gasto 2200 y 450"` | sí | sí | ✅ `PARTIAL` |
| 13 | `"Diezmo_Vital 225, Casa_Vital 700"` | sí | sí | ✅ 2 ítems con `_` |
| 14 | `"alquiler 700 comida 450 luz 120"` | sí | sí | ✅ 3 ítems |
| 15 | `"Alquiler: 700, Comida: 450, Luz: 120"` | sí | sí | ✅ 3 ítems, 1270 |
| 16 | 15 partidas de testdev7 | sí | sí | ✅ 15 ítems, 2250 |
| 17 | Crédito con monto sin plazo | sí | sí | ✅ plazo nunca 0 |
| E5-24 | `"gasto aproximadamente 2000 entre vivienda, comida"` | sí | sí | ✅ 2000, `gastos_items` vacío |
| extra | Desglose sin confirmar: sin recorte, con sobrante | sí | sí | ✅ sobrante 250, sin `recorte_propuesto_50pct` |
| I.1 | Fronteras como rangos `[start,end)` | sí | sí | ✅ `expenses.ts:249` — no es un set de strings |
| I.2 | Los 3 mensajes del bloqueante | sí | sí | ✅ 1200 · 1090 · idéntico en ambos órdenes |
| L 1-6 | V15/V16 | sí | sí | ✅ los 6 |

---

## 5 · Riesgos latentes

**R1 — el techo del enfoque, ahora cuantificado.** Cinco tandas de iteración han llevado la
detección del agregado a un punto muy bueno (9/9 sin keyword, 3/3 en riesgo espejo dirigido),
pero M2 muestra el límite: el sistema decide bien **qué es el agregado** y sigue decidiendo mal
**qué es un gasto**. El parser de listas acepta como partida cualquier `nombre + número`, sin
aplicar §5.1. Mientras eso siga así, cada mejora en el agregado desplaza el error al detalle. Es
la misma dinámica de péndulo que señalé en la ronda 5, un nivel más abajo.

**R2 — el bloque PLAZO BARE es un precedente.** Es el primer sitio donde se escribe un campo de
negocio (`credito`) como **efecto secundario** de una necesidad del parser (reclamar un rango).
Conviene separar las dos cosas por diseño: reclamar rangos no debería poder crear estado
financiero.

**R3 — dos denominadores de materialidad.** Ver m1. Hoy no produce diferencias observables, pero
un cambio futuro del umbral se aplicará de forma inconsistente.

**R4 — colisión de numeración de invariantes, cuarta ronda abierta.** Ahora hay **tres**
candidatos a número: mi V17 y V18 de la ronda 1, el "V18" de AG08 de la ronda 4 ("ningún
mandamiento edita prosa") y el **V19** que esta tanda introduce y que yo he verificado. Ninguno
está en §9. Si se incorporan sin resolver la colisión, el contrato queda con dos V18 distintos.

---

## 6 · Recomendación a Luis

**Mergear**, con **una** condición antes del piloto.

Esta es la tanda más sólida de la serie y conviene decirlo: cierra los cinco bloqueantes de la
ronda 5, mejora tres casos más que `develop` no resolvía, no introduce ninguna regresión en 31
verificaciones de no-regresión, respeta V11 por tercera vez seguida, e introduce V19 —un
invariante que a mí me parece correcto y que he verificado 3/3—. El cambio de enfoque (dejar de
deducir "qué es" una cifra por su contexto textual y pasar a **verificarlo aritméticamente**) es
la primera idea de la serie que no ha desplazado el fallo a otro sitio.

### Condición de piloto (no de merge) — una línea

1. **M1 · Eliminar la asignación de `delta.credito` en `scenario.ts:1002`.** El bloque cumple su
   propósito (proteger el plazo vía C2) solo con `rangosReclamados.push(r)`. Con el test
   `"en 3 meses: viaje 500, regalos 300"` → gastos 800 **y** `credito === undefined` **y**
   `missing` sin `monto`/`tae`. Si prefieres conservar el plazo, que vaya a un campo que no
   arrastre `monto`/`tae` a `missing`.

### Deuda registrada — decisión explícita tuya, no olvido

2. **M2 · El riesgo residual de O.2.** No lo cuento como bloqueante porque es idéntico a
   `develop` y esta tanda no lo toca, pero dos casos salen `COMPLETE` con cifra equivocada
   (`"somos 4 en casa: …"` → 1204 €; `"desde 2024: …"` → 3424 €). Mi recomendación: **aplicar
   §5.1 en el parser de listas** antes de aceptar un número como importe de partida, o degradar a
   `AMBIGUOUS` cuando el nombre adyacente no sea una categoría de gasto reconocible. Si decides
   diferirlo al post-piloto, que quede registrado como deuda aceptada y no como algo que se nos
   pasó.
3. **m1** — reutilizar `calcularMaterialidad` en C3.
4. **m2** — resolver en el contrato la divergencia entre §10 caso 8 (`CONFLICT`) y §4 paso 2
   (`AMBIGUOUS` tiene precedencia). Hoy gana §4 en el código; que gane también en el papel.

### Enmiendas al contrato — sexta tanda arrastrándolas

- **V17**, **V18** (el mío) y ahora **V19** siguen fuera de §9, pese a estar implementados y
  verificados. **Resolver primero la colisión**: el invariante de AG08 de la ronda 4 necesita un
  número propio, y V19 ya está ocupado por el de esta tanda.
- **§5.3** sigue describiendo solo el parser numérico. La regla del agregado va por su cuarta
  versión y ahora tiene una forma estable y describible en tres líneas (estructura + tres
  compuertas). Es el momento de escribirla en el cuerpo del contrato, con su límite conocido
  (M2) declarado como parte de la regla.

---

*Revisión ejecutada sobre `origin/agent/08` (`b611393`) en worktree aislado, con `origin/develop`
(`b166b22`) como control para separar regresión de defecto preexistente. Ningún código de AG08
fue modificado; esta entrega es solo el informe.*
