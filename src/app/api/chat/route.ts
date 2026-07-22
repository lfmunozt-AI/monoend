import { createClient } from '@/lib/supabase/server'
import { adminClient } from '@/lib/supabase/admin'
import { buildSystemPrompt } from '@/lib/prompts/consigliere'
import { callLLMWithTools } from '@/lib/llm'
import {
  runGuardrail,
  ensureSubstance,
  resolveClosing,
  enforceSimulationHonesty,
  classifyTurn,
  detectInjection,
  assertOutputInvariants,
} from '@/lib/guardrail'
import { buildScenarioContext } from '@/lib/calculator/orchestrator'
import { mergeScenario, summarizeScenario, type ScenarioState } from '@/lib/calculator/scenario'
import { registrarDatosFinancieros, resolveDelta, buildToolResult } from '@/lib/calculator/tools'
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

// user_ids exentos del rate limit incluso en Production (admins/QA). Se leen de
// la env var ADMIN_USER_IDS (coma-separada) para eximir a alguien en PRD sin
// tocar código — basta añadir su user_id en Vercel.
const ADMIN_USER_IDS = (process.env.ADMIN_USER_IDS ?? '')
  .split(',')
  .map((id) => id.trim())
  .filter(Boolean)

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
  // Excepción por entorno/rol: fuera de Production (Preview/dev), con el
  // interruptor manual RATE_LIMIT_DISABLED, o si el user_id es admin/QA. La
  // protección de coste real (20/día) sigue intacta para usuarios reales en PRD.
  const skipLimit =
    process.env.VERCEL_ENV !== 'production' ||
    process.env.RATE_LIMIT_DISABLED === 'true' ||
    ADMIN_USER_IDS.includes(user.id)

  if (skipLimit) {
    console.warn('[chat] rate_limit_skipped', JSON.stringify({
      user_id: user.id,
      reason:
        process.env.VERCEL_ENV !== 'production' ? 'non_production'
        : process.env.RATE_LIMIT_DISABLED === 'true' ? 'disabled_switch'
        : 'admin_user',
    }))
  }

  if (!skipLimit && plan === 'free') {
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
  let prevScenario: Partial<ScenarioState> = {}
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
      .select('id, scenario_state')
      .eq('id', conversationId)
      .eq('user_id', user.id)
      .maybeSingle()
    if (!conv) {
      return NextResponse.json({ error: 'Conversación no encontrada' }, { status: 404 })
    }
    convId = (conv as { id: string }).id
    // El motor recuerda: el escenario acumulado del diálogo (migración 010).
    prevScenario = ((conv as { scenario_state?: Partial<ScenarioState> }).scenario_state) ?? {}
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

  // ── SCENARIO STATE · el motor calcula desde el estado completo del diálogo ────
  const userLang = detectLanguage(cleanMessage)
  // Semilla: el perfil (transacciones del mes) rellena ingreso/gasto si los hay.
  const seed: Partial<ScenarioState> = { ...prevScenario }
  if (ingresosMes > 0) seed.ingreso_mensual = Math.round(ingresosMes)
  if (gastosMes > 0) seed.gastos_mensuales = Math.round(gastosMes)

  // ── CARRIL (Pieza 1-2) ───────────────────────────────────────────────────────
  // Causa raíz QA: el pipeline solo conocía UN modo (turno de cálculo). A "¿qué
  // modelo eres?" el guardarraíl de cifras juzgó la respuesta como esqueleto y la
  // sustituyó por el enlatado de missing[0]. La jaula de cifras solo debe
  // aplicarse a la PARTE financiera de la conversación. Se clasifica con el
  // estado PREVIO (seed): el mensaje del turno actual ya trae su propia señal
  // financiera/META en el texto; el escenario solo desempata cuando no hay
  // ninguna ("ninguno", "ok").
  const carril = classifyTurn(cleanMessage, seed, userLang)
  console.warn('[chat] carril', JSON.stringify({ user_id: user.id, conversation_id: convId, carril }))

  // ── System prompt (persona + idioma espejo) ──────────────────────────────────
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
  const LANG_NAME: Record<'es' | 'pt' | 'en', string> = { es: 'ES', pt: 'PT', en: 'EN' }
  const idiomaObligatorio =
    `IDIOMA OBLIGATORIO: el usuario escribe en ${LANG_NAME[userLang]}. ` +
    `Responde ÍNTEGRAMENTE en ese idioma.`

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

  // ── EXTRACCIÓN por function calling (el LLM extrae, el código calcula) ─────────
  // LLAMADA 1: el modelo emite un tool_call con los datos del mensaje, o no lo
  // emite si no hay datos nuevos. El bloque "ESTADO ACTUAL CONOCIDO" le da el
  // contexto previo para responder charla trivial sin una segunda llamada.
  const allMessages = [...contextMessages, { role: 'user' as const, content: cleanMessage }]
  const systemPrompt1 = [
    basePrompt,
    `ESTADO ACTUAL CONOCIDO (lo que ya sabemos del usuario):\n${summarizeScenario(seed)}`,
    idiomaObligatorio,
  ].filter(Boolean).join('\n\n')

  // BONUS de latencia/coste (Pieza 2): en META no hay nada financiero que
  // extraer — una sola llamada, sin tool, con presupuesto de tokens de
  // respuesta completa (no de mero tool_call).
  const call1 = await callLLMWithTools(
    allMessages,
    systemPrompt1,
    [registrarDatosFinancieros],
    carril === 'META'
      ? { maxTokens: 400, toolChoice: 'none' }
      : { maxTokens: 150 },
  )

  // Paso 3: delta del tool_call, o FALLBACK a la extracción regex (se conserva).
  // META nunca extrae: no hay tool_call (toolChoice 'none') y no tiene sentido
  // correr el fallback regex sobre una charla trivial.
  const toolCall = carril === 'META'
    ? undefined
    : call1.toolCalls.find((t) => t.name === 'registrar_datos_financieros')
  const { delta, usedTool } = carril === 'META'
    ? { delta: {}, usedTool: false }
    : resolveDelta({ toolArgs: toolCall?.args, message: cleanMessage, lang: userLang, prev: seed })
  console.log(`[chat] ${usedTool ? 'toolCall usado' : 'fallback-regex'}`,
    JSON.stringify({ conversation_id: convId, keys: Object.keys(delta), carril }))

  // Paso 4: estado completo → paquete verificado (código calcula y marca).
  const scenario = mergeScenario(seed, delta)
  const verified = buildScenarioContext(scenario, cleanMessage)

  // Paso 5-6: si hubo tool_call, LLAMADA 2 con el paquete verificado como
  // tool_result; si no, se usa el content de la LLAMADA 1 (ahorra latencia).
  let llmResult: { content: string; tokensUsed: number; model: string }
  if (usedTool && toolCall) {
    const toolResult = JSON.stringify(buildToolResult(scenario, verified))
    const systemPrompt2 = [basePrompt, idiomaObligatorio].filter(Boolean).join('\n\n')
    const call2 = await callLLMWithTools(
      [
        ...allMessages,
        { role: 'assistant' as const, content: call1.content, toolCalls: [toolCall] },
        { role: 'tool' as const, toolCallId: toolCall.id, content: toolResult },
      ],
      systemPrompt2,
      [registrarDatosFinancieros],
      { maxTokens: 400, toolChoice: 'none' },
    )
    llmResult = { content: call2.content, tokensUsed: call1.tokensUsed + call2.tokensUsed, model: call2.model }
  } else {
    // Sin datos nuevos: la respuesta de la LLAMADA 1 (con el ESTADO CONOCIDO) vale.
    // Si el modelo no está disponible, el guardrail/ensureSubstance da el cierre seguro.
    llmResult = {
      content: call1.content || 'El Consigliere no está disponible en este momento. Intenta en unos minutos.',
      tokensUsed: call1.tokensUsed,
      model: call1.model,
    }
  }

  // ── Guardarraíl de cifras (código externo al modelo) ─────────────────────────
  // Pieza 2: la jaula de cifras SOLO aplica a la parte financiera del turno.
  // META no tiene nada que fundamentar (charla trivial, identidad, gracias):
  // se salta el grounding entero, pero la señal anti-inyección (M3 / Pieza 5b
  // identity_probe) se sigue detectando y logueando igual.
  let finalContent: string
  let injectionDetected: boolean
  let injectionPatterns: string[]
  // Hoisted: assertOutputInvariants (cableado tras resolveClosing) lo necesita
  // fuera de este bloque. false en META — ahí ni se calcula ni aplica (b).
  let esSimulacion = false

  if (carril === 'META') {
    finalContent = llmResult.content
    const inj = detectInjection(cleanMessage)
    injectionDetected = inj.sospechoso
    injectionPatterns = inj.patrones
  } else {
    // FINANCIERO y MIXTO: grounding de cifras. `texto_final` es la respuesta
    // saneada (montos inventados corregidos/eliminados). best-effort: nunca lanza.
    const guardrail = await runGuardrail(cleanMessage, llmResult.content, {
      mode: 'mvp',
      supabase: admin,
      userId: user.id,
      // Grounding: valores exactos (c0) + conceptos semánticos (PIEZA 2).
      cifrasCalculadas: { valores: verified.valores, conceptos: verified.conceptos },
      // Fallo A: el cierre del guardarraíl en el idioma del usuario, no el del modelo.
      idioma: userLang,
    })
    finalContent = guardrail.texto_final
    injectionDetected = guardrail.injection.detected
    injectionPatterns = guardrail.injection.patterns

    // PIEZA 4 — simulación: la cuota simulada (TAE de referencia) nunca puede
    // afirmar que "no incluye intereses" (sí los incluye) y siempre debe dejar
    // claro que es una simulación, no la cifra real del banco.
    esSimulacion = scenario.credito?.tae_es_referencia === true
    const beforeSimulation = finalContent
    finalContent = enforceSimulationHonesty(finalContent, { esSimulacion, lang: userLang })
    if (finalContent !== beforeSimulation) {
      console.warn('[chat] simulation_honesty_enforced', JSON.stringify({
        user_id: user.id,
        conversation_id: convId,
        carril,
      }))
    }
  }

  // M3 / Pieza 5b: la señal anti-inyección (incluido identity_probe) no
  // bloquea; se registra para vigilancia.
  if (injectionDetected) {
    console.warn('[chat] injection_detected', JSON.stringify({
      user_id: user.id,
      conversation_id: convId,
      patterns: injectionPatterns,
      carril,
    }))
  }

  // ── Validador de política, sobre el texto ya saneado ─────────────────────────
  // Capas de seguridad (garantías, absolutos, branding, fuga de identidad de
  // proveedor/modelo — Pieza 5c): se aplican en TODOS los carriles, META
  // incluido. `validation.text` trae el branding corregido; `enforceOutputPolicy`
  // hace cumplir los bloqueos (C1) eliminando la oración infractora.
  const validation = validateConsigliereOutput(finalContent)
  finalContent = validation.text

  const enforced = enforceOutputPolicy(finalContent, validation)
  if (enforced !== finalContent) {
    console.warn('[chat] output_enforced', JSON.stringify({
      user_id: user.id,
      conversation_id: convId,
      carril,
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

  // PIEZA 3 — fallback de sustancia: SOLO en FINANCIERO. Si el guardrail vació
  // la respuesta a un esqueleto sin cifras, se sustituye por una petición segura
  // del dato que falta (scenario.missing[0]) con promesa de cálculo. En META/MIXTO
  // una respuesta sin cifras (charla trivial, o la parte no financiera de un
  // turno mixto) es perfectamente válida — no hay esqueleto que rellenar.
  if (carril === 'FINANCIERO') {
    const beforeSubstance = finalContent
    finalContent = ensureSubstance(finalContent, { lang: userLang, missing: scenario.missing })
    if (finalContent !== beforeSubstance) {
      console.warn('[chat] substance_fallback', JSON.stringify({
        user_id: user.id,
        conversation_id: convId,
        missing: scenario.missing,
      }))
    }
  }

  // PIEZA 3 — resolutor ÚNICO de cierre (arregla el doble cierre real: dos
  // cierres canónicos propios seguidos porque rewriteDelegativeClosing y
  // enforceMissingClosing no se coordinaban entre sí). Por carril:
  // META → intacto; MIXTO → solo elimina delegación, nunca añade; FINANCIERO →
  // el missing manda, garantizando UNA sola pregunta final.
  const beforeClosing = finalContent
  finalContent = resolveClosing(finalContent, { carril, missing: scenario.missing, lang: userLang })
  if (finalContent !== beforeClosing) {
    console.warn('[chat] closing_resolved', JSON.stringify({
      user_id: user.id,
      conversation_id: convId,
      carril,
      missing: scenario.missing,
    }))
  }

  // AUDITORÍA AG01 (H2 + H5) — assertOutputInvariants: ÚLTIMO paso del pipeline,
  // en TODOS los carriles (PIPELINE_CONTRACT.md §4). Post-condición única: máx.
  // 1 pregunta, sin contradicción tasa/simulación, sin concepto sin cálculo
  // (defensa en profundidad de H1), sin fuga de proveedor, sin cierre delegativo.
  // En META solo aplican (d) y (e) — el resto no tiene sentido sin contenido
  // financiero (assertOutputInvariants lo gestiona internamente por carril).
  const beforeInvariants = finalContent
  const invariants = assertOutputInvariants(finalContent, {
    carril,
    lang: userLang,
    missing: scenario.missing,
    conceptos: verified.conceptos,
    esSimulacion,
  })
  finalContent = invariants.texto
  if (invariants.violaciones.length > 0) {
    console.warn('[chat] invariants', JSON.stringify({
      user_id: user.id,
      conversation_id: convId,
      carril,
      violaciones: invariants.violaciones,
      changed: finalContent !== beforeInvariants,
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
      .update({ updated_at: new Date().toISOString(), scenario_state: scenario })
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
    model: llmResult.model,
  })
}
