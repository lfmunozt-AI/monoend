-- Function to create profile and subscription when a new user signs up
CREATE OR REPLACE FUNCTION public.handle_new_user()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
BEGIN
  -- Insert into profiles table
  INSERT INTO public.profiles (user_id, language)
  VALUES (
    NEW.id,
    'es'::text
  );

  -- Insert into subscriptions table
  INSERT INTO public.subscriptions (user_id, plan, status)
  VALUES (
    NEW.id,
    'free'::text,
    'active'::text
  );

  RETURN NEW;
END;
$$;

-- Trigger to automatically create profile and subscription after user signup
CREATE TRIGGER on_auth_user_created
  AFTER INSERT ON auth.users
  FOR EACH ROW
  EXECUTE FUNCTION public.handle_new_user();
