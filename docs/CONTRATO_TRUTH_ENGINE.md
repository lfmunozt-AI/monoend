# Contrato de comportamiento — Truth Engine de monoend

**Estado:** acordado con Luis · 5 de agosto de 2026
**Alcance:** capa de verdad financiera + reconciliación cross-turno + sustracción de instrucciones redundantes
**Rama base:** `develop` (`8624a3c`)
**Naturaleza de este documento:** especificación de comportamiento. Los agentes implementan **contra esta matriz**; una entrega se juzga por los casos que pasa, no por los fixes que declara.

---

## 0 · Principio rector

> **Antes de decir "el usuario se contradijo", el sistema debe preguntarse "¿lo leí bien?".**
>
> El código decide qué es verdad, qué está confirmado, qué está en conflicto, qué se leyó mal y qué no se puede calcular todavía. El LLM decide cómo decirlo. El LLM **nunca** es fuente de una cifra financiera.

Corolario operativo: **el parser no necesita ser perfecto; necesita ser honesto sobre su propia confianza.** El eco de confirmación es lo que convierte una lectura dudosa en un hecho.

---

## 1 · Máquina de estados: `EXTRACTION_STATUS` (por turno)

| Estado | Definición | Efecto |
|---|---|---|
| `COMPLETE` | Todo número financieramente relevante quedó asignado a un campo. Cero huérfanos relevantes. Ningún ítem sospechoso de pegado. | Se calcula con normalidad. Habilita evaluar reconciliación. |
| `PARTIAL` | Hay campos extraídos con confianza **y** huérfanos relevantes sin asignar. | **Los campos extraídos SE USAN.** Se pregunta por los huérfanos citándolos. NO se declara conflicto sobre los campos afectados. |
| `AMBIGUOUS` | Un número podría corresponder a ≥2 campos, o hay un ítem sospechoso de pegado. | El campo afectado no se usa; los demás sí. Se pide confirmación de la lectura. |
| `INVALID` | Valor imposible: cero de placeholder, negativo, o magnitud absurda. | El campo se descarta (queda `MISSING`) y se pregunta. |

---

## 2 · Máquina de estados: `FACT_STATUS` (por campo)

```
MISSING ──extracción──► PARSED ──eco sin corrección──► CONFIRMED
                          │                                │
                          │        nueva fuente fiable      │
                          │        discrepa materialmente   │
                          └──────────────┬─────────────────┘
                                         ▼
                                     CONFLICT
                                         │
                    ┌────────────────────┼────────────────────┐
                    ▼                    ▼                    ▼
          usuario resuelve      2 intentos sin resolver   usuario cuestiona
                    │            + materialidad OK              │
                    ▼            + extracción COMPLETE          │
              CONFIRMED                  │                      │
          (perdedor →                    ▼                      │
           SUPERSEDED)               ASSUMED ───────────────────┘
                                         │
                                usuario confirma
                                         ▼
                                    CONFIRMED
```

`SUPERSEDED` conserva **valor, motivo y turno**. Nunca se borra.

---

## 3 · Jerarquía de confianza y promoción

```
USER_DECLARED_EXPLICIT   confianza ALTA    usable para todo
USER_CONFIRMED           confianza ALTA    usable para todo
PARSED_AND_VALIDATED     confianza MEDIA   usable solo si pasa plausibilidad
CALCULATED               derivado          hereda el peor estado de sus insumos
LLM_INFERRED             confianza NULA    JAMÁS usable para cálculo
```

**Mecanismo de promoción — el eco:** un valor `PARSED` sube a `CONFIRMED` cuando el eco lo enuncia y el usuario no lo corrige en el turno siguiente, o cuando lo confirma explícitamente.

**Nota de implementación:** `LLM_INFERRED` ya está bloqueado por la maquinaria existente — un valor inferido por el modelo no está en `conceptos` y el grounding lo elimina. No hay que construir nada: basta no introducir nunca inferencias del LLM en el mapa de conceptos.

---

## 4 · Jerarquía de decisión (orden estricto, se detiene en la primera coincidencia)

1. ¿Algún valor es `INVALID`? → descartar ese campo, preguntar. **Fin.**
2. ¿El campo tiene `EXTRACTION_STATUS = AMBIGUOUS`? → **NO es conflicto, es incertidumbre.** Confirmar la lectura. **Fin.**
3. ¿`EXTRACTION_STATUS = PARTIAL`? → usar lo extraído, preguntar por los huérfanos, **no** declarar conflicto sobre los campos afectados. **Fin.**
4. Ambas fuentes `COMPLETE` → evaluar reconciliación (§6).

**Regla arquitectónica:** `extraction_incomplete` **tiene precedencia sobre** `conflict`. Siempre.

---

## 5 · Detectores deterministas

### 5.1 Clasificación de huérfanos

- **No relevante** (se ignora, **no degrada** el estado): número adyacente a sustantivo no monetario — `años/anos/years`, `hijos/niños/personas`, `hora(s)`, `día(s)`, `veces`, `kg`, `m2`, `habitaciones/hab`, `edad`, `grados`.
- **Relevante** (degrada a `PARTIAL`): todo lo demás.

*Razón: sin esta clasificación, "gano 2.300, tengo 43 años y 2 hijos, gasto 2.200" paralizaría el sistema preguntando por la edad del usuario.*

### 5.2 Detector de pegado (ítem sospechoso)

Un ítem de una lista de gastos es **sospechoso** si cumple cualquiera de estas condiciones:

- `importe > agregado_declarado` (cuando el agregado existe), **o**
- `importe > 10 × mediana(otros ítems)` con al menos 3 ítems en la lista.

→ `EXTRACTION_STATUS = AMBIGUOUS` para gastos, y el eco pregunta por **ese ítem concreto**, proponiendo la separación.

*Validación con el caso real: ítems 225, 700, 450, 120, **60100**, 150, 100, 80, 60, 40, 25, 40, 60, 40 → mediana ≈ 90. El ítem 60.100 es ~600× la mediana y ~27× el agregado declarado. Detección trivial.*

### 5.3 Parser numérico

El espacio como separador de miles **se conserva** para números individuales (`2 500 €` → 2500). Dentro de una lista de gastos, el parser de lista **establece primero los límites de cada partida** y solo después invoca al parser numérico. No se sacrifica un caso para arreglar el otro.

---

## 6 · Reconciliación cross-turno (Gate G1c)

`reconcile(previousTruth, currentDelta)` — **no** `reconcile(delta)`.

Debe producir el mismo resultado en ambos sentidos:

- T1 agregado → T2 detalle
- T1 detalle → T2 agregado

### Materialidad

| Diferencia | Clasificación | Escape a `ASSUMED` |
|---|---|---|
| ≤ 1 € | Tolerancia de redondeo → `CONSISTENT` | — |
| > 1 € y ≤ 5% del agregado | Conflicto material | **Elegible** |
| > 5% del agregado | Fallo de comprensión, no discrepancia | **NO elegible** — se reinicia la captura de gastos |

*Ejemplo: 50 € sobre 2.200 = 2,3% → elegible. 2.200 declarado contra 6.000 de detalle = 173% → no es que el usuario se contradiga, es que no nos entendimos; jamás se asume.*

### Escape (tras **dos** peticiones de aclaración sin resolver)

Requiere las tres condiciones: extracción del detalle `COMPLETE` **y** diferencia material pero ≤5% **y** dos intentos agotados.

→ Se adopta **el detalle** (por estar itemizado y ser más verificable), estado `ASSUMED`.

`ASSUMED` es **revocable siempre** y **re-emergente**: cuando esa cifra pese en una decisión (viabilidad de una cuota, tamaño de un plan), el modelo debe declarar que es un supuesto no confirmado.

---

## 7 · Bloqueo de derivadas (granular, no global)

Un campo en `CONFLICT` bloquea **solo** las derivadas que lo consumen.

| Campo en conflicto | Se bloquea | NO se bloquea |
|---|---|---|
| gastos | sobrante, capacidad anual, brecha, viabilidad de cuota, recorte propuesto, nueva capacidad | cuota del crédito (solo consume monto/plazo/TAE), clasificación vital/no-vital del detalle |

`ASSUMED` **no bloquea** el cálculo, pero obliga a declarar el supuesto.

---

## 8 · Historial y coste

- **Cap de 5 versiones por campo** en `scenario_state`. Lo anterior se colapsa a un contador.
- La auditoría completa vive en `response_telemetry`, no en el estado.

*Razón: el estado se lee y escribe en cada turno; sin cap, una conversación larga con correcciones infla el jsonb y la latencia sube con él.*

---

## 9 · Invariantes — nunca pueden ocurrir

| # | Invariante |
|---|---|
| **V1** | Un dato extraído con confianza **no se descarta** por la presencia de huérfanos en otra parte del mensaje. |
| **V2** | Nunca se sobrescribe un valor en `CONFLICT`. |
| **V3** | Nunca se declara `CONFLICT` si la extracción de alguna de las dos fuentes no es `COMPLETE`. |
| **V4** | Nunca se calcula una derivada que consume un campo en `CONFLICT`. |
| **V5** | El LLM nunca es fuente de una cifra: `LLM_INFERRED` no entra en `conceptos`. |
| **V6** | Un valor `ASSUMED` se declara como supuesto cuando pesa en una decisión. |
| **V7** | El valor perdedor de un conflicto se conserva como `SUPERSEDED` con motivo y turno. |
| **V8** | El cero se rechaza como placeholder (ya vigente — no regresar). |
| **V9** | Tras el turno, todo el estado sobrevive una **re-lectura desde la BD** (no desde memoria). |
| **V10** | Si `raw !== final`, existe al menos una entrada en `mutations` (auditoría sin puntos ciegos). |

---

## 10 · Matriz de aceptación — 20 casos

Cada caso especifica: entrada → estado esperado → comportamiento esperado de la respuesta.

### Reconciliación

| # | Entrada | Estado esperado | Respuesta debe |
|---|---|---|---|
| 1 | Declarado 2200 · detalle suma 2200 | `CONSISTENT` | Calcular con normalidad |
| 2 | Mismo turno: 2200 + detalle 2250 | `CONFLICT` +50 | Señalar los 50 €, no calcular sobrante |
| 3 | 2200 vs detalle 2150 | `CONFLICT` −50 | Igual, con signo inverso |
| 4 | **T1** 2200 → **T2** detalle 2250 | `CONFLICT` +50 | *(caso real que hoy falla)* |
| 5 | **T1** detalle 2250 → **T2** 2200 | `CONFLICT` +50 | **Idéntico al caso 4** (bidireccional = G1c) |
| 6 | T1 2200 · T2 2250 · T3 "eran 2250" | `RESOLVED` → 2250 `CONFIRMED`, 2200 `SUPERSEDED` | Reconocer la corrección y reanudar cálculos |
| 7 | T1 2200 · T2 2250 · dos preguntas sin resolver | `ASSUMED` 2250 | Declarar que asume el desglose sin confirmar |
| 8 | 2200 declarado vs 6000 de detalle (>5%) | `CONFLICT` **no elegible** para escape | Nunca asumir; reiniciar la captura de gastos |

### Extracción

| # | Entrada | Estado esperado | Respuesta debe |
|---|---|---|---|
| 9 | `"Telecomunicaciones_Necesario 60 100 Pañales_Bebe_Vital"` | `AMBIGUOUS`, **no** `CONFLICT` | Preguntar si son 60 y 100 separados |
| 10 | `"gasto 2 500 €"` | `COMPLETE`, valor 2500 | Calcular normal (no romper este caso) |
| 11 | `"gano 2300, tengo 43 años, 2 hijos, gasto 2200"` | `COMPLETE` | Calcular. **NO** preguntar por 43 ni por 2 |
| 12 | `"gano 2300 y gasto 2200 y 450"` | `PARTIAL` | Usar 2300/2200 **y** preguntar por el 450 |
| 13 | `"Diezmo_Vital 225, Casa_Vital 700"` | items extraídos con `_` en el nombre | — |
| 14 | `"alquiler 700 comida 450 luz 120"` (sin comas) | 3 items | — |
| 15 | `"Alquiler: 700, Comida: 450, Luz: 120"` | 3 items | — |
| 16 | 15 partidas del caso real de testdev7 | `items[]` con 15 entradas **+** buckets | Suma 2250 disponible para reconciliar |
| 17 | Crédito con monto, sin plazo | `plazo_meses` = `MISSING`, **nunca 0** | Preguntar el plazo; el monto sobrevive el guardarraíl |

### Conversación y persistencia

| # | Entrada | Estado esperado | Respuesta debe |
|---|---|---|---|
| 18 | 5× `"¿cuánto me queda?"` | contador de intención repetida | R1 responde · R2 aclara distinto · R3 reconoce la repetición · R4 pregunta qué parte genera la duda |
| 19 | Cualquier turno con datos | V9: re-lectura desde BD devuelve el estado completo | — |
| 20 | `"me frustra, tengo 43 años y gasto 2200"` | financiero **+** emocional simultáneos | Abrir con empatía antes de cualquier cifra |

---

## 11 · Sustracción — segunda tanda

Cuando la capa de verdad esté verde, se **eliminan** las instrucciones deterministas que existían para compensar un estado poco fiable. Candidatas identificadas en `route.ts` (12 en total):

**Se eliminan** (eran parches del estado): `notaEco`, `notaAmbigua`, `notaExtraccionAmbigua`, `notaFaltaDesglose`, `notaSinCifras`, `notaSinCifrasDePlan`.

**Se conservan pero se reformulan** como *Response Objective* en vez de texto prescriptivo: `notaDigresion`, `notaRetornoMeta`, `notaTonoEmocional`, `instruccionAvance`, `instruccionCorrectiva`, `notaDesglose`.

El *Response Objective* entrega **qué debe conseguir esta respuesta** (hechos, conflictos, estado emocional, objetivo pendiente) y deja al modelo **cómo decirlo**.

---

## 12 · Fuera de alcance — deuda aceptada, post-piloto

Documentado explícitamente para que ningún agente lo implemente ahora:

- `FinancialTruth` generalizado a income / debts / savings (hoy solo gastos tiene doble fuente)
- `DerivedFacts Registry` formal (el orquestador ya emite conceptos con fórmula)
- `ConversationState` completo (solo entra el contador de intención repetida)
- Memoria emocional rica (`label` + `intensity` + `acknowledged`)
- Intención semántica con embeddings
- Benchmark de 100 conversaciones
- `turn_id` global de traza

---

## 13 · Criterio de éxito — medible, no percibido

| Métrica (fuente: `response_telemetry`) | Antes | Objetivo |
|---|---|---|
| Tasa de intervención sobre **prosa** | 84% (testdev6) | **↓ tendencia a 0** |
| Tasa de intervención sobre **cifras** | — | se mantiene (es la defensa real) |
| Conflictos detectados cross-turno | 0 | 100% de los casos 4 y 5 |
| Conflictos **falsos** por error de parseo | n/d | 0 |
| Casos de la matriz en verde | — | **20/20** |

**Tesis a demostrar:** la naturalidad de monoend mejora **quitando** instrucciones que se peleaban entre sí, no añadiendo inteligencia. Si la intervención sobre prosa cae mientras la de cifras se mantiene, la tesis queda probada con números.

---

## 14 · Gates de piloto — integración, no sistema paralelo

- **G1a** (0 errores aritméticos del calculador) — vigente
- **G1b** (0 respuestas con texto que contradiga la cifra calculada o cifras no trazables) — vigente
- **G1c** (**nuevo**) — reconciliación cross-turno bidireccional: detecta el conflicto sea T1→T2 o T2→T1, y lo mantiene hasta que el usuario lo resuelva o se declare `ASSUMED`. **Bloqueante de piloto.**
- G2 a G8 — sin cambios

---

## 15 · Metodología de entrega

1. Diseño acordado (**este documento**)
2. Implementación en `agent/XX`, con bloque de **invariantes bloqueantes** (§9) en el prompt
3. **Declaración de impacto**: qué funciones existentes se tocaron y por qué (`git diff --stat` justificado)
4. Revisión por un **agente distinto** del implementador (AG01 revisa a AG08)
5. `test:regression` + `test:e2e` + matriz §10 en verde
6. PR con base `develop` → merge por Luis
7. QA manual en el alias estable
8. Regla de no-reemplazo: se **añade**; modificar o eliminar lógica que funciona exige justificación explícita

**Calendario estimado:** dos tandas de fondo + una de sustracción, con QA entre cada una → 5-7 días efectivos → dogfooding 12-13 de agosto, piloto cerrado la semana del 17.

---

## 16 · Enmiendas

Este documento es histórico: el cuerpo (§0-§15) no se reescribe. Las enmiendas lo corrigen
**por encima**, con fecha y motivo. Ante contradicción entre el cuerpo y una enmienda, prevalece
la enmienda.

### E1 · 2026-08-06 — §5.2, umbral del detector de pegado: 10× → 50×

El cuerpo dice "`importe > 10 × mediana(otros ítems)`". El umbral real es **50×**.

**Motivo:** con 10×, un gasto legítimamente grande se marca como pegado y bloquea al usuario —
caso real: hipoteca de 1.200 € entre gastos de 40-60 €, mediana ≈ 90, ratio ≈13× (o ≈25× medido
por AG08 contra el caso de riesgo documentado por AG01). Con 50× el sistema sigue cazando el
caso real del "60100" (ratio ~600-668×) con margen amplio. También se añadió un suelo absoluto:
con agregado conocido, un ítem `< 3 × agregado` no se marca aunque supere la mediana.
Recalibración medida por AG08 (`docs/informes/CORRECCIONES_AG08_tanda1_truth_engine.md`, §2) y
validada en revisión por AG01. El código ya está en 50× (`detectarItemSospechosoPorMagnitud`,
`src/lib/calculator/expenses.ts`); esta enmienda elimina la contradicción entre código y contrato.

### E2 · 2026-08-06 — §9, invariantes formales V11-V13

Hasta ahora vivían solo en los prompts de implementación, no en el contrato — el próximo revisor
no tendría contra qué juzgar. Se añaden a la tabla de §9:

| # | Invariante |
|---|---|
| **V11** | Prohibido reescribir un test existente para que afirme lo contrario de lo que afirmaba. Un test que estorba está describiendo un requisito: el cambio se detiene y se reporta. |
| **V12** | El ingreso nunca puede aparecer como ítem de gasto. |
| **V13** | Un número reclamado por un patrón declarativo no puede ser usado por el parser de listas. El token reclamado actúa como frontera con offsets preservados y nunca se elimina: borrarlo fusiona los fragmentos de nombre vecinos y pierde partidas. |

**Motivo V11:** en la tanda 1 se cambió el aserto de `numbers.test.ts` para dejar la batería en
verde sobre una corrupción de datos real (`parseDigitAmount("2 500")` pasó de `2500` a `2`, y el
test se reescribió para esperar `2` en vez de detectar la regresión — ver
`docs/informes/REVISION_AG01_tanda1_truth_engine.md`, hallazgos B1/B2).

**Motivo V13:** "gano 700 y pago arriendo 650, comida 200, luz 50" perdía el arriendo y reportaba
superávit a un usuario en déficit, porque el número reclamado por el patrón declarativo de
ingreso se borraba en vez de quedar como frontera, fusionando los fragmentos de nombre vecinos.

### E3 · 2026-08-06 — §12, deuda aceptada nueva

`meta.monto` puede capturar el ingreso del usuario como monto de la meta. Preexistente e idéntico
en `develop` — no es una regresión de esta tanda. Se resuelve en la tanda 2 mediante el mecanismo
de reclamación de V13 (un número reclamado por "gano" no puede ser el monto de la meta), no como
frente aparte.

### E4 · 2026-08-06 — §11, requisito nuevo: confirmación del desglose

Cuando el usuario entrega gastos desglosados, el detalle entra como `PARSED` y el eco lo enuncia
pidiendo confirmación, antes de proponer recortes por partida.

**Alcance — deliberadamente estrecho:** no afecta sobrante, capacidad anual ni viabilidad de una
cuota (el agregado basta para eso); sí bloquea proponer recortes por partida y cualquier plan que
dependa de la clasificación vital/no-vital. Promoción a `CONFIRMED` por confirmación explícita o
por eco no corregido en el turno siguiente. El eco lo redacta el modelo, nunca una plantilla.

### E5 · 2026-08-06 — §10, casos nuevos a la matriz de aceptación (21-24)

| # | Entrada | Estado esperado | Respuesta debe |
|---|---|---|---|
| 21 | `"gano 700 y pago arriendo 650, comida 200, luz 50"` | ingreso 700, gastos 900, sobrante −200 (déficit) | Ningún ítem perdido |
| 22 | `"mi sueldo es 2500 y el arriendo 800, comida 300, luz 90"` | ingreso 2500, gastos 1190, sobrante +1310 | — |
| 23 | Prueba estructural de no-destructividad de spans tras la reclamación | — | Los offsets del token reclamado se preservan (V13) |
| 24 | `"gano 2300 y gasto aproximadamente 2000 entre vivienda, comida, servicios, ocio"` | gastos 2000, `gastos_items` **vacío** | Una categoría sin importe propio nunca es un gasto |

### E6 · 2026-08-06 — §15, metodología: revisión por agente distinto, obligatoria

La revisión adversarial de AG01 sobre la tanda 1 detectó **dos bloqueantes con la batería de
tests en verde**: la corrupción del parser (`"2 500 €"` → `2` en vez de `2500`, con el test
reescrito para ocultarlo) y la pérdida de partidas por fusión de spans al borrar el token
reclamado. Ninguno de los dos lo habría detectado la batería propia del implementador — ambos
salieron a la luz por revisión cruzada (`docs/informes/REVISION_AG01_tanda1_truth_engine.md`).

Se registra en §15 (paso 4) como **obligatorio, no opcional**: toda entrega pasa por revisión de
un agente distinto del implementador antes de PR.

### E7 · 2026-08-11 — aclaración de numeración: V11 ya es E2, no una enmienda nueva

En la comunicación entre AG08 y AG01 durante la tanda 2 (`docs/informes/CORRECCIONES_AG08_tanda2_reconciliacion_cross_turno.md`,
`docs/informes/REVISION_AG01_tanda2_reconciliacion.md`) se citó **V11 como "enmienda E7"**. No lo
es: **V11 ya está incorporado en E2** (arriba). Esta entrada cierra la ambigüedad de numeración —
no añade invariante nueva. Referencia única de V11 a partir de ahora: **E2**.

### E8 · 2026-08-11 — aclaración de numeración: V12/V13 ya son E2, no una enmienda nueva

Misma situación que E7: la comunicación entre agentes citó **V12 y V13 como "enmienda E8"**
(`docs/informes/CORRECCIONES_AG08_tanda2_reconciliacion_cross_turno.md` §"Base verificada" cita "V15
atribución… Enmienda E8 del contrato"). **V12 y V13 ya están incorporados en E2.** Esta entrada
cierra la ambigüedad — no añade invariante nueva. Referencia única de V12/V13 a partir de ahora:
**E2**.

**Nota de proceso (E7+E8):** es la **tercera tanda consecutiva** en que el revisor adversarial
(AG01) juzga invariantes que el contrato no contenía formalmente en el momento de la revisión —
primero V11-V13 (tanda 1, cerrado en E2), ahora V14-V16 (tanda 2, cerrado en E9 abajo). El
contrato es la fuente de verdad o no sirve: **toda invariante que un revisor usa para aprobar o
rechazar una entrega se incorpora a §9 en la misma tanda en que se detecta**, no se deja para la
memoria de los agentes ni para informes sueltos.

### E9 · 2026-08-11 — §9, invariantes formales nuevos V14-V16

Detectados y verificados en la tanda 2 de reconciliación cross-turno
(`docs/informes/CORRECCIONES_AG08_tanda2_reconciliacion_cross_turno.md`,
`docs/informes/CORRECCIONES_AG08_tanda2_revision_AG01.md`,
`docs/informes/REVISION_AG01_tanda2_reconciliacion.md`). Se añaden a la tabla de §9:

| # | Invariante |
|---|---|
| **V14** | **Ley de conservación.** Ningún número desaparece en silencio. Todo número termina en (a) campo asignado, (b) huérfano no relevante, o (c) huérfano relevante que degrada `extraction_status` a `PARTIAL`. `extraction_status` nunca sale `undefined`. |
| **V15** | **Atribución correcta.** La conservación (V14) garantiza que ningún número desaparezca — **no** que se atribuya al campo correcto. Son invariantes distintas: un número puede sobrevivir y aun así atribuirse mal. |
| **V16** | **No doble conteo.** Un importe declarado como agregado no puede figurar además como ítem del detalle; la suma de ítems no puede exceder el agregado sin declarar `CONFLICT`. |

**Motivo V14:** convierte una clase entera de fallos ("un número simplemente desapareció") en test
estructural automático — se verifica sobre el propio delta, sin enumerar casos manualmente.

**Motivo V15 (caso real que la distingue de V14):** "gasté 1800: renta 900, comida 500, luz 400" —
sin V15, "gasté" podía leerse como ítem con importe 1800 (ningún número desaparecía: V14 seguía
cumplida) mientras el agregado real terminaba en `renta=900, comida=500, luz=400` **más** un
ítem fantasma `gasté=1800`, reportando 3600 en vez de 1800. La regresión de fronteras posicionales
("casa" de un crédito no debe destruir "casa 700" de un gasto) es la misma clase de fallo.

**Motivo V16 y estado — PARCIAL, no cerrado:** el mismo caso de arriba corregido por
`aplicarGuardaV16` (`src/lib/calculator/scenario.ts`): si un ítem del desglose iguala
**exactamente** el agregado declarado en el mismo mensaje, se descarta como ítem fantasma.
Cubre `"gasté 1800: renta 900, comida 500, luz 400"` → 1800 ✅. **No cubre** el fraseo con palabra
intermedia entre la cifra y la palabra clave de gasto (`"mis gastos fueron 1200: …"`,
`"gastamos 950 al mes: …"`) — ahí el patrón declarativo no reconoce agregado alguno, el total cae
al parser de listas como una partida más, y el resultado sale **el doble** de los gastos reales
marcado `COMPLETE`, sin huérfano ni señal de ambigüedad. Preexistente e idéntico en `develop`; no
es regresión de la tanda 2. **Condición antes del piloto (no del merge)**, según recomendación
explícita de AG01: generalizar V16 para que cualquier lista precedida de contexto de gasto + cifra
+ dos puntos trate esa cifra como agregado, y — como red — degradar a `AMBIGUOUS` en vez de
`COMPLETE` si la suma de ítems ≈ 2× una cifra presente en el mensaje.

### E10 · 2026-08-11 — §1 y §12, memoria a nivel de usuario (decisión de Luis, 2026-08-07)

**Decisión:** el estado financiero es del **usuario**, no de la conversación.

**Diagnóstico:** hoy `scenario_state` se lee de `conversations` filtrando por `conversationId`
(`src/app/api/chat/route.ts`, lectura de `conv.scenario_state` tras `.eq('id', conversationId)`).
Cada conversación nueva arranca con `prevScenario = {}`: amnesia entre sesiones **por diseño**.
Contradice el ADN de `CLAUDE.md` ("seguimiento constante") y es inconsistente con `goals`, que ya
es por usuario (`user_id` en `007_goals_table.sql`), no por conversación.

**Resolución:** los **HECHOS financieros** (ingreso, gastos, detalle, ítems, crédito, conflictos,
`ASSUMED`/`SUPERSEDED`, `fact_status`) pasan a nivel de **usuario**. El **estado de DIÁLOGO**
(digresiones, propuesta pendiente, contador anti-repetición) permanece por **conversación** — no
tiene sentido que una digresión de hace tres sesiones condicione el turno de hoy.

**Se descarta explícitamente usar RAG como fuente de hechos financieros.** RAG es recuperación
probabilística; la capa de hechos debe ser determinista, con procedencia (`fact_status`,
`SUPERSEDED` con motivo y turno) y estado verificable. RAG queda para recuperación no
estructurada (contexto conversacional libre), **nunca** como fuente de una cifra — sería
reintroducir por la puerta trasera exactamente lo que §3 prohíbe para `LLM_INFERRED`.

**Alcance de implementación — no se especifica aquí.** Esta enmienda registra la decisión y su
motivo; el diseño de la migración (tabla nueva vs. columna en `profiles`, estrategia de
reconciliación cuando el usuario tiene múltiples conversaciones concurrentes) es trabajo de
implementación de la tanda correspondiente, no de este contrato.

### Casos nuevos a la matriz de aceptación (E9/E10 — §10, 25-27)

| # | Entrada | Estado esperado | Respuesta debe |
|---|---|---|---|
| 25 | `"mis gastos fueron 1200: internet 300, agua 400, gas 500"` | gastos **1200** (hoy da 2400 — M1, condición de piloto, ver E9) | Ningún doble conteo del agregado como ítem |
| 26 | `"gasté 1800: renta 900, comida 500, luz 400"` | gastos 1800, 3 ítems, `CONSISTENT`/`COMPLETE` (atribución única, V15) | "gasté" nunca se atribuye como ítem con importe 1800 |
| 27 | Sesión nueva (conversación distinta) de un usuario con meta/ingreso/desglose ya confirmados en una sesión anterior | Los hechos financieros están disponibles sin volver a preguntarlos | Reconoce el estado; no repite el onboarding de datos ya `CONFIRMED` |
