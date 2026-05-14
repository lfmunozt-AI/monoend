import { createClient } from '@/lib/supabase/server'
import { getICAScore, updateICAScore, isValidEvento, VALID_EVENTOS } from '@/lib/ica-service'
import { NextResponse } from 'next/server'

export async function GET() {
  const supabase = await createClient()
  const { data: { user }, error: authError } = await supabase.auth.getUser()

  if (authError || !user) {
    return NextResponse.json({ error: 'No autenticado' }, { status: 401 })
  }

  try {
    const now = new Date()
    const monthStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1))
      .toISOString()
      .split('T')[0]

    // ICA score: fallback a 0 si ica_history no existe o service key no está configurada
    let score = 0
    try {
      score = await getICAScore(user.id)
    } catch (icaErr) {
      console.error('[ica/score] getICAScore failed — check SUPABASE_SERVICE_ROLE_KEY and ica_history table:', icaErr)
    }

    const txResult = await supabase
      .from('transactions')
      .select('type, amount, is_leak')
      .eq('user_id', user.id)
      .gte('date', monthStart)

    if (txResult.error) {
      console.error('[ica/score] transactions query failed:', txResult.error)
      throw txResult.error
    }

    const txs = txResult.data
    let monthlyIncome = 0
    let monthlyExpenses = 0
    let leaksCount = 0
    let leaksAmount = 0

    for (const t of txs) {
      const amount = Number(t.amount)
      if (t.type === 'income') {
        monthlyIncome += amount
      } else {
        monthlyExpenses += amount
        if (t.is_leak) {
          leaksCount++
          leaksAmount += amount
        }
      }
    }

    return NextResponse.json({
      score,
      metrics: {
        monthlyIncome,
        monthlyExpenses,
        savings: monthlyIncome - monthlyExpenses,
        leaksDetected: leaksCount,
        leaksAmount,
      },
      powerLeaks: {
        count: leaksCount,
        totalAmount: leaksAmount,
        leaks: [],
      },
    }, {
      headers: { 'Cache-Control': 'private, max-age=60' },
    })
  } catch (err) {
    console.error('[ica/score] unhandled error:', err)
    return NextResponse.json({ error: 'Error interno del servidor' }, { status: 500 })
  }
}

export async function POST(request: Request) {
  const supabase = await createClient()
  const { data: { user }, error: authError } = await supabase.auth.getUser()

  if (authError || !user) {
    return NextResponse.json({ error: 'No autenticado' }, { status: 401 })
  }

  let evento: string
  try {
    const body = await request.json()
    evento = body?.evento
  } catch {
    return NextResponse.json({ error: 'Body JSON inválido' }, { status: 400 })
  }

  if (!evento || !isValidEvento(evento)) {
    return NextResponse.json(
      { error: 'Evento inválido', valid: VALID_EVENTOS },
      { status: 400 },
    )
  }

  try {
    const score = await updateICAScore(user.id, evento)
    return NextResponse.json({ score })
  } catch (err) {
    console.error('Error updating ICA score:', err)
    return NextResponse.json({ error: 'Error interno del servidor' }, { status: 500 })
  }
}
