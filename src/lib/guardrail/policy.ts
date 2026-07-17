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
import { segmentSentences, splitSentences, isPercent, isTimeUnit, hasReferenceMarker } from "./context";
import { findNumberMentions } from "./numbers";

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

// ── Cierre por missing (bug de prioridad) ────────────────────────────────────
//
// QA real: el motor marcó missing=["tae"] pero el modelo cerró con "¿Te
// gustaría proceder con esta compra?" — una pregunta LÍCITA (no delegativa,
// `rewriteDelegativeClosing` no la caza) pero de prioridad equivocada: el
// código ya sabe que falta la TAE y el cierre debe pedir exactamente eso.
// Filosofía: el código decide QUÉ se pregunta, el modelo lo redacta.

// Keywords por campo (ES/PT/EN), sobre texto normalizado (sin acentos, minúsculas).
const MISSING_KEYWORDS: Record<string, RegExp> = {
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

function safeAsk(missing: string | undefined, lang: Language): string {
  const key = missing === "meta_monto" ? "meta" : missing;
  const table = key ? SAFE_ASK[key] : undefined;
  return (table ?? SAFE_GENERIC)[lang];
}

/**
 * Garantiza que la respuesta tenga sustancia. Si NO contiene ninguna cifra real
 * Y es corta (<220) o solo relleno genérico, la sustituye por una petición segura
 * del dato que falta. Si ya trae una cifra real, la deja intacta. Puro.
 */
export function ensureSubstance(
  text: string,
  opts: { lang?: Language; missing?: string[] } = {},
): string {
  const lang = opts.lang ?? detectLanguage(text);
  if (hasValidSubstance(text)) return text; // cifra real o referencia % etiquetada
  const esCorto = text.trim().length < 220;
  const esGenerico = GENERIC_SKELETON.test(text);
  if (!esCorto && !esGenerico) return text; // largo y con contenido: se respeta
  return safeAsk(opts.missing?.[0], lang);
}

// ── Limpieza ───────────────────────────────────────────────────────────────

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

/** Formatea a convención es/LatAm ("953.99" → "953,99"). */
function esNum(n: number): string {
  return String(n).replace(".", ",");
}

/**
 * Procesa las cifras bloqueadas frase a frase:
 *   · con `correccion` (mismatch de un concepto que el motor SÍ conoce) → la
 *     cifra se corrige EN SU SITIO y la frase se conserva. El motor sabe el valor
 *     bueno, así que lo pone en vez de borrar información útil.
 *   · sin `correccion` (monto inventado sin respaldo) → se elimina la frase entera.
 * Cuenta `eliminadas` (frases borradas) y `corregidas` (cifras sustituidas).
 */
function removeBlockedSentences(
  text: string,
  blocked: BlockedFigure[],
): { texto: string; eliminadas: number; corregidas: number } {
  const segments = segmentSentences(text);
  const kept: string[] = [];
  let eliminadas = 0;
  let corregidas = 0;

  for (const seg of segments) {
    const enFrase = blocked.filter((b) => b.start >= seg.start && b.start < seg.end);
    const aEliminar = enFrase.some((b) => b.correccion === undefined);

    if (aEliminar) {
      eliminadas++;
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
      s = s.slice(0, rel) + esNum(b.correccion as number) + s.slice(rel + (b.end - b.start));
      corregidas++;
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

  // MODO MVP (v2): corrige las cifras de concepto conocido en su sitio, elimina
  // las frases con montos inventados y, si hubo eliminaciones, cierra UNA vez.
  const { texto, eliminadas, corregidas } = removeBlockedSentences(modelResponse, blocked);

  // Solo hubo correcciones (ninguna frase borrada): el texto corregido es la
  // respuesta final, sin añadir cierre — la información útil se conserva.
  if (eliminadas === 0) {
    return {
      texto_final: corregidas > 0 ? texto : modelResponse,
      bloqueado: true,
      logEntries,
    };
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
