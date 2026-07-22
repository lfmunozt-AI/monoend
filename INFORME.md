# INFORME AG02 — Pattern Architect

Fecha: 2026-05-26
Worktree: `wt-ag02-datos` · Branch: `agent/02`

## Output entregado

1. `supabase/migrations/007_goals_table.sql`
2. `supabase/migrations/008_idf_function.sql`

## Decisión de numeración

El prompt original pedía `005_goals_table.sql` y `006_idf_function.sql`,
pero esos números ya están ocupados en la rama `agent/02`:

- `005_ica_trigger.sql` (AG06, en producción)
- `006_embeddings_search.sql` (AG01, en producción)

Sobreescribirlos hubiera roto el trigger ICA y la función `match_embeddings()`.
Usé los siguientes números libres (007, 008), consistente con la entrada del
backlog en CLAUDE.md: `Migración 007_goals_idf.sql ← pendiente`.

## Tabla `goals` (007)

Columnas exactas según spec:

| columna | tipo | constraint |
|---|---|---|
| id | uuid | PK, default `gen_random_uuid()` |
| user_id | uuid | NOT NULL, FK `auth.users` ON DELETE CASCADE |
| title | text | NOT NULL |
| target_amount | numeric(12,2) | NOT NULL, CHECK > 0 |
| target_date | date | NOT NULL |
| category | text | NOT NULL, CHECK in 9 valores |
| status | text | NOT NULL, default `'active'`, CHECK in 4 valores |
| baseline_data | jsonb | NOT NULL, default `'{}'::jsonb` |
| created_at | timestamptz | NOT NULL, default `now()` |
| updated_at | timestamptz | NOT NULL, default `now()` |

- RLS habilitada · policy `goals_user_isolation` con
  `USING (user_id = auth.uid())` y `WITH CHECK (user_id = auth.uid())` para
  todas las operaciones (FOR ALL).
- Índice `idx_goals_user_status` sobre `(user_id, status)`.
- Trigger `goals_set_updated_at` que reutiliza `set_updated_at()`.
  La función `set_updated_at()` se crea de forma idempotente en 007 — no
  existía aún (en 001 hay `update_updated_at` con nombre distinto).
- `GRANT SELECT/INSERT/UPDATE/DELETE TO authenticated`.

## Función `calcular_idf_dimensions(uuid)` (008)

- `RETURNS jsonb`, `LANGUAGE plpgsql`, `SECURITY DEFINER`,
  `SET search_path = public, pg_catalog`.
- `GRANT EXECUTE TO authenticated`.

### Fórmulas

`FORMULAS_IDF_ICA.md` **no existe** en la raíz del proyecto ni en ninguna
subcarpeta (verificado con `find`). Las fórmulas se tradujeron fielmente
desde `src/lib/idf.ts` del proyecto principal (`sovereign-cfo`) — única
fuente de verdad disponible. Cada dimensión devuelve 0–100 (no
pre-ponderado); el peso 40/25/20/15 se aplica sólo al `idf_total`.

| dimensión | escala 0–100 |
|---|---|
| `progreso_meta` | `(baseline + net_desde_meta) / target * 100` cap 0–100 |
| `control_fugas` | 100/80/48/20 según ratio `fugas/ingresos` mensual |
| `estabilidad_base` | 100/50/0 según `ingresos vs gastos` mensuales |
| `velocidad_ahorro` | 100/67/33/0 según ratio `ahorro/ingresos` |

`idf_total = 0.40·progreso + 0.25·fugas + 0.20·estabilidad + 0.15·velocidad`
(redondeado, cap 0–100).

Niveles: `bronce(0-25)` · `plata(26-50)` · `oro(51-75)` · `diamante(76-100)`.

### Cálculo de `acumulado_meta` (decisión técnica)

El spec original de `goals` **no incluye `current_amount`** (existía en la
versión AG06 del proyecto principal). Para que IDF funcione sin esa columna:

- `baseline_data.starting_amount` (jsonb) → cantidad inicial declarada por el
  usuario al crear la meta (default 0).
- Suma neta de transacciones (`income − expense`) desde `goal.created_at`.
- `acumulado_meta = baseline + net_desde_meta`.

Esto garantiza que `progreso_meta` se actualiza automáticamente con cada
transacción registrada, sin necesidad de mutar el `goal` desde la app.

### Sin meta activa

```json
{
  "idf_total": null,
  "razon": "no_goal_declared",
  "siguiente_accion": "consigliere_debe_pedir_meta",
  "datos_disponibles": false,
  "calculado_en": "<ISO8601>"
}
```

### Con meta + transacciones

```json
{
  "progreso_meta": 43,
  "control_fugas": 80,
  "estabilidad_base": 100,
  "velocidad_ahorro": 100,
  "idf_total": 72,
  "nivel": "oro",
  "datos_disponibles": true,
  "componentes_calculables": ["progreso_meta","control_fugas","estabilidad_base","velocidad_ahorro"],
  "calculado_en": "2026-05-26T22:25:41.222Z"
}
```

## Validación remota (Supabase MCP)

Proyecto: `sovereign-cfo` (`jmbzjcrgxetqfkqopfgr`, ACTIVE_HEALTHY).

| test | resultado |
|---|---|
| `apply_migration 007` | ✓ success |
| `apply_migration 008` | ✓ success |
| Tabla `goals` creada | ✓ |
| RLS habilitada | ✓ `relrowsecurity = true` |
| Policy `goals_user_isolation` con `user_id = auth.uid()` | ✓ USING + WITH CHECK |
| Índice `idx_goals_user_status` | ✓ |
| Trigger `goals_set_updated_at` | ✓ |
| Función `calcular_idf_dimensions` | ✓ |
| Caso sin meta → estructura `no_goal_declared` | ✓ |
| Caso con meta + 4 tx → cálculo correcto (oro, 72) | ✓ valores derivados verificados a mano |
| ROLLBACK del test | ✓ no quedó basura |

## Validación local

**No ejecutada**: el entorno no tiene Docker ni Supabase CLI instalados
(`which docker` y `which supabase` vacíos). `supabase db reset` requiere
ambos. La validación remota cubre la equivalencia funcional: las
migraciones aplicaron limpio sobre el schema real en producción de dev.

## Aislamiento RLS — verificación

La policy se valida estructuralmente: `pg_policy.polqual` y `polwithcheck`
devuelven ambos `(user_id = auth.uid())`. Esto significa que cualquier
sesión `authenticated` sólo puede ver/insertar/actualizar/borrar filas
donde `user_id` coincida con su `auth.uid()`. Un usuario A no puede leer
ni mutar `goals` de usuario B.

Test E2E manual (con JWT real) corresponde a AG07 (testing).

## Restricciones respetadas

- ✓ No tocadas migraciones 001-004 (ni 005-006).
- ✓ Ningún archivo en `src/lib/` modificado.
- ✓ Ningún paquete npm nuevo.

## Pendientes / notas para otros agentes

- **AG06** (idf-service.ts): puede llamar a `rpc('calcular_idf_dimensions', { p_user_id })`
  directamente. Las dimensiones vienen ya en escala 0–100; no requiere
  re-escalado.
- **AG08** (prompts IDF): el campo `razon: "no_goal_declared"` es la señal
  para que el Consigliere pida meta en primera sesión.
- **AG01** (consolidador): si requiere renumerar al merge con `develop`,
  ambos archivos son auto-contenidos; solo cuidar que `set_updated_at()`
  no se duplique con `update_updated_at()` ya existente en 001.

---

# INFORME — AG08 · The Consigliere prompt v2 + Output Validator

Fecha: 2026-05-26
Agente: AG08
Worktree: `../wt-ag08-consigliere/`
Branch: `agent/08`

## Misión

Reescribir el system prompt del Consigliere y crear la capa validadora de outputs
del LLM previa a su envío al usuario.

## Archivos modificados / creados

### Modificados
- `src/lib/prompts/consigliere.ts` — añade `systemPromptConsigliere`,
  `mensajeBienvenidaPrimeraSesion`; `buildSystemPrompt(context)` ahora compone
  la base estática con el bloque PERFIL ACTIVO. Se mantiene la firma pública
  consumida por `src/app/api/chat/route.ts`.
- `package.json` — añade script `npm test` que encadena los tests unitarios
  vía `npx tsx`.

### Creados
- `src/lib/llm/validator-rules.ts` — listas de regex: productos específicos,
  recomendaciones absolutas, garantías de rentabilidad, lenguaje motivacional,
  detección de disclaimer y disclaimer canónico.
- `src/lib/llm/output-validator.ts` — `validateConsigliereOutput(text)` →
  `ValidationResult` con `passed`, `severity` (`ok|flag|block`), `reasons`,
  `suggestedDisclaimer?`.
- `src/lib/prompts/__tests__/validator.test.ts` — 10 casos PASS + 10 casos
  FAIL. Todos verdes.
- `docs/consigliere-voice.md` — 10 outputs ideales + 10 outputs a evitar
  con su razón.
- `INFORME.md` — este archivo.

## Comportamiento del system prompt v2

Resumen de lo que el prompt ahora cubre:

- **Identidad**: estratega italiano implícito (palabras, no acento), frío,
  protector, lealtad al patrimonio del usuario.
- **Léxico de la casa**: Reserva de Imprevistos, Fuga de Poder, Escudo Familiar,
  Escenario de Poder, Hito, Dominio Financiero, ICA Score.
- **Lo que no hace**: nada de "tú puedes", "cree en ti", emojis enfáticos,
  anglicismos innecesarios.
- **Proactividad** (cuándo habla primero): fuga detectada · 7 días inactividad ·
  últimos 3 días del mes · meta en riesgo · ingreso recurrente próximo.
- **Política de documentos**: extracto 3 meses para metas >6m · histórico
  ingresos/gastos fijos para compra de activo · detalle deudas+tasas para
  salida de deudas · perfil fiscal completo para proyecciones >12m.
- **Disclaimer obligatorio**: cualquier mención de broker/exchange/fondo/acción
  específica exige el texto canónico en el mismo mensaje. La alternativa es
  hablar en categorías (no marcas).
- **Reglas de respuesta**: 600 tokens máx, acción concreta, cuantificar fugas,
  cerrar con siguiente paso (nunca con pregunta abierta vacía).

## Capa validadora — qué bloquea

| Detección | Severidad |
|-----------|-----------|
| Mención de producto financiero específico SIN disclaimer en el mismo mensaje | `block` |
| Garantía de rentabilidad futura ("vas a ganar X%", "rentabilidad del Y%", "tienes asegurado", "garantizado:") | `block` |
| Recomendación absoluta ("compra X", "vende Y", "invierte en Z", "abre cuenta en", "tu mejor opción es") junto a producto específico | `block` |
| Lenguaje motivacional cliché ("tú puedes", "cree en ti", "todo va a estar bien", "el universo te apoya", ...) | `flag` |

Cuando hay productos sin disclaimer, el `ValidationResult` rellena
`suggestedDisclaimer` con el texto canónico para facilitar la regeneración.

## Tests

```
npm test
```

Resultado:

```
ica.test.ts            → 21 passed
portugal.test.ts       → 19 passed
transactions.test.ts   → 24 passed
validator.test.ts      → 20 passed (10 PASS + 10 FAIL)
─────────────────────────────────────
TOTAL                  → 84 passed · 0 failed
```

Acceptance criteria:

- ✅ `npm test` verde.
- ✅ Validator: 0 falsos positivos en los 10 casos PASS.
- ✅ Validator: detecta los 10 casos FAIL como `severity: 'block'`.

## Restricciones respetadas

- ✅ No se ha tocado `src/app/api/chat/route.ts` (endpoint de AG01).
- ✅ No se han tocado `categorizar.ts`, `detectarFuga.ts`, `reporte.ts`,
  `onboarding.ts` (otros prompts).
- ✅ `buildSystemPrompt(context)` mantiene su firma pública: el chat route
  consume el output sin cambios.

## Notas para AG01 / integración

- Para usar el validator en el endpoint de chat, importar
  `validateConsigliereOutput` desde `@/lib/llm/output-validator` y aplicarlo
  sobre el output del LLM antes de persistirlo en `messages` / devolverlo al
  cliente. Si `severity === 'block'`, opciones: (a) regenerar pidiendo al LLM
  que adjunte `suggestedDisclaimer` o evite el producto específico;
  (b) bloquear y enviar mensaje genérico de retry al usuario.
- `mensajeBienvenidaPrimeraSesion` ya está exportado para ser inyectado por el
  flujo de primera sesión cuando el usuario complete GDPR.

---

## Adenda AG08 — Cableado runGuardrail (2026-07-06)

Rebase de `agent/08` (prompt v2 + validator) sobre `origin/develop`
(que ya trae la capa guardrail + calculator de AG02). Conflicto add/add en
`INFORME.md` resuelto fusionando ambos informes (AG02 arriba, AG08 debajo).
Detalle del cableado en la sección de entrega Fase 4.

---

# INFORME — AG07 · Simulador Masivo

**Misión:** generar 100 perfiles sintéticos realistas PT/ES en DB de staging.
**Branch:** `agent/07`
**Worktree:** `../wt-ag07-testing/`
**Fecha:** 2026-05-26

## Entregables

| Archivo                                  | LoC | Función                                                          |
|------------------------------------------|----:|------------------------------------------------------------------|
| `scripts/seed-synthetic-profiles.ts`     | ~610| Crea 100 usuarios + perfiles + transacciones                     |
| `scripts/cleanup-synthetic-profiles.ts`  | ~100| Borra usuarios sintéticos vía `auth.admin.deleteUser` (cascada)  |
| `docs/synthetic-data-spec.md`            | ~250| Especificación completa de distribuciones, reglas y verificación |

## Cumplimiento del brief

- ✅ Emails `synth_001@audit.andgcore.test` … `synth_100@…` (TLD reservado RFC 2606)
- ✅ Distribución país: 60 PT + 40 ES
- ✅ Distribución edad: 25 / 40 / 25 / 10 en los buckets pedidos
- ✅ Distribución arquetipo: 20 / 25 / 15 / 20 / 20
- ✅ Salarios realistas: PT 800–3500 € / ES 1100–4500 € con subsidios y pagas extra
- ✅ Eventos puntuales: bono anual (25%), devolución hacienda (30%), gasto médico (20%)
- ✅ 3–6 meses de transacciones por usuario, ordenadas por fecha
- ✅ Categorías coherentes: alquiler, supermercado, transporte, restaurantes, suscripciones, ocio, salud, ropa, energia, telecomunicaciones (+ pago_deuda / intereses_deuda para `endeudado`)
- ✅ Meta declarada coherente con arquetipo (storage en `onboarding_data.main_goal` — tabla `goals` aún no existe)
- ✅ Patrones de spike semanal para `impulsivo` (factor 0.3–2.5 sobre discrecionales)
- ✅ Cleanup script funcional (delete en cascada vía FK `ON DELETE CASCADE`)

## Decisiones técnicas

- **PRNG determinista (mulberry32, seed `20260526`).** Re-runs producen el mismo conjunto — necesario para auditar diffs entre ejecuciones.
- **Triple guard-rail anti-producción:**
  1. URL no debe contener `prod` / `production`
  2. Variables `ALLOW_SYNTHETIC_SEED=1` y `ALLOW_SYNTHETIC_CLEANUP=1` deben estar puestas explícitamente
  3. El TLD `.test` (RFC 2606) garantiza que ningún email saliente se entregue
- **No tocamos triggers.** El trigger ICA (`005_ica_trigger.sql`) seguirá disparando por cada `INSERT`. Documentado en spec § 13 como limitación conocida (todos los sintéticos terminarán con ICA = 100).
- **`monthly_gross` = `monthly_net × 1.32`** como aproximación uniforme. No usamos `src/lib/fiscal/portugal.ts` porque el seeder vive fuera del bundle Next.js y la dirección bruto→neto es la inversa de lo que la lib calcula.
- **No insertamos en `goals`.** Migración 007 pendiente (owner AG06). La meta vive en `profiles.onboarding_data.main_goal`. Cuando AG06 termine, este script deberá extenderse — comentado en `docs/synthetic-data-spec.md` § 13.

## Verificación

- ✅ Type-check con `tsc --strict` pasa limpio sobre ambos scripts.
- ⚠️ No ejecutado contra staging (esta sesión no tiene credenciales). La spec incluye queries SQL de verificación post-seed en § 12.

## Cómo se ejecuta

```bash
export $(grep -v '^#' .env.local | xargs)

ALLOW_SYNTHETIC_SEED=1 npx tsx scripts/seed-synthetic-profiles.ts
# … logs por usuario …
# ✅ Listo. Creados: 100 · Fallidos: 0

# Cuando se quiera limpiar:
ALLOW_SYNTHETIC_CLEANUP=1 npx tsx scripts/cleanup-synthetic-profiles.ts
```

## Restricciones respetadas

- Solo `scripts/` y `docs/` tocados.
- Sin cambios a `src/`, `supabase/`, `package.json`, `next.config.ts`, ni CLAUDE.md.
- Sin tocar scripts existentes (no había ninguno).
- Compatible con el resto de agentes — ningún archivo pisado.

## Pendiente (no-blockers para esta misión)

- Ejecución real contra staging cuando AG01/operador disponga del entorno.
- Extender seeder para insertar `goals` cuando AG06 termine la migración 007.
- Considerar un script auxiliar `reset-synthetic-ica.ts` que pone `ica_score=0` y truncate `ica_history` de los sintéticos si las pruebas necesitan ICAs distribuidos en vez de saturados a 100.

---

# INFORME — AG07 · Harness de regresión conversacional multi-turno

**Misión:** probar la maquinaria determinista completa, multi-turno, sin depender del LLM.
**Branch:** `agent/07` · **Worktree:** `../wt-ag07-testing/` · **Fecha:** 2026-07-09

## Entregables

| Archivo | Función |
|---|---|
| `scripts/regression-harness.ts` | Runner. Modo fixture (default) y `--live`. Asserts por turno. |
| `scripts/harness/scenario.ts` | Loader: prefiere `src/lib/calculator/scenario.ts` (AG08); cae al shim. |
| `scripts/harness/scenario-provisional.ts` | **PROVISIONAL** — implementación AG07 del contrato de AG08. |
| `scripts/lib/synthetic-profiles.ts` | Núcleo puro extraído del seeder. Fuente única de los 100 perfiles. |
| `tests/scenarios/*.json` | 13 escenarios multi-turno (26 turnos). |

## El fallo que motiva la tanda

`buildVerifiedContext` (orchestrator) es **sin estado**: recibe un único string.

    T1  "Gano 2500, gasto 1500. Financiar un carro de 30000 a 36 meses."
    T2  "El banco me ofrece 9%."

En T2 el orquestador ve un mensaje sin ingreso, sin gastos y sin préstamo:
devuelve `bloque: ""` y `cifrasCalculadas: []`. El 9% se pierde (el extractor lo
etiqueta `""`). Verificado en vivo antes de escribir una línea de harness.

La cadena `extractScenarioDelta → mergeScenario → buildScenarioContext` mantiene el
estado y recalcula la cuota con la TAE **real**: 30000 a 36 meses al 9% = **953,99 €/mes**
(al 7% de referencia serían 926,31). Corrección semántica clave: cuando la TAE la
aporta el usuario, la cuota deja de ser REFERENCIA y pasa a TU REALIDAD
(`cuota_credito_real`), entrando en `cifrasCalculadas`.

## Hallazgo — el guardarraíl es VALUE-BASED, no concept-based

Con el estado correcto (`cifrasCalculadas = [2500, 1500, 1000, 12000, 953.99]`), la
respuesta alucinada **"La cuota rondaría los 1.000 €/mes"** pasa el guardarraíl
**sin bloqueo**: `1.000` parsea a `1000`, que es el *sobrante* legítimo. El
guardarraíl aprueba cualquier cifra que coincida con una calculada, esté donde esté.

Solo un assert de CONCEPTO lo detecta:

    expectConcept.cuota: esperaba 954 ±1, encontré 1000

Por eso `expectConcept` no es azúcar: es la única red para esta clase de fallo.
`conceptValue()` prefiere el número que **sigue** a la palabra del concepto
(ES/PT/EN lo escriben así); sin esa direccionalidad, en "sobrante 984 € y capacidad
anual 11808 €" el ancla `capacidad` elegiría el 984 de detrás.

## Bug encontrado y corregido en la capa de escenario

`"Mis gastos: netflix 15, luz 80, …"` → el extractor etiqueta `gasto` por proximidad
al **primer ítem** (15) y lo tomaba como gasto mensual agregado, machacando el 1400
real del turno anterior (sobrante saltaba a 1985). Guard añadido: si el supuesto
agregado coincide con un monto de la lista, no es un agregado — se descarta y el
`gastos` previo se conserva. Cubierto por `entrega_gastos` (mutación C, abajo).

## Escenarios (14 · 28 turnos)

Los 6 playbooks en ES + los críticos en PT/EN:

`capacidad_simple` (PB1) · `normativa_referencia` (PB2) · `credito_tae_update` (PB3) ·
`entrega_gastos` (PB4) · `meta_definicion` (PB5) · `seguimiento_desviacion` (PB6) ·
`garantia_bloqueada` · `fallback_sustancia` · `negacion_permitida` · `cuota_semantica` ·
`delegativo_reemplazado` · `idioma_espejo_en` (EN) · `credito_pt` (PT) · `cuota_colision_valor`

Los perfiles salen del banco de 100 sintéticos (`canonicalProfiles()`, seed `20260526`).
El JSON se plantilla (`{{monthlyNet}}`, `{{sobrante}}`, …) **antes** de parsearse, así el
token vale igual dentro de una cadena que en posición de número.

## Verificación — mutación (los asserts muerden)

Verde a la primera es sospechoso. Se reintrodujeron los bugs a mano:

| Mutación | Turnos rojos | Escenarios que lo cazan |
|---|---|---|
| A · ignorar la TAE del usuario (bug original) | 3 | credito_tae_update, cuota_semantica, credito_pt |
| B · `mergeScenario` sin memoria | 10 | 10 escenarios (la memoria es load-bearing) |
| C · quitar el guard de lista de gastos | 1 | entrega_gastos |
| D · fixture alucinada `"1.000"` | 1 | credito_tae_update (**solo** vía expectConcept) |

Suites existentes tras el cambio: `npm test` 49/49 · `test:guardrail` OK · `test:calculator` OK
(incluye `scenario.test.ts` de AG08, que pasa: sus tests no cubren los defectos A y B).
`tsc --strict` limpio sobre los cuatro archivos nuevos y sobre el seeder refactorizado.

## Refactor del seeder — sin cambio de comportamiento

El núcleo puro (PRNG mulberry32, distribuciones, `buildAssignments`, `salaryRange`,
pools de nombres) se movió a `scripts/lib/synthetic-profiles.ts`. El seeder no era
importable: `main()` corre al cargar y los guards hacen `process.exit(1)`.

El `rng` se **inyecta**, y `buildAssignments` sigue siendo su primer consumidor, así que
el orden de consumo del PRNG no cambia. Snapshot dorado de los 100 perfiles tomado
ANTES del refactor y comparado después: **sha256 `c11b60c4fb3267f6`, idéntico**.

## Coordinación con AG08 — mergeó, y el harness pasó a probar SU código

El loader cumplió su función: AG08 mergeó (`e5b7db7`), el shim provisional se borró y
el harness importa ahora su cadena real. Su contrato quedó repartido:
`extractScenarioDelta`/`mergeScenario` en `calculator/scenario.ts`, y
`buildScenarioContext(scenario, userMessage)` en `calculator/orchestrator.ts`.
`cifrasCalculadas` pasó a `{valores, conceptos}` y hay un paso nuevo,
`ensureSubstance`, replicado aquí en el mismo orden que `route.ts`.

## RESULTADO: 21/28 turnos verdes · 7 rojos = 4 defectos reales del motor

El rojo ES el entregable. Cada fallo se reprodujo y se atribuye a un defecto concreto
de la tanda recién mergeada. No se tocó `src/`: son ficheros de AG08.

**A · `calculator/scenario.ts` — `credito.monto` toma el primer número del mensaje.**
`AMOUNT = /(\d[\d.,]*)/` no está anclada y se aplica al mensaje entero, así que
"Gano 2500 … financiar un carro de 30000 a 36 meses" fija `monto = 2500` (el ingreso).
Cuota 79,5 € en vez de 953,99 €. Depende del orden: con el crédito primero, acierta.
Los 8 tests de `scenario.test.ts` sólo pasan el crédito aislado y siembran el ingreso
como objeto literal, así que nunca cruzan ambos en un mismo mensaje.
→ credito_tae_update T1/T2 · cuota_semantica T1 · cuota_colision_valor T1

**B · `calculator/scenario.ts` — la lista de gastos machaca el agregado.**
"Mis gastos: netflix 15, luz 80, …" fija `gastos_mensuales = 15` (el primer ítem) y
borra los 2372 del turno anterior. Sobrante 2621 en vez de 264.
→ entrega_gastos T2

**C · `guardrail/validate.ts` — el orden de ramas anula el grounding semántico.**
`(c0)` coincidencia exacta con `valores` corre ANTES de `(c1)` `conceptos`. La cuota
alucinada "1.000" coincide con el sobrante (1000) y se aprueba como cálculo verificado.
Es el caso que el propio comentario de (c1) dice impedir.
→ cuota_colision_valor T2

**D · `guardrail/policy.ts` — `ensureSubstance` destruye el ejemplo canónico de PB2.**
El texto literal de `prompts/consigliere.ts:125` ("Como referencia, el estándar ronda el
20% del ingreso — …") no tiene "cifra real" (20% es porcentaje) y mide 145 chars, así
que se sustituye por `safeAsk`. El prompt de AG08 contradice a su propio enforcement.
→ normativa_referencia T2

## Limitaciones documentadas (no bloquean)

- **`extractInputFacts` sólo etiqueta en ES.** "Ganho…/despesas…" (PT) y "I earn…" (EN)
  devuelven `etiqueta: ""`. Por eso `credito_pt` extrae el préstamo y la TAE (patrones
  multi-idioma) pero no los ingresos, y `idioma_espejo_en` prueba el idioma del cierre,
  no la extracción. Cubrirlo es trabajo de AG08/AG06.
- **`detectLanguage` falla en PT corto.** `"O banco oferece-me 9%."` → `es`. Los turnos PT
  del escenario son deliberadamente más largos. Vale la pena un fix aparte.
- `SAFE_RESPONSE` no se exporta desde `output-validator.ts`: el harness detecta el
  fallback por su primera frase en cada idioma. Si AG08 la exporta, sustituir el marcador.
- `package.json` usa `npx tsx` (no `tsx` pelado, como pedía el prompt) para no añadir
  `tsx` a devDependencies y tocar `package-lock.json`, compartido con otros agentes.
  Es lo que ya hacen `test`, `test:guardrail` y `test:calculator`.
- `npm run build` necesita `.env.local` (Supabase). Sin él falla también en `origin/develop`
  limpio; con variables dummy pasa. No es un fallo de esta tanda.

## Cómo se ejecuta

```bash
npm run test:regression                      # fixture, determinista, sin red
npm run test:regression -- --filter=credito  # subconjunto
npm run test:regression -- --verbose         # imprime texto final y cifras por turno
LLM_API_KEY=sk-... npm run test:regression -- --live   # contra el LLM real
```

---

# INFORME — AG07 · Fase 4 · Escenarios conversacionales + carril (AG08)

**Misión:** cerrar el hueco de cobertura que motivó la tanda: el harness solo
tenía escenarios financieros, así que nunca detectó que un turno conversacional
("¿qué modelo eres?") era sustituido por el enlatado de missing. AG08 mergeó
`271b5a4` (`agent/08` → `develop`) con el clasificador de carril
(`FINANCIERO|META|MIXTO`), el resolutor único de cierre y la honestidad de
simulación. **Branch:** `agent/07` · **Fecha:** 2026-07-22

## Reset de rama

`git reset --hard origin/develop` (protocolo estándar) trajo el merge de AG08
(`ffb5295`, PR #24) — el clasificador de carril, `resolveClosing`,
`enforceSimulationHonesty` y la red anti-fuga de identidad (Pieza 5c), todos
ya en `develop`.

## Harness — deja de ser fiel al route (y se corrige)

El `runTurn` de la tanda anterior todavía aplicaba el pipeline plano pre-AG08:
`runGuardrail` siempre, `rewriteDelegativeClosing` + `enforceMissingClosing`
siempre, sin clasificar carril. El route real (`src/app/api/chat/route.ts`)
ya no hace eso — desde `271b5a4` bifurca por carril. Se reescribió `runTurn`
para reproducir el orden real:

1. `classifyTurn(mensaje, estadoPrevio, idioma)` — con el estado **previo**,
   igual que el route (`seed`, antes del delta del turno actual).
2. `extractScenarioDelta` — se salta si el carril es META (igual que el route:
   `carril === 'META' ? {delta:{}, usedTool:false} : resolveDelta(...)`).
3. `runGuardrail` + `enforceSimulationHonesty` — **solo** FINANCIERO/MIXTO.
4. `validateConsigliereOutput` + `enforceOutputPolicy` + disclaimer — **todos**
   los carriles (la red anti-fuga de identidad protege incluso en META).
5. `ensureSubstance` — **solo** FINANCIERO.
6. `resolveClosing` — todos los carriles, coordina cierre único por carril.

Se añadió `expectCarril` (opcional, por turno) y `Carril` al `TurnOutcome`,
expuesto también en el log de fallos (`carril: FINANCIERO · estado: {...}`).

## Escenarios nuevos (10 ficheros · 12 turnos) — `tests/scenarios/`

| Escenario | Idiomas | Qué prueba |
|---|---|---|
| `identidad_meta` | es | Crédito en curso (missing=['tae']) + "¿qué modelo eres?" → META, sin el enlatado de missing, sin fuga de proveedor (Pieza 5c) aunque el fixture la mencione |
| `identidad_meta_pt` / `_en` | pt / en | Mismo sondeo de identidad, sin escenario activo |
| `saludo_simple` | es | "hola" sin escenario → META, sin cierre canónico forzado, respuesta libre intacta |
| `saludo_simple_pt` / `_en` | pt / en | Mismo saludo |
| `agradecimiento` | es | Cálculo (FINANCIERO) → "gracias" (META) → sin re-pregunta del dato que aún falta |
| `mixto_saludo_dato` | es | "hola, gano 3000 y gasto 2000" → MIXTO: funda cifras (guardarraíl activo) pero NUNCA añade cierre propio |
| `cierre_unico` | es | Regresión del doble cierre real de QA: cierre delegativo + missing=['tae'] → UNA sola pregunta (antes `rewriteDelegativeClosing` podía inyectar su propio cierre y `enforceMissingClosing` añadía el suyo encima) |
| `simulacion_honesta` | es | "(sin incluir intereses)" sobre una cuota simulada al 7% → cláusula falsa eliminada, sin duplicar el marcador de simulación (la frase ya trae "TAE de referencia") |

Los 12 turnos nuevos pasan: `npm run test:regression -- --filter=identidad`,
`--filter=saludo`, `--filter=agradecimiento`, `--filter=mixto`,
`--filter=cierre_unico`, `--filter=simulacion_honesta`.

## RESULTADO SUITE COMPLETA: 49/50 turnos verdes · 29 escenarios

Los 4 defectos documentados en la tanda anterior (A · monto del ingreso
robado por el crédito, B · lista de gastos machaca el agregado, C · orden de
ramas del guardarraíl anula el grounding semántico, D · `ensureSubstance`
destruye el ejemplo canónico de PB2) **ya no reproducen** — el merge de AG08
los corrigió junto con el carril. El único turno rojo es nuevo:

**E · `guardrail/turn-classifier.ts` — la continuidad de carril exige DATOS
guardados, no basta con estar "en conversación financiera".**
`isScenarioActive()` solo mira si el escenario tiene `ingreso_mensual`,
`gastos_mensuales`, `gastos_detalle`, `credito` o `meta` ya capturados. Un
turno de seguimiento sin cifra ni keyword financiera match, mientras el motor
TODAVÍA no tiene ningún dato (missing=['ingreso','gastos']), cae a META y se
salta la jaula de cifras entera — el escenario exacto para el que la jaula
existe.

Reproducido en `idioma_espejo_en` T2 (preexistente, no tocado):

    T1 "How much should I save each month?"     → FINANCIERO ("save" es keyword) → bloqueado ✓
    T2 "And how much should I put aside every year?"
       → clasifica META (ni dígito, ni keyword — "put aside" no está en
         FINANCIAL_KEYWORDS EN — ni el escenario tiene datos aún)
       → runGuardrail NUNCA corre → "24000 €" (inventado) sale sin fundamentar

```
expectContains: falta "With your net monthly income"
expectNotContains: aparece "24000"
expectFallback: esperaba true, encontré false
expectBlocked: esperaba true, encontré false
carril: META · estado: {"missing":["ingreso","gastos"]}
```

No se tocó `idioma_espejo_en.json`: el rojo ES el entregable (mismo criterio
que la tanda anterior) — es un defecto real de `turn-classifier.ts`, no del
escenario. Candidatos de fix para AG08 (fuera de scope de AG07): ampliar
`FINANCIAL_KEYWORDS` EN con sinónimos de ahorro ("put aside", "set aside",
"stash away"), o cambiar la continuidad para que mire "¿el turno anterior fue
FINANCIERO/MIXTO?" en vez de "¿hay datos ya capturados?".

## Cómo se ejecuta

```bash
npm run test:regression                          # 29 escenarios, 50 turnos
npm run test:regression -- --filter=identidad     # sondeo de identidad
npm run test:regression -- --filter=saludo        # charla trivial
npm run test:regression -- --filter=cierre_unico  # regresión doble cierre
```
