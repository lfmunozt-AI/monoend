-- GDPR: tabla de consentimientos explícitos
CREATE TABLE IF NOT EXISTS public.consent_records (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
    consented_at timestamptz NOT NULL DEFAULT now(),
    revoked_at timestamptz,
    ip_address text,
    user_agent text,
    consent_version varchar(10) NOT NULL DEFAULT '1.0',
    UNIQUE(user_id)
);

ALTER TABLE public.consent_records ENABLE ROW LEVEL SECURITY;

-- Sólo lectura para el usuario propietario; escritura exclusiva del service role
CREATE POLICY "Users can view own consent" ON public.consent_records
    FOR SELECT USING (auth.uid() = user_id);

-- GDPR: campo de eliminación programada en profiles
ALTER TABLE public.profiles
    ADD COLUMN IF NOT EXISTS deletion_scheduled_at timestamptz;

-- Índice para el job de eliminación programada
CREATE INDEX IF NOT EXISTS idx_profiles_deletion_scheduled
    ON public.profiles(deletion_scheduled_at)
    WHERE deletion_scheduled_at IS NOT NULL;
