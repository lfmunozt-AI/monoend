import { createClient } from '@/lib/supabase/server'
import { adminClient } from '@/lib/supabase/admin'
import { buildSystemPrompt } from '@/lib/prompts/consigliere'
import { callLLMWithHistory } from '@/lib/llm'
import { runGuardrail, rewriteDelegativeClosing } from '@/lib/guardrail'
import { buildVerifiedContext } from '@/lib/calculator/orchestrator'
import { detectLanguage } from '@/lib/language'
import {
  validateConsigliereOutput,
  enforceOutputPolicy,
  mentionsSpecificProduct,
} from '@/lib/llm/output-validator'
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

  const now = new Date()
  const monthStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1))
    .toISOString().split('T')[0]

  // ── Plan, perfil y contexto del usuario (todo en paralelo) ───────────────────
  // Estas seis consultas solo dependen de `user.id`: no hay razón para que
  // ninguna espere a otra. Antes, las cuatro últimas colgaban del final de la
  // cadena perfil → rate limit → conversación, y pagaban ese round-trip triple.
  const [subResult, profileResult, fiscalResult, txResult, leaksResult, icaScore] =
    await Promise.all([
      admin.from('subscriptions').select('plan, status').eq('user_id', user.id).maybeSingle(),
      admin.from('profiles')
        .select('name, country, language, ica_score, plan, onboarding_data')
        .eq('user_id', user.id)
        .maybeSingle(),
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
      // `null` en vez del fallback a profile.ica_score: `profile` aún no existe
      // aquí. El fallback se resuelve más abajo, ya con el perfil cargado.
      getICAScore(user.id).catch(() => null),
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

  // ── Historial de la conversación ─────────────────────────────────────────────
  // Única consulta de contexto que NO puede paralelizarse con las anteriores:
  // necesita `convId`, que sale de crear/resolver la conversación.
  const historyResult = await admin.from('messages')
    .select('role, content')
    .eq('conversation_id', convId)
    .order('created_at', { ascending: false })
    .limit(10)

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

  // ── M1 · Motor financiero: el código calcula, el modelo redacta ───────────────
  // `buildVerifiedContext` solo acepta un string, del que extrae hechos con el
  // mismo extractor del guardarraíl. Le añadimos los datos del perfil como texto
  // para que el motor también los vea.
  //
  // Enteros a propósito: `parseDigitAmount` usa convención es/LatAm y leería el
  // punto de "3000.00" como separador de millares → 300000.
  const datosPerfil = [
    ingresosMes > 0 ? `Ingresos ${Math.round(ingresosMes)} euros al mes` : '',
    gastosMes > 0 ? `Gastos ${Math.round(gastosMes)} euros al mes` : '',
  ].filter(Boolean).join('. ')

  const verified = buildVerifiedContext(
    datosPerfil ? `${cleanMessage}\n${datosPerfil}.` : cleanMessage,
  )

  // ── System prompt ────────────────────────────────────────────────────────────
  const basePrompt = buildSystemPrompt({
    nombre: profile.name ?? 'Usuario',
    pais,
    idioma: (profile.language ?? 'es') as 'es' | 'pt' | 'en' | 'de' | 'fr' | 'sv',
    icaScore: currentICA,
    ingresosMes,
    gastosMes,
    fugas,
    metas,
  })

  // FALLO A — idioma espejo del usuario. El perfil (profile.language) puede
  // diferir del idioma en que el usuario escribe AHORA; manda el último mensaje.
  const LANG_NAME: Record<'es' | 'pt' | 'en', string> = { es: 'ES', pt: 'PT', en: 'EN' }
  const userLang = detectLanguage(cleanMessage)
  const idiomaObligatorio =
    `IDIOMA OBLIGATORIO: el usuario escribe en ${LANG_NAME[userLang]}. ` +
    `Responde ÍNTEGRAMENTE en ese idioma.`

  // El bloque del motor ("TU REALIDAD…" / "REFERENCIAS ESTÁNDAR…") va al final:
  // son las cifras exactas que el modelo debe usar en vez de improvisar. La regla
  // de idioma va la última, para que sea lo más reciente en el contexto.
  const systemPrompt = [basePrompt, verified.bloque, idiomaObligatorio]
    .filter(Boolean)
    .join('\n\n')

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
  // maxTokens 400: el Consigliere responde en ≤120 palabras. Explícito aquí
  // aunque sea también el default de llm.ts — es una decisión de latencia del chat.
  const allMessages = [...contextMessages, { role: 'user' as const, content: cleanMessage }]
  const llmResult = await callLLMWithHistory(allMessages, systemPrompt, { maxTokens: 400 })

  // ── Guardarraíl de cifras (código externo al modelo) ─────────────────────────
  // Extrae los hechos del usuario, valida el grounding de las cifras de la
  // respuesta y, en modo mvp, reescribe los montos inventados. best-effort:
  // nunca lanza. `texto_final` es la respuesta saneada a persistir/mostrar.
  const guardrail = await runGuardrail(cleanMessage, llmResult.content, {
    mode: 'mvp',
    supabase: admin,
    userId: user.id,
    // M1: habilita la aprobación por "cálculo verificado" (rama c0 del validador).
    cifrasCalculadas: verified.cifrasCalculadas,
    // Fallo A: el cierre del guardarraíl en el idioma del usuario, no el del modelo.
    idioma: userLang,
  })
  let finalContent = guardrail.texto_final

  // M3: la señal anti-inyección no bloquea; se registra para vigilancia.
  if (guardrail.injection.detected) {
    console.warn('[chat] injection_detected', JSON.stringify({
      user_id: user.id,
      conversation_id: convId,
      patterns: guardrail.injection.patterns,
    }))
  }

  // ── Validador de política, sobre el texto ya saneado ─────────────────────────
  // El guardrail de cifras corre primero; el validador de política, después.
  // `validation.text` trae el branding corregido; `enforceOutputPolicy` hace
  // cumplir los bloqueos (C1) eliminando la oración infractora.
  const validation = validateConsigliereOutput(finalContent)
  finalContent = validation.text

  const enforced = enforceOutputPolicy(finalContent, validation)
  if (enforced !== finalContent) {
    console.warn('[chat] output_enforced', JSON.stringify({
      user_id: user.id,
      conversation_id: convId,
      severity: validation.severity,
      reasons: validation.reasons,
      removed_sentences: validation.violatingSentences.length,
    }))
  } else if (validation.severity !== 'ok') {
    console.warn('[chat] output-validator:', validation.severity, validation.reasons)
  }
  finalContent = enforced

  // Producto específico sin disclaimer → adjuntar el disclaimer canónico.
  // Solo si el producto SOBREVIVIÓ al enforcement: si su oración se eliminó, un
  // disclaimer colgando al final no protege de nada y confunde.
  if (
    validation.suggestedDisclaimer &&
    mentionsSpecificProduct(finalContent) &&
    !finalContent.includes(validation.suggestedDisclaimer)
  ) {
    finalContent = `${finalContent}\n\n${validation.suggestedDisclaimer}`
  }

  // TAREA 1 — cierre delegativo: si la respuesta cierra pidiendo al usuario que
  // analice ("¿qué gastos podrías reducir?"), se sustituye por una petición de
  // insumo + promesa de análisis, en el idioma del usuario. monoend pide el
  // dato, él analiza. Determinista; último paso para no reintroducir delegación.
  const beforeDelegative = finalContent
  finalContent = rewriteDelegativeClosing(finalContent, userLang)
  if (finalContent !== beforeDelegative) {
    console.warn('[chat] delegative_closing_rewritten', JSON.stringify({
      user_id: user.id,
      conversation_id: convId,
    }))
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
