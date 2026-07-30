# AG08 — "Bloquear lo falso sin sustituir lo bueno"

> Autor: AG08 (The Consigliere) · 2026-07-30
> Base: `origin/develop` @ c8864a7 · Rama: `agent/08`
> Diagnóstico de partida: telemetría real (`response_telemetry`, 27 turnos).

---

## 1. El problema, medido

De **27 turnos**, **13 (48%)** tuvieron su texto MODIFICADO por nuestras capas de
enforcement. Tres casos verificados **ejecutando el código de `develop`** sobre
los textos reales (no inferidos):

| Caso | Estado del motor | Lo que escribió el modelo | Lo que publicamos |
|---|---|---|---|
| **A** 21:03:40 | `missing` VACÍO; ingreso 2300, gastos 1750, sobrante 550, cuota 248,85, plazo 48, TAE 9 | "Movimiento registrado. … ¿Quieres que te prepare un recordatorio mensual para la cuota?" (211 chars) | "Para darte una cifra exacta necesito un dato concreto — ¿me compartes tus ingresos y gastos mensuales?" · `mutations: []` |
| **B** 20:55:55 | ídem | resolvió la digresión ("¿qué temperatura hace?") y volvió a la meta | la misma plantilla |
| **C** 21:02:58 | crédito con `plazo=48` | "Reserva de Imprevistos … al menos **3 meses** de gastos" | "… al menos **48 meses** de gastos" |

**Causas raíz confirmadas en código:**

1. `ensureSubstance` juzgaba "esqueleto" toda respuesta sin cifras y <220 chars
   (A tenía 211) y la sustituía por `safeAsk`/`SAFE_GENERIC`. Un turno
   conversacional natural (confirmar, proponer, redirigir) no lleva cifras y es
   corto → se destruía **siempre**.
2. El rol posicional `plazo` ("`<CIFRA>` meses") se aplicaba en cualquier frase,
   incluida una sobre Reserva de Imprevistos → corrección al plazo del crédito.
3. `ensureSubstance` no registraba nada en `mutations[]` → el Caso A es invisible
   para The Commandments, para la telemetría y para cualquier auditoría.
4. Detalle relevante del Caso B: "¿qué temperatura hace?" no trae señal
   financiera ni META, así que `classifyTurn` lo manda a **FINANCIERO por
   continuidad** — por eso `ensureSubstance` llegó a ejecutarse sobre una
   digresión.

---

## 2. Qué cambia

| Pieza | Cambio | Dónde |
|---|---|---|
| 1 | `ENFORCEMENT_MODE` = `full` \| `minimal` (default `full`), registrado por turno en telemetría | `guardrail/enforcement.ts`, `.env.example`, migración `015` |
| 2 | `ensureSubstance` pasa a último recurso; con `missing` vacío **no puede pedir datos** | `guardrail/policy.ts` |
| 3 | La sustitución de `plazo` exige keyword de crédito **en la misma frase** | `guardrail/validate.ts` |
| 4 | El cierre **solo añade**; la pregunta del modelo queda intacta | `guardrail/policy.ts` |
| 5 | Registro COMPLETO de mutaciones + invariante de auditoría | `guardrail/pipeline.ts` (nuevo) |
| 6 | Meta activa única con transición explícita + `goals_cerradas[]` | `calculator/scenario.ts` |
| 7 | `digresiones_seguidas` + nota de reconducción al 3.º turno | `calculator/scenario.ts`, `route.ts` |
| 8 | Bloque de conducta (reconocer progreso, variar fraseo, origen de cada cifra) | `prompts/consigliere.ts` |

La cadena de enforcement deja de estar duplicada dentro de `route.ts`: vive en
`applyEnforcement()` (`guardrail/pipeline.ts`), donde **cada paso que cambia el
texto anota su mutación**. Invariante verificada en test:
`raw !== final ⇒ mutations.length > 0`.

---

## 3. Los tres casos, antes / después (`npm run cases:enforcement`)

| Caso | ANTES (develop) | DESPUÉS `full` | DESPUÉS `minimal` |
|---|---|---|---|
| A | plantilla pidiendo ingresos/gastos ya conocidos | **INTACTO**, 0 mutaciones | **INTACTO**, 0 mutaciones |
| B | la misma plantilla | **INTACTO**, 0 mutaciones | **INTACTO**, 0 mutaciones |
| C | "48 meses de gastos" | **INTACTO** ("3 meses"), 0 mutaciones | **INTACTO**, 0 mutaciones |

---

## 4. Modo `minimal`: qué cambia respecto a `full`

`npm run test:regression` → **62/62 OK** en `full`.
`npm run test:regression:minimal` → **8/62 turnos cambian**, todos en la
dirección esperada (menos intervención). **Cero fallos de `expectNotContains`,
`expectConcept` o `expectBlocked`: ninguna cifra falsa aparece en minimal.**

| Escenario | Diferencia en `minimal` |
|---|---|
| `cierre_por_missing_tae` (T2) | no se añade "¿Qué TAE te ofrece tu banco?" |
| `cierre_unico` | ídem |
| `simulacion_honesta` | ídem |
| `delegativo_reemplazado` | se elimina la delegación pero no se añade el cierre de insumo |
| `credito_monto_vs_cuota` (T2) | la cuota citada como monto **se elimina** en vez de reescribirse a 30000 → respuesta vacía |
| `credito_objeto_de_compra` (T2) | ídem |
| `idioma_espejo_en` (T1, T2) | sin `ensureSubstance`, la respuesta bloqueada queda vacía en vez de pedir el ingreso |

**Lectura:** `minimal` nunca fabrica cifras, pero pierde dos rescates útiles —
la corrección posicional del monto (que sí es inequívoca) y la petición del dato
que falta cuando la respuesta se vacía entera. Recomendación para el piloto:
mantener `full` en producción y usar `minimal` como brazo B de comparación sobre
`response_telemetry.enforcement_mode`.

---

## 5. Validación

| Comando | Resultado |
|---|---|
| `npm run build` | ✅ (requiere env de Supabase; sin `.env.local` falla el prerender de `/login` — **idéntico en `develop`**) |
| `npm test` | ✅ 130 |
| `npm run test:guardrail` | ✅ 202 (26 nuevos) |
| `npm run test:calculator` | ✅ 114 (12 nuevos) |
| `npm run test:regression` | ✅ 62/62 (`full`) |
| `npm run test:regression:minimal` | ⚠ 8 diferencias documentadas arriba |
| `npm run smoke:db` | SKIPPED (sin env en el worktree) |

---

## 6. Pendiente / fuera de alcance

- **Migración `015_enforcement_mode.sql` sin ejecutar en Supabase.** Hasta que se
  aplique, el insert de telemetría fallará por columna inexistente — y
  `logResponseTelemetry` **nunca lanza**, así que el chat no se ve afectado, pero
  se pierde la fila. Ejecutarla antes de desplegar (protocolo de migraciones,
  CLAUDE.md).
- El harness de regresión sigue sin ejecutar The Commandments (replica los pasos
  6-12 del route, no el 13). La cadena completa sí se testea en
  `enforcement.test.ts` vía `applyEnforcement`.
- `classifyTurn` manda a FINANCIERO cualquier turno sin señal propia cuando hay
  escenario activo (§1.4). No se ha tocado: la PIEZA 7 lo resuelve mirando el
  mensaje, no reclasificando.
