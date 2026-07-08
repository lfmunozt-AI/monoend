/**
 * @module output-validator
 * Capa validadora de outputs del Consigliere — pre-envío al usuario.
 *
 * Responsabilidad: detectar respuestas que violan reglas del system prompt
 * antes de que lleguen al usuario.
 *
 * Severidades:
 *   ok    → libre de bandera
 *   flag  → registrar pero no bloquear (ej. lenguaje motivacional aislado)
 *   block → no enviar al usuario tal cual; regenerar o adjuntar disclaimer
 *
 * Categoría "branding": no bloquea ni depende del modelo. Reescribe de forma
 * determinista los términos prohibidos por la casa (nada de "Soberanía") antes
 * de correr el resto de comprobaciones. El texto corregido viaja en `text`.
 */

import {
  SPECIFIC_PRODUCT_REGEXES,
  ABSOLUTE_RECOMMENDATION_REGEXES,
  RETURN_GUARANTEE_REGEXES,
  MOTIVATIONAL_PHRASES,
  DISCLAIMER_REGEXES,
  CANONICAL_DISCLAIMER,
  BRANDING_REWRITES,
} from './validator-rules';
import { sentenceRangeAt } from '../guardrail/context';
import {
  cleanup,
  endsWithRequestOrProposal,
  standardClosingRequest,
} from '../guardrail/policy';
import { detectLanguage, type Language } from '../language';

export type Severity = 'ok' | 'flag' | 'block';

/** Una sustitución de branding efectivamente aplicada. */
export interface BrandingRewrite {
  from: string;
  to: string;
}

export interface ValidationResult {
  passed: boolean;
  severity: Severity;
  reasons: string[];
  /**
   * Texto con el branding ya corregido. Idéntico a la entrada si no hubo
   * reescrituras. Es el texto sobre el que opera `enforceOutputPolicy`.
   */
  text: string;
  /** Sustituciones de branding aplicadas (vacío si ninguna). */
  brandingRewrites: BrandingRewrite[];
  /**
   * Oraciones COMPLETAS (sin el signo de puntuación final) que contienen una
   * infracción de severidad `block`. Es lo que `enforceOutputPolicy` elimina.
   * Vacío si `severity !== 'block'`. Las infracciones `flag` (motivacional,
   * branding) NO entran: no justifican borrar texto.
   */
  violatingSentences: string[];
  suggestedDisclaimer?: string;
}

// ── Guardián de negación ──────────────────────────────────────────────────────
//
// "sin riesgo" es una garantía prohibida; "no existe inversión sin riesgo" es la
// verdad que el Consigliere DEBE poder decir. Sin este guardián, el enforcement
// borraba "ningún retorno está garantizado" — exactamente lo contrario de lo que
// la regla persigue.

const NEGATION_RE =
  /\b(?:no|nunca|nada|ning[úu]n|ninguna|ninguno|não|nenhum|nenhuma|never|nothing|not)\b/i;

// Garantías cuya propia formulación YA contiene una negación ("no puedes perder",
// "cannot lose"). Aquí el guardián debe callarse: la negación es parte del delito.
const SELF_NEGATING_RE = /\b(?:no|não|cannot|can'?t|imposible|imposs[íi]vel|impossible)\b/i;

/**
 * ¿La coincidencia está negada en su propia cláusula? Se mira solo hacia atrás,
 * dentro de la misma oración y sin cruzar una coma, punto y coma o dos puntos:
 * "no te voy a mentir: es rentabilidad asegurada" NO cuenta como negada.
 */
function isNegated(text: string, matchText: string, matchStart: number): boolean {
  if (SELF_NEGATING_RE.test(matchText)) return false;

  const [sentenceStart] = sentenceRangeAt(text, matchStart, matchStart);
  const from = Math.max(sentenceStart, matchStart - 40);
  const before = text.slice(from, matchStart);
  const clause = before.split(/[,;:]/).pop() ?? before;

  return NEGATION_RE.test(clause);
}

interface Violation {
  match: string;
  index: number;
}

/**
 * Coincidencias de un conjunto de patrones. Recorre TODAS las de cada patrón: una
 * garantía repetida en dos frases infringe dos veces.
 *
 * `skipNegated` solo se activa para garantías y recomendaciones absolutas. NO para
 * productos: "no compres Bitcoin" sigue siendo una mención de producto concreto y
 * arrastra su disclaimer.
 */
function findViolations(
  text: string,
  regexes: ReadonlyArray<RegExp>,
  skipNegated: boolean,
): Violation[] {
  const out: Violation[] = [];
  for (const r of regexes) {
    const global = new RegExp(r.source, r.flags.includes('g') ? r.flags : `${r.flags}g`);
    for (const m of text.matchAll(global)) {
      if (m.index === undefined) continue;
      if (skipNegated && isNegated(text, m[0], m.index)) continue;
      out.push({ match: m[0], index: m.index });
    }
  }
  return out;
}

/** Primera coincidencia NO negada (garantías, absolutos). */
function findMatch(text: string, regexes: ReadonlyArray<RegExp>): string | null {
  return findViolations(text, regexes, true)[0]?.match ?? null;
}

/** Todas las coincidencias literales, sin guardián (productos). */
function findAllMatches(text: string, regexes: ReadonlyArray<RegExp>): string[] {
  const found: string[] = [];
  for (const v of findViolations(text, regexes, false)) {
    if (!found.includes(v.match)) found.push(v.match);
  }
  return found;
}

function hasDisclaimer(text: string): boolean {
  return DISCLAIMER_REGEXES.some((r) => r.test(text));
}

/** ¿El texto menciona todavía un producto financiero concreto? */
export function mentionsSpecificProduct(text: string): boolean {
  return SPECIFIC_PRODUCT_REGEXES.some((r) => r.test(text));
}

/**
 * Oraciones completas que contienen una infracción real de `regexes`.
 * `skipNegated` debe coincidir con el usado al detectar: si una garantía negada no
 * cuenta como infracción, tampoco puede borrarse su oración.
 */
function sentencesWithMatches(
  text: string,
  regexes: ReadonlyArray<RegExp>,
  skipNegated: boolean,
): string[] {
  const found: string[] = [];
  for (const v of findViolations(text, regexes, skipNegated)) {
    const [start, end] = sentenceRangeAt(text, v.index, v.index + v.match.length);
    const sentence = text.slice(start, end).trim();
    if (sentence && !found.includes(sentence)) found.push(sentence);
  }
  return found;
}

/** Copia la caja de la primera letra del original a la sustitución. */
function matchCase(original: string, replacement: string): string {
  const first = original[0];
  if (!first || first !== first.toUpperCase()) return replacement;
  return replacement[0].toUpperCase() + replacement.slice(1);
}

/**
 * Aplica las reescrituras de branding en orden. El orden importa: los términos
 * compuestos ("Reserva de Soberanía", "soberanía financiera") se resuelven antes
 * que el residual "soberanía" → "dominio", que si no dejaría "Reserva de dominio".
 */
function applyBranding(text: string): { text: string; rewrites: BrandingRewrite[] } {
  const rewrites: BrandingRewrite[] = [];
  let out = text;

  for (const { pattern, replacement, preserveCase } of BRANDING_REWRITES) {
    // `pattern` lleva flag `g`: `replace` lo recorre entero y deja lastIndex a 0,
    // pero el módulo se comparte entre llamadas — reset defensivo.
    pattern.lastIndex = 0;
    out = out.replace(pattern, (match) => {
      const to = preserveCase ? matchCase(match, replacement) : replacement;
      rewrites.push({ from: match, to });
      return to;
    });
  }

  return { text: out, rewrites };
}

/**
 * Valida el output del Consigliere contra las reglas de la casa.
 *
 * Reglas:
 *   0. Branding prohibido ("Reserva de Soberanía", "fondo de emergencia"…) →
 *      reescritura determinista + flag. El resto de reglas corre sobre el
 *      texto ya corregido.
 *   1. Mención de producto financiero específico sin disclaimer → block.
 *   2. Garantía de rentabilidad futura ("vas a ganar X%") → block.
 *   3. Recomendación absoluta ("compra X", "vende Y", "invierte en Z")
 *      junto a un producto específico → block.
 *   4. Lenguaje motivacional cliché → flag.
 *
 * Severidad final = la más alta encontrada (block > flag > ok).
 * Si hay al menos un bloqueo → passed: false.
 */
export function validateConsigliereOutput(input: string): ValidationResult {
  const reasons: string[] = [];
  const violating: string[] = [];
  let severity: Severity = 'ok';
  let needsDisclaimerSuggestion = false;

  const addViolating = (sentences: string[]) => {
    for (const s of sentences) if (!violating.includes(s)) violating.push(s);
  };

  // 0. Branding: reescritura determinista antes de cualquier comprobación.
  const { text, rewrites: brandingRewrites } = applyBranding(input);
  if (brandingRewrites.length > 0) {
    severity = 'flag';
    const terms = [...new Set(brandingRewrites.map((r) => r.from))].join(', ');
    reasons.push(`Branding corregido (${terms}) — terminología prohibida por la casa`);
  }

  // 1. Productos específicos
  const productMatches = findAllMatches(text, SPECIFIC_PRODUCT_REGEXES);
  const disclaimer = hasDisclaimer(text);

  if (productMatches.length > 0 && !disclaimer) {
    severity = 'block';
    needsDisclaimerSuggestion = true;
    addViolating(sentencesWithMatches(text, SPECIFIC_PRODUCT_REGEXES, false));
    reasons.push(
      `Menciona producto financiero específico (${productMatches.join(', ')}) sin disclaimer obligatorio`,
    );
  }

  // 2. Garantías de rentabilidad
  const guarantee = findMatch(text, RETURN_GUARANTEE_REGEXES);
  if (guarantee) {
    severity = 'block';
    addViolating(sentencesWithMatches(text, RETURN_GUARANTEE_REGEXES, true));
    reasons.push(`Garantía de rentabilidad futura detectada: "${guarantee.trim()}"`);
  }

  // 3. Recomendación absoluta + producto específico
  const absolute = findMatch(text, ABSOLUTE_RECOMMENDATION_REGEXES);
  if (absolute && productMatches.length > 0) {
    severity = 'block';
    addViolating(sentencesWithMatches(text, ABSOLUTE_RECOMMENDATION_REGEXES, true));
    reasons.push(
      `Recomendación absoluta ("${absolute.trim()}") sobre producto específico sin condicional`,
    );
  }

  // 4. Lenguaje motivacional cliché
  const motivational = findMatch(text, MOTIVATIONAL_PHRASES);
  if (motivational) {
    if (severity !== 'block') severity = 'flag';
    reasons.push(`Lenguaje motivacional cliché: "${motivational.trim()}"`);
  }

  const passed = severity !== 'block';

  const result: ValidationResult = {
    passed,
    severity,
    reasons,
    text,
    brandingRewrites,
    violatingSentences: severity === 'block' ? violating : [],
  };

  if (needsDisclaimerSuggestion) {
    result.suggestedDisclaimer = CANONICAL_DISCLAIMER;
  }

  return result;
}

// ── Enforcement (C1) ──────────────────────────────────────────────────────────
//
// La auditoría (C1) encontró que el route calculaba `severity:'block'` y lo
// ignoraba: una garantía de rentabilidad llegaba íntegra al usuario. Decisión de
// producto: opción (a), eliminar la oración infractora.

/**
 * Respuesta segura cuando, tras eliminar las oraciones infractoras, no queda
 * nada que decir. En el idioma del mensaje; ES por defecto.
 */
const SAFE_RESPONSE: Record<Language, string> = {
  es:
    'No puedo prometerte resultados de inversión — nadie puede con honestidad. ' +
    'Lo que sí puedo es calcular tu plan con tus datos reales. ' +
    '¿Cuál es la meta que quieres conquistar?',
  pt:
    'Não posso prometer-te resultados de investimento — ninguém pode com honestidade. ' +
    'O que posso é calcular o teu plano com os teus dados reais. ' +
    'Qual é a meta que queres conquistar?',
  en:
    "I can't promise you investment returns — nobody honestly can. " +
    'What I can do is build your plan from your real numbers. ' +
    "What's the goal you want to conquer?",
};

// Segmenta conservando los delimitadores (mismo criterio que el guardarraíl v2).
const SENTENCE_SPLIT_RE = /[^.!?\n]*[.!?\n]+|[^.!?\n]+$/g;

/** El texto normalizado de una oración, sin su signo final, para comparar. */
function sentenceKey(segment: string): string {
  return segment.trim().replace(/[.!?]+$/, '').trim();
}

/**
 * ¿Queda algo que merezca enviarse? Menos de 30 caracteres, o sin ninguna
 * palabra real, significa que la respuesta se quedó en huesos tras el borrado.
 */
function hasSubstance(text: string): boolean {
  if (text.trim().length < 30) return false;
  return /[a-záéíóúüñçãõâêô]{3,}/i.test(text);
}

/**
 * Hace cumplir el veredicto del validador. Función PURA.
 *
 * - `severity !== 'block'` → devuelve `text` intacto. El disclaimer de producto
 *   lo sigue adjuntando el route; aquí no se duplica.
 * - `block` → elimina las oraciones infractoras completas y limpia el residuo.
 * - Si no queda sustancia → respuesta segura en el idioma del texto.
 * - Si lo que queda no cierra pidiendo un dato ni proponiendo → añade el cierre
 *   estándar del guardarraíl v2 (misma frase, no una réplica).
 *
 * `text` debe ser `validation.text` (branding ya aplicado): las oraciones
 * infractoras se calcularon sobre ese texto.
 */
export function enforceOutputPolicy(text: string, validation: ValidationResult): string {
  if (validation.severity !== 'block') return text;

  const lang = detectLanguage(text);
  const banned = new Set(validation.violatingSentences.map(sentenceKey));

  const kept = (text.match(SENTENCE_SPLIT_RE) ?? [text])
    .filter((segment) => !banned.has(sentenceKey(segment)))
    .join('');

  const limpio = cleanup(kept);
  if (!hasSubstance(limpio)) return SAFE_RESPONSE[lang];

  if (endsWithRequestOrProposal(limpio)) return limpio;
  return `${limpio}\n\n${standardClosingRequest(lang)}`;
}
