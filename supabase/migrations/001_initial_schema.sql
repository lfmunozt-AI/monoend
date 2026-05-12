-- Enable extensions
CREATE EXTENSION IF NOT EXISTS vector;

-- 2. supported_languages
CREATE TABLE IF NOT EXISTS public.supported_languages (
    code varchar(10) PRIMARY KEY,
    name varchar(50) NOT NULL,
    active bool DEFAULT true,
    flag_emoji varchar(10)
);

ALTER TABLE public.supported_languages ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Allow read access to everyone" ON public.supported_languages
    FOR SELECT USING (true);

INSERT INTO public.supported_languages (code, name, flag_emoji) VALUES
    ('es', 'Español', '🇪🇸'),
    ('pt', 'Português', '🇵🇹'),
    ('en', 'English', '🇬🇧'),
    ('de', 'Deutsch', '🇩🇪'),
    ('fr', 'Français', '🇫🇷'),
    ('sv', 'Svenska', '🇸🇪')
ON CONFLICT (code) DO NOTHING;

-- 1. profiles
CREATE TABLE IF NOT EXISTS public.profiles (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
    name text,
    country text,
    language varchar(10) DEFAULT 'es',
    ica_score int DEFAULT 0,
    plan varchar DEFAULT 'free',
    onboarding_done bool DEFAULT false,
    created_at timestamptz DEFAULT now(),
    UNIQUE(user_id)
);

ALTER TABLE public.profiles ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users can view own profile" ON public.profiles
    FOR SELECT USING (auth.uid() = user_id);

CREATE POLICY "Users can insert own profile" ON public.profiles
    FOR INSERT WITH CHECK (auth.uid() = user_id);

CREATE POLICY "Users can update own profile" ON public.profiles
    FOR UPDATE USING (auth.uid() = user_id);

-- 3. fiscal_profiles
CREATE TABLE IF NOT EXISTS public.fiscal_profiles (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
    country text,
    employment_type text,
    monthly_gross numeric,
    has_holiday_bonus bool DEFAULT false,
    has_christmas_bonus bool DEFAULT false,
    created_at timestamptz DEFAULT now(),
    UNIQUE(user_id)
);

ALTER TABLE public.fiscal_profiles ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users can view own fiscal profile" ON public.fiscal_profiles
    FOR SELECT USING (auth.uid() = user_id);

CREATE POLICY "Users can update own fiscal profile" ON public.fiscal_profiles
    FOR ALL USING (auth.uid() = user_id);

-- 4. transactions
CREATE TABLE IF NOT EXISTS public.transactions (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
    amount numeric NOT NULL,
    type varchar NOT NULL CHECK (type IN ('income', 'expense')),
    category text,
    power_law text,
    is_leak bool DEFAULT false,
    date date NOT NULL DEFAULT CURRENT_DATE,
    description text,
    created_at timestamptz DEFAULT now()
);

ALTER TABLE public.transactions ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users can manage own transactions" ON public.transactions
    FOR ALL USING (auth.uid() = user_id);

CREATE INDEX idx_transactions_user_id_date ON public.transactions(user_id, date);

-- 5. ica_history
CREATE TABLE IF NOT EXISTS public.ica_history (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
    score int NOT NULL,
    level varchar,
    event_trigger varchar,
    recorded_at timestamptz DEFAULT now()
);

ALTER TABLE public.ica_history ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users can view own ica history" ON public.ica_history
    FOR SELECT USING (auth.uid() = user_id);

CREATE POLICY "Users can insert own ica history" ON public.ica_history
    FOR INSERT WITH CHECK (auth.uid() = user_id);

CREATE INDEX idx_ica_history_user_id_recorded_at ON public.ica_history(user_id, recorded_at);

-- 6. conversations
CREATE TABLE IF NOT EXISTS public.conversations (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
    title text,
    created_at timestamptz DEFAULT now(),
    updated_at timestamptz DEFAULT now()
);

ALTER TABLE public.conversations ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users can manage own conversations" ON public.conversations
    FOR ALL USING (auth.uid() = user_id);

-- Trigger for updated_at
CREATE OR REPLACE FUNCTION update_updated_at()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = now();
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER conversations_updated_at
    BEFORE UPDATE ON public.conversations
    FOR EACH ROW EXECUTE FUNCTION update_updated_at();

-- 7. messages
CREATE TABLE IF NOT EXISTS public.messages (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    conversation_id uuid NOT NULL REFERENCES public.conversations(id) ON DELETE CASCADE,
    user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
    role varchar NOT NULL CHECK (role IN ('user', 'assistant')),
    content text NOT NULL,
    tokens_used int DEFAULT 0,
    created_at timestamptz DEFAULT now()
);

ALTER TABLE public.messages ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users can manage own messages" ON public.messages
    FOR ALL USING (auth.uid() = user_id);

-- 8. embeddings
CREATE TABLE IF NOT EXISTS public.embeddings (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
    content text,
    embedding vector(1536),
    metadata jsonb,
    created_at timestamptz DEFAULT now()
);

ALTER TABLE public.embeddings ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users can manage own embeddings" ON public.embeddings
    FOR ALL USING (auth.uid() = user_id);

CREATE INDEX idx_embeddings_user_id ON public.embeddings(user_id);

-- 9. subscriptions
CREATE TABLE IF NOT EXISTS public.subscriptions (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
    stripe_customer_id text,
    plan varchar,
    status varchar,
    current_period_end timestamptz,
    created_at timestamptz DEFAULT now(),
    UNIQUE(user_id)
);

ALTER TABLE public.subscriptions ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users can view own subscription" ON public.subscriptions
    FOR SELECT USING (auth.uid() = user_id);

-- 10. documents
CREATE TABLE IF NOT EXISTS public.documents (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
    filename text NOT NULL,
    type text,
    status varchar DEFAULT 'pending',
    processed_at timestamptz,
    created_at timestamptz DEFAULT now()
);

ALTER TABLE public.documents ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users can manage own documents" ON public.documents
    FOR ALL USING (auth.uid() = user_id);

-- 11. audit_logs
CREATE TABLE IF NOT EXISTS public.audit_logs (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id uuid REFERENCES auth.users(id) ON DELETE SET NULL,
    action varchar NOT NULL,
    metadata jsonb,
    created_at timestamptz DEFAULT now()
);

ALTER TABLE public.audit_logs ENABLE ROW LEVEL SECURITY;

-- Policy: INSERT only via service role (no user policy for INSERT)
-- Policy: SELECT own user
CREATE POLICY "Users can view own audit logs" ON public.audit_logs
    FOR SELECT USING (auth.uid() = user_id);

-- 12. behavioral_patterns
CREATE TABLE IF NOT EXISTS public.behavioral_patterns (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    country text,
    age_range varchar,
    pattern_type varchar,
    pattern_data jsonb,
    recorded_at timestamptz DEFAULT now()
);

-- RLS enabled but no user-specific policies (anonymized data for Data Lake)
ALTER TABLE public.behavioral_patterns ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Allow read access to service role only" ON public.behavioral_patterns
    FOR SELECT USING (false); -- Adjust if public read is needed, but prompt said "sin RLS de usuario"
