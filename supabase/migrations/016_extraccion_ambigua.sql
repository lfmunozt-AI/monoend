-- 016 — TELEMETRÍA DE AMBIGÜEDAD DE EXTRACCIÓN (AG08, PIEZA 4 · cierre de la
-- clase de extracción)
--
-- CASO REAL (testdev4, 31/07 09:19): "gano 2300 y gasto= 1000 arriendo 500
-- servicios 250 carro 100 ropa" se extrajo como gastos=1000 (el primer número
-- tras "gasto"), cuando el gasto real era 1850 (la suma del desglose). La
-- calculadora computó bien sobre un insumo falso: el hueco estaba en la
-- ENTRADA, no en el cálculo.
--
-- Principio que cierra la clase entera: "Ningún dato entra al estado sin que
-- el usuario lo vea. Ante ambigüedad de extracción se PREGUNTA, nunca se
-- asume." Estas columnas permiten a la revisión nocturna (AG07) medir, sobre
-- tráfico real, la tasa de turnos donde la extracción quedó ambigua — no solo
-- en los escenarios de QA.

alter table public.response_telemetry
  add column if not exists extraccion_incompleta boolean,
  add column if not exists numeros_huerfanos numeric[],
  add column if not exists discrepancia_gastos boolean;

comment on column public.response_telemetry.extraccion_incompleta is
  'true si el turno mencionó números que parecían financieros y no aterrizaron en ningún campo del delta (huérfanos) — el sistema debió preguntar en vez de calcular.';
comment on column public.response_telemetry.numeros_huerfanos is
  'Los números concretos detectados como huérfanos en el turno, para auditoría manual.';
comment on column public.response_telemetry.discrepancia_gastos is
  'true si el agregado de gastos declarado no reconcilia con la suma de su propio desglose.';

-- Tasa de ambigüedad por ventana temporal (digest nocturno).
create index if not exists response_telemetry_extraccion_ambigua_idx
  on public.response_telemetry (created_at desc)
  where extraccion_incompleta is true or discrepancia_gastos is true;
