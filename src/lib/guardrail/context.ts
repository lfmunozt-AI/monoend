// Detección de contexto alrededor de una cifra: moneda, porcentaje, unidad de
// tiempo, marcador de referencia y etiqueta por proximidad. Código PURO,
// compartido por las piezas 1 y 2.

import type { NumberMention } from "./numbers";

/** Moneda/contexto normalizado de una cifra. `null` = no determinado. */
export type Moneda = "EUR" | "USD" | "pesos" | "%" | "$" | null;

function norm(s: string): string {
  return s.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase();
}

// ── Segmentador de oraciones — ÚNICO en el sistema, NUMERIC-SAFE ──────────────
//
// BUG QA: "tu sobrante mensual de 1.000 €" salía como "tu sobrante mensual de 1."
// porque el splitter cortaba en el punto de los millares. Este es el ÚNICO
// segmentador del sistema; policy.ts y output-validator.ts lo consumen para que
// eliminación de frases, `violatingSentences` y `sentenceRangeAt` corten igual.
//
// Reglas de corte (un `[.!?]` es límite de frase solo si TODAS se cumplen):
//   1. No está entre dígitos → respeta 1.000 · 3,5 · 1.234,56.
//   2. No va tras una abreviatura común (Sr., etc., p.ej., núm., …).
//   3. Va seguido de espacio + inicio de frase nueva (mayúscula/¿/¡/comilla/
//      dígito), o de fin de texto.
// El salto de línea `\n` es siempre límite (separa párrafos).

interface Sentence {
  /** Texto del segmento, delimitadores incluidos (concatenar reproduce el original). */
  text: string;
  start: number;
  end: number;
}

// Abreviaturas tras las que un punto NO cierra frase. Sin acentos (se comparan
// sobre `norm`). "p.ej" cubre el punto final de "p.ej."; el interno lo salva ya
// la regla de "espacio después".
const ABBREVIATIONS = new Set([
  "sr", "sra", "srta", "dr", "dra", "d", "dna", "ud", "uds", "vd", "vds",
  "etc", "vs", "av", "avda", "num", "nro", "art", "pag", "ej", "aprox",
  "max", "min", "cap", "fig", "pp", "ss", "esq", "izq", "dcha", "tel",
]);

const DIGIT = /\d/;
const SENTENCE_START = /[\p{Lu}¿¡"«'(0-9]/u;

/** ¿El `[.!?]` en la posición `i` cierra realmente una frase? */
function isSentenceBoundary(text: string, i: number): boolean {
  const ch = text[i];
  if (ch !== "." && ch !== "!" && ch !== "?") return false;

  // (1) Entre dígitos: separador de millares/decimal. No corta.
  if (DIGIT.test(text[i - 1] ?? "") && DIGIT.test(text[i + 1] ?? "")) return false;

  // (2) Tras abreviatura común (solo aplica al punto).
  if (ch === ".") {
    const m = /([\p{L}]+)$/u.exec(text.slice(Math.max(0, i - 12), i));
    if (m && ABBREVIATIONS.has(norm(m[1]))) return false;
  }

  // (3) Fin de texto, o espacio + inicio de frase nueva.
  const rest = text.slice(i + 1);
  if (rest === "") return true;
  const m = /^\s+(\S)/.exec(rest);
  if (!m) return false; // sin espacio tras el signo → no es límite (p.ej "p.ej")
  return SENTENCE_START.test(m[1]);
}

/**
 * Parte el texto en segmentos con offsets. Partición contigua: concatenar
 * `seg.text` reproduce el original EXACTO (delimitadores incluidos). Es el núcleo
 * que usan `splitSentences`, `sentenceRangeAt` y la eliminación de frases.
 */
export function segmentSentences(text: string): Sentence[] {
  const segs: Sentence[] = [];
  let start = 0;
  let i = 0;
  while (i < text.length) {
    if (text[i] === "\n" || isSentenceBoundary(text, i)) {
      // Absorbe un run contiguo de signos y saltos ("?!", ".\n\n").
      let j = i + 1;
      while (j < text.length && (text[j] === "\n" || ".!?".includes(text[j]))) j++;
      segs.push({ text: text.slice(start, j), start, end: j });
      start = j;
      i = j;
    } else {
      i++;
    }
  }
  if (start < text.length) segs.push({ text: text.slice(start), start, end: text.length });
  return segs.length ? segs : [{ text, start: 0, end: text.length }];
}

/**
 * Utilidad canónica: oraciones del texto como strings recortados y no vacíos.
 * Numeric-safe. Es la que deben usar todos los consumidores que no necesiten
 * offsets.
 */
export function splitSentences(text: string): string[] {
  return segmentSentences(text)
    .map((s) => s.text.trim())
    .filter(Boolean);
}

/**
 * Límites [start, end) de la frase que contiene el rango dado. `end` excluye la
 * puntuación de cierre y los espacios finales (los consumidores hacen trim). La
 * frase es la unidad de decisión del guardarraíl: se elimina entera, y un
 * marcador de referencia solo vale si vive en la MISMA frase que la cifra.
 */
export function sentenceRangeAt(text: string, from: number, to: number): [number, number] {
  for (const seg of segmentSentences(text)) {
    if (from >= seg.start && from < seg.end) {
      // Recorta la puntuación/espacios de cierre para devolver solo el contenido.
      let end = seg.end;
      while (end > seg.start && /[.!?\n\s]/.test(text[end - 1] ?? "")) end--;
      return [seg.start, Math.max(end, to)];
    }
  }
  return [0, text.length];
}

// ── Marcador de referencia ───────────────────────────────────────────────────
// "Tercera vía": un estándar de la industria puede mencionarse como PUENTE DE
// CONOCIMIENTO, nunca como diagnóstico. Lo que separa una cosa de la otra es que
// la frase se etiquete explícitamente como referencia. Sin marcador, "el 20%" es
// una cifra de manual disfrazada de respuesta personal.
// ES/PT/EN — regla transversal del proyecto: toda lista de detección cubre los
// tres idiomas. "como referencia" y "habitualmente" valen en ES y PT a la vez.
const REFERENCE_MARKERS = [
  // ES
  "como referencia",
  "de referencia",
  "el estandar",
  "suele",
  "en general",
  "orientativo",
  "orientativa",
  "habitualmente",
  "tipicamente",
  // PT
  "o padrao",
  "costuma",
  "em geral",
  "a titulo indicativo",
  "indicativo",
  "geralmente",
  // EN
  "as a reference",
  "for reference",
  "the standard",
  "a rule of thumb",
  "rule of thumb",
  "typically",
  "usually",
  "generally",
  "on average",
  "ballpark",
];

/** ¿La frase presenta la cifra como estándar/orientación, no como diagnóstico? */
export function hasReferenceMarker(sentence: string): boolean {
  const n = norm(sentence);
  return REFERENCE_MARKERS.some((mk) => n.includes(mk));
}

// ── Conceptos financieros (grounding semántico, PIEZA 2) ─────────────────────
// Keywords ES/PT/EN → concepto canónico. Si una frase nombra un concepto y el
// motor conoce su valor exacto, la cifra de esa frase DEBE coincidir con él: la
// heurística de multiplicadores no aplica cuando hay un concepto conocido.
// HUECO QA: "tus ingresos son de 500 €" (ingreso real 10000) pasó el guardarraíl
// porque ni "ingreso" ni "gastos" tenían concepto — caían a la heurística
// genérica y 500 (el sobrante) coincidía por c0. Mismo patrón del defecto C.
const CONCEPT_KEYWORDS: [RegExp, string][] = [
  [/\b(cuota|cuotas|mensualidad|mensualidade|prestacao|prestacoes|payment|installment)\b/, "cuota"],
  [/\b(sobrante|excedente|surplus|left ?over)\b/, "sobrante"],
  [/\b(recorte|corte|cut)\b/, "recorte"],
  [/\b(capacidad (?:de ahorro )?anual|capacidad anual|annual capacity|yearly (?:savings|capacity))\b/, "capacidad_anual"],
  [/\b(ingreso|ingresos|sueldo|salario|rendimento|income|earnings|gano|ganas)\b/, "ingreso"],
  // "gastos" NO debe casar con "gastos vitales"/"gastos no vitales": son
  // subtotales con su propio valor (gastos_vitales/gastos_no_vitales), sin
  // concepto propio todavía — si "gastos" los capturase, el guardarraíl
  // "corregiría" 510/135 al total mensual (2372), que es la propia alucinación
  // que este fix busca evitar, solo que sobre un concepto distinto.
  [/\b(?:gastos|gasto)\b(?!\s+(?:vitales|no\s+vitales))|\b(?:despesas|expenses|spending)\b/, "gastos"],
  // BUG 2: el déficit (gastas más de lo que ingresas) es un concepto propio, no
  // un "sobrante negativo" — sin esto, un déficit citado con la cifra errónea
  // caería a la heurística genérica igual que ingreso/gastos antes del fix.
  [/\b(deficit|defice|shortfall)\b|gastas de mas|numeros rojos/, "deficit"],
];

/** Conceptos financieros nombrados en la frase (canónicos, sin repetir). */
export function conceptsInSentence(sentence: string): string[] {
  const n = norm(sentence);
  const out: string[] = [];
  for (const [re, concepto] of CONCEPT_KEYWORDS) {
    if (re.test(n) && !out.includes(concepto)) out.push(concepto);
  }
  return out;
}

/**
 * El concepto MÁS CERCANO a la cifra `m` (posiciones relativas a `sentence`),
 * de entre los que están en `known`.
 *
 * HUECO QA: "Tus ingresos son de 500 € y tus gastos son de 500 €, lo que te
 * deja un sobrante de 500 €" es UNA sola frase (sin punto entre cláusulas) que
 * nombra ingreso, gastos y sobrante a la vez. `conceptsInSentence` por sí solo
 * no basta: si cualquiera de los tres conceptos de la frase tiene el valor
 * citado, un chequeo "algún concepto de la frase coincide" aprobaría los TRES
 * 500 con solo que el sobrante fuera 500 — exactamente el defecto C, pero a
 * nivel de frase en vez de por confusión con `valores`. La cifra debe cotejarse
 * contra el concepto textualmente más próximo, no contra cualquiera presente.
 */
export function nearestConceptInSentence(
  sentence: string,
  m: { start: number; end: number },
  known: ReadonlySet<string>,
): string | null {
  if (known.size === 0) return null;
  const n = norm(sentence);
  // Prioridad direccional: en ES/PT/EN el concepto PRECEDE a su cifra ("tu
  // sobrante es de 1369", "capacidad anual es de 16428" — igual que asume
  // `conceptValue` del harness de regresión). Un concepto más cercano mirando
  // ATRÁS gana siempre a uno más cercano mirando ADELANTE, aunque este último
  // esté a menos caracteres: si no, "sobrante es de 1369 y capacidad anual es
  // de 16428" asignaría el 1369 a "capacidad anual" (más próximo en bruto)
  // en vez de a "sobrante" (el que de verdad lo antecede).
  let bestBefore: string | null = null;
  let bestBeforeDist = Infinity;
  let bestAfter: string | null = null;
  let bestAfterDist = Infinity;
  for (const [re, concepto] of CONCEPT_KEYWORDS) {
    if (!known.has(concepto)) continue;
    const g = new RegExp(re.source, "g");
    let match: RegExpExecArray | null;
    while ((match = g.exec(n)) !== null) {
      const matchEnd = match.index + match[0].length;
      if (matchEnd <= m.start) {
        const dist = m.start - matchEnd;
        if (dist < bestBeforeDist) {
          bestBeforeDist = dist;
          bestBefore = concepto;
        }
      } else if (match.index >= m.end) {
        const dist = match.index - m.end;
        if (dist < bestAfterDist) {
          bestAfterDist = dist;
          bestAfter = concepto;
        }
      }
    }
  }
  return bestBefore ?? bestAfter;
}

// ── Porcentaje ───────────────────────────────────────────────────────────────
// "%" pegado o casi pegado tras la cifra, o "por ciento"/"porciento".
export function isPercent(text: string, m: NumberMention): boolean {
  const after = text.slice(m.end, m.end + 12);
  if (/^\s*%/.test(after)) return true;
  return /^\s*(por\s*ciento|porciento)/.test(norm(after));
}

// ── Unidad de tiempo (regla general, no es dinero) ───────────────────────────
// "6 meses", "3 a 6 meses", "2 años", "30 días"… El número que CUANTIFICA una
// unidad temporal NO es un monto monetario. La unidad debe seguir directamente
// a la cifra (admitiendo el patrón de rango "3 a 6 meses" para el primer
// número). Así NO confundimos cadencia con duración: en "8000 euros al mes" el
// 8000 es dinero, no una duración.
const TIME_UNIT_AFTER =
  /^\s*(?:a\s+\d[\d.,]*\s+)?(?:mes|meses|anos?|dias?|semana|semanas|trimestre|trimestres|quincena|quincenas)\b/;

export function isTimeUnit(text: string, m: NumberMention): boolean {
  return TIME_UNIT_AFTER.test(norm(text.slice(m.end, m.end + 16)));
}

// ── Moneda ───────────────────────────────────────────────────────────────────
const CURRENCY_WORDS: [RegExp, Moneda][] = [
  [/\b(euros?|eur)\b/, "EUR"],
  [/\b(dolares?|dolar|usd)\b/, "USD"],
  [/\b(pesos?)\b/, "pesos"],
];

/**
 * Determina la moneda de una cifra mirando el símbolo pegado y un pequeño
 * entorno de palabras a ambos lados. Prioriza el porcentaje, luego símbolos
 * pegados (€, $) y por último palabras (euros, pesos…).
 */
export function detectCurrency(text: string, m: NumberMention): Moneda {
  if (isPercent(text, m)) return "%";

  const before = text.slice(Math.max(0, m.start - 12), m.start);
  const after = text.slice(m.end, m.end + 14);

  if (/€/.test(before + after)) return "EUR";

  const window = norm(`${before} ${after}`);
  for (const [re, code] of CURRENCY_WORDS) {
    if (re.test(window)) return code;
  }

  // "$" es genérico (puede ser USD o pesos según país): se marca como tal.
  if (/\$/.test(before + after)) return "$";

  return null;
}

// ── Etiqueta por proximidad ──────────────────────────────────────────────────
// Mapa de palabras de contexto → etiqueta del hecho. Se elige la coincidencia
// más cercana a la cifra dentro de una ventana acotada.
const LABEL_KEYWORDS: [string, string][] = [
  ["deuda", "deuda"], ["deudas", "deuda"], ["debo", "deuda"],
  ["prestamo", "deuda"], ["prestamos", "deuda"], ["credito", "deuda"],
  ["creditos", "deuda"], ["hipoteca", "deuda"],
  ["gano", "ingreso"], ["gana", "ingreso"], ["ingreso", "ingreso"],
  ["ingresos", "ingreso"], ["sueldo", "ingreso"], ["salario", "ingreso"],
  ["cobro", "ingreso"], ["facturo", "ingreso"],
  ["ahorro", "ahorro"], ["ahorros", "ahorro"], ["ahorrar", "ahorro"],
  ["gasto", "gasto"], ["gastos", "gasto"], ["pago", "gasto"], ["pagos", "gasto"],
  ["meta", "meta"], ["objetivo", "meta"],
  ["renta", "renta"], ["alquiler", "renta"],
  ["inversion", "inversion"], ["invertir", "inversion"],
  ["interes", "interes"], ["intereses", "interes"], ["tasa", "interes"],
  ["patrimonio", "patrimonio"], ["capital", "patrimonio"],
];

const LABEL_WINDOW = 40;

/**
 * Etiqueta a qué se refiere una cifra según las palabras cercanas
 * ("40000 en deudas" → "deuda"). Devuelve "" si no encuentra contexto.
 */
export function detectLabel(text: string, m: NumberMention): string {
  const from = Math.max(0, m.start - LABEL_WINDOW);
  const to = Math.min(text.length, m.end + LABEL_WINDOW);
  const windowNorm = norm(text.slice(from, to));
  // Offset aproximado de la cifra dentro de la ventana (quitar marcas NFD puede
  // desplazarlo unos pocos chars si hay acentos antes; solo afecta al desempate
  // por cercanía, no a si se detecta o no la etiqueta).
  const anchor = m.start - from;

  let best = "";
  let bestDist = Infinity;
  for (const [kw, label] of LABEL_KEYWORDS) {
    const re = new RegExp(`\\b${kw}\\b`, "g");
    let match: RegExpExecArray | null;
    while ((match = re.exec(windowNorm)) !== null) {
      const dist = Math.abs(match.index - anchor);
      if (dist < bestDist) {
        bestDist = dist;
        best = label;
      }
    }
  }
  return best;
}
