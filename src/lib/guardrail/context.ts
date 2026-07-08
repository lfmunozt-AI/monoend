// Detección de contexto alrededor de una cifra: moneda, porcentaje, unidad de
// tiempo, marcador de referencia y etiqueta por proximidad. Código PURO,
// compartido por las piezas 1 y 2.

import type { NumberMention } from "./numbers";

/** Moneda/contexto normalizado de una cifra. `null` = no determinado. */
export type Moneda = "EUR" | "USD" | "pesos" | "%" | "$" | null;

function norm(s: string): string {
  return s.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase();
}

// ── Frase que contiene una cifra ─────────────────────────────────────────────
const SENTENCE_END = [".", "!", "?", "\n"];

/**
 * Límites [start, end) de la frase que contiene el rango dado. La frase es la
 * unidad de decisión del guardarraíl: se elimina entera, y un marcador de
 * referencia solo vale si vive en la MISMA frase que la cifra.
 */
export function sentenceRangeAt(text: string, from: number, to: number): [number, number] {
  let start = 0;
  for (const ch of SENTENCE_END) {
    const i = text.lastIndexOf(ch, from - 1);
    if (i !== -1 && i + 1 > start) start = i + 1;
  }

  let end = text.length;
  for (const ch of SENTENCE_END) {
    const i = text.indexOf(ch, to);
    if (i !== -1 && i < end) end = i;
  }

  return [start, end];
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
