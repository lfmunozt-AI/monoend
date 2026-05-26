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
