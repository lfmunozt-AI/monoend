import { NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { exportUserData } from '@/lib/gdpr'

export async function POST() {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  try {
    const data = await exportUserData(user.id)
    return NextResponse.json(data)
  } catch (err) {
    console.error('gdpr_export error:', err)
    return NextResponse.json({ error: 'Internal error' }, { status: 500 })
  }
}
