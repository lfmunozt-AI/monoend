-- Migration 007: goals
-- AG02 (Pattern Architect)
--
-- Tabla `goals` para metas financieras del usuario. Soporta múltiples
-- metas por usuario; el Consigliere extrae meta principal en primera sesión.
-- baseline_data captura el estado inicial al declarar la meta para que el
-- motor IDF pueda calcular progreso real (no depende de current_amount).
--
-- Numeración: usamos 007 porque 005 (ica_trigger) y 006 (embeddings_search)
-- ya están ocupadas en esta rama. El spec original pedía 005/006 pero esos
-- archivos están en producción.

-- ─── Función set_updated_at ─────────────────────────────────────────────────
-- Idempotente: crear o reemplazar para que cualquier tabla pueda reutilizarla.

CREATE OR REPLACE FUNCTION public.set_updated_at()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = now();
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- ─── Tabla goals ────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS public.goals (
    id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id         uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
    title           text NOT NULL,
    target_amount   numeric(12,2) NOT NULL CHECK (target_amount > 0),
    target_date     date NOT NULL,
    category        text NOT NULL CHECK (category IN (
                        'property',
                        'debt_payoff',
                        'emergency_fund',
                        'retirement',
                        'business',
                        'education',
                        'travel',
                        'vehicle',
                        'other'
                    )),
    status          text NOT NULL DEFAULT 'active' CHECK (status IN (
                        'active',
                        'paused',
                        'completed',
                        'abandoned'
                    )),
    baseline_data   jsonb NOT NULL DEFAULT '{}'::jsonb,
    created_at      timestamptz NOT NULL DEFAULT now(),
    updated_at      timestamptz NOT NULL DEFAULT now()
);

-- ─── RLS ────────────────────────────────────────────────────────────────────

ALTER TABLE public.goals ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS goals_user_isolation ON public.goals;
CREATE POLICY goals_user_isolation ON public.goals
    FOR ALL
    USING (user_id = auth.uid())
    WITH CHECK (user_id = auth.uid());

-- ─── Trigger updated_at ─────────────────────────────────────────────────────

DROP TRIGGER IF EXISTS goals_set_updated_at ON public.goals;
CREATE TRIGGER goals_set_updated_at
    BEFORE UPDATE ON public.goals
    FOR EACH ROW
    EXECUTE FUNCTION public.set_updated_at();

-- ─── Índice ─────────────────────────────────────────────────────────────────

CREATE INDEX IF NOT EXISTS idx_goals_user_status
    ON public.goals(user_id, status);

-- ─── Permisos ───────────────────────────────────────────────────────────────

GRANT SELECT, INSERT, UPDATE, DELETE ON public.goals TO authenticated;
