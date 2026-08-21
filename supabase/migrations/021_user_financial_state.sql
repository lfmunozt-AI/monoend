-- 021 — MEMORIA A NIVEL DE USUARIO (AG08, 13ª tanda)
--
-- DECISIÓN DE ARQUITECTURA (Luis, opción A): los HECHOS financieros son del
-- USUARIO; el estado de DIÁLOGO es de la CONVERSACIÓN.
--
-- PROBLEMA QUE CIERRA: hasta ahora TODO el `ScenarioState` vivía en
-- `conversations.scenario_state`, leído filtrando por `conversation_id`. Cada
-- conversación nueva arrancaba VACÍA: amnesia entre sesiones por diseño.
-- Contradice el ADN ("seguimiento constante: mide desviaciones, recalcula
-- rumbo") y era incoherente con `goals`, que ya vivía a nivel de usuario. Un
-- usuario del piloto que abre la app el día 2 espera que monoend recuerde su
-- meta, su ingreso y su desglose — no que le pregunte todo otra vez.
--
-- LA PARTICIÓN (la lista viva está en src/lib/calculator/scenario.ts,
-- CAMPOS_HECHOS / CAMPOS_DIALOGO / CAMPOS_TRANSITORIOS — ahí es donde falla
-- el build si alguien añade un campo y no lo clasifica):
--
--   HECHOS (esta tabla, por user_id): ingreso_mensual, gastos_mensuales,
--     gastos_detalle, gastos_items, gastos_es_detalle, tiene_agregado_gastos,
--     tiene_detalle_gastos, credito, meta, meta_derivada, goals_cerradas,
--     extraction_status, factStatus, detalle_confirmado, y el ciclo de vida
--     del conflicto completo (gastos_conflict con su `attempts`,
--     gastos_assumed, gastos_superseded + su contador de colapsados, los dos
--     orígenes agregado/detalle, y `turn`, que es el reloj que fecha todo lo
--     anterior).
--
--   DIÁLOGO (sigue en conversations.scenario_state, por conversation_id):
--     propuesta_pendiente, plan_confirmado, meta_cerrada, digresiones_seguidas,
--     eco_pendiente y `missing` (derivado, se recalcula en cada merge).
--
-- NOTA sobre `attempts`: los dos intentos de aclaración previos al escape a
-- ASSUMED (§6 del contrato) cuentan a nivel de USUARIO. Abrir un chat nuevo NO
-- reinicia ese contador — si lo hiciera, el usuario podría esquivar el escape
-- indefinidamente abriendo conversaciones.
--
-- NO se usa RAG para los hechos: esta capa es DETERMINISTA, con procedencia
-- (origen + turno) y estado (PARSED/CONFIRMED/CONFLICT/ASSUMED). RAG es
-- probabilístico y queda deliberadamente fuera de la ruta de los hechos.
--
-- `conversations.scenario_state` NO se borra: conserva el estado de diálogo y
-- actúa de respaldo del backfill.

-- ── Tabla ────────────────────────────────────────────────────────────────────

create table if not exists public.user_financial_state (
  user_id uuid primary key references auth.users(id) on delete cascade,
  state jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now()
);

comment on table public.user_financial_state is
  'Hechos financieros del USUARIO (no de la conversación): ingreso, gastos, desglose, meta, crédito y el ciclo de vida del conflicto. Sobrevive entre conversaciones — ver la partición hechos/diálogo en src/lib/calculator/scenario.ts (splitScenarioState).';
comment on column public.user_financial_state.state is
  'Mitad HECHOS del ScenarioState, tal cual la produce splitScenarioState(). La FORMA del objeto en memoria no cambió: route.ts fusiona esta mitad con la de diálogo antes de pasar al pipeline.';

-- ── RLS + GRANTs ─────────────────────────────────────────────────────────────
-- IMPORTANTE: los GRANT explícitos a service_role NO son opcionales. La
-- migración 018 existió precisamente porque `goals` los tenía faltantes y el
-- fallo solo salió a la luz cuando `test:e2e` intentó escribir. No se repite
-- aquí ese fallo: se conceden en la misma migración que crea la tabla.

alter table public.user_financial_state enable row level security;

grant select, insert, update, delete on public.user_financial_state to service_role;

-- El chat escribe SIEMPRE vía service_role (persistTurn, punto único de
-- escritura). Esta política es solo de LECTURA para el propio usuario, por si
-- la UI necesita mostrar su estado sin pasar por el route. Nunca de escritura:
-- ningún cliente debe poder mutar los hechos saltándose la extracción.
drop policy if exists "user_financial_state_select_own" on public.user_financial_state;
create policy "user_financial_state_select_own"
  on public.user_financial_state
  for select
  using (auth.uid() = user_id);

-- ── Telemetría (PIEZA 4) ─────────────────────────────────────────────────────
-- NULLABLE: los turnos anteriores a esta migración la dejan en NULL. El nombre
-- coincide EXACTAMENTE con la clave del payload (`userStatePersistFailed` →
-- `user_state_persist_failed`) — un desajuste haría que la telemetría fallara
-- en silencio, como pasó con la 016.

alter table public.response_telemetry
  add column if not exists user_state_persist_failed boolean;

comment on column public.response_telemetry.user_state_persist_failed is
  'true si falló la escritura en user_financial_state este turno (fallo CRÍTICO: el motor pierde la memoria financiera del usuario ENTRE conversaciones — distinto de scenario_persist_failed, que solo pierde la del diálogo en curso). PURGA 30 días junto con el resto de columnas de depuración — ver docs/TELEMETRIA_RETENCION.md.';

-- ── BACKFILL ─────────────────────────────────────────────────────────────────
-- Por cada usuario, toma el scenario_state de su conversación con `updated_at`
-- más reciente y extrae SOLO los campos de HECHOS. IDEMPOTENTE: `on conflict
-- do nothing` — si el usuario ya tiene fila (porque ya conversó tras el
-- despliegue), su estado vivo manda y este backfill no lo pisa.
--
-- La lista de claves debe coincidir con CAMPOS_HECHOS en scenario.ts. Se
-- extraen con jsonb y se filtran las ausentes, para no escribir claves con
-- valor null que el código interpretaría como "campo presente y vacío".

insert into public.user_financial_state (user_id, state, updated_at)
select
  c.user_id,
  (
    select coalesce(jsonb_object_agg(kv.key, kv.value), '{}'::jsonb)
    from jsonb_each(c.scenario_state) as kv(key, value)
    where kv.key in (
      'ingreso_mensual', 'gastos_mensuales', 'gastos_detalle', 'gastos_es_detalle',
      'gastos_items', 'tiene_agregado_gastos', 'tiene_detalle_gastos',
      'credito', 'meta', 'meta_derivada', 'goals_cerradas',
      'extraction_status', 'factStatus', 'detalle_confirmado',
      'gastos_conflict', 'gastos_assumed', 'gastos_superseded',
      'gastos_superseded_colapsados', 'gastos_agregado_origen',
      'gastos_detalle_origen', 'turn'
    )
      and kv.value is not null
      and jsonb_typeof(kv.value) <> 'null'
  ) as state,
  now()
from (
  select distinct on (user_id) user_id, scenario_state
  from public.conversations
  where scenario_state is not null
    and scenario_state <> '{}'::jsonb
  order by user_id, updated_at desc nulls last
) as c
on conflict (user_id) do nothing;
