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
   * reescrituras. Es el texto que debe entregarse al usuario.
   */
  text: string;
  /** Sustituciones de branding aplicadas (vacío si ninguna). */
  brandingRewrites: BrandingRewrite[];
  suggestedDisclaimer?: string;
}

function findMatch(text: string, regexes: ReadonlyArray<RegExp>): string | null {
  for (const r of regexes) {
    const m = text.match(r);
    if (m) return m[0];
  }
  return null;
}

function findAllMatches(text: string, regexes: ReadonlyArray<RegExp>): string[] {
  const found: string[] = [];
  for (const r of regexes) {
    const m = text.match(r);
    if (m) found.push(m[0]);
  }
  return found;
}

function hasDisclaimer(text: string): boolean {
  return DISCLAIMER_REGEXES.some((r) => r.test(text));
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
  let severity: Severity = 'ok';
  let needsDisclaimerSuggestion = false;

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
    reasons.push(
      `Menciona producto financiero específico (${productMatches.join(', ')}) sin disclaimer obligatorio`,
    );
  }

  // 2. Garantías de rentabilidad
  const guarantee = findMatch(text, RETURN_GUARANTEE_REGEXES);
  if (guarantee) {
    severity = 'block';
    reasons.push(`Garantía de rentabilidad futura detectada: "${guarantee.trim()}"`);
  }

  // 3. Recomendación absoluta + producto específico
  const absolute = findMatch(text, ABSOLUTE_RECOMMENDATION_REGEXES);
  if (absolute && productMatches.length > 0) {
    severity = 'block';
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
  };

  if (needsDisclaimerSuggestion) {
    result.suggestedDisclaimer = CANONICAL_DISCLAIMER;
  }

  return result;
}
