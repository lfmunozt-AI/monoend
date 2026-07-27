-- migración 012: alertas de la revisión nocturna de telemetría (AG07).
--
-- `response_telemetry` (migración 011) es la fuente cruda; esta tabla guarda
-- el VEREDICTO de `scripts/telemetry-review.ts` sobre esa fuente, para poder
-- auditar el histórico de compuerta G1b sin releer telemetry cada vez y para
-- que el digest por email tenga una fuente estable que citar.
--
-- Regla D1-D5 (ver docs/ACEPTACION_FASE0.md): D1-D3 son severidad 'G1b'
-- (crítico, bloquea el piloto si no son 0), D4 es 'regresion' (defecto de
-- capa, no compuerta G1b), D5 es 'info' (métricas, nunca bloquea).
--
-- IDEMPOTENTE: re-ejecutar la revisión de un `review_date` borra sus alertas
-- previas antes de reinsertar (mismo criterio que el resto del pipeline: sin
-- rastro duplicado de una re-ejecución).
--
-- PRIVACIDAD: mismo uso interno que 011 — solo service_role.

create table public.telemetry_alerts (
  id              uuid primary key default gen_random_uuid(),
  created_at      timestamptz not null default now(),
  review_date     date not null,
  severity        text not null check (severity in ('G1b', 'regresion', 'info')),
  rule            text not null check (rule in ('D1', 'D2', 'D3', 'D4', 'D5')),
  telemetry_id    uuid references public.response_telemetry(id) on delete set null,
  detail          jsonb not null default '{}'::jsonb
);

create index telemetry_alerts_review_date_idx
  on public.telemetry_alerts (review_date desc);

create index telemetry_alerts_severity_idx
  on public.telemetry_alerts (severity, review_date desc);

-- ── RLS: solo service_role lee/escribe — es telemetría interna ─────────────────
alter table public.telemetry_alerts enable row level security;

grant all on public.telemetry_alerts to service_role;
revoke all on public.telemetry_alerts from anon, authenticated;
