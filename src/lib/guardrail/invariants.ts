// AUDITORÍA AG01 (H2 + H5) — assertOutputInvariants: la garantía de calidad del
// pipeline vivía repartida en 3-5 capas que insertaban/eliminaban texto sin
// conocerse entre sí (ver docs/PIPELINE_CONTRACT.md). Esta función es el ÚNICO
// paso final, después de `resolveClosing`, que verifica y corrige el texto que
// SALE. Ninguna capa intermedia vuelve a ser responsable de la garantía
// global — su trabajo es no introducir violaciones; esta es la red de
// seguridad determinista.
//
// Contrato: pura, nunca lanza, idempotente (aplicarla dos veces da el mismo
// resultado). Código PURO, edge-safe, SIN llamadas a ningún LLM.

import { segmentSentences, splitSentences, conceptsInSentence } from "./context";
import {
  cleanup,
  endsWithRequestOrProposal,
  isDelegativeClosing,
  stripDelegativeClosing,
  enforceSimulationHonesty,
  MISSING_KEYWORDS,
} from "./policy";
import { DERIVED_CONCEPTS } from "./validate";
import { PROVIDER_LEAK_REGEXES } from "../llm/validator-rules";
import { DEFAULT_LANGUAGE, type Language } from "../language";
import type { Carril } from "./turn-classifier";

export interface OutputInvariantContext {
  carril: Carril;
  lang: Language;
  /** Qué falta para el playbook activo (scenario.missing). */
  missing: string[];
  /** Lo que el motor SÍ calculó este turno (buildScenarioContext). */
  conceptos: Record<string, number>;
  /** ¿La cuota citada es una simulación con TAE de referencia? */
  esSimulacion: boolean;
}

export type InvariantId = "a" | "b" | "c" | "d" | "e";
export type InvariantAction = "corregido" | "logueado";

export interface InvariantViolation {
  id: InvariantId;
  accion: InvariantAction;
  detalle?: string;
}

export interface InvariantReport {
  texto: string;
  violaciones: InvariantViolation[];
}

function norm(s: string): string {
  return s.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase();
}

// ── (b) coordinación TAE — cláusula de simulación + cierre de TAE ────────────
// QA real (H2): "(simulación con TAE de referencia — tu banco te dará la tasa
// real)" convive con "¿Qué TAE te ofrece TU BANCO?" — no es una pregunta
// duplicada (una sola "?"), pero "tu banco" se menciona DOS veces, sensación de
// guion repetido. Si el cierre YA pide la TAE (mismo campo), la cláusula se
// recorta a la forma corta — una sola mención de "tu banco".
const BANCO_MENTION_RE: Record<Language, RegExp> = {
  es: /tu banco/gi,
  pt: /teu banco/gi,
  en: /your bank/gi,
};

const SHORT_SIMULATION_CLAUSE: Record<Language, string> = {
  es: "(simulación con TAE de referencia del 7%)",
  pt: "(simulação com TAEG de referência de 7%)",
  en: "(a simulation with a 7% reference APR)",
};

const SIMULATION_CLAUSE_RE = /\([^)]*(?:simulaci[oó]n|simula[çc][ãa]o|simulation)[^)]*\)/i;

function coordinateTaeMention(text: string, lang: Language): { texto: string; corregido: boolean } {
  const bancoRe = BANCO_MENTION_RE[lang] ?? BANCO_MENTION_RE[DEFAULT_LANGUAGE];
  const mentions = text.match(new RegExp(bancoRe.source, bancoRe.flags)) ?? [];
  if (mentions.length < 2) return { texto: text, corregido: false };
  if (!SIMULATION_CLAUSE_RE.test(text)) return { texto: text, corregido: false };

  const short = SHORT_SIMULATION_CLAUSE[lang] ?? SHORT_SIMULATION_CLAUSE[DEFAULT_LANGUAGE];
  const texto = cleanup(text.replace(SIMULATION_CLAUSE_RE, short));
  return { texto, corregido: texto !== text };
}

// ── (a) máx. 1 pregunta final ────────────────────────────────────────────────
// Bloque de cierre: frases finales que son pregunta/propuesta, recolectadas
// desde el final mientras lo sean (mismo criterio que `enforceMissingClosing`).
function maxOneClosingQuestion(
  text: string,
  missing: string[],
): { texto: string; corregido: boolean } {
  const sentences = splitSentences(text);
  if (sentences.length === 0) return { texto: text, corregido: false };

  let start = sentences.length;
  while (start > 0 && endsWithRequestOrProposal(sentences.slice(0, start).join(" "))) {
    // endsWithRequestOrProposal opera sobre la ÚLTIMA frase del texto que se le
    // pase: reconstruimos el prefijo para evaluar cada candidata desde el final.
    start--;
  }
  const closingIdxs: number[] = [];
  for (let i = sentences.length - 1; i >= start; i--) closingIdxs.unshift(i);

  const questionIdxs = closingIdxs.filter((i) => sentences[i].trim().endsWith("?"));
  if (questionIdxs.length <= 1) return { texto: text, corregido: false };

  // Prioridad: la pregunta que menciona missing[0] gana; si ninguna lo hace, la
  // ÚLTIMA (la más reciente en la respuesta) gana.
  const field = missing[0] === "meta_monto" ? "meta" : missing[0];
  const keywordRe = field ? MISSING_KEYWORDS[field] : undefined;
  let keepIdx = questionIdxs[questionIdxs.length - 1];
  if (keywordRe) {
    const withKeyword = questionIdxs.find((i) => keywordRe.test(norm(sentences[i])));
    if (withKeyword !== undefined) keepIdx = withKeyword;
  }

  const drop = new Set(questionIdxs.filter((i) => i !== keepIdx));
  const texto = cleanup(sentences.filter((_, i) => !drop.has(i)).join(" "));
  return { texto, corregido: true };
}

// ── (c) concepto DERIVADO afirmado sin cálculo (defensa en profundidad de H1) ─
function stripUnbackedConcepts(
  text: string,
  conceptos: Record<string, number>,
): { texto: string; corregido: boolean } {
  let corregido = false;
  const kept = segmentSentences(text)
    .filter((seg) => {
      const nombrados = conceptsInSentence(seg.text);
      const deficitContrario = nombrados.includes("deficit") && (conceptos.sobrante ?? 0) > 0;
      const sinCalculo = nombrados.some((c) => DERIVED_CONCEPTS.has(c) && !(c in conceptos));
      if (deficitContrario || sinCalculo) {
        corregido = true;
        return false;
      }
      return true;
    })
    .map((s) => s.text)
    .join("");
  return { texto: cleanup(kept), corregido };
}

// ── (d) 0 términos de proveedor ───────────────────────────────────────────────
function stripProviderLeaks(text: string): { texto: string; corregido: boolean } {
  const leaks = PROVIDER_LEAK_REGEXES.some((re) => re.test(text));
  if (!leaks) return { texto: text, corregido: false };

  const kept = segmentSentences(text)
    .filter((seg) => !PROVIDER_LEAK_REGEXES.some((re) => re.test(seg.text)))
    .map((s) => s.text)
    .join("");
  return { texto: cleanup(kept), corregido: true };
}

/**
 * Verifica y corrige las 5 invariantes de salida (PIPELINE_CONTRACT.md §3)
 * sobre `text`, en orden. Devuelve el texto corregido y el detalle de cada
 * violación encontrada. Nunca lanza; si una corrección vacía la respuesta, el
 * texto resultante puede ser "" (el llamante decide el fallback de carril).
 */
export function assertOutputInvariants(
  text: string,
  ctx: OutputInvariantContext,
): InvariantReport {
  const violaciones: InvariantViolation[] = [];
  if (!text || !text.trim()) return { texto: text, violaciones };

  let out = text;

  // (d) y (e) aplican SIEMPRE, en todos los carriles (incluido META).
  const leak = stripProviderLeaks(out);
  if (leak.corregido) {
    out = leak.texto;
    violaciones.push({ id: "d", accion: "corregido", detalle: "fuga de identidad de proveedor/modelo" });
  }

  if (isDelegativeClosing(out)) {
    const before = out;
    out = stripDelegativeClosing(out);
    if (out !== before) {
      violaciones.push({ id: "e", accion: "corregido", detalle: "cierre delegativo eliminado" });
    }
  }

  // (a)-(c) solo tienen sentido en carriles con contenido financiero: META no
  // calcula conceptos, no simula crédito ni tiene missing que priorizar.
  if (ctx.carril !== "META") {
    const concepts = stripUnbackedConcepts(out, ctx.conceptos);
    if (concepts.corregido) {
      out = concepts.texto;
      violaciones.push({ id: "c", accion: "corregido", detalle: "concepto afirmado sin cálculo que lo respalde" });
    }

    const sim = enforceSimulationHonesty(out, { esSimulacion: ctx.esSimulacion, lang: ctx.lang });
    if (sim !== out) {
      out = sim;
      violaciones.push({ id: "b", accion: "corregido", detalle: "contradicción tasa/simulación" });
    }
    const coord = coordinateTaeMention(out, ctx.lang);
    if (coord.corregido) {
      out = coord.texto;
      violaciones.push({ id: "b", accion: "corregido", detalle: "cláusula de simulación recortada — TAE ya la pide el cierre" });
    }

    const closing = maxOneClosingQuestion(out, ctx.missing);
    if (closing.corregido) {
      out = closing.texto;
      violaciones.push({ id: "a", accion: "corregido", detalle: "más de una pregunta final — se conservó la de mayor prioridad" });
    }
  }

  return { texto: out, violaciones };
}
