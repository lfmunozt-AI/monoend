-- 024 — TELEMETRÍA DE FIDELIDAD DE EXTRACCIÓN (AG08 · Compuerta G1d)
--
-- EVIDENCIA REAL (producción, 22 ago) — el usuario declaró 17 partidas de
-- gasto; el sistema capturó 11 y certificó extraction_status = COMPLETE.
-- Perdidas: Amazon Prime 5, Claude 20, Google 10, filtro de agua 10, ayuda a
-- la madre 50, ayuda a la suegra 30 = 125 €. Publicado: gastos 2.080 € y
-- sobrante 220 €. Real: gastos 2.205 € y sobrante 95 €.
--
-- CAUSA RAÍZ: la verificación de conservación (V14, `detectarNumerosHuerfanos`
-- en scenario.ts) comprobaba PERTENENCIA de valor ("¿existe algún asignado
-- con este número?"), no MULTISET — una partida capturada ("cuota 50") podía
-- "cubrir" TODAS las apariciones futuras de 50 en el mensaje, incluida una
-- partida DISTINTA sin capturar ("ayuda a mi madre 50"). Corregido en la
-- misma tanda (`huerfanosPorMultiset`, scenario.ts) — esta migración añade el
-- SENSOR: la telemetría existente no podía detectar esta clase de fallo
-- porque comparaba el texto contra el output del calculador, y ambos venían
-- del MISMO input corrupto.
--
-- Estas tres columnas son la ÚNICA fuente independiente en el payload:
--   importes_en_mensaje  — cuántos importes MONETARIOS trae el mensaje
--                           original del usuario (ya excluye edades, nº de
--                           hijos, plazos, años — ver esCandidataFinanciera).
--   importes_con_destino — cuántos de esos terminaron en un destino
--                           declarado (campo asignado, ítem de gasto,
--                           huérfano no relevante, o huérfano relevante).
--   importes_sin_destino — la lista exacta de los que no (jsonb).
--
-- RETENCIÓN (ver docs/TELEMETRIA_RETENCION.md): mismo tratamiento que
-- `numeros_huerfanos` (016_extraccion_ambigua.sql) — listas de VALORES
-- numéricos desnudos, sin nombres ni texto libre, no entran en la purga de
-- 30 días de `src/lib/telemetry-purge.ts` (esa purga cubre específicamente
-- response_raw/response_final/delta_raw/previous_scenario/merged_scenario/
-- expense_items, que sí llevan texto/nombres literales).
--
-- NULLABLE + IDEMPOTENTE: no se ejecuta en esta tanda — la corre Luis antes
-- del merge (protocolo de migraciones SQL, CLAUDE.md).

alter table public.response_telemetry
  add column if not exists importes_en_mensaje integer,
  add column if not exists importes_con_destino integer,
  add column if not exists importes_sin_destino jsonb;

comment on column public.response_telemetry.importes_en_mensaje is
  'Cuántos importes MONETARIOS (no números crudos — excluye edades, nº de hijos, plazos, años) trae el MENSAJE ORIGINAL del usuario este turno. Ver numerosCandidatos()/esCandidataFinanciera en src/lib/calculator/scenario.ts. NULL en turnos anteriores a esta migración.';
comment on column public.response_telemetry.importes_con_destino is
  'Cuántos de esos importes terminaron en un destino declarado (campo asignado, ítem de gasto, huérfano no relevante, o huérfano relevante) = importes_en_mensaje - jsonb_array_length(importes_sin_destino). NULL en turnos anteriores a esta migración.';
comment on column public.response_telemetry.importes_sin_destino is
  'Lista exacta (jsonb) de los importes del mensaje original que NO encontraron destino este turno — huerfanos.numerosHuerfanos de detectarNumerosHuerfanos(). Si extraction_status=COMPLETE, debe ser un array vacío; si no lo es con COMPLETE, es la señal de un fallo de fidelidad como el del 22 ago. NULL en turnos anteriores a esta migración.';

-- Tasa de fidelidad de extracción por ventana temporal (digest nocturno) —
-- mismo patrón que los índices parciales de 016/019/020: solo indexa las
-- filas que de verdad importan para la revisión (algún importe sin destino).
create index if not exists response_telemetry_importes_sin_destino_idx
  on public.response_telemetry (created_at desc)
  where importes_sin_destino is not null and importes_sin_destino <> '[]'::jsonb;
