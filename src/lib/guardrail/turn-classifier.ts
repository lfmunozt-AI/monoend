// PIEZA 1 — Clasificador de turno (carril).
//
// CAUSA RAÍZ (QA real): el pipeline solo conocía UN modo — turno de cálculo
// financiero. A "¿qué modelo eres?" el guardarraíl juzgó la respuesta como
// esqueleto (sin cifras) y la sustituyó por el enlatado de missing[0]='tae'.
// Lo mismo pasaría con "hola", "gracias", "no entendí": la jaula de cifras se
// aplicaba a TODA la conversación, no solo a la parte financiera.
//
// classifyTurn() decide, de forma pura y determinista, qué carril de
// enforcement le corresponde a un turno — el route (Pieza 2) usa esa
// clasificación para activar o desactivar el grounding de cifras y el cierre
// forzado. Código PURO, edge-safe, SIN llamadas a ningún LLM.

import type { ScenarioState } from "../calculator/scenario";
import type { Language } from "../language";

export type Carril = "FINANCIERO" | "META" | "MIXTO";

function norm(s: string): string {
  return s.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase();
}

// ── Señal FINANCIERA ──────────────────────────────────────────────────────────
// Cualquier cifra/porcentaje, o una keyword de dominio financiero (ES/PT/EN).
const HAS_DIGIT = /\d/;

const FINANCIAL_KEYWORDS = new RegExp(
  "\\b(" +
    // ES
    "gano|ganas|gasto|gastos|gasta|ingreso|ingresos|sueldo|salario|ahorro|ahorros|ahorrar|" +
    "credito|creditos|prestamo|prestamos|cuota|cuotas|tae|taeg|tasa|meta|objetivo|precio|" +
    "financiar|comprar|deuda|deudas|inversion|invertir|" +
    // PT
    "rendimento|despesas?|poupanca|emprestimo|prestacao|prestacoes|taxa|preco|divida|" +
    "investimento|" +
    // EN
    "earn(?:ings)?|income|expenses?|spending|savings?|save|put aside|set aside|loan|payment|" +
    "installment|rate|apr|goal|price|finance|buy|debt|invest(?:ment)?" +
    ")\\b",
);

function hasFinancialSignal(n: string): boolean {
  return HAS_DIGIT.test(n) || FINANCIAL_KEYWORDS.test(n);
}

// ── PIEZA 5c (complemento, 5ª tanda) — TONO EMOCIONAL ────────────────────────
//
// PRINCIPIO ARQUITECTÓNICO: el enforcement solo tiene autoridad sobre CIFRAS Y
// HECHOS VERIFICABLES. Tono, empatía y consuelo son responsabilidad exclusiva
// del modelo. Esta señal NO cambia el cálculo (missing/conceptos/valores
// siguen igual) — solo le dice al PIPELINE (applyEnforcement) y al PROMPT que
// este turno necesita la frontera de autoridad reducida de un turno humano:
// sin grounding forzado, sin petición de dato forzada.
const TONO_EMOCIONAL_RE = new RegExp(
  "\\b(" +
    // ES
    "frustrad[oa]|hart[oa]|agobiad[oa]|no puedo mas|no doy mas|me da verguenza|" +
    "me averguenza|tengo miedo|me despidieron|perdi el trabajo|sin trabajo|" +
    "no consigo trabajo|no encuentro trabajo|estoy en cero|deprimid[oa]|" +
    "angustiad[oa]|desesperad[oa]|abrumad[oa]|" +
    // PT
    "frustrad[oa]|farto[a]?|sobrecarregad[oa]|nao aguento mais|tenho vergonha|" +
    "tenho medo|fui despedid[oa]|perdi o emprego|sem emprego|nao consigo emprego|" +
    "estou a zero|deprimid[oa]|angustiad[oa]|desesperad[oa]|" +
    // EN
    "frustrated|fed up|overwhelmed|i can'?t (?:take it|do this) anymore|" +
    "i'?m ashamed|i'?m scared|i'?m afraid|i got fired|lost my job|no job|" +
    "can'?t find (?:a )?job|i'?m at zero|depressed|anxious|desperate" +
    ")\\b",
);

/**
 * ¿El mensaje expresa frustración, vergüenza, miedo, desánimo, pérdida de
 * empleo, enfermedad o crisis familiar? Puro, determinista. No decide el
 * carril (una pregunta financiera dicha con angustia sigue siendo
 * financiera) — es una señal ADICIONAL que el pipeline usa para reducir su
 * propia autoridad, nunca para ampliarla.
 */
export function esTonoEmocional(message: string): boolean {
  return TONO_EMOCIONAL_RE.test(norm(message));
}

/**
 * ¿El MENSAJE trae señal financiera propia (una cifra o una keyword de dominio)?
 *
 * Exportado para la PIEZA 7 (digresión con retorno): un turno sin señal propia
 * se clasifica FINANCIERO por CONTINUIDAD del escenario ("ok", "ninguno", o una
 * pregunta sobre el tiempo), pero conversacionalmente el usuario está FUERA de
 * la meta. El contador de digresiones necesita esa distinción; la clasificación
 * de carril, no.
 */
export function tieneSenalFinanciera(message: string): boolean {
  return hasFinancialSignal(norm(message));
}

// ── Señal META (charla trivial / identidad / meta-ayuda) ─────────────────────
const GREETINGS =
  "hola|buenos dias|buenas tardes|buenas noches|buen dia|que tal|" + // ES
  "ola|bom dia|boa tarde|boa noite|" + // PT
  "hi|hello|hey|good morning|good afternoon|good evening"; // EN

const THANKS = "gracias|obrigado|obrigada|thanks|thank you";

const FAREWELLS =
  "adios|hasta luego|nos vemos|chau|" + // ES
  "tchau|ate logo|ate a proxima|" + // PT
  "bye|goodbye|see you"; // EN

// Sondeo de identidad: mismas keywords que consumirá Pieza 5b (identity_probe).
const IDENTITY_PROBE =
  "quien eres|que eres|que modelo|que version|fabricante|quien te hizo|quien te creo|" +
  "como funcionas|que puedes hacer|" + // ES
  "quem te criou|quem te fez|que modelo es|qual modelo|que versao|como funcionas|" + // PT
  "who made you|what model|which llm|what version|how do you work|what can you do"; // EN

const META_HELP =
  "no entendi|no comprendo|explicame|ayuda|repite|" + // ES
  "nao entendi|nao compreendo|explica|ajuda|repete|" + // PT
  "i don'?t understand|help me|explain|repeat"; // EN

const META_KEYWORDS = new RegExp(
  `\\b(${GREETINGS}|${THANKS}|${FAREWELLS}|${IDENTITY_PROBE}|${META_HELP})\\b`,
);

function hasMetaSignal(n: string): boolean {
  return META_KEYWORDS.test(n);
}

// ── Continuidad de escenario ──────────────────────────────────────────────────
// Un turno SIN ninguna señal ("ninguno", "ok", "sí") hereda el carril del
// contexto: si hay datos activos en el escenario, es continuación financiera;
// si el escenario está vacío, es charla trivial.
function isScenarioActive(scenario: Partial<ScenarioState> | undefined): boolean {
  if (!scenario) return false;
  return (
    scenario.ingreso_mensual !== undefined ||
    scenario.gastos_mensuales !== undefined ||
    !!scenario.gastos_detalle ||
    !!scenario.credito ||
    !!scenario.meta
  );
}

/**
 * Clasifica un turno en su carril de enforcement.
 *
 * - META sin señal financiera → 'META' (charla trivial, identidad, agradecimiento).
 * - Financiera sin señal META → 'FINANCIERO' (pipeline completo).
 * - Ambas señales presentes → 'MIXTO' (grounding de cifras + seguridad, sin
 *   cierre forzado).
 * - Ninguna señal → continuidad: escenario activo → 'FINANCIERO'; vacío → 'META'.
 *
 * `lang` se acepta para paridad de firma con el resto del guardarraíl (los
 * patrones ya cubren ES/PT/EN); no se usa hoy.
 */
export function classifyTurn(
  message: string,
  scenario: Partial<ScenarioState> | undefined,
  lang?: Language,
): Carril {
  void lang;
  const n = norm(message);
  const financiera = hasFinancialSignal(n);
  const meta = hasMetaSignal(n);

  if (meta && !financiera) return "META";
  if (financiera && !meta) return "FINANCIERO";
  if (financiera && meta) return "MIXTO";

  return isScenarioActive(scenario) ? "FINANCIERO" : "META";
}
