-- 015 — MODO DE ENFORCEMENT EN LA TELEMETRÍA (AG08, PIEZA 1)
--
-- El flag ENFORCEMENT_MODE ('full' | 'minimal') decide qué capas de reescritura
-- están activas en cada turno. Sin registrarlo por fila, la telemetría no
-- permite comparar A/B: dos turnos con distinta intervención no son comparables
-- si no se sabe qué capas corrían.
--
-- 'full' es el valor por defecto — es lo que corre hoy en producción, así que
-- las filas históricas quedan correctamente etiquetadas con el backfill.

alter table public.response_telemetry
  add column if not exists enforcement_mode text;

update public.response_telemetry
  set enforcement_mode = 'full'
  where enforcement_mode is null;

alter table public.response_telemetry
  add constraint response_telemetry_enforcement_mode_chk
  check (enforcement_mode is null or enforcement_mode in ('full', 'minimal'));

comment on column public.response_telemetry.enforcement_mode is
  'Modo de enforcement aplicado al turno: full (todas las capas) | minimal (solo bloqueo).';

-- Comparación A/B por modo dentro de una ventana temporal.
create index if not exists response_telemetry_mode_created_idx
  on public.response_telemetry (enforcement_mode, created_at desc);
