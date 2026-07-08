// Detección de idioma para las capas de política (guardarraíl y validador).
//
// REGLA TRANSVERSAL DEL PROYECTO: toda lista de detección, diccionario o mensaje
// del sistema cubre SIEMPRE los tres idiomas ES/PT/EN. Este módulo es la pieza
// que permite elegir el mensaje correcto sin arrastrar el idioma del perfil por
// media docena de firmas.
//
// Heurística de stopwords ponderadas, no un clasificador. El par difícil es
// ES/PT (léxico muy solapado): se puntúa solo con marcas EXCLUSIVAS de cada uno
// ("você"/"não"/"teu" vs "¿"/"tus"/"eres"). Ante empate o texto sin señal, ES.
// Código PURO, edge-safe, sin dependencias.

export type Language = "es" | "pt" | "en";

export const DEFAULT_LANGUAGE: Language = "es";

/**
 * Marcas EXCLUSIVAS por idioma. Esto es lo delicado del módulo.
 *
 * Nada de léxico compartido: "es", "mes", "meta", "anos", "está", "que" existen
 * en español Y portugués, y meterlos aquí hace que el detector clasifique como
 * PT una frase castellana tan trivial como "La regla es ahorrar". Solo entran
 * palabras que un idioma usa y el otro no, con su tilde cuando la tilde es lo
 * que las distingue ("és" portugués vs "es" español).
 */
const SIGNALS: Record<Language, [RegExp, number][]> = {
  es: [
    [/[¿¡]/, 2],
    [/\b(?:eres|tus|quieres|dinero|inversi[óo]n|años|ahorro|ahorrar|ahorras)\b/i, 2],
    [/\b(?:cu[áa]nto|tambi[ée]n|qué|c[óo]mo)\b/i, 1],
    [/\b(?:hola|gracias|necesito|quiero|tengo|gastos|ingresos|mensuales)\b/i, 1],
  ],
  pt: [
    // ã, õ, ç y ê no existen en castellano: marca ortográfica inequívoca.
    [/[ãõçê]/i, 2],
    [/\b(?:não|você|teu|tua|teus|tuas|és|são|dívida)\b/i, 2],
    [/\b(?:dinheiro|investimento|poupança|poupas|lucro|mês|despesas|rendimentos?)\b/i, 2],
    [/\b(?:tudo|ganhas|garantido|garantida|impossível|padrão)\b/i, 2],
    [/\b(?:queres|podes|obrigado|olá|partilhas|comigo|juro|certeza)\b/i, 1],
  ],
  en: [
    [/\b(?:can't|cannot|don't|what's|i'm|you're)\b/i, 2],
    [/\b(?:money|savings|investment|returns?|goal|income|expenses?|guaranteed)\b/i, 2],
    [/\b(?:the|you|your|and|is|to)\b/i, 1],
    [/\b(?:hello|thanks|need|want|risk|everything|month)\b/i, 1],
  ],
};

/**
 * Idioma dominante del texto. Devuelve `DEFAULT_LANGUAGE` si no hay señal o si
 * hay empate: preferimos responder en español antes que en el idioma equivocado.
 */
export function detectLanguage(text: string): Language {
  if (!text || !text.trim()) return DEFAULT_LANGUAGE;

  const scores: Record<Language, number> = { es: 0, pt: 0, en: 0 };
  for (const lang of Object.keys(SIGNALS) as Language[]) {
    for (const [re, weight] of SIGNALS[lang]) {
      if (re.test(text)) scores[lang] += weight;
    }
  }

  // PT y ES comparten casi todo: una marca exclusiva de PT ("não", "você") pesa
  // más que el solapamiento genérico, así que ya viene ponderada arriba.
  let best: Language = DEFAULT_LANGUAGE;
  for (const lang of ["es", "pt", "en"] as Language[]) {
    if (scores[lang] > scores[best]) best = lang;
  }
  return scores[best] === 0 ? DEFAULT_LANGUAGE : best;
}
