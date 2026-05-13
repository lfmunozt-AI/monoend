-- Add onboarding_data column to profiles for flexible onboarding metadata storage
ALTER TABLE public.profiles
    ADD COLUMN IF NOT EXISTS onboarding_data jsonb;
