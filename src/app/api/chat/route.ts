import { createClient } from '@/lib/supabase/server'
import { adminClient } from '@/lib/supabase/admin'
import { buildSystemPrompt } from '@/lib/prompts/consigliere'
import { callLLMWithTools } from '@/lib/llm'
import {
  applyEnforcement,
  auditarMutaciones,
  ensureSubstance,
  classifyTurn,
  esTonoEmocional,
  getEnforcementMode,
} from '@/lib/guardrail'
import { buildScenarioContext } from '@/lib/calculator/orchestrator'
import {
  mergeScenario,
  summarizeScenario,
  esConfirmacionCorta,
  registrarPropuestaPendiente,
  esRespuestaRepetida,
  actualizarDigresiones,
  notaRetornoMeta,
  notaSinCifrasDePlan,
  detectarNumerosHuerfanos,
  detectarDiscrepanciaGastos,
  notaExtraccionAmbigua,
  deltaSeguro,
  renderDatosRecienEntendidos,
  numerosCandidatos,
  type ScenarioState,
} from '@/lib/calculator/scenario'
import { registrarDatosFinancieros, resolveDelta, buildToolResult } from '@/lib/calculator/tools'
import { detectLanguage } from '@/lib/language'
import { getICAScore } from '@/lib/ica-service'
import { getICALevel } from '@/lib/ica'
import { logResponseTelemetry } from '@/lib/telemetry'
import { NextResponse } from 'next/server'

const RATE_LIMIT_FREE = 20

// REINTENTO ÚNICO ACOTADO: derivadas de decisión (FIX B) que el motor SÍ puede
// calcular — si los Mandamientos vacían la respuesta por una cita incorrecta
// de una de estas, vale la pena regenerar UNA vez con el valor correcto en vez
// de pedir el dato de nuevo (el dato ya lo tenemos).
const DECISION_DERIVATIVES = [
  'brecha',
  'esfuerzo_total',
  'aumento_necesario',
  'recorte_necesario',
  'ahorro_necesario_mensual',
]

// user_ids exentos del rate limit incluso en Production (admins/QA). Se leen de
// la env var ADMIN_USER_IDS (coma-separada) para eximir a alguien en PRD sin
// tocar código — basta añadir su user_id en Vercel.
const ADMIN_USER_IDS = (process.env.ADMIN_USER_IDS ?? '')
  .split(',')
  .map((id) => id.trim())
  .filter(Boolean)

export async function POST(request: Request) {
  // TELEMETRÍA G1b — marca de inicio del route, para latency_total_ms.
  const routeStart = Date.now()

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

  // FIX C — el modelo necesita saber YA en la LLAMADA 1 si el usuario acaba de
  // confirmar una propuesta pendiente ("sí"): una confirmación corta no trae
  // datos nuevos, así que nunca dispara tool_call — no hay una LLAMADA 2 donde
  // colar el dato. `mergeScenario` (más abajo) hace la transición OFICIAL del
  // estado; esto solo adelanta el hecho al prompt de la primera llamada.
  if (seed.propuesta_pendiente && esConfirmacionCorta(cleanMessage)) {
    seed.plan_confirmado = true
  }

  // ── CARRIL (Pieza 1-2) ───────────────────────────────────────────────────────
  // Causa raíz QA: el pipeline solo conocía UN modo (turno de cálculo). A "¿qué
  // modelo eres?" el guardarraíl de cifras juzgó la respuesta como esqueleto y la
  // sustituyó por el enlatado de missing[0]. La jaula de cifras solo debe
  // aplicarse a la PARTE financiera de la conversación. Se clasifica con el
  // estado PREVIO (seed): el mensaje del turno actual ya trae su propia señal
  // financiera/META en el texto; el escenario solo desempata cuando no hay
  // ninguna ("ninguno", "ok").
  const carril = classifyTurn(cleanMessage, seed, userLang)

  // PIEZA 5c (complemento, 5ª tanda) — TONO EMOCIONAL. Señal ORTOGONAL al
  // carril: reduce la autoridad del enforcement (pipeline.ts) y se expone al
  // prompt para que el modelo consuele primero — nunca cambia el cálculo.
  const esEmocional = esTonoEmocional(cleanMessage)
  const notaTonoEmocional = esEmocional
    ? 'TONO EMOCIONAL detectado en este turno (frustración, vergüenza, miedo, pérdida de empleo…). ' +
      'PROHIBIDO pedir datos financieros o forzar un cierre en esta respuesta: consuela primero y ofrece ' +
      'una alternativa concreta, según el MANDATO DE TONO. El eco de datos recién entendidos, si lo hay, espera al turno siguiente.'
    : null

  // PIEZA 1 — modo de enforcement del turno ('full' por defecto). Se resuelve
  // UNA vez y baja por toda la cadena; se registra en telemetría para el A/B.
  const enforcementMode = getEnforcementMode()

  // PIEZA 7 — DIGRESIÓN CON RETORNO. Un turno META habiendo meta activa no es un
  // fallo: es conversación. Se cuenta, no se corta. Al tercero seguido se le
  // pide al modelo que reconduzca con naturalidad; cualquier turno FINANCIERO
  // reinicia el contador.
  seed.digresiones_seguidas = actualizarDigresiones(prevScenario, carril, cleanMessage)
  const notaDigresion = notaRetornoMeta(seed)

  // FIX 2b (4ª tanda) — refuerzo determinista del auto-chequeo: si el
  // playbook activo implica cifras de plan y falta un dato, se lo decimos
  // directamente en vez de confiar solo en que el modelo se autochequee.
  const notaSinCifras = notaSinCifrasDePlan(seed)

  console.warn('[chat] carril', JSON.stringify({
    user_id: user.id,
    conversation_id: convId,
    carril,
    enforcement_mode: enforcementMode,
    digresiones: seed.digresiones_seguidas,
  }))

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
    notaDigresion,
    notaSinCifras,
    notaTonoEmocional,
    idiomaObligatorio,
  ].filter(Boolean).join('\n\n')

  // BONUS de latencia/coste (Pieza 2): en META no hay nada financiero que
  // extraer — una sola llamada, sin tool, con presupuesto de tokens de
  // respuesta completa (no de mero tool_call).
  // TELEMETRÍA G1b — marca de inicio del bloque de generación (LLAMADA 1 en
  // adelante, incluida la LLAMADA 2 y el reintento anti-repetición FIX C).
  const generationStart = Date.now()

  const call1 = await callLLMWithTools(
    allMessages,
    systemPrompt1,
    [registrarDatosFinancieros],
    carril === 'META'
      ? { maxTokens: 500, toolChoice: 'none' }
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

  // PIEZA 1/2 (5ª tanda) — CIERRE DE LA CLASE DE EXTRACCIÓN. "Ningún dato entra
  // al estado sin que el usuario lo vea. Ante ambigüedad de extracción se
  // PREGUNTA, nunca se asume." Se cuenta tras extraer el delta (tool call o
  // fallback regex, ambas vías convergen en el mismo Partial<ScenarioState>):
  // números que parecen financieros y no aterrizaron en ningún campo
  // (huérfanos), o un agregado declarado que no reconcilia con su propio
  // desglose (discrepancia). Cualquiera de las dos prohíbe calcular derivadas
  // este turno.
  const huerfanos = detectarNumerosHuerfanos(cleanMessage, delta)
  const discrepancia = detectarDiscrepanciaGastos(delta)
  const extraccionAmbigua = huerfanos.extraccionIncompleta || discrepancia.discrepancia
  const notaAmbigua = extraccionAmbigua ? notaExtraccionAmbigua(huerfanos, discrepancia) : null

  if (extraccionAmbigua) {
    console.warn('[chat] extraccion_ambigua', JSON.stringify({
      user_id: user.id,
      conversation_id: convId,
      carril,
      numeros_huerfanos: huerfanos.numerosHuerfanos,
      discrepancia_gastos: discrepancia.discrepancia,
    }))
  }

  // Paso 4: estado completo → paquete verificado (código calcula y marca).
  // PIEZA 1 — con extracción ambigua, el delta financiero NUNCA se persiste
  // (deltaSeguro lo despoja de sus campos numéricos) y el motor no calcula
  // ninguna derivada sobre un insumo sin confirmar (buildScenarioContext
  // devuelve bloque vacío vía `extraccionAmbigua`).
  const scenario = mergeScenario(seed, extraccionAmbigua ? deltaSeguro(delta) : delta)
  // Todo número candidato del mensaje (no solo los huérfanos) queda autorizado
  // para el guardarraíl de cifras: el modelo necesita poder citar cualquiera
  // de ellos al preguntar ("¿tu ingreso ronda los 2.000 € o los 2.500 €?",
  // "dijiste 1.000 € pero el detalle suma 850 €") sin que se bloqueen por no
  // ser una cifra derivada verificada — es el eco de lo que el usuario
  // escribió, no una cifra inventada. `discrepancia.suma` se añade aparte
  // porque es COMPUTADA (no un token literal del mensaje).
  const valoresAmbiguos = [
    ...numerosCandidatos(cleanMessage),
    ...(discrepancia.suma !== undefined ? [discrepancia.suma] : []),
  ]
  const verified = buildScenarioContext(scenario, cleanMessage, { extraccionAmbigua, valoresAmbiguos })

  // PIEZA 3 — ECO DE CONFIRMACIÓN: con datos limpios (sin ambigüedad) y turno
  // no emocional (PIEZA 7: el eco espera al turno siguiente si la persona está
  // en un momento emocional), la primera línea de la respuesta debe devolver lo
  // entendido antes de usarlo.
  const notaEco = !extraccionAmbigua && !esEmocional
    ? renderDatosRecienEntendidos(delta, cleanMessage)
    : null

  // Paso 5-6: si hubo tool_call, LLAMADA 2 con el paquete verificado como
  // tool_result; si no, se usa el content de la LLAMADA 1 (ahorra latencia).
  // Se guardan systemPrompt/mensajes de la llamada que ganó: el reintento por
  // repetición (FIX C, más abajo) los reutiliza para regenerar UNA vez.
  let llmResult: { content: string; tokensUsed: number; model: string }
  let respondingSystemPrompt: string
  let respondingMessages: Parameters<typeof callLLMWithTools>[0]
  if (usedTool && toolCall) {
    const toolResult = JSON.stringify(buildToolResult(scenario, verified))
    // PIEZA 1/3 — la nota de ambigüedad y el eco de confirmación van en ESTA
    // llamada (aún no se ha generado nada con el delta de este turno).
    const systemPrompt2 = [basePrompt, notaDigresion, notaSinCifras, notaAmbigua, notaEco, notaTonoEmocional, idiomaObligatorio]
      .filter(Boolean).join('\n\n')
    const messages2 = [
      ...allMessages,
      { role: 'assistant' as const, content: call1.content, toolCalls: [toolCall] },
      { role: 'tool' as const, toolCallId: toolCall.id, content: toolResult },
    ]
    const call2 = await callLLMWithTools(
      messages2,
      systemPrompt2,
      [registrarDatosFinancieros],
      { maxTokens: 500, toolChoice: 'none' },
    )
    llmResult = { content: call2.content, tokensUsed: call1.tokensUsed + call2.tokensUsed, model: call2.model }
    respondingSystemPrompt = systemPrompt2
    respondingMessages = messages2
  } else if (notaAmbigua || notaEco) {
    // PIEZA 1/3 (sin tool_call) — el contenido de la LLAMADA 1 se generó ANTES
    // de conocer la ambigüedad o el eco (ambos dependen del delta, resuelto
    // después). Se regenera UNA vez con la nota inyectada — mismo patrón que el
    // REINTENTO ÚNICO ACOTADO de las derivadas de decisión, más abajo.
    const systemPromptRegen = [basePrompt, `ESTADO ACTUAL CONOCIDO (lo que ya sabemos del usuario):\n${summarizeScenario(seed)}`, notaDigresion, notaSinCifras, notaAmbigua, notaEco, notaTonoEmocional, idiomaObligatorio]
      .filter(Boolean).join('\n\n')
    const regen = await callLLMWithTools(
      allMessages,
      systemPromptRegen,
      [registrarDatosFinancieros],
      { maxTokens: 500, toolChoice: 'none' },
    )
    llmResult = {
      content: regen.content || call1.content || 'El Consigliere no está disponible en este momento. Intenta en unos minutos.',
      tokensUsed: call1.tokensUsed + regen.tokensUsed,
      model: regen.model,
    }
    respondingSystemPrompt = systemPromptRegen
    respondingMessages = allMessages
  } else {
    // Sin datos nuevos: la respuesta de la LLAMADA 1 (con el ESTADO CONOCIDO) vale.
    // Si el modelo no está disponible, el guardrail/ensureSubstance da el cierre seguro.
    llmResult = {
      content: call1.content || 'El Consigliere no está disponible en este momento. Intenta en unos minutos.',
      tokensUsed: call1.tokensUsed,
      model: call1.model,
    }
    respondingSystemPrompt = systemPrompt1
    respondingMessages = allMessages
  }

  // FIX C — ANTI-REPETICIÓN: bug real de 5 turnos con la respuesta prácticamente
  // calcada ("¿quieres que te proyecte el plan?" una y otra vez). Si el texto
  // generado es ≥90% idéntico al último mensaje del asistente en esta MISMA
  // conversación, se regenera UNA sola vez con instrucción explícita de avanzar.
  const lastAssistantMessage = [...contextMessages].reverse().find((m) => m.role === 'assistant')?.content
  if (esRespuestaRepetida(llmResult.content, lastAssistantMessage)) {
    console.warn('[chat] repetition_detected', JSON.stringify({ user_id: user.id, conversation_id: convId, carril }))
    const instruccionAvance =
      'Tu respuesta iba a repetir casi literalmente la anterior de esta conversación. ' +
      'PROHIBIDO reformular el mismo diagnóstico o repetir la misma pregunta: avanza al siguiente paso concreto.'
    const retry = await callLLMWithTools(
      respondingMessages,
      `${respondingSystemPrompt}\n\n${instruccionAvance}`,
      [registrarDatosFinancieros],
      { maxTokens: 500, toolChoice: 'none' },
    )
    llmResult = {
      content: retry.content || llmResult.content,
      tokensUsed: llmResult.tokensUsed + retry.tokensUsed,
      model: retry.model,
    }
  }

  // TELEMETRÍA G1b — fin del bloque de generación / respuesta cruda del LLM
  // (pre-runGuardrail). Se guarda aparte porque `llmResult.content` se
  // reescribe más abajo en el REINTENTO ÚNICO ACOTADO.
  const generationEnd = Date.now()
  let latencyGenerationMs = generationEnd - generationStart
  let responseRawForTelemetry = llmResult.content

  // ── Guardarraíl de cifras (código externo al modelo) ─────────────────────────
  // Pieza 2: la jaula de cifras SOLO aplica a la parte financiera del turno.
  // META no tiene nada que fundamentar (charla trivial, identidad, gracias):
  // se salta el grounding entero, pero la señal anti-inyección (M3 / Pieza 5b
  // identity_probe) se sigue detectando y logueando igual.
  //
  // Extraída a función para el REINTENTO ÚNICO ACOTADO (más abajo): una
  // regeneración necesita pasar por exactamente la misma cadena de seguridad
  // (grounding → validador → cierre → Mandamientos), con un registro de
  // mutaciones NUEVO — no el de la primera pasada.
  // `userId`: TS no propaga el null-check de `user` dentro de una función
  // anidada; se captura ya-no-nulo aquí para no repetir `user!.id`.
  const userId = user.id
  async function runSafetyPipeline(rawContent: string) {
    // La cadena vive en `lib/guardrail/pipeline.ts` (un solo orden, un solo
    // lugar) y registra TODA mutación — incluido el punto ciego del Caso A,
    // donde una sustitución completa se logueaba con `mutations: []`.
    const result = await applyEnforcement(rawContent, {
      userMessage: cleanMessage,
      carril,
      lang: userLang,
      missing: scenario.missing,
      valores: verified.valores,
      conceptos: verified.conceptos,
      // false en META — ahí ni se calcula ni aplica (Mandamiento 2).
      esSimulacion: carril === 'META' ? false : scenario.credito?.tae_es_referencia === true,
      // PIEZA 5a (complemento, 5ª tanda) — frontera de autoridad reducida en
      // turnos emocionales: el enforcement no toca tono, solo cifras.
      esEmocional,
      enforcement: enforcementMode,
      supabase: admin,
      userId,
    })

    // M3 / Pieza 5b: la señal anti-inyección (incluido identity_probe) no
    // bloquea; se registra para vigilancia.
    if (result.injection.detected) {
      console.warn('[chat] injection_detected', JSON.stringify({
        user_id: userId,
        conversation_id: convId,
        patterns: result.injection.patterns,
        carril,
      }))
    }

    if (result.mutations.length > 0) {
      console.warn('[chat] mutations', JSON.stringify({
        user_id: userId,
        conversation_id: convId,
        carril,
        enforcement_mode: result.enforcement,
        capas: result.mutations.map((m) => `${m.capa}:${m.regla}`),
      }))
    }

    if (result.violaciones.length > 0) {
      console.warn('[chat] commandments', JSON.stringify({
        user_id: userId,
        conversation_id: convId,
        carril,
        violaciones: result.violaciones,
      }))
    }

    // PIEZA 5 — INVARIANTE DE AUDITORÍA: si el texto cambió, tiene que haber
    // quedado registrado. Un fallo aquí es un punto ciego nuevo: se avisa, no se
    // bloquea la respuesta (la telemetría lo recogerá igualmente).
    if (!auditarMutaciones(rawContent, result.texto, result.mutations)) {
      console.error('[chat] mutation_audit_gap', JSON.stringify({
        user_id: userId,
        conversation_id: convId,
        carril,
        enforcement_mode: result.enforcement,
      }))
    }

    return {
      finalContent: result.texto,
      commandments: { texto: result.texto, violaciones: result.violaciones },
      mutations: result.mutations,
      guardrailBloqueado: result.guardrailBloqueado,
    }
  }

  // TELEMETRÍA G1b — capas de validación: guardrail + validator + Commandments.
  const validationStart = Date.now()
  let safety = await runSafetyPipeline(llmResult.content)
  let latencyValidationMs = Date.now() - validationStart
  let finalContent = safety.finalContent

  // REINTENTO ÚNICO ACOTADO — cuando los Mandamientos vacían la respuesta
  // entera por una cita incorrecta de una derivada de decisión (FIX B: brecha,
  // esfuerzo_total, aumento/recorte necesario, ahorro_necesario_mensual), el
  // motor SÍ tiene el valor correcto en `conceptos` — no hace falta pedir el
  // dato de nuevo, basta regenerar UNA vez con la cifra correcta explícita.
  // Si la segunda pasada TAMBIÉN queda vacía, se abandona (nunca un segundo
  // reintento) y se cae al cierre seguro de siempre (ensureSubstance).
  const derivadaDisponible = DECISION_DERIVATIVES.some((k) => k in verified.conceptos)
  if (carril !== 'META' && finalContent.trim() === '' && derivadaDisponible) {
    const cifrasCorrectas = DECISION_DERIVATIVES
      .filter((k) => k in verified.conceptos)
      .map((k) => `${k} = ${verified.conceptos[k]}`)
      .join(', ')
    console.warn('[chat] bounded_retry', JSON.stringify({
      user_id: userId,
      conversation_id: convId,
      carril,
      motivo: 'respuesta vaciada por Mandamientos — derivada de decisión disponible en el motor',
      cifras: cifrasCorrectas,
    }))
    const instruccionCorrectiva =
      'Tu respuesta anterior citó una cifra de decisión incorrecta y fue eliminada por completo. ' +
      `Usa EXACTAMENTE estos valores ya calculados (no los recalcules, no inventes otros): ${cifrasCorrectas}.`
    const boundedRetryGenStart = Date.now()
    const retry = await callLLMWithTools(
      respondingMessages,
      `${respondingSystemPrompt}\n\n${instruccionCorrectiva}`,
      [registrarDatosFinancieros],
      { maxTokens: 500, toolChoice: 'none' },
    )
    latencyGenerationMs += Date.now() - boundedRetryGenStart
    if (retry.content) {
      const boundedRetryValStart = Date.now()
      safety = await runSafetyPipeline(retry.content)
      latencyValidationMs += Date.now() - boundedRetryValStart
      finalContent = safety.finalContent
      llmResult = { content: retry.content, tokensUsed: llmResult.tokensUsed + retry.tokensUsed, model: retry.model }
      responseRawForTelemetry = retry.content
    }
    if (finalContent.trim() === '') {
      const antes = finalContent
      finalContent = ensureSubstance('', {
        lang: userLang,
        missing: scenario.missing,
        // El último recurso tiene que producir ALGO aunque el modo sea minimal:
        // una respuesta vacía no es "no sustituir lo bueno", es no responder.
        enforcement: 'full',
      })
      // PIEZA 5 — también este último recurso queda registrado.
      if (finalContent !== antes) {
        safety.mutations.push({
          capa: 'ensureSubstance',
          regla: 'respuesta vacía tras el reintento acotado',
          antes,
          despues: finalContent,
        })
      }
    }
  }

  // FIX C — si `finalContent` cierra proponiendo un plan, se recuerda para que
  // una confirmación corta del PRÓXIMO turno dispare PB7 en vez de que el
  // modelo vuelva a diagnosticar. Sin propuesta, el escenario vuelve intacto.
  const scenarioAPersistir = registrarPropuestaPendiente(scenario, finalContent)

  // ── Guardar respuesta + actualizar conversación (parallel) ───────────────────
  const [assistantMsgResult, updateConvResult] = await Promise.all([
    admin.from('messages').insert({
      conversation_id: convId,
      user_id: user.id,
      role: 'assistant',
      content: finalContent,
      tokens_used: llmResult.tokensUsed,
    }).select('id').single(),
    admin.from('conversations')
      .update({ updated_at: new Date().toISOString(), scenario_state: scenarioAPersistir })
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

  // TELEMETRÍA G1b — compuerta medible: registro de mutaciones + violaciones
  // de mandamientos de este turno. `await` deliberado: en serverless el
  // trabajo post-response no está garantizado, así que se espera antes del
  // return (logResponseTelemetry nunca lanza — fire-and-forget con try/catch).
  const messageId = (assistantMsgResult.data as { id: string } | null)?.id ?? null
  await logResponseTelemetry(admin, {
    userId: user.id,
    conversationId: convId,
    messageId,
    carril,
    model: llmResult.model,
    tokensUsed: llmResult.tokensUsed,
    toolCallUsed: usedTool,
    latencyGenerationMs,
    latencyValidationMs,
    latencyTotalMs: Date.now() - routeStart,
    calculatorConceptos: verified.conceptos,
    scenarioMissing: scenario.missing,
    responseRaw: responseRawForTelemetry,
    responseFinal: finalContent,
    mutations: safety.mutations,
    commandmentViolations: safety.commandments.violaciones,
    guardrailIntervened:
      safety.mutations.length > 0 || safety.commandments.violaciones.length > 0 || safety.guardrailBloqueado,
    // PIEZA 1 — qué capas estaban activas en este turno (comparación A/B).
    enforcementMode,
    // PIEZA 4 (5ª tanda) — tasa de ambigüedad de extracción para la revisión nocturna.
    extraccionIncompleta: huerfanos.extraccionIncompleta,
    numerosHuerfanos: huerfanos.numerosHuerfanos,
    discrepanciaGastos: discrepancia.discrepancia,
  })

  return NextResponse.json({
    response: finalContent,
    conversationId: convId,
    tokensUsed: llmResult.tokensUsed,
    model: llmResult.model,
  })
}
