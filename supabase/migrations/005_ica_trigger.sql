-- Migration 005: ICA triggers
-- Actualiza ica_history y profiles.ica_score automáticamente cuando:
--   1. Se inserta una transacción (transaccion_registrada +5)
--   2. Se completa el onboarding en profiles (onboarding_completado +20)

-- ─── Función auxiliar: nivel ICA ────────────────────────────────────────────

CREATE OR REPLACE FUNCTION fn_ica_level(p_score int)
RETURNS text
LANGUAGE sql
IMMUTABLE
AS $$
  SELECT CASE
    WHEN p_score <= 30 THEN 'ceguera'
    WHEN p_score <= 70 THEN 'vision'
    ELSE 'soberania'
  END;
$$;

-- ─── Trigger 1: nueva transacción → +5 ICA ──────────────────────────────────

CREATE OR REPLACE FUNCTION fn_ica_on_transaction()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_current int;
  v_new     int;
BEGIN
  SELECT score INTO v_current
    FROM ica_history
   WHERE user_id = NEW.user_id
   ORDER BY recorded_at DESC
   LIMIT 1;

  v_current := COALESCE(v_current, 0);
  v_new     := LEAST(100, v_current + 5);

  INSERT INTO ica_history (user_id, score, level, event_trigger)
  VALUES (NEW.user_id, v_new, fn_ica_level(v_new), 'transaccion_registrada');

  UPDATE profiles SET ica_score = v_new WHERE user_id = NEW.user_id;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_ica_on_transaction ON public.transactions;

CREATE TRIGGER trg_ica_on_transaction
  AFTER INSERT ON public.transactions
  FOR EACH ROW
  EXECUTE FUNCTION fn_ica_on_transaction();

-- ─── Trigger 2: onboarding completado → +20 ICA ─────────────────────────────
-- Usamos BEFORE UPDATE para poder modificar NEW.ica_score en el mismo UPDATE,
-- evitando un segundo UPDATE que reactivaría el trigger.

CREATE OR REPLACE FUNCTION fn_ica_on_onboarding()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_current int;
  v_new     int;
BEGIN
  IF OLD.onboarding_done IS DISTINCT FROM true AND NEW.onboarding_done = true THEN
    SELECT score INTO v_current
      FROM ica_history
     WHERE user_id = NEW.user_id
     ORDER BY recorded_at DESC
     LIMIT 1;

    v_current := COALESCE(v_current, 0);
    v_new     := LEAST(100, v_current + 20);

    INSERT INTO ica_history (user_id, score, level, event_trigger)
    VALUES (NEW.user_id, v_new, fn_ica_level(v_new), 'onboarding_completado');

    NEW.ica_score := v_new;
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_ica_on_onboarding ON public.profiles;

CREATE TRIGGER trg_ica_on_onboarding
  BEFORE UPDATE ON public.profiles
  FOR EACH ROW
  EXECUTE FUNCTION fn_ica_on_onboarding();
