-- 019 — TELEMETRÍA DE DEPURACIÓN DE EXTRACCIÓN (AG08, 8ª tanda · "extracción
-- honesta")
--
-- EVIDENCIA REAL (testdev7, 31/07 21:20): un desglose de 15 partidas con
-- nombres con guion bajo ("Diezmo_Vital 225, 700 Casa_Vital...") no producía
-- NINGÚN ítem (el parser de listas no aceptaba "_" en los nombres) y el
-- detector de huérfanos general glueaba "60 100" en 60100 (el mismo espacio
-- que en "2 500 €" separa miles). Diagnosticar ese incidente exigió
-- reconstruir a mano, a partir de logs de servidor dispersos, qué había
-- devuelto la extracción y en qué estado estaba el escenario antes/después.
-- Estas columnas cierran ese bucle de "arreglar a ciegas": permiten
-- reconstruir CUALQUIER turno real desde la propia fila de telemetría.
--
-- RETENCIÓN — IMPORTANTE (ver docs/TELEMETRIA_RETENCION.md): a diferencia de
-- las columnas de métricas de `response_telemetry` (latencias, tokens,
-- conceptos…), que se conservan indefinidamente por no llevar texto libre,
-- estas CUATRO columnas SÍ llevan cifras y nombres literales que el usuario
-- escribió (ingresos, gastos, nombres de partidas, metas) — la misma clase de
-- dato sensible que `response_raw`/`response_final`. Por eso entran en la
-- MISMA purga de 30 días (`src/lib/telemetry-purge.ts`, actualizado en esta
-- misma tanda), no en la retención indefinida de las métricas.

alter table public.response_telemetry
  add column if not exists extraction_status text,
  add column if not exists delta_raw jsonb,
  add column if not exists previous_scenario jsonb,
  add column if not exists merged_scenario jsonb,
  add column if not exists expense_items jsonb;

comment on column public.response_telemetry.extraction_status is
  'COMPLETE | PARTIAL | AMBIGUOUS | INVALID — honestidad de la extracción de este turno (ver src/lib/calculator/scenario.ts, computeExtractionStatus). PURGA 30 días junto con response_raw/response_final — ver docs/TELEMETRIA_RETENCION.md.';
comment on column public.response_telemetry.delta_raw is
  'Lo que devolvió la extracción este turno (tool_call o fallback regex), tal cual, antes de cualquier filtrado por discrepancia. PURGA 30 días.';
comment on column public.response_telemetry.previous_scenario is
  'scenario_state ANTES del merge de este turno (el "seed"). PURGA 30 días.';
comment on column public.response_telemetry.merged_scenario is
  'scenario_state DESPUÉS del merge de este turno (lo que se persistió). PURGA 30 días.';
comment on column public.response_telemetry.expense_items is
  'Ítems de gasto individuales extraídos este turno (name, amount, category, source) — ver GastoItemEntry en scenario.ts. PURGA 30 días.';

-- Tasa de extracciones no-COMPLETE por ventana temporal (digest nocturno) —
-- mismo patrón que el índice de 016_extraccion_ambigua.sql.
create index if not exists response_telemetry_extraction_status_idx
  on public.response_telemetry (created_at desc)
  where extraction_status is not null and extraction_status <> 'COMPLETE';
