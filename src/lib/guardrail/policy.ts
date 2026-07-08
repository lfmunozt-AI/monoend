// PIEZA 3 — Política de acción + log.
//
// A partir del resultado del validador (Pieza 2):
//   · Si NO hay cifras bloqueadas → se entrega la respuesta tal cual, SALVO que
//     cite un estándar como referencia sin pedir el dato personal: entonces se
//     le añade el cierre (tercera vía, ver `containsDataRequest`).
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
import { detectLanguage, DEFAULT_LANGUAGE, type Language } from "../language";

export type PolicyMode = "mvp" | "passthrough";

export interface PolicyOptions {
  /** "mvp" (reescribe la frase) | "passthrough" (solo loguea). Por defecto "mvp". */
  mode?: PolicyMode;
  /**
   * Pista del dato que falta para personalizar la petición. Si no se da, se usa
   * una frase genérica. NO debe contener datos sensibles del usuario.
   */
  dataHint?: string;
  /** Idioma del cierre. Si no se da, se infiere de la respuesta del modelo. */
  idioma?: Language;
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

// ── Petición de cierre (ES/PT/EN) ─────────────────────────────────────────────
// Regla transversal del proyecto: todo mensaje del sistema existe en los tres
// idiomas. El idioma sale de `options.idioma`, y si no se da, del propio texto.

/** Cierre genérico cuando no se puede identificar qué dato faltó. */
const GENERIC_REQUEST: Record<Language, string> = {
  es: "Para darte cifras exactas necesito tus gastos mensuales y tu meta. ¿Me los compartes?",
  pt: "Para te dar números exatos preciso das tuas despesas mensais e da tua meta. Partilhas comigo?",
  en: "To give you exact numbers I need your monthly expenses and your goal. Can you share both?",
};

/** Plantilla del cierre con pista explícita del llamante (`dataHint`). */
const HINT_REQUEST: Record<Language, (hint: string) => string> = {
  es: (h) => `Para darte esa cifra necesito conocer tu ${h}. ¿Me lo compartes?`,
  pt: (h) => `Para te dar esse número preciso de saber o teu ${h}. Partilhas comigo?`,
  en: (h) => `To give you that number I need to know your ${h}. Can you share it?`,
};

/**
 * Petición específica por etiqueta de la cifra bloqueada. Si el modelo inventó
 * "gastarás 2000 al mes", la etiqueta es "gasto" y el dato que falta son sus
 * gastos reales. Solo se usa cuando TODAS las cifras bloqueadas comparten una
 * misma etiqueta conocida; con etiquetas mezcladas, el cierre genérico.
 *
 * Las claves (gasto, ingreso…) las produce `detectLabel`, que trabaja en ES: son
 * identificadores internos, no texto de cara al usuario.
 */
const REQUEST_BY_LABEL: Record<Language, Record<string, string>> = {
  es: {
    gasto: "Para darte esa cifra necesito tus gastos mensuales. ¿Me los compartes?",
    ingreso: "Para darte esa cifra necesito tus ingresos mensuales. ¿Me los compartes?",
    meta: "Para darte esa cifra necesito tu meta y el plazo en que la quieres. ¿Me lo cuentas?",
    ahorro: "Para darte esa cifra necesito saber cuánto ahorras cada mes. ¿Me lo compartes?",
    deuda: "Para darte esa cifra necesito el importe pendiente de tus deudas. ¿Me lo compartes?",
    interes: "Para darte esa cifra necesito la tasa de interés que pagas. ¿Me la compartes?",
    renta: "Para darte esa cifra necesito cuánto pagas de alquiler al mes. ¿Me lo compartes?",
  },
  pt: {
    gasto: "Para te dar esse número preciso das tuas despesas mensais. Partilhas comigo?",
    ingreso: "Para te dar esse número preciso dos teus rendimentos mensais. Partilhas comigo?",
    meta: "Para te dar esse número preciso da tua meta e do prazo. Contas-me?",
    ahorro: "Para te dar esse número preciso de saber quanto poupas por mês. Partilhas comigo?",
    deuda: "Para te dar esse número preciso do valor em dívida. Partilhas comigo?",
    interes: "Para te dar esse número preciso da taxa de juro que pagas. Partilhas comigo?",
    renta: "Para te dar esse número preciso de saber quanto pagas de renda por mês. Partilhas comigo?",
  },
  en: {
    gasto: "To give you that number I need your monthly expenses. Can you share them?",
    ingreso: "To give you that number I need your monthly income. Can you share it?",
    meta: "To give you that number I need your goal and its deadline. Can you tell me?",
    ahorro: "To give you that number I need to know how much you save each month. Can you share it?",
    deuda: "To give you that number I need your outstanding debt. Can you share it?",
    interes: "To give you that number I need the interest rate you pay. Can you share it?",
    renta: "To give you that number I need how much rent you pay monthly. Can you share it?",
  },
};

/**
 * Cierre estándar (genérico) del guardarraíl v2, por idioma. Exportado para que
 * el enforcement del validador (C1) reutilice EXACTAMENTE la misma frase en vez
 * de mantener una réplica que se desincronice.
 */
export function standardClosingRequest(lang: Language = DEFAULT_LANGUAGE): string {
  return GENERIC_REQUEST[lang];
}

/**
 * Construye la ÚNICA línea de cierre. Precedencia:
 *   1. `dataHint` explícito del llamante.
 *   2. Etiqueta única entre las cifras bloqueadas (gasto, ingreso, meta…).
 *   3. Genérico.
 */
function buildClosingRequest(
  entries: GuardrailLogEntry[],
  hint: string | undefined,
  lang: Language,
): string {
  if (hint) return HINT_REQUEST[lang](hint);

  const byLabel = REQUEST_BY_LABEL[lang];
  const labels = new Set(entries.map((e) => e.etiqueta).filter((l) => l in byLabel));
  if (labels.size === 1) return byLabel[[...labels][0]];

  return GENERIC_REQUEST[lang];
}

// ── Detección de cierre ya presente ───────────────────────────────────────────

function norm(s: string): string {
  return s.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase();
}

// Verbos con los que se cierra proponiendo o pidiendo un dato (ES/PT/EN).
// Se evalúa sobre texto normalizado (sin acentos, minúsculas).
const PROPOSAL_RE = new RegExp(
  "\\b(" +
    // ES
    "te propongo|propongo|mi propuesta|siguiente paso|empecemos|empieza por|hagamos|" +
    "comparteme|compartes|comparte|dame|damelo|pasame|indicame|facilitame|dime|" +
    "cuentame|enviame|mandame|necesito|" +
    // PT
    "proponho|a minha proposta|proximo passo|comecemos|vamos|partilhas|partilha|" +
    "diz-me|conta-me|envia-me|preciso|" +
    // EN
    "i propose|my proposal|next step|let's start|share|tell me|send me|give me|" +
    "i need|can you share|what's your" +
  ")\\b",
);

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
 *
 * Exportada: el enforcement del validador (C1) la reutiliza para no añadir un
 * cierre a una respuesta que ya lo trae.
 */
export function endsWithRequestOrProposal(text: string): boolean {
  const last = lastSentence(text);
  if (!last) return false;
  if (last.endsWith("?")) return true;
  return PROPOSAL_RE.test(norm(last));
}

/**
 * ¿La respuesta pide un dato EN ALGÚN punto, no necesariamente al final?
 *
 * Es el requisito de la tercera vía: un estándar puede citarse como referencia
 * solo si la respuesta, en conjunto, reclama el dato personal que falta. Si no
 * lo hace, el cierre v2 se añade para cubrirla.
 */
export function containsDataRequest(text: string): boolean {
  if (text.includes("?")) return true;
  return PROPOSAL_RE.test(norm(text));
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
 *
 * Exportada: el enforcement del validador (C1) elimina frases igual que aquí y
 * necesita exactamente la misma limpieza.
 */
export function cleanup(text: string): string {
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
  const lang = options.idioma ?? detectLanguage(modelResponse) ?? DEFAULT_LANGUAGE;
  const blocked = validation.cifras_bloqueadas;
  const referencias = validation.cifras_aprobadas.filter((c) => c.categoria === "referencia");

  const logEntries: GuardrailLogEntry[] = blocked.map((b) => ({
    cifra_bloqueada: b.valor,
    texto: b.texto,
    motivo: b.motivo,
    etiqueta: b.etiqueta,
    pregunta_hash: preguntaHash,
  }));

  // MODO passthrough: nunca reescribe, solo loguea.
  if (mode === "passthrough") {
    return { texto_final: modelResponse, bloqueado: blocked.length > 0, logEntries };
  }

  if (blocked.length === 0) {
    // TERCERA VÍA: la respuesta cita un estándar etiquetado como referencia. Se
    // permite, pero un estándar sin petición del dato personal se lee como
    // diagnóstico. Si la respuesta no reclama el dato, el cierre lo reclama.
    if (referencias.length > 0 && !containsDataRequest(modelResponse)) {
      const texto_final = appendClosing(cleanup(modelResponse), buildClosingRequest([], dataHint, lang));
      return { texto_final, bloqueado: false, logEntries };
    }
    return { texto_final: modelResponse, bloqueado: false, logEntries };
  }

  // MODO MVP (v2): elimina las frases con montos inventados y cierra UNA vez.
  const { texto, eliminadas } = removeBlockedSentences(modelResponse, blocked);
  if (eliminadas === 0) {
    return { texto_final: modelResponse, bloqueado: true, logEntries };
  }

  const texto_final = appendClosing(texto, buildClosingRequest(logEntries, dataHint, lang));
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
