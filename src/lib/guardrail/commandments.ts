// THE COMMANDMENTS (ex assertOutputInvariants, AUDITORÍA AG01 H2+H5) — la
// garantía de calidad del pipeline vivía repartida en 3-5 capas que
// insertaban/eliminaban texto sin conocerse entre sí (ver
// docs/PIPELINE_CONTRACT.md). `enforceCommandments` es el ÚNICO paso final,
// después de `resolveClosing`, que verifica y corrige el texto que SALE.
// Ninguna capa intermedia vuelve a ser responsable de la garantía global; su
// trabajo es no introducir violaciones, esta es la red de seguridad
// determinista. Los invariantes (a)-(e) de AG01 pasan a ser los Mandamientos
// 1-5; una tanda posterior añadió 6-8, luego el 9 (PLAN FANTASMA); esta añade
// el 10 (CIFRA PEDIDA — QA testdev8).
//
// Contrato: pura, nunca lanza, idempotente (aplicarla dos veces da el mismo
// resultado). Código PURO, edge-safe, SIN llamadas a ningún LLM.

import { segmentSentences, splitSentences, conceptsInSentence, cifraPedidaAusente, hasReferenceMarker, isPercent, isTimeUnit } from "./context";
import {
  cleanup,
  endsWithRequestOrProposal,
  isDelegativeClosing,
  stripDelegativeClosing,
  enforceSimulationHonesty,
  esTextoCanonico,
  renumberLists,
  MISSING_KEYWORDS,
  maxOneClosingQuestion,
  type Mutation,
} from "./policy";
import { DERIVED_CONCEPTS, isListEnumerator } from "./validate";
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
  /**
   * Respuesta CRUDA del modelo, antes de cualquier capa (grounding incluido).
   * Mandamiento 9 (PLAN FANTASMA) la usa para revertir cuando el enforcement
   * vació un plan hasta dejarlo sin cifras ni acción concreta. Mandamiento 10
   * (CIFRA PEDIDA) la usa con el mismo espíritu. Opcional: sin ella, ninguno
   * de los dos tiene nada a lo que revertir y no se activan nunca.
   */
  raw?: string;
  /**
   * Mensaje del usuario que originó este turno. Mandamiento 10 (CIFRA PEDIDA)
   * lo usa para saber qué concepto financiero se preguntó. Opcional: sin él,
   * M10 no tiene qué comprobar y no se activa nunca.
   */
  userMessage?: string;
}

export type CommandmentId = 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9 | 10;
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

// ── Mandamiento 3 — concepto DERIVADO afirmado sin cálculo ───────────────────
// Defensa en profundidad de FIX A/H1: para cuando llegue hasta aquí.
function stripUnbackedConcepts(
  text: string,
  conceptos: Record<string, number>,
): { texto: string; corregido: boolean } {
  let corregido = false;
  const kept = segmentSentences(text)
    .filter((seg) => {
      // FIX 6 (2ª tanda) — textos canónicos propios INMUNES. QA real: "Con ese
      // dato la cuota es exacta al 100%" (MISSING_REQUEST.tae) mencionaba
      // "cuota" sin que `conceptos.cuota` estuviera poblado (missing incluía
      // 'tae') y este Mandamiento lo eliminaba — las capas peleándose entre sí.
      if (esTextoCanonico(seg.text)) return true;
      // QA (4ª tanda, surgido al conectar Commandments al harness de
      // regresión): "¿Quieres que te prepare un recordatorio mensual para la
      // cuota?" mencionaba "cuota" (concepto derivado) SIN que el motor la
      // hubiera calculado este turno — y se eliminaba, aunque la frase no cita
      // NINGÚN valor de "cuota", solo nombra el concepto de pasada. El
      // Mandamiento existe para atrapar una CIFRA afirmada sin respaldo (el
      // déficit fantasma citaba "9500 €"); sin una cifra en la propia frase no
      // hay nada que fundamentar, así que no hay nada que eliminar.
      if (!/\d/.test(seg.text)) return true;
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

// ── Mandamiento 9 — PLAN FANTASMA ────────────────────────────────────────────
//
// QA real: tras eliminar dos ítems de un plan de 4 pasos (montos que el
// guardarraíl juzgó sin respaldo — FIX 1/2 de esta misma tanda corrige la
// causa; esto es la red de seguridad si algo se cuela de todos modos), el
// texto final anunciaba un plan y pedía confirmación ("¿Arrancamos con este
// plan?") sobre un cascarón sin ninguna cifra ni acción concreta. Publicar esa
// pregunta es peor que no responder: el usuario confirma un plan que no
// existe. Si el enforcement vació el plan hasta ese punto, se revierte al
// texto ORIGINAL del modelo — el registro de mutaciones ya demuestra que algo
// cambió; aquí simplemente se usa el propio `raw` en vez de reconstruirlo.
const PLAN_ANNOUNCE_RE = /\b(plan|planos?|propongo|proponho|i propose|pasos|passos|steps|hitos|marcos|milestones)\b/;

/** ¿El texto trae alguna cifra MONETARIA real (no un %, no una duración, no un enumerador de lista)? */
function tieneCifraMonetaria(text: string): boolean {
  return findNumberMentions(text).some((m) => {
    if (isListEnumerator(text, m)) return false;
    if (isPercent(text, m)) return false;
    if (isTimeUnit(text, m)) return false;
    return true;
  });
}

/**
 * Cuenta ítems de lista numerada BIEN FORMADOS ("N.<sep> contenido") por
 * línea. Cuenta sobre el texto YA renumerado (`renumberLists`), así que un
 * enumerador huérfano o pegado ("1.2.3.") no aparece como línea propia y no
 * infla el conteo — cada línea contada es un ítem con contenido real.
 */
function contarItemsDeLista(text: string): number {
  const lineas = renumberLists(text).texto.split("\n");
  return lineas.filter((l) => /^\s*\d+[.):-]\s+\S/.test(l)).length;
}

/**
 * ¿`text` es un PLAN FANTASMA? Solo si:
 *   (a) algo cambió respecto al `raw` original;
 *   (b) `text` NO es un texto canónico nuestro (QA real, 4ª tanda: la
 *       respuesta segura de output-validator.ts cuando una GARANTÍA prohibida
 *       se elimina — "No puedo prometerte resultados de inversión… tu PLAN…
 *       ¿Cuál es tu META?" — menciona "plan", cierra en pregunta y no cita
 *       cifra: calza EXACTO con la forma de un plan fantasma. Revertirla al
 *       raw devolvería la garantía prohibida que la propia capa de seguridad
 *       acababa de bloquear. Una sustitución de seguridad intencional no es
 *       un vaciado);
 *   (c) `text` sigue anunciando un plan y pidiendo confirmación;
 *   (d) el `raw` ERA una lista numerada (`nRaw > 0`) — un "plan fantasma" real
 *       es un PLAN NUMERADO que perdió su sustancia. QA real (4ª tanda): "Tus
 *       ingresos son de 500 € y tus gastos son de 500 €… ¿Confirmamos el
 *       plan?" no es una lista numerada; el grounding elimina correctamente
 *       la hallucinación (ingreso/gastos falsos) y deja solo la pregunta de
 *       cierre — sin este chequeo, M9 confundía esa pregunta corta (sin
 *       cifra, menciona "plan") con un plan vaciado y revertía al raw,
 *       resucitando la mentira que el grounding acababa de bloquear con
 *       razón. Sin lista numerada en el raw no hay "pasos" que mutilar ni
 *       "vaciar": nada de esto es cosa de M9;
 *   (e) Y, dentro de (d), O BIEN no le queda ninguna cifra monetaria real
 *       (cascarón sin sustancia), O BIEN perdió pasos de la lista numerada
 *       del raw (plan MUTILADO, FIX 4 — "no basta con que quede alguna cifra
 *       o algún ítem": QA real, raw 3 pasos → final 1 paso CON cifra propia,
 *       igual mutilado) — cualquiera de las dos basta.
 */
function esPlanFantasma(text: string, raw: string | undefined): boolean {
  if (raw === undefined || raw === text) return false;
  if (esTextoCanonico(text)) return false;
  if (!PLAN_ANNOUNCE_RE.test(norm(text))) return false;
  if (!endsWithRequestOrProposal(text)) return false;

  const nRaw = contarItemsDeLista(raw);
  if (nRaw === 0) return false;

  // Normaliza la numeración SOLO para detectar sustancia: enumeradores
  // huérfanos pegados ("1.2.3.") no cuentan como cifra monetaria, pero
  // `isListEnumerator` solo reconoce un enumerador si abre línea — con la
  // numeración rota, "2" y "3" dejarían de identificarse como tales y el plan
  // fantasma pasaría desapercibido. `renumberLists` corre de nuevo, sin
  // efecto, si el texto que llega aquí ya está limpio (pipeline.ts la aplica
  // antes de Commandments) — idempotente por diseño.
  const sinCifras = !tieneCifraMonetaria(renumberLists(text).texto);
  const mutilado = contarItemsDeLista(text) < nRaw;
  return sinCifras || mutilado;
}

// ── Mandamiento 10 — LA CIFRA PEDIDA NUNCA SE BORRA ──────────────────────────
//
// QA real (testdev8): "¿cuánto me queda al mes?" ×3 produjo, en el tercer
// turno, una respuesta cuyo enforcement había eliminado el sobrante (250 €),
// dejando un demostrativo huérfano ("Esa es tu capacidad real para destinar a
// ahorro...") sin ningún número al que "esa" pudiera referirse.
//
// REDISEÑO (revisión AG01, bloqueante 1) — la primera versión revertía al
// RAW: texto SIN VALIDAR. Si el RAW traía la cifra pedida en la MISMA frase
// que otra cifra inventada ("Te quedan 250 € al mes aunque arrastras un
// déficit de 9500 €"), M10 resucitaba TAMBIÉN la inventada — anulando el
// Mandamiento 3 con G1b (cifras no trazables) vigente y bloqueante de piloto.
// V17 (propuesta por esa revisión): "ninguna capa de reparación puede
// reintroducir una cifra que una capa anterior eliminó por falta de
// respaldo". M10 NUNCA vuelve al RAW: opera exclusivamente sobre el texto YA
// VALIDADO (`out`), frase a frase, y solo puede escribir una cifra que ya
// esté en `conceptos` (verificada por el motor, nunca por el LLM — V5).
//
// Por cada frase con una anáfora sin antecedente numérico:
//   (a) el concepto que pidió el usuario (`conceptosPedidosEnPregunta`, tabla
//       EXCLUSIVA de pregunta — nunca la de grounding de salida, ver M3/M4 de
//       la misma revisión) SÍ está en `conceptos` y aún no aparece en NINGÚN
//       lugar del texto → la anáfora se SUSTITUYE por esa cifra verificada,
//       en sitio.
//   (b) no hay ningún concepto verificado al que la anáfora pueda
//       corresponder → la frase se ELIMINA (mismo criterio que el
//       Mandamiento 3: sin respaldo, no se publica — nunca se revive
//       contenido del RAW).
// Si tras esto la respuesta queda sin sustancia, es tarea de `ensureSubstance`
// / el reintento acotado de route.ts (que comparte `cifraPedidaAusente` con
// este módulo) — nunca de M10 resucitar el RAW.
const ANAFORA_SIN_ANTECEDENTE_RE = /\b(esa|ese|esta|este|esto|eso)\s+(cifra|cantidad|monto|numero|valor)\b|\beso\b/i;

function esNum(n: number): string {
  return String(n).replace(".", ",");
}

/** ¿La frase usa un demostrativo/anáfora sin ningún número en sí misma? */
function fraseConAnaforaSinAntecedente(sentence: string): boolean {
  return ANAFORA_SIN_ANTECEDENTE_RE.test(sentence) && !/\d/.test(sentence);
}

/**
 * Repara las anáforas sin antecedente de `text` frase a frase, SOBRE EL
 * TEXTO YA VALIDADO — nunca sobre el raw. Solo puede insertar una cifra que
 * ya viva en `conceptos`; si no hay ninguna disponible, la frase se elimina.
 */
function repararAnaforasSinAntecedente(
  text: string,
  userMessage: string | undefined,
  conceptos: Record<string, number>,
): { texto: string; corregido: boolean } {
  if (!userMessage) return { texto: text, corregido: false };
  const { ausente, conceptosPedidos } = cifraPedidaAusente(userMessage, text, conceptos);
  // Sin nada pedido y verificado que reinsertar, solo cabe la eliminación (b)
  // — pero si además la cifra pedida YA está en el texto (`!ausente`), el
  // concepto elegible para sustituir la anáfora ya cumplió su papel en otra
  // frase: tampoco hay nada que reinsertar aquí, se elimina si aparece.
  const concepto = ausente ? conceptosPedidos.find((c) => c in conceptos) : undefined;

  let corregido = false;
  const partes: string[] = [];
  for (const seg of segmentSentences(text)) {
    if (!fraseConAnaforaSinAntecedente(seg.text)) {
      partes.push(seg.text);
      continue;
    }
    corregido = true;
    if (concepto !== undefined) {
      // (a) — sustituye la anáfora por la cifra verificada, en sitio.
      partes.push(seg.text.replace(ANAFORA_SIN_ANTECEDENTE_RE, `${esNum(conceptos[concepto])} €`));
    }
    // (b) — sin concepto verificado al que anclarla: la frase se descarta.
  }
  return { texto: cleanup(partes.join("")), corregido };
}

/**
 * Verifica y corrige los 10 Mandamientos sobre `text`, en orden. Devuelve el
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

    // Mandamiento 9 — ÚLTIMO, tras todo lo anterior: solo entonces se sabe si
    // el plan quedó vacío. Revierte al texto ORIGINAL del modelo; M4/M5/M1
    // (universales y baratos) se reaplican sobre el raw, que nunca pasó por
    // ellos — el resto de mandamientos confía en que el raw, con FIX 1/2 de
    // esta misma tanda, ya no debería necesitar reescritura en primer lugar.
    if (esPlanFantasma(out, ctx.raw)) {
      const before = out;
      let revertido = ctx.raw as string;
      const leakRaw = stripProviderLeaks(revertido);
      if (leakRaw.corregido) revertido = leakRaw.texto;
      if (isDelegativeClosing(revertido)) revertido = stripDelegativeClosing(revertido);
      const closingRaw = maxOneClosingQuestion(revertido, ctx.missing);
      if (closingRaw.corregido) revertido = closingRaw.texto;
      out = revertido;
      anotar(9, "plan vacío tras enforcement — revertido al original", before, out);
      violaciones.push({ mandamiento: 9, accion: "corregido", detalle: "plan sin sustancia tras enforcement — revertido al texto original" });
    }

    // Mandamiento 10 — ÚLTIMO de todos: corre incluso después de M9, sobre lo
    // que M9 haya dejado. NUNCA vuelve al raw (V17) — repara la anáfora en
    // sitio con una cifra verificada, o elimina la frase sin respaldo.
    const anafora = repararAnaforasSinAntecedente(out, ctx.userMessage, ctx.conceptos);
    if (anafora.corregido) {
      anotar(10, "anáfora sin antecedente — cifra verificada reinsertada o frase eliminada", out, anafora.texto);
      out = anafora.texto;
      violaciones.push({
        mandamiento: 10,
        accion: "corregido",
        detalle: "anáfora sin antecedente numérico: cifra verificada reinsertada, o frase sin respaldo eliminada",
      });
    }
  }

  return { texto: out, violaciones };
}
