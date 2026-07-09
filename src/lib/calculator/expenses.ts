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
  // vivienda
  "vivienda", "alquiler", "renda", "rent", "hipoteca", "mortgage",
  // suministros
  "luz", "electricidad", "eletricidade", "electricity", "agua", "water", "gas",
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
// crédito): se descartan al parsear.
const NO_ES_GASTO =
  /\b(ingreso|ingresos|sueldo|salario|gano|gana|gasto|gastos|meta|objetivo|plazo|carro|coche|auto|vehiculo|prestamo|credito|financiar|ahorro|ahorros|deuda)\b/;

/**
 * Extrae una lista de gastos ("netflix 100, luz 50, …") del mensaje. Segmenta por
 * comas, saltos y puntos, y en cada segmento busca un nombre corto seguido de un
 * monto AL FINAL (tolerando € y "al mes"). Así "financiar un carro de 30000 a 36
 * meses" no cuenta (el monto no está al final) y "Ingresos 10000 euros al mes" se
 * descarta por el nombre. Devuelve [] si hay menos de 2 pares.
 *
 * Compartido por el orquestador (clasificador) y el scenario (para no machacar el
 * gasto agregado con el primer ítem de la lista — defecto B).
 */
export function parseExpenseList(message: string): ExpenseItem[] {
  const items: ExpenseItem[] = [];
  const segmentos = message.split(/[,\n]|(?<=[.!?])\s+/);
  const re =
    /([\p{L}][\p{L} ]{0,24}?)\s+(\d[\d.,]*)\s*(?:€|eur|euros?)?\s*(?:\/\s*m[eê]s|al\s+mes|por\s+m[eê]s|per\s+month|\/mo)?\s*$/iu;

  for (const seg of segmentos) {
    const m = re.exec(seg.trim());
    if (!m) continue;
    const name = m[1].trim();
    if (!name || NO_ES_GASTO.test(norm(name))) continue;
    const amount = parseDigitAmount(m[2]);
    if (!Number.isFinite(amount) || amount <= 0) continue;
    items.push({ name, amount });
  }

  return items.length >= 2 ? items : [];
}
