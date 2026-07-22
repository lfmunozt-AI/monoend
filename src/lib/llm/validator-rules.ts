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
  // ── ES ─────────────────────────────────────────────────────────────────────
  /\bcompra\s+(?:acciones?\s+de\s+|el\s+|la\s+|las\s+|los\s+|un\s+|una\s+)?/i,
  /\bvende\s+(?:todo|tus|tu|el|la|las|los|un|una)?/i,
  /\binvierte\s+en\b/i,
  /\bmete\s+(?:todo|tu|tus|tu\s+dinero|el\s+dinero)\b/i,
  /\bpon\s+(?:todo|todo\s+tu\s+dinero)\b/i,
  /\binvierte\s+todo\b/i,
  /\btodo\s+tu\s+dinero\b/i,
  /\bla\s+mejor\s+inversi[óo]n\s+sin\s+duda\b/i,
  /\bs[íi]\s+o\s+s[íi]\b/i,
  /\bobligatorio\s+invertir\b/i,
  /\b[úu]nica\s+opci[óo]n\b/i,
  /\bm[ée]tete\s+sin\s+dudar\b/i,
  /\babre\s+(?:una\s+)?cuenta\s+en\b/i,
  /\bpasa\s+tu\s+dinero\s+a\b/i,
  /\btu\s+mejor\s+opci[óo]n\s+es\b/i,
  /\bes\s+el\s+mejor\b/i,
  /\bes\s+la\s+mejor\b/i,

  // ── PT ─────────────────────────────────────────────────────────────────────
  /\bmete\s+tudo\b/i,
  /\bp[õo]e\s+tudo\b/i,
  /\btodo\s+o\s+teu\s+dinheiro\b/i,
  /\bsem\s+d[úu]vida\s+a\s+melhor\b/i,
  /\b[úu]nica\s+op[çc][ãa]o\b/i,
  /\btens\s+de\s+investir\b/i,

  // ── EN ─────────────────────────────────────────────────────────────────────
  /\ball\s+in\b/i,
  /\b(?:put|invest)\s+everything\b/i,
  /\ball\s+your\s+money\b/i,
  /\bthe\s+best\s+investment\s+hands\s+down\b/i,
  /\bmust\s+invest\b/i,
  /\bonly\s+option\b/i,
  /\bno-?brainer\s+investment\b/i,
];

/**
 * Patrones de garantía de rentabilidad futura.
 * Combinaciones de verbo en futuro o adjetivo absoluto + porcentaje.
 */
export const RETURN_GUARANTEE_REGEXES: ReadonlyArray<RegExp> = [
  // ── ES ─────────────────────────────────────────────────────────────────────
  /\bvas\s+a\s+ganar\b[^.]*?\d+\s?%/i,
  /\bte\s+van?\s+a\s+dar\b[^.]*?\d+\s?%/i,
  /\bte\s+dar[áa]\b[^.]*?\d+\s?%/i,
  /\besto\s+te\s+dar[áa]\b[^.]*?\d+\s?%/i,
  /\brentabilidad\s+(?:de|del)\s+\d+\s?%/i,
  /\bganar[áa]s\s+(?:un\s+)?\d+\s?%/i,
  /\bgarantizad[oa]s?\b/i,
  /\basegurad[oa]s?\b/i,
  /\bsin\s+riesgo\b/i,
  /\briesgo\s+cero\b/i,
  /\b100\s?%\s+seguro\b/i,
  /\brentabilidad\s+asegurada\b/i,
  /\b(?:ganancia|retorno|beneficio)\s+garantizad[oa]\b/i,
  /\bbeneficio\s+seguro\b/i,
  /\bno\s+puedes\s+perder\b/i,
  /\bimposible\s+perder\b/i,
  /\bseguro\s+que\s+(?:gana|sube|vas|te)\b/i,
  /\bte\s+aseguro\s+que\b/i,
  /\bgarantizado\s*:/i,
  /\bno\s+puede\s+bajar\b/i,

  // ── PT ─────────────────────────────────────────────────────────────────────
  /\bgarantid[oa]s?\b/i,
  /\bsem\s+risco\b/i,
  /\brisco\s+zero\b/i,
  /\b(?:lucro|retorno)\s+garantid[oa]\b/i,
  /\bimposs[íi]vel\s+perder\b/i,
  /\bcom\s+certeza\s+ganhas\b/i,
  /\bgaranto\s+que\b/i,
  /\b100\s?%\s+seguro\b/i,

  // ── EN ─────────────────────────────────────────────────────────────────────
  /\bguaranteed\b/i,
  /\bassured\s+returns?\b/i,
  /\brisk-?free\b/i,
  /\bzero\s+risk\b/i,
  /\b100\s?%\s+safe\b/i,
  /\bcan'?t\s+lose\b/i,
  /\bcannot\s+lose\b/i,
  /\bimpossible\s+to\s+lose\b/i,
  /\bsure\s+(?:gain|win)\b/i,
  /\bi\s+guarantee\b/i,
  /\bguaranteed\s+(?:profit|return)s?\b/i,
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

/**
 * Categoría "branding" — reescritura determinista de terminología prohibida.
 *
 * La casa no usa la palabra "Soberanía" de cara al usuario (ver CLAUDE.md,
 * REGLAS ABSOLUTAS 6). El fondo de emergencia se llama "Reserva de Imprevistos"
 * en todos los idiomas.
 *
 * EL ORDEN ES SIGNIFICATIVO: las expresiones compuestas se resuelven antes que
 * el residual `soberanía|soberano → dominio`. Si se invirtiera, "Reserva de
 * Soberanía" quedaría como "Reserva de dominio". No reordenar sin revisar
 * `applyBranding()` y sus tests.
 *
 * "fondo" es masculino y "Reserva" femenina: los artículos que lo preceden se
 * absorben en la sustitución para no dejar "el Reserva de Imprevistos". Los
 * posesivos (tu, su, mi) no marcan género y no necesitan regla propia.
 *
 * `preserveCase` copia la caja de la primera letra del match a la sustitución.
 * Va activo solo donde la sustitución NO empieza por nombre propio: los
 * artículos ("el fondo…" → "La Reserva…" a principio de frase) y el residual
 * "dominio". "Reserva de Imprevistos" y "Dominio Financiero" son términos de la
 * casa y van siempre capitalizados, aparezcan como aparezcan en el original.
 *
 * Todos los patrones llevan flags `g` + `i` (case-insensitive, global) y toleran
 * la variante sin tilde.
 */
export interface BrandingRule {
  pattern: RegExp;
  replacement: string;
  preserveCase?: boolean;
}

export const BRANDING_REWRITES: ReadonlyArray<BrandingRule> = [
  // ── ES ─────────────────────────────────────────────────────────────────────
  { pattern: /\breserva\s+de\s+soberan[íi]a\b/gi, replacement: 'Reserva de Imprevistos' },
  { pattern: /\breserva\s+de\s+emergencia\b/gi, replacement: 'Reserva de Imprevistos' },
  { pattern: /\bel\s+fondo\s+de\s+emergencia\b/gi, replacement: 'la Reserva de Imprevistos', preserveCase: true },
  { pattern: /\bun\s+fondo\s+de\s+emergencia\b/gi, replacement: 'una Reserva de Imprevistos', preserveCase: true },
  { pattern: /\bfondo\s+de\s+emergencia\b/gi, replacement: 'Reserva de Imprevistos' },
  { pattern: /\bsoberan[íi]a\s+financiera\b/gi, replacement: 'Dominio Financiero' },

  // ── PT ─────────────────────────────────────────────────────────────────────
  { pattern: /\breserva\s+de\s+soberania\b/gi, replacement: 'Reserva de Imprevistos' },
  { pattern: /\breserva\s+de\s+emerg[êe]ncia\b/gi, replacement: 'Reserva de Imprevistos' },
  { pattern: /\bo\s+fundo\s+de\s+emerg[êe]ncia\b/gi, replacement: 'a Reserva de Imprevistos', preserveCase: true },
  { pattern: /\bum\s+fundo\s+de\s+emerg[êe]ncia\b/gi, replacement: 'uma Reserva de Imprevistos', preserveCase: true },
  { pattern: /\bfundo\s+de\s+emerg[êe]ncia\b/gi, replacement: 'Reserva de Imprevistos' },
  { pattern: /\bsoberania\s+financeira\b/gi, replacement: 'Dominio Financiero' },

  // ── EN ─────────────────────────────────────────────────────────────────────
  { pattern: /\b(?:an?\s+)?emergency\s+fund\b/gi, replacement: 'Reserva de Imprevistos' },
  { pattern: /\bemergency\s+reserve\b/gi, replacement: 'Reserva de Imprevistos' },
  { pattern: /\bsovereignty\s+reserve\b/gi, replacement: 'Reserva de Imprevistos' },
  { pattern: /\bfinancial\s+sovereignty\b/gi, replacement: 'Dominio Financiero' },

  // Residual — SIEMPRE al final: si corriera antes, "Reserva de Soberanía"
  // quedaría como "Reserva de dominio".
  { pattern: /\bsoberan(?:[íi]as?|[oa]s?)\b/gi, replacement: 'dominio', preserveCase: true },
  { pattern: /\bsovereign(?:ty)?\b/gi, replacement: 'dominio', preserveCase: true },
];

/**
 * Pieza 5c — RED ANTI-FUGA: términos de proveedor/modelo que NUNCA deben llegar
 * al usuario (identidad en 3 capas: prompt + injection.ts detecta el sondeo +
 * esta red elimina la fuga si, aun así, se coló en la respuesta). Aplica en
 * TODOS los carriles, incluido META — el campo `model` del JSON de respuesta
 * (instrumento de debugging) es un canal aparte y esta red nunca lo toca.
 */
export const PROVIDER_LEAK_REGEXES: ReadonlyArray<RegExp> = [
  /\bopen\s*ai\b/i,
  /\bgpt-?[34]\b/i,
  /\bchatgpt\b/i,
  /\banthropic\b/i,
  /\bclaude\b/i,
  /\bmistral\b/i,
  /\bllama\b/i,
  /\bgemini\b/i,
  /\bdeepseek\b/i,
  /\bqwen\b/i,
];
