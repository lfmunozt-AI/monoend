-- sovereign-cfo — migración 010: estado de escenario persistido + cierre M3.
--
-- Parte de las migraciones previas (001-009): NO recrea nada. Añade:
--   1. conversations.scenario_state — el motor deja de ser stateless. Guarda el
--      escenario financiero acumulado del diálogo (ingreso, gastos, crédito,
--      meta…) para recalcular sobre el ESTADO COMPLETO, no solo el último mensaje.
--   2. Cierre del TODO de M3 en guardrail_log: event_type + details jsonb, para
--      registrar eventos que no son un bloqueo de cifra (p. ej. inyección) sin
--      falsear blocked_value/blocked_text.
--
-- RLS y grants existentes cubren las columnas nuevas (la política es por fila,
-- no por columna). No se tocan políticas ni privilegios.

-- ── 1. Estado de escenario por conversación ────────────────────────────────────
alter table public.conversations
  add column if not exists scenario_state jsonb not null default '{}'::jsonb;

-- ── 2. Cierre de M3: guardrail_log admite eventos no-cifra ─────────────────────
alter table public.guardrail_log
  add column if not exists event_type text not null default 'cifra_bloqueada';

alter table public.guardrail_log
  add column if not exists details jsonb;

-- RLS intacta: `guardrail_log_owner` y `conversations` ya filtran por user_id, y
-- los grants a authenticated/service_role abarcan las columnas nuevas.
