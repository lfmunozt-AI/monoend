-- sovereign-cfo — migración 011: telemetría de respuestas para la compuerta G1b.
--
-- Piloto de 6 semanas con 10 usuarios externos. G1b exige que "0 respuestas
-- donde el texto contradiga al calculador o presente cifras no trazables" sea
-- MEDIBLE por telemetría, no por reporte del usuario. Esta tabla captura, por
-- turno del chat, la salida cruda del LLM, la salida final tras The
-- Commandments, el registro de mutaciones de todas las capas del pipeline
-- (grounding/validator/resolveClosing) y las violaciones de mandamientos
-- detectadas. AG07 construye la revisión nocturna sobre esta tabla.
--
-- RETENCIÓN: Datos del piloto. Contiene texto de respuestas y conceptos
-- financieros → borrado obligatorio al cierre del piloto o a petición del
-- usuario (GDPR). El on delete cascade sobre auth.users cubre el derecho al
-- olvido.
--
-- PRIVACIDAD: tabla de uso interno exclusivo (AG02/AG07/QA del piloto).
-- Ningún usuario final accede a esta tabla — solo service_role.

create table public.response_telemetry (
  id                      uuid primary key default gen_random_uuid(),
  created_at              timestamptz not null default now(),
  user_id                 uuid not null references auth.users(id) on delete cascade,
  conversation_id         uuid references public.conversations(id) on delete cascade,
  message_id              uuid,
  carril                  text,     -- FINANCIERO | META | MIXTO
  model                   text,     -- modelo LLM usado
  tokens_used             int,
  tool_call_used          boolean,
  latency_generation_ms   int,      -- llamadas al LLM
  latency_validation_ms   int,      -- guardrail+validator+commandments
  latency_total_ms        int,      -- total del route (antes del typewriter)
  calculator_conceptos    jsonb,    -- mapa de conceptos del motor
  scenario_missing        jsonb,
  response_raw            text,     -- salida CRUDA del LLM (pre-guardrail)
  response_final          text,     -- texto publicado (post-Commandments)
  mutations               jsonb,    -- registro de capa/regla/antes/despues
  commandment_violations  jsonb,    -- violaciones detectadas y su acción
  guardrail_intervened    boolean
);

create index response_telemetry_created_at_idx
  on public.response_telemetry (created_at desc);

create index response_telemetry_user_created_idx
  on public.response_telemetry (user_id, created_at desc);

-- ── RLS: solo service_role lee/escribe — es telemetría interna ─────────────────
alter table public.response_telemetry enable row level security;

grant all on public.response_telemetry to service_role;
revoke all on public.response_telemetry from anon, authenticated;
