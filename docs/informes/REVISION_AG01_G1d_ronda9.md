# APROBADO CON RESERVAS — revisión adversarial AG01 · ronda 9 (`agent/08` @ `31af215`)

**Revisor:** AG01 (Arquitecto) · **Implementador:** AG08 · **Fecha:** 2026-08-22
**Base:** `origin/develop` (`f4a1414`, ya con la tanda 7 recuperada — PR #66) · **Rama juzgada:** `origin/agent/08` (`31af215`), sin mergear
**Reportes Fase 4:** `CORRECCIONES_AG08_G1d_fidelidad_extraccion.md` · `CORRECCIONES_AG08_G1d_cierre_marca_anual.md`
**Contrato:** `docs/CONTRATO_TRUTH_ENGINE.md` (§5.1, §9 con E11-E14, §15)

---

## 1 · Veredicto

**APROBADO CON RESERVAS — mergear.**

**Mi reserva de la ronda 8 está cerrada, y verificada con los casos exactos que la abrieron.** La
tolerancia `÷12`/`×12` ya solo se aplica cuando el candidato lleva **marca anual explícita**
(`scenario.ts:1749`), de modo que el agregado ya no puede "cubrir" una pérdida por coincidencia
aritmética:

| Caso (2 de 3 capturadas, agregado 1200) | ronda 8 | ahora |
|---|---|---|
| `"renta 1000, comida 200, luz 100"` — perdida `[100]` | ✗✗ `COMPLETE`, detectadas `[]` | ✅ **`PARTIAL`, detectadas `[100]`** |
| `"renta 900, comida 300, luz 100"` — perdida `[100]` | ✗✗ `COMPLETE` | ✅ **`PARTIAL`** |
| control `"…luz 150"` | ✓ `PARTIAL` | ✅ `PARTIAL` |
| 3 perdidas de 50 con agregado 600 | ⚠️ 2 de 3 | ✅ **3 de 3** |

El caso de valores repetidos mejora además sobre la propia tanda anterior (de 2/3 a 3/3). El
mensaje real de 17 partidas sigue capturando **las 17** con **2.205 €** y `COMPLETE` legítimo, y
la reproducción del incidente (11 de 17) degrada a `PARTIAL` detectando **las 6** perdidas.

**El hallazgo de proceso de la ronda 8 está resuelto y bien resuelto.** `agent/08` **contiene**
`origin/develop` (verificado con `git merge-base`), el fix del bloqueante G1b sobrevive
(`content: ''`, `route.ts:621`), y `esEstructuraRepetida` sigue viva. AG08 documenta en §0 la
causa real de la pérdida —un `--force-with-lease` al cierre de la tanda 7— y cómo la recuperó. El
rebase produjo un conflicto en `route.static.test.ts` que resolvió **conservando los dos bloques**
de tests: 13 tests, verificado.

**La congelación de alcance se respeta.** El diff **no toca `consigliere.ts`**, y el único cambio
en `route.ts` es el sensor G1d — comprobado línea a línea: ni una sola modificación de tono.

**V11 limpio por sexta ronda consecutiva** (0 líneas eliminadas en tests) y **regresión 34/34**,
más la batería completa (84/84, scenario 248→252).

**La reserva** es la familia de **falsos `PARTIAL`** que ya reporté en la ronda 8 y que sigue
abierta: 7 de 17 mensajes normales con números no monetarios degradan sin motivo. Es
**preexistente** —idéntica en `develop`— y esta tanda incluso **mejora una categoría**. Pero ahora
importa más que antes: con el sensor G1d recién instalado, cada uno de esos turnos se registrará
como un fallo de fidelidad y va a enterrar los casos reales.

---

## 2 · Hallazgos priorizados

### 🟠 M1 · MAYOR — la familia de falsos `PARTIAL` sigue abierta, y ahora contamina el sensor

`src/lib/calculator/scenario.ts:1624-1626` (`SUSTANTIVO_NO_MONETARIO_AFTER_RE` / `TIEMPO_AFTER_RE`)

O.3 pedía inventar 6 mensajes normales con números no monetarios y comprobar que ninguno degrada.
Inventé 6 nuevos (verificados con `grep` como ausentes de su batería) y reejecuté los 6 de la
ronda 8:

| Mensaje | Qué es la cifra | Resultado |
|---|---|---|
| `"llevo 12 años en la misma empresa…"` | antigüedad | ✅ `COMPLETE` |
| `"mis 2 hijos van al colegio…"` | nº de hijos | ✅ `COMPLETE` |
| `"quiero una hipoteca a 30 años…"` | plazo | ✅ `COMPLETE` |
| **`"me ofrecen una TAE del 7 sin comisiones…"`** | TAE sin `%` | ✅ **`COMPLETE` — mejora de esta rama** *(develop: `PARTIAL [7]`)* |
| `"cumplí 38 en marzo…"` | edad | ✗ `PARTIAL`, `[38]` |
| `"el piso tiene 90 metros…"` | superficie | ✗ `PARTIAL`, `[90]` |
| `"gano 2400, cumplo 40 este año…"` | edad | ✗ `PARTIAL`, `[40]` |
| `"somos 5 en casa…"` | personas | ✗ `PARTIAL`, `[5]` |
| `"…rentabilidad del 3 por ciento…"` | % en palabras | ✗ `PARTIAL`, `[3, 100]` |
| `"desde 2019 vivo aquí…"` | un año | ✗ `PARTIAL`, `[2019]` |
| `"tenemos 3 coches…"` | objetos | ✗ `PARTIAL`, `[3]` |

**Los siete fallos son idénticos en `develop`** — preexistentes, no regresión. La causa es que
§5.1 solo reconoce el sustantivo **posterior** al número (`43 años`, `2 hijos`), y estas formas lo
llevan antes (`somos 5`, `cumplí 38`), en palabras (`3 por ciento`), o no lo llevan (`2019`).

**Por qué sube de prioridad respecto a la ronda 8.** Dos motivos concretos:

1. **Rompe G2 y G3.** Cada uno de estos turnos hace que el Consigliere pida aclaración sobre la
   edad del usuario, el número de coches o los metros del piso. El encargo lo dice explícitamente:
   *"un sobredisparo convierte al Consigliere en interrogador"*.
2. **Contamina el sensor que esta tanda acaba de instalar.** `importes_sin_destino` se alimenta de
   `huerfanos.numerosHuerfanos` (`route.ts:504-506`), así que **cada falso `PARTIAL` entra en la
   telemetría de fidelidad como si fuera una partida perdida**. El digest nocturno de G1d va a
   mezclar `[38]` (la edad de alguien) con `[5, 20, 10, 10, 50, 30]` (seis gastos realmente
   perdidos). El instrumento nace con ruido estructural.

**Corrección recomendada:** ampliar §5.1 al sustantivo **anterior** (`somos N`, `tenemos N`,
`cumplí N`, `tiene N metros`), a los años de 4 dígitos sin moneda, y a `N por ciento`. Con los 7
casos de la tabla como test. Es el mismo predicado que ya existe, en la otra dirección.

### 🟡 m1 · MENOR — el comentario de `importes_con_destino` sigue contradiciéndose

`supabase/migrations/024_telemetry_fidelidad.sql`, comentario de la columna. Reportado en la ronda
8 y **sin corregir**:

> *"…terminaron en un destino declarado (campo asignado, ítem de gasto, huérfano no relevante, **o
> huérfano relevante**) = importes_en_mensaje − jsonb_array_length(importes_sin_destino)"*

El huérfano **relevante** es exactamente lo que va en `importes_sin_destino`, así que la fórmula lo
resta: no cuenta como destino. La enumeración y la fórmula se contradicen en la misma frase. No
afecta a los datos —la fórmula es la que se ejecuta y es correcta— pero es un comentario que se va
a leer al interpretar el digest. **La migración aún no se ha ejecutado**, así que corregirlo es
gratis ahora y caro después.

### ⚪ Observación — el encargo contradice al contrato en un punto de O.2

O.2 pide `'gano 27600 al año'` → **`COMPLETE` sin huérfanos**. El código real devuelve `PARTIAL`
con huérfano `[27600]` e `ingreso = undefined` — y **eso es deliberado, preexistente y está
fijado por un test**: `scenario.test.ts:597`, *"escenario 5 · 'gano 27600 al año' → no asume
mensual (huérfano, no 27600 como ingreso mensual)"*, con `assert.equal(huerfanos.extraccionIncompleta, true)`.
Es la PIEZA 1 de la 5ª tanda (`scenario.ts:789`, MARCADOR ANUAL): el sistema se niega a asumir que
27.600 €/año son 2.300 €/mes y pregunta, que es exactamente el §0 del contrato.

**AG08 no lo rompió, y hizo bien.** Romperlo habría exigido reescribir `escenario 5` para que
afirmara lo contrario — la violación de V11 que E11 acaba de registrar cinco veces. Lo que sí
ejercitó es `escenario 5b` (`:605`), el caso correcto para esta tolerancia: un delta que **ya**
normalizó 27.600/año a 2.300/mes no debe marcarse huérfano — y sigue verde con la marca anual
nueva.

Lo señalo para que quede resuelto en el papel: **la línea de O.2 y `escenario 5` no pueden ser
ambas correctas.** Mi lectura es que manda el contrato (§0 y la PIEZA 1) y que el encargo tenía un
error de redacción, pero es decisión de Luis.

---

## 3 · Verificación del encargo (BLOQUE O)

### O.2 — G1d ✅

| Requisito | Resultado |
|---|---|
| `"renta 1000, comida 200, luz 100"` → `PARTIAL` citando el 100 | ✅ `PARTIAL`, `[100]` |
| control con 150 → `PARTIAL` | ✅ `PARTIAL`, `[150]` |
| `"gano 27600 al año"` → `COMPLETE` sin huérfanos | ⚪ `PARTIAL` — **por diseño**, ver la Observación |
| Mensaje de 17 partidas → nunca `COMPLETE` con 2.080 | ✅ 17 ítems, **2.205 €**, `COMPLETE` legítimo; con 11 de 17 → `PARTIAL` detectando las 6 |

**Riesgo espejo del fix nuevo, probado por mí:** un gasto anual **no capturado** cuyo doceavo
coincide con una partida sí capturada — `"luz 100, comida 300, seguro del coche 1200 al año"` con
el seguro perdido y `luz 100` presente. La marca anual está en el candidato perdido, así que la
puerta podría abrirse. **No se abre:** el 1200 se detecta como perdido (`PARTIAL`, `[1200]`). La
condición está bien colocada.

### O.3 — falsos `PARTIAL` ⚠️ **4/6 nuevos, 7/17 en total**

Ver M1. Todos preexistentes; una categoría (TAE sin `%`) mejorada por esta rama.

### O.4 — alcance ✅

| Comprobación | Resultado |
|---|---|
| `consigliere.ts` | ✅ **ausente del diff** |
| `route.ts` — ¿solo el sensor? | ✅ el diff completo son 18 líneas: `importesEnMensaje`/`importesConDestino`/`importesSinDestino` (`:504-506`) y su paso al payload (`:959-961`). **Ni una línea de tono** |
| Ficheros con lógica | `scenario.ts` (conservación), `route.ts` (sensor), `telemetry.ts` + migración 024 (plumbing del sensor, ya justificado en la tanda anterior) |
| ¿El orquestador? | no tocado — el snapshot de la tanda 7 llega vía `develop`, intacto |
| `llm.ts` (dominio AG01) · ICA (dominio AG06) | ✅ ausentes |

### O.5 — sin regresiones ✅ **34/34**

M10 sensor: las 4 frases intactas (V18) · M3 · M9 · G1b · G1c bidireccional `[2200, 2250]` ·
`esEstructuraRepetida` viva (tanda 7 recuperada) · los 7 fraseos de la reconciliación aritmética ·
V12 · V13 (1090/1090) · V16 (L2/L3/L5) · V19 · las 15 partidas de testdev7 (2250) · dedup 5 con
ítems = buckets = 2200 · memoria entre sesiones · `"gasto 2 500 €"` → 2500 · casos 9-17 · E5-24 ·
desglose sin confirmar · detector de pegado en ambos sentidos · el crédito fantasma no vuelve.

**Migración 024:** `add column if not exists`, las tres columnas NULLABLE, nota de retención,
índice parcial, **no ejecutada**. Nombres verificados letra por letra:
`importesEnMensaje`→`importes_en_mensaje`, `importesConDestino`→`importes_con_destino`,
`importesSinDestino`→`importes_sin_destino` (`route.ts:959-961` ↔ `telemetry.ts:156-158` ↔ SQL).
Salvedad documental en m1.

---

## 4 · Tabla de invariantes

| # | Invariante | Estado | Evidencia |
|---|---|---|---|
| **V1** | Un dato con confianza no se descarta | ✅ verificado | V19 verificado aparte; ninguna ruta nueva descarta |
| **V5** | Nada inferido por el LLM entra en `conceptos` | ✅ verificado | El diff no toca el guardarraíl ni `buildScenarioContext` |
| **V8** | El cero se rechaza como placeholder | ✅ verificado | caso 17 |
| **V9** | El estado sobrevive re-lectura desde BD | ✅ verificado | Memoria entre sesiones, 5 partidas |
| **V10** | `raw !== final` ⟹ ≥1 mutación | ✅ verificado | Pipeline sin cambios |
| **V11** *(E2+E11)* | No se borra, debilita ni esquiva un test | ✅ **limpio, 6ª ronda seguida** | 0 líneas eliminadas; 4 tests nuevos; el conflicto del rebase se resolvió **conservando los dos bloques** (13 tests en `route.static.test.ts`) |
| **V12** | El ingreso nunca como ítem de gasto | ✅ verificado | testdev7 |
| **V13** | Token reclamado = frontera con offsets | ✅ verificado | `expenses.ts:249`; independencia de orden byte a byte |
| **V14** | Conservación · `extraction_status` nunca `undefined` | ✅ **cerrada la puerta trasera** | La tolerancia `÷12` ya solo aplica con marca anual (`:1749`); mis 4 casos de reserva en verde |
| **V15/V16** | Atribución / no doble conteo | ✅ verificado | Los 7 fraseos, L2/L3/L5 |
| **V17** *(E14: la aritmética decide el agregado)* | | ✅ verificado | Los 7 fraseos sin keyword |
| **V18** *(E14: ningún mandamiento edita prosa)* | | ✅ verificado | Las 4 frases de M10 intactas |
| **V19** *(E14: nunca se pierde un dato extraíble)* | | ✅ verificado | meta 150000 **y** gastos 1400 |
| **V20/V21** *(E14, renumerados)* | | ✅ verificado | G1b y bloque consistente |
| **G1a/G1b** | 0 errores aritméticos · 0 cifras no trazables | ✅ verificado | M3/M9/déficit fantasma; el fix del snapshot sobrevive al rebase |
| **G1c** | Reconciliación bidireccional | ✅ verificado | `[2200, 2250]` en ambos sentidos |
| **G1d** *(fidelidad de extracción)* | | ✅ **cerrada** | Los dos casos de mi reserva, el control, el de valores repetidos (3/3) y la reproducción del incidente |
| — | `scenario_state` · `response_telemetry` · `runGuardrail` · `persistTurn` | ✅ verificado | `route.static.test.ts` 13/13; `persistence.ts` sin tocar |
| — | `llm.ts` NO tocado (dominio AG01) | ✅ verificado | ausente del diff |
| — | Tabla de puntos del ICA no redefinida (dominio AG06) | ✅ verificado | ausente del diff |
| — | Sin reconciliación/CONFLICT/ASSUMED nuevos (BLOQUE C) | ✅ verificado | `reconciliarGastos` sin tocar |
| — | Eco sin plantilla (BLOQUE G) | ✅ verificado | `renderDatosRecienEntendidos` sin tocar |
| — | Migración (BLOQUE F) | ✅ verificado | Ver O.5; salvedad en m1 |
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
| I.1 | Fronteras como rangos `[start,end)` | sí | sí | ✅ `expenses.ts:249` |
| I.2 | Los 3 mensajes del bloqueante | sí | sí | ✅ 1200 · 1090 · idéntico |
| L 1-6 | V15/V16 | sí | sí | ✅ |

**Batería:** TypeScript limpio · `npm test` 0 fallos · `test:guardrail` 0 fallos, 8 suites ·
`test:calculator` 0 fallos (scenario 248→252) · `test:regression` **84/84**. El build falla en el
prerender por credenciales de Supabase ausentes — entorno, no código.

---

## 5 · Riesgos latentes

**R1 — el sensor mide el detector, no al usuario.** `importes_sin_destino` sale de
`huerfanos.numerosHuerfanos`: la misma función que decide. Cuando el detector se equivoca —por
exceso (M1) o por defecto—, el sensor se equivoca con él y la fila queda coherente. No hay segunda
fuente y no la habrá; lo importante es leer el digest sabiendo que **una tasa de fidelidad del
100% no prueba fidelidad, prueba que el detector no encontró nada**.

**R2 — §5.1 es una lista de sustantivos, con la misma fragilidad que las tres listas anteriores.**
La serie ya sustituyó la enumeración de conectores por estructura (V17) y la de keywords de gasto
por aritmética. La clasificación de huérfanos sigue siendo una lista cerrada, y M1 es su factura.
Merece el mismo tratamiento: una señal estructural (¿el número lleva moneda, va tras un verbo de
gasto/ingreso, encaja en la aritmética?) en vez de enumerar sustantivos.

**R3 — la marca anual se busca en ±15 caracteres.** `tieneMarcaAnual` (`:1694`) mira una ventana
fija alrededor del número. `"gano 27600 euros brutos al año"` cae fuera de esa ventana. No es un
defecto hoy —la ruta que lo consume ya trata ese caso como huérfano por diseño— pero si algún día
se decide anualizar automáticamente, la ventana será demasiado corta.

**R4 — el proceso de ramas funcionó esta vez porque alguien lo miró.** La recuperación de la
tanda 7 salió bien, y AG08 añadió la verificación previa (`git log --not origin/develop`) a su
rutina. Conviene que esa comprobación entre en el Protocolo de Entrega Estándar y no dependa de
que el revisor la repita.

---

## 6 · Recomendación a Luis

**Mergear.** Es la entrega más limpia de la serie en su propio alcance: cierra la reserva que dejé
abierta con los casos exactos que la abrieron, no introduce ninguna regresión en 34 verificaciones,
respeta la congelación de alcance al pie de la letra, mantiene V11 limpio por sexta vez y repara
—con la causa documentada— la pérdida de la tanda 7.

**Antes del merge, dos minutos de trabajo:**

1. **m1 — corregir el comentario de `importes_con_destino`** en la migración 024, que aún no se ha
   ejecutado. Quitar `"o huérfano relevante"` de la enumeración: contradice la fórmula de la misma
   frase y es el texto que se leerá al interpretar el digest de G1d.
2. **Ejecutar la migración 024** (protocolo de migraciones SQL).

**Primera tanda después del merge — una sola cosa, y es la de mayor retorno:**

3. **M1 — ampliar §5.1 al sustantivo anterior**, a los años de 4 dígitos y a `N por ciento`
   (`scenario.ts:1624-1626`). Con los 7 casos de mi tabla como test. Dos razones que se refuerzan:
   deja de convertir al Consigliere en interrogador (G2/G3), y **limpia el ruido estructural del
   sensor G1d antes de que se acumule** — si el digest arranca mezclando edades con partidas
   perdidas, la compuerta nace inservible para lo que se instaló.

**Para el contrato:**

4. **Resolver la contradicción de O.2 sobre `'gano 27600 al año'`** (ver la Observación). Mi
   recomendación es dejar el comportamiento como está —es §0 aplicado— y corregir el enunciado del
   encargo, dejando constancia en el contrato de que el MARCADOR ANUAL degrada a propósito.
5. **R4 — llevar al Protocolo de Entrega Estándar** la verificación previa al reset
   (`git log --oneline origin/agent/XX --not origin/develop`), que AG08 ya ha incorporado por su
   cuenta tras la pérdida de la tanda 7.

---

*Revisión ejecutada sobre `origin/agent/08` (`31af215`) en worktree aislado, con `origin/develop`
(`f4a1414`) como control para separar regresión de defecto preexistente. Ningún código de AG08
fue modificado; esta entrega es solo el informe.*
