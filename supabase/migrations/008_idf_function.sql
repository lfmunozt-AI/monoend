-- Migration 008: calcular_idf_dimensions()
-- AG02 (Pattern Architect)
--
-- Función SQL que calcula el IDF (Índice de Dominio Financiero) de un usuario
-- combinando 4 dimensiones ponderadas sobre escala 0–100:
--   · progreso_meta      40%
--   · control_fugas      25%
--   · estabilidad_base   20%
--   · velocidad_ahorro   15%
--
-- Niveles: bronce(0-25) · plata(26-50) · oro(51-75) · diamante(76-100).
--
-- Período de evaluación para fugas/estabilidad/velocidad: mes en curso.
-- Período para progreso: desde created_at de la meta + baseline_data.starting_amount.
--
-- Las fórmulas son traducción fiel de src/lib/idf.ts (referencia AG06).
-- Nota: FORMULAS_IDF_ICA.md no existe en disco; idf.ts es la única fuente.

CREATE OR REPLACE FUNCTION public.calcular_idf_dimensions(p_user_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_catalog
AS $$
DECLARE
    v_goal               record;
    v_progreso_meta      numeric := 0;
    v_control_fugas      numeric := 0;
    v_estabilidad_base   numeric := 0;
    v_velocidad_ahorro   numeric := 0;
    v_idf_total          numeric;
    v_nivel              text;
    v_componentes        text[] := ARRAY[]::text[];
    v_ingresos_mes       numeric := 0;
    v_gastos_mes         numeric := 0;
    v_fugas_mes          numeric := 0;
    v_ahorro_mes         numeric := 0;
    v_net_desde_meta     numeric := 0;
    v_baseline           numeric := 0;
    v_acumulado_meta     numeric := 0;
    v_ratio              numeric;
    v_periodo_desde      date := date_trunc('month', now())::date;
    v_periodo_hasta      date := now()::date;
    v_has_tx_period      boolean := false;
    v_has_tx_since_goal  boolean := false;
BEGIN
    -- ─── 1. Meta activa ────────────────────────────────────────────────────
    SELECT id, target_amount, baseline_data, created_at
      INTO v_goal
      FROM public.goals
     WHERE user_id = p_user_id
       AND status = 'active'
     ORDER BY created_at DESC
     LIMIT 1;

    IF NOT FOUND THEN
        RETURN jsonb_build_object(
            'idf_total',         null,
            'razon',             'no_goal_declared',
            'siguiente_accion',  'consigliere_debe_pedir_meta',
            'datos_disponibles', false,
            'calculado_en',      to_char(now() AT TIME ZONE 'UTC',
                                         'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
        );
    END IF;

    -- ─── 2. Transacciones del mes en curso ─────────────────────────────────
    SELECT
        COALESCE(SUM(CASE WHEN type = 'income'  THEN amount ELSE 0 END), 0),
        COALESCE(SUM(CASE WHEN type = 'expense' THEN amount ELSE 0 END), 0),
        COALESCE(SUM(CASE WHEN type = 'expense' AND is_leak = true
                          THEN amount ELSE 0 END), 0),
        COUNT(*) > 0
      INTO v_ingresos_mes, v_gastos_mes, v_fugas_mes, v_has_tx_period
      FROM public.transactions
     WHERE user_id = p_user_id
       AND date >= v_periodo_desde
       AND date <= v_periodo_hasta;

    -- ─── 3. Acumulado hacia la meta (desde goal.created_at) ────────────────
    v_baseline := COALESCE(
        (v_goal.baseline_data->>'starting_amount')::numeric,
        0
    );

    SELECT
        COALESCE(SUM(CASE WHEN type = 'income'  THEN amount
                          WHEN type = 'expense' THEN -amount
                          ELSE 0 END), 0),
        COUNT(*) > 0
      INTO v_net_desde_meta, v_has_tx_since_goal
      FROM public.transactions
     WHERE user_id = p_user_id
       AND date >= v_goal.created_at::date;

    v_acumulado_meta := v_baseline + v_net_desde_meta;

    -- ─── 4. Dimensión 1 · progreso_meta (0–100) ────────────────────────────
    IF v_goal.target_amount > 0 THEN
        v_ratio := v_acumulado_meta / v_goal.target_amount;
        v_progreso_meta := LEAST(100, GREATEST(0, v_ratio * 100));
        IF v_baseline > 0 OR v_has_tx_since_goal THEN
            v_componentes := array_append(v_componentes, 'progreso_meta');
        END IF;
    END IF;

    -- ─── 5. Dimensión 2 · control_fugas (0–100) ────────────────────────────
    -- Traducción fiel de dimControlFugas() en idf.ts (peso 25 → escala 100).
    IF v_fugas_mes <= 0 THEN
        v_control_fugas := 100;            -- TS: 25 (máximo)
    ELSIF v_ingresos_mes <= 0 THEN
        v_control_fugas := 20;             -- TS: 5  (penalización máxima)
    ELSE
        v_ratio := v_fugas_mes / v_ingresos_mes;
        IF v_ratio < 0.10 THEN
            v_control_fugas := 80;         -- TS: 20
        ELSIF v_ratio < 0.20 THEN
            v_control_fugas := 48;         -- TS: 12
        ELSE
            v_control_fugas := 20;         -- TS: 5
        END IF;
    END IF;
    IF v_ingresos_mes > 0 OR v_fugas_mes > 0 THEN
        v_componentes := array_append(v_componentes, 'control_fugas');
    END IF;

    -- ─── 6. Dimensión 3 · estabilidad_base (0–100) ─────────────────────────
    IF v_ingresos_mes = 0 AND v_gastos_mes = 0 THEN
        v_estabilidad_base := 0;
    ELSIF v_ingresos_mes > v_gastos_mes THEN
        v_estabilidad_base := 100;
    ELSIF v_ingresos_mes = v_gastos_mes THEN
        v_estabilidad_base := 50;
    ELSE
        v_estabilidad_base := 0;
    END IF;
    IF v_has_tx_period THEN
        v_componentes := array_append(v_componentes, 'estabilidad_base');
    END IF;

    -- ─── 7. Dimensión 4 · velocidad_ahorro (0–100) ─────────────────────────
    v_ahorro_mes := v_ingresos_mes - v_gastos_mes;
    IF v_ahorro_mes <= 0 OR v_ingresos_mes <= 0 THEN
        v_velocidad_ahorro := 0;
    ELSE
        v_ratio := v_ahorro_mes / v_ingresos_mes;
        IF v_ratio > 0.20 THEN
            v_velocidad_ahorro := 100;     -- TS: 15
        ELSIF v_ratio >= 0.10 THEN
            v_velocidad_ahorro := 67;      -- TS: 10  (~10/15*100)
        ELSIF v_ratio >= 0.01 THEN
            v_velocidad_ahorro := 33;      -- TS: 5   (~5/15*100)
        ELSE
            v_velocidad_ahorro := 0;
        END IF;
    END IF;
    IF v_ingresos_mes > 0 THEN
        v_componentes := array_append(v_componentes, 'velocidad_ahorro');
    END IF;

    -- ─── 8. IDF total ponderado ────────────────────────────────────────────
    v_idf_total := 0.40 * v_progreso_meta
                 + 0.25 * v_control_fugas
                 + 0.20 * v_estabilidad_base
                 + 0.15 * v_velocidad_ahorro;
    v_idf_total := LEAST(100, GREATEST(0, ROUND(v_idf_total)));

    -- ─── 9. Nivel ──────────────────────────────────────────────────────────
    v_nivel := CASE
        WHEN v_idf_total <= 25 THEN 'bronce'
        WHEN v_idf_total <= 50 THEN 'plata'
        WHEN v_idf_total <= 75 THEN 'oro'
        ELSE 'diamante'
    END;

    RETURN jsonb_build_object(
        'progreso_meta',          ROUND(v_progreso_meta)::int,
        'control_fugas',          ROUND(v_control_fugas)::int,
        'estabilidad_base',       ROUND(v_estabilidad_base)::int,
        'velocidad_ahorro',       ROUND(v_velocidad_ahorro)::int,
        'idf_total',              v_idf_total::int,
        'nivel',                  v_nivel,
        'datos_disponibles',      (v_has_tx_period OR v_has_tx_since_goal OR v_baseline > 0),
        'componentes_calculables', to_jsonb(v_componentes),
        'calculado_en',           to_char(now() AT TIME ZONE 'UTC',
                                          'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
    );
END;
$$;

-- ─── Permisos ───────────────────────────────────────────────────────────────
-- SECURITY DEFINER: la función corre con privilegios del owner, pero filtra
-- explícitamente por p_user_id. Los callers deben pasar auth.uid() desde la
-- capa de aplicación. Para uso server-side via service_role no hay restricción.
GRANT EXECUTE ON FUNCTION public.calcular_idf_dimensions(uuid) TO authenticated;
