# RECHAZADO — revisión adversarial AG01 · ronda 3 (`agent/08` @ `8d6adad`)

**Revisor:** AG01 (Arquitecto) · **Implementador:** AG08 · **Fecha:** 2026-08-18
**Base:** `origin/develop` (`358c729`) · **Rama juzgada:** `origin/agent/08` (`8d6adad`), sin mergear
**Rondas previas:** `REVISION_AG01_qa_testdev8.md` (RECHAZADO) · `REVISION_AG01_qa_testdev8_ronda2.md` (APROBADO CON RESERVAS)
**Reporte Fase 4 de AG08:** `docs/informes/CORRECCIONES_AG08_regla_estructural_agregado_y_anafora.md`
**Contrato:** `docs/CONTRATO_TRUTH_ENGINE.md` (§5, §8, §9 con E1-E10, §13, §14, §15)

> **Nota sobre el nombre del archivo.** El encargo pedía entregar en
> `REVISION_AG01_tanda1_truth_engine.md`. Ese archivo es el informe de la **tanda 1** y el
> contrato lo cita como evidencia en **E2** y **E6**; sobrescribirlo destruiría la prueba que
> sostiene dos enmiendas vigentes. Tercera ronda consecutiva que se entrega en archivo propio.

---

## 1 · Veredicto

**RECHAZADO** — por **un** hallazgo, con una corrección acotada. Todo lo demás de esta tanda
está verificado y correcto, y **no debe rehacerse**.

**Lo que esta tanda consigue** (verificado ejecutando el código, con `develop` como control):

- **La condición de piloto (M1) está cerrada, y bien cerrada.** Inventé 6 fraseos nuevos,
  comprobados por `grep` como ausentes de su batería, y **los 6 devuelven el agregado
  correcto**. Ninguno sale "seguro y equivocado" — la línea roja del encargo. Los 4 fraseos de
  mi ronda 2 que fallaban ahora aciertan los 4.
- **El test canónico está repuesto de verdad** (`commandments.test.ts:300`): frase exacta,
  pipeline completo, y asserta que el resto de la oración sobrevive. La regex ahora caza
  demostrativo + verbo: mis 8 formas nuevas se reparan las 8.
- **No hay quinta violación de V11.** Audité el diff: **cero líneas eliminadas** en archivos de
  test, cero asertos cambiados, cero tests borrados. Todo aditivo. Es la primera tanda de la
  serie en la que esto ocurre, y merece registrarse.
- **Los tres menores cerrados** (cap §8, `tool_call` de un ítem, declaración de impacto como
  artefacto del repo) y **sin regresiones** en G1b, G1c, M3, M9, V12/V13, fronteras, dedup,
  testdev7 y el resto de la lista de O.4.

**Lo que lo bloquea:**

> **El Mandamiento 10 ahora borra prosa legítima del modelo.** La ampliación a demostrativo +
> verbo habilita también la rama que **elimina** la frase cuando no hay cifra que insertar, y
> `"Esta es…"` / `"Ese es…"` son la apertura de frase más común del idioma. Resultado: M10 edita
> respuestas que ninguna capa había tocado. Once frases de conversación normal — `"Esta es una buena pregunta."`,
> `"Ese es tu punto de partida, y es más de lo que crees."`, `"That is a fair question."`,
> `"Essa é uma boa pergunta."` — se **eliminan** de la respuesta. **8 de las 11 son regresión
> nueva**: en `develop` sobreviven intactas.

No viola G1b (ninguna cifra falsa se publica). Viola el **§13**, que es el criterio de éxito
medible del contrato: *"Tasa de intervención sobre **prosa**: 84% → ↓ tendencia a 0"*, con la
tesis explícita de que *"la naturalidad de monoend mejora **quitando** instrucciones"*. Esta
tanda mueve esa métrica en la dirección contraria, y lo hace justo sobre el registro que el
MAYOR 8 de la tanda anterior acababa de instalar en el prompt ("acompaña antes de dirigir").
Un turno de mala noticia con la frase de acompañamiento amputada es exactamente el tono
robótico que llevamos tres tandas desmontando.

Aplico el criterio del encargo: ante la duda, rechazar. La corrección es de una condición, no
de un rediseño — la tanda está a horas de aprobarse, no a un día.

Batería completa en verde: TypeScript limpio, 84/84 turnos de regresión, commandments 30→33,
scenario 185→198, tools 15→17. **Ninguna de las dos desviaciones que reporto la detecta esa
batería** — las dos salieron de frases que construí yo. Cuarta ronda consecutiva.

---

## 2 · Hallazgos priorizados

### 🔴 B1 · BLOQUEANTE — M10 borra prosa legítima que ninguna capa había tocado

`src/lib/guardrail/commandments.ts:404-425` (regex) · `:441-469` (`repararAnaforasSinAntecedente`) · `:591`

**Qué pasa.** `ANAFORA_SIN_ANTECEDENTE_RE` se amplía a demostrativo + (clítico) + verbo
copulativo/resultativo, en ES/PT/EN. `repararAnaforasSinAntecedente` recorre las frases y, si
una casa el patrón y no tiene dígitos, la **sustituye** por la cifra pedida (rama a) o la
**elimina** (rama b, cuando no hay concepto pedido y verificado que insertar). El problema no
es la ampliación: es que **nada comprueba que una capa anterior haya eliminado algo**. La
versión que rechacé en la ronda 1 sí lo exigía (`raw !== text`); el rediseño de la ronda 2
retiró esa guarda, y con la regex estrecha casi no se notaba. Con la regex ancha, se nota mucho.

**Medido con el pipeline completo** (`applyEnforcement`, `enforcement: "full"`), contra `develop`:

| RAW del modelo | `develop` | `agent/08` |
|---|---|---|
| `"Esta es una buena pregunta. Tus gastos mensuales son 2250 €."` | intacta | **`"Tus gastos mensuales son 2250 €."`** |
| `"Ese es exactamente el punto que quería tratar contigo. …"` | intacta | **frase borrada** |
| `"Este es el primer paso: ordenar lo que ya tienes. …"` | intacta | **frase borrada** |
| `"Te quedan 250 € al mes. Ese es tu punto de partida, y es más de lo que crees."` | intacta | **`"Te quedan 250 € al mes."`** |
| `"Te quedan 250 € al mes. Esta es la parte que sí puedes mover hoy."` | intacta | **`"Te quedan 250 € al mes."`** |
| `"That is a fair question. Your expenses are 2250 €."` | intacta | **frase borrada** |
| `"This is the first step you can take today. …"` | intacta | **frase borrada** |
| `"Essa é uma boa pergunta. As tuas despesas são 2250 €."` | intacta | **frase borrada** |
| `"Eso depende de lo que decidas priorizar. …"` | ya se borraba | se borra *(preexistente, `eso` desnudo)* |
| `"Eso sí, conviene no tocarlos."` | ya se borraba | se borra *(preexistente)* |
| `"Esa decisión es tuya, no mía. …"` | intacta | intacta *("decisión" no es verbo)* |

**8 de 11 son regresión nueva de esta tanda.**

**Causa raíz, aislada.** Ejecuté el caso 1 y miré el registro de mutaciones:

```
raw   : "Esta es una buena pregunta. Tus gastos mensuales son 2250 €."
final : "Tus gastos mensuales son 2250 €."
capas que mutaron: ["commandment_10/anáfora sin antecedente — cifra verificada reinsertada o frase eliminada"]
```

**M10 fue la única capa que tocó el texto.** El grounding no había quitado nada: no había
ninguna anáfora huérfana que reparar. M10 está reescribiendo salida sana.

**Por qué importa.** §13 fija como criterio de éxito medible que la intervención sobre prosa
tienda a 0 mientras la de cifras se mantiene; esto la sube. Y el registro que destruye —
demostrativo de apertura, frase de acompañamiento sin cifra— es literalmente el que el prompt
pide desde la tanda anterior (`consigliere.ts`, MAYOR 8: *"ACOMPAÑA antes de dirigir: reconoce
lo que cuesta, y solo entonces da el número"*). El sistema instruye al modelo a escribir esa
frase y después se la borra.

**El daño viene de UNA sola rama.** Antes de proponer nada medí qué llega a M10 en cada caso,
contando las mutaciones **previas** a M10:

| Caso | Mutaciones antes de M10 | Rama de M10 | Veredicto |
|---|---|---|---|
| Canónico `"Esa es tu capacidad real…"` · `{sobrante:250}` | **0** | (a) sustituye | correcto |
| QA real: `"…9.999 €… . Eso te deja margen."` | 1 (`grounding`) | (a) sustituye | correcto |
| Prosa sana `"Esta es una buena pregunta. …"` · pregunta sin concepto | **0** | **(b) elimina** | **el daño** |
| `"Te quedan 250 € al mes. Ese es tu punto de partida…"` · cifra ya presente | 0 | **(b) elimina** | **el daño** |

Esto **descarta** la corrección obvia —condicionar M10 a que una capa anterior haya eliminado
algo—: el caso canónico llega con **cero** mutaciones previas (el modelo escribió la frase rota
por sí solo, que es justo lo que pasó en el QA real), así que esa guarda lo desactivaría.

El discriminador real es **la fuerza de la señal anafórica**, y ya está en el propio código:

- **Demostrativo + SUSTANTIVO numérico** (`"esa cifra"`, `"ese monto"`) y `"eso"` desnudo son
  referencias inequívocas a una cifra. Si no hay ninguna verificada a la que anclarlas, la frase
  es basura → **eliminar es correcto** (es lo que fija su test `OBLIGATORIO 3`).
- **Demostrativo + VERBO** (`"Esa es…"`, `"Este queda…"`) es la ampliación de esta tanda y una
  señal **débil**: en español es la apertura de frase más común que existe. Sirve para saber
  dónde **insertar** una cifra que falta, no para decidir que la frase sobra.

**Corrección exigida (acotada).** Que la rama (b) —eliminación— siga aplicándose **solo** al
patrón fuerte (demostrativo + sustantivo numérico y `"eso"` desnudo, es decir la regex previa a
esta tanda); la ampliación demostrativo + verbo habilita **únicamente** la rama (a)
—sustitución por una cifra verificada—. Si no hay cifra que insertar, la frase se deja como
está. **No** hay que estrechar la regex ni revertir la ampliación: ambas son correctas y
necesarias para el caso canónico.

Verificado contra todos mis datos: con ese criterio se reparan el canónico, mis 8 formas nuevas
y las 3 que ya funcionaban; sobreviven intactas las 8 frases de prosa sana; y se sigue
eliminando `"Con ese monto podrás cerrar tu meta…"` sin cifra disponible (su `OBLIGATORIO 3`
queda en verde).

Tests que deben acompañar la corrección (hoy fallarían):
- RAW intacto `"Esta es una buena pregunta. Tus gastos mensuales son 2250 €."` con
  `conceptos = {gastos: 2250}` y pregunta sin concepto → **la respuesta no cambia**.
- `"Te quedan 250 € al mes. Ese es tu punto de partida, y es más de lo que crees."` con
  `{sobrante: 250}` → **la respuesta no cambia** (la cifra pedida ya está).
- El canónico (`commandments.test.ts:300`) y el `OBLIGATORIO 3` deben seguir en verde.

---

### 🟠 M1 · MAYOR — la regla estructural es golosa y destruye un gasto correctamente extraído

`src/lib/calculator/scenario.ts:624-654` (`detectarAgregadoEstructural`), en particular `:641`

La cifra del agregado se elige como **el último número entre la keyword de gasto y los dos
puntos**, sin comprobar si ese número ya fue reclamado por otro patrón declarativo (ingreso,
meta, crédito). Cuando el usuario menciona los gastos **antes** que otro campo, el detector se
lleva el número equivocado:

| Mensaje | `develop` | `agent/08` |
|---|---|---|
| `"gasto 1200 al mes y gano 2500: arriendo 800, comida 400"` | gastos **1200** ✅ · ingreso 2500 · `PARTIAL` | **gastos `undefined`** · agregado crudo = **2500** (el ingreso) · `AMBIGUOUS` |

El 2500 es el **ingreso**; tomado como agregado de gastos, choca con el detalle de 1200 y
dispara una discrepancia. El resultado es una **ambigüedad falsa**: se descarta un `gastos`
que el usuario había declarado explícitamente y bien parseado, y se le pregunta por una
contradicción que no existe. §13 fija *"Conflictos **falsos** por error de parseo: 0"*, y es
V1 en espíritu — un dato extraído con confianza acaba en `undefined`.

**Atenuante que lo mantiene en mayor y no en bloqueante:** el sistema **pregunta**, no afirma.
No hay "seguro y equivocado" — la línea roja del encargo no se cruza. Y en los otros dos
vectores de la misma familia el cambio es una **mejora** neta sobre `develop`:

| Mensaje | `develop` | `agent/08` |
|---|---|---|
| `"mis gastos son 1200 y quiero financiar un carro de 30000: cuota 700, seguro 100"` | gastos **31300** (basura, ítem `cuota = 30000`) | `undefined` + `AMBIGUOUS` — mejor |
| `"gasto en 12 meses: arriendo 800, comida 400"` | gastos **412** (basura, `arriendo = 12`) | `undefined` + `AMBIGUOUS` — mejor |

Y cuando la keyword de gasto va **después** del otro campo, todo funciona:
`"gano 2500 y mis gastos son 1200: …"` → ingreso 2500, gastos 1200, `COMPLETE` ✅;
`"quiero un piso de 200000 y gasto 1200: …"` → meta 200000, gastos 1200, `COMPLETE` ✅.

**Corrección recomendada:** al elegir el número del tramo, descartar los que caen dentro de un
rango ya reclamado por otro patrón declarativo (`rangosReclamados` ya existe para esto) y
quedarse con el último **no reclamado**. Si no queda ninguno, no disparar la regla estructural
y caer al respaldo.

---

### 🟡 m1 · MENOR — la sustitución de la anáfora no concuerda en género/número

`commandments.ts:464`. `"Esa cifra es la que necesitas."` → `"250 € es la que necesitas."`;
`"250 € representa tu capacidad anual"`, `"250 € basta para arrancar…"`. La cifra es correcta
y la frase se entiende, pero la concordancia se rompe. Ya lo anoté como R3 en la ronda 2 y la
ampliación lo hace más frecuente. Sugerencia: cuando la sustitución no produzca una oración
bien formada, preferir la rama (b).

### 🟡 m2 · MENOR — `"gasto 1200: internet 300"` deja el 300 huérfano

Una sola partida tras los dos puntos no valida la regla estructural (correcto: hace falta ≥2),
cae al respaldo, y el resultado es `gastos = 1200`, `gastos_items = []`, `PARTIAL` con el 300
como huérfano. V14 se cumple (el número tiene destino declarado) y el sistema pregunta, así que
no es un fallo — pero es asimétrico con el arreglo de `tools.ts:143-155`, donde un desglose de un
solo ítem **sí** se registra ahora. Convendría el mismo criterio en la ruta regex.

---

## 3 · Verificación del encargo (BLOQUE O)

### O.1 — regla estructural del agregado ✅

`scenario.ts:624-654` · invocada en `:921` con `GASTO_AGREGADO_DETALLE_RE` como respaldo.

**Mis 6 fraseos nuevos** (verificados con `grep -ril` como ausentes de `src/` y `scripts/`):

| # | Fraseo | Esperado | Obtenido | `status` |
|---|---|---|---|---|
| 1 | `"sumando todo, mis gastos llegan a 1350: renta 700, mercado 400, luz 250"` | 1350 | **1350** ✅ | `COMPLETE` |
| 2 | `"al final del mes he gastado unos 1750: hipoteca 950, comida 500, transporte 300"` | 1750 | **1750** ✅ | `COMPLETE` |
| 3 | `"mis gastos, redondeando, andan por 1150: casa 600, comida 350, agua 200"` | 1150 | **1150** ✅ | `COMPLETE` |
| 4 | `"cada mes se me van en gastos 1900: colegio 1000, super 600, gasolina 300"` | 1900 | **1900** ✅ | `COMPLETE` |
| 5 | `"gasto aproximadamente 1050 mensuales, repartidos así: luz 350, agua 350, gas 350"` | 1050 | **1050** ✅ | `COMPLETE` |
| 6 | `"mis gastos fijos suman 1400: arriendo 800, seguro 350, internet 250"` | 1400 | **1400** ✅ | `COMPLETE` |

**Ninguno "seguro y equivocado".** En los 6, además, el desglose sale con las 3 partidas
correctas y su importe propio.

**Mis 4 de la ronda 2** — los 4 arreglados: 1000 ✅ · 900 ✅ · 1500 ✅ · 2000 ✅.
**Los 4 conocidos** — 1200 ✅ · 1200 ✅ · 950 ✅ · 1800 ✅.

**Vectores de falso positivo** que construí: 1 regresión (M1 arriba), 2 mejoras, y los
controles correctos — `"en los últimos 3 meses gasté 1200: …"` → 1200 ✅ (el plazo no se
confunde), `"tengo 43 años y gasto 1200: …"` → 1200 ✅, `"mis gastos fueron 1200: no sé bien en
qué"` → sin desglose ✅ (su propio test), `"Alquiler: 700, Comida: 450, Luz: 120"` → 1270 sin
agregado declarado ✅ (la regla no se dispara sin keyword de gasto).

### O.2 — test canónico repuesto y auditoría de V11 ✅

`commandments.test.ts:300-319`. Frase **exacta**, `applyEnforcement` (pipeline completo, `raw`
es el primer argumento posicional, `userMessage` explícito), y dos asertos: que aparece el 250
y que **solo** se sustituye el demostrativo (`/250\s*€\s+es\s+tu\s+capacidad\s+real/i`). Pasa.

Cobertura de demostrativo + verbo, medida con el pipeline completo:

| Grupo | Resultado |
|---|---|
| Las 8 formas de mi ronda 2 (redacción exacta) | **6/8 reparadas** (antes 3/8). Las 2 restantes — `"Es lo que te queda…"`, `"Ahí tienes tu margen mensual."` — no llevan demostrativo; AG08 las declara fuera de alcance y es correcto |
| **8 formas nuevas mías** (`"Ese sería…"`, `"Esta representa…"`, `"Eso significa…"`, `"Esa te permite…"`, `"Este queda…"`, `"Esa equivale…"`, `"Ese cubre…"`, `"Esta basta…"`) | **8/8 reparadas** ✅ |

**Auditoría de tests eliminados o debilitados — limpia.** `git diff` sobre `*.test.ts` no
contiene **ni una sola línea eliminada**: cero tests borrados, cero asertos cambiados. La única
modificación declarada (el fixture `estado` gana `gastos_items_colapsados: 2`) es una línea
**añadida**, exigida por un test exhaustivo que itera `CAMPOS_HECHOS`. **No hay quinta
violación de V11.**

### O.3 — menores ✅

| Menor | Estado |
|---|---|
| Cap de `gastos_items` (§8, máx 5) | ✅ `scenario.ts:1904-1937`. Con 8 versiones de la misma partida: máx 5 por nombre, el **activo** es siempre el más reciente (970), un solo activo por nombre, `gastos_items_colapsados = 6`, suma de activos = `gastos_mensuales`, y el campo nuevo **sobrevive el viaje a BD** (V9) |
| `tool_call` de un solo ítem | ✅ `tools.ts:143-155`. `netflix 15` se registra en `gastos_items` con `source: "tool"`, **sin** fijar `gastos_es_detalle`/`gastos_detalle` (la clasificación agregada sigue exigiendo ≥2), `tiene_detalle_gastos` true por posesión, y acumula si llegan más partidas después |
| Declaración de impacto como artefacto | ✅ `docs/informes/CORRECCIONES_AG08_regla_estructural_agregado_y_anafora.md`, 224 líneas, con tabla función-por-función. La contrasté contra el diff real: **coincide**, incluidos los dos cambios de test, que declara y justifica |

### O.4 — sin regresiones ✅

| Verificación | Resultado |
|---|---|
| **G1b** — el déficit fantasma no vuelve | ✅ los 3 vectores decisivos publican `"Tomo nota. Seguimos con tu plan."` / `"¿Confirmamos el plan?"`, sin `9500` ni `9.999` |
| **M3** intacto con pipeline completo | ✅ sigue eliminando el déficit fantasma, también con la pregunta por el sobrante |
| **M9** intacto | ✅ el plan fantasma con cifras no trazables no se publica |
| **G1c** bidireccional | ✅ `[2200, 2250, 50]` idéntico en ambos sentidos |
| **V13** fronteras posicionales | ✅ `expenses.ts:249` `interface Rango {start,end}` — rangos, no set de strings. Independencia de orden: 1090 / 1090 |
| **V14** conservación · `extraction_status` nunca `undefined` | ✅ en ~45 mensajes |
| **V12** el ingreso nunca como ítem | ✅ testdev7 con ingreso 2500 |
| `"gasto 2 500 €"` → 2500 | ✅ |
| 15 partidas de testdev7 | ✅ 15 ítems, suma 2250, conflicto 2200/2250 |
| Dedup testdev8 (5, no 11) | ✅ 5 ítems, sin `"fueron"`, `arriendo = 900`, suma ítems = buckets = 2200 |
| **B2** (bloque coherente, ronda 2) | ✅ sigue cerrado: gastos 1550, sobrante 1450 |
| Cuota derivada del estado, sesión nueva | ✅ 881,25 sin datos nuevos, `cuota` fuera de `missing` |
| Desglose sin confirmar | ✅ recorte bloqueado, sobrante 250 disponible |
| Detector de pegado | ✅ hipoteca 1200 entre gastos de 40-60 no se marca · caso 9 (`60 100`) sigue `AMBIGUOUS` con el ítem expuesto |

---

## 4 · Tabla de invariantes

| # | Invariante | Estado | Evidencia |
|---|---|---|---|
| **V1** | Un dato con confianza no se descarta | ⚠️ **en espíritu, violado en un caso** | `"gasto 1200 al mes y gano 2500: …"` deja `gastos` en `undefined` por una discrepancia falsa — ver M1 |
| **V5** | Nada inferido por el LLM entra en `conceptos` | ✅ verificado | M10 solo escribe valores de `conceptos`; ningún vector publica una cifra ausente del mapa |
| **V8** | El cero se rechaza como placeholder | ✅ verificado | `agregado <= 0` descarta el candidato en la regla estructural; caso 17 intacto |
| **V9** | El estado sobrevive re-lectura desde BD | ✅ verificado | Incluido el campo nuevo `gastos_items_colapsados` |
| **V10** | `raw !== final` ⟹ ≥1 mutación | ✅ verificado | M10 registra vía `anotar`; el borrado de prosa **queda auditado** (que es como lo detecté) |
| **V11** | Prohibido reescribir un test para que afirme lo contrario | ✅ **respetado por primera vez en la serie** | Cero líneas eliminadas en `*.test.ts`; el canónico **repuesto**, no sustituido |
| **V12** | El ingreso nunca como ítem de gasto | ✅ verificado | testdev7 |
| **V13** | Token reclamado = frontera con offsets | ✅ verificado | Independencia de orden byte a byte |
| **V14** | Conservación · `extraction_status` nunca `undefined` | ✅ verificado | ~45 mensajes |
| **V15** | Atribución correcta | ✅ **cerrada para el fraseo con palabras intermedias** | 6/6 fraseos nuevos + 4/4 de la ronda 2 + 4/4 conocidos. Queda el caso de M1 (número de otro campo dentro del tramo) |
| **V16** | No doble conteo | ✅ verificado | La regla estructural elimina el doble conteo en los 14 fraseos probados |
| **V17** *(ronda 1)* | Ninguna capa de reparación reintroduce una cifra eliminada | ✅ verificado | M10 no lee `ctx.raw` |
| **V18** *(ronda 1)* | El bloque de datos verificados es internamente consistente | ✅ verificado | Rederivación + guarda bloqueante siguen en pie |
| — | §13 · intervención sobre **prosa** → 0 | ❌ **violado** | M10 interviene sobre prosa intacta — ver B1 |
| — | §13 · conflictos **falsos** por parseo = 0 | ⚠️ **1 caso** | Ver M1 |
| — | `scenario_state` · `response_telemetry` · `runGuardrail` · `persistTurn` | ✅ verificado | `route.static.test.ts` en verde; `pipeline.ts` no se toca en este diff |
| — | `llm.ts` NO tocado (dominio AG01) | ✅ verificado | ausente del diff |
| — | Tabla de puntos del ICA no redefinida (dominio AG06) | ✅ verificado | ausente del diff |
| — | Umbral 50× · `meta.monto` · V12 sin cambios | ✅ verificado | `meta.monto` correcto en los dos mensajes de control |
| — | Sin reconciliación/CONFLICT/ASSUMED **nuevos** (BLOQUE C) | ✅ verificado | El diff no toca `reconciliarGastos` ni la máquina de estados |
| — | Eco sin plantilla (BLOQUE G) | ✅ verificado | `renderDatosRecienEntendidos` no se toca en este diff |
| — | Migración (BLOQUE F) | **no aplica** | El diff no toca `supabase/`. `gastos_items_colapsados` vive dentro del jsonb existente — sin DDL |
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
| 15 | `"Alquiler: 700, Comida: 450, Luz: 120"` | sí | sí | ✅ 3 ítems, 1270, **sin** agregado declarado |
| 16 | 15 partidas de testdev7 | sí | sí | ✅ 15 ítems, 2250, buckets coherentes |
| 17 | Crédito con monto sin plazo | sí | sí | ✅ plazo nunca 0 |
| E5-24 | `"gasto aproximadamente 2000 entre vivienda, comida"` | sí | sí | ✅ 2000, `gastos_items` vacío |
| extra | Desglose sin confirmar: sin recorte, con sobrante | sí | sí | ✅ |
| I.1 | Fronteras como rangos `[start,end)` | sí | sí | ✅ `expenses.ts:249` |
| I.2 | Los 3 mensajes del bloqueante | sí | sí | ✅ 1200 · 1090 · idéntico |
| L 1-6 | V15/V16 | sí | sí | ✅ los 6 |

---

## 5 · Riesgos latentes

**R1 — M10 se ha convertido en un editor de estilo.** Desde que dejó de exigir que algo se
hubiera eliminado, actúa sobre cualquier respuesta. Aunque se aplique la corrección de B1, la
dirección de diseño merece una decisión explícita: **la capa de mandamientos es una red de
seguridad sobre cifras, no un corrector de prosa.** Cada ampliación de una regex de lenguaje
natural en esa capa multiplica la superficie de falsos positivos sobre texto que el modelo
escribió bien. La alternativa arquitectónica —dejar la reparación al reintento acotado de
`route.ts`, que ya comparte `cifraPedidaAusente`— es más cara en latencia pero no puede borrar
prosa correcta.

**R2 — la regla estructural depende de `parseExpenseList` como validador.** Es su mayor
acierto (el validador es el éxito del parseo, no una lista de palabras) y también su
acoplamiento: cualquier cambio futuro en el parser de listas mueve, de forma no obvia, qué
mensajes se reconocen como "agregado + desglose". Merece un test que fije explícitamente el
contrato entre las dos piezas.

**R3 — asimetría regex/tool en el desglose de un ítem.** `tools.ts` ya conserva la partida
única; la ruta regex la deja como huérfano (m2). Dos criterios distintos para el mismo hecho
del usuario.

**R4 — `gastos_items_colapsados` es un contador sin consumidor.** Se persiste y sobrevive a la
BD, pero nada lo lee todavía. Igual que su hermano `gastos_superseded_colapsados`, conviene que
entre en la revisión nocturna de telemetría o quedará como dato muerto.

---

## 6 · Recomendación a Luis

**Devolver a AG08 — con una única corrección obligatoria.** No es una tanda para rehacer: es
una tanda a la que le falta una guarda.

Quiero ser explícito en esto, porque el trabajo es bueno: la condición de piloto que llevaba
dos rondas abierta está **cerrada y verificada con fraseos que AG08 no podía anticipar**, el
test canónico está repuesto en lugar de sustituido, y por primera vez en la serie el diff no
elimina ni debilita un solo test. Eso hay que registrarlo, no solo lo que falta.

### Obligatorio antes de un nuevo PR

1. **B1 — limitar la rama de ELIMINACIÓN de M10 al patrón anafórico fuerte** (demostrativo +
   sustantivo numérico y `"eso"` desnudo). La ampliación demostrativo + verbo de esta tanda
   debe habilitar **solo** la sustitución por una cifra verificada; si no hay cifra que
   insertar, la frase se deja intacta. **No estrechar la regex ni revertir la ampliación.**
   Con los dos tests de no-intervención que detallo en B1, y el canónico y el `OBLIGATORIO 3`
   siguiendo en verde.

   *(Descarto explícitamente la corrección aparentemente obvia —exigir que una capa anterior
   haya mutado el texto—: medí que el caso canónico llega a M10 con cero mutaciones previas, así
   que esa guarda lo desactivaría. El detalle de la medición está en B1.)*

### Recomendado en la misma tanda (barato, evita otra vuelta)

2. **M1 — descartar en `detectarAgregadoEstructural` los números ya reclamados por otro patrón
   declarativo** y quedarse con el último no reclamado; si no queda ninguno, caer al respaldo.
   Con `"gasto 1200 al mes y gano 2500: arriendo 800, comida 400"` → gastos 1200, ingreso 2500,
   como test.

### Deuda registrada, sin bloquear

3. **m1** — concordancia de la sustitución, o preferir la eliminación cuando no concuerde.
4. **m2** — mismo criterio que `tools.ts` para el desglose de una sola partida por regex.
5. **R2** — test de contrato entre la regla estructural y `parseExpenseList`.
6. **R4** — dar consumidor a `gastos_items_colapsados`.

### Enmiendas al contrato pendientes

- **V17** y **V18**, propuestas en la ronda 1, implementadas y verificadas en la ronda 2 y
  **estables en esta**. Siguen sin incorporarse a §9. Tercera tanda que arrastran; procede
  cerrarlas ya, según la nota de proceso de E7+E8.
- **E9** puede darse por cerrada en su parte de M1: la regla estructural sustituye la
  enumeración de conectores y supera 14 fraseos, 10 de ellos ajenos a la batería del
  implementador. Conviene registrar la regla nueva en el cuerpo del contrato (§5.3), porque hoy
  §5.3 sigue describiendo solo el parser numérico.

---

*Revisión ejecutada sobre `origin/agent/08` (`8d6adad`) en worktree aislado, con `origin/develop`
(`358c729`) como control para separar regresión de defecto preexistente. Ningún código de AG08
fue modificado; esta entrega es solo el informe.*
