-- 020 — TELEMETRÍA DE RECONCILIACIÓN CROSS-TURNO (AG08, 12ª tanda · Gate G1c)
--
-- CONTEXTO: docs/CONTRATO_TRUTH_ENGINE.md §2/§6/§8. El caso real que originó
-- esta tanda — el usuario declara 2.200 € de gastos en un turno y entrega un
-- desglose que suma 2.250 € en OTRO — no se detectaba porque la
-- reconciliación solo miraba el delta del turno actual. `mergeScenario`
-- (scenario.ts) ahora compara SIEMPRE contra el último valor conocido de
-- cada fuente y produce CONFLICT (sin resolver) o ASSUMED (tras el escape de
-- §6), guardado en `scenario_state.gastos_conflict`/`gastos_assumed`.
--
-- Esas dos claves ya viajan dentro de `merged_scenario` (jsonb, columna de
-- 019_telemetry_extraction.sql), pero eso exige parsear el blob para medir la
-- tasa real de conflictos. Estas cinco columnas son de primera clase para que
-- la revisión nocturna (AG07) pueda agregar directamente
-- (`group by conflict_status`, `avg(conflict_diff)`, `count(*) filter (where
-- conflict_attempts >= 2)`…) sin tocar JSON.
--
-- RETENCIÓN (ver docs/TELEMETRIA_RETENCION.md): `conflict_diff` es una cifra
-- que el usuario aportó (aunque derivada), y `conflict_field`/`assumed_fields`
-- son nombres de campo, no texto libre — no llevan PII directa. Aun así,
-- entran en la misma purga de 30 días que el resto de columnas de depuración
-- de extracción (019), por consistencia: viven en la MISMA fila que
-- `delta_raw`/`previous_scenario`/`merged_scenario`, y separar la retención
-- columna a columna en la misma tabla sería más frágil que purgar la fila
-- entera junto con el resto.

alter table public.response_telemetry
  add column if not exists conflict_status text,
  add column if not exists conflict_field text,
  add column if not exists conflict_diff numeric,
  add column if not exists conflict_attempts integer,
  add column if not exists assumed_fields text[];

comment on column public.response_telemetry.conflict_status is
  'CONFLICT | ASSUMED | NULL — estado del ciclo de vida del conflicto de gastos tras este turno (ver src/lib/calculator/scenario.ts, reconciliarGastos). PURGA 30 días junto con delta_raw/previous_scenario/merged_scenario — ver docs/TELEMETRIA_RETENCION.md.';
comment on column public.response_telemetry.conflict_field is
  'Campo en conflicto (hoy solo "gastos_mensuales" — único campo con doble fuente agregado/desglose). NULL si no hay conflicto activo. PURGA 30 días.';
comment on column public.response_telemetry.conflict_diff is
  'Diferencia con signo (detalle − agregado) del conflicto activo al cierre de este turno. NULL si no hay conflicto. PURGA 30 días.';
comment on column public.response_telemetry.conflict_attempts is
  'Intentos de aclaración sin resolver acumulados en el conflicto activo (§6: escapa a ASSUMED en 2 si la diferencia es ≤5%). NULL si no hay conflicto. PURGA 30 días.';
comment on column public.response_telemetry.assumed_fields is
  'Campos actualmente en estado ASSUMED (adoptados tras el escape de §6, revocables — V6). Array vacío si ninguno. PURGA 30 días.';

-- Tasa de conflictos/supuestos por ventana temporal (digest nocturno) — mismo
-- patrón que los índices parciales de 016/019.
create index if not exists response_telemetry_conflict_status_idx
  on public.response_telemetry (created_at desc)
  where conflict_status is not null;
