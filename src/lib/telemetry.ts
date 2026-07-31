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
}

/**
 * Inserta una fila de telemetría de respuesta. Nunca lanza: si falla, solo
 * hace console.warn — la conversación ya se persistió y no debe verse
 * afectada por esto.
 */
export async function logResponseTelemetry(
  admin: SupabaseClient,
  payload: ResponseTelemetryPayload,
): Promise<void> {
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
    })
    if (error) throw new Error(error.message)
  } catch (err) {
    console.warn('[telemetry] logResponseTelemetry falló (no bloquea el chat):', err)
  }
}
