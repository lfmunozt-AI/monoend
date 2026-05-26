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
 */

import {
  SPECIFIC_PRODUCT_REGEXES,
  ABSOLUTE_RECOMMENDATION_REGEXES,
  RETURN_GUARANTEE_REGEXES,
  MOTIVATIONAL_PHRASES,
  DISCLAIMER_REGEXES,
  CANONICAL_DISCLAIMER,
} from './validator-rules';

export type Severity = 'ok' | 'flag' | 'block';

export interface ValidationResult {
  passed: boolean;
  severity: Severity;
  reasons: string[];
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

/**
 * Valida el output del Consigliere contra las reglas de la casa.
 *
 * Reglas:
 *   1. Mención de producto financiero específico sin disclaimer → block.
 *   2. Garantía de rentabilidad futura ("vas a ganar X%") → block.
 *   3. Recomendación absoluta ("compra X", "vende Y", "invierte en Z")
 *      junto a un producto específico → block.
 *   4. Lenguaje motivacional cliché → flag.
 *
 * Severidad final = la más alta encontrada (block > flag > ok).
 * Si hay al menos un bloqueo → passed: false.
 */
export function validateConsigliereOutput(text: string): ValidationResult {
  const reasons: string[] = [];
  let severity: Severity = 'ok';
  let needsDisclaimerSuggestion = false;

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
  };

  if (needsDisclaimerSuggestion) {
    result.suggestedDisclaimer = CANONICAL_DISCLAIMER;
  }

  return result;
}
