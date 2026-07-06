// Guardarraíl de cifras de ModeloCFO — orquestador de las 4 piezas.
//
// Capa de CÓDIGO externa al modelo: extrae las cifras que el usuario aportó,
// valida que las cifras de la respuesta estén fundamentadas, aplica la política
// sobre los montos inventados y registra metadatos. NO toca lib/llm.ts ni el
// modelo: envuelve la respuesta ya generada.
//
// ENGANCHE (no cableado en esta sesión, ver docs/GUARDRAIL.md): llamar a
// `runGuardrail(message, fullText, { supabase, userId })` en el `onComplete` de
// streamChat (app/api/chat/route.ts), usando `texto_final` como respuesta a
// persistir/mostrar. Requiere bufferizar la respuesta (la UX pasa a no-stream).

import type { SupabaseClient } from "@supabase/supabase-js";
import { extractInputFacts, type VerifiedFact } from "./extract";
import { validateGrounding, type GroundingResult } from "./validate";
import {
  applyPolicy,
  hashQuestion,
  logGuardrailEvents,
  type GuardrailLogEntry,
  type PolicyMode,
} from "./policy";
import { parseModelOutput } from "./schema";

export interface RunGuardrailOptions {
  /** Política a aplicar ante montos inventados. Por defecto "mvp". */
  mode?: PolicyMode;
  /** Pista del dato que falta, para personalizar la petición. */
  dataHint?: string;
  /** Cliente Supabase de la request; si se da junto a userId, persiste el log. */
  supabase?: SupabaseClient;
  /** Dueño del log (RLS). */
  userId?: string;
}

export interface GuardrailOutcome {
  /** Respuesta final a entregar (reescrita si hubo bloqueos en modo mvp). */
  texto_final: string;
  /** ¿Se bloqueó alguna cifra? */
  bloqueado: boolean;
  /** Hechos verificados extraídos del mensaje del usuario (Pieza 1). */
  hechos: VerifiedFact[];
  /** Detalle del validador de grounding (Pieza 2). */
  validacion: GroundingResult;
  /** ¿La respuesta del modelo venía como JSON estructurado válido (Pieza 4)? */
  estructurada: boolean;
  /** Entradas de log generadas (metadatos). */
  logEntries: GuardrailLogEntry[];
}

/**
 * Ejecuta el guardarraíl completo sobre un turno (mensaje del usuario +
 * respuesta del modelo). Las Piezas 1-3 corren en código puro (~ms); solo el
 * hash de la pregunta y el log opcional son async. Si se pasan `supabase` y
 * `userId`, persiste el log (best-effort, nunca lanza).
 */
export async function runGuardrail(
  userMessage: string,
  modelResponse: string,
  options: RunGuardrailOptions = {},
): Promise<GuardrailOutcome> {
  // Pieza 1: hechos verificados del usuario.
  const hechos = extractInputFacts(userMessage);

  // Pieza 4: si el modelo emitió JSON estructurado, validamos su `consejo`;
  // si no, tratamos todo el texto como consejo (la vía regex sigue mandando).
  const parsed = parseModelOutput(modelResponse);
  const consejo = parsed.data.consejo;

  // Pieza 2: grounding de las cifras de la respuesta.
  const validacion = validateGrounding(consejo, hechos);

  // Pieza 3: política + log (metadatos, hash de la pregunta).
  const preguntaHash = await hashQuestion(userMessage);
  const policy = applyPolicy(consejo, validacion, preguntaHash, {
    mode: options.mode,
    dataHint: options.dataHint,
  });

  if (options.supabase && options.userId && policy.logEntries.length > 0) {
    await logGuardrailEvents(options.supabase, options.userId, policy.logEntries);
  }

  return {
    texto_final: policy.texto_final,
    bloqueado: policy.bloqueado,
    hechos,
    validacion,
    estructurada: parsed.structured,
    logEntries: policy.logEntries,
  };
}

// Reexports para uso directo de cada pieza (y para los tests).
export { extractInputFacts, type VerifiedFact } from "./extract";
export {
  validateGrounding,
  type GroundingResult,
  type ApprovedFigure,
  type BlockedFigure,
  type Categoria,
} from "./validate";
export {
  applyPolicy,
  hashQuestion,
  logGuardrailEvents,
  type PolicyMode,
  type PolicyOptions,
  type PolicyResult,
  type GuardrailLogEntry,
} from "./policy";
export {
  parseModelOutput,
  ModelOutputSchema,
  CifraUsadaSchema,
  type ModelOutput,
  type CifraUsada,
  type ParseResult,
} from "./schema";
export {
  findNumberMentions,
  parseDigitAmount,
  dedupeOverlaps,
  type NumberMention,
} from "./numbers";
export {
  detectCurrency,
  detectLabel,
  isPercent,
  isTimeUnit,
  type Moneda,
} from "./context";
export { detectInjection, type InjectionResult } from "./injection";
