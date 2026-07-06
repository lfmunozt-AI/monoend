// Núcleo de parsing numérico del guardarraíl (compartido por las piezas 1 y 2).
//
// Todo es código PURO (regex + lógica), edge-safe, SIN llamadas a ningún LLM.
// Convención de formato: es/LatAm — el punto es separador de miles y la coma es
// el separador decimal:  "1.200,50" → 1200.5 ; "1.200" → 1200 ; "40000" → 40000.
// Los límites de esta convención están documentados en docs/GUARDRAIL.md.

/** Una mención numérica localizada en el texto, con su posición original. */
export interface NumberMention {
  /** Valor numérico ya normalizado. */
  value: number;
  /** Texto exacto que la originó (para poder reescribir/loguear). */
  text: string;
  /** Índice de inicio en la cadena original. */
  start: number;
  /** Índice de fin (exclusivo) en la cadena original. */
  end: number;
  /** Cómo se detectó: dígitos o palabras en español. */
  kind: "digit" | "word";
}

// ── Dígitos ──────────────────────────────────────────────────────────────────
// Grupo 1 (el número), tres alternativas:
//   a) miles con punto (1.200, 1.200.000) y coma decimal opcional (1.200,50).
//   b) miles con ESPACIO (2 500, 1 200 000) y coma decimal opcional.
//   c) dígitos llanos con coma decimal opcional (40000, 2000,50).
// Grupo 2 (opcional): sufijo "k"/"K" → ×1000 ("2,5k" = 2500). El sufijo solo se
// consume si NO va seguido de otra letra, para no comerse "2kg".
// Los lookarounds evitan enganchar trozos de un número más largo. La alternativa
// de espacio exige grupos de EXACTAMENTE 3 dígitos, así "2 500" se une pero
// "2500 500" (ya de 4 dígitos) o "2 cosas" no.
const DIGIT_RE =
  /(?<!\d)(\d{1,3}(?:\.\d{3})+(?:,\d+)?|\d{1,3}(?: \d{3})+(?:,\d+)?|\d+(?:,\d+)?)(k(?![\p{L}]))?(?!\d)/giu;

/**
 * Parsea un literal de dígitos en convención es/LatAm a número.
 * El espacio es separador de miles (se elimina), igual que el punto; la coma es
 * el decimal. El sufijo "k" NO llega aquí (lo aplica `findNumberMentions`).
 */
export function parseDigitAmount(raw: string): number {
  const noSpaces = raw.replace(/\s/g, "");
  // Si tiene punto, es separador de miles → se elimina. La coma es decimal.
  const normalized = noSpaces.includes(".")
    ? noSpaces.replace(/\./g, "").replace(",", ".")
    : noSpaces.replace(",", ".");
  return Number.parseFloat(normalized);
}

// ── Palabras en español ────────────────────────────────────────────────────────
// Mapas normalizados (sin acentos, minúsculas). Cubren el rango habitual hasta
// miles de millones; los compuestos raros se documentan como límite conocido.
const UNITS: Record<string, number> = {
  cero: 0, un: 1, uno: 1, una: 1, dos: 2, tres: 3, cuatro: 4, cinco: 5, seis: 6,
  siete: 7, ocho: 8, nueve: 9, diez: 10, once: 11, doce: 12, trece: 13,
  catorce: 14, quince: 15, dieciseis: 16, diecisiete: 17, dieciocho: 18,
  diecinueve: 19, veinte: 20, veintiuno: 21, veintiun: 21, veintiuna: 21,
  veintidos: 22, veintitres: 23, veinticuatro: 24, veinticinco: 25,
  veintiseis: 26, veintisiete: 27, veintiocho: 28, veintinueve: 29, treinta: 30,
  cuarenta: 40, cincuenta: 50, sesenta: 60, setenta: 70, ochenta: 80, noventa: 90,
};
const HUNDREDS: Record<string, number> = {
  cien: 100, ciento: 100, doscientos: 200, doscientas: 200, trescientos: 300,
  trescientas: 300, cuatrocientos: 400, cuatrocientas: 400, quinientos: 500,
  quinientas: 500, seiscientos: 600, seiscientas: 600, setecientos: 700,
  setecientas: 700, ochocientos: 800, ochocientas: 800, novecientos: 900,
  novecientas: 900,
};
const THOUSAND = new Set(["mil"]);
const MILLION = new Set(["millon", "millones"]);
const BILLION = new Set(["millardo", "millardos"]);
const CONNECTOR = new Set(["y"]);

// "un/uno/una" en solitario casi siempre es artículo ("una deuda"), no la cifra 1.
const ARTICLE_ONLY = new Set(["un", "uno", "una"]);

/** Quita acentos para poder casar "millón"/"dieciséis" contra los mapas. */
function stripAccents(s: string): string {
  return s.normalize("NFD").replace(/[\u0300-\u036f]/g, "");
}

function isNumberWord(token: string): boolean {
  return (
    token in UNITS ||
    token in HUNDREDS ||
    THOUSAND.has(token) ||
    MILLION.has(token) ||
    BILLION.has(token) ||
    CONNECTOR.has(token)
  );
}

/**
 * Combina una secuencia de palabras-número en su valor.
 * Algoritmo aditivo/multiplicativo estándar: "cien mil"→100000,
 * "dos mil"→2000, "ciento veinte"→120, "un millón doscientos mil"→1200000.
 */
function combineWords(tokens: string[]): number {
  let total = 0;
  let current = 0;
  for (const t of tokens) {
    if (CONNECTOR.has(t)) continue;
    if (t in UNITS) current += UNITS[t];
    else if (t in HUNDREDS) current += HUNDREDS[t];
    else if (THOUSAND.has(t)) {
      total += (current === 0 ? 1 : current) * 1000;
      current = 0;
    } else if (MILLION.has(t)) {
      total += (current === 0 ? 1 : current) * 1_000_000;
      current = 0;
    } else if (BILLION.has(t)) {
      total += (current === 0 ? 1 : current) * 1_000_000_000;
      current = 0;
    }
  }
  return total + current;
}

// ── Extracción combinada con posiciones ──────────────────────────────────────
const WORD_RE = /[\p{L}]+/gu;

/**
 * Localiza todas las menciones numéricas (dígitos y palabras) de un texto,
 * con su posición. Es la primitiva común de extracción del guardarraíl.
 */
export function findNumberMentions(text: string): NumberMention[] {
  const mentions: NumberMention[] = [];

  // 1) Dígitos. m[1] = el número; m[2] = sufijo "k" opcional (×1000).
  for (const m of text.matchAll(DIGIT_RE)) {
    const raw = m[0];
    const numero = m[1];
    const tieneK = Boolean(m[2]);
    const start = m.index ?? 0;
    mentions.push({
      value: parseDigitAmount(numero) * (tieneK ? 1000 : 1),
      text: raw,
      start,
      end: start + raw.length,
      kind: "digit",
    });
  }

  // 2) Palabras: agrupamos tokens-número contiguos (admitiendo el conector "y").
  const tokens: { word: string; start: number; end: number }[] = [];
  for (const m of text.matchAll(WORD_RE)) {
    const start = m.index ?? 0;
    tokens.push({
      word: stripAccents(m[0].toLowerCase()),
      start,
      end: start + m[0].length,
    });
  }

  let run: { word: string; start: number; end: number }[] = [];
  const flush = () => {
    if (run.length === 0) return;
    // Recorta conectores "y" en los bordes para que no inflen el span.
    while (run.length && CONNECTOR.has(run[0].word)) run.shift();
    while (run.length && CONNECTOR.has(run[run.length - 1].word)) run.pop();
    const words = run.map((r) => r.word);
    const onlyArticle = words.every((w) => ARTICLE_ONLY.has(w));
    const onlyConnector = words.every((w) => CONNECTOR.has(w));
    if (run.length && !onlyArticle && !onlyConnector) {
      mentions.push({
        value: combineWords(words),
        text: text.slice(run[0].start, run[run.length - 1].end),
        start: run[0].start,
        end: run[run.length - 1].end,
        kind: "word",
      });
    }
    run = [];
  };

  for (const tk of tokens) {
    if (isNumberWord(tk.word)) run.push(tk);
    else flush();
  }
  flush();

  // Orden por posición; el llamante decide cómo deduplicar solapes.
  return mentions.sort((a, b) => a.start - b.start);
}

/**
 * Cuando dos menciones se solapan (típicamente una en palabras y otra en
 * dígitos sobre el mismo trozo), conserva la de mayor cobertura (span más
 * ancho). Evita contar dos veces la misma cifra.
 */
export function dedupeOverlaps(mentions: NumberMention[]): NumberMention[] {
  const kept: NumberMention[] = [];
  for (const m of mentions) {
    const overlap = kept.find((k) => m.start < k.end && k.start < m.end);
    if (!overlap) {
      kept.push(m);
      continue;
    }
    if (m.end - m.start > overlap.end - overlap.start) {
      kept[kept.indexOf(overlap)] = m;
    }
  }
  return kept;
}
