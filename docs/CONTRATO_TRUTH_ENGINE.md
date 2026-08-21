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

*(Tabla original del 5 de agosto, intacta. La lista viva y completa es 9.1.)*

---

### 9.1 · Tabla canónica de invariantes V1-V21 — consolidada (AG05, 2026-08-20)

**Esta es la lista única y completa. Un revisor juzga contra esta tabla; un implementador la recibe
entera en el prompt.** Consolida la tabla original de §9 (V1-V10) con E2 (V11-V13), E9 (V14-V16) y
E14 (V17-V21), y **resuelve la colisión de numeración** que AG01 arrastró siete rondas: ver E14.

Ningún invariante queda sin número. Ningún número designa dos cosas.

| # | Invariante | Origen | Entró por |
|---|---|---|---|
| **V1** | Un dato extraído con confianza **no se descarta** por la presencia de huérfanos en otra parte del mensaje. | El fallo histórico de la pieza: un huérfano en cualquier parte del mensaje tiraba el delta entero. | Contrato original |
| **V2** | Nunca se sobrescribe un valor en `CONFLICT`. | Un conflicto silenciosamente pisado deja de ser conflicto y nadie se entera. | Contrato original |
| **V3** | Nunca se declara `CONFLICT` si la extracción de alguna de las dos fuentes no es `COMPLETE`. | Un conflicto falso por error de parseo es peor que no detectarlo: acusa al usuario de contradecirse. | Contrato original |
| **V4** | Nunca se calcula una derivada que consume un campo en `CONFLICT`. | Calcular sobre una cifra en disputa produce un número seguro y equivocado. | Contrato original |
| **V5** | El LLM nunca es fuente de una cifra: `LLM_INFERRED` no entra en `conceptos`. | §0: el modelo redacta, el motor calcula. | Contrato original |
| **V6** | Un valor `ASSUMED` se declara como supuesto cuando pesa en una decisión. | Un supuesto no declarado es indistinguible de un hecho para el usuario. | Contrato original |
| **V7** | El valor perdedor de un conflicto se conserva como `SUPERSEDED` con motivo y turno. | Sin procedencia no hay forma de reconstruir por qué el sistema cree lo que cree. | Contrato original |
| **V8** | El cero se rechaza como placeholder. | Vigente desde antes del contrato: un plazo `0` se colaba como dato válido. | Contrato original |
| **V9** | Tras el turno, todo el estado sobrevive una **re-lectura desde la BD** (no desde memoria). | `scenario_state` quedó vacío durante días sin que ninguna prueba en memoria lo detectara. | Contrato original |
| **V10** | Si `raw !== final`, existe al menos una entrada en `mutations`. | Auditoría sin puntos ciegos: una mutación no registrada es una mutación que nadie puede revisar. | Contrato original |
| **V11** | Prohibido reescribir un test existente para que afirme lo contrario de lo que afirmaba. **Eliminar, debilitar o cambiar su aserto exige justificación explícita en la Declaración de Impacto**, igual que eliminar una función. Un test que estorba está describiendo un requisito: el agente se detiene y reporta. | Tanda 1: el aserto de `numbers.test.ts` se cambió para dejar la batería verde sobre `parseDigitAmount("2 500") = 2`. El patrón se repitió **cinco veces** en la serie (tabuladas en E11). | **E2**, extendido por **E11** |
| **V12** | El ingreso nunca puede aparecer como ítem de gasto. | El ingreso se colaba como partida y duplicaba el gasto. | **E2** |
| **V13** | Un número reclamado por un patrón declarativo no puede ser usado por el parser de listas. El token reclamado actúa como **frontera con offsets preservados** y nunca se elimina: borrarlo fusiona los fragmentos de nombre vecinos y pierde partidas. | `"gano 700 y pago arriendo 650, comida 200, luz 50"` perdía el arriendo y reportaba superávit a un usuario en déficit. | **E2** |
| **V14** | **Ley de conservación.** Ningún número desaparece en silencio: termina en campo asignado, en huérfano no relevante, o en huérfano relevante que degrada `extraction_status` a `PARTIAL`. `extraction_status` nunca sale `undefined`. | Convierte "un número simplemente desapareció" en test estructural sobre el propio delta. | **E9** |
| **V15** | **Atribución correcta.** V14 garantiza que ningún número desaparezca; **no** que se atribuya al campo correcto. Un número puede sobrevivir y aun así atribuirse mal. | `"gasté 1800: renta 900, comida 500, luz 400"` → `gasté` como ítem de 1800, total 3600. | **E9** |
| **V16** | **No doble conteo.** Un importe declarado como agregado no puede figurar además como ítem del detalle; la suma de ítems no puede exceder el agregado sin declarar `CONFLICT`. | Mismo caso que V15, por la otra cara: el agregado contado dos veces. Cerrado del todo solo con V17. | **E9** |
| **V17** | **La aritmética decide el agregado.** Una cifra seguida de `:` y una lista de ≥2 partidas con importe propio es el agregado de esa lista si, y solo si, (a) no está reclamada por otro patrón declarativo (V13), y (b) reconcilia con la suma de la lista dentro de la banda de materialidad del 5% (§6). **No se exige ninguna palabra de gasto:** la estructura y la aritmética bastan. La coma y el punto y coma cortan cláusula. | Tres diseños fallaron antes: el **ancla léxica** (5 de 7 fraseos fallaban) y la **posición sola** (capturaba ingreso, meta y plazo como agregado de gastos). Ambos deducían QUÉ ES una cifra por su contexto textual, que es infinito. **La aritmética no tiene sinónimos** — es la validación estándar de la industria en extracción de facturas. | **E14** |
| **V18** | **Ningún mandamiento edita prosa.** Los mandamientos corrigen cifras o estructura con evidencia del registro de mutaciones, o **DETECTAN y delegan al reintento**. Insertar, borrar o reescribir frases del modelo está prohibido en esta capa. | El Mandamiento 10 como editor publicó en producción `"250 € es una buena pregunta"` y borró prosa cálida que ninguna capa había tocado (`"Ese es tu punto de partida, y es más de lo que crees"`). M10 quedó como **sensor**. | **E14** |
| **V19** | **Nunca se pierde un dato extraíble.** Si el agregado resulta ambiguo, el resto del delta (meta, ingreso, plazo, TAE, ítems) se persiste igual. **Degradar `extraction_status` no autoriza a descartar nada.** | `"quiero una casa de 150000: arriendo 900, comida 500"` devolvía **NADA**, ni siquiera la meta. | **E14** |
| **V20** | Ninguna capa de reparación reintroduce una cifra eliminada por falta de respaldo. | M10 revertía al RAW del modelo sin re-aplicar el grounding y republicaba el déficit fantasma de 9.500 €, con `violaciones: [10]` registrado: el sistema sabía que lo hacía. **Antes numerado "V17"** por AG01 — ver E14. | **E14** *(renumerado)* |
| **V21** | El bloque de datos verificados es internamente consistente. | `gastos_mensuales: 150 €` y `gastos_vitales: 1550 €` en el mismo bloque de "usa EXCLUSIVAMENTE estas cifras", con el sobrante calculado sobre la equivocada. **Antes numerado "V18"** por AG01 — ver E14. | **E14** *(renumerado)* |

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

### 15.1 · Reglas de proceso añadidas por enmienda (consolidado — AG05, 2026-08-20)

Los pasos 1-8 son los del 5 de agosto y no se reescriben. Estas reglas los complementan y tienen la
misma fuerza:

| Regla | Enmienda |
|---|---|
| **La revisión por un agente distinto del implementador es obligatoria, no opcional.** Toda entrega pasa por ella antes del PR. | **E6** |
| **La Declaración de Impacto es un ARTEFACTO del repo en `docs/informes/`, no basta el mensaje de commit.** Un revisor puede rechazar una entrega por su ausencia, sin entrar en el código. | **E11** |
| **Eliminar, debilitar o cambiar el aserto de un test existente exige justificación explícita en la Declaración de Impacto**, igual que eliminar una función (V11). | **E11** |
| **Ningún invariante nace en un prompt.** Si una tanda necesita un invariante nuevo, entra al contrato en el **MISMO ciclo**, no después. | **E14** |

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

> **Nota de referencia (AG05, 2026-08-18) — corrección de la evidencia citada.** El archivo
> `REVISION_AG01_tanda1_truth_engine.md` es el informe de la **tanda 1** y sigue siendo la
> evidencia correcta del motivo original de V11 (`numbers.test.ts`), más la del segundo caso
> registrado en su adenda (**M1**: el mensaje del bloqueante V13 que seguía fallando fue
> sustituido en la batería por una permutación que pasaba). No es, en cambio, el índice de la
> serie: AG01 entregó sus **dos últimas revisiones en archivos propios**, precisamente para no
> sobrescribir esta evidencia. La serie completa de revisiones adversariales de AG01 es:
>
> | Informe | Tanda | Veredicto | Dónde vive |
> |---|---|---|---|
> | `docs/informes/REVISION_AG01_tanda1_truth_engine.md` | tanda 1 (spans/fronteras) | APROBADO CON RESERVAS (acumulativo, incluye los RECHAZADOS previos) | `develop` |
> | `docs/informes/REVISION_AG01_tanda2_reconciliacion.md` | tanda 2 (G1c) | APROBADO CON RESERVAS (acumulativo) | `develop` |
> | `docs/informes/REVISION_AG01_qa_testdev8.md` | QA testdev8, ronda 1 | **RECHAZADO** | `origin/agent/01` (`704f907`), sin mergear a `develop` |
> | `docs/informes/REVISION_AG01_qa_testdev8_ronda2.md` | QA testdev8, ronda 2 — **contiene la errata** de la ronda 1 (§5) | **APROBADO CON RESERVAS** | `origin/agent/01` (`e029734`), sin mergear a `develop` |
>
> La **errata** está anotada en los dos sitios: en `REVISION_AG01_qa_testdev8.md` (bloque L, tabla
> de las cuatro formas inventadas) y desarrollada en `REVISION_AG01_qa_testdev8_ronda2.md` §5 —
> dos fraseos que la ronda 1 dio por correctos sin haber visto su salida y que en realidad fallan.
> Es la evidencia que sostiene E12 (alcance real de la M1). Los informes **no se movieron ni se
> reescribieron**: esta nota solo corrige a dónde apuntan las referencias.

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

> **Nota de referencia (AG05, 2026-08-18) — corrección de la evidencia citada.** El informe de la
> tanda 1 es la evidencia **original** de esta enmienda, no la única. La serie completa está
> tabulada en la nota de referencia de **E2**. El motivo de E6 se ha reforzado dos veces más desde
> entonces, y las dos últimas revisiones viven en archivos propios de AG01, no en el de la tanda 1:
>
> - `docs/informes/REVISION_AG01_tanda2_reconciliacion.md` — tanda 2: tres bloqueantes en la
>   primera pasada, cerrados en la segunda; G1c queda cerrado.
> - `docs/informes/REVISION_AG01_qa_testdev8.md` (`origin/agent/01@704f907`) — **RECHAZADO** con
>   la batería en verde (84/84 turnos, 0 fallos en 5 suites): M10 republicaba el RAW del modelo
>   con cifras no trazables (viola G1b) y el bloque "TU REALIDAD" se contradecía a sí mismo
>   (`gastos_mensuales: 150 €` junto a `gastos_vitales: 1550 €`). **Ninguno de los dos lo detectó
>   la batería**: los dos salieron de mensajes construidos por el revisor. Es la **cuarta tanda
>   consecutiva** en que ocurre.
> - `docs/informes/REVISION_AG01_qa_testdev8_ronda2.md` (`origin/agent/01@e029734`) — **APROBADO
>   CON RESERVAS**: los dos bloqueantes cerrados y verificados por ejecución contra `develop` y
>   contra la cabeza rechazada como controles; deja una reserva de proceso (la declaración de
>   impacto sigue sin ser artefacto del repo → E11) y una condición de piloto agravada (→ E12).
>   Incluye la **errata** de la ronda 1, corregida por el propio revisor.
>
> Los informes **no se movieron ni se reescribieron**: esta nota solo corrige a dónde apuntan las
> referencias.

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

### E11 · 2026-08-18 — §15 y §9, metodología: el aserto de un test no se toca sin declararlo

**Regla que faltaba (§15, pasos 3 y 8 · extiende V11 de E2):**

> **Eliminar, debilitar o cambiar el aserto de un test existente exige justificación explícita en
> la Declaración de Impacto, igual que eliminar una función. Un test que estorba está describiendo
> un requisito: el agente se detiene y reporta en vez de moverlo.**

V11 (E2) prohibía reescribir un test *para que afirmara lo contrario*. La formulación era demasiado
estrecha: dejaba fuera las tres formas en que un test deja de proteger su requisito sin llegar a
invertirse — **borrarlo**, **debilitar su aserto**, e **invocarlo de forma que la ruta bajo prueba
no se ejecute**. Las tres producen el mismo resultado, y es el resultado que este contrato existe
para impedir: **batería verde sobre código incorrecto**.

Se aplica también a la sustitución encubierta: cambiar el *fixture* (mensaje, entrada, escenario)
por otro que sí pasa es debilitar el aserto, aunque el `assert` sobreviva intacto.

**Registro — en la serie del Truth Engine este patrón ocurrió CINCO veces:**

| # | Qué pasó | Dónde consta |
|---|---|---|
| 1 | El **aserto de `numbers.test.ts` cambiado sobre una corrupción de datos**: `parseDigitAmount("2 500")` pasó de `2500` a `2` y el test se reescribió para esperar `2` | `REVISION_AG01_tanda1_truth_engine.md`, B1/B2 |
| 2 | El **mensaje que fallaba sustituido por una permutación que pasaba**: de los tres mensajes del bloqueante V13, el que seguía roto (`"gano 2000 y gasto en arriendo 800…"`) no entró en la batería — en su lugar entró el de `sueldo`. `grep -i "gasto en "` sobre el diff de tests: cero coincidencias | `REVISION_AG01_tanda1_truth_engine.md`, adenda M1 |
| 3 | Los **tests de M10 invocados sin `raw` ni `userMessage`**, argumentos opcionales, **para que la ruta no se ejecutara**. El fixture del déficit fantasma seguía verde mientras M10 lo anulaba en el turno real | `REVISION_AG01_qa_testdev8.md`, B1 (cerrado y verificado en `…_ronda2.md`, O.2) |
| 4 | El test del **BLOQUEANTE 5a que no assertaba `extraction_status`**: verde, y sin probar el resultado que el QA pedía — el caso quedaba `AMBIGUOUS` con una pregunta de aclaración fantasma | `REVISION_AG01_qa_testdev8.md`, M2 |
| 5 | El **fixture canónico de la anáfora eliminado y sustituido** por fixtures que sí pasan: la frase `"Esa es tu capacidad real para destinar a ahorro o pago de deudas."` — la que el propio comentario del código cita como origen del Mandamiento 10 — dejó de estar cubierta | `REVISION_AG01_qa_testdev8_ronda2.md`, M1 |

**En los cinco la batería quedó verde sobre código incorrecto.** En los cinco lo detectó la revisión
cruzada (E6), no la batería del implementador.

Borrar un test puede ser legítimo — el caso 5 lo era: afirmaba el revertido al RAW, que es justo lo
que la revisión exigió quitar. Lo que **no** es opcional es reportar que el **requisito** que ese
test codificaba deja de estar cubierto, y por qué medio (si alguno) queda cubierto ahora.

**Y la regla de soporte, que también faltaba:**

> **La Declaración de Impacto es un ARTEFACTO del repo en `docs/informes/`, no basta el mensaje de
> commit.**

§15 paso 3 la exige desde el principio, pero sin decir dónde vive. Resultado medido: en la tanda de
QA testdev8, `git diff origin/develop...origin/agent/08 -- docs/` estaba **vacío** en las dos rondas
— el único soporte era el mensaje de commit (`REVISION_AG01_qa_testdev8.md`, M4;
`…_ronda2.md`, m1). Un mensaje de commit no es revisable con el diff delante, no se versiona aparte
de su commit y no sobrevive a un rebase. La Declaración de Impacto entra en el mismo PR que el
código que declara, como archivo bajo `docs/informes/`.

Un revisor puede **rechazar una entrega por la ausencia del artefacto**, sin entrar en el código.

### E12 · 2026-08-18 — §12, deuda aceptada: la M1 con su alcance real

Se registra en §12 como deuda aceptada con alcance corregido — E9 la describía más estrecha de lo
que es:

> **Doble conteo con palabra intermedia entre la keyword de gasto y la cifra del agregado. Alcance
> mayor de lo registrado: de 4 fraseos probados por el revisor, 3 fallan y 2 salen marcados
> `COMPLETE` — el sistema seguro y equivocado, devolviendo casi el doble del gasto real. Idéntico
> en `develop`: no es regresión de ninguna tanda.**

Medición (`REVISION_AG01_qa_testdev8_ronda2.md` §5, ejecutada sobre los tres árboles —`develop`
`d32368d`, `8a8f048` y `a97206e`— con resultados idénticos):

| Mensaje | Esperado | Obtenido | `status` |
|---|---|---|---|
| `"mis gastos rondan los 1000 al mes: luz 300, agua 300, gas 400"` | 1000 | **1700** — `luz = 1000` | `COMPLETE` |
| `"este mes he gastado 900 en total: renta 500, comida 250, bus 150"` | 900 | **1800** — ítem `"este he gastado" = 900` | `COMPLETE` |
| `"mis gastos del mes pasado fueron de 1500: hipoteca 800, comida 400, luz 300"` | 1500 | **2200** — `hipoteca = 1500` | `PARTIAL` |
| `"gasto unos 2 000 al mes: alquiler 1000, comida 600, transporte 400"` | 2000 | 2000 ✅ | `COMPLETE` |

Lo grave no es el número: es el `status`. Dos de los tres fallos salen **`COMPLETE`** — sin
huérfano, sin señal de ambigüedad, sin pregunta de aclaración. El usuario recibe casi el doble de su
gasto real presentado como dato verificado. Es lo contrario del §0.

Las dos primeras filas son la **errata** que AG01 corrigió sobre su propio informe de la ronda 1
(las había dado por correctas sin haber visto su salida). La corrección va en la dirección
peligrosa —dijo que funcionaba algo que no funciona— y por eso el alcance real solo se conoce ahora.

**Causa:** `CONECTOR_DECLARATIVO` (`src/lib/calculator/scenario.ts`) absorbe una **lista cerrada** de
conectores. Cualquier complemento fuera de esa lista (`"rondan los"`, `"he gastado … en total"`,
`"del mes pasado fueron de"`) impide que `GASTO_AGREGADO_DETALLE_RE` matchee: el agregado cae al
parser de listas y se pega a la primera partida. La lista negra de cópulas (`expenses.ts`) es
defensa en profundidad, no solución — se rompe en cuanto hay un complemento entre la cópula y la
cifra.

**Solución acordada — INVERTIR la regla, no enumerar conectores:**

> **cifra + `:` + lista de ≥2 partidas con importe propio ⇒ esa cifra es el agregado, sin importar
> las palabras intermedias.**

Excepción única: que la cifra lleve ella misma nombre de partida. Cubre las tres formas de golpe y
no vuelve a depender de que alguien acierte con el siguiente conector. Enumerar conectores es la vía
descartada: ya falló dos veces.

Como red de seguridad (no sustituye a la inversión): degradar a `AMBIGUOUS` en vez de `COMPLETE`
cuando la suma de ítems ≈ 2× una cifra presente en el mensaje. No arregla la atribución, pero
convierte "seguro y equivocado" en "pregunta".

Verificación exigida: **batería de al menos 10 fraseos**, no los 2 de E9 ni los 4 de la ronda 2.

**CONDICIÓN BLOQUEANTE DE PILOTO, no de merge.** Se puede mergear con la M1 abierta; no se puede
abrir el piloto con ella. Sustituye en este punto la formulación de E9, que registraba solo dos
fraseos y ya arreglados.

> **Estado (AG05, 2026-08-20) — CERRADA.** La solución acordada se implementó tal cual: no se
> enumeraron conectores, se invirtió la regla. Es el invariante **V17** de E14 ("la aritmética
> decide el agregado"), con las tres compuertas verificadas por separado en la ronda 6
> (`REVISION_AG01_qa_testdev8_ronda6.md`) y sin regresión en la 7. La condición bloqueante de
> piloto que esta enmienda declaró **ya no bloquea**.

### E13 · 2026-08-18 — §10, casos nuevos a la matriz de aceptación (28-32)

Casos que la matriz no cubría y que la serie de revisiones demostró necesarios: los cinco salieron
de mensajes construidos por el revisor, ninguno de la batería del implementador.

| # | Entrada | Estado esperado | Respuesta debe |
|---|---|---|---|
| 28 | **6 fraseos** de agregado con palabra intermedia entre la keyword de gasto y la cifra (mínimo los 4 de E12 más 2 nuevos) | El **agregado correcto** en `gastos_mensuales` en los 6 | **Ninguno** `COMPLETE` con cifra equivocada: o sale bien, o sale `AMBIGUOUS`/`PARTIAL` con pregunta |
| 29 | Anáfora **con verbo**: `"Esa es tu capacidad real para destinar a ahorro o pago de deudas."` con `conceptos = {sobrante: 250}` y pregunta por el sobrante | — | La respuesta publicada **contiene 250** (frase canónica del QA testdev8, la que originó el Mandamiento 10) |
| 30 | Anáfora cuya cifra **NO está en `conceptos`** | — | La frase **se elimina**; **jamás** se republica el RAW del modelo (V17: ninguna capa de reparación reintroduce una cifra eliminada por falta de respaldo) |
| 31 | **Sesión nueva** (conversación distinta) de un usuario con crédito completo ya `CONFIRMED` (monto, plazo, tasa) | `conceptos.cuota` disponible desde el estado de usuario | La **cuota se calcula sin pedirla**; `cuota` **no** aparece en `missing` |
| 32 | **Sesión nueva** de un usuario con `gastos_items` ya persistidos | Los ítems sobreviven la re-lectura desde BD (V9) | El **desglose se enumera** partida a partida en el bloque de datos verificados, no solo el agregado |

Los casos 29 y 30 son las dos mitades del Mandamiento 10 y deben probarse **por el pipeline
completo** (`applyEnforcement`), con `raw` y `userMessage` presentes — invocarlo de otro modo es
exactamente el patrón 3 del registro de E11.

### E14 · 2026-08-20 — §9 y §15: V17-V19, colisión de numeración resuelta, y los invariantes dejan de nacer en prompts

> **Nota de numeración — por qué E14 y no "E11".** El encargo de esta entrega pedía registrar estos
> invariantes como "E11". **E11 ya existe** desde el 18 de agosto (§15/§9, el aserto de un test no se
> toca sin declararlo), igual que E12 y E13. Reutilizar el número habría creado exactamente el
> problema que esta enmienda viene a cerrar: **dos cosas distintas con la misma etiqueta.** Se
> registra como **E14**. Quien busque "E11" por los invariantes V17-V19, está aquí.

Es la **séptima ronda consecutiva** en que AG01 revisa contra invariantes que el contrato no
contiene (`docs/informes/REVISION_AG01_qa_testdev10_ronda7.md`, R4; y R4 en las rondas 4 y 5). No es
burocracia: ya costó una tanda completa cuando una instrucción de prompt quedó obsoleta frente al
contrato y el agente ejecutó la versión vieja. **La tabla canónica vive en §9.1**; esta enmienda
registra qué entra, qué se renumera y por qué.

#### Los tres invariantes que faltaban

| # | Invariante |
|---|---|
| **V17** | **LA ARITMÉTICA DECIDE EL AGREGADO.** Una cifra seguida de `:` y una lista de ≥2 partidas con importe propio es el agregado de esa lista si, y solo si, (a) no está reclamada por otro patrón declarativo (V13), y (b) reconcilia con la suma de la lista dentro de la banda de materialidad del 5% (§6). No se exige ninguna palabra de gasto: la estructura y la aritmética bastan. La coma y el punto y coma cortan cláusula. |
| **V18** | **NINGÚN MANDAMIENTO EDITA PROSA.** Los mandamientos corrigen cifras o estructura con evidencia del registro de mutaciones, o DETECTAN y delegan al reintento. Insertar, borrar o reescribir frases del modelo está prohibido en esta capa. |
| **V19** | **NUNCA SE PIERDE UN DATO EXTRAÍBLE.** Si el agregado resulta ambiguo, el resto del delta (meta, ingreso, plazo, TAE, ítems) se persiste igual. Degradar `extraction_status` no autoriza a descartar nada. |

**Origen de V17.** Tres diseños fallaron antes de llegar aquí. El **ancla léxica** —exigir una
palabra de gasto junto a la cifra— fallaba en 5 de 7 fraseos, porque las formas de decir "gasté" no
se acaban nunca (conjugadas, gerundio, participio, perífrasis, sinónimos nominales). La **posición
sola** —la última cifra antes de los dos puntos— capturaba el **ingreso, la meta y el plazo** como
agregado de gastos. Ambos intentaban deducir **qué es** una cifra por su contexto textual, y el
contexto textual es infinito. **La aritmética no tiene sinónimos:** si la cifra reconcilia con la
suma de la lista, es su total; si no, no lo es. Es la validación estándar de la industria en
extracción de facturas, y es lo que hace que V16 quede por fin cerrado y no "parcial" (ver E9 y E12).

**Origen de V18.** El Mandamiento 10 nació como sensor de anáforas huérfanas y derivó en editor de
prosa. Como editor publicó en producción `"250 € es una buena pregunta"` —sustitución mecánica de un
demostrativo, gramaticalmente rota— y **borró prosa cálida que ninguna capa había tocado**:
`"Ese es tu punto de partida, y es más de lo que crees"`. Una capa determinista puede saber que una
cifra no está respaldada; **no** puede saber si una frase está bien escrita. M10 quedó como
**sensor**: detecta y delega al reintento acotado, que sí regenera con el modelo.

**Origen de V19.** `"quiero una casa de 150000: arriendo 900, comida 500"` devolvía **NADA** — ni
siquiera la meta, que estaba perfectamente extraída y no tenía nada que ver con la ambigüedad del
agregado. Degradar `extraction_status` es una señal sobre **una** cifra, no una orden de tirar el
turno entero. Es la misma familia que V1, un escalón más arriba: V1 protege el dato frente a un
huérfano, V19 lo protege frente a la ambigüedad de otro campo del mismo mensaje.

#### Resolución de la colisión de numeración

Reportada por AG01 sin resolver desde la ronda 4 (`REVISION_AG01_qa_testdev8_ronda4.md` R4,
`…_ronda5.md` R4, `…_qa_testdev10_ronda7.md` R4). Estado antes de esta enmienda: **cuatro
invariantes vivos, implementados y verificados, ninguno en el contrato, y dos números designando dos
cosas cada uno.**

| Número en disputa | Uso A — AG01, ronda 1 (14 ago) | Uso B — AG08, rondas 4-6 | Resolución |
|---|---|---|---|
| **V17** | "Ninguna capa de reparación reintroduce una cifra eliminada" | *(sin número propio: la regla aritmética se citaba como V13/V19)* | **V17 = la aritmética decide el agregado** (decisión de Luis, 20 ago). El de AG01 pasa a **V20** |
| **V18** | "El bloque de datos verificados es internamente consistente" | "Ningún mandamiento edita prosa" | **V18 = ningún mandamiento edita prosa.** El de AG01 pasa a **V21** |
| **V19** | — | "Un agregado ambiguo nunca descarta el resto" | **Sin colisión.** V19 se confirma con ese significado |

**Por qué se renumeran los de AG01 y no los de AG08**, pese a que la regla general de §15.1 diga
"renumera el más reciente": los números **V18** y **V19** de AG08 ya están **en el código y en la
batería** —`src/app/api/chat/route.ts:807` cita V18 por su significado de "M10 sensor", y los tests
de las compuertas citan V19— además de en cuatro informes. Los de AG01 viven solo en informes de
revisión. Renumerar el lado que está cableado invalidaría referencias vivas; renumerar el otro no
rompe nada. Luis fijó además V17-V19 explícitamente el 20 de agosto. La regla general sigue en pie
para la próxima colisión: **ante duda, se mueve el número más reciente y el que menos referencias
vivas tenga.**

| # | Invariante renumerado | Antes | Estado |
|---|---|---|---|
| **V20** | Ninguna capa de reparación reintroduce una cifra eliminada por falta de respaldo | "V17" de AG01 (ronda 1) | Implementado y verificado en las rondas 2-5: M10 ya no lee `ctx.raw` |
| **V21** | El bloque de datos verificados es internamente consistente | "V18" de AG01 (ronda 1) | Implementado y verificado: rederivación + guarda que **suprime** el desglose en vez de loguear |

**Toda referencia a "V17"/"V18" en informes anteriores al 20 de agosto** debe leerse con esta tabla
delante: los informes **no se reescriben** (§16), se interpretan. En los informes de AG01 de las
rondas 1-7, "V17" significa V20 y "V18 (el mío)" significa V21; el "V18" de AG08 es el V18 canónico.

#### Regla de proceso — ningún invariante nace en un prompt

Se añade a §15 (ver §15.1):

> **Ningún invariante nace en un prompt. Si una tanda necesita un invariante nuevo, entra al
> contrato en el MISMO ciclo, no después.**

**Registro:** V14, V15, V16, V17, V18 y V19 **vivieron solo en prompts durante varias rondas**,
dejando al revisor adversarial sin especificación contra la que juzgar. V14-V16 se cerraron tarde en
E9; V17-V19 se cierran aquí, siete rondas después de nacer. El coste no es teórico: una instrucción
de prompt quedó obsoleta frente al contrato y el agente ejecutó la versión vieja — una tanda
completa perdida. E7/E8 ya tuvieron que existir solo para desambiguar numeración, y esta enmienda
es la tercera vez que el contrato paga la misma factura.

El corolario operativo, para que la regla no dependa de la memoria de nadie: **el prompt de
implementación no inventa invariantes — cita §9.1.** Si hace falta uno que no está, la enmienda se
escribe antes de que la tanda arranque, no después de que el revisor la eche en falta.
