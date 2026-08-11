// TELEMETRÍA DE RESPUESTAS — compuerta G1b (piloto 6 semanas).
//
// Captura, por turno del chat, lo necesario para medir por telemetría (no por
// reporte del usuario) si el texto publicado contradice al calculador o cita
// cifras no trazables. AG07 construye la revisión nocturna sobre
// `response_telemetry` (migración 011).
//
// Contrato: fire-and-forget, NUNCA lanza — un fallo de telemetría no puede
// bloquear ni degradar la respuesta al usuario.

import type { SupabaseClient } from '@supabase/supabase-js'
import type { Mutation, CommandmentViolation, Carril, EnforcementMode } from '@/lib/guardrail'

export interface ResponseTelemetryPayload {
  userId: string
  conversationId: string | null
  messageId: string | null
  carril: Carril | null
  model: string | null
  tokensUsed: number | null
  toolCallUsed: boolean | null
  latencyGenerationMs: number | null
  latencyValidationMs: number | null
  latencyTotalMs: number | null
  calculatorConceptos: Record<string, number> | null
  scenarioMissing: string[] | null
  responseRaw: string | null
  responseFinal: string | null
  mutations: Mutation[] | null
  commandmentViolations: CommandmentViolation[] | null
  guardrailIntervened: boolean | null
  /**
   * PIEZA 1 — modo de enforcement aplicado a ESTE turno ('full' | 'minimal').
   * Sin este campo no hay forma de comparar A/B: dos turnos con la misma
   * intervención no son comparables si no se sabe qué capas estaban activas.
   */
  enforcementMode: EnforcementMode | null
  /**
   * PIEZA 4 (5ª tanda) — telemetría de ambigüedad de extracción, para que la
   * revisión nocturna (AG07) pueda medir la tasa real de "el usuario dijo un
   * número que el sistema no supo dónde poner" sobre tráfico real, no solo en
   * los escenarios de QA.
   */
  extraccionIncompleta: boolean | null
  numerosHuerfanos: number[] | null
  discrepanciaGastos: boolean | null
  /**
   * PIEZA 2 (6ª tanda) — "si scenario_state falla, se registra como error
   * crítico en la telemetría": sin este campo el fallo solo quedaba en los
   * logs del servidor, invisible para la revisión nocturna (G1b).
   */
  scenarioPersistFailed: boolean | null
  /**
   * 13ª tanda — ¿falló la escritura de los HECHOS financieros del usuario
   * (`user_financial_state`, migración 021)? Es un fallo CRÍTICO distinto de
   * `scenarioPersistFailed`: ese pierde la memoria del DIÁLOGO en curso, este
   * pierde la memoria FINANCIERA del usuario entre conversaciones. Nullable
   * (turnos anteriores a la migración la dejan en NULL).
   */
  userStatePersistFailed?: boolean | null
  /**
   * PIEZA 7 (8ª tanda) — telemetría de depuración de extracción (migración
   * 019_telemetry_extraction.sql). Cierra el bucle de "arreglar a ciegas":
   * permite reconstruir, para un turno real, qué devolvió la extracción, en
   * qué estado estaba el escenario antes y después del merge, y qué ítems de
   * gasto se leyeron. Todas nullable — no afectan turnos que no las pasen.
   */
  extractionStatus?: string | null
  deltaRaw?: Record<string, unknown> | null
  previousScenario?: Record<string, unknown> | null
  mergedScenario?: Record<string, unknown> | null
  expenseItems?: Array<Record<string, unknown>> | null
  /**
   * PIEZA 7 (12ª tanda, §2/§6) — telemetría de la reconciliación cross-turno
   * (migración 020_telemetry_conflict.sql). `mergedScenario` ya lleva
   * `gastos_conflict`/`gastos_assumed` enteros dentro del JSON, pero eso
   * exige parsear el blob para medir la tasa real de conflictos — estas
   * columnas de primera clase son lo que la revisión nocturna (AG07) puede
   * agregar directamente (`group by conflict_status`, `avg(conflict_diff)`…).
   * Todas nullable — un turno sin conflicto/supuesto activo las deja NULL.
   */
  conflictStatus?: 'CONFLICT' | 'ASSUMED' | null
  conflictField?: string | null
  conflictDiff?: number | null
  conflictAttempts?: number | null
  assumedFields?: string[] | null
}

/**
 * Inserta una fila de telemetría de respuesta. Nunca lanza: si falla, solo
 * hace console.warn — la conversación ya se persistió y no debe verse
 * afectada por esto. Devuelve `true`/`false` (éxito/fallo) para que
 * `persistTurn` (PIEZA 2, 6ª tanda) pueda contarlo entre sus escrituras — el
 * contrato "nunca lanza" se mantiene, solo se hace observable el resultado.
 */
export async function logResponseTelemetry(
  admin: SupabaseClient,
  payload: ResponseTelemetryPayload,
): Promise<boolean> {
  try {
    const { error } = await admin.from('response_telemetry').insert({
      user_id: payload.userId,
      conversation_id: payload.conversationId,
      message_id: payload.messageId,
      carril: payload.carril,
      model: payload.model,
      tokens_used: payload.tokensUsed,
      tool_call_used: payload.toolCallUsed,
      latency_generation_ms: payload.latencyGenerationMs,
      latency_validation_ms: payload.latencyValidationMs,
      latency_total_ms: payload.latencyTotalMs,
      calculator_conceptos: payload.calculatorConceptos,
      scenario_missing: payload.scenarioMissing,
      // TODO(post-piloto, ver docs/TELEMETRIA_RETENCION.md § Estrategia
      // post-piloto): a esta escala (10 usuarios) se captura el 100% del
      // texto y la purga de 30 días basta. Con más usuarios, punto de
      // extensión: capturar response_raw/response_final solo en un 5-10% de
      // muestra + el 100% de los turnos con guardrailIntervened===true o
      // commandmentViolations.length>0 — el resto entra como NULL desde el
      // insert (no hace falta esperar a la purga de 30 días).
      response_raw: payload.responseRaw,
      response_final: payload.responseFinal,
      mutations: payload.mutations,
      commandment_violations: payload.commandmentViolations,
      guardrail_intervened: payload.guardrailIntervened,
      enforcement_mode: payload.enforcementMode,
      extraccion_incompleta: payload.extraccionIncompleta,
      numeros_huerfanos: payload.numerosHuerfanos,
      discrepancia_gastos: payload.discrepanciaGastos,
      scenario_persist_failed: payload.scenarioPersistFailed,
      user_state_persist_failed: payload.userStatePersistFailed ?? null,
      extraction_status: payload.extractionStatus ?? null,
      delta_raw: payload.deltaRaw ?? null,
      previous_scenario: payload.previousScenario ?? null,
      merged_scenario: payload.mergedScenario ?? null,
      expense_items: payload.expenseItems ?? null,
      conflict_status: payload.conflictStatus ?? null,
      conflict_field: payload.conflictField ?? null,
      conflict_diff: payload.conflictDiff ?? null,
      conflict_attempts: payload.conflictAttempts ?? null,
      assumed_fields: payload.assumedFields ?? null,
    })
    if (error) throw new Error(error.message)
    return true
  } catch (err) {
    console.error('[telemetry] logResponseTelemetry falló (no bloquea el chat, pero la fila no se escribió):', JSON.stringify({
      user_id: payload.userId,
      conversation_id: payload.conversationId,
      error: err instanceof Error ? err.message : String(err),
    }))
    return false
  }
}
