import { createClient, SupabaseClient } from '@supabase/supabase-js'

// Singleton — safe across requests within the same warm serverless instance.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let _client: SupabaseClient<any> | undefined

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function adminClient(): SupabaseClient<any> {
  if (!_client) {
    _client = createClient(
      process.env.NEXT_PUBLIC_SUPABASE_URL!,
      process.env.SUPABASE_SERVICE_ROLE_KEY!,
      { auth: { autoRefreshToken: false, persistSession: false } },
    )
  }
  return _client
}
