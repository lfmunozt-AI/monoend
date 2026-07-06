// PIEZA 3 — Política de acción + log.
//
// A partir del resultado del validador (Pieza 2):
//   · Si NO hay cifras bloqueadas → se entrega la respuesta tal cual.
//   · Si HAY cifras bloqueadas → se aplica la política configurable:
//       - MODO MVP: se reemplaza la frase que contiene el monto inventado por
//         una petición de dato.
//       - MODO passthrough: no se reescribe (solo se loguea); útil para medir
//         sin alterar la UX.
//   · En ambos casos se generan entradas de log con SOLO metadatos.
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

function buildRequest(hint?: string): string {
  return hint
    ? `Para darte esa cifra necesito conocer tu ${hint}.`
    : "Para darte esa cifra primero necesito un dato que aún no me has compartido.";
}

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
    pregunta_hash: preguntaHash,
  }));

  if (blocked.length === 0) {
    return { texto_final: modelResponse, bloqueado: false, logEntries };
  }

  if (mode === "passthrough") {
    return { texto_final: modelResponse, bloqueado: true, logEntries };
  }

  // MODO MVP: reescribe cada frase que contenga un monto bloqueado.
  const texto_final = rewriteBlockedSentences(modelResponse, blocked, buildRequest(dataHint));
  return { texto_final, bloqueado: true, logEntries };
}

function rewriteBlockedSentences(
  text: string,
  blocked: BlockedFigure[],
  replacement: string,
): string {
  const segments = splitSentences(text);
  const out: string[] = [];
  let lastWasReplacement = false;

  for (const seg of segments) {
    const hit = blocked.some((b) => b.start >= seg.start && b.start < seg.end);
    if (hit) {
      // Evita repetir la misma petición en frases bloqueadas consecutivas.
      if (!lastWasReplacement) {
        out.push(replacement + " ");
        lastWasReplacement = true;
      }
    } else {
      out.push(seg.text);
      lastWasReplacement = false;
    }
  }

  return out.join("").trim();
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
