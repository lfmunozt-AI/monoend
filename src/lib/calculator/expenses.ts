// Clasificador determinista de gastos.
//
// Mueve al CÓDIGO una decisión que el prompt hacía de forma frágil: qué gasto es
// vital y cuál es una Fuga de Poder potencial. Taxonomía por keywords en ES/PT/EN
// (insensible a mayúsculas y acentos). Lo no reconocido queda DESCONOCIDO — nunca
// se asume ni entra al recorte.
//
// Código PURO, edge-safe, sin dependencias ni LLM.

import { parseDigitAmount } from "../guardrail/numbers";

export interface ExpenseItem {
  name: string;
  amount: number;
}

export interface ExpenseGroup {
  items: ExpenseItem[];
  total: number;
}

export interface ExpenseClassification {
  vitales: ExpenseGroup;
  noVitales: ExpenseGroup;
  desconocidos: ExpenseGroup;
  /** noVitales.total × factorRecorte. El recorte inicial acordado. */
  recortePropuesto: number;
  /** 0.50 — recorte inicial. Más agresivo SOLO si el usuario lo pide. */
  factorRecorte: number;
}

/** Recorte inicial acordado: la mitad de los gastos no vitales. */
const FACTOR_RECORTE = 0.5;

function norm(s: string): string {
  return s.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase();
}

function round2(n: number): number {
  return Math.round((n + Number.EPSILON) * 100) / 100;
}

// Keywords normalizadas (sin acentos, minúsculas). Multi-palabra permitido.
const VITALES_KEYWORDS = [
  // vivienda — FIX 6 (7ª tanda, testdev6): "arriendo" (término LatAm de
  // alquiler) caía a "desconocido" — el diálogo real decía "arriendo 1000" y
  // todo el desglose se iba a desconocidos, dejando el clasificador
  // inoperante (0 vitales, 0 no vitales). "renta" (México) queda FUERA a
  // propósito: colisiona con "renta fija"/"renta variable" (terminología de
  // inversión ya usada en el prompt), un falso positivo peor que el hueco.
  "vivienda", "alquiler", "arriendo", "renda", "rent", "hipoteca", "mortgage",
  // suministros — "servicios" (LatAm, genérico para luz/agua/gas/internet)
  // tenía el mismo hueco.
  "luz", "electricidad", "eletricidade", "electricity", "agua", "water", "gas", "servicios",
  // alimentación
  "mercado", "supermercado", "comida", "alimentacao", "groceries", "food",
  // salud
  "salud", "saude", "health", "farmacia",
  // transporte
  "transporte", "transport", "gasolina", "combustivel", "fuel",
  // educación
  "colegio", "escola", "school", "educacion", "educacao",
  // conectividad y protección
  "internet", "telefono", "telemovel", "phone", "seguro", "insurance",
];

const NO_VITALES_KEYWORDS = [
  // streaming / suscripciones
  "netflix", "spotify", "hbo", "disney", "streaming", "suscripcion", "subscription", "assinatura",
  // alcohol / tabaco
  "cerveza", "cerveja", "beer", "alcohol", "vino", "wine", "tabaco", "tobacco", "cigarros",
  // restauración / delivery
  "restaurante", "delivery", "uber eats", "glovo", "takeaway",
  // ocio / juego
  "ocio", "lazer", "entertainment", "juegos", "gaming", "apuestas", "betting",
  // otros discrecionales
  "ropa", "clothing", "gimnasio",
];

/** ¿El nombre contiene alguna de estas keywords (palabra completa o frase)? */
function matchesAny(nameNorm: string, keywords: string[]): boolean {
  for (const kw of keywords) {
    if (kw.includes(" ")) {
      if (nameNorm.includes(kw)) return true;
    } else {
      // Palabra completa: evita que "aguacate" matchee "agua".
      if (new RegExp(`\\b${kw}\\b`).test(nameNorm)) return true;
    }
  }
  return false;
}

/** Categoría de un gasto según la taxonomía. */
export function classifyExpense(name: string): "vital" | "no_vital" | "desconocido" {
  const n = norm(name);
  // No vitales primero: sus keywords son más específicas (netflix, cerveza) que
  // las genéricas de vitales (food, agua); ante un nombre que sugiere fuga, gana.
  if (matchesAny(n, NO_VITALES_KEYWORDS)) return "no_vital";
  if (matchesAny(n, VITALES_KEYWORDS)) return "vital";
  return "desconocido";
}

function group(items: ExpenseItem[]): ExpenseGroup {
  const total = round2(items.reduce((a, b) => a + b.amount, 0));
  return { items, total };
}

/**
 * Clasifica una lista de gastos en vitales / no vitales / desconocidos y calcula
 * el recorte propuesto (mitad de los no vitales). Los DESCONOCIDOS no entran al
 * recorte: no se asume nada sobre ellos.
 */
export function classifyExpenses(items: ExpenseItem[]): ExpenseClassification {
  const vitales: ExpenseItem[] = [];
  const noVitales: ExpenseItem[] = [];
  const desconocidos: ExpenseItem[] = [];

  for (const item of items) {
    switch (classifyExpense(item.name)) {
      case "vital": vitales.push(item); break;
      case "no_vital": noVitales.push(item); break;
      default: desconocidos.push(item);
    }
  }

  const grpNoVitales = group(noVitales);
  return {
    vitales: group(vitales),
    noVitales: grpNoVitales,
    desconocidos: group(desconocidos),
    recortePropuesto: round2(grpNoVitales.total * FACTOR_RECORTE),
    factorRecorte: FACTOR_RECORTE,
  };
}

// ── Parseo de una lista de gastos en texto libre ─────────────────────────────
// Nombres que NO son un gasto (agregados, etiquetas de perfil, escenario de
// crédito): se descartan al parsear. "carro/coche/auto/vehiculo" quedaron
// FUERA a propósito (5ª tanda): son categorías de gasto legítimas (cuota del
// carro, gasolina) y el caso real las necesita ("250 carro"). La colisión con
// "financiar un carro de 30000" la resuelve `STOPWORD_NAME_RE` en el fallback
// monto-primero, no esta lista.
const NO_ES_GASTO =
  /\b(ingreso|ingresos|sueldo|salario|gano|gana|gasto|gastos|meta|objetivo|plazo|prestamo|credito|financiar|ahorro|ahorros|deuda)\b/;

// BUG BLOQUEANTE (6ª tanda, testdev5) — "...dudo entre 200000, 300000 o
// 150000" (candidatas de precio de una meta sin decidir, mencionadas en el
// MISMO mensaje que los gastos) se colaba como DOS ítems de gasto: {"dudo
// entre": 200000} y {"o": 150000}. El regex de arriba no exige que el
// "nombre" capturado SEA un nombre de gasto — solo que sean letras y
// espacios antes del número. Un nombre que TERMINA en un conector
// (preposición/artículo/conjunción) nunca es un gasto real ("luz", "netflix",
// "arriendo" no terminan en "entre"/"o"/"de"): es el resto de una frase que
// solo ENVUELVE al número, no lo nombra.
const TERMINA_EN_CONECTOR_RE =
  /\b(?:entre|de|del|a|al|con|sin|para|por|o|u|y|el|la|los|las|un|una|unos|unas|que|es|son)$/i;

/**
 * Extrae una lista de gastos ("netflix 100, luz 50, …") del mensaje. Segmenta por
 * comas, saltos y puntos, y en cada segmento busca un nombre corto seguido de un
 * monto AL FINAL (tolerando € y "al mes"). Así "financiar un carro de 30000 a 36
 * meses" no cuenta (el monto no está al final) y "Ingresos 10000 euros al mes" se
 * descarta por el nombre. Devuelve [] si hay menos de 2 pares.
 */
function parseExpenseListNameFirst(message: string): ExpenseItem[] {
  const items: ExpenseItem[] = [];
  const segmentos = message.split(/[,\n]|(?<=[.!?])\s+/);
  const re =
    /([\p{L}][\p{L} ]{0,24}?)\s+(\d[\d.,]*)\s*(?:€|eur|euros?)?\s*(?:\/\s*m[eê]s|al\s+mes|por\s+m[eê]s|per\s+month|\/mo)?\s*$/iu;

  for (const seg of segmentos) {
    const m = re.exec(seg.trim());
    if (!m) continue;
    const name = m[1].trim();
    if (!name || NO_ES_GASTO.test(norm(name)) || TERMINA_EN_CONECTOR_RE.test(norm(name))) continue;
    const amount = parseDigitAmount(m[2]);
    if (!Number.isFinite(amount) || amount <= 0) continue;
    items.push({ name, amount });
  }

  return items;
}

/**
 * FALLBACK (5ª tanda) — secuencia "MONTO nombre MONTO nombre…" SIN comas.
 * Caso real: "gasto= 1000 arriendo 500 servicios 250 carro 100 ropa" — el
 * orden está INVERTIDO respecto al formato principal (monto ANTES del
 * nombre, no después) y no hay comas entre ítems. Tokeniza por espacios y
 * empareja cada número con las palabras que lo siguen hasta el próximo
 * número; un número sin ninguna palabra detrás (p. ej. un total agregado
 * seguido de ":") no produce ítem — lo cuenta el detector de huérfanos o la
 * reconciliación de discrepancia, no esta función.
 */
// Palabras que, SOLAS, no son un nombre de gasto válido (preposiciones,
// artículos, conectores, unidades de tiempo). QA real: sin esto, "financiar un
// carro de 30000 a 36 meses" producía DOS ítems espurios ({a: 30000}, {meses:
// 36}) — el 30000 y el 36 de un escenario de crédito, no una lista de gastos.
const STOPWORD_NAME_RE =
  /^(?:a|al|de|del|en|el|la|los|las|un|una|unos|unas|y|o|por|para|con|sin|que|es|son|mi|tu|su|meses?|mes|a[ñn]os?|anos?|d[ií]as?|semanas?|trimestres?|months?|years?|days?|weeks?)$/i;

function parseExpenseListAmountFirst(message: string): ExpenseItem[] {
  const tokens = message.trim().split(/\s+/).filter(Boolean);
  const items: ExpenseItem[] = [];
  let i = 0;
  while (i < tokens.length) {
    const tok = tokens[i];
    if (!/^\d/.test(tok)) {
      i++;
      continue;
    }
    const amount = parseDigitAmount(tok.replace(/[.,;:€]+$/, ""));
    let j = i + 1;
    const words: string[] = [];
    while (j < tokens.length && !/^\d/.test(tokens[j])) {
      const w = tokens[j].replace(/^[.,;:()]+|[.,;:()]+$/g, "");
      if (w) words.push(w);
      j++;
    }
    const name = words.join(" ").trim();
    const esSoloStopwords = words.length > 0 && words.every((w) => STOPWORD_NAME_RE.test(w));
    if (Number.isFinite(amount) && amount > 0 && name && !esSoloStopwords && !NO_ES_GASTO.test(norm(name))) {
      items.push({ name, amount });
    }
    i = j;
  }
  return items;
}

/**
 * Extrae una lista de gastos del mensaje, en cualquiera de los DOS formatos:
 * "nombre monto" (principal, con comas) o "monto nombre" (fallback, sin
 * comas — QA real). Devuelve [] si ningún formato encuentra ≥2 pares.
 *
 * Compartido por el orquestador (clasificador) y el scenario (para no machacar el
 * gasto agregado con el primer ítem de la lista — defecto B).
 */
export function parseExpenseList(message: string): ExpenseItem[] {
  const nameFirst = parseExpenseListNameFirst(message);
  if (nameFirst.length >= 2) return nameFirst;

  const amountFirst = parseExpenseListAmountFirst(message);
  return amountFirst.length >= 2 ? amountFirst : [];
}
