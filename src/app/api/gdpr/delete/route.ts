import { NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { scheduleAccountDeletion } from '@/lib/gdpr'

export async function POST() {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  try {
    const deletionDate = await scheduleAccountDeletion(user.id)
    return NextResponse.json({ deletion_date: deletionDate.toISOString() })
  } catch (err) {
    console.error('gdpr_delete error:', err)
    return NextResponse.json({ error: 'Internal error' }, { status: 500 })
  }
}
