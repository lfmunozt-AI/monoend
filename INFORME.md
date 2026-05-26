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
