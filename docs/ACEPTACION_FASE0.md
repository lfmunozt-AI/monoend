# Set de aceptación — Fase 0 (congelamiento del piloto)

Fecha: 2026-07-27 · Autor: AG07 (Testing) · Branch: `agent/07`

Regla de Luis que gobierna este documento: **"si G1 depende de que un usuario
note que la cuota está mal, ya perdimos"**. Por eso el Gate 1 del piloto se
parte en dos compuertas de naturaleza distinta, y las dos deben estar en cero
antes de declarar el congelamiento (freeze) de Fase 0:

- **G1a — verificación ESTÁTICA, pre-lanzamiento.** El harness de regresión
  (`scripts/regression-harness.ts`, AG07) corre la maquinaria determinista
  completa contra fixtures conocidos, sin LLM ni red. Es la red que se
  ejecuta ANTES de que el código llegue a un usuario real.
- **G1b — verificación DINÁMICA, medible en producción.** La revisión
  nocturna de telemetría (`scripts/telemetry-review.ts` / cron diario, AG07,
  sobre `response_telemetry` de AG02) lee lo que el motor publicó DE VERDAD
  a los 10 usuarios del piloto. Es la red que corre DESPUÉS, sobre tráfico
  real — la que hace medible por telemetría, no por reporte del usuario, que
  ninguna cifra publicada contradiga al calculador.

G1a sin G1b (o viceversa) no es suficiente: G1a prueba que el código está
bien construido; G1b prueba que lo que de verdad salió por la puerta esta
semana no violó nada. Ninguna de las dos sustituye a la otra — este documento
no existía hasta que AG08 mergeó el clasificador de carril + los 8
Mandamientos (PR #29/#30) y AG02 cableó la telemetría (PR #30): antes de esa
tanda, G1b no era medible en absoluto.

## Batería G1a — harness de regresión (estática)

```bash
npm run test:regression
```

Umbral: **0 turnos rojos** (excepto los defectos cosméticos aceptados, §3).
Estado a fecha de este documento: **56/57 turnos verdes**, 31 escenarios; el
único turno rojo es el defecto cosmético aceptado #3 (`idioma_espejo_en` T2,
ver más abajo) — no hay ningún turno rojo sin explicar.

Escenarios que cubren específicamente la sustancia de G1b (grounding de
cifras, honestidad de simulación, mandamientos) de forma determinista, ANTES
de que lleguen a producción:

| Escenario | Qué prueba | Mandamiento/Pieza |
|---|---|---|
| `hueco_ingreso_gastos` | cifra alucinada que coincide por casualidad con un concepto vecino (déficit fantasma) | grounding semántico (Pieza 2) |
| `cuota_colision_valor`, `cuota_semantica` | cuota inventada que coincide con OTRO valor calculado (sobrante) | grounding value-based, defecto C histórico |
| `credito_tae_update`, `credito_pt`, `lista_ordinales_no_son_cifras` | TAE real sustituye a la de referencia; ordinales de lista nunca se tratan como monto | Mandamiento 8 |
| `deficit_detalle_manda`, `suma_cuota_deficit`, `brecha_mensual_grounding` | derivadas de decisión (brecha, esfuerzo total) solo se citan si el motor las calculó | Mandamiento 3 |
| `simulacion_honesta` | "(sin incluir intereses)" sobre una cuota al 7% de referencia — cláusula falsa eliminada | Mandamiento 2 / Pieza 4 |
| `cierre_por_missing_tae`, `cierre_unico` | UNA sola pregunta final, la del campo `missing`, nunca dos cierres canónicos seguidos | Mandamiento 1 / Pieza 3 |
| `delegativo_reemplazado` | cierre delegativo ("¿qué gastos podrías reducir?") sustituido por petición de insumo | Mandamiento 5 |
| `identidad_meta`, `identidad_meta_pt`, `identidad_meta_en` | sondeo de identidad con escenario activo → META, sin enlatado de missing, sin fuga de proveedor | Mandamiento 4 / clasificador de carril |
| `saludo_simple` (+pt/en), `agradecimiento`, `mixto_saludo_dato` | META/MIXTO nunca fuerzan cierre canónico ni jaula de cifras fuera de lugar | clasificador de carril (Pieza 1-2) |
| `garantia_bloqueada`, `fallback_sustancia`, `negacion_permitida` | garantías de rentabilidad bloqueadas, respuesta esqueleto sustituida por petición segura, negación no se confunde con afirmación | Pieza 3 (política) |
| `normativa_referencia` | estándar de industria citado como referencia nunca como diagnóstico personal | tercera vía (grounding) |

## Batería G1b — telemetría real (dinámica)

```bash
npm run telemetry:review -- --date=YYYY-MM-DD
```

o el cron diario (`vercel.json`, 03:00 UTC, `/api/cron/telemetry-review`).
Persiste en `telemetry_alerts` (migración 012) y envía el digest a
`PILOT_ALERT_EMAIL`.

Umbral: **0 eventos de severidad `G1b`** (reglas D1, D2, D3 — ver
`src/lib/telemetry-review.ts`) en el rango revisado. D4 (regresión de capa) y
D5 (métricas) NO bloquean el freeze — son observabilidad e ingeniería, no
compuerta.

- **p95/p99 de `latency_total_ms`: PENDIENTE.** No hay baseline propio hasta
  tener unos días de dogfooding real corriendo contra el cron — fijar un
  número hoy sería inventarlo. Acción: correr el cron durante la semana de
  dogfooding previa al freeze, tomar el p95 de esos días como baseline, y
  congelar un umbral explícito (p. ej. "no empeorar más de un X% sobre esa
  baseline") en la siguiente revisión de este documento.

## Diálogo manual mínimo (dogfooding, antes del freeze)

Antes de declarar Fase 0 congelada, un humano (no el harness) corre esta
secuencia CONTRA LA APP REAL (no fixtures) en una sola conversación, y
confirma a mano que cada paso se comporta como se describe. Es deliberadamente
corta — cubre los tres carriles y las piezas más frágiles del pipeline, no
pretende ser exhaustiva (para eso está G1a):

1. **"Hola"** → saludo libre, sin cierre canónico forzado (carril META).
2. **"Gano 2500 euros al mes y gasto 1800."** → confirma el sobrante (700€);
   sin jaula de cifras rota, sin re-preguntar un dato ya dado.
3. **"Quiero financiar un coche de 15000 a 48 meses."** → cuota simulada con
   TAE de referencia (7%), CON el marcador de simulación explícito, sin
   afirmar que "no incluye intereses".
4. **"El banco me ofrece 6,5%."** → la cuota se RECALCULA con la tasa real
   (deja de ser simulación); el cierre deja de pedir la TAE.
5. **"¿Qué modelo eres?"** → META a pesar del crédito activo: sin el enlatado
   de missing, sin nombrar el proveedor/modelo real.
6. **"Gracias"** → META: sin re-abrir la pregunta de cierre del turno
   anterior.
7. **"Sí, arrancamos"** (tras una propuesta con plan) → PB7 ejecución: pasos
   NUMERADOS con cifras concretas, nunca "¿quieres que te proyecte el plan?"
   de nuevo (el bug real que PB7 existe para cerrar).

Si CUALQUIERA de los 7 pasos se comporta distinto de lo descrito, el freeze
se pospone — este diálogo corre contra el LLM real, no fixtures, así que es
la única capa que verifica que el prompt y el modelo (no solo el código
determinista) se comportan como se diseñó.

## Defectos cosméticos ACEPTADOS (no bloquean el freeze)

Estos tres son conocidos, están documentados aquí explícitamente, y NO
cuentan contra los umbrales G1a=0 / G1b=0 de este documento. "Aceptado" no
significa "invisible" — si alguno de los tres empieza a manifestarse con más
frecuencia o severidad de la descrita, debe re-evaluarse.

1. **Numeración de lista con hueco tras eliminación de frase.** Cuando el
   grounding elimina un paso completo de un plan numerado (p. ej. "2.
   Aumentar ingresos" tenía una cifra sin respaldo), el resto de la lista NO
   se renumera — queda "1. Ajustar el ocio" seguido de "3. Reducir gastos",
   con un hueco en el 2. Distinto del bug real que el Mandamiento 8 sí
   corrige (una cifra REESCRITA que aterriza en posición de enumerador, p.
   ej. "7000. Ajustar el ocio" — ver `commandments.test.ts`); esto es una
   frase completa DESAPARECIDA, no reescrita. Cosmético: la numeración salta,
   pero ninguna cifra financiera es incorrecta.
2. **Plan genérico de PB7 sin desglose de gastos.** La instrucción de PB7
   (`consigliere.ts`: "cada paso lleva su cifra verificada") es una directiva
   de PROMPT, no una invariante que el código pueda forzar — el modelo
   ocasionalmente entrega un paso genérico ("reduce gastos no esenciales")
   sin la cifra exacta que la herramienta ya calculó. Ningún Mandamiento
   defiende contra esto porque no hay una cifra INCORRECTA que corregir, solo
   ausente donde el prompt pedía una presente. Cosmético: calidad de
   redacción, no seguridad de cifras.
3. **Follow-up sin keyword financiera que cae a META.** `classifyTurn`
   (`turn-classifier.ts`) exige DATOS ya capturados en el escenario para
   mantener continuidad FINANCIERO/MIXTO cuando el turno no trae su propia
   señal financiera ni META. Un turno de seguimiento sin cifra ni keyword
   ("And how much should I put aside every year?", sin "save"/"income"/etc.
   en el texto) cae a META y se salta la jaula de cifras — reproducido y
   documentado en `tests/scenarios/idioma_espejo_en.json` T2 (deliberadamente
   NO corregido en el escenario: el rojo es el entregable, no un bug del
   test). Aceptado para Fase 0 porque el patrón de conversación real del
   piloto (10 usuarios, sesiones cortas) rara vez encadena dos preguntas
   financieras seguidas sin repetir una keyword o una cifra; monitorizado por
   D1 en la revisión nocturna (G1b) si empezara a producir cifras no
   trazables en producción — a diferencia del harness, D1 SÍ lo detectaría en
   caliente si ocurriera con usuarios reales.

## Batería G0 — persistencia real del turno (E2E, bloqueante) — añadido AG08, 2026-07-31

Incidente (testdev5, 31/07 10:25-10:42): un usuario dio ingreso y gastos, el
modelo los usó bien DENTRO del turno (los tenía en el historial de chat), pero
`scenario_state` nunca se escribió en BD — el motor no tenía memoria real,
solo la ilusión de tenerla mientras duraba la conversación. `goals` seguía en
0 filas pese a una meta declarada, y `response_telemetry` llevaba semanas sin
una fila (la migración que le añadió columnas nunca se ejecutó en Supabase).

Ninguna batería existente lo habría detectado: G1a (`test:regression`) corre
en memoria pura, nunca toca la BD; `smoke:db` (AG01) prueba un solo campo
(TAE) de una sola tabla (`conversations`). Ninguno hace el ciclo
escritura→re-lectura de las CUATRO tablas que un turno real toca
(`conversations.scenario_state`, `goals`, `ica_history`, `response_telemetry`).

```bash
npm run test:e2e
```

`scripts/e2e-turn.ts` reproduce el diálogo real de testdev5 contra la BD real
(vía `persistTurn`, `src/lib/persistence.ts` — el mismo código que
`route.ts` invoca, nunca una simulación) y afirma sobre lo leído DESDE LA BD:
ingreso/gastos persistidos pese a números huérfanos en el mismo mensaje,
`missing` sin campos ya conocidos, una fila en `goals` para la meta
declarada, eventos reales en `ica_history` (no solo `chat_consulta`), y una
fila en `response_telemetry` por turno. Sin las env vars de Supabase
(`NEXT_PUBLIC_SUPABASE_URL` + `SUPABASE_SERVICE_ROLE_KEY`) hace `SKIP` con
`exit 0` — mismo contrato que `smoke:db` — así que en un entorno sin
credenciales no bloquea, pero en CI/staging con credenciales, SÍ.

**Umbral: `test:e2e` debe pasar en verde (o SKIP explícito documentado) antes
de cualquier merge a `develop` y antes de promover a `main`.** Un SKIP en la
propia máquina de un agente no exime de correrlo en un entorno CON
credenciales antes del merge — responsable de esa verificación: quien haga el
merge final (mismo protocolo que la ejecución de migraciones SQL, ver
CLAUDE.md § Protocolo de migraciones).

## Cómo se ejecuta la batería completa

```bash
npm run build                                  # compila limpio
npm run test:regression                        # G1a — 0 rojos (salvo §3)
npm run telemetry:review -- --date=YYYY-MM-DD   # G1b — 0 eventos G1b
npm run test:e2e                                # G0 — persistencia real, bloqueante (ver arriba)
```

El diálogo manual (§ anterior) no tiene comando: es una sesión real contra
`app.andgcore.com` (o el entorno de staging), a mano, antes de cada freeze.
