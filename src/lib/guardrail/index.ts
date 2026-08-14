// Guardarraíl de cifras de ModeloCFO — BARREL del módulo.
//
// La implementación vive en piezas separadas:
//   · run.ts       → runGuardrail (grounding + política + log)
//   · pipeline.ts  → applyEnforcement (la cadena completa que ejecuta el route)
//   · policy.ts / validate.ts / commandments.ts / enforcement.ts → las capas
//
// Se separó `runGuardrail` a `run.ts` para que `pipeline.ts` pueda usarlo sin
// crear un ciclo de imports con este barrel.

export {
  runGuardrail,
  type RunGuardrailOptions,
  type GuardrailOutcome,
  type InjectionSignal,
} from "./run";

// Reexports para uso directo de cada pieza (y para los tests).
export { extractInputFacts, type VerifiedFact } from "./extract";
export {
  validateGrounding,
  type GroundingResult,
  type GroundingCifras,
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
  stripDelegativeClosing,
  enforceMissingClosing,
  resolveClosing,
  enforceSimulationHonesty,
  ensureSubstance,
  tieneVerbo,
  tieneSustanciaConversacional,
  esTextoCanonico,
  renumberLists,
  cleanup,
  type PolicyMode,
  type PolicyOptions,
  type PolicyResult,
  type GuardrailLogEntry,
  type ResolveClosingOptions,
  type Mutation,
} from "./policy";
export { classifyTurn, esTonoEmocional, tieneSenalFinanciera, type Carril } from "./turn-classifier";
export {
  enforceCommandments,
  type CommandmentContext,
  type CommandmentReport,
  type CommandmentViolation,
  type CommandmentId,
} from "./commandments";
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
  conceptsInSentence,
  type Moneda,
} from "./context";
export { detectInjection, type InjectionResult } from "./injection";
export {
  getEnforcementMode,
  parseEnforcementMode,
  permiteSustitucion,
  DEFAULT_ENFORCEMENT_MODE,
  type EnforcementMode,
} from "./enforcement";
export {
  applyEnforcement,
  auditarMutaciones,
  type EnforcementInput,
  type EnforcementResult,
} from "./pipeline";
