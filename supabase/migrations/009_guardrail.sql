-- sovereign-cfo — migración 009 (guardrail_log), adaptada de ModeloCFO 0005.
-- Parte de 0001/0002/0003/0004: NO recrea nada, solo añade la bitácora del
-- guardarraíl. Cada vez que el validador de grounding bloquea un monto que el
-- modelo no podía justificar, se registra aquí.
--
-- PRIVACIDAD: solo metadatos. NUNCA el mensaje del usuario ni la respuesta del
-- modelo. La pregunta se referencia por hash (question_hash), nunca su texto.
-- RLS multitenant por user_id, igual que el resto de tablas.

create table if not exists public.guardrail_log (
  id            uuid primary key default gen_random_uuid(),
  user_id       uuid not null references auth.users(id) on delete cascade,
  -- Qué se bloqueó (metadato numérico) y su literal exacto ("1500").
  blocked_value numeric not null,
  blocked_text  text not null,
  -- Por qué se bloqueó (motivo de la regla, no contenido del usuario).
  reason        text not null,
  -- Hash de la pregunta para correlacionar sin almacenar el texto.
  question_hash text not null,
  created_at    timestamptz not null default now()
);

create index if not exists guardrail_log_user_id_idx
  on public.guardrail_log (user_id);

create index if not exists guardrail_log_created_at_idx
  on public.guardrail_log (user_id, created_at desc);

-- ── RLS: cada usuario solo ve/gestiona sus propios registros ───────────────────
alter table public.guardrail_log enable row level security;

create policy "guardrail_log_owner" on public.guardrail_log
  for all
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

-- Privilegios base para `authenticated` (la RLS hace el filtrado por fila).
grant select, insert, update, delete on public.guardrail_log to authenticated;

-- El chat route registra vía adminClient (service_role).
grant all on public.guardrail_log to service_role;
