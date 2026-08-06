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
// PIEZA 4 (8ª tanda) — "tae" añadido: regresión real (regression-harness,
// escenario suma_cuota_deficit) — "...con una TAE del 9%." producía el ítem
// espurio {name: "TAE", amount: 48} (el 48 de "48 meses", ya sin la palabra
// "meses" tras el filtro de ruido). La TAE es un concepto de crédito
// (RATE_CONTEXT en scenario.ts), nunca una partida de gasto.
const NO_ES_GASTO =
  /\b(ingreso|ingresos|sueldo|salario|gano|gana|gasto|gastos|meta|objetivo|plazo|prestamo|credito|financiar|ahorro|ahorros|deuda|tae|tasa)\b/;

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

// Palabras que, SOLAS, no son un nombre de gasto válido (preposiciones,
// artículos, conectores, unidades de tiempo). QA real: sin esto, "financiar un
// carro de 30000 a 36 meses" producía DOS ítems espurios ({a: 30000}, {meses:
// 36}) — el 30000 y el 36 de un escenario de crédito, no una lista de gastos.
// PIEZA 4 (8ª tanda) — "mis/tus/sus" añadidos: regresión real (mismo
// escenario que "tae" arriba) — "...y mis gastos son 2500." producía
// {name: "mis", amount: 2000} (el 2000 de "Gano 2000 euros al mes", ya sin
// "euros"/"al"/"mes" tras el filtro de ruido). Posesivos plurales, no
// singulares — "mi"/"tu"/"su" ya estaban.
const STOPWORD_NAME_RE =
  /^(?:a|al|de|del|en|el|la|los|las|un|una|unos|unas|y|o|por|para|con|sin|que|es|son|mi|tu|su|mis|tus|sus|meses?|mes|a[ñn]os?|anos?|d[ií]as?|semanas?|trimestres?|months?|years?|days?|weeks?)$/i;

// PIEZA 4 (8ª tanda) — ruido a ignorar durante el tokenizado: unidades de
// tiempo/moneda que no son ni nombre ni monto ("al mes", "€", "euros"). Se
// descartan ANTES de la segmentación de partidas, para que ni acumulen en un
// nombre ni interrumpan el emparejamiento nombre↔monto.
const IGNORABLE_WORD_RE = /^(?:eur|euros?|al|por|per|mes|meses|month|months?|mo|semana|semanas)$/i;

/** ¿`s` tiene forma de monto ("225", "2500,50")? Sin espacios — esos ya se separaron al tokenizar. */
function isNumberToken(s: string): boolean {
  return /^\d[\d.,]*$/.test(s);
}

/**
 * ¿`s` tiene forma de nombre? PIEZA 4 — admite guion bajo, guion y punto
 * además de letras ("Diezmo_Vital", "Colegio-Niño", "Supermercado.Vital"):
 * el regex anterior solo aceptaba letras y espacios, así que NINGUNA
 * partida del caso real (testdev7, nombres con "_") matcheaba.
 */
function isWordToken(s: string): boolean {
  return /^[\p{L}][\p{L}_.-]*$/u.test(s);
}

/** ¿`name` es un nombre de gasto válido? (ni agregado/etiqueta, ni conector, ni solo stopwords). */
function esNombreValido(nameRaw: string): boolean {
  const name = nameRaw.trim();
  if (!name || name.length > 60) return false;
  const n = norm(name);
  if (NO_ES_GASTO.test(n)) return false;
  if (TERMINA_EN_CONECTOR_RE.test(n)) return false;
  const words = name.split(/\s+/);
  if (words.length > 6) return false; // gramática limitada: nombres razonablemente cortos.
  if (words.every((w) => STOPWORD_NAME_RE.test(norm(w)))) return false;
  return true;
}

interface Tok {
  raw: string;
  kind: "num" | "word";
  /** ¿El token original terminaba en ":" ("Alquiler:")? Ver `emparejarNombreMonto`. */
  hadColon?: boolean;
}

// PIEZA 2/4 (8ª tanda) — mismo vocabulario que `SUSTANTIVO_NO_MONETARIO_AFTER_RE`
// / `TIEMPO_AFTER_RE` de scenario.ts (edad, nº de hijos, duración, unidades):
// un número pegado a uno de estos NUNCA es un monto de gasto. Sin este filtro,
// "tengo 43 años, 2 hijos" se leía como una lista de gastos válida ({tengo:
// 43}, {hijos: 2}) — regresión real (caso 11: "gano 2300, tengo 43 años, 2
// hijos, gasto 2200" debe seguir siendo COMPLETE, nunca una lista de gastos).
const UNIDAD_NO_MONETARIA_RE =
  /^(?:a[ñn]os?|anos?|years?|meses?|months?|d[ií]as?|days?|semanas?|weeks?|horas?|hours?|hijos?|hijas?|filhos?|filhas?|kids?|child(?:ren)?|ni[ñn]os?|personas?|people|veces|times|kgs?|kilos?|m2|m²|habitaciones?|hab|quartos?|rooms?|edad|idade|age|grados?|graus|degrees?)$/i;

/**
 * PIEZA 4 — LÍMITES PRIMERO: tokeniza un segmento YA ACOTADO (una partida o un
 * fragmento sin comas) por espacios simples. Nunca reagrupa dígitos separados
 * por espacio como si fueran miles — eso es exactamente lo que
 * `resolverPegado` (más abajo) decide caso por caso, no el tokenizador.
 */
function tokenizeSegment(segment: string): Tok[] {
  const raw = segment.trim().split(/\s+/).filter(Boolean);
  const toks: Tok[] = [];
  for (const r of raw) {
    const hadColon = r.endsWith(":");
    const stripped = r.replace(/^[.,;:()€$=]+|[.,;:()€$=]+$/g, "");
    if (!stripped) continue;
    if (isNumberToken(stripped)) {
      toks.push({ raw: stripped, kind: "num" });
    } else if (IGNORABLE_WORD_RE.test(stripped)) {
      continue; // ruido (unidad de tiempo/moneda) — no es nombre ni monto.
    } else if (isWordToken(stripped)) {
      toks.push({ raw: stripped, kind: "word", hadColon });
    }
    // cualquier otro símbolo suelto se descarta.
  }

  // Un número seguido de una unidad NO monetaria ("43 años", "2 hijos") no es
  // un monto de gasto: se descartan AMBOS tokens, para que ni el número quede
  // disponible como pendingAmount ni la unidad se cuele como nombre.
  const filtrados: Tok[] = [];
  for (let i = 0; i < toks.length; i++) {
    const tok = toks[i];
    const next = toks[i + 1];
    if (tok.kind === "num" && next && next.kind === "word" && UNIDAD_NO_MONETARIA_RE.test(next.raw)) {
      i++; // descarta también la unidad.
      continue;
    }
    filtrados.push(tok);
  }
  return filtrados;
}

/** ¿`raw` tiene EXACTAMENTE 3 dígitos? (continuación válida de miles-con-espacio, misma regla que el parser general). */
function esContinuacionDeMiles(raw: string): boolean {
  return /^\d{3}$/.test(raw);
}

/**
 * PIEZA 3/4 — PASO 1: detección de PEGADO. Dos números NUM NUM directamente
 * adyacentes (solo un espacio entre ellos, sin nombre ni coma de por medio)
 * son estructuralmente ambiguos: "60 100" es EXACTAMENTE la misma forma que
 * "2 500" (miles con espacio, caso 10) — el mismo parser general los uniría
 * en 60100. La única señal que distingue "es un monto con miles" de "son dos
 * partidas" es si HAY un nombre disponible para reclamar el segundo número:
 *   - si NO hay nombre después (fin de la partida) → no hay otra lectura
 *     posible → se fusionan en un solo monto, sin preguntar (caso 10/"alquiler
 *     2 500").
 *   - si SÍ hay un nombre después → se separan (cada número a su partida) PERO
 *     se marca sospechoso, para que el eco confirme la lectura.
 * Nunca cruza el límite de una partida ya establecida (opera DENTRO de un
 * segmento acotado por comas/saltos — PIEZA 4).
 */
function resolverPegado(tokens: Tok[]): { tokens: Tok[]; pares: Array<[Tok, Tok]> } {
  const out: Tok[] = [];
  const pares: Array<[Tok, Tok]> = [];
  let i = 0;
  while (i < tokens.length) {
    const t = tokens[i];
    const next = tokens[i + 1];
    if (t.kind === "num" && next && next.kind === "num" && esContinuacionDeMiles(next.raw)) {
      const after = tokens[i + 2];
      const hayNombreDespues = !!after && after.kind === "word";
      if (!hayNombreDespues) {
        out.push({ raw: `${t.raw} ${next.raw}`, kind: "num" });
        i += 2;
        continue;
      }
      pares.push([t, next]);
      out.push(t);
      i += 1;
      continue;
    }
    out.push(t);
    i += 1;
  }
  return { tokens: out, pares };
}

/**
 * PIEZA 3/4 — PASO 2: emparejamiento nombre↔monto bidireccional dentro de una
 * partida ya acotada. Soporta AMBOS órdenes ("nombre monto" y "monto
 * nombre"), incluso mezclados en la misma partida ("700 Casa_Vital
 * Supermercado_Vital 450" → (Casa_Vital,700) + (Supermercado_Vital,450)). Un
 * nombre candidato se valida ANTES de cerrarse contra un monto — si no es un
 * nombre de gasto válido (p. ej. "gasto=", "financiar un carro de"), se
 * descarta y el monto queda disponible para la SIGUIENTE palabra ("gasto=
 * 1000 arriendo" → 1000 va con "arriendo", no con "gasto").
 */
function emparejarNombreMonto(tokens: Tok[]): ExpenseItem[] {
  const items: ExpenseItem[] = [];
  let pendingName: string[] = [];
  let pendingAmount: number | undefined;

  for (let idx = 0; idx < tokens.length; idx++) {
    const tok = tokens[idx];

    // PIEZA 4 (forma "Alquiler: 700") — un ":" pegado a la palabra es una
    // promesa de valor inmediato. Si SÍ va seguido de un número, la palabra
    // arranca un nombre fresco (descarta cualquier prefijo acumulado antes,
    // p. ej. "Mis gastos:" — "gastos" invalidaría el nombre combinado). Si
    // el ":" NO va seguido de un número, era un encabezado ("Mis gastos:
    // netflix 15…") — se descarta TODO lo acumulado, sin arrastrarlo al
    // nombre real que viene después.
    if (tok.kind === "word" && tok.hadColon) {
      const next = tokens[idx + 1];
      pendingName = next && next.kind === "num" ? [tok.raw] : [];
      continue;
    }

    if (tok.kind === "num") {
      const amount = parseDigitAmount(tok.raw);
      if (!Number.isFinite(amount) || amount <= 0) continue;
      if (pendingName.length > 0) {
        const name = pendingName.join(" ");
        pendingName = [];
        if (esNombreValido(name)) {
          items.push({ name, amount });
          continue;
        }
        // Nombre inválido (agregado/etiqueta/conector): se descarta y el
        // monto queda disponible para la palabra siguiente.
      }
      pendingAmount = amount;
    } else {
      if (pendingAmount !== undefined) {
        if (esNombreValido(tok.raw)) {
          items.push({ name: tok.raw, amount: pendingAmount });
          pendingAmount = undefined;
          continue;
        }
        // Palabra inválida como nombre único: se ignora, el monto sigue pendiente.
        continue;
      }
      pendingName.push(tok.raw);
    }
  }
  return items;
}

export interface ItemSospechoso {
  name: string;
  amount: number;
  sugerencia: string;
}

/** Mediana de una lista de montos. */
function mediana(valores: number[]): number {
  const s = [...valores].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 === 0 ? (s[mid - 1] + s[mid]) / 2 : s[mid];
}

/**
 * PIEZA 3 — detección de ítem sospechoso por MAGNITUD (complementaria a la
 * estructural de `resolverPegado`): un ítem es sospechoso si su importe
 * supera el agregado declarado, o si supera 10× la mediana de los DEMÁS
 * ítems (con ≥3 ítems en la lista — con menos no hay base estadística).
 */
// PIEZA 3 — CALIBRACIÓN (revisión adversarial AG01, 2026-08-06): el umbral
// literal "10 × mediana" marca en falso una hipoteca de 1.200 € entre gastos
// de 40-60 € (mediana ≈47,5 → 10× = 475 → 1200 > 475, falso positivo). Medido
// contra los dos casos reales:
//   hipoteca 1200 / mediana 47.5 ≈ 25× (NO debe marcarse)
//   60100 (pegado real, testdev7) / mediana ~90 ≈ 668× (SÍ debe marcarse)
// 50× deja margen amplio a ambos lados sin necesitar el agregado como
// condición. Con agregado conocido, se añade además un suelo absoluto: un
// ítem por debajo de 3× el agregado total es un gasto grande PLAUSIBLE
// (vivienda, no un error de tecleo) y no se marca aunque supere la mediana.
const UMBRAL_MEDIANA_MULTIPLICADOR = 50;
const SUELO_AGREGADO_MULTIPLICADOR = 3;

export function detectarItemSospechosoPorMagnitud(
  items: ExpenseItem[],
  agregado?: number,
): ItemSospechoso | null {
  if (agregado !== undefined) {
    const excedeAgregado = items.find((i) => i.amount > agregado);
    if (excedeAgregado) {
      return {
        name: excedeAgregado.name,
        amount: excedeAgregado.amount,
        sugerencia: `${excedeAgregado.name} (${excedeAgregado.amount}) supera el total declarado (${agregado}) — ¿es una cifra junta que debería separarse?`,
      };
    }
  }
  if (items.length >= 3) {
    for (const item of items) {
      const otros = items.filter((i) => i !== item).map((i) => i.amount);
      const med = mediana(otros);
      if (med <= 0 || item.amount <= med * UMBRAL_MEDIANA_MULTIPLICADOR) continue;
      if (agregado !== undefined && item.amount < agregado * SUELO_AGREGADO_MULTIPLICADOR) continue;
      return {
        name: item.name,
        amount: item.amount,
        sugerencia: `${item.name} (${item.amount}) es muy superior al resto de partidas (mediana ${med}) — ¿son dos cifras pegadas?`,
      };
    }
  }
  return null;
}

export interface ParseExpenseListResult {
  items: ExpenseItem[];
  itemSospechoso: ItemSospechoso | null;
}

/**
 * PIEZA 4 — LÍMITES PRIMERO, NÚMEROS DESPUÉS: segmenta el mensaje en partidas
 * (comas, saltos, fin de frase) ANTES de tocar un solo dígito. Cada partida se
 * tokeniza por espacios (nunca por el regex de miles-con-espacio del parser
 * general — así el espacio no puede cruzar el límite entre dos partidas),
 * resuelve el pegado estructural (`resolverPegado`) y empareja nombre↔monto
 * (`emparejarNombreMonto`). El sospechoso ESTRUCTURAL (pegado) tiene prioridad
 * sobre el de MAGNITUD; si no hay ninguno estructural, se corre el de
 * magnitud sobre el total de ítems ya reunidos.
 */
export function parseExpenseListDetallado(message: string, agregado?: number): ParseExpenseListResult {
  const segmentos = message.split(/[,\n]|(?<=[.!?])\s+/);
  const items: ExpenseItem[] = [];
  let sospechosoEstructural: ItemSospechoso | null = null;

  for (const seg of segmentos) {
    const tokens = tokenizeSegment(seg);
    if (tokens.length === 0) continue;
    const { tokens: resueltos, pares } = resolverPegado(tokens);
    const itemsSegmento = emparejarNombreMonto(resueltos);
    items.push(...itemsSegmento);
    if (!sospechosoEstructural && pares.length > 0) {
      const [a, b] = pares[0];
      const glued = parseDigitAmount(`${a.raw} ${b.raw}`);
      // El nombre expuesto es el de la partida que reclamó el SEGUNDO número
      // (el que se quedó sin separador claro) — mejor esfuerzo a partir de lo
      // ya emparejado en este segmento.
      const amountB = parseDigitAmount(b.raw);
      const itemAsociado = itemsSegmento.find((i) => i.amount === amountB);
      sospechosoEstructural = {
        name: itemAsociado?.name ?? "?",
        amount: glued,
        sugerencia: `"${a.raw} ${b.raw}" — ¿son dos partidas separadas (${a.raw} y ${b.raw}) o una sola cifra (${glued})?`,
      };
    }
  }

  if (items.length < 2) return { items: [], itemSospechoso: null };
  const itemSospechoso = sospechosoEstructural ?? detectarItemSospechosoPorMagnitud(items, agregado);
  return { items, itemSospechoso };
}

/**
 * Extrae una lista de gastos del mensaje ("netflix 100, luz 50, …" en
 * cualquiera de las formas soportadas: con comas, sin comas, con dos puntos,
 * nombre-monto o monto-nombre). Devuelve [] si hay menos de 2 pares.
 *
 * Compartido por el orquestador (clasificador) y el scenario (para no machacar el
 * gasto agregado con el primer ítem de la lista — defecto B).
 */
export function parseExpenseList(message: string): ExpenseItem[] {
  return parseExpenseListDetallado(message).items;
}
