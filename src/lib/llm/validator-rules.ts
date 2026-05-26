/**
 * @module validator-rules
 * Reglas (regex + listas) usadas por `validateConsigliereOutput`.
 * Separadas para mantener mantenibilidad: añadir/quitar términos no requiere tocar el motor.
 */

/**
 * Marcas, tickers y nombres concretos de brokers / exchanges / fondos / acciones / criptomonedas.
 * Mencionarlos sin disclaimer es bloqueo automático.
 *
 * Nota: se mantienen únicamente nombres claramente identificables como producto financiero.
 * Categorías genéricas ("fondo indexado", "renta fija", "ETF de renta variable global") NO
 * deben entrar aquí — esas son admisibles sin disclaimer.
 */
export const SPECIFIC_PRODUCT_REGEXES: ReadonlyArray<RegExp> = [
  // Criptomonedas concretas
  /\bbitcoin\b/i,
  /\bbtc\b/i,
  /\bethereum\b/i,
  /\b(?:eth|ether)\b/i,
  /\bsolana\b/i,
  /\bcardano\b/i,
  /\b(?:dogecoin|doge)\b/i,
  /\b(?:ripple|xrp)\b/i,
  /\bpolkadot\b/i,
  /\bbinance\s+coin\b/i,

  // Exchanges / brokers / neobancos de inversión
  /\brevolut\b/i,
  /\betoro\b/i,
  /\bcoinbase\b/i,
  /\bbinance\b/i,
  /\bkraken\b/i,
  /\brobinhood\b/i,
  /\bdegiro\b/i,
  /\btrade\s+republic\b/i,
  /\binteractive\s+brokers\b/i,
  /\bibkr\b/i,
  /\bxtb\b/i,
  /\bmyinvestor\b/i,
  /\bindexa\s+capital\b/i,
  /\bbullionvault\b/i,
  /\bscalable\s+capital\b/i,
  /\bn26\b/i,

  // Acciones concretas
  /\btesla\b/i,
  /\btsla\b/i,
  /\bnvidia\b/i,
  /\bnvda\b/i,
  /\bapple\s+inc\b/i,
  /\baapl\b/i,
  /\bmicrosoft\b/i,
  /\bmsft\b/i,
  /\bamazon\b/i,
  /\bamzn\b/i,
  /\balphabet\b/i,
  /\bgoogl\b/i,
  /\bmeta\s+platforms\b/i,

  // Tickers concretos de fondos / ETFs
  /\bvwce\b/i,
  /\bvti\b/i,
  /\bvoo\b/i,
  /\bvusa\b/i,
  /\biwda\b/i,
  /\beunl\b/i,
  /\bsxr8\b/i,
  /\bswda\b/i,
  /\bcsspx\b/i,
];

/**
 * Patrones de recomendación absoluta sin condicional.
 * Imperativos directos sobre producto financiero ("compra X", "vende Y", "invierte en Z",
 * "abre cuenta en X"). Se combinan en el motor con la mención de un producto concreto;
 * cuando aparecen junto a un nombre específico se bloquea.
 *
 * Se incluye también la forma infinitiva imperativa común ("Te recomiendo invertir en X")
 * porque el caso de uso es funcionalmente equivalente a un imperativo.
 */
export const ABSOLUTE_RECOMMENDATION_REGEXES: ReadonlyArray<RegExp> = [
  /\bcompra\s+(?:acciones?\s+de\s+|el\s+|la\s+|las\s+|los\s+|un\s+|una\s+)?/i,
  /\bvende\s+(?:todo|tus|tu|el|la|las|los|un|una)?/i,
  /\binvierte\s+en\b/i,
  /\bmete\s+(?:todo|tu|tus|tu\s+dinero|el\s+dinero)\b/i,
  /\bm[ée]tete\s+sin\s+dudar\b/i,
  /\babre\s+(?:una\s+)?cuenta\s+en\b/i,
  /\bpasa\s+tu\s+dinero\s+a\b/i,
  /\btu\s+mejor\s+opci[óo]n\s+es\b/i,
  /\bes\s+el\s+mejor\b/i,
  /\bes\s+la\s+mejor\b/i,
];

/**
 * Patrones de garantía de rentabilidad futura.
 * Combinaciones de verbo en futuro o adjetivo absoluto + porcentaje.
 */
export const RETURN_GUARANTEE_REGEXES: ReadonlyArray<RegExp> = [
  /\bvas\s+a\s+ganar\b[^.]*?\d+\s?%/i,
  /\bte\s+van?\s+a\s+dar\b[^.]*?\d+\s?%/i,
  /\bte\s+dar[áa]\b[^.]*?\d+\s?%/i,
  /\besto\s+te\s+dar[áa]\b[^.]*?\d+\s?%/i,
  /\brentabilidad\s+(?:de|del)\s+\d+\s?%/i,
  /\bganar[áa]s\s+(?:un\s+)?\d+\s?%/i,
  /\bgarantizad[oa]\b[^.]*?\d+\s?%/i,
  /\basegurad[oa]\s+(?:un\s+)?\d+\s?%/i,
  /\btienes\s+asegurad[oa]\b/i,
  /\bgarantizado\s*:/i,
  /\bes\s+seguro\s+que\s+(?:vas|te)/i,
  /\bno\s+puede\s+bajar\b/i,
];

/**
 * Frases de lenguaje motivacional cliché.
 * Detectarlas marca el output como `flag` (no bloquea, pero queda registrado).
 */
export const MOTIVATIONAL_PHRASES: ReadonlyArray<RegExp> = [
  /\bt[úu]\s+puedes\b/i,
  /\bcree\s+en\s+ti\b/i,
  /\btodo\s+va\s+a\s+estar\s+bien\b/i,
  /\bel\s+universo\s+te\s+apoya\b/i,
  /\bconf[íi]a\s+en\s+el\s+proceso\b/i,
  /\beres\s+m[áa]s\s+fuerte\s+de\s+lo\s+que\s+crees\b/i,
  /\bno\s+te\s+rindas\b/i,
  /\btodo\s+es\s+posible\b/i,
  /\bsigue\s+tus\s+sue[ñn]os\b/i,
  /\bbelieve\s+in\s+yourself\b/i,
];

/**
 * Indicadores de presencia del disclaimer obligatorio.
 * Basta con que aparezca uno de estos fragmentos en el mismo mensaje.
 */
export const DISCLAIMER_REGEXES: ReadonlyArray<RegExp> = [
  /no\s+es\s+asesoramiento\s+(?:financiero\s+)?personalizado/i,
  /consulta\s+a\s+un\s+asesor\s+regulado/i,
];

/**
 * Texto canónico del disclaimer — usado como sugerencia cuando falta.
 */
export const CANONICAL_DISCLAIMER =
  'Esto no es asesoramiento financiero personalizado; consulta a un asesor regulado antes de actuar.';
