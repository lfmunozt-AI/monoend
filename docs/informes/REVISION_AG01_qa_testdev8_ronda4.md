# APROBADO CON RESERVAS — revisión adversarial AG01 · ronda 4 (`agent/08` @ `51f8513`)

**Revisor:** AG01 (Arquitecto) · **Implementador:** AG08 · **Fecha:** 2026-08-18
**Base:** `origin/develop` (`358c729`) · **Rama juzgada:** `origin/agent/08` (`51f8513`), sin mergear
**Rondas previas:** ronda 1 RECHAZADO · ronda 2 APROBADO CON RESERVAS · ronda 3 RECHAZADO
**Reportes Fase 4 de AG08:** `CORRECCIONES_AG08_regla_estructural_agregado_y_anafora.md` · `CORRECCIONES_AG08_m10_sensor_no_editor.md`
**Contrato:** `docs/CONTRATO_TRUTH_ENGINE.md` (§5, §8, §9 con E1-E10, §13, §14, §15)

> **Nota sobre el nombre del archivo.** Cuarta ronda consecutiva que se entrega en archivo
> propio en vez de sobrescribir `REVISION_AG01_tanda1_truth_engine.md`, que el contrato cita
> como evidencia en **E2** y **E6**.

---

## 1 · Veredicto

**APROBADO CON RESERVAS — mergear, con el piloto BLOQUEADO.**

**El bloqueante de la ronda 3 está cerrado, y de más.** Las 11 frases de prosa que M10 borraba
salen ahora **intactas las 11** — incluidas las dos que ya se rompían en `develop` antes de esta
serie (`"Eso depende de lo que decidas priorizar."`, `"Eso sí, conviene no tocarlos."`). La rama
tras el arreglo es **mejor que `develop`** también en eso, no solo igual.

El rediseño va más lejos de lo que yo recomendé: AG08 cita una orden explícita de Luis
(*"ELIMINA la rama de inserción de cifra y la rama de borrado de frase de M10. El código de
edición se va entero."*). Yo había propuesto conservar la sustitución y limitar solo el borrado.
La orden de Luis manda, y ejecutada así el resultado es más limpio: **M10 ya no edita nada.**
Verifiqué que el código de edición desapareció de verdad (`repararAnaforasSinAntecedente` y
`esNum`: **0 ocurrencias** en `commandments.ts`).

**No hay quinta violación de V11.** Los 6 tests eliminados afirmaban el comportamiento de
edición que la propia orden manda suprimir; AG08 los declara uno a uno y repone cobertura
equivalente, incluida la **fixture canónica con la frase exacta**. Los dos tests de regresión
que dice haber conservado (déficit fantasma y M3) los comparé línea a línea: **idénticos salvo
el título**. Esto es lo contrario de lo que pasó en la ronda 3 de la serie.

**Lo que reservo** — y por lo que el piloto no puede abrirse:

> **La condición de piloto (M1) sigue abierta para una familia entera de fraseos.** La regla
> estructural sustituyó la enumeración de *conectores* pero conservó una enumeración de
> *keywords* como ancla (`GASTO_CTX`, `scenario.ts:533`). Sin gerundio ni sinónimos, el ancla
> no engancha y el mensaje cae al parser de listas: `"estoy gastando 1300 mensuales: renta 700,
> comida 400, transporte 200"` → **2600, `COMPLETE`**. De los 6 fraseos nuevos que inventé esta
> ronda, **3 fallan y 2 son "seguro y equivocado"** — la línea roja explícita del encargo.

**No es regresión: es un hueco que la tanda estrecha mucho pero no cierra.** Sobre esos mismos 6
fraseos, `develop` produce **5** "seguro y equivocado"; esta rama, **2**. Y en todo lo demás que
medí, la rama es igual o mejor que `develop`. Por eso apruebo el merge y bloqueo el piloto: no
mergear dejaría en `develop` un estado estrictamente peor.

Batería completa en verde: TypeScript limpio, 84/84 turnos de regresión, commandments 33→36,
scenario 198 y tools 17 sin cambios.

---

## 2 · Verificación del encargo (BLOQUE O)

### O.1 — regla estructural del agregado ⚠️ **abierta para el ancla**

`scenario.ts:624-654` (`detectarAgregadoEstructural`), anclada en `GASTO_CTX` (`:533`) vía `:628`.

**Lo que funciona — 14/14.** Los 4 fraseos conocidos, mis 4 de la ronda 2 y mis 6 de la ronda 3
siguen los 14 devolviendo el agregado correcto, con el desglose completo y `COMPLETE`. Ninguna
regresión.

**Mis 6 fraseos nuevos de esta ronda** (verificados con `grep` como ausentes de `src/` y
`scripts/`), contra `develop` como control:

| # | Fraseo | Esperado | `develop` | `agent/08` |
|---|---|---|---|---|
| 1 | `"mis gastos suelen quedarse en 1250: renta 650, comida 400, luz 200"` | 1250 | ✗✗ 2500 `COMPLETE` | **1250** ✅ |
| 2 | `"he acabado gastando 1600 este mes: hipoteca 900, super 450, gasolina 250"` | 1600 | ✗✗ 3200 `COMPLETE` | ✗✗ **3200 `COMPLETE`** |
| 3 | `"mis gastos, contando todo lo del hogar, dan 1500: casa 800, comida 450, agua 250"` | 1500 | ✗✗ 3000 `COMPLETE` | **1500** ✅ |
| 4 | `"gastamos por lo general 1150 al mes: mercado 600, luz 300, gas 250"` | 1150 | ✗✗ 2300 `COMPLETE` | **1150** ✅ |
| 5 | `"acabo gastando cerca de 1450 al mes: alquiler 750, comida 450, luz 250"` | 1450 | ✗ 2150 `PARTIAL` | ✗ 2150 `PARTIAL` |
| 6 | `"estoy gastando 1300 mensuales: renta 700, comida 400, transporte 200"` | 1300 | ✗✗ 2600 `COMPLETE` | ✗✗ **2600 `COMPLETE`** |

**3/6 arreglados, 3/6 abiertos, ninguno empeorado.** El salto es real (5 catástrofes → 2), pero
la línea roja del encargo se cruza dos veces.

**Causa raíz, aislada.** Los tres fallos comparten una sola cosa: el verbo. `GASTO_CTX` no
contiene el **gerundio**. Barrido de la familia del ancla, todos con la misma estructura
`cifra + ":" + 3 partidas`:

| Mensaje | `agent/08` |
|---|---|
| `"gasté 1600: hipoteca 900, super 450, gasolina 250"` | **1600** ✅ |
| `"gastando 1600: …"` | ✗✗ 3200 `COMPLETE` |
| `"gastándome 1600: …"` | ✗✗ 3200 `COMPLETE` |
| `"mis desembolsos son 1600: …"` | ✗ 2300 `PARTIAL` |
| `"mis egresos son 1600: …"` | ✗ 2300 `PARTIAL` |
| `"mis salidas de dinero son 1600: …"` | ✗ 2300 `PARTIAL` |

La misma frase, con la misma estructura, acierta o duplica **según la forma verbal**. La tanda
quitó la enumeración de conectores y dejó la de keywords: el punto único de fallo subió un nivel
en vez de desaparecer. En los casos `COMPLETE` el agregado acaba como ítem con nombre absurdo
(`"estoy gastando" = 1300`, `"gastándome" = 1600`) y el total sale **exactamente el doble**;
`aplicarGuardaV16` no lo caza porque, sin ancla, no hay agregado declarado contra el que
comparar.

### O.2 — M10 sensor, test canónico y auditoría V11 ✅

`commandments.ts:404` (`huboEliminacionDeOtraCapa`) · `:436-448` (`DeteccionAnafora`) ·
`:450-478` (`detectarAnaforaSinAntecedente`) · `:592` (llamada, `accion: "logueado"`)

**El código de edición se fue entero**, como ordenaba el encargo:
`grep -c "repararAnaforasSinAntecedente\|function esNum"` → **0**.

**Las 11 frases de prosa de mi ronda 3 salen intactas**, en ES, EN y PT — verificado con el
pipeline completo. Incluidas las dos que `develop` ya rompía.

**El sensor no es código muerto.** Comprobé que dispara por la **ruta real**, sin `mutations`
fabricadas:

| Vector | Mutaciones de otras capas | M10 | ¿Editó? | Señal para el reintento |
|---|---|---|---|---|
| `"…9.999 €… . Eso te deja margen."` | 1 (`grounding`) | **dispara**, `logueado` | no ✓ | `ausente = true` |
| `"…250 € … déficit de 9500 €"` | 3 (`grounding`×2, `ensureSubstance`) | **dispara**, `logueado` | no ✓ | `ausente = true` |
| Canónico D solo (el modelo la escribió rota) | 0 | no dispara *(condición c)* | no ✓ | `ausente = true` |

En los tres, `cifraPedidaAusente` da `true`, así que el reintento acotado de `route.ts:816`
sigue cubriendo al usuario. El cableado no se tocó (el diff de `route.ts` es **solo
comentarios**, verificado).

**Auditoría V11 — sin violación.** 6 tests eliminados, 10 añadidos:

| Test eliminado | Justificación | Reposición |
|---|---|---|
| `OBLIGATORIO 2` (anáfora reinsertada) | afirmaba la inserción, suprimida por orden | tests A/B/C de no-edición |
| `OBLIGATORIO 3` (frase eliminada) | afirmaba el borrado, suprimido por orden | "concepto pedido NO existe → nunca dispara" |
| `CANÓNICO (repuesto, V11)` | afirmaba la reparación | **repuesto con la frase exacta** como test del sensor |
| `CANÓNICO — variantes` y `— forma PT` | ídem | repuestos como detección sin edición |
| `OBLIGATORIO 1` (déficit fantasma) | — | **re-añadido idéntico**, solo cambia el título |
| `OBLIGATORIO 4` (regresión M3) | — | **re-añadido idéntico**, solo cambia el título |

Comparé los cuerpos de los dos últimos línea a línea: mismos fixtures, mismos asertos, mismos
conceptos. Y la fixture canónica conserva la frase literal del QA testdev8. Los tests del sensor
fabrican `mutations` a propósito para aislar la condición (c) — AG08 lo **declara** en cada uno,
y el caso del pipeline real queda cubierto por el test D-sin-mutación. Es unit testing legítimo,
no el "test que no ejercita la ruta real" de rondas anteriores.

### O.3 — menores ✅

| Menor | Estado |
|---|---|
| Cap de `gastos_items` (§8) | ✅ 8 versiones → máx 5 por partida, activo siempre el más reciente, `gastos_items_colapsados = 6`, sobrevive el viaje a BD |
| `tool_call` de un solo ítem (V14) | ✅ `netflix 15` se registra sin fijar `gastos_es_detalle`/`gastos_detalle` |
| Declaración de impacto como artefacto | ✅ dos documentos en `docs/informes/`. Los contrasté contra el diff real: coinciden, incluidas las eliminaciones de test |

### O.4 — sin regresiones ✅

| Verificación | Resultado |
|---|---|
| **G1b** — el déficit fantasma no vuelve | ✅ los 4 vectores sin cifra no trazable |
| **M3** intacto con pipeline completo | ✅ |
| **M9** (plan fantasma) intacto | ✅ 24/24 y verificado por pipeline |
| **G1c** bidireccional | ✅ `[2200, 2250]` idéntico en ambos sentidos |
| **V13** fronteras por rango | ✅ `expenses.ts:249` `interface Rango {start,end}`; independencia de orden 1090/1090 |
| **V14** · `extraction_status` nunca `undefined` | ✅ en ~50 mensajes |
| **V12** el ingreso nunca como ítem | ✅ |
| `"gasto 2 500 €"` → 2500 | ✅ |
| 15 partidas de testdev7 | ✅ 15 ítems, 2250 |
| Dedup testdev8 (5, no 11) | ✅ suma ítems = buckets = 2200 |
| **B2** bloque coherente (ronda 2) | ✅ gastos 1550, sobrante 1450 |
| Cuota derivada del estado, sesión nueva | ✅ 881,25 · `cuota` fuera de `missing` |
| Desglose sin confirmar | ✅ recorte bloqueado, sobrante 250 disponible |
| Detector de pegado | ✅ hipoteca legítima no se marca · caso 9 sigue `AMBIGUOUS` |
| V9 desglose entre sesiones | ✅ |

---

## 3 · Hallazgos priorizados

### 🔴 P1 · BLOQUEANTE DE PILOTO (no de merge) — el ancla de la regla estructural sigue siendo una lista cerrada

`src/lib/calculator/scenario.ts:533` (`GASTO_CTX`) · consumido en `:628`

Detalle y evidencia en §2/O.1. **Por qué importa:** es exactamente el defecto que E9 declara
condición de piloto y que esta tanda declara cerrado. Con un usuario real, `"estoy gastando 1300
al mes: …"` devuelve 2600 € de gasto **sin ninguna señal de duda**. Un gasto al doble presentado
como dato verificado destruye toda la cadena: sobrante, capacidad, viabilidad de cuota, plan.

**Corrección recomendada — quitar el ancla, no ampliarla.** Ampliar `GASTO_CTX` con `gastando`,
`gastándome`, `desembolsos`, `egresos`… repite el error una tercera vez: mañana aparecerá
`"se me va en gastos"` o `"lo que pago al mes"`. La estructura ya es suficiente señal: **cifra +
`:` + lista de ≥2 partidas con importe propio**. Propongo que el ancla de keyword sea
**opcional**: si tras los dos puntos hay una lista válida y la cifra previa no está reclamada
por otro campo, es el agregado — con o sin verbo de gasto reconocido.

Si se prefiere no tocar el diseño ahora, la **red mínima** de E9 sigue disponible y es barata:
degradar a `AMBIGUOUS` en vez de `COMPLETE` cuando la suma de ítems ≈ 2× una cifra presente en
el mensaje. No arregla la atribución, pero convierte "seguro y equivocado" en una pregunta —
que es el principio rector del §0.

**Criterio de cierre que propongo:** una batería de ≥12 fraseos con formas verbales variadas
(conjugadas, gerundio, participio, perífrasis y sinónimos nominales), **cero** `COMPLETE` con
cifra equivocada.

### 🟠 M1 · MAYOR (heredado de mi ronda 3, sin tocar) — la regla golosa destruye un gasto correcto

`scenario.ts:624-654`, elección del último número del tramo (`:641`)

`"gasto 1200 al mes y gano 2500: arriendo 800, comida 400"` → toma **2500** (el ingreso) como
agregado, choca con el detalle de 1200 y deja `gastos = undefined` con `AMBIGUOUS`. En `develop`
daba 1200. Sigue idéntico: esta tanda no tocó `scenario.ts`, lo cual es coherente con el alcance
que se le dio (solo M10). Lo mantengo abierto para que no se pierda.

§13 fija *"conflictos falsos por error de parseo: 0"*. Atenuante: pregunta, no afirma.
**Corrección:** descartar del tramo los números ya reclamados por otro patrón declarativo
(`rangosReclamados` existe) y quedarse con el último no reclamado.

### 🟡 m1 · MENOR — M10 queda casi redundante con el reintento de `route.ts`

`commandments.ts:450-478` vs `route.ts:816`. Ambos consumen `cifraPedidaAusente`; el sensor solo
añade la condición (c) —"otra capa borró algo"— y no cambia el texto. Su valor real es de
**telemetría**: distinguir "la borramos nosotros" de "el modelo nunca la dijo". Bien, pero hoy
`conceptoEsperado`/`cifraEsperada`/`fraseAfectada` no los consume nadie: el detalle se
concatena en un string libre. Si no entran en `response_telemetry` como campos, el sensor no
servirá para medir nada.

### 🟡 m2 · MENOR — la reparación determinista desapareció

Antes de esta tanda, el caso canónico se arreglaba **sin LLM**. Ahora siempre requiere el
reintento acotado: una llamada extra al modelo en cada turno con la cifra ausente. Es la
consecuencia buscada de la orden de Luis y me parece la decisión correcta —una capa determinista
no debe redactar prosa—, pero tiene coste medible en latencia y tokens. Merece un contador en
telemetría antes del piloto para saber cuántos turnos lo disparan.

---

## 4 · Tabla de invariantes

| # | Invariante | Estado | Evidencia |
|---|---|---|---|
| **V1** | Un dato con confianza no se descarta | ⚠️ **un caso** | M1 heredado: `gasto 1200 … gano 2500:` deja `gastos` en `undefined` |
| **V5** | Nada inferido por el LLM entra en `conceptos` | ✅ verificado | M10 ya no escribe **nada**; ninguna cifra nueva puede entrar por esa vía |
| **V8** | El cero se rechaza como placeholder | ✅ verificado | `agregado <= 0` descarta el candidato; caso 17 intacto |
| **V9** | El estado sobrevive re-lectura desde BD | ✅ verificado | Incluido `gastos_items_colapsados` |
| **V10** | `raw !== final` ⟹ ≥1 mutación | ✅ verificado | M10 ya no muta; el resto del pipeline sigue auditado |
| **V11** | Prohibido reescribir un test para que afirme lo contrario | ✅ **respetado** | 6 eliminaciones declaradas y justificadas por orden explícita; los 2 tests de regresión, idénticos; fixture canónica conservada |
| **V12** | El ingreso nunca como ítem de gasto | ✅ verificado | testdev7 |
| **V13** | Token reclamado = frontera con offsets | ✅ verificado | Independencia de orden byte a byte |
| **V14** | Conservación · `extraction_status` nunca `undefined` | ✅ verificado | ~50 mensajes |
| **V15** | Atribución correcta | ⚠️ **parcial** | 14/14 fraseos previos ✅; 3/6 nuevos ✗ — ver P1 |
| **V16** | No doble conteo | ⚠️ **parcial** | Los `COMPLETE` de P1 son doble conteo exacto sin señal |
| **V17** *(ronda 1)* | Ninguna capa reintroduce una cifra eliminada | ✅ verificado | M10 no lee `ctx.raw` |
| **V18** *(ronda 1: bloque de datos verificados consistente)* | | ✅ verificado | Rederivación + guarda bloqueante en pie |
| **V18'** *(AG08 usa este número para "ningún mandamiento edita prosa")* | | ⚠️ **colisión de numeración** | Ver §5/R4 |
| — | §13 · intervención sobre **prosa** → 0 | ✅ **restaurado y mejorado** | 11/11 frases intactas, incluidas 2 que `develop` rompía |
| — | §13 · conflictos **falsos** por parseo = 0 | ⚠️ **1 caso** | M1 heredado |
| — | `scenario_state` · `response_telemetry` · `runGuardrail` · `persistTurn` | ✅ verificado | `route.static.test.ts` verde; `pipeline.ts` sin cambios |
| — | `llm.ts` NO tocado (dominio AG01) | ✅ verificado | ausente del diff |
| — | Tabla de puntos del ICA no redefinida (dominio AG06) | ✅ verificado | ausente del diff |
| — | Sin reconciliación/CONFLICT/ASSUMED nuevos (BLOQUE C) | ✅ verificado | `reconciliarGastos` sin tocar |
| — | Eco sin plantilla (BLOQUE G) | ✅ verificado | `renderDatosRecienEntendidos` sin tocar; M10 ya no publica texto propio |
| — | Migración (BLOQUE F) | **no aplica** | El diff no toca `supabase/` |
| — | `test:e2e` · `smoke:db` | **no verificable por mí** | Requieren credenciales |

### Casos de aceptación 9-17 + extras

| # | Caso | Test | Ruta real | Pasa |
|---|---|---|---|---|
| 9 | `"Telecomunicaciones_Necesario 60 100 Pañales_Bebe_Vital"` | sí | sí | ✅ `AMBIGUOUS`, ítem sospechoso expuesto, sin conflicto |
| 10 | `"gasto 2 500 €"` | sí | sí | ✅ 2500 |
| 11 | `"gano 2300, tengo 43 años, 2 hijos, gasto 2200"` | sí | sí | ✅ `COMPLETE` |
| 12 | `"gano 2300 y gasto 2200 y 450"` | sí | sí | ✅ `PARTIAL` |
| 13 | `"Diezmo_Vital 225, Casa_Vital 700"` | sí | sí | ✅ 2 ítems con `_` |
| 14 | `"alquiler 700 comida 450 luz 120"` | sí | sí | ✅ 3 ítems |
| 15 | `"Alquiler: 700, Comida: 450, Luz: 120"` | sí | sí | ✅ 3 ítems, 1270 |
| 16 | 15 partidas de testdev7 | sí | sí | ✅ 15 ítems, 2250 |
| 17 | Crédito con monto sin plazo | sí | sí | ✅ plazo nunca 0 |
| E5-24 | `"gasto aproximadamente 2000 entre vivienda, comida"` | sí | sí | ✅ 2000, ítems vacío |
| extra | Desglose sin confirmar: sin recorte, con sobrante | sí | sí | ✅ |
| I.1 | Fronteras como rangos | sí | sí | ✅ `expenses.ts:249` |
| I.2 | Los 3 mensajes del bloqueante | sí | sí | ✅ 1200 · 1090 · idéntico |
| L 1-6 | V15/V16 | sí | sí | ✅ los 6 |

---

## 5 · Riesgos latentes

**R1 — el patrón se repite: cada tanda mueve el punto único de fallo un nivel arriba.** Tanda 3
sustituyó la enumeración de conectores por estructura, y el fallo migró a la enumeración de
keywords. Si la próxima amplía `GASTO_CTX`, migrará al siguiente eslabón enumerado. Merece una
decisión de diseño explícita —*ninguna lista cerrada de palabras puede ser condición necesaria
para leer una cifra*— y no otra ronda de añadir términos.

**R2 — el pipeline depende cada vez más de reintentos con LLM.** Con M10 desactivado como
reparador, hay tres reintentos posibles en un mismo turno. Ninguno es gratis y ninguno es
determinista. Antes del piloto conviene medir qué porcentaje de turnos dispara alguno.

**R3 — `huboEliminacionDeOtraCapa` mide longitud, no semántica.** `commandments.ts:404` compara
`despues.length < antes.length`. Una capa que **sustituya** contenido por algo igual de largo
(un reemplazo, un reformateo) no cuenta como eliminación y M10 no dispararía. Hoy no hay tal
capa, pero es un acoplamiento frágil a documentar.

**R4 — colisión de numeración de invariantes.** AG08 llama **V18** a "ningún mandamiento edita
prosa". En mi informe de la ronda 1, **V18** es "el bloque de datos verificados es internamente
consistente" — otro invariante distinto, también implementado. Ninguno de los dos está aún en
§9 del contrato, así que la colisión no ha causado daño todavía; si se incorporan sin resolverla,
sí. Es exactamente lo que E7/E8 tuvieron que arreglar con V11-V13.

---

## 6 · Recomendación a Luis

**Mergear.** Y **no abrir el piloto** hasta cerrar P1.

Mergear es la opción correcta aunque quede una reserva seria: en todo lo que medí, esta rama es
igual o mejor que `develop`, en ningún punto peor. Sobre mis 6 fraseos nuevos, `develop` produce
5 casos de "seguro y equivocado" y la rama 2. Bloquear el merge dejaría en `develop` el estado
peor por proteger de un defecto que `develop` también tiene, y de paso retendría el cierre de la
prosa borrada, la regla estructural (14 fraseos), el cap §8 y el arreglo de conservación del
`tool_call`.

### Antes del piloto (bloqueante)

1. **P1 — hacer opcional el ancla de keyword** en `detectarAgregadoEstructural`, en vez de
   ampliarla. Criterio de cierre: batería de ≥12 fraseos con formas verbales variadas
   (conjugadas, gerundio, participio, perífrasis, sinónimos nominales), **cero** `COMPLETE` con
   cifra equivocada. Si no da tiempo, aplicar al menos la red de E9 (degradar a `AMBIGUOUS`
   cuando la suma de ítems ≈ 2× una cifra del mensaje): convierte la catástrofe en pregunta.

### Recomendado, sin bloquear

2. **M1 heredado** — descartar los números ya reclamados por otro patrón declarativo al elegir
   el agregado.
3. **m1** — que `conceptoEsperado`/`cifraEsperada` entren en `response_telemetry` como campos,
   o el sensor no medirá nada.
4. **m2** — contador de turnos que disparan reintento, antes del piloto.
5. **R3** — documentar el acoplamiento de `huboEliminacionDeOtraCapa` a la longitud.

### Enmiendas al contrato — ya no deberían esperar más

- **V17** ("ninguna capa de reparación reintroduce una cifra eliminada") y **V18** ("el bloque
  de datos verificados es internamente consistente"), propuestas en la ronda 1, implementadas y
  **verificadas estables en tres rondas consecutivas**. Cuarta tanda que arrastran sin entrar en
  §9.
- **Resolver la colisión de numeración** antes de incorporarlas: el invariante nuevo de AG08
  ("ningún mandamiento edita prosa" — que me parece correcto y merece entrar) necesita un número
  propio, **V19**, no reutilizar V18. Es el mismo problema que E7/E8 cerraron para V11-V13.
- **§5.3** sigue describiendo solo el parser numérico; la regla estructural del agregado debería
  quedar registrada en el cuerpo del contrato, con su límite conocido (el ancla) declarado.

---

*Revisión ejecutada sobre `origin/agent/08` (`51f8513`) en worktree aislado, con `origin/develop`
(`358c729`) y `8d6adad` como controles para separar regresión de defecto preexistente. Ningún
código de AG08 fue modificado; esta entrega es solo el informe.*
