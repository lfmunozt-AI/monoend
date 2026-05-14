import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { parseAmount, parseISODate } from '@/lib/transactions-validation'

type RouteContext = { params: Promise<{ id: string }> }

function isValidUUID(s: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(s)
}

// ─── GET /api/transactions/[id] ───────────────────────────────────────────────

export async function GET(_request: NextRequest, { params }: RouteContext) {
  const { id } = await params
  if (!isValidUUID(id)) return NextResponse.json({ error: 'ID inválido' }, { status: 400 })

  const supabase = await createClient()
  const { data: { user }, error: authError } = await supabase.auth.getUser()
  if (authError || !user) return NextResponse.json({ error: 'No autenticado' }, { status: 401 })

  const { data, error } = await supabase
    .from('transactions')
    .select('*')
    .eq('id', id)
    .eq('user_id', user.id) // explicit: no confiar sólo en RLS para 404 vs 403
    .maybeSingle()

  if (error) {
    console.error('[transactions/GET/:id]', { code: error.code, message: error.message })
    return NextResponse.json({ error: 'Error al obtener transacción' }, { status: 500 })
  }
  if (!data) return NextResponse.json({ error: 'Transacción no encontrada' }, { status: 404 })

  return NextResponse.json(data)
}

// ─── PUT /api/transactions/[id] ───────────────────────────────────────────────

export async function PUT(request: NextRequest, { params }: RouteContext) {
  const { id } = await params
  if (!isValidUUID(id)) return NextResponse.json({ error: 'ID inválido' }, { status: 400 })

  const supabase = await createClient()
  const { data: { user }, error: authError } = await supabase.auth.getUser()
  if (authError || !user) return NextResponse.json({ error: 'No autenticado' }, { status: 401 })

  let body: Record<string, unknown>
  try {
    body = await request.json()
  } catch {
    return NextResponse.json({ error: 'Body JSON inválido' }, { status: 400 })
  }

  // Whitelist de campos actualizables (type y user_id son inmutables)
  const MUTABLE = ['amount', 'description', 'date', 'category', 'is_leak', 'power_law'] as const
  const updates: Record<string, unknown> = {}

  for (const key of MUTABLE) {
    if (!(key in body)) continue

    if (key === 'amount') {
      const n = parseAmount(body[key])
      if (!n) return NextResponse.json({ error: 'amount debe ser un número positivo' }, { status: 400 })
      updates[key] = n
    } else if (key === 'date') {
      const d = parseISODate(body[key])
      if (!d) return NextResponse.json({ error: 'date inválida (usa formato YYYY-MM-DD)' }, { status: 400 })
      updates[key] = d
    } else if (key === 'description') {
      const s = typeof body[key] === 'string' ? (body[key] as string).trim().slice(0, 500) : null
      if (!s) return NextResponse.json({ error: 'description no puede estar vacía' }, { status: 400 })
      updates[key] = s
    } else {
      updates[key] = body[key]
    }
  }

  if (Object.keys(updates).length === 0) {
    return NextResponse.json({ error: 'No se proporcionaron campos válidos para actualizar' }, { status: 400 })
  }

  const { data, error } = await supabase
    .from('transactions')
    .update(updates)
    .eq('id', id)
    .eq('user_id', user.id)
    .select()
    .maybeSingle()

  if (error) {
    console.error('[transactions/PUT/:id]', { code: error.code, message: error.message })
    return NextResponse.json({ error: 'Error al actualizar transacción' }, { status: 500 })
  }
  if (!data) return NextResponse.json({ error: 'Transacción no encontrada' }, { status: 404 })

  return NextResponse.json(data)
}

// ─── DELETE /api/transactions/[id] ────────────────────────────────────────────

export async function DELETE(_request: NextRequest, { params }: RouteContext) {
  const { id } = await params
  if (!isValidUUID(id)) return NextResponse.json({ error: 'ID inválido' }, { status: 400 })

  const supabase = await createClient()
  const { data: { user }, error: authError } = await supabase.auth.getUser()
  if (authError || !user) return NextResponse.json({ error: 'No autenticado' }, { status: 401 })

  // Verificar existencia antes de borrar para devolver 404 correcto
  const { data: existing } = await supabase
    .from('transactions')
    .select('id')
    .eq('id', id)
    .eq('user_id', user.id)
    .maybeSingle()

  if (!existing) return NextResponse.json({ error: 'Transacción no encontrada' }, { status: 404 })

  const { error } = await supabase
    .from('transactions')
    .delete()
    .eq('id', id)
    .eq('user_id', user.id)

  if (error) {
    console.error('[transactions/DELETE/:id]', { code: error.code, message: error.message })
    return NextResponse.json({ error: 'Error al eliminar transacción' }, { status: 500 })
  }

  return new NextResponse(null, { status: 204 })
}
