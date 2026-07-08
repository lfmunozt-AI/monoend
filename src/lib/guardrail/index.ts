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
import { detectInjection } from "./injection";
import type { Language } from "../language";

export interface RunGuardrailOptions {
  /** Política a aplicar ante montos inventados. Por defecto "mvp". */
  mode?: PolicyMode;
  /** Pista del dato que falta, para personalizar la petición. */
  dataHint?: string;
  /** Cliente Supabase de la request; si se da junto a userId, persiste el log. */
  supabase?: SupabaseClient;
  /** Dueño del log (RLS). */
  userId?: string;
  /**
   * Cifras EXACTAS del motor financiero (`buildVerifiedContext`). Habilitan la
   * rama de aprobación "cálculo verificado" del validador (validate.ts, c0), que
   * sin esto es inalcanzable. Ver M1 de la auditoría.
   */
  cifrasCalculadas?: number[];
  /** Idioma del cierre. Si no se da, se infiere de la respuesta del modelo. */
  idioma?: Language;
}

/** Señal anti-inyección del mensaje del usuario. Nunca bloquea (M3). */
export interface InjectionSignal {
  detected: boolean;
  patterns: string[];
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
  /** Señal anti-inyección sobre el mensaje del usuario. Informativa: no bloquea. */
  injection: InjectionSignal;
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
  // M3 — Señal anti-inyección sobre el mensaje del usuario. Conservador por
  // diseño: se evalúa y se expone, pero NO altera ni bloquea la respuesta.
  const inj = detectInjection(userMessage);
  const injection: InjectionSignal = { detected: inj.sospechoso, patterns: inj.patrones };

  if (injection.detected) {
    // La tabla `guardrail_log` (migración 009) tiene columnas NOT NULL
    // `blocked_value`/`blocked_text` y ningún campo jsonb: no admite un evento de
    // inyección sin falsear una cifra bloqueada. Por eso NO se persiste aquí.
    // TODO(migración 010): añadir `event_type text` + `details jsonb` a
    // guardrail_log y mover este warn a logGuardrailEvents.
    console.warn(
      "[guardrail] injection_detected",
      JSON.stringify({ patterns: injection.patterns, user_id: options.userId ?? null }),
    );
  }

  // Pieza 1: hechos verificados del usuario.
  const hechos = extractInputFacts(userMessage);

  // Pieza 4: si el modelo emitió JSON estructurado, validamos su `consejo`;
  // si no, tratamos todo el texto como consejo (la vía regex sigue mandando).
  const parsed = parseModelOutput(modelResponse);
  const consejo = parsed.data.consejo;

  // Pieza 2: grounding de las cifras de la respuesta. `cifrasCalculadas` viene
  // del motor financiero (M1): sin ellas, la rama c0 del validador es inalcanzable.
  const validacion = validateGrounding(consejo, hechos, options.cifrasCalculadas ?? []);

  // Pieza 3: política + log (metadatos, hash de la pregunta).
  const preguntaHash = await hashQuestion(userMessage);
  const policy = applyPolicy(consejo, validacion, preguntaHash, {
    mode: options.mode,
    dataHint: options.dataHint,
    idioma: options.idioma,
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
    injection,
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
  standardClosingRequest,
  endsWithRequestOrProposal,
  containsDataRequest,
  isDelegativeClosing,
  rewriteDelegativeClosing,
  cleanup,
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
