import { NextResponse } from 'next/server'
import { headers } from 'next/headers'
import { createClient } from '@/lib/supabase/server'
import { recordConsent } from '@/lib/gdpr'

export async function POST() {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const headersList = await headers()
  const ip = headersList.get('x-forwarded-for') ?? undefined
  const userAgent = headersList.get('user-agent') ?? undefined

  try {
    await recordConsent(user.id, { ip, userAgent })
    return NextResponse.json({ ok: true })
  } catch (err) {
    const detail = err instanceof Error
      ? { message: err.message, stack: err.stack }
      : JSON.stringify(err)
    console.error('[gdpr/consent] error recording consent for user', user.id, detail)
    return NextResponse.json({ error: 'Internal error' }, { status: 500 })
  }
}
