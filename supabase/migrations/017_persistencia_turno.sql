-- 017 — PERSISTENCIA TRANSACCIONAL DEL TURNO (AG08, 6ª tanda)
--
-- Dos ajustes de esquema requeridos por persistTurn() (src/lib/persistence.ts):
--
-- 1. public.goals.target_date era NOT NULL, pero el estado del diálogo puede
--    conocer el MONTO de una meta antes que el PLAZO ("quiero una casa de
--    150.000€" sin decir en cuánto tiempo) — PIEZA 3 exige crear la fila con
--    "titulo y (monto o plazo)", no solo cuando AMBOS están completos.
--    Forzar una fecha inventada sería el mismo error que este incidente
--    corrige en otra forma (asumir en vez de dejar en blanco lo que no se
--    sabe). Se completará cuando el usuario dé el plazo.
--
-- 2. response_telemetry.scenario_persist_failed — "si scenario_state falla,
--    se registra como error crítico en la telemetría": sin esta columna el
--    fallo solo quedaba en los logs del servidor, invisibles para la
--    revisión nocturna (compuerta G1b).

alter table public.goals
  alter column target_date drop not null;

alter table public.response_telemetry
  add column if not exists scenario_persist_failed boolean;

comment on column public.response_telemetry.scenario_persist_failed is
  'true si el UPDATE de conversations.scenario_state falló este turno — fallo crítico: el motor pierde memoria del diálogo.';
