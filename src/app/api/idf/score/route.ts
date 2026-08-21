import { createClient } from '@/lib/supabase/server'
import { calcularIDF, buildIdfScoreResponse, type ActiveGoalRow } from '@/lib/idf/calculator'
import { NextResponse } from 'next/server'

export async function GET() {
  const supabase = await createClient()
  const { data: { user }, error: authError } = await supabase.auth.getUser()

  if (authError || !user) {
    return NextResponse.json({ error: 'No autenticado' }, { status: 401 })
  }

  try {
    const goalRes = await supabase
      .from('goals')
      .select('title, target_amount, target_date')
      .eq('user_id', user.id)
      .eq('status', 'active')
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle()

    if (goalRes.error) {
      console.error('[idf/score] goals query failed:', goalRes.error)
      throw goalRes.error
    }

    const goal = (goalRes.data as ActiveGoalRow | null) ?? null
    const now = new Date()
    const result = await calcularIDF(user.id, { now })

    return NextResponse.json(buildIdfScoreResponse(goal, result, now), {
      headers: { 'Cache-Control': 'private, max-age=60' },
    })
  } catch (err) {
    console.error('[idf/score] unhandled error:', err)
    return NextResponse.json({ error: 'Error interno del servidor' }, { status: 500 })
  }
}
