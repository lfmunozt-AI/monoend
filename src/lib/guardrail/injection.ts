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
  /** Nombre del patrón que disparó la detección (para el log). */
  patron?: string;
}

// Patrones sobre texto normalizado (sin acentos, minúsculas). El nombre es la
// etiqueta que se registra; la regex es lo que se busca.
const PATTERNS: readonly [RegExp, string][] = [
  [/ignora\s+(?:tus|las|todas|estas)?\s*(?:anteriores|previas)?\s*instrucciones/, "ignorar_instrucciones"],
  [/ignore\s+(?:all\s+)?(?:previous|prior|above)\s+instructions/, "ignore_instructions_en"],
  [/olvida\s+(?:tus|las|todo|todas)\b/, "olvidar_instrucciones"],
  [/(?:eres|actua\s+como|comportate\s+como)\s+ahora\b/, "cambio_de_rol"],
  [/a\s+partir\s+de\s+ahora\s+(?:eres|actua|seras)/, "cambio_de_rol"],
  [/\bsystem\s*:/, "rol_falso_system"],
  [/\bassistant\s*:/, "rol_falso_assistant"],
  [/nuevas?\s+instrucciones/, "nuevas_instrucciones"],
  [/desactiva\s+(?:el\s+)?(?:guardarrail|guardrail|filtro|las\s+reglas)/, "desactivar_guardrail"],
];

function norm(s: string): string {
  return s.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase();
}

/**
 * Detecta patrones de inyección de prompts. Devuelve el primer patrón que casa.
 * NO bloquea: es responsabilidad del llamante decidir qué hacer con la señal.
 */
export function detectInjection(text: string): InjectionResult {
  if (!text || !text.trim()) return { sospechoso: false };
  const t = norm(text);
  for (const [re, patron] of PATTERNS) {
    if (re.test(t)) return { sospechoso: true, patron };
  }
  return { sospechoso: false };
}
