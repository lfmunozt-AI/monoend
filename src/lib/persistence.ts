// PERSISTENCIA TRANSACCIONAL DEL TURNO (AG08, 6ª tanda).
//
// CAUSA RAÍZ (testdev5, 31/07 10:25-10:42) — las escrituras del turno vivían
// dispersas en `route.ts`, cada una con su propio manejo de error (algunas
// con catch silencioso, otras sin `await`). El resultado, verificado con la
// evidencia real: el usuario dio ingreso y gastos y el modelo los usó bien
// EN el turno (los tenía en el historial de chat), pero `scenario_state`
// NUNCA se escribió — el motor no tenía memoria real, solo la ilusión de
// tenerla mientras duraba la conversación en curso. `goals` seguía en 0 filas
// pese a una meta declarada, y `response_telemetry` llevaba semanas sin
// escribir una sola fila (la migración que le añadió columnas nunca se
// ejecutó en Supabase — ver 016_extraccion_ambigua.sql).
//
// PIEZA 2 — persistTurn() es el ÚNICO punto donde el turno escribe en BD:
// scenario_state, goals, ica_history y response_telemetry. Cada escritura
// tiene su propia captura de error EXPLÍCITA (console.error con el detalle
// completo — PROHIBIDO el catch silencioso que ocultó este incidente) y las
// cuatro se ejecutan en paralelo (ninguna depende del resultado de otra).

import type { SupabaseClient } from '@supabase/supabase-js'
import { splitScenarioState, type ScenarioState } from './calculator/scenario'
import { updateICAScore } from './ica-service'
import { logResponseTelemetry, type ResponseTelemetryPayload } from './telemetry'

/**
 * Meta a upsertear en `public.goals` este turno, o `null` si no hay nada que
 * tocar (sin meta activa, o la meta activa aún no tiene monto — la tabla
 * exige `target_amount NOT NULL > 0`, así que sin monto no hay fila posible).
 */
export interface GoalUpsert {
  titulo: string
  monto: number
  plazoMeses?: number
}

export interface PersistTurnPayload {
  userId: string
  conversationId: string
  scenarioState: ScenarioState
  goal: GoalUpsert | null
  /**
   * PIEZA 4 — eventos de conocimiento NUEVO detectados este turno (p. ej.
   * ['dato_ingreso', 'meta_declarada']). `chat_consulta` (0 puntos) se añade
   * SIEMPRE, aparte de esta lista — es la traza de actividad, no un evento
   * de conocimiento.
   */
  icaEventos: string[]
  telemetry: Omit<ResponseTelemetryPayload, 'scenarioPersistFailed'>
}

export interface PersistTurnResult {
  scenarioStateOk: boolean
  /** 13ª tanda — hechos financieros a nivel de usuario (`user_financial_state`). */
  userStateOk: boolean
  goalOk: boolean
  icaOk: boolean
  telemetryOk: boolean
  /** Contador de escrituras exitosas, para el log del turno (PIEZA 2). */
  writesOk: number
  writesTotal: number
}

// ── scenario_state ────────────────────────────────────────────────────────

async function persistScenarioState(
  admin: SupabaseClient,
  conversationId: string,
  scenarioState: ScenarioState,
): Promise<boolean> {
  const { error } = await admin
    .from('conversations')
    .update({ updated_at: new Date().toISOString(), scenario_state: scenarioState })
    .eq('id', conversationId)
  if (error) {
    console.error('[persistTurn] scenario_state FALLÓ (fallo crítico — el motor pierde memoria del diálogo):', JSON.stringify({
      conversation_id: conversationId,
      error: error.message,
    }))
    return false
  }
  return true
}

// ── user_financial_state (13ª tanda — memoria a nivel de usuario) ─────────
//
// Los HECHOS financieros son del USUARIO, no de la conversación (migración
// 021). Antes TODO el escenario vivía en `conversations.scenario_state` y una
// conversación nueva arrancaba vacía: amnesia entre sesiones. Esta escritura
// es la que hace que el día 2, en un chat nuevo, monoend siga recordando el
// ingreso, la meta y el desglose.
//
// Un fallo aquí es CRÍTICO — el motor pierde la memoria financiera del
// usuario, no solo la del diálogo — y se marca en la telemetría
// (`userStatePersistFailed`), igual que `scenario_persist_failed`.

async function persistUserFinancialState(
  admin: SupabaseClient,
  userId: string,
  hechos: Partial<ScenarioState>,
): Promise<boolean> {
  const { error } = await admin
    .from('user_financial_state')
    .upsert(
      { user_id: userId, state: hechos, updated_at: new Date().toISOString() },
      { onConflict: 'user_id' },
    )
  if (error) {
    console.error('[persistTurn] user_financial_state FALLÓ (fallo crítico — el motor pierde la memoria financiera del usuario entre conversaciones):', JSON.stringify({
      user_id: userId,
      error: error.message,
    }))
    return false
  }
  return true
}

// ── goals ────────────────────────────────────────────────────────────────

// Categoría inferida del título (ES/PT/EN) — el enum de `goals.category` no
// tiene una opción "sin clasificar" propia; 'other' es su equivalente.
const CATEGORY_KEYWORDS: Array<[RegExp, string]> = [
  [/\b(casa|piso|vivienda|apartamento|imovel|house|apartment)\b/, 'property'],
  [/\b(carro|coche|auto|vehiculo|moto|viatura|car|vehicle)\b/, 'vehicle'],
  [/\b(deuda|prestamo|credito|divida|emprestimo|debt|loan)\b/, 'debt_payoff'],
  [/\b(reserva|emergencia|imprevistos|emergency)\b/, 'emergency_fund'],
  [/\b(jubilacion|retiro|reforma|retirement)\b/, 'retirement'],
  [/\b(negocio|empresa|negocio|business)\b/, 'business'],
  [/\b(estudio|educacion|educacao|education)\b/, 'education'],
  [/\b(viaje|viagem|travel)\b/, 'travel'],
]

const COMBINING_MARKS_RE = /[̀-ͯ]/g

function norm(s: string): string {
  return s.normalize('NFD').replace(COMBINING_MARKS_RE, '').toLowerCase()
}

function inferGoalCategory(titulo: string): string {
  const t = norm(titulo)
  for (const [re, cat] of CATEGORY_KEYWORDS) if (re.test(t)) return cat
  return 'other'
}

function addMonthsISO(months: number): string {
  const d = new Date()
  d.setUTCMonth(d.getUTCMonth() + Math.round(months))
  return d.toISOString().split('T')[0]
}

/**
 * FIX 7 (7ª tanda, testdev6) — BUG BLOQUEANTE: `err instanceof Error ?
 * err.message : String(err)` serializaba un `PostgrestError` (lanzado con
 * `throw error` más abajo) como "[object Object]" — PostgrestError es un
 * objeto plano `{message, code, details, hint}`, NO una instancia de `Error`,
 * así que el chequeo `instanceof` siempre fallaba y el log quedaba sin
 * información útil para depurar un fallo real de escritura. Duck-typing en
 * vez de `instanceof`: cualquier objeto con `.message` (Error nativo o
 * PostgrestError) se desglosa en sus campos reales.
 */
export function serializarError(err: unknown): { message: string; code?: string; details?: string } {
  if (err && typeof err === 'object') {
    const e = err as { message?: unknown; code?: unknown; details?: unknown }
    return {
      message: typeof e.message === 'string' ? e.message : String(err),
      ...(typeof e.code === 'string' ? { code: e.code } : {}),
      ...(typeof e.details === 'string' ? { details: e.details } : {}),
    }
  }
  return { message: String(err) }
}

/**
 * PIEZA 3 — la meta declarada crea (o actualiza) una fila en `goals`. Una
 * sola meta ACTIVA por usuario: si la meta de este turno tiene un título
 * distinto de la(s) activa(s) en BD, esas se ARCHIVAN (status='paused', NUNCA
 * se borran) y se inserta la nueva. Si coincide con la ya activa, se
 * actualiza en sitio (no se duplica la fila cada turno).
 */
async function persistGoal(
  admin: SupabaseClient,
  userId: string,
  goal: GoalUpsert | null,
): Promise<boolean> {
  if (!goal) return true // nada que persistir este turno — no es un fallo.
  try {
    const { data: activas, error: selErr } = await admin
      .from('goals')
      .select('id, title')
      .eq('user_id', userId)
      .eq('status', 'active')
    if (selErr) throw selErr

    const filas = (activas ?? []) as Array<{ id: string; title: string }>
    const existente = filas.find((g) => g.title === goal.titulo)
    const targetDate = goal.plazoMeses !== undefined ? addMonthsISO(goal.plazoMeses) : null
    const category = inferGoalCategory(goal.titulo)

    if (existente) {
      const { error } = await admin
        .from('goals')
        .update({ target_amount: goal.monto, target_date: targetDate, category, updated_at: new Date().toISOString() })
        .eq('id', existente.id)
      if (error) throw error
      return true
    }

    // Meta nueva o con título distinto: archiva las activas previas (nunca
    // se borran) e inserta la nueva como la única activa.
    const idsAArchivar = filas.map((g) => g.id)
    if (idsAArchivar.length > 0) {
      const { error: archErr } = await admin.from('goals').update({ status: 'paused' }).in('id', idsAArchivar)
      if (archErr) throw archErr
    }
    const { error: insErr } = await admin.from('goals').insert({
      user_id: userId,
      title: goal.titulo,
      target_amount: goal.monto,
      target_date: targetDate,
      category,
    })
    if (insErr) throw insErr
    return true
  } catch (err) {
    console.error('[persistTurn] goals FALLÓ:', JSON.stringify({
      user_id: userId,
      goal,
      error: serializarError(err),
    }))
    return false
  }
}

// ── ica_history + profiles.ica_score ─────────────────────────────────────

/**
 * PIEZA 4 — un evento por dato NUEVO, vía `updateICAScore` (AG06,
 * `src/lib/ica-service.ts`): se INVOCA la tabla de puntos existente, nunca
 * se redefine. `chat_consulta` (0 puntos) se registra siempre, aparte, como
 * traza de actividad — la charla en sí ya no puntúa.
 */
async function persistIcaEventos(
  admin: SupabaseClient,
  userId: string,
  icaEventos: string[],
): Promise<boolean> {
  let ok = true
  for (const evento of [...icaEventos, 'chat_consulta']) {
    try {
      await updateICAScore(userId, evento)
    } catch (err) {
      ok = false
      console.error('[persistTurn] ica_history FALLÓ:', JSON.stringify({
        user_id: userId,
        evento,
        error: serializarError(err),
      }))
    }
  }
  return ok
}

/**
 * Punto ÚNICO de persistencia del turno. Las cuatro escrituras corren en
 * PARALELO (ninguna depende del resultado de otra) y cada una captura su
 * propio error explícitamente — nunca un catch silencioso. Devuelve el
 * resultado de cada una y un contador para el log del turno.
 */
export async function persistTurn(
  admin: SupabaseClient,
  payload: PersistTurnPayload,
): Promise<PersistTurnResult> {
  // PARTICIÓN HECHOS/DIÁLOGO (13ª tanda). `splitScenarioState` LANZA si
  // encuentra un campo sin clasificar — es deliberado (ver su doc): un campo
  // nuevo sin clasificar es un bug de programación que debe reventar en los
  // tests. En producción NO puede tumbar el turno del usuario: se captura
  // aquí, se registra como fallo crítico y el resto de escrituras continúa
  // (la conversación se guarda igual; lo que se pierde es la promoción de los
  // hechos, y la telemetría lo deja visible).
  let hechos: Partial<ScenarioState> | null = null
  let dialogo: ScenarioState = payload.scenarioState
  try {
    const split = splitScenarioState(payload.scenarioState)
    hechos = split.hechos
    // El estado de la conversación conserva SOLO la mitad de diálogo. `missing`
    // es obligatorio en el tipo y siempre viaja en esa mitad (es derivado).
    dialogo = { ...split.dialogo, missing: split.dialogo.missing ?? payload.scenarioState.missing }
  } catch (err) {
    console.error('[persistTurn] splitScenarioState FALLÓ (campo sin clasificar — bug de programación, ver CAMPOS_HECHOS/CAMPOS_DIALOGO en scenario.ts):', JSON.stringify({
      user_id: payload.userId,
      conversation_id: payload.conversationId,
      error: err instanceof Error ? err.message : String(err),
    }))
  }

  const [scenarioStateOk, userStateOk, goalOk, icaOk] = await Promise.all([
    persistScenarioState(admin, payload.conversationId, dialogo),
    hechos === null ? Promise.resolve(false) : persistUserFinancialState(admin, payload.userId, hechos),
    persistGoal(admin, payload.userId, payload.goal),
    persistIcaEventos(admin, payload.userId, payload.icaEventos),
  ])

  // La telemetría se registra DESPUÉS de conocer el resultado de
  // scenario_state: "si scenario_state falla, se registra como error crítico
  // en la telemetría" exige que la propia fila lo lleve. Mismo criterio para
  // `user_financial_state` (13ª tanda).
  const telemetryOk = await logResponseTelemetry(admin, {
    ...payload.telemetry,
    scenarioPersistFailed: !scenarioStateOk,
    userStatePersistFailed: !userStateOk,
  })

  const resultado = { scenarioStateOk, userStateOk, goalOk, icaOk, telemetryOk }
  const writesOk = Object.values(resultado).filter(Boolean).length
  const writesTotal = 5

  console.log('[persistTurn] resumen del turno', JSON.stringify({
    user_id: payload.userId,
    conversation_id: payload.conversationId,
    writes_ok: writesOk,
    writes_total: writesTotal,
    ...resultado,
  }))

  return { ...resultado, writesOk, writesTotal }
}
