// PIEZA 3 — Política de acción + log.
//
// A partir del resultado del validador (Pieza 2):
//   · Si NO hay cifras bloqueadas → se entrega la respuesta tal cual.
//   · Si HAY cifras bloqueadas → se aplica la política configurable:
//       - MODO MVP (v2): la frase que contiene el monto inventado se ELIMINA
//         entera y, si hubo al menos una eliminación, se añade UNA SOLA línea
//         de cierre pidiendo el dato que falta.
//       - MODO passthrough: no se reescribe (solo se loguea); útil para medir
//         sin alterar la UX.
//   · En ambos casos se generan entradas de log con SOLO metadatos.
//
// Por qué v2: en QA la plantilla de petición sustituía cada frase bloqueada, y
// una respuesta con tres cifras sin fundamento acababa con la misma frase
// ("Para darte esa cifra primero necesito un dato…") incrustada tres veces. El
// modelo del Consigliere cierra con UNA petición de dato, nunca con varias.
//
// Reescritura y construcción del log: código PURO (~ms). El hash de la pregunta
// y la inserción en DB son helpers aparte (async) que el orquestador invoca.

import type { SupabaseClient } from "@supabase/supabase-js";
import type { BlockedFigure, GroundingResult } from "./validate";

export type PolicyMode = "mvp" | "passthrough";

export interface PolicyOptions {
  /** "mvp" (reescribe la frase) | "passthrough" (solo loguea). Por defecto "mvp". */
  mode?: PolicyMode;
  /**
   * Pista del dato que falta para personalizar la petición. Si no se da, se usa
   * una frase genérica. NO debe contener datos sensibles del usuario.
   */
  dataHint?: string;
}

/** Entrada de log: SOLO metadatos. Nunca el texto del usuario ni la respuesta. */
export interface GuardrailLogEntry {
  /** Valor numérico bloqueado (metadato, no contenido sensible). */
  cifra_bloqueada: number;
  /** Literal exacto bloqueado ("1500"). */
  texto: string;
  /** Por qué se bloqueó. */
  motivo: string;
  /**
   * A qué se refería la cifra ("gasto", "ingreso", "meta"…) o "". Permite pedir
   * el dato que falta de forma específica. No se persiste en DB (sin columna).
   */
  etiqueta: string;
  /** Hash de la pregunta — para correlacionar sin almacenar el texto. */
  pregunta_hash: string;
}

export interface PolicyResult {
  /** Respuesta final a entregar (reescrita si modo mvp y hubo bloqueos). */
  texto_final: string;
  /** true si hubo al menos una cifra bloqueada. */
  bloqueado: boolean;
  /** Entradas de log a persistir (metadatos). */
  logEntries: GuardrailLogEntry[];
}

// ── Petición de cierre ────────────────────────────────────────────────────────

/** Cierre genérico cuando no se puede identificar qué dato faltó. */
const GENERIC_REQUEST =
  "Para darte cifras exactas necesito tus gastos mensuales y tu meta. ¿Me los compartes?";

/**
 * Petición específica por etiqueta de la cifra bloqueada. Si el modelo inventó
 * "gastarás 2000 al mes", la etiqueta es "gasto" y el dato que falta son sus
 * gastos reales. Solo se usa cuando TODAS las cifras bloqueadas comparten una
 * misma etiqueta conocida; con etiquetas mezcladas, el cierre genérico.
 */
const REQUEST_BY_LABEL: Record<string, string> = {
  gasto: "Para darte esa cifra necesito tus gastos mensuales. ¿Me los compartes?",
  ingreso: "Para darte esa cifra necesito tus ingresos mensuales. ¿Me los compartes?",
  meta: "Para darte esa cifra necesito tu meta y el plazo en que la quieres. ¿Me lo cuentas?",
  ahorro: "Para darte esa cifra necesito saber cuánto ahorras cada mes. ¿Me lo compartes?",
  deuda: "Para darte esa cifra necesito el importe pendiente de tus deudas. ¿Me lo compartes?",
  interes: "Para darte esa cifra necesito la tasa de interés que pagas. ¿Me la compartes?",
  renta: "Para darte esa cifra necesito cuánto pagas de alquiler al mes. ¿Me lo compartes?",
};

/**
 * Construye la ÚNICA línea de cierre. Precedencia:
 *   1. `dataHint` explícito del llamante.
 *   2. Etiqueta única entre las cifras bloqueadas (gasto, ingreso, meta…).
 *   3. Genérico.
 */
function buildClosingRequest(entries: GuardrailLogEntry[], hint?: string): string {
  if (hint) return `Para darte esa cifra necesito conocer tu ${hint}. ¿Me lo compartes?`;

  const labels = new Set(
    entries.map((e) => e.etiqueta).filter((l) => l in REQUEST_BY_LABEL),
  );
  if (labels.size === 1) return REQUEST_BY_LABEL[[...labels][0]];

  return GENERIC_REQUEST;
}

// ── Detección de cierre ya presente ───────────────────────────────────────────

function norm(s: string): string {
  return s.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase();
}

// Verbos con los que el Consigliere cierra proponiendo o pidiendo un dato.
const PROPOSAL_RE =
  /\b(te propongo|propongo|mi propuesta|siguiente paso|empecemos|empieza por|hagamos|comparteme|compartes|comparte|dime|cuentame|enviame|mandame|necesito)\b/;

/** Última frase no vacía del texto. */
function lastSentence(text: string): string {
  const parts = text
    .split(/(?<=[.!?])\s+|\n+/)
    .map((s) => s.trim())
    .filter(Boolean);
  return parts.at(-1) ?? "";
}

/**
 * ¿El texto ya termina pidiendo un dato o proponiendo una jugada? En ese caso
 * añadir el cierre duplicaría la petición (regla 3).
 */
function endsWithRequestOrProposal(text: string): boolean {
  const last = lastSentence(text);
  if (!last) return false;
  if (last.endsWith("?")) return true;
  return PROPOSAL_RE.test(norm(last));
}

// ── Segmentación y limpieza ───────────────────────────────────────────────────

// Segmenta el texto en frases conservando los delimitadores, de modo que
// concatenar los segmentos reproduce el original exacto.
interface Segment {
  text: string;
  start: number;
  end: number;
}
function splitSentences(text: string): Segment[] {
  const re = /[^.!?\n]*[.!?\n]+|[^.!?\n]+$/g;
  const segs: Segment[] = [];
  for (const m of text.matchAll(re)) {
    const start = m.index ?? 0;
    segs.push({ text: m[0], start, end: start + m[0].length });
  }
  return segs.length ? segs : [{ text, start: 0, end: text.length }];
}

/**
 * Tras eliminar frases quedan espacios dobles y líneas huérfanas. Se colapsan
 * los espacios internos, se recortan las líneas y se reducen los saltos
 * múltiples a un máximo de párrafo.
 */
function cleanup(text: string): string {
  return text
    .split("\n")
    .map((line) => line.replace(/[ \t]+/g, " ").trim())
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/** Elimina por completo cada frase que contenga una cifra bloqueada. */
function removeBlockedSentences(
  text: string,
  blocked: BlockedFigure[],
): { texto: string; eliminadas: number } {
  const segments = splitSentences(text);
  const kept: string[] = [];
  let eliminadas = 0;

  for (const seg of segments) {
    const hit = blocked.some((b) => b.start >= seg.start && b.start < seg.end);
    if (hit) eliminadas++;
    else kept.push(seg.text);
  }

  return { texto: cleanup(kept.join("")), eliminadas };
}

/**
 * Aplica la política a la respuesta del modelo según el resultado del validador.
 * Construye también las entradas de log (solo metadatos) usando `preguntaHash`,
 * que el llamante calcula con `hashQuestion()`.
 */
export function applyPolicy(
  modelResponse: string,
  validation: GroundingResult,
  preguntaHash: string,
  options: PolicyOptions = {},
): PolicyResult {
  const { mode = "mvp", dataHint } = options;
  const blocked = validation.cifras_bloqueadas;

  const logEntries: GuardrailLogEntry[] = blocked.map((b) => ({
    cifra_bloqueada: b.valor,
    texto: b.texto,
    motivo: b.motivo,
    etiqueta: b.etiqueta,
    pregunta_hash: preguntaHash,
  }));

  if (blocked.length === 0) {
    return { texto_final: modelResponse, bloqueado: false, logEntries };
  }

  if (mode === "passthrough") {
    return { texto_final: modelResponse, bloqueado: true, logEntries };
  }

  // MODO MVP (v2): elimina las frases con montos inventados y cierra UNA vez.
  const { texto, eliminadas } = removeBlockedSentences(modelResponse, blocked);
  if (eliminadas === 0) {
    return { texto_final: modelResponse, bloqueado: true, logEntries };
  }

  const texto_final = appendClosing(texto, buildClosingRequest(logEntries, dataHint));
  return { texto_final, bloqueado: true, logEntries };
}

/**
 * Añade la línea de cierre una sola vez. Si lo que sobrevivió ya termina en una
 * petición de dato o en una propuesta, no se duplica (regla 3). Si no sobrevivió
 * nada, la petición ES la respuesta.
 */
function appendClosing(texto: string, cierre: string): string {
  if (!texto) return cierre;
  if (endsWithRequestOrProposal(texto)) return texto;
  return `${texto}\n\n${cierre}`;
}

// ── Helpers de integración (async) ────────────────────────────────────────────

/**
 * Hash hex (SHA-256, 16 chars) de la pregunta del usuario. Permite correlacionar
 * bloqueos sin almacenar el texto. Edge-safe: usa Web Crypto (crypto.subtle),
 * disponible tanto en el runtime edge como en Node 20+.
 */
export async function hashQuestion(question: string): Promise<string> {
  const data = new TextEncoder().encode(question.trim());
  const digest = await crypto.subtle.digest("SHA-256", data);
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("")
    .slice(0, 16);
}

/**
 * Persiste las entradas de log en `guardrail_log` (solo metadatos). Reutiliza el
 * cliente Supabase de la request (RLS por user_id). Best-effort: nunca lanza,
 * para no tumbar el chat si el log falla.
 */
export async function logGuardrailEvents(
  supabase: SupabaseClient,
  userId: string,
  entries: GuardrailLogEntry[],
): Promise<void> {
  if (entries.length === 0) return;
  try {
    const rows = entries.map((e) => ({
      user_id: userId,
      blocked_value: e.cifra_bloqueada,
      blocked_text: e.texto,
      reason: e.motivo,
      question_hash: e.pregunta_hash,
    }));
    const { error } = await supabase.from("guardrail_log").insert(rows);
    if (error) throw new Error(error.message);
  } catch (err) {
    console.error("logGuardrailEvents falló (no bloquea el chat):", err);
  }
}
