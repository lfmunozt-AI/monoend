// REVISIÓN NOCTURNA DE TELEMETRÍA — compuerta G1b medible (AG07).
//
// Núcleo COMPARTIDO entre `scripts/telemetry-review.ts` (CLI manual) y
// `src/app/api/cron/telemetry-review/route.ts` (cron diario 03:00 UTC): ambos
// llaman a `runTelemetryReview` + `persistReviewResults` + `buildDigestEmail` /
// `sendDigestEmail`. Ni el script ni la ruta duplican esta lógica.
//
// Regla de Luis: "si G1 depende de que un usuario note que la cuota está mal,
// ya perdimos" — por eso esto lee `response_telemetry` (migración 011, AG02),
// NO reportes de usuario. Detecta 5 clases de evento sobre cada turno del día:
//
//   D1 (G1b crítico) — cifra en response_final NO trazable a calculator_conceptos.
//   D2 (G1b crítico) — contradicción de honestidad de simulación.
//   D3 (G1b crítico) — violación de mandamiento registrada SIN corrección
//                       aplicada (accion !== 'corregido' — quedó publicada).
//   D4 (regresión)   — una capa sustituyó una cifra fuera de los patrones
//                       posicionales permitidos (bug real "7000. Ajustar el ocio").
//   D5 (info)         — métricas del día (latencia, intervención, coste).
//
// Reutiliza EXCLUSIVAMENTE primitivas puras ya existentes del guardarraíl
// (numbers.ts, context.ts, validate.ts, policy.ts vía @/lib/guardrail) — cero
// reimplementación del splitter/parser numérico ni de `enforceSimulationHonesty`.
// Código puro salvo `runTelemetryReview` (lee Supabase) y `sendDigestEmail`
// (llama a Resend); todo lo demás es determinista y testeable sin red.

import type { SupabaseClient } from '@supabase/supabase-js'
import { Resend } from 'resend'
import {
  findNumberMentions,
  dedupeOverlaps,
  isPercent,
  enforceSimulationHonesty,
  type Mutation,
  type CommandmentViolation,
  type Carril,
} from '@/lib/guardrail'
import { isListEnumerator } from '@/lib/guardrail/validate'
import { hasReferenceMarker, sentenceRangeAt, splitSentences, conceptsInSentence } from '@/lib/guardrail/context'
import { detectLanguage, type Language } from '@/lib/language'

// ── Fila de response_telemetry (migración 011) ──────────────────────────────

export interface TelemetryRow {
  id: string
  created_at: string
  user_id: string
  conversation_id: string | null
  message_id: string | null
  carril: Carril | null
  model: string | null
  tokens_used: number | null
  tool_call_used: boolean | null
  latency_generation_ms: number | null
  latency_validation_ms: number | null
  latency_total_ms: number | null
  calculator_conceptos: Record<string, number> | null
  scenario_missing: string[] | null
  response_raw: string | null
  response_final: string | null
  mutations: Mutation[] | null
  commandment_violations: CommandmentViolation[] | null
  guardrail_intervened: boolean | null
}

export type ReviewRule = 'D1' | 'D2' | 'D3' | 'D4'
export type ReviewSeverity = 'G1b' | 'regresion'

export interface ReviewEvent {
  rule: ReviewRule
  severity: ReviewSeverity
  telemetryId: string
  detail: Record<string, unknown>
}

function norm(s: string): string {
  return s.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase()
}

/** Fragmento legible alrededor de una posición del texto, para el digest. */
function fragmentAround(text: string, start: number, end: number, radius = 40): string {
  const from = Math.max(0, start - radius)
  const to = Math.min(text.length, end + radius)
  return `${from > 0 ? '…' : ''}${text.slice(from, to).trim()}${to < text.length ? '…' : ''}`
}

function mkEvent(
  row: TelemetryRow,
  rule: ReviewRule,
  severity: ReviewSeverity,
  detail: Record<string, unknown>,
): ReviewEvent {
  return { rule, severity, telemetryId: row.id, detail: { carril: row.carril, ...detail } }
}

// ── D1 — cifra NO trazable a calculator_conceptos ───────────────────────────
//
// Value-based, igual que el guardarraíl en vivo: cualquier cifra del texto
// publicado debe coincidir (±1) con ALGÚN valor que el motor calculó este
// turno. Excluye lo que el propio pipeline ya considera "no es una cifra
// financiera": enumeradores de lista (Mandamiento 8, `isListEnumerator`) y
// porcentajes con marcador de referencia en su misma frase (tercera vía).
//
// LÍMITE CONOCIDO: solo compara contra `calculator_conceptos` (lo que el
// motor financiero calculó), no contra los "hechos" sueltos que el usuario
// pudiera mencionar fuera del `ScenarioState` (p. ej. una deuda ad-hoc no
// trackeada). Documentado en docs/ACEPTACION_FASE0.md — el dominio del piloto
// (ingreso/gastos/crédito/meta) sí queda cubierto por `ScenarioState`.
export function detectD1(row: TelemetryRow): ReviewEvent[] {
  const text = row.response_final ?? ''
  if (!text.trim()) return []

  const conceptos = row.calculator_conceptos ?? {}
  const known = Object.values(conceptos).filter((v) => typeof v === 'number' && Number.isFinite(v))
  const mentions = dedupeOverlaps(findNumberMentions(text))
  const events: ReviewEvent[] = []

  for (const m of mentions) {
    if (isListEnumerator(text, m)) continue

    if (isPercent(text, m)) {
      const [s, e] = sentenceRangeAt(text, m.start, m.end)
      if (hasReferenceMarker(text.slice(s, e))) continue
    }

    const traceable = known.some((v) => Math.abs(m.value - v) <= 1)
    if (traceable) continue

    events.push(
      mkEvent(row, 'D1', 'G1b', {
        valor: m.value,
        texto: m.text,
        fragmento: fragmentAround(text, m.start, m.end),
      }),
    )
  }

  return events
}

// ── D2 — contradicción de honestidad de simulación ──────────────────────────
//
// Solo aplica si el motor calculó una cuota con tasa este turno (`cuota` en
// `calculator_conceptos`) — sin cuota no hay nada que contradecir. La cuota es
// SIMULADA cuando el motor no tiene la TAE real del usuario: `deriveConceptos`
// (orchestrator.ts) solo puebla el concepto `tae` cuando `!usarReferencia`, así
// que su AUSENCIA es la señal — mismo criterio que `scenario.credito.tae_es_referencia`
// en route.ts, sin necesitar esa columna en la telemetría.
//
//   a) simulación: reutiliza `enforceSimulationHonesty` TAL CUAL (Mandamiento 2)
//      forzando `esSimulacion:true` — es exactamente la llamada que route.ts ya
//      hace en producción. Si el texto CAMBIA, la contradicción sobrevivió al
//      pipeline y quedó publicada.
//   b) simulación + "exacta": el pipeline no defiende esto todavía (ninguna
//      pieza existente lo cubre) — detección propia, acotada a frases con una
//      cifra MONETARIA real (no `%`) junto al reclamo de exactitud, para no
//      disparar con el cierre canónico "...la cuota es exacta al 100%" (que
//      promete exactitud FUTURA condicionada a un dato, sin cifra monetaria).
//   c) TAE real pero el texto dice "simulación"/"de referencia": la
//      contradicción inversa — tampoco defendida hoy. Detección propia,
//      acotada a la frase que nombra la cuota (`conceptsInSentence`).
const EXACT_CLAIM_RE = /\b(exacta|exacto|exata|exato|exactly|exact)\b/
const SIMULATION_CLAIM_RE = /(simulac|simulat|de referencia|orientativ)/
const INTEREST_NEGATION_RE =
  /\b(sin incluir intereses|sin intereses|no incluye intereses|sin (?:la )?(?:tae|taeg|tasa)|sem juros|sem (?:a )?(?:taeg|taxa)|without interest|excluding interest|without (?:the )?(?:apr|interest rate))\b/

export function detectD2(row: TelemetryRow): ReviewEvent[] {
  const text = row.response_final ?? ''
  if (!text.trim()) return []

  const conceptos = row.calculator_conceptos ?? {}
  if (!('cuota' in conceptos)) return []

  const esSimulacion = !('tae' in conceptos)
  const lang: Language = detectLanguage(text)
  const events: ReviewEvent[] = []

  if (esSimulacion) {
    const corregido = enforceSimulationHonesty(text, { esSimulacion: true, lang })
    if (corregido !== text) {
      events.push(
        mkEvent(row, 'D2', 'G1b', {
          tipo: 'negador_de_intereses_o_marcador_de_simulacion_ausente',
          antes: text,
          despues: corregido,
        }),
      )
    }

    for (const sentence of splitSentences(text)) {
      if (!EXACT_CLAIM_RE.test(norm(sentence))) continue
      const tieneMontoReal = findNumberMentions(sentence).some((m) => !isPercent(sentence, m))
      if (!tieneMontoReal) continue // "...la cuota es exacta al 100%" (promesa futura, sin monto)
      events.push(mkEvent(row, 'D2', 'G1b', { tipo: 'exacta_pero_simulada', fragmento: sentence }))
    }
  } else {
    for (const sentence of splitSentences(text)) {
      if (!conceptsInSentence(sentence).includes('cuota')) continue
      const n = norm(sentence)
      if (INTEREST_NEGATION_RE.test(n)) {
        events.push(mkEvent(row, 'D2', 'G1b', { tipo: 'negador_de_intereses_con_tae_real', fragmento: sentence }))
      }
      if (SIMULATION_CLAIM_RE.test(n)) {
        events.push(mkEvent(row, 'D2', 'G1b', { tipo: 'simulacion_pero_tae_real', fragmento: sentence }))
      }
    }
  }

  return events
}

// ── D3 — violación de mandamiento registrada SIN corrección aplicada ────────
//
// `CommandmentAction` admite 'corregido' | 'logueado' (commandments.ts). Hoy
// TODAS las ramas de `enforceCommandments` empujan 'corregido' — este chequeo
// es la red de seguridad para el día en que una violación se detecte pero NO
// se pueda corregir automáticamente (p. ej. un patrón ambiguo que solo se
// puede señalar, no reescribir con seguridad): si eso ocurre, quedó publicada
// y es exactamente el escenario crítico de G1b que Luis describe.
export function detectD3(row: TelemetryRow): ReviewEvent[] {
  const violaciones = row.commandment_violations ?? []
  return violaciones
    .filter((v) => v.accion !== 'corregido')
    .map((v) =>
      mkEvent(row, 'D3', 'G1b', {
        mandamiento: v.mandamiento,
        accion: v.accion,
        detalle: v.detalle,
        capa: v.capa,
      }),
    )
}

// ── D4 — mutación fuera de los patrones posicionales permitidos ─────────────
//
// Cada capa que reescribe texto en sitio (`Mutation[]`, policy.ts) solo debería
// producir un puñado de formas conocidas — el bug real "7000. Ajustar el ocio"
// fue justo una capa sustituyendo una cifra fuera de esos patrones. Lista
// blanca por capa; cualquier `regla` que no la cumpla (o una `capa`
// desconocida) es una regresión de motor, no una compuerta G1b — se corrige
// en el pipeline, no bloquea el piloto.
const ALLOWED_MUTATION_PATTERNS: Record<string, RegExp> = {
  grounding: /^posici[oó]n de (monto|plazo) pero no coincide con su valor verificado$/,
  validator: /^branding$/,
  resolveClosing: /^cierre$/,
}

export function detectD4(row: TelemetryRow): ReviewEvent[] {
  const events: ReviewEvent[] = []
  for (const mut of row.mutations ?? []) {
    const pattern = ALLOWED_MUTATION_PATTERNS[mut.capa]
    if (!pattern) {
      events.push(mkEvent(row, 'D4', 'regresion', { motivo: 'capa desconocida', ...mut }))
      continue
    }
    if (!pattern.test(mut.regla)) {
      events.push(mkEvent(row, 'D4', 'regresion', { motivo: 'regla fuera del patrón posicional permitido', ...mut }))
    }
  }
  return events
}

// ── D5 — métricas del día (observabilidad, no compuerta) ────────────────────

/**
 * Precio por 1M tokens (USD), constante configurable. Blended (no separa
 * input/output): `tokens_used` en `response_telemetry` es el total de la API,
 * no desglosado — aproximación documentada, no una factura exacta.
 */
export const PRICE_PER_1M_TOKENS_USD: Record<string, number> = {
  'gpt-4o-mini': 0.375,
  'gpt-4o': 6.25,
}
export const DEFAULT_PRICE_PER_1M_TOKENS_USD = 0.375

function percentile(sortedAsc: number[], p: number): number {
  if (sortedAsc.length === 0) return 0
  const idx = Math.min(sortedAsc.length - 1, Math.max(0, Math.ceil((p / 100) * sortedAsc.length) - 1))
  return sortedAsc[idx]
}

export interface D5Metrics {
  totalTurnos: number
  latencyTotalMsP50: number
  latencyTotalMsP95: number
  latencyTotalMsP99: number
  guardrailIntervencionGlobalPct: number
  intervencionPorCapa: Record<string, number>
  intervencionPorMandamiento: Record<string, number>
  toolCallUsedPct: number
  toolCallElegibles: number
  tokensTotal: number
  costeEstimadoUsd: number
  porModelo: Record<string, { turnos: number; tokens: number; costeUsd: number }>
}

export function computeD5(rows: TelemetryRow[]): D5Metrics {
  const totalTurnos = rows.length
  const latencies = rows
    .map((r) => r.latency_total_ms)
    .filter((v): v is number => typeof v === 'number' && Number.isFinite(v))
    .sort((a, b) => a - b)

  const intervenidos = rows.filter((r) => r.guardrail_intervened === true).length

  const intervencionPorCapa: Record<string, number> = {}
  for (const row of rows) {
    const capasDelTurno = new Set((row.mutations ?? []).map((m) => m.capa))
    for (const capa of capasDelTurno) {
      intervencionPorCapa[capa] = (intervencionPorCapa[capa] ?? 0) + 1
    }
  }

  const intervencionPorMandamiento: Record<string, number> = {}
  for (const row of rows) {
    const mandamientosDelTurno = new Set((row.commandment_violations ?? []).map((v) => String(v.mandamiento)))
    for (const m of mandamientosDelTurno) {
      intervencionPorMandamiento[m] = (intervencionPorMandamiento[m] ?? 0) + 1
    }
  }

  // tool_call vs fallback-regex: solo tiene sentido fuera de META (route.ts
  // fuerza toolChoice:'none' y usedTool:false en META — no es un fallback).
  const elegibles = rows.filter((r) => r.carril !== 'META')
  const conToolCall = elegibles.filter((r) => r.tool_call_used === true).length

  const porModelo: Record<string, { turnos: number; tokens: number; costeUsd: number }> = {}
  let tokensTotal = 0
  let costeEstimadoUsd = 0
  for (const row of rows) {
    const modelo = row.model ?? 'desconocido'
    const tokens = row.tokens_used ?? 0
    const precio = PRICE_PER_1M_TOKENS_USD[modelo] ?? DEFAULT_PRICE_PER_1M_TOKENS_USD
    const coste = (tokens / 1_000_000) * precio
    tokensTotal += tokens
    costeEstimadoUsd += coste
    const acc = porModelo[modelo] ?? { turnos: 0, tokens: 0, costeUsd: 0 }
    acc.turnos += 1
    acc.tokens += tokens
    acc.costeUsd += coste
    porModelo[modelo] = acc
  }

  return {
    totalTurnos,
    latencyTotalMsP50: percentile(latencies, 50),
    latencyTotalMsP95: percentile(latencies, 95),
    latencyTotalMsP99: percentile(latencies, 99),
    guardrailIntervencionGlobalPct: totalTurnos > 0 ? round2((intervenidos / totalTurnos) * 100) : 0,
    intervencionPorCapa,
    intervencionPorMandamiento,
    toolCallUsedPct: elegibles.length > 0 ? round2((conToolCall / elegibles.length) * 100) : 0,
    toolCallElegibles: elegibles.length,
    tokensTotal,
    costeEstimadoUsd: round4(costeEstimadoUsd),
    porModelo,
  }
}

function round2(n: number): number {
  return Math.round(n * 100) / 100
}
function round4(n: number): number {
  return Math.round(n * 10000) / 10000
}

// ── Orquestación: lee un día, detecta D1-D5 ──────────────────────────────────

export interface ReviewResult {
  reviewDate: string // YYYY-MM-DD
  events: ReviewEvent[] // D1-D4
  metrics: D5Metrics // D5
  rowCount: number
}

/** Rango UTC [00:00, +24h) del `reviewDate` (YYYY-MM-DD). */
function dayRangeUtc(reviewDate: string): { fromIso: string; toIso: string } {
  const from = new Date(`${reviewDate}T00:00:00.000Z`)
  const to = new Date(from.getTime() + 24 * 60 * 60 * 1000)
  return { fromIso: from.toISOString(), toIso: to.toISOString() }
}

/** `YYYY-MM-DD` de "ayer" en UTC — default del script/cron sin `--date`. */
export function yesterdayUtc(now: Date = new Date()): string {
  const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() - 1))
  return d.toISOString().slice(0, 10)
}

export async function fetchTelemetryForDate(
  admin: SupabaseClient,
  reviewDate: string,
): Promise<TelemetryRow[]> {
  const { fromIso, toIso } = dayRangeUtc(reviewDate)
  const { data, error } = await admin
    .from('response_telemetry')
    .select('*')
    .gte('created_at', fromIso)
    .lt('created_at', toIso)
    .order('created_at', { ascending: true })

  if (error) throw new Error(`fetchTelemetryForDate: ${error.message}`)
  return (data ?? []) as TelemetryRow[]
}

export function reviewRows(reviewDate: string, rows: TelemetryRow[]): ReviewResult {
  const events: ReviewEvent[] = []
  for (const row of rows) {
    events.push(...detectD1(row), ...detectD2(row), ...detectD3(row), ...detectD4(row))
  }
  return { reviewDate, events, metrics: computeD5(rows), rowCount: rows.length }
}

export async function runTelemetryReview(admin: SupabaseClient, reviewDate: string): Promise<ReviewResult> {
  const rows = await fetchTelemetryForDate(admin, reviewDate)
  return reviewRows(reviewDate, rows)
}

// ── Persistencia (idempotente) ───────────────────────────────────────────────

/**
 * Borra las alertas previas de `reviewDate` y reinserta — re-ejecutar un día
 * (p. ej. `--date=` manual tras un fix) no deja rastro duplicado.
 */
export async function persistReviewResults(admin: SupabaseClient, result: ReviewResult): Promise<void> {
  const del = await admin.from('telemetry_alerts').delete().eq('review_date', result.reviewDate)
  if (del.error) throw new Error(`persistReviewResults (delete): ${del.error.message}`)

  const rows = [
    ...result.events.map((e) => ({
      review_date: result.reviewDate,
      severity: e.severity,
      rule: e.rule,
      telemetry_id: e.telemetryId,
      detail: e.detail,
    })),
    {
      review_date: result.reviewDate,
      severity: 'info' as const,
      rule: 'D5' as const,
      telemetry_id: null,
      detail: { ...result.metrics, rowCount: result.rowCount },
    },
  ]

  const ins = await admin.from('telemetry_alerts').insert(rows)
  if (ins.error) throw new Error(`persistReviewResults (insert): ${ins.error.message}`)
}

// ── Digest por email ──────────────────────────────────────────────────────────

export interface Digest {
  subject: string
  html: string
  text: string
}

const RULE_LABEL: Record<ReviewRule, string> = {
  D1: 'D1 · cifra no trazable',
  D2: 'D2 · contradicción de simulación',
  D3: 'D3 · violación de mandamiento sin corregir',
  D4: 'D4 · mutación fuera de patrón (regresión de capa)',
}

export function buildDigestEmail(result: ReviewResult): Digest {
  const g1b = result.events.filter((e) => e.severity === 'G1b')
  const regresiones = result.events.filter((e) => e.severity === 'regresion')

  const subject = `[monoend piloto] Revisión ${result.reviewDate} — ${g1b.length} eventos G1b`

  const porRegla: Record<ReviewRule, number> = { D1: 0, D2: 0, D3: 0, D4: 0 }
  for (const e of result.events) porRegla[e.rule]++

  // Hasta 5 ejemplos: prioridad a G1b (crítico) sobre regresión.
  const ejemplos = [...g1b, ...regresiones].slice(0, 5)

  const m = result.metrics
  const lines: string[] = []
  lines.push(`Revisión nocturna de telemetría — ${result.reviewDate}`)
  lines.push(`Turnos analizados: ${result.rowCount}`)
  lines.push('')
  lines.push(
    g1b.length === 0
      ? '✅ 0 eventos G1b hoy — el motor no publicó ninguna cifra no trazable, contradicción de simulación ni violación de mandamiento sin corregir.'
      : `🚨 ${g1b.length} eventos G1b hoy — REVISAR ANTES DE SEGUIR EL PILOTO.`,
  )
  lines.push('')
  lines.push('Conteo por regla:')
  for (const rule of Object.keys(porRegla) as ReviewRule[]) {
    lines.push(`  ${RULE_LABEL[rule]}: ${porRegla[rule]}`)
  }
  lines.push('')
  lines.push('Métricas del día (D5):')
  lines.push(`  Turnos: ${m.totalTurnos}`)
  lines.push(`  Latencia total p50/p95/p99 (ms): ${m.latencyTotalMsP50} / ${m.latencyTotalMsP95} / ${m.latencyTotalMsP99}`)
  lines.push(`  Intervención del guardarraíl (global): ${m.guardrailIntervencionGlobalPct}%`)
  lines.push(`  Intervención por capa: ${JSON.stringify(m.intervencionPorCapa)}`)
  lines.push(`  Intervención por mandamiento: ${JSON.stringify(m.intervencionPorMandamiento)}`)
  lines.push(`  tool_call usado (turnos no-META, n=${m.toolCallElegibles}): ${m.toolCallUsedPct}%`)
  lines.push(`  Tokens: ${m.tokensTotal} · coste estimado: $${m.costeEstimadoUsd.toFixed(4)}`)
  lines.push('')

  if (ejemplos.length > 0) {
    lines.push(`Ejemplos (hasta 5, de ${result.events.length} eventos totales):`)
    for (const ev of ejemplos) {
      const cifra = ev.detail.valor ?? ev.detail.antes ?? ev.detail.despues ?? ''
      const capa = ev.detail.capa ?? ev.detail.mandamiento ?? ''
      const fragmento = ev.detail.fragmento ?? ev.detail.detalle ?? ''
      lines.push(`  [${ev.rule}] capa/mandamiento: ${capa} · cifra: ${cifra}`)
      lines.push(`    ${String(fragmento).slice(0, 200)}`)
      lines.push(`    telemetry_id: ${ev.telemetryId}`)
    }
  }

  const text = lines.join('\n')
  const html = `<pre style="font-family:ui-monospace,monospace;white-space:pre-wrap">${escapeHtml(text)}</pre>`
  return { subject, text, html }
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

/**
 * Envía el digest con Resend. Best-effort: si falla, se loguea pero NO lanza —
 * la revisión ya persistió en `telemetry_alerts` (fuente de verdad), el email
 * es solo el aviso. Requiere `RESEND_API_KEY` y `PILOT_ALERT_EMAIL` en el entorno.
 */
export async function sendDigestEmail(digest: Digest): Promise<void> {
  const to = process.env.PILOT_ALERT_EMAIL
  const apiKey = process.env.RESEND_API_KEY
  if (!to || !apiKey) {
    console.warn('[telemetry-review] sendDigestEmail: falta PILOT_ALERT_EMAIL o RESEND_API_KEY — email no enviado')
    return
  }
  try {
    const resend = new Resend(apiKey)
    const { error } = await resend.emails.send({
      from: process.env.PILOT_ALERT_FROM ?? 'monoend piloto <onboarding@resend.dev>',
      to,
      subject: digest.subject,
      html: digest.html,
      text: digest.text,
    })
    if (error) throw new Error(JSON.stringify(error))
  } catch (err) {
    console.error('[telemetry-review] sendDigestEmail falló (no bloquea la revisión):', err)
  }
}
