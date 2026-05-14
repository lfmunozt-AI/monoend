import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { callLLMJson } from '@/lib/llm'
import { buildCategorizationPrompt, type CategorizacionResultado } from '@/lib/prompts/categorizar'
import { generateEmbedding, storeEmbedding } from '@/lib/embeddings'
import { parseAmount, parseType, parseISODate, parseCursor } from '@/lib/transactions-validation'

export { parseAmount, parseType, parseISODate, parseCursor }

const DEFAULT_LIMIT = 30
const MAX_LIMIT = 100

// ─── GET /api/transactions ────────────────────────────────────────────────────

export async function GET(request: NextRequest) {
  const supabase = await createClient()
  const { data: { user }, error: authError } = await supabase.auth.getUser()
  if (authError || !user) {
    return NextResponse.json({ error: 'No autenticado' }, { status: 401 })
  }

  const { searchParams } = request.nextUrl
  const rawLimit = parseInt(searchParams.get('limit') ?? String(DEFAULT_LIMIT), 10)
  const limit = Math.min(isNaN(rawLimit) || rawLimit < 1 ? DEFAULT_LIMIT : rawLimit, MAX_LIMIT)
  const cursor = parseCursor(searchParams.get('cursor'))

  let query = supabase
    .from('transactions')
    .select('id, amount, type, category, power_law, is_leak, date, description, created_at')
    .eq('user_id', user.id)
    .order('created_at', { ascending: false })
    .order('id', { ascending: false })
    .limit(limit + 1) // one extra to detect hasMore

  if (cursor) {
    // Rows after cursor: created_at < cursorDate OR (same date AND id < cursorId)
    query = query.or(
      `created_at.lt.${cursor.date},and(created_at.eq.${cursor.date},id.lt.${cursor.id})`
    )
  }

  const { data, error } = await query

  if (error) {
    console.error('[transactions/GET]', { code: error.code, message: error.message })
    return NextResponse.json({ error: 'Error al obtener transacciones' }, { status: 500 })
  }

  const hasMore = data.length > limit
  const items = hasMore ? data.slice(0, limit) : data
  const last = items[items.length - 1]
  const nextCursor = hasMore && last ? `${last.created_at}|${last.id}` : null

  return NextResponse.json({ items, nextCursor, hasMore, count: items.length })
}

// ─── POST /api/transactions ───────────────────────────────────────────────────

export async function POST(request: NextRequest) {
  const supabase = await createClient()
  const { data: { user }, error: authError } = await supabase.auth.getUser()
  if (authError || !user) {
    return NextResponse.json({ error: 'No autenticado' }, { status: 401 })
  }

  let body: Record<string, unknown>
  try {
    body = await request.json()
  } catch {
    return NextResponse.json({ error: 'Body JSON inválido' }, { status: 400 })
  }

  // Validation
  const amount = parseAmount(body.amount)
  const type = parseType(body.type)
  const description = typeof body.description === 'string'
    ? body.description.trim().slice(0, 500)
    : null
  const date = parseISODate(body.date) ?? new Date().toISOString().split('T')[0]

  if (!amount) return NextResponse.json({ error: 'amount debe ser un número positivo' }, { status: 400 })
  if (!type) return NextResponse.json({ error: 'type debe ser "income" o "expense"' }, { status: 400 })
  if (!description) return NextResponse.json({ error: 'description es requerida' }, { status: 400 })

  // Categorization (LLM — solo para gastos, non-blocking on failure)
  let category = 'otros'
  let isLeak = false
  let powerLaw = 'Ley Neutral'

  if (type === 'expense') {
    const prompt = buildCategorizationPrompt(description, amount)
    const result = await callLLMJson<CategorizacionResultado>(
      prompt,
      'Eres un categorizador de transacciones financieras. Responde únicamente con JSON válido.',
    )
    if (result) {
      category = result.categoria ?? 'otros'
      isLeak = result.is_leak ?? false
      powerLaw = result.power_law ?? 'Ley Neutral'
    }
  } else {
    // income: categoría inferida de la descripción
    category = /freelance|factura|cliente/i.test(description) ? 'freelance' : 'salario'
    powerLaw = 'Ley del Dominio'
  }

  // Insert transaction (RLS enforced by server client session)
  const { data: tx, error: txError } = await supabase
    .from('transactions')
    .insert({
      user_id: user.id,
      amount,
      type,
      category,
      power_law: powerLaw,
      is_leak: isLeak,
      date,
      description,
    })
    .select()
    .single()

  if (txError || !tx) {
    console.error('[transactions/POST] insert failed:', {
      code: txError?.code,
      message: txError?.message,
    })
    return NextResponse.json({ error: 'Error al guardar la transacción' }, { status: 500 })
  }

  // Embedding — fire & forget (no bloquea la respuesta)
  const embeddingText = `${type} ${amount}€ ${category} ${description} ${date}`
  generateEmbedding(embeddingText)
    .then(embedding =>
      storeEmbedding(user.id, embeddingText, embedding, {
        transaction_id: tx.id,
        type,
        category,
        amount,
        date,
        is_leak: isLeak,
      }),
    )
    .catch(err => console.error('[transactions/POST] embedding failed:', err))

  return NextResponse.json(tx, { status: 201 })
}
