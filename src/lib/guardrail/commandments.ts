// THE COMMANDMENTS (ex assertOutputInvariants, AUDITORÍA AG01 H2+H5) — la
// garantía de calidad del pipeline vivía repartida en 3-5 capas que
// insertaban/eliminaban texto sin conocerse entre sí (ver
// docs/PIPELINE_CONTRACT.md). `enforceCommandments` es el ÚNICO paso final,
// después de `resolveClosing`, que verifica y corrige el texto que SALE.
// Ninguna capa intermedia vuelve a ser responsable de la garantía global; su
// trabajo es no introducir violaciones, esta es la red de seguridad
// determinista. Los invariantes (a)-(e) de AG01 pasan a ser los Mandamientos
// 1-5; esta tanda añade 6-8.
//
// Contrato: pura, nunca lanza, idempotente (aplicarla dos veces da el mismo
// resultado). Código PURO, edge-safe, SIN llamadas a ningún LLM.

import { segmentSentences, splitSentences, conceptsInSentence, hasReferenceMarker } from "./context";
import {
  cleanup,
  endsWithRequestOrProposal,
  isDelegativeClosing,
  stripDelegativeClosing,
  enforceSimulationHonesty,
  MISSING_KEYWORDS,
  type Mutation,
} from "./policy";
import { DERIVED_CONCEPTS } from "./validate";
import { findNumberMentions, type NumberMention } from "./numbers";
import { PROVIDER_LEAK_REGEXES } from "../llm/validator-rules";
import { detectLanguage, DEFAULT_LANGUAGE, type Language } from "../language";
import type { Carril } from "./turn-classifier";

export interface CommandmentContext {
  carril: Carril;
  lang: Language;
  /** Qué falta para el playbook activo (scenario.missing). */
  missing: string[];
  /** Lo que el motor SÍ calculó este turno (buildScenarioContext). */
  conceptos: Record<string, number>;
  /** ¿La cuota citada es una simulación con TAE de referencia? */
  esSimulacion: boolean;
  /**
   * REGISTRO DE MUTACIONES — lo que las capas anteriores (grounding, policy,
   * validator, resolveClosing) ya reescribieron en este turno. Permite (a)
   * identificar la capa culpable de una violación y (b) REVERTIR al valor
   * original en vez de adivinar (Mandamiento 8). Opcional: si no se da, los
   * mandamientos que dependen de ella simplemente no tienen nada que revisar.
   */
  mutations?: Mutation[];
}

export type CommandmentId = 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8;
export type CommandmentAction = "corregido" | "logueado";

export interface CommandmentViolation {
  mandamiento: CommandmentId;
  accion: CommandmentAction;
  detalle?: string;
  /** Capa identificada como causante, si el registro de mutaciones la delata. */
  capa?: string;
}

export interface CommandmentReport {
  texto: string;
  violaciones: CommandmentViolation[];
}

function norm(s: string): string {
  return s.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase();
}

// ── Mandamiento 2 — coordinación TAE (cláusula de simulación + cierre) ───────
// QA real (H2): "(simulación con TAE de referencia — tu banco te dará la tasa
// real)" convive con "¿Qué TAE te ofrece TU BANCO?" — no es una pregunta
// duplicada (una sola "?"), pero "tu banco" se menciona DOS veces, sensación de
// guion repetido. Si el cierre YA pide la TAE, la cláusula se recorta a la
// forma corta — una sola mención de "tu banco".
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

// ── Mandamiento 1 — máx. 1 pregunta final ────────────────────────────────────
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

// ── Mandamiento 3 — concepto DERIVADO afirmado sin cálculo ───────────────────
// Defensa en profundidad de FIX A/H1: para cuando llegue hasta aquí.
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

// ── Mandamiento 4 — 0 términos de proveedor ──────────────────────────────────
function stripProviderLeaks(text: string): { texto: string; corregido: boolean } {
  const leaks = PROVIDER_LEAK_REGEXES.some((re) => re.test(text));
  if (!leaks) return { texto: text, corregido: false };

  const kept = segmentSentences(text)
    .filter((seg) => !PROVIDER_LEAK_REGEXES.some((re) => re.test(seg.text)))
    .map((s) => s.text)
    .join("");
  return { texto: cleanup(kept), corregido: true };
}

// ── Mandamiento 6 — VALOR DE EJEMPLO DECLARADO ───────────────────────────────
// Generaliza la tercera vía a CUALQUIER campo vacío (no solo TAE): si el motor
// expone un `ejemplo_<campo>` (orchestrator.ts) y la respuesta cita justo ese
// número para un campo que el usuario todavía no dio, la frase DEBE declarar
// que es un ejemplo ("como ejemplo"/"ilustrativo"/…, ver context.ts). Si no lo
// declara, se inserta la declaración; si el número no es el ejemplo verificado
// tampoco es una cifra grounded por ningún otro camino → no es cosa de este
// mandamiento (lo atrapan los mandamientos 3 o la eliminación de grounding).
function enforceExampleDeclared(
  text: string,
  missing: string[],
  conceptos: Record<string, number>,
  lang: Language,
): { texto: string; corregido: boolean } {
  const campos = [...new Set(missing.map((m) => (m === "meta_monto" ? "meta" : m)))];
  const ejemplos = campos
    .map((campo) => ({ campo, valor: conceptos[`ejemplo_${campo}`] }))
    .filter((e): e is { campo: string; valor: number } => e.valor !== undefined);
  if (ejemplos.length === 0) return { texto: text, corregido: false };

  let corregido = false;
  const rebuilt = segmentSentences(text)
    .map((seg) => {
      const numeros = findNumberMentions(seg.text);
      const cita = numeros.find((m: NumberMention) =>
        ejemplos.some((e) => Math.abs(m.value - e.valor) <= 0.01),
      );
      if (!cita) return seg.text;
      if (hasReferenceMarker(seg.text)) return seg.text; // ya declarado como ejemplo/referencia
      corregido = true;
      const declaracion: Record<Language, string> = {
        es: " (como ejemplo ilustrativo)",
        pt: " (como exemplo ilustrativo)",
        en: " (as an illustrative example)",
      };
      const clause = declaracion[lang] ?? declaracion[DEFAULT_LANGUAGE];
      const trailing = /([.!?]+\s*)$/.exec(seg.text);
      return trailing
        ? seg.text.slice(0, -trailing[0].length) + clause + trailing[0]
        : seg.text + clause;
    })
    .join("");
  return { texto: cleanup(rebuilt), corregido };
}

// ── Mandamiento 7 — IDIOMA DE ENTRADA ────────────────────────────────────────
// Términos técnicos universales exentos: se dejan en inglés aunque el resto de
// la respuesta sea ES/PT.
const EXEMPT_TERMS_RE =
  /\b(apr|tin|tae|taeg|cet|cat|cash ?flow|etf|roi|break-?even|leasing|renting|spread|benchmark)\b/gi;

function enforceInputLanguage(text: string, lang: Language): { texto: string; corregido: boolean } {
  if (lang === "en") return { texto: text, corregido: false }; // nada que exigir sobre EN
  let corregido = false;
  const kept = segmentSentences(text)
    .filter((seg) => {
      const sinExentos = seg.text.replace(EXEMPT_TERMS_RE, " ");
      if (sinExentos.trim() && detectLanguage(sinExentos) === "en") {
        corregido = true;
        return false;
      }
      return true;
    })
    .map((s) => s.text)
    .join("");
  return { texto: cleanup(kept), corregido };
}

// ── Mandamiento 8 — ORDINALES NO SON CIFRAS (defensa en profundidad de FIX A) ─
// Los números de enumeración se excluyen en el origen (validate.ts), pero si
// una mutación reescribió un ordinal pequeño (1-20) a otra cifra y esa cifra
// hoy ocupa una posición de enumerador de lista, se REVIERTE al valor
// original — nunca se adivina una corrección nueva.
const ENUMERATOR_AFTER_RE = /^\s*[.)-]/;

function isAtEnumeratorPosition(text: string, valor: string): boolean {
  const idx = text.indexOf(valor);
  if (idx === -1) return false;
  const lineStart = text.lastIndexOf("\n", idx - 1) + 1;
  const prefix = text.slice(lineStart, idx);
  if (!/^[ \t]*$/.test(prefix)) return false;
  return ENUMERATOR_AFTER_RE.test(text.slice(idx + valor.length, idx + valor.length + 2));
}

function revertOrdinalMutations(
  text: string,
  mutations: Mutation[],
): { texto: string; corregido: boolean; capa?: string } {
  let out = text;
  let corregido = false;
  let capa: string | undefined;
  for (const mut of mutations) {
    if (!/^\d{1,2}$/.test(mut.antes.trim())) continue;
    const n = Number(mut.antes);
    if (n < 1 || n > 20) continue;
    if (mut.antes === mut.despues) continue;
    if (isAtEnumeratorPosition(out, mut.despues)) {
      out = out.replace(mut.despues, mut.antes);
      corregido = true;
      capa = mut.capa;
    }
  }
  return { texto: out, corregido, capa };
}

/**
 * Verifica y corrige los 8 Mandamientos sobre `text`, en orden. Devuelve el
 * texto corregido y el detalle de cada violación. Nunca lanza; si una
 * corrección vacía la respuesta, el texto resultante puede ser "" (el llamante
 * decide el fallback de carril).
 */
export function enforceCommandments(
  text: string,
  ctx: CommandmentContext,
): CommandmentReport {
  const violaciones: CommandmentViolation[] = [];
  if (!text || !text.trim()) return { texto: text, violaciones };

  let out = text;
  const mutations = ctx.mutations ?? [];
  // PIEZA 5 — las mutaciones PREVIAS (las de las capas anteriores) se leen de
  // una copia: a partir de aquí este propio módulo añade las suyas al registro,
  // y M8 no debe razonar sobre sus propias entradas.
  const previas = [...mutations];

  /** Registra una corrección de mandamiento en el registro de mutaciones. */
  const anotar = (mandamiento: CommandmentId, regla: string, antes: string, despues: string) => {
    if (antes === despues) return;
    mutations.push({ capa: `commandment_${mandamiento}`, regla, antes, despues });
  };

  // Mandamiento 8 primero: si alguna capa anterior reescribió un enumerador,
  // se revierte ANTES de que el resto de mandamientos razone sobre el texto ya
  // corrompido.
  const ordinal = revertOrdinalMutations(out, previas);
  if (ordinal.corregido) {
    anotar(8, "enumerador de lista revertido", out, ordinal.texto);
    out = ordinal.texto;
    violaciones.push({ mandamiento: 8, accion: "corregido", detalle: "enumerador de lista reescrito — revertido", capa: ordinal.capa });
  }

  // Mandamientos 4 y 5 aplican SIEMPRE, en todos los carriles (incluido META).
  const leak = stripProviderLeaks(out);
  if (leak.corregido) {
    anotar(4, "fuga de proveedor", out, leak.texto);
    out = leak.texto;
    violaciones.push({ mandamiento: 4, accion: "corregido", detalle: "fuga de identidad de proveedor/modelo" });
  }

  if (isDelegativeClosing(out)) {
    const before = out;
    out = stripDelegativeClosing(out);
    if (out !== before) {
      anotar(5, "cierre delegativo", before, out);
      violaciones.push({ mandamiento: 5, accion: "corregido", detalle: "cierre delegativo eliminado" });
    }
  }

  // Mandamiento 7 (idioma) aplica en todos los carriles: una fuga de inglés es
  // igual de fuera de lugar en META que en un turno financiero.
  const idioma = enforceInputLanguage(out, ctx.lang);
  if (idioma.corregido) {
    anotar(7, "idioma de entrada", out, idioma.texto);
    out = idioma.texto;
    violaciones.push({ mandamiento: 7, accion: "corregido", detalle: "término en inglés fuera de la lista exenta" });
  }

  // Mandamientos 1, 2, 3, 6 solo tienen sentido en carriles con contenido
  // financiero: META no calcula conceptos, no simula crédito ni tiene missing.
  if (ctx.carril !== "META") {
    const concepts = stripUnbackedConcepts(out, ctx.conceptos);
    if (concepts.corregido) {
      anotar(3, "concepto sin cálculo", out, concepts.texto);
      out = concepts.texto;
      violaciones.push({ mandamiento: 3, accion: "corregido", detalle: "concepto afirmado sin cálculo que lo respalde" });
    }

    const sim = enforceSimulationHonesty(out, { esSimulacion: ctx.esSimulacion, lang: ctx.lang });
    if (sim !== out) {
      anotar(2, "contradicción tasa/simulación", out, sim);
      out = sim;
      violaciones.push({ mandamiento: 2, accion: "corregido", detalle: "contradicción tasa/simulación" });
    }
    const coord = coordinateTaeMention(out, ctx.lang);
    if (coord.corregido) {
      anotar(2, "cláusula de simulación recortada", out, coord.texto);
      out = coord.texto;
      violaciones.push({ mandamiento: 2, accion: "corregido", detalle: "cláusula de simulación recortada — TAE ya la pide el cierre" });
    }

    const ejemplo = enforceExampleDeclared(out, ctx.missing, ctx.conceptos, ctx.lang);
    if (ejemplo.corregido) {
      anotar(6, "valor de ejemplo sin declarar", out, ejemplo.texto);
      out = ejemplo.texto;
      violaciones.push({ mandamiento: 6, accion: "corregido", detalle: "valor de ejemplo sin declarar como tal" });
    }

    const closing = maxOneClosingQuestion(out, ctx.missing);
    if (closing.corregido) {
      anotar(1, "más de una pregunta final", out, closing.texto);
      out = closing.texto;
      violaciones.push({ mandamiento: 1, accion: "corregido", detalle: "más de una pregunta final — se conservó la de mayor prioridad" });
    }
  }

  return { texto: out, violaciones };
}
