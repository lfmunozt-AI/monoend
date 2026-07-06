import { createClient } from '@/lib/supabase/server'
import { adminClient } from '@/lib/supabase/admin'
import { buildSystemPrompt } from '@/lib/prompts/consigliere'
import { callLLMWithHistory } from '@/lib/llm'
import { runGuardrail } from '@/lib/guardrail'
import { validateConsigliereOutput } from '@/lib/llm/output-validator'
import { getICAScore } from '@/lib/ica-service'
import { getICALevel } from '@/lib/ica'
import { NextResponse } from 'next/server'

const RATE_LIMIT_FREE = 20

export async function POST(request: Request) {
  // ── Auth ────────────────────────────────────────────────────────────────────
  const supabase = await createClient()
  const { data: { user }, error: authError } = await supabase.auth.getUser()
  if (authError || !user) {
    return NextResponse.json({ error: 'No autenticado' }, { status: 401 })
  }

  // ── Parse body ──────────────────────────────────────────────────────────────
  let message: string
  let conversationId: string | undefined
  try {
    const body = await request.json() as { message?: unknown; conversationId?: unknown }
    message = typeof body?.message === 'string' ? body.message : ''
    conversationId = typeof body?.conversationId === 'string' ? body.conversationId : undefined
  } catch {
    return NextResponse.json({ error: 'Body JSON inválido' }, { status: 400 })
  }

  const cleanMessage = message.trim().substring(0, 4000)
  if (!cleanMessage) {
    return NextResponse.json({ error: 'El mensaje no puede estar vacío' }, { status: 400 })
  }

  const admin = adminClient()

  // ── Plan + perfil (parallel) ─────────────────────────────────────────────────
  const [subResult, profileResult] = await Promise.all([
    admin.from('subscriptions').select('plan, status').eq('user_id', user.id).maybeSingle(),
    admin.from('profiles')
      .select('name, country, language, ica_score, plan, onboarding_data')
      .eq('user_id', user.id)
      .maybeSingle(),
  ])

  if (profileResult.error || !profileResult.data) {
    return NextResponse.json({ error: 'Perfil no encontrado' }, { status: 404 })
  }

  const profile = profileResult.data as {
    name: string | null
    country: string | null
    language: string | null
    ica_score: number | null
    plan: string | null
    onboarding_data: Record<string, unknown> | null
  }
  const sub = subResult.data as { plan: string | null; status: string | null } | null
  const isActiveSub = sub?.status === 'active' || sub?.status === 'trialing'
  const plan: string = (isActiveSub && sub?.plan) ? sub.plan : (profile.plan ?? 'free')

  // ── Rate limit (solo plan free) ──────────────────────────────────────────────
  if (plan === 'free') {
    const todayUTC = new Date()
    todayUTC.setUTCHours(0, 0, 0, 0)
    const { count, error: countErr } = await admin
      .from('messages')
      .select('*', { count: 'exact', head: true })
      .eq('user_id', user.id)
      .eq('role', 'user')
      .gte('created_at', todayUTC.toISOString())

    if (!countErr && (count ?? 0) >= RATE_LIMIT_FREE) {
      return NextResponse.json(
        { error: `Límite diario alcanzado. El plan gratuito permite ${RATE_LIMIT_FREE} consultas por día.` },
        { status: 429 },
      )
    }
  }

  // ── Conversación: obtener o crear ────────────────────────────────────────────
  let convId: string
  if (!conversationId) {
    const { data: newConv, error: convErr } = await admin
      .from('conversations')
      .insert({ user_id: user.id, title: cleanMessage.substring(0, 80) })
      .select('id')
      .single()
    if (convErr || !newConv) {
      console.error('[chat] crear conversación:', convErr)
      return NextResponse.json({ error: 'Error al crear la conversación' }, { status: 500 })
    }
    convId = (newConv as { id: string }).id
  } else {
    const { data: conv } = await admin
      .from('conversations')
      .select('id')
      .eq('id', conversationId)
      .eq('user_id', user.id)
      .maybeSingle()
    if (!conv) {
      return NextResponse.json({ error: 'Conversación no encontrada' }, { status: 404 })
    }
    convId = (conv as { id: string }).id
  }

  // ── Contexto del usuario (parallel) ─────────────────────────────────────────
  const now = new Date()
  const monthStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1))
    .toISOString().split('T')[0]

  const [historyResult, fiscalResult, txResult, leaksResult, icaScore] = await Promise.all([
    admin.from('messages')
      .select('role, content')
      .eq('conversation_id', convId)
      .order('created_at', { ascending: false })
      .limit(10),
    admin.from('fiscal_profiles')
      .select('country, monthly_gross')
      .eq('user_id', user.id)
      .maybeSingle(),
    admin.from('transactions')
      .select('type, amount')
      .eq('user_id', user.id)
      .gte('date', monthStart),
    admin.from('transactions')
      .select('description, amount, category')
      .eq('user_id', user.id)
      .eq('is_leak', true)
      .order('date', { ascending: false })
      .limit(5),
    getICAScore(user.id).catch(() => (profile.ica_score ?? 0)),
  ])

  // Historial en orden cronológico para el contexto del LLM
  const contextMessages = ((historyResult.data ?? []) as Array<{ role: string; content: string }>)
    .reverse()
    .map((m) => ({ role: m.role as 'user' | 'assistant', content: m.content }))

  let ingresosMes = 0
  let gastosMes = 0
  for (const t of (txResult.data ?? []) as Array<{ type: string; amount: unknown }>) {
    const amount = Number(t.amount)
    if (t.type === 'income') ingresosMes += amount
    else gastosMes += amount
  }

  const leakRows = (leaksResult.data ?? []) as Array<{
    description?: string | null
    amount: unknown
    category?: string | null
  }>
  const fugas = leakRows.map((l) =>
    `${l.description ?? l.category ?? 'sin descripción'} (${Number(l.amount).toFixed(2)}€)`
  )

  const fiscal = fiscalResult.data as { country?: string | null } | null
  const metas = profile.onboarding_data?.main_goal
    ? [String(profile.onboarding_data.main_goal)]
    : []

  const pais = fiscal?.country ?? profile.country ?? 'desconocido'
  const currentICA = typeof icaScore === 'number' ? icaScore : (profile.ica_score ?? 0)

  // ── System prompt ────────────────────────────────────────────────────────────
  const systemPrompt = buildSystemPrompt({
    nombre: profile.name ?? 'Usuario',
    pais,
    idioma: (profile.language ?? 'es') as 'es' | 'pt' | 'en' | 'de' | 'fr' | 'sv',
    icaScore: currentICA,
    ingresosMes,
    gastosMes,
    fugas,
    metas,
  })

  // ── Guardar mensaje del usuario ──────────────────────────────────────────────
  const { error: userMsgErr } = await admin.from('messages').insert({
    conversation_id: convId,
    user_id: user.id,
    role: 'user',
    content: cleanMessage,
    tokens_used: 0,
  })
  if (userMsgErr) {
    console.error('[chat] guardar mensaje usuario:', userMsgErr)
  }

  // ── Llamar al LLM ────────────────────────────────────────────────────────────
  const allMessages = [...contextMessages, { role: 'user' as const, content: cleanMessage }]
  const llmResult = await callLLMWithHistory(allMessages, systemPrompt)

  // ── Guardarraíl de cifras (código externo al modelo) ─────────────────────────
  // Extrae los hechos del usuario, valida el grounding de las cifras de la
  // respuesta y, en modo mvp, reescribe los montos inventados. best-effort:
  // nunca lanza. `texto_final` es la respuesta saneada a persistir/mostrar.
  const guardrail = await runGuardrail(cleanMessage, llmResult.content, {
    mode: 'mvp',
    supabase: admin,
    userId: user.id,
  })
  let finalContent = guardrail.texto_final

  // ── BONUS: validador de política de consejos, sobre el texto ya saneado ──────
  // El guardrail de cifras corre primero; el validador de política, después,
  // ambos sobre `finalContent`. Función pura: solo detecta y reporta.
  const validation = validateConsigliereOutput(finalContent)
  if (validation.severity !== 'ok') {
    console.warn('[chat] output-validator:', validation.severity, validation.reasons)
  }
  // Producto específico sin disclaimer → adjuntar el disclaimer canónico
  // (enforcement determinista, sin segunda llamada al LLM, no bloqueante).
  if (validation.suggestedDisclaimer && !finalContent.includes(validation.suggestedDisclaimer)) {
    finalContent = `${finalContent}\n\n${validation.suggestedDisclaimer}`
  }

  // ── Guardar respuesta + actualizar conversación (parallel) ───────────────────
  const [assistantMsgResult, updateConvResult] = await Promise.all([
    admin.from('messages').insert({
      conversation_id: convId,
      user_id: user.id,
      role: 'assistant',
      content: finalContent,
      tokens_used: llmResult.tokensUsed,
    }),
    admin.from('conversations')
      .update({ updated_at: new Date().toISOString() })
      .eq('id', convId),
  ])

  if (assistantMsgResult.error) {
    console.error('[chat] guardar respuesta asistente:', assistantMsgResult.error)
  }
  if (updateConvResult.error) {
    console.error('[chat] actualizar conversación:', updateConvResult.error)
  }

  // ── ICA +2 por consulta al Consigliere (no crítico) ──────────────────────────
  try {
    const newScore = Math.min(100, currentICA + 2)
    const level = getICALevel(newScore)
    await Promise.all([
      admin.from('ica_history').insert({
        user_id: user.id,
        score: newScore,
        level,
        event_trigger: 'chat_consulta',
      }),
      admin.from('profiles').update({ ica_score: newScore }).eq('user_id', user.id),
    ])
  } catch (err) {
    console.error('[chat] actualizar ICA (no crítico):', err)
  }

  return NextResponse.json({
    response: finalContent,
    conversationId: convId,
    tokensUsed: llmResult.tokensUsed,
  })
}
