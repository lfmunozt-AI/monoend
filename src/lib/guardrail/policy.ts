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
import {
  segmentSentences,
  splitSentences,
  isPercent,
  isTimeUnit,
  hasReferenceMarker,
  conceptsInSentence,
} from "./context";
import { findNumberMentions } from "./numbers";
import type { Carril } from "./turn-classifier";
import { DEFAULT_ENFORCEMENT_MODE, type EnforcementMode } from "./enforcement";

export type PolicyMode = "mvp" | "passthrough";

/**
 * REGISTRO DE MUTACIONES — cada capa que reescribe texto (grounding, policy,
 * validator, resolveClosing) añade una entrada aquí. Habilita el diagnóstico de
 * capa en `enforceCommandments`: ante una violación puede señalar QUIÉN la
 * causó ("Mandamiento 8 violado — capa: grounding, regla: posicional_monto,
 * antes: '1', después: '7000'") y, cuando la mutación es la causa, REVERTIR al
 * valor original en vez de adivinar una corrección nueva.
 */
export interface Mutation {
  capa: string;
  regla: string;
  antes: string;
  despues: string;
}

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
  /**
   * REGISTRO DE MUTACIONES (PIEZA 5) — toda operación que modifique el texto se
   * anota aquí: correcciones en sitio Y eliminaciones de frase. El punto ciego
   * del Caso A (texto sustituido con `mutations: []`) impedía que The
   * Commandments detectara ni revirtiera nada.
   */
  mutations?: Mutation[];
  /**
   * PIEZA 1 — en `minimal` NUNCA se reescribe una cifra: la frase se ELIMINA
   * (bloquear lo falso sí; sustituirlo por una cifra nuestra, no).
   */
  enforcement?: EnforcementMode;
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

/**
 * Cierre estándar (genérico) del guardarraíl v2, por idioma. AUDITORÍA AG01
 * (H3): ya no la usa `applyPolicy` ni `enforceOutputPolicy` para insertar un
 * cierre (esa autoridad es única de `resolveClosing`) — queda exportada como
 * utilidad de referencia por si algún consumidor externo la necesita.
 */
export function standardClosingRequest(lang: Language = DEFAULT_LANGUAGE): string {
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

/** Última frase no vacía del texto (segmentador canónico, numeric-safe). */
function lastSentence(text: string): string {
  return splitSentences(text).at(-1) ?? "";
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

// ── Cierre delegativo (bug de persona) ───────────────────────────────────────
//
// monoend pide el INSUMO y él analiza. Un cierre que delega el análisis al
// usuario ("¿qué gastos podrías reducir?") viola el ADN. Se detecta de forma
// determinista y se reemplaza por una petición de insumo + promesa de análisis.

// ES/PT/EN, sobre texto normalizado (sin acentos, minúsculas).
const DELEGATIVE_RE = new RegExp(
  "(" +
    // ES
    "podrias\\s+reducir|podrias\\s+recortar|crees\\s+que|te\\s+parece|piensa\\s+en|" +
    "evalua|considera\\s+cuales|que\\s+gastos\\s+(?:podrias|crees)|que\\s+recortarias|" +
    "en\\s+que\\s+(?:crees\\s+que\\s+)?gastas\\s+de\\s+mas|" +
    "como\\s+deseas\\s+proceder|como\\s+quieres\\s+proceder|que\\s+prefieres|como\\s+prefieres|" +
    // PT
    "achas\\s+que|consegues\\s+reduzir|o\\s+que\\s+achas|pensa\\s+em|avalia|" +
    "como\\s+preferes|o\\s+que\\s+preferes|como\\s+desejas\\s+proceder|" +
    // EN
    "could\\s+you\\s+cut|do\\s+you\\s+think|consider\\s+which|what\\s+do\\s+you\\s+think|" +
    "think\\s+about\\s+which|how\\s+do\\s+you\\s+want\\s+to\\s+proceed|what\\s+would\\s+you\\s+prefer" +
  ")",
);

/** Cierre de petición de insumo + promesa de análisis (el patrón correcto). */
const INSUMO_REQUEST: Record<Language, string> = {
  es: "¿Me compartes tus gastos principales con sus montos? Yo identifico cuáles recortar.",
  pt: "Partilhas comigo os teus principais gastos com os valores? Eu identifico quais cortar.",
  en: "Share your main expenses with their amounts — I'll pinpoint which ones to cut.",
};

/** ¿Es la frase una petición de dato/propuesta VÁLIDA (no delegativa)? */
function isValidRequest(sentence: string): boolean {
  const n = norm(sentence);
  if (DELEGATIVE_RE.test(n)) return false;
  return sentence.trim().endsWith("?") || PROPOSAL_RE.test(n);
}

/** ¿La última frase delega el análisis en el usuario en vez de pedir un dato? */
export function isDelegativeClosing(text: string): boolean {
  const last = lastSentence(text);
  return last !== "" && DELEGATIVE_RE.test(norm(last));
}

/**
 * Garantiza un cierre ÚNICO y no delegativo (PIEZA 3 — fix del doble cierre).
 *
 * Pasos, en orden:
 *   1. Si la última frase delega el análisis ("¿qué gastos podrías reducir?"),
 *      se elimina.
 *   2. Se colapsa un cierre duplicado al final (dos frases idénticas seguidas).
 *   3. Solo si tras 1-2 la respuesta NO termina ya en una petición de dato válida
 *      (en sus últimas 2 frases) se añade el cierre estándar de insumo.
 *
 * Antes, el paso 1 añadía SIEMPRE el cierre estándar, aunque la respuesta ya
 * pidiera un dato en una frase anterior → salían dos preguntas. Garantía: como
 * mucho una pregunta final. Determinista y puro; si no hay nada que corregir,
 * devuelve el texto intacto.
 */
export function rewriteDelegativeClosing(
  text: string,
  lang: Language = DEFAULT_LANGUAGE,
): string {
  const segments = segmentSentences(text);
  const nonEmpty = segments
    .map((s, i) => ({ i, t: s.text.trim() }))
    .filter((x) => x.t !== "");
  if (nonEmpty.length === 0) return text;

  let keep = nonEmpty.length; // nº de frases con contenido que conservamos
  let changed = false;

  // 1. Elimina un cierre delegativo final.
  if (DELEGATIVE_RE.test(norm(nonEmpty[keep - 1].t))) {
    keep--;
    changed = true;
  }

  // 2. Colapsa cierres duplicados idénticos al final.
  while (keep >= 2 && norm(nonEmpty[keep - 1].t) === norm(nonEmpty[keep - 2].t)) {
    keep--;
    changed = true;
  }

  // Sin cierre delegativo ni duplicado: no había nada que arreglar. Se devuelve
  // el texto intacto — no es tarea de esta función añadir cierres donde no hay
  // problema (de eso se ocupa el guardarraíl de cifras en applyPolicy).
  if (!changed) return text;

  // Reconstruye conservando el formato original hasta la última frase mantenida.
  const kept = keep > 0
    ? cleanup(segments.slice(0, nonEmpty[keep - 1].i + 1).map((s) => s.text).join(""))
    : "";

  // ¿Lo que queda ya cierra con una petición válida (últimas 2 frases)? Entonces
  // no se añade el cierre de insumo: evita la segunda pregunta seguida.
  const ultimas = nonEmpty.slice(Math.max(0, keep - 2), keep).map((x) => x.t);
  if (ultimas.some(isValidRequest)) return kept;

  const req = INSUMO_REQUEST[lang];
  return kept ? `${kept}\n\n${req}` : req;         // añade UN cierre de insumo
}

/**
 * Elimina un cierre delegativo final (y colapsa duplicados) SIN añadir nada —
 * a diferencia de `rewriteDelegativeClosing`, que sí añade el cierre de insumo
 * cuando hace falta. Es el paso compartido que usa `resolveClosing` (Pieza 3):
 * el carril MIXTO nunca debe añadir un cierre, solo limpiar la delegación; y el
 * carril FINANCIERO con `missing` no vacío necesita el texto YA limpio de
 * delegación antes de decidir el cierre por missing — si se le pasara el
 * cierre de insumo ya inyectado por `rewriteDelegativeClosing`, la frase de
 * seguimiento ("Yo identifico cuáles recortar") no es pregunta ni propuesta y
 * rompía la detección del bloque de cierre de `enforceMissingClosing`, dejando
 * DOS cierres seguidos (el bug real de doble cierre que Pieza 3 corrige).
 */
export function stripDelegativeClosing(text: string): string {
  const segments = segmentSentences(text);
  const nonEmpty = segments
    .map((s, i) => ({ i, t: s.text.trim() }))
    .filter((x) => x.t !== "");
  if (nonEmpty.length === 0) return text;

  let keep = nonEmpty.length;
  let changed = false;

  if (DELEGATIVE_RE.test(norm(nonEmpty[keep - 1].t))) {
    keep--;
    changed = true;
  }
  while (keep >= 2 && norm(nonEmpty[keep - 1].t) === norm(nonEmpty[keep - 2].t)) {
    keep--;
    changed = true;
  }

  if (!changed) return text;

  return keep > 0
    ? cleanup(segments.slice(0, nonEmpty[keep - 1].i + 1).map((s) => s.text).join(""))
    : "";
}

// ── Cierre por missing (bug de prioridad) ────────────────────────────────────
//
// QA real: el motor marcó missing=["tae"] pero el modelo cerró con "¿Te
// gustaría proceder con esta compra?" — una pregunta LÍCITA (no delegativa,
// `rewriteDelegativeClosing` no la caza) pero de prioridad equivocada: el
// código ya sabe que falta la TAE y el cierre debe pedir exactamente eso.
// Filosofía: el código decide QUÉ se pregunta, el modelo lo redacta.

// Keywords por campo (ES/PT/EN), sobre texto normalizado (sin acentos, minúsculas).
// Exportado: `assertOutputInvariants` (invariants.ts) lo reutiliza para decidir
// qué pregunta de cierre conservar cuando sobreviven dos (invariante a).
export const MISSING_KEYWORDS: Record<string, RegExp> = {
  tae: /\b(tae|taeg|tasa|taxa|juros|interes|interest|apr)\b|banco\s+te\s+ofrece/,
  gastos: /\b(gastos?|despesas?|expenses?|spending)\b/,
  ingreso: /\b(ingresos?|salario|rendimento|income|earn)\b/,
  meta: /\b(meta|objetivo|goal)\b/,
  plazo: /\b(plazo|meses|months?|prazo)\b/,
  monto: /\b(monto|precio|importe|preco|amount|price)\b/,
};

/** Petición canónica por campo, en el idioma del usuario. */
const MISSING_REQUEST: Record<string, Record<Language, string>> = {
  tae: {
    es: "¿Qué TAE te ofrece tu banco? Con ese dato la cuota es exacta al 100%.",
    pt: "Qual é a TAEG que o teu banco te oferece? Com esse dado a prestação é exata a 100%.",
    en: "What APR is your bank offering? With that figure the payment is exact.",
  },
  gastos: {
    es: "¿Me compartes tus gastos principales con sus montos? Yo identifico cuáles recortar.",
    pt: "Partilhas os teus principais gastos com os valores? Eu identifico quais cortar.",
    en: "Share your main expenses with their amounts — I'll pinpoint which ones to cut.",
  },
  ingreso: {
    es: "¿Cuál es tu ingreso neto mensual? Con ese dato calculo tu capacidad real.",
    pt: "Qual é o teu rendimento líquido mensal? Com esse dado calculo a tua capacidade real.",
    en: "What's your monthly net income? With that I calculate your real capacity.",
  },
  meta: {
    es: "¿Cuál es la meta que quieres conquistar y en qué plazo? Con eso te armo el plan.",
    pt: "Qual é a meta que queres conquistar e em que prazo? Com isso monto-te o plano.",
    en: "What's the goal you want to conquer and by when? I'll build the plan.",
  },
  plazo: {
    es: "¿A cuántos meses lo quieres financiar? Con ese dato calculo la cuota.",
    pt: "A quantos meses queres financiar? Com esse dado calculo a prestação.",
    en: "Over how many months do you want to finance it? Then I'll calculate the payment.",
  },
  monto: {
    es: "¿Cuál es el precio exacto? Con ese dato calculo la cuota.",
    pt: "Qual é o preço exato? Com esse dado calculo a prestação.",
    en: "What's the exact price? Then I'll calculate the payment.",
  },
};

/**
 * ¿Es una frase de CIERRE (pregunta o propuesta), no una frase de análisis?
 * Reutiliza `PROPOSAL_RE`, ya definida arriba para el mismo propósito en
 * `endsWithRequestOrProposal` — no se duplica el criterio.
 */
function isClosingCandidate(sentence: string): boolean {
  return sentence.trim().endsWith("?") || PROPOSAL_RE.test(norm(sentence));
}

/**
 * Garantiza que el cierre pida EXACTAMENTE `missing[0]` (el dato que el motor
 * marcó como faltante), no lo que al modelo le pareció natural preguntar.
 *
 * - `missing` vacío → texto intacto (nada que enforzar).
 * - Se identifica el BLOQUE DE CIERRE: las frases finales que son pregunta o
 *   propuesta, recolectadas desde el final mientras lo sean (0, 1 o 2 frases).
 *   Una frase de ANÁLISIS que solo MENCIONA el campo (p. ej. "calculando con
 *   la TAE de referencia…", parte de la regla de simulación B2) no cuenta como
 *   cierre y no debe confundirse con una petición real de ese dato — por eso
 *   NO se mira "las últimas N frases" a ciegas, solo el bloque de cierre.
 * - Si el bloque de cierre YA menciona el campo → texto intacto.
 * - Si no lo menciona: se sustituye el bloque de cierre (si existe) por la
 *   petición canónica; si no hay bloque de cierre (solo texto declarativo, sin
 *   pregunta ni propuesta), se conserva todo y la petición se añade. En ambos
 *   casos, UNA sola petición final. Reutiliza `segmentSentences` (context.ts)
 *   y `cleanup`; no duplica splitter ni la lógica de cierre único.
 */
export function enforceMissingClosing(
  text: string,
  missing: string[],
  lang: Language = DEFAULT_LANGUAGE,
): string {
  if (!missing || missing.length === 0) return text;

  const field = missing[0] === "meta_monto" ? "meta" : missing[0];
  const keywordsRe = MISSING_KEYWORDS[field];
  const request = MISSING_REQUEST[field]?.[lang];
  if (!keywordsRe || !request) return text; // campo desconocido: no tocar

  const segments = segmentSentences(text);
  const nonEmpty = segments
    .map((s, i) => ({ i, t: s.text.trim() }))
    .filter((x) => x.t !== "");
  if (nonEmpty.length === 0) return request;

  // Bloque de cierre: frases finales que son pregunta/propuesta, recolectadas
  // desde el final mientras lo sean (se detiene en la primera de análisis).
  const closing: typeof nonEmpty = [];
  for (let k = nonEmpty.length - 1; k >= 0; k--) {
    if (!isClosingCandidate(nonEmpty[k].t)) break;
    closing.unshift(nonEmpty[k]);
  }

  if (closing.length > 0 && closing.some((x) => keywordsRe.test(norm(x.t)))) {
    return text; // el cierre ya apunta al campo correcto
  }

  const kept = closing.length > 0
    ? cleanup(segments.slice(0, closing[0].i).map((s) => s.text).join(""))
    : cleanup(text);

  return kept ? `${kept}\n\n${request}` : request;
}

// ── PIEZA 3 (carriles) — resolutor ÚNICO de cierre ───────────────────────────
//
// QA real: DOS cierres canónicos propios seguidos ("¿Me compartes tus gastos
// principales…?" de rewriteDelegativeClosing + "¿Qué TAE te ofrece tu banco?"
// de enforceMissingClosing). Cada función garantiza UNA pregunta puertas
// adentro, pero nada coordinaba entre las dos: `rewriteDelegativeClosing`
// corría primero y podía inyectar su propio cierre de insumo; `enforceMissingClosing`
// corría después sin saber que ese cierre ya existía, y su frase de
// seguimiento ("Yo identifico cuáles recortar") rompía la detección de bloque
// de cierre, así que el segundo cierre se AÑADÍA en vez de sustituir.
//
// `resolveClosing` es la ÚNICA función que el route llama para decidir el
// cierre: una sola decisión, por carril, con el missing como máxima prioridad.

// FIX 5 (2ª tanda) — "YA PIDE CUALQUIER DATO CONCRETO". QA real: el modelo
// cerró con "Dime el precio del carro y en cuántos meses planeas comprarlo" —
// una petición legítima de OTRO dato, no de missing[0] — y se sustituyó por el
// cierre canónico. `endsWithRequestOrProposal` ya cubre "?" y los verbos de
// PROPOSAL_RE; esto añade el caso de una petición interrogativa que NOMBRA un
// campo concreto sin encajar exactamente en esos patrones. Acotado a propósito:
// exige AMBAS señales (un marcador interrogativo Y el nombre de un campo) para
// no confundir una frase puramente declarativa ("tu meta es un carro de 30000
// en 36 meses", que no pide nada) con una petición real.
const INTERROGATIVE_RE = new RegExp(
  "\\b(" +
    "que|qual|cual|cuanto|cuantos|cuanta|cuantas|como|cuando|donde|" + // ES
    "quanto|quantos|quanta|quantas|quando|onde|" + // PT extra
    "what|which|how|when|where" + // EN
  ")\\b",
);

/** ¿La última frase ya pide CUALQUIER dato concreto (no necesariamente missing[0])? */
function pideDatoConcreto(text: string): boolean {
  if (endsWithRequestOrProposal(text)) return true;
  const last = lastSentence(text);
  if (!last) return false;
  const n = norm(last);
  if (!INTERROGATIVE_RE.test(n)) return false;
  return Object.values(MISSING_KEYWORDS).some((re) => re.test(n));
}

export interface ResolveClosingOptions {
  carril: Carril;
  missing: string[];
  lang?: Language;
  /** PIEZA 1 — en `minimal` el cierre NUNCA se añade ni se sustituye. */
  enforcement?: EnforcementMode;
}

/**
 * Decide el cierre de la respuesta según el carril del turno (Pieza 1).
 *
 * PIEZA 4 (esta tanda) — EL CIERRE SOLO AÑADE, NUNCA PISA. Antes, con `missing`
 * no vacío, `enforceMissingClosing` SUSTITUÍA el cierre del modelo aunque fuera
 * una pregunta legítima ("¿Quieres que te prepare un recordatorio mensual para
 * la cuota?" → "¿Qué TAE te ofrece tu banco?"). Eso es reemplazar prosa buena
 * por plantilla: prohibido. La prioridad del `missing` sigue viva donde no hace
 * daño — cuando el modelo NO cerró con nada, ahí sí se añade la petición.
 *
 * 1. META → texto intacto: no hay grounding de cifras ni cierre forzado en
 *    charla trivial, identidad o agradecimientos.
 * 2. MIXTO → solo elimina un cierre delegativo (o colapsa un duplicado);
 *    NUNCA añade nada — el turno mezcla charla y datos, no se le impone guion.
 * 3. FINANCIERO:
 *    a) cierre DELEGATIVO (pide análisis al usuario, viola el ADN) → se elimina
 *       y se sustituye por la petición canónica. Es la ÚNICA sustitución que
 *       sobrevive a esta tanda: lo delegativo no es "prosa buena".
 *    b) la respuesta YA pide CUALQUIER dato concreto (no necesariamente
 *       missing[0]) → INTACTA.
 *    c) sin ningún cierre y con `missing` → se AÑADE la petición canónica.
 *    d) sin cierre y sin `missing` → intacta (no hay nada que pedir).
 *
 * GARANTÍA: como mucho UNA pregunta añadida por esta capa; The Commandments
 * (M1) sigue siendo la red de seguridad si el propio modelo escribió dos.
 */
export function resolveClosing(text: string, opts: ResolveClosingOptions): string {
  const { carril, missing } = opts;
  const lang = opts.lang ?? detectLanguage(text) ?? DEFAULT_LANGUAGE;
  const enforcement = opts.enforcement ?? DEFAULT_ENFORCEMENT_MODE;

  if (carril === "META") return text;

  if (carril === "MIXTO") return stripDelegativeClosing(text);

  // FINANCIERO
  const eraDelegativo = isDelegativeClosing(text);
  const limpio = eraDelegativo ? stripDelegativeClosing(text) : text;

  // MINIMAL: eliminar la delegación es BLOQUEO (legítimo); añadir o sustituir
  // un cierre es reescritura (desactivada).
  if (enforcement === "minimal") return limpio;

  // FIX 5 (7ª tanda, testdev6) — GARANTÍA INCONDICIONAL DE UN SOLO CIERRE. Sea
  // cual sea el camino que tome esta función (delegativo sustituido, cierre
  // añadido, o el texto del modelo dejado intacto), el resultado NUNCA puede
  // llevar más de una pregunta final — "Si la respuesta YA termina en
  // pregunta, no se añade nada. Sin excepciones." Antes esta garantía solo
  // vivía en Commandments (Mandamiento 1, más adelante en la cadena); ahora
  // `resolveClosing` la aplica a SU PROPIA salida en cada retorno, así que un
  // segundo cierre nunca sale de esta función, ni siquiera transitoriamente.
  const unaSolaPregunta = (t: string): string => maxOneClosingQuestion(t, missing ?? []).texto;

  // (a) el cierre delegativo se sustituye por la petición canónica.
  if (eraDelegativo) {
    return unaSolaPregunta(
      missing && missing.length > 0
        ? enforceMissingClosing(limpio, missing, lang)
        : rewriteDelegativeClosing(text, lang),
    );
  }

  // (b) el modelo YA pide cualquier dato concreto → intacto (salvo colapsar un
  // posible segundo cierre que el propio modelo hubiera escrito).
  if (pideDatoConcreto(limpio)) return unaSolaPregunta(limpio);

  // (c) no hay cierre: se AÑADE el canónico del dato que falta.
  if (missing && missing.length > 0) return unaSolaPregunta(enforceMissingClosing(limpio, missing, lang));

  // (d) nada que pedir y nada que arreglar.
  return unaSolaPregunta(limpio);
}

// ── Mandamiento 1 — máx. 1 pregunta final ────────────────────────────────────
// Bloque de cierre: frases finales que son pregunta/propuesta, recolectadas
// desde el final mientras lo sean (mismo criterio que `enforceMissingClosing`).
//
// FIX 5 (7ª tanda) — vivía solo en commandments.ts (Mandamiento 1), corriendo
// DESPUÉS de `resolveClosing` en la cadena. Se mueve aquí (policy.ts) y se
// exporta para que `resolveClosing` la aplique a SU PROPIA salida — Commandments
// sigue siendo la red de seguridad final (por si otra capa aguas abajo
// reintroduce un segundo cierre), pero ya no es la ÚNICA barrera.
export function maxOneClosingQuestion(
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

// ── PIEZA 4 — simulación: prohibir la afirmación falsa ───────────────────────
//
// QA real: "la cuota sería de 718,39 € (sin incluir intereses)" — FALSO: 718,39
// ya incluye el 7% de TAE de referencia (sin intereses serían 625 €). Cuando la
// cuota es una simulación (es_simulacion=true), dos garantías:
//   a) nunca puede afirmar que NO incluye intereses — se elimina esa cláusula.
//   b) siempre debe quedar claro que es una simulación — si su propia frase no
//      trae un marcador de referencia, se inserta la cláusula canónica.

// Afirmación falsa: la cuota simulada SÍ incluye la TAE de referencia.
// AUDITORÍA AG01 (H4): amplía a los negadores de TAE/tasa, no solo de
// "intereses" — QA real: "(sin considerar la TAE)" sobrevivía junto a la
// cláusula canónica "(simulación con TAE de referencia…)" porque este regex
// solo cazaba variantes de *intereses*, nunca de *TAE/tasa* directamente.
const FALSE_NO_INTEREST_RE =
  /,?\s*\(?\s*(sin incluir intereses|sin intereses|no incluye intereses|sem juros|sem incluir juros|without interest|excluding interest|sin considerar (?:la )?(?:tae|taeg|tasa)|sin tener en cuenta (?:la )?(?:tae|taeg|tasa)|sin (?:la )?(?:tae|taeg|tasa)|excluyendo (?:la )?(?:tae|taeg|tasa)|sem considerar a (?:taeg|taxa)|sem ter em conta a (?:taeg|taxa)|sem a (?:taeg|taxa)|excluindo a (?:taeg|taxa)|without considering (?:the )?(?:apr|interest rate)|without the (?:apr|interest rate)|excluding (?:the )?(?:apr|interest rate))\s*\)?/gi;

// Marcador de que la cuota es una simulación, no la cifra real del banco.
const SIMULATION_MARKER_RE = /(simulac|de referencia|tae del 7|orientativo)/;

// Cifra de cuota mencionada en la frase (para saber dónde adjuntar la cláusula).
const CUOTA_MENTION_RE = /\b(cuota|cuotas|mensualidad|mensualidade|prestacao|prestacoes|payment|installment)\b/;

const SIMULATION_CLAUSE: Record<Language, string> = {
  es: " (simulación con TAE de referencia — tu banco te dará la tasa real)",
  pt: " (simulação com TAEG de referência — o teu banco vai dar-te a taxa real)",
  en: " (a simulation with a reference APR — your bank will give you the real rate)",
};

/**
 * Aplica la honestidad de simulación (Pieza 4). Función PURA.
 *
 * - `esSimulacion` false → texto intacto: nada que corregir, la cuota es real.
 * - `esSimulacion` true:
 *   a) elimina cualquier cláusula que niegue que incluye intereses.
 *   b) si la frase que menciona la cuota no trae YA un marcador de referencia,
 *      le adjunta la cláusula canónica de simulación.
 */
export function enforceSimulationHonesty(
  text: string,
  opts: { esSimulacion: boolean; lang?: Language },
): string {
  if (!opts.esSimulacion || !text) return text;
  const lang = opts.lang ?? detectLanguage(text) ?? DEFAULT_LANGUAGE;

  // a) elimina la afirmación falsa.
  const out = cleanup(text.replace(FALSE_NO_INTEREST_RE, ""));

  // b) inserta el marcador de simulación en la frase de la cuota, si falta.
  // AUDITORÍA AG01 (H2, bug descubierto al validar la coordinación de cierre):
  //   1. El marcador se comprueba en TODO el texto, no frase a frase — si una
  //      frase anterior ya lo trae, ninguna otra necesita uno propio. Antes,
  //      una frase de cierre como "Con ese dato la cuota es exacta al 100%"
  //      (literal de MISSING_REQUEST.tae) volvía a calificar como "mención de
  //      cuota sin marcador" y se llevaba una SEGUNDA cláusula.
  //   2. La cifra candidata debe ser un MONTO real, no un porcentaje: "100%" en
  //      esa misma frase de cierre pasaba el chequeo de `/\d/` sin más.
  if (SIMULATION_MARKER_RE.test(norm(out))) return out;

  let inserted = false;
  const rebuilt = segmentSentences(out)
    .map((seg) => {
      if (inserted) return seg.text;
      const n = norm(seg.text);
      const tieneMontoReal = findNumberMentions(seg.text).some((m) => !isPercent(seg.text, m));
      if (!CUOTA_MENTION_RE.test(n) || !tieneMontoReal) {
        return seg.text;
      }
      inserted = true;
      const trailing = /([.!?]+\s*)$/.exec(seg.text);
      const clause = SIMULATION_CLAUSE[lang];
      return trailing
        ? seg.text.slice(0, -trailing[0].length) + clause + trailing[0]
        : seg.text + clause;
    })
    .join("");

  return cleanup(rebuilt);
}

// ── PIEZA 3 — fallback de sustancia ──────────────────────────────────────────
//
// Cuando el guardarraíl vacía una respuesta (todas sus cifras eran inventadas),
// lo que queda es un esqueleto: frases genéricas + un cierre, sin ningún número.
// En vez de entregar eso, se sustituye por una respuesta segura que pide EL dato
// que falta (scenario.missing[0]) con promesa de cálculo.

/** ¿El texto contiene alguna cifra monetaria real (no un %, no una duración)? */
function hasRealFigure(text: string): boolean {
  return findNumberMentions(text).some(
    (m) => !isPercent(text, m) && !isTimeUnit(text, m),
  );
}

/**
 * ¿El texto tiene SUSTANCIA VÁLIDA? (defecto D)
 *   (a) un porcentaje acompañado de marcador de referencia en la MISMA frase
 *       (respuesta normativa PB2: "Como referencia… el 20%…"),
 *   (b) una cifra monetaria real (cuota, sobrante, propuesta con importe).
 * Sin esto, una respuesta normativa válida (solo % + marcador, <220 chars) se
 * destruía porque `hasRealFigure` ignora los porcentajes.
 */
function hasValidSubstance(text: string): boolean {
  if (hasRealFigure(text)) return true; // (b)
  // (a) porcentaje etiquetado como referencia en su propia frase.
  for (const sentence of splitSentences(text)) {
    if (hasReferenceMarker(sentence) && /\d[\d.,]*\s*%/.test(sentence)) return true;
  }
  return false;
}

// Aperturas de relleno típicas de un esqueleto sin datos.
const GENERIC_SKELETON =
  /\b(necesito m[aá]s (?:informaci[oó]n|datos)|para ayudarte mejor|cu[eé]ntame m[aá]s|no tengo (?:suficientes )?datos|preciso de mais|i need more (?:info|information|details))\b/i;

/** Petición segura por dato faltante, con promesa de cálculo (ES/PT/EN). */
const SAFE_ASK: Record<string, Record<Language, string>> = {
  tae: {
    es: "Con la TAE real de tu banco te doy la cuota exacta — ¿me la confirmas?",
    pt: "Com a TAE real do teu banco dou-te a prestação exata — confirmas?",
    en: "With your bank's real APR I'll give you the exact payment — can you confirm it?",
  },
  gastos: {
    es: "Con tus gastos mensuales te calculo la capacidad exacta — ¿me los compartes?",
    pt: "Com as tuas despesas mensais calculo a capacidade exata — partilhas?",
    en: "With your monthly expenses I'll compute the exact capacity — can you share them?",
  },
  ingreso: {
    es: "Con tu ingreso neto mensual te doy la cifra exacta — ¿cuál es?",
    pt: "Com o teu rendimento líquido mensal dou-te o número exato — qual é?",
    en: "With your net monthly income I'll give you the exact figure — what is it?",
  },
  monto: {
    es: "Con el monto del crédito te calculo la cuota — ¿cuánto es?",
    pt: "Com o valor do crédito calculo a prestação — quanto é?",
    en: "With the loan amount I'll compute the payment — how much is it?",
  },
  plazo: {
    es: "Con el plazo te calculo el ritmo exacto — ¿en cuántos meses lo quieres?",
    pt: "Com o prazo calculo o ritmo exato — em quantos meses o queres?",
    en: "With the term I'll compute the exact pace — over how many months?",
  },
  meta: {
    es: "Con el monto de tu meta te armo el plan — ¿cuánto necesitas juntar?",
    pt: "Com o valor da tua meta monto o plano — quanto precisas de juntar?",
    en: "With your goal amount I'll build the plan — how much do you need to save?",
  },
};

const SAFE_GENERIC: Record<Language, string> = {
  es: "Para darte una cifra exacta necesito un dato concreto — ¿me compartes tus ingresos y gastos mensuales?",
  pt: "Para te dar um número exato preciso de um dado concreto — partilhas os teus rendimentos e despesas mensais?",
  en: "To give you an exact figure I need one concrete data point — can you share your monthly income and expenses?",
};

/**
 * Última red cuando la respuesta llega LITERALMENTE vacía y el motor no tiene
 * nada que pedir (`missing` vacío). No cita cifras, no pide datos y no
 * contradice el estado: es lo mínimo entregable, no una plantilla de guion.
 */
const SAFE_EMPTY: Record<Language, string> = {
  es: "Tomo nota. Seguimos con tu plan.",
  pt: "Tomo nota. Seguimos com o teu plano.",
  en: "Noted. We continue with your plan.",
};

function safeAsk(missing: string | undefined, lang: Language): string {
  const key = missing === "meta_monto" ? "meta" : missing;
  const table = key ? SAFE_ASK[key] : undefined;
  return (table ?? SAFE_GENERIC)[lang];
}

// ── FIX 6 (2ª tanda) — TEXTOS CANÓNICOS PROPIOS INMUNES ──────────────────────
//
// QA real: "Con ese dato la cuota es exacta al 100%" (MISSING_REQUEST.tae,
// nuestro propio cierre canónico, inyectado por `resolveClosing`) fue
// eliminado por el Mandamiento 3 (`stripUnbackedConcepts`, commandments.ts) al
// mencionar "cuota" sin que `conceptos.cuota` estuviera poblado todavía (missing
// aún incluía 'tae'). Las capas posteriores NO pueden volver a juzgar lo que
// NOSOTROS inyectamos: por construcción no citamos cifras sin respaldo. "Las
// capas no pueden pelearse entre sí" — se marca cada texto canónico propio
// como inmune a la reescritura de capas posteriores.
function flattenStrings(x: unknown): string[] {
  if (typeof x === "string") return [x];
  if (x && typeof x === "object") return Object.values(x as Record<string, unknown>).flatMap(flattenStrings);
  return [];
}

// FIX (4ª tanda) — QA real al conectar The Commandments al harness: la
// respuesta segura de `output-validator.ts` cuando una garantía de
// rentabilidad se elimina y no queda sustancia ("No puedo prometerte
// resultados de inversión… Lo que sí puedo es calcular tu PLAN… ¿Cuál es la
// META que quieres conquistar?") menciona "plan", termina en pregunta y no
// cita ninguna cifra — coincide EXACTO con la forma de un "plan fantasma"
// (Mandamiento 9). Sin registrarla aquí, M9 la confundía con un plan vaciado
// y la REVERTÍA al raw original — es decir, devolvía la garantía prohibida
// que la propia capa de seguridad acababa de eliminar. Duplicada literal (no
// importada) para evitar un ciclo: `output-validator.ts` YA importa de
// `policy.ts` (`cleanup`), así que `policy.ts` no puede importar de vuelta.
// Si el texto de SAFE_RESPONSE cambia allí, debe actualizarse aquí también.
const SAFE_RESPONSE_OUTPUT_VALIDATOR: Record<Language, string> = {
  es:
    "No puedo prometerte resultados de inversión — nadie puede con honestidad. " +
    "Lo que sí puedo es calcular tu plan con tus datos reales. " +
    "¿Cuál es la meta que quieres conquistar?",
  pt:
    "Não posso prometer-te resultados de investimento — ninguém pode com honestidade. " +
    "O que posso é calcular o teu plano com os teus dados reais. " +
    "Qual é a meta que queres conquistar?",
  en:
    "I can't promise you investment returns — nobody honestly can. " +
    "What I can do is build your plan from your real numbers. " +
    "What's the goal you want to conquer?",
};

// Se registra tanto el texto COMPLETO de cada plantilla como cada una de sus
// oraciones por separado (`splitSentences`): varias plantillas (MISSING_REQUEST)
// son DOS oraciones ("¿Qué TAE…? Con ese dato…") y las capas posteriores
// (Mandamiento 3) filtran frase a frase — sin esto, ninguna mitad calzaría
// exacta contra el texto completo.
const TEXTOS_CANONICOS = new Set(
  [SAFE_ASK, SAFE_GENERIC, SAFE_EMPTY, MISSING_REQUEST, INSUMO_REQUEST, GENERIC_REQUEST, SAFE_RESPONSE_OUTPUT_VALIDATOR]
    .flatMap(flattenStrings)
    .flatMap((s) => [s, ...splitSentences(s)])
    .map((s) => s.trim().toLowerCase()),
);

/** ¿`sentence` ES (exactamente, tras normalizar) uno de nuestros textos canónicos (o una de sus oraciones)? */
export function esTextoCanonico(sentence: string): boolean {
  return TEXTOS_CANONICOS.has(sentence.trim().toLowerCase());
}

// ── PIEZA 2 — ¿la respuesta está REALMENTE vacía? ────────────────────────────
//
// CAUSA RAÍZ del Caso B del diagnóstico: `ensureSubstance` juzgaba "esqueleto"
// TODA respuesta sin cifras y <220 caracteres. Un turno conversacional natural
// (confirmar un registro, proponer el siguiente paso, redirigir una digresión)
// no lleva cifras y es corto → se destruía SIEMPRE. Ahora solo actúa cuando no
// queda nada que entregar.

// Formas verbales frecuentes (ES/PT/EN), sobre texto normalizado sin acentos.
const VERB_FORMS_RE = new RegExp(
  "\\b(" +
    // ES — copulativos, auxiliares y modales
    "soy|eres|es|somos|sois|son|era|eran|fue|fui|sera|seran|sere|seria|" +
    "estoy|estas|esta|estamos|estan|estaba|estuve|" +
    "hay|he|has|ha|hemos|han|habia|hubo|" +
    "tengo|tienes|tiene|tenemos|tienen|tenia|" +
    "voy|vas|va|vamos|van|" +
    "puedo|puedes|puede|podemos|pueden|" +
    "quiero|quieres|quiere|debo|debes|debe|" +
    "hago|haces|hace|hare|" +
    // ES — imperativos cortos frecuentes en respuestas del Consigliere
    "di|dime|dame|mira|revisa|manda|envia|pasa|sigue|ve|" +
    // PT
    "sou|somos|sao|estou|estao|tem|temos|tenho|vou|vais|pode|podes|quero|queres|faco|faz|" +
    // EN
    "is|are|am|was|were|be|been|being|have|has|had|do|does|did|" +
    "can|could|will|would|should|need|needs|let|share|tell|send" +
    ")\\b",
);

// Morfología verbal productiva: infinitivos, gerundios, participios y las
// terminaciones conjugadas más comunes. DELIBERADAMENTE AMPLIO: un falso
// positivo significa NO tocar el texto (dirección segura); un falso negativo
// significaría destruir prosa buena (dirección prohibida).
const VERB_SUFFIX_RE =
  /\b[a-zñç]{3,}(?:ar|er|ir|amos|emos|imos|aste|aron|ando|endo|indo|ados?|adas?|idos?|idas?|aba|aban|ia|ian|aria|eria|iria|are|eras|aremos)\b/i;

/** ¿Hay al menos una frase con verbo? (heurística amplia por diseño) */
export function tieneVerbo(text: string): boolean {
  const n = norm(text);
  return VERB_FORMS_RE.test(n) || VERB_SUFFIX_RE.test(n);
}

// Confirmación de registro / acuse de recibo: sustancia conversacional válida.
const CONFIRMACION_RE = new RegExp(
  "\\b(" +
    "registrado|registrada|anotado|anotada|apuntado|guardado|actualizado|fijado|" +
    "hecho|listo|perfecto|entendido|confirmado|de acuerdo|tomo nota|queda claro|" +
    "registado|feito|pronto|anotei|combinado|" +
    "noted|logged|recorded|done|got it|understood|all set" +
    ")\\b",
);

/**
 * ¿El texto tiene SUSTANCIA CONVERSACIONAL? Cuenta como sustancia válida —y por
 * tanto NO se toca— cualquiera de estas: confirmación, propuesta de siguiente
 * paso, pregunta del propio modelo, mención a un concepto del estado, o una
 * explicación con verbo de longitud normal (incluida la redirección de una
 * digresión, que es exactamente eso).
 */
export function tieneSustanciaConversacional(text: string): boolean {
  const t = text.trim();
  if (!t) return false;
  const n = norm(t);
  if (CONFIRMACION_RE.test(n)) return true;              // confirmación
  if (PROPOSAL_RE.test(n)) return true;                  // propuesta / siguiente paso
  if (t.includes("?")) return true;                      // pregunta del propio modelo
  if (conceptsInSentence(t).length > 0) return true;     // menciona un concepto del estado
  return t.length >= 30 && tieneVerbo(t);                // explicación normal
}

/**
 * ¿Es puro relleno genérico ("necesito más información para ayudarte mejor")?
 * No es prosa buena que proteger: no confirma, no propone y no explica nada.
 * Solo cuenta como relleno si NO trae ninguna otra sustancia.
 */
function esRellenoGenerico(text: string): boolean {
  if (!GENERIC_SKELETON.test(text)) return false;
  if (hasValidSubstance(text)) return false;
  if (conceptsInSentence(text).length > 0) return false;
  return text.trim().length < 220;
}

/**
 * ÚLTIMO RECURSO (PIEZA 2). Actúa SOLO si la respuesta está realmente vacía:
 * menos de 30 caracteres, o sin ninguna frase con verbo, o puro relleno
 * genérico. Cualquier otra cosa —confirmación, propuesta, redirección de
 * digresión, explicación sin cifras, pregunta del modelo, mención a un concepto
 * del estado— se entrega INTACTA.
 *
 * REGLA DEL CASO A: si `missing` está vacío, está PROHIBIDO pedir datos. El
 * motor ya los tiene; una plantilla pidiéndolos es una contradicción del propio
 * sistema ("Para darte una cifra exacta necesito tus ingresos y gastos" con
 * ingreso 2300, gastos 1750 y cuota ya calculada). Mejor un hueco que una
 * mentira.
 *
 * En modo `minimal` no actúa nunca. Puro.
 */
export function ensureSubstance(
  text: string,
  opts: { lang?: Language; missing?: string[]; enforcement?: EnforcementMode } = {},
): string {
  if ((opts.enforcement ?? DEFAULT_ENFORCEMENT_MODE) === "minimal") return text;

  const lang = opts.lang ?? detectLanguage(text);
  const missing0 = opts.missing?.[0];

  const vacia = !hasValidSubstance(text) && !tieneSustanciaConversacional(text);
  if (!vacia && !esRellenoGenerico(text)) return text;

  // Caso A — prohibido pedir lo que el motor ya tiene.
  if (!missing0) return text.trim() ? text : SAFE_EMPTY[lang];

  return safeAsk(missing0, lang);
}

// ── Limpieza ───────────────────────────────────────────────────────────────

/**
 * Tras eliminar frases quedan espacios dobles y líneas huérfanas. Se colapsan
 * los espacios internos, se recortan las líneas y se reducen los saltos
 * múltiples a un máximo de párrafo.
 *
 * FIX 5 (4ª tanda) — GARANTÍA DE ESPACIO ENTRE FRASES. QA real: al eliminar la
 * frase de en medio, las dos que sobrevivían quedaban pegadas sin espacio
 * ("Tu observación es justa.Confirma si quieres..."). Se inserta un espacio
 * entre un cierre de frase (.!?) y la mayúscula/¿/¡ que la sigue SIN espacio —
 * cosmético y seguro: nunca toca separadores de miles ("1.234", dígito tras el
 * punto) ni pasa dentro de una misma frase bien formada (que ya trae su espacio).
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
    .replace(/([.!?])(?=[\p{Lu}¿¡])/gu, "$1 ")
    .trim();
}

// ── PIEZA 3 (2ª tanda) — RENUMERAR LISTAS TRAS ELIMINACIÓN ───────────────────
//
// QA real: "1. Identificar…\n2. Buscar…\n3. Mantener…\n4. Revisar…" con los
// ítems 1 y 2 eliminados por el guardarraíl publicó "1.2.3. Mantener…\n4.
// Revisar…". CAUSA: el segmentador de frases (`segmentSentences`, único en el
// sistema) trata "1." como su PROPIA oración — el punto va seguido de espacio
// + mayúscula, cumple la regla de límite de frase — separada de "Identificar…"
// El ENUMERADOR nunca contiene una cifra financiera (`isListEnumerator` lo
// excluye en origen), así que NUNCA aparece en `blocked`: sobrevive siempre,
// aunque su CONTENIDO se elimine entero. Al eliminar los contenidos de los
// ítems 1 y 2, sus enumeradores huérfanos ("1." "2.") quedan pegados entre sí
// justo delante del primer ítem que sí sobrevivió ("3."). Nunca debe
// publicarse un salto de numeración ni un enumerador pegado — se repara en dos
// pasos, ambos por línea (cada ítem numerado vive en su propia línea):
//   a) colapsar runs de 2+ enumeradores huérfanos pegados al principio de
//      línea ("1.2.3. ") a solo el ÚLTIMO (el que de verdad precede contenido);
//   b) renumerar 1..N cada racha CONTIGUA de líneas "N.<sep> contenido".

/** Runs de 2+ enumeradores huérfanos pegados al principio de línea ("1.2.3. "). */
function collapseGluedEnumerators(text: string): string {
  return text.replace(
    /^(\s*)((?:\d+[.):-]\s*){2,})/gm,
    (_all: string, indent: string, glued: string) => {
      const tokens = glued.match(/\d+[.):-]\s*/g) ?? [];
      return indent + (tokens[tokens.length - 1] ?? glued);
    },
  );
}

/** Renumera 1..N cada racha CONTIGUA de líneas "N.<sep> contenido". */
function renumberSequential(text: string): { texto: string; corregido: boolean } {
  let corregido = false;
  let contador = 0;
  let enRacha = false;
  const lineas = text.split("\n").map((linea) => {
    const m = /^(\s*)(\d+)([.):-])(\s.*)$/.exec(linea);
    if (!m) {
      enRacha = false;
      return linea;
    }
    const [, indent, numStr, sep, resto] = m;
    contador = enRacha ? contador + 1 : 1;
    enRacha = true;
    if (Number(numStr) === contador) return linea;
    corregido = true;
    return `${indent}${contador}${sep}${resto}`;
  });
  return { texto: lineas.join("\n"), corregido };
}

/**
 * Repara la numeración de una lista tras cualquier eliminación de frase
 * (grounding o Mandamientos): colapsa enumeradores huérfanos pegados y
 * renumera 1..N las rachas contiguas de ítems que sobrevivieron. Pura; si no
 * hay nada que arreglar, devuelve el texto intacto.
 */
export function renumberLists(text: string): { texto: string; corregido: boolean } {
  if (!text) return { texto: text, corregido: false };
  const colapsado = collapseGluedEnumerators(text);
  const { texto, corregido: renumerado } = renumberSequential(colapsado);
  const corregido = colapsado !== text || renumerado;
  return { texto: corregido ? cleanup(texto) : text, corregido };
}

/** Formatea a convención es/LatAm ("953.99" → "953,99"). */
function esNum(n: number): string {
  return String(n).replace(".", ",");
}

/**
 * Procesa las cifras bloqueadas frase a frase:
 *   · con `correccion` (mismatch de un concepto que el motor SÍ conoce) → la
 *     cifra se corrige EN SU SITIO y la frase se conserva. El motor sabe el valor
 *     bueno, así que lo pone en vez de borrar información útil. En modo `minimal`
 *     esta corrección NO se aplica: la frase se elimina (PIEZA 1).
 *   · sin `correccion` (monto inventado sin respaldo) → se elimina la frase entera.
 * Cuenta `eliminadas` (frases borradas) y `corregidas` (cifras sustituidas).
 *
 * PIEZA 5 — TODA operación queda registrada en `mutations`: la corrección en
 * sitio (antes/después de la cifra) y también la ELIMINACIÓN (después = ""),
 * que hasta ahora no dejaba rastro alguno.
 */
function removeBlockedSentences(
  text: string,
  blocked: BlockedFigure[],
  mutations?: Mutation[],
  enforcement: EnforcementMode = DEFAULT_ENFORCEMENT_MODE,
): { texto: string; eliminadas: number; corregidas: number } {
  const segments = segmentSentences(text);
  const kept: string[] = [];
  let eliminadas = 0;
  let corregidas = 0;

  for (const seg of segments) {
    const enFrase = blocked.filter((b) => b.start >= seg.start && b.start < seg.end);
    // MINIMAL: se ignora `correccion` — nunca se reescribe una cifra, se elimina
    // la frase que la contiene.
    const aEliminar = enFrase.some(
      (b) => b.correccion === undefined || enforcement === "minimal",
    );

    if (aEliminar) {
      eliminadas++;
      for (const b of enFrase) {
        mutations?.push({
          capa: "grounding",
          regla: b.motivo,
          antes: seg.text.trim(),
          despues: "",
        });
      }
      continue;
    }
    if (enFrase.length === 0) {
      kept.push(seg.text);
      continue;
    }
    // Solo correcciones: sustituye cada cifra por su valor correcto, de derecha a
    // izquierda para no invalidar los offsets de las anteriores.
    let s = seg.text;
    for (const b of enFrase.sort((a, c) => c.start - a.start)) {
      const rel = b.start - seg.start;
      const antes = s.slice(rel, rel + (b.end - b.start));
      const despues = esNum(b.correccion as number);
      s = s.slice(0, rel) + despues + s.slice(rel + (b.end - b.start));
      corregidas++;
      mutations?.push({ capa: "grounding", regla: b.motivo, antes, despues });
    }
    kept.push(s);
  }

  return { texto: cleanup(kept.join("")), eliminadas, corregidas };
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
  const { mode = "mvp" } = options;
  const blocked = validation.cifras_bloqueadas;

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

  // AUDITORÍA AG01 (H3) — esta capa SOLO sanea cifras (elimina/corrige); ya NO
  // inserta cierre. Antes, la "tercera vía" y el camino de eliminación llamaban
  // `appendClosing(..., buildClosingRequest(...))` — un segundo (y tercer) punto
  // de inserción de pregunta que `resolveClosing` (la única autoridad de cierre,
  // PIPELINE_CONTRACT.md §2) no siempre revertía → doble cierre real de QA.
  if (blocked.length === 0) {
    // TERCERA VÍA: la respuesta cita un estándar etiquetado como referencia sin
    // reclamar el dato personal. Se deja pasar igual — que el cierre lo decida
    // `resolveClosing`/`assertOutputInvariants`, no esta capa.
    return { texto_final: modelResponse, bloqueado: false, logEntries };
  }

  // MODO MVP (v2): corrige las cifras de concepto conocido en su sitio y elimina
  // las frases con montos inventados. El cierre (si falta tras eliminar) lo
  // decide la capa 8, nunca esta.
  const { texto, eliminadas, corregidas } = removeBlockedSentences(
    modelResponse,
    blocked,
    options.mutations,
    options.enforcement ?? DEFAULT_ENFORCEMENT_MODE,
  );

  const texto_final = eliminadas === 0
    ? (corregidas > 0 ? texto : modelResponse)
    : texto;
  return { texto_final, bloqueado: true, logEntries };
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
