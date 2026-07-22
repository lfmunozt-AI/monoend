// Detector básico de inyección de prompts (cierre de gap de auditoría).
//
// Solo DETECTA y expone la señal para que el llamante la loguee; NO bloquea
// (la decisión de política queda para una fase posterior). Código PURO,
// edge-safe, SIN llamadas a ningún LLM.
//
// Es deliberadamente conservador: prioriza NO marcar consultas financieras
// normales (falsos positivos costosos) sobre atrapar todo intento.

export interface InjectionResult {
  /** ¿El texto contiene un patrón sospechoso de inyección? */
  sospechoso: boolean;
  /** Nombre del PRIMER patrón que disparó la detección (compatibilidad). */
  patron?: string;
  /** Todos los patrones que casaron, sin repetir. Vacío si no hubo detección. */
  patrones: string[];
}

// Patrones sobre texto normalizado (sin acentos, minúsculas). El nombre es la
// etiqueta que se registra; la regex es lo que se busca.
//
// ES/PT/EN — regla transversal del proyecto. Los nombres de patrón son
// identificadores internos comunes a los tres idiomas: lo que importa en el log
// es QUÉ se intentó, no en qué idioma.
const PATTERNS: readonly [RegExp, string][] = [
  // ── Ignorar / olvidar instrucciones ────────────────────────────────────────
  [/ignora\s+(?:tus|las|todas|estas)?\s*(?:anteriores|previas)?\s*instrucciones/, "ignorar_instrucciones"],
  [/ignora\s+(?:as|todas\s+as|estas)?\s*(?:anteriores|previas)?\s*instrucoes/, "ignorar_instrucciones"],
  [/ignore\s+(?:all\s+)?(?:previous|prior|above|the)?\s*instructions/, "ignorar_instrucciones"],
  [/olvida\s+(?:tus|las|todo|todas)\b/, "olvidar_instrucciones"],
  [/esquece\s+(?:as|tudo|todas)\b/, "olvidar_instrucciones"],
  [/forget\s+(?:your|all|the|everything)\b/, "olvidar_instrucciones"],

  // ── Cambio de rol ──────────────────────────────────────────────────────────
  [/(?:eres|actua\s+como|comportate\s+como)\s+ahora\b/, "cambio_de_rol"],
  [/a\s+partir\s+de\s+ahora\s+(?:eres|actua|seras)/, "cambio_de_rol"],
  [/\bactua\s+como\b/, "cambio_de_rol"],
  [/a\s+partir\s+de\s+agora\s+(?:es|age|seras)/, "cambio_de_rol"],
  [/\bage\s+como\b/, "cambio_de_rol"],
  [/\bcomporta-?te\s+como\b/, "cambio_de_rol"],
  [/from\s+now\s+on\s+you\s+(?:are|will\s+be|act)/, "cambio_de_rol"],
  [/\bact\s+as\b/, "cambio_de_rol"],
  [/\bpretend\s+(?:to\s+be|you\s+are)\b/, "cambio_de_rol"],

  // ── Roles falsos inyectados ────────────────────────────────────────────────
  [/\bsystem\s*:/, "rol_falso_system"],
  [/\bassistant\s*:/, "rol_falso_assistant"],

  // ── Nuevas instrucciones ───────────────────────────────────────────────────
  [/nuevas?\s+instrucciones/, "nuevas_instrucciones"],
  [/novas?\s+instrucoes/, "nuevas_instrucciones"],
  [/new\s+instructions/, "nuevas_instrucciones"],

  // ── Desactivar el guardarraíl ──────────────────────────────────────────────
  [/desactiva\s+(?:el\s+)?(?:guardarrail|guardrail|filtro|las\s+reglas)/, "desactivar_guardrail"],
  [/desativa\s+(?:o\s+)?(?:guardrail|guardarrail|filtro|as\s+regras)/, "desactivar_guardrail"],
  [/disable\s+(?:the\s+)?(?:guardrail|guardrails|filter|rules|safety)/, "desactivar_guardrail"],

  // ── Sondeo de identidad (Pieza 5b) ──────────────────────────────────────────
  // NO es un ataque: es una pregunta legítima del usuario. Se detecta y expone
  // (event_type 'identity_probe') para vigilancia, pero NUNCA bloquea — la
  // respuesta la decide el prompt (Pieza 5a), no el guardarraíl. Mismas
  // keywords que el clasificador de turno (turn-classifier.ts) usa para META.
  [/\b(quien\s+eres|que\s+eres|que\s+modelo|que\s+version|fabricante|quien\s+te\s+hizo|quien\s+te\s+creo|como\s+funcionas|que\s+puedes\s+hacer)\b/, "identity_probe"],
  [/\b(quem\s+te\s+criou|quem\s+te\s+fez|que\s+modelo\s+es|qual\s+modelo|que\s+versao)\b/, "identity_probe"],
  [/\b(who\s+made\s+you|what\s+model|which\s+llm|what\s+version\s+are\s+you|how\s+do\s+you\s+work|what\s+can\s+you\s+do)\b/, "identity_probe"],
];

function norm(s: string): string {
  return s.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase();
}

/**
 * Detecta patrones de inyección de prompts. Recorre TODOS los patrones y devuelve
 * los nombres que casaron (`patrones`), además del primero (`patron`) por
 * compatibilidad con los llamantes previos.
 * NO bloquea: es responsabilidad del llamante decidir qué hacer con la señal.
 */
export function detectInjection(text: string): InjectionResult {
  if (!text || !text.trim()) return { sospechoso: false, patrones: [] };

  const t = norm(text);
  const encontrados: string[] = [];
  for (const [re, patron] of PATTERNS) {
    if (re.test(t) && !encontrados.includes(patron)) encontrados.push(patron);
  }

  if (encontrados.length === 0) return { sospechoso: false, patrones: [] };
  return { sospechoso: true, patron: encontrados[0], patrones: encontrados };
}
