import { createClient } from '@supabase/supabase-js'

// Server-side only — nunca importar en componentes cliente
function createServiceClient() {
  return createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
    { auth: { autoRefreshToken: false, persistSession: false } }
  )
}

export interface ConsentData {
  ip?: string
  userAgent?: string
  consentVersion?: string
}

export async function recordConsent(userId: string, consentData: ConsentData): Promise<void> {
  const supabase = createServiceClient()

  const { error } = await supabase.from('consent_records').upsert(
    {
      user_id: userId,
      consented_at: new Date().toISOString(),
      revoked_at: null,
      ip_address: consentData.ip ?? null,
      user_agent: consentData.userAgent ?? null,
      consent_version: consentData.consentVersion ?? '1.0',
    },
    { onConflict: 'user_id' }
  )
  if (error) throw error

  await supabase.from('audit_logs').insert({
    user_id: userId,
    action: 'gdpr_consent_recorded',
    metadata: { consent_version: consentData.consentVersion ?? '1.0', ip: consentData.ip },
  })
}

export async function hasConsent(userId: string): Promise<boolean> {
  const supabase = createServiceClient()
  const { data, error } = await supabase
    .from('consent_records')
    .select('user_id')
    .eq('user_id', userId)
    .is('revoked_at', null)
    .maybeSingle()
  if (error) throw error
  return data !== null
}

export async function revokeConsent(userId: string): Promise<void> {
  const supabase = createServiceClient()
  const { error } = await supabase
    .from('consent_records')
    .update({ revoked_at: new Date().toISOString() })
    .eq('user_id', userId)
    .is('revoked_at', null)
  if (error) throw error

  await supabase.from('audit_logs').insert({
    user_id: userId,
    action: 'gdpr_consent_revoked',
    metadata: {},
  })
}

export async function exportUserData(userId: string): Promise<Record<string, unknown>> {
  const supabase = createServiceClient()

  const [profile, fiscal, transactions, ica, conversations, documents, subscription] =
    await Promise.all([
      supabase.from('profiles').select('*').eq('user_id', userId).maybeSingle(),
      supabase.from('fiscal_profiles').select('*').eq('user_id', userId).maybeSingle(),
      supabase.from('transactions').select('*').eq('user_id', userId),
      supabase.from('ica_history').select('*').eq('user_id', userId),
      supabase.from('conversations').select('id, title, created_at, updated_at').eq('user_id', userId),
      supabase.from('documents').select('*').eq('user_id', userId),
      supabase.from('subscriptions').select('id, plan, status, current_period_end, created_at').eq('user_id', userId).maybeSingle(),
    ])

  await supabase.from('audit_logs').insert({
    user_id: userId,
    action: 'gdpr_data_exported',
    metadata: { exported_at: new Date().toISOString() },
  })

  return {
    exported_at: new Date().toISOString(),
    profile: profile.data,
    fiscal_profile: fiscal.data,
    transactions: transactions.data ?? [],
    ica_history: ica.data ?? [],
    conversations: conversations.data ?? [],
    documents: documents.data ?? [],
    subscription: subscription.data,
  }
}

export async function scheduleAccountDeletion(userId: string): Promise<Date> {
  const supabase = createServiceClient()
  const deletionDate = new Date()
  deletionDate.setDate(deletionDate.getDate() + 30)

  const { error } = await supabase
    .from('profiles')
    .update({ deletion_scheduled_at: deletionDate.toISOString() })
    .eq('user_id', userId)
  if (error) throw error

  await supabase.from('audit_logs').insert({
    user_id: userId,
    action: 'gdpr_deletion_scheduled',
    metadata: { deletion_date: deletionDate.toISOString() },
  })

  return deletionDate
}
