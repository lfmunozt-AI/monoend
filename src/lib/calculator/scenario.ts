// SCENARIO STATE — el motor recuerda entre turnos.
//
// Causa raíz (QA): el motor era stateless (solo veía el último mensaje), así que
// "el banco me ofrece un 9%" no recalculaba nada — no había crédito en contexto
// que actualizar. Este módulo acumula el escenario financiero del diálogo y se
// persiste en conversations.scenario_state (migración 010).
//
// Extracción CONSERVADORA: solo señales de alta confianza. Lo ambiguo NO se
// extrae — mejor no tocar el estado que corromperlo. Código PURO, edge-safe.

import { parseDigitAmount, findNumberMentions, dedupeOverlaps, type NumberMention } from "../guardrail/numbers";
import { parseExpenseList, parseExpenseListDetallado, classifyExpenses, classifyExpense, type ItemSospechoso } from "./expenses";
import type { Language } from "../language";
import { tieneSenalFinanciera, type Carril } from "../guardrail/turn-classifier";

export interface GastosDetalle {
  vitales: number;
  noVitales: number;
  desconocidos: number;
}

/**
 * PIEZA 5 (8ª tanda) — evidencia INDIVIDUAL de cada partida de gasto, para no
 * perder la trazabilidad que `gastos_detalle` (solo totales por grupo) no
 * conserva. Se AÑADE, no sustituye: `gastos_detalle` sigue existiendo con la
 * misma forma porque el orquestador y la calculadora lo consumen tal cual.
 * Flujo correcto: items → clasificación → buckets (nunca al revés).
 */
export interface GastoItemEntry {
  name: string;
  amount: number;
  category: "vital" | "no_vital" | "desconocido";
  /** De dónde vino este ítem este turno: regex determinista o tool_call del LLM. */
  source: "regex" | "tool";
  /** Turno (1-indexado) en el que se aportó, para poder auditar cuándo se dijo qué. */
  turn: number;
}

/**
 * PIEZA 1 (8ª tanda) — honestidad del extractor sobre su propia confianza.
 * NUNCA degrada globalmente: la afectación es SIEMPRE por campo (ver
 * `notaExtraccionAmbigua`/`deltaSinGastosPorDiscrepancia` — huérfanos y
 * discrepancias ya solo tocan el campo implicado, no el turno entero).
 *   COMPLETE   — todo número relevante quedó asignado, 0 huérfanos relevantes.
 *   PARTIAL    — hay campos extraídos con confianza Y huérfanos relevantes sin
 *                asignar. Los campos extraídos SÍ se usan (V1); se pregunta
 *                por los huérfanos citándolos.
 *   AMBIGUOUS  — un número podría ir a ≥2 campos, o hay un ítem sospechoso de
 *                pegado. El campo afectado no se cierra sin confirmar — pero
 *                en una lista de gastos, con una lectura estructural
 *                plausible, el ítem SÍ se usa (mismo principio V1, aplicado a
 *                nivel de partida): el eco solo pregunta.
 *   INVALID    — valor imposible (cero de placeholder, negativo). Ese campo
 *                queda MISSING y se pregunta.
 */
export type ExtractionStatus = "COMPLETE" | "PARTIAL" | "AMBIGUOUS" | "INVALID";

/** PIEZA 6 (8ª tanda) — confianza por campo. Ver `actualizarFactStatus`. */
export type FactStatus = "MISSING" | "PARSED" | "CONFIRMED";

export interface CreditoState {
  /**
   * FIX 1 (7ª tanda, testdev6) — CERO NO ES UN VALOR. `monto`/`plazo_meses`
   * eran `number` obligatorios, así que un crédito parcial (solo TAE, o solo
   * monto) se rellenaba con `0` de PLACEHOLDER para satisfacer el tipo. Ese
   * 0 no es "desconocido": es un valor FALSO que se colaba como si fuera
   * real — `buildScenarioContext` exigía `plazo_meses > 0` para exponer
   * siquiera el monto, así que un crédito con monto real pero plazo aún sin
   * declarar dejaba el monto invisible para el guardarraíl (bloqueo circular:
   * se borraba la propia pregunta que iba a conseguir el plazo). Ahora
   * ausente es `undefined`, nunca `0`.
   */
  monto?: number;
  plazo_meses?: number;
  /** TAE en %. Si `tae_es_referencia`, es el 7% supuesto, no el del usuario. */
  tae_pct?: number;
  tae_es_referencia: boolean;
  /** Objeto de compra detectado en el mensaje que creó el crédito ("carro", "casa"…). */
  objeto?: string;
}

export interface MetaState {
  titulo?: string;
  monto?: number;
  plazo_meses?: number;
}

// FIX C — anti-repetición: distancia de Levenshtein normalizada. Suficiente
// para textos del tamaño de una respuesta del chat (unos pocos cientos de
// caracteres) — el bug real eran 5 turnos con la respuesta prácticamente
// calcada, no una coincidencia parcial que exija algo más sofisticado.
function levenshtein(a: string, b: string): number {
  const m = a.length;
  const n = b.length;
  const dp: number[] = new Array(n + 1);
  for (let j = 0; j <= n; j++) dp[j] = j;
  for (let i = 1; i <= m; i++) {
    let prev = dp[0];
    dp[0] = i;
    for (let j = 1; j <= n; j++) {
      const tmp = dp[j];
      dp[j] = a[i - 1] === b[j - 1] ? prev : 1 + Math.min(prev, dp[j], dp[j - 1]);
      prev = tmp;
    }
  }
  return dp[n];
}

/** Similitud aproximada entre dos textos, 0 (nada en común) a 1 (idénticos). */
export function similitudTexto(a: string, b: string): number {
  const s1 = a.trim().toLowerCase();
  const s2 = b.trim().toLowerCase();
  if (s1 === s2) return 1;
  if (!s1.length || !s2.length) return 0;
  return 1 - levenshtein(s1, s2) / Math.max(s1.length, s2.length);
}

/**
 * ¿`actual` repite casi literalmente la respuesta ANTERIOR del asistente en la
 * misma conversación? QA real: el modelo prometía "¿quieres que te proyecte el
 * plan?" cinco turnos seguidos, prácticamente palabra por palabra. Umbral por
 * defecto 90% — texto distinto con la misma ESTRUCTURA (cifras que cambian de
 * un turno a otro) no cuenta como repetición.
 */
export function esRespuestaRepetida(actual: string, anterior: string | undefined, umbral = 0.9): boolean {
  if (!anterior) return false;
  return similitudTexto(actual, anterior) >= umbral;
}

/**
 * FIX C (QA real: 5 turnos idénticos) — la última respuesta cerró proponiendo
 * un plan concreto ("¿quieres que te proyecte el plan?", "¿Confirmamos?"). Se
 * recuerda para que una confirmación corta del usuario ("sí") dispare la
 * EJECUCIÓN (PB7) en vez de que el modelo vuelva a diagnosticar desde cero.
 */
export interface PropuestaPendiente {
  /** Clasificación gruesa de la propuesta ("credito" | "meta" | "general"). */
  tipo: string;
  /** El cierre propuesto, tal cual se le mostró al usuario (para dar contexto). */
  resumen: string;
}

export interface ScenarioState {
  ingreso_mensual?: number;
  gastos_mensuales?: number;
  gastos_detalle?: GastosDetalle;
  /** true si `gastos_detalle` vino de una lista desglosada (defecto B). */
  gastos_es_detalle?: boolean;
  credito?: CreditoState;
  meta?: MetaState;
  /**
   * true si `meta` la puso el motor (derivada del crédito), no el usuario. Una
   * meta EXPLÍCITA del usuario siempre pisa la derivada y apaga este flag para
   * siempre: una vez el usuario habla, el motor deja de inventar.
   */
  meta_derivada?: boolean;
  /** FIX C — propuesta de plan aún sin confirmar por el usuario. */
  propuesta_pendiente?: PropuestaPendiente;
  /** FIX C — el usuario confirmó: PB7 debe ENTREGAR el plan, no re-diagnosticar. */
  plan_confirmado?: boolean;
  /**
   * PIEZA 6 — la meta activa se CERRÓ (el usuario confirmó el plan). Solo con
   * la meta cerrada puede iniciarse otra sin petición explícita.
   */
  meta_cerrada?: boolean;
  /**
   * PIEZA 6 — metas anteriores. Al abrir una meta nueva la anterior se ARCHIVA
   * aquí; nunca se borra.
   */
  goals_cerradas?: MetaState[];
  /**
   * PIEZA 6 — señal DEL TURNO (no se persiste): el usuario pidió explícitamente
   * cambiar, olvidar o sustituir la meta. Sin esta señal, ningún mensaje
   * ambiguo puede sobrescribir la meta activa.
   */
  meta_cambio_explicito?: boolean;
  /**
   * PIEZA 7 — turnos META consecutivos habiendo meta activa. Al llegar al
   * umbral se inyecta una nota de reconducción en el system prompt; cualquier
   * turno FINANCIERO lo reinicia. Nunca se corta al usuario en seco.
   */
  digresiones_seguidas?: number;
  /**
   * PIEZA 7 (6ª tanda) — ¿hay un agregado de gastos conocido? Derivado de
   * `gastos_mensuales !== undefined`, expuesto explícito para que el prompt no
   * tenga que inferirlo. El agregado BASTA para sobrante/capacidad/brecha —
   * nunca se vuelve a pedir el total si esto es true.
   */
  tiene_agregado_gastos?: boolean;
  /**
   * PIEZA 7 (6ª tanda) — ¿hay un desglose por partida conocido? Derivado de
   * `gastos_detalle !== undefined`. Solo hace falta para proponer un plan de
   * RECORTE (qué partida bajar y cuánto) — nunca para calcular viabilidad.
   */
  tiene_detalle_gastos?: boolean;
  /**
   * PIEZA 5 (8ª tanda) — evidencia acumulada de cada partida de gasto vista en
   * cualquier turno (se ACUMULA, nunca se pisa). `gastos_detalle` (buckets)
   * sigue siendo lo que consume el orquestador; esto es la traza de origen.
   */
  gastos_items?: GastoItemEntry[];
  /** PIEZA 1 (8ª tanda) — honestidad del último turno de extracción. No degrada nada por sí solo. */
  extraction_status?: ExtractionStatus;
  /** PIEZA 6 (8ª tanda) — confianza por campo (ver `FactStatus`). */
  factStatus?: Record<string, FactStatus>;
  /**
   * PIEZA 6 (8ª tanda) — campos que el ECO de este turno enunció, para que el
   * merge del turno SIGUIENTE sepa qué promover a CONFIRMED si el usuario no
   * lo corrige.
   */
  eco_pendiente?: { fields: string[] };
  /** Qué falta para completar el playbook activo. Recalculado en cada merge. */
  missing: string[];
}

// ── Normalización ────────────────────────────────────────────────────────────
function norm(s: string): string {
  return s.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase();
}

// ── Patrones de extracción (alta confianza) ──────────────────────────────────

// Tasa: un porcentaje en CONTEXTO de tipo de interés / oferta bancaria.
const RATE_CONTEXT = /(tae|tasa|tipo|juros|interes|interest|apr|banco|ofrec|oferec|offer)/;
const PERCENT = /(\d[\d.,]*)\s*%/;

// El mensaje ENTERO es esencialmente un porcentaje (respuesta directa a la
// pregunta por la tasa). Cubre "18%", "es un 9", "de 9%", "9 por ciento",
// "9 percent", "it's 9". Anclado a ^…$ para exigir que no haya otras señales.
const BARE_RATE =
  /^\s*(?:es\s+un\s+|es\s+|un\s+|de\s+|it'?s\s+|the\s+rate\s+is\s+)?(\d[\d.,]*)\s*(?:%|por\s*ciento|por\s*cento|percent)?\s*\.?\s*$/i;

// Plazo en meses o años.
const PLAZO = /(\d[\d.,]*)\s*(a[ñn]os?|anos?|years?|meses|mes|months?)\b/;

// Monto con contexto de ingreso / gasto / precio.
const INGRESO_CTX = /\b(gano|ingreso|ingresos|sueldo|salario|cobro|rendimento|income|earn|salary)\b/;
const GASTO_CTX = /\b(gasto|gastos|gasta|despesas?|spend|expenses?)\b/;
// PIEZA 2 — total agregado seguido de ":" y un desglose ("gasto 1000: 500
// arriendo..."). El ":" es el marcador INEQUÍVOCO que distingue "aquí va un
// total, y luego el detalle" de "gasto= 1000 arriendo..." (sin ":", que es
// directamente el primer ítem del detalle, sin agregado propio — caso A).
const GASTO_AGREGADO_DETALLE_RE = /\b(?:gastos?|despesas?|expenses?)\b\s*[:=]?\s*(\d[\d.,]*)\s*:/;
const PRECIO_CTX = /\b(precio|cuesta|vale|financiar|credito|prestamo|emprestimo|loan|financ|carro|coche|auto|casa|piso|vivienda)\b/;
// PIEZA 3 (8ª tanda) — misma convención de miles-con-espacio que el parser
// general (`guardrail/numbers.ts`, DIGIT_RE): "2 500" es 2500, no "2" seguido
// de un huérfano "500" (caso 10 — NO se toca la regla general, solo se hace
// que esta cifra la use también). La alternativa de espacio va PRIMERO
// (probada antes que el dígito llano) y exige grupos de EXACTAMENTE 3 dígitos.
const AMOUNT = /(\d{1,3}(?: \d{3})+(?:,\d+)?|\d[\d.,]*)/;

// PIEZA 1 (5ª tanda) — MARCADOR ANUAL. "gano 27600 al año" NO es "gano 27600
// al mes": asumir mensual sin más es exactamente el tipo de suposición que el
// principio nuevo prohíbe ("ante ambigüedad se PREGUNTA, nunca se asume"). Si
// el número que INGRESO_CTX/GASTO_CTX capturarían trae este marcador
// PEGADO detrás, NO se asigna — queda sin asignar, y el detector de huérfanos
// (más abajo) lo atrapa para que el sistema pregunte en vez de dividir por 12
// en silencio.
const MARCADOR_ANUAL_RE =
  /^\s*(?:€\s*)?(?:al\s+a[ñn]o|anual(?:es)?|por\s+a[ñn]o|\/\s*a[ñn]o|per\s+year|\/\s*year|annually|yearly|ao\s+ano|por\s+ano|\/\s*ano)\b/;

/** ¿El número que empieza en `desdeIdx` (dentro de `n`) trae un marcador anual pegado? */
function esCifraAnual(n: string, ctxRe: RegExp, matchAmount: RegExpExecArray): boolean {
  const base = n.search(ctxRe);
  const after = n.slice(base + matchAmount.index + matchAmount[0].length, base + matchAmount.index + matchAmount[0].length + 20);
  return MARCADOR_ANUAL_RE.test(after);
}

// PIEZA 1 (6ª tanda) — RANGO. "gano entre 2000 y 2500" no tiene una cifra:
// tiene DOS candidatas. Elegir la primera que capture AMOUNT (2000) es
// justamente la suposición de baja confianza que el principio prohíbe — así
// se originó el bug de la tanda anterior (un campo "confiado" que en
// realidad era una adivinanza). Si el número capturado trae pegado un
// conector de rango ("y"/"a"/"o"/"-"/"hasta") seguido de OTRO número, NINGUNO
// de los dos se asigna: ambos quedan como huérfanos genuinos para que el
// detector (más abajo) pida cuál es el correcto.
const RANGO_AFTER_RE = /^\s*(?:-|y|o|a|to|or|hasta)\s*\d/;
// PIEZA 1 (8ª tanda) — caso 12: "gasto 2200 y 450" NO es un rango — es un
// agregado limpio (2200) seguido de un número suelto (450, huérfano
// genuino). Sin este marcador de apertura, CUALQUIER "número CONECTOR
// número" tras la keyword se leía como rango y descartaba AMBOS valores —
// incluido el agregado, que sí se sabe con confianza. Un rango real siempre
// se ABRE con "entre"/"desde"/"between" ("gano ENTRE 2000 y 2500"); sin esa
// apertura, la "y"/"o" que sigue es solo el resto de la frase.
const RANGO_ABRE_RE = /\b(?:entre|desde|between|from)\s*$/i;

/** ¿El número capturado es la primera mitad de un rango ("entre X y/a/o/- Y")? */
function esRango(n: string, ctxRe: RegExp, matchAmount: RegExpExecArray): boolean {
  const base = n.search(ctxRe);
  const matchStart = base + matchAmount.index;
  const after = n.slice(matchStart + matchAmount[0].length, matchStart + matchAmount[0].length + 20);
  const before = n.slice(Math.max(0, matchStart - 15), matchStart);
  return RANGO_AFTER_RE.test(after) && RANGO_ABRE_RE.test(before);
}

// Meta.
const META_CTX = /\b(meta|objetivo|quiero (?:comprar|llegar|ahorrar)|goal|target|juntar|reunir)\b/;

// PIEZA 6 — PETICIÓN EXPLÍCITA de cambio de meta. Solo estas formas autorizan
// tocar la meta activa: "cambia la meta", "olvida el carro", "ahora quiero una
// casa". Una mención ambigua de otro objetivo NUNCA la sobrescribe.
const CAMBIO_META_EXPLICITO = new RegExp(
  "(" +
    // ES
    "cambia(?:r|me)?\\s+(?:la|mi|de)\\s+(?:meta|objetivo)|cambiar\\s+de\\s+(?:meta|objetivo)|" +
    "quiero\\s+cambiar\\s+(?:la|mi|de)\\s+(?:meta|objetivo)|olvida(?:te)?\\s+(?:el|la|lo|los|las|mi)\\b|" +
    "olvidemos|descarta\\s+(?:el|la|lo|mi)\\b|ya\\s+no\\s+quiero|ahora\\s+quiero|nueva\\s+meta|otra\\s+meta|mejor\\s+quiero|" +
    // PT
    "muda(?:r)?\\s+(?:a|de)\\s+(?:meta|objetivo)|esquece\\s+(?:o|a)\\b|ja\\s+nao\\s+quero|agora\\s+quero|nova\\s+meta|" +
    // EN
    "change\\s+(?:my|the)\\s+goal|forget\\s+(?:the|my)\\b|new\\s+goal|another\\s+goal|instead\\s+i\\s+want|i\\s+want\\s+to\\s+change" +
  ")",
);

/** ¿El usuario PIDE explícitamente cambiar/olvidar la meta activa? (PIEZA 6) */
export function pideCambioDeMeta(message: string): boolean {
  return CAMBIO_META_EXPLICITO.test(norm(message));
}

// Objeto de compra de un crédito (BUG 3): qué se está financiando. Se captura
// SOLO en el mensaje que crea el crédito (monto+plazo) para poder derivar una
// meta con título con sentido ("carro de 30000" → meta "carro") en vez de
// preguntar por una meta que el usuario ya dio, solo que sin la palabra "meta".
const OBJETO_CREDITO =
  /\b(carro|coche|auto|vehiculo|moto|casa|piso|apartamento|viatura|car|house|apartment|vehicle)\b/;

// FIX C — confirmación CORTA del usuario tras una propuesta ("sí", "ok",
// "dale", "arrancamos", "sim", "yes"…). Anclada a ^…$ (con puntuación/énfasis
// tolerado): un "sí" perdido dentro de una frase larga NO cuenta — el usuario
// tiene que estar respondiendo A la propuesta, no mencionando la palabra.
const CONFIRMACION_CORTA_RE =
  /^(si|s[ií]+|ok(?:ay)?|vale|dale|arrancamos|arranquemos|vamos|adelante|hagamoslo|confirmado|de acuerdo|sim|isso|vamos la|yes|yep|yeah|sure|deal|let'?s go|go ahead|sounds good)[!.\s]*$/;

/** ¿Es `message` una confirmación corta ("sí", "dale", "yes"…)? */
export function esConfirmacionCorta(message: string): boolean {
  return CONFIRMACION_CORTA_RE.test(norm(message).trim());
}

/** Convierte un plazo a meses. "3 años" → 36; "36 meses" → 36. */
function toMonths(value: number, unit: string): number {
  const u = norm(unit);
  if (/^(a[ñn]os?|anos?|years?)$/.test(u)) return Math.round(value * 12);
  return Math.round(value);
}

/**
 * PIEZA 5 (8ª tanda) — envuelve ítems ya parseados (por regex o por la tool
 * del LLM) como `GastoItemEntry` para este turno. `turn` queda en 0: es un
 * placeholder que `mergeScenario` SIEMPRE reescribe al acumular (necesita ver
 * el historial previo para saber qué turno toca).
 */
function itemsAGastoItemEntries(
  items: Array<{ name: string; amount: number }>,
  source: "regex" | "tool",
): GastoItemEntry[] {
  return items.map((i) => ({ name: i.name, amount: i.amount, category: classifyExpense(i.name), source, turn: 0 }));
}

/**
 * Extrae SOLO señales de alta confianza del mensaje. Devuelve un delta parcial;
 * lo ambiguo se omite. `lang` se acepta para futura afinación por idioma (hoy los
 * patrones ya cubren ES/PT/EN).
 */
export function extractScenarioDelta(
  message: string,
  lang: Language = "es",
  prev?: Partial<ScenarioState>,
): Partial<ScenarioState> {
  void lang; // los patrones ya cubren ES/PT/EN; el idioma queda para afinar a futuro
  const delta: Partial<ScenarioState> = {};
  const n = norm(message);

  // Defecto B: si el mensaje es una LISTA de gastos, se trata aparte — NUNCA se
  // deja que la extracción por keyword tome un ítem individual (netflix 15) como
  // el gasto mensual agregado.
  const listItems = parseExpenseList(message);
  const esLista = listItems.length >= 2;

  // ── Tasa real (TAE) — porcentaje en contexto de interés/banco ─────────────
  if (RATE_CONTEXT.test(n)) {
    const p = PERCENT.exec(n);
    if (p) {
      const tae = parseDigitAmount(p[1]);
      if (Number.isFinite(tae) && tae > 0 && tae < 100) {
        delta.credito = { tae_pct: tae, tae_es_referencia: false };
      }
    }
  }

  // FIX 2 — respuesta CORTA de TAE. Si ya hay un crédito en el estado y el
  // mensaje es esencialmente un porcentaje ("18%", "es un 9", "9 por ciento",
  // "9 percent") sin otras señales → es la respuesta a "¿cuál es esa tasa?".
  if (!delta.credito?.tae_pct && prev?.credito) {
    const m = BARE_RATE.exec(n);
    if (m) {
      const tae = parseDigitAmount(m[1]);
      if (Number.isFinite(tae) && tae > 0 && tae < 100) {
        delta.credito = { tae_pct: tae, tae_es_referencia: false };
      }
    }
  }

  // ── Crédito: monto + plazo ANCLADOS al contexto del crédito (defecto A) ────
  // El monto se busca DESDE la keyword de crédito/compra, no como primer número
  // global: en "gano 2500 ... carro de 30000 a 36 meses" el monto es 30000.
  if (PRECIO_CTX.test(n)) {
    const desdeCredito = n.slice(n.search(PRECIO_CTX)).replace(PLAZO, " ");
    const plazo = PLAZO.exec(n);
    const amount = AMOUNT.exec(desdeCredito);
    if (plazo && amount) {
      const meses = toMonths(parseDigitAmount(plazo[1]), plazo[2]);
      const monto = parseDigitAmount(amount[1]);
      if (Number.isFinite(monto) && monto > 0 && meses > 0) {
        const objetoMatch = OBJETO_CREDITO.exec(n);
        delta.credito = {
          ...(delta.credito ?? { tae_es_referencia: true }),
          monto,
          plazo_meses: meses,
          ...(objetoMatch ? { objeto: objetoMatch[1] } : {}),
        };
      }
    }
  }

  // ── Ingreso — anclado a su keyword ─────────────────────────────────────────
  if (INGRESO_CTX.test(n)) {
    const a = AMOUNT.exec(n.slice(n.search(INGRESO_CTX)));
    // PIEZA 1 — "27600 al año" NO se asigna como si fuera mensual: el número
    // queda huérfano a propósito (ver MARCADOR_ANUAL_RE arriba). "entre 2000 y
    // 2500" tampoco se asigna: es un rango, no una cifra (ver esRango arriba).
    if (a && !esCifraAnual(n, INGRESO_CTX, a) && !esRango(n, INGRESO_CTX, a)) {
      const v = parseDigitAmount(a[1]);
      if (Number.isFinite(v) && v > 0) delta.ingreso_mensual = v;
    }
  }

  // ── Gastos ──────────────────────────────────────────────────────────────────
  // PIEZA 2 (5ª tanda) — el usuario declara un TOTAL EXPLÍCITO (marcado con
  // ":") seguido de un desglose: "gasto 1000: 500 arriendo 250 carro 100
  // ropa". Se extraen AMBOS — agregado Y detalle — sin elegir uno en
  // silencio; la reconciliación (detectarDiscrepanciaGastos, más abajo) decide
  // si coinciden. Tiene PRIORIDAD sobre `esLista`: sin ella, el fallback
  // monto-primero de `parseExpenseList` ya habría troceado el mensaje entero
  // en detalle y el agregado nunca habría quedado registrado aparte.
  const aggMatch = GASTO_AGREGADO_DETALLE_RE.exec(n);
  if (aggMatch) {
    const agregado = parseDigitAmount(aggMatch[1]);
    if (Number.isFinite(agregado) && agregado > 0) delta.gastos_mensuales = agregado;
    const restoDesdeColon = message.slice(aggMatch.index + aggMatch[0].length);
    const detailItems = parseExpenseList(restoDesdeColon);
    if (detailItems.length >= 2) {
      const cls = classifyExpenses(detailItems);
      delta.gastos_detalle = {
        vitales: cls.vitales.total,
        noVitales: cls.noVitales.total,
        desconocidos: cls.desconocidos.total,
      };
      delta.gastos_es_detalle = true;
      delta.gastos_items = itemsAGastoItemEntries(detailItems, "regex");
    }
  } else if (esLista) {
    // Lista desglosada: gastos_detalle con totales por grupo. NO se toca
    // gastos_mensuales (el merge conserva el agregado previo — defecto B).
    const cls = classifyExpenses(listItems);
    delta.gastos_detalle = {
      vitales: cls.vitales.total,
      noVitales: cls.noVitales.total,
      desconocidos: cls.desconocidos.total,
    };
    delta.gastos_es_detalle = true;
    // PIEZA 5 (8ª tanda) — conserva cada partida individual (name, amount,
    // categoría), no solo los totales por grupo. Flujo: items → clasificación
    // → buckets (los buckets de arriba se derivan de los mismos `listItems`).
    delta.gastos_items = itemsAGastoItemEntries(listItems, "regex");
  } else if (GASTO_CTX.test(n)) {
    // Agregado en una sola cifra ("mis gastos son 1500").
    const a = AMOUNT.exec(n.slice(n.search(GASTO_CTX)));
    if (a && !esCifraAnual(n, GASTO_CTX, a) && !esRango(n, GASTO_CTX, a)) {
      const v = parseDigitAmount(a[1]);
      if (Number.isFinite(v) && v > 0) delta.gastos_mensuales = v;
    }
  }

  // ── Meta ───────────────────────────────────────────────────────────────────
  // PIEZA 6 — la señal de cambio explícito viaja en el delta: es lo ÚNICO que
  // autoriza a `mergeScenario` a tocar una meta activa del usuario.
  if (pideCambioDeMeta(message)) delta.meta_cambio_explicito = true;

  if (META_CTX.test(n)) {
    const plazo = PLAZO.exec(n);
    const a = AMOUNT.exec(n.replace(PLAZO, " "));
    const meta: MetaState = {};
    if (a) {
      const v = parseDigitAmount(a[1]);
      if (Number.isFinite(v) && v > 0) meta.monto = v;
    }
    if (plazo) {
      // FIX 1 (7ª tanda) — cero no es un valor: un plazo mal formado (0 tras
      // redondear) no se persiste como si fuera real.
      const meses = toMonths(parseDigitAmount(plazo[1]), plazo[2]);
      if (meses > 0) meta.plazo_meses = meses;
    }
    if (meta.monto !== undefined || meta.plazo_meses !== undefined) delta.meta = meta;
  }

  // ── FIX C — confirmación corta tras una propuesta pendiente ────────────────
  // "sí" SOLO dispara ejecución si había algo que confirmar; sobre un estado
  // sin propuesta pendiente es ruido conversacional ("sí, sigue así") y no
  // marca nada — evita falsos positivos de plan_confirmado.
  if (prev?.propuesta_pendiente && esConfirmacionCorta(message)) {
    delta.plan_confirmado = true;
  }

  return delta;
}

// ── PIEZA 1 (5ª tanda) — DETECTOR DE NÚMEROS HUÉRFANOS ───────────────────────
//
// CASO REAL: "gano 2300 y gasto= 1000 arriendo 500 servicios 250 carro 100
// ropa" — el sistema publicó gastos=1000 (el primer número tras "gasto") con
// gasto real de 1850 (la suma del desglose). La calculadora computó BIEN
// sobre un insumo FALSO: el hueco está en la entrada, no en el cálculo.
//
// PRINCIPIO: "Ningún dato entra al estado sin que el usuario lo vea. Ante
// ambigüedad de extracción se PREGUNTA, nunca se asume." Tras extraer el
// delta (tool call o fallback regex), se cuenta:
//   N = números en el mensaje que PARECEN financieros.
//   M = de esos, cuántos aterrizaron en algún campo del delta.
// N − M ≥ 1 ⇒ extraccion_incompleta = true.

// Sustantivos NO monetarios que, pegados a un número, lo excluyen del conteo
// ("3 hijos", "2 personas"). "años"/"meses" YA quedan fuera vía duración
// (unidad de tiempo, ver TIEMPO_AFTER_RE) — ni un plazo de crédito ni una edad
// son dinero.
//
// PIEZA 2 (8ª tanda) — vocabulario ampliado: horas, kg, m²/m2, habitaciones,
// edad, grados (ES/PT/EN). Test obligatorio (caso 11): "gano 2300, tengo 43
// años, 2 hijos, gasto 2200" → COMPLETE, sin preguntar por 43 ni 2 — sin este
// vocabulario el sistema se paraliza pidiendo la edad.
const SUSTANTIVO_NO_MONETARIO_AFTER_RE =
  /^\s*(?:hijos?|hijas?|filhos?|filhas?|kids?|child(?:ren)?|ni[ñn]os?|personas?|people|veces|times|kg|kgs|kilos?|m2|m²|habitaciones?|hab|quartos?|rooms?|edad|idade|age|grados?|graus|degrees?)\b/;
const TIEMPO_AFTER_RE =
  /^\s*(?:a[ñn]os?|anos?|years?|meses|mes|months?|d[ií]as?|days?|semanas?|weeks?|horas?|hours?)\b/;

/** ¿`m` es un enumerador de lista ("1. Ajustar…")? Mismo criterio que validate.ts. */
function esEnumeradorDeLista(text: string, m: NumberMention): boolean {
  const lineStart = text.lastIndexOf("\n", m.start - 1) + 1;
  const prefix = text.slice(lineStart, m.start);
  if (!/^[ \t]*$/.test(prefix)) return false;
  return /^ ?[.)-]/.test(text.slice(m.end, m.end + 3));
}

/** ¿`m` es una cifra CANDIDATA a financiera? (no enumerador, no duración, no sustantivo no-monetario). */
function esCandidataFinanciera(text: string, m: NumberMention): boolean {
  if (esEnumeradorDeLista(text, m)) return false;
  const after = text.slice(m.end, m.end + 20);
  if (TIEMPO_AFTER_RE.test(after)) return false;
  if (SUSTANTIVO_NO_MONETARIO_AFTER_RE.test(after)) return false;
  return true;
}

/**
 * Números candidatos a financieros del mensaje (N del detector). Exportada
 * también para el llamante (route.ts/harness): cuando la extracción es
 * ambigua, el modelo necesita poder CITAR cualquiera de estos números al
 * preguntar ("¿tu ingreso ronda los 2.000 € o los 2.500 €?") sin que el
 * guardarraíl de cifras los bloquee por no ser una derivada verificada — son
 * el eco de lo que el propio usuario escribió, no una cifra inventada.
 */
export function numerosCandidatos(message: string): number[] {
  return dedupeOverlaps(findNumberMentions(message))
    .filter((m) => esCandidataFinanciera(message, m))
    .map((m) => m.value);
}

/**
 * ¿`v` coincide con algún valor ya asignado en el delta? Tolera la conversión
 * año↔mes (÷12 / ×12, ±1 de redondeo): un extractor más listo (tool call) que
 * SÍ divide 27.600 €/año entre 12 y guarda 2.300 €/mes no debe marcarse como
 * huérfano — "normaliza explícitamente" es una salida tan válida como preguntar.
 */
function coincideConAsignado(v: number, asignados: number[]): boolean {
  return asignados.some(
    (a) => Math.abs(a - v) <= 1 || Math.abs(a - v / 12) <= 1 || Math.abs(a - v * 12) <= 1,
  );
}

/**
 * Valores numéricos que ATERRIZARON en algún campo del delta (M del
 * detector), incluyendo cada ítem individual de `gastos_detalle` — los
 * totales por grupo no coincidirían nunca con un número suelto del mensaje,
 * así que se RE-DERIVAN los ítems con el mismo parser que usó la extracción
 * (determinista, sin efectos secundarios).
 */
function valoresAsignadosEnDelta(message: string, delta: Partial<ScenarioState>): number[] {
  const vals: number[] = [];
  if (delta.ingreso_mensual !== undefined) vals.push(delta.ingreso_mensual);
  if (delta.gastos_mensuales !== undefined) vals.push(delta.gastos_mensuales);
  if (delta.gastos_es_detalle) {
    for (const item of parseExpenseList(message)) vals.push(item.amount);
  }
  if (delta.credito) {
    if (delta.credito.monto) vals.push(delta.credito.monto);
    if (delta.credito.plazo_meses) vals.push(delta.credito.plazo_meses);
    if (delta.credito.tae_pct !== undefined) vals.push(delta.credito.tae_pct);
  }
  if (delta.meta) {
    if (delta.meta.monto !== undefined) vals.push(delta.meta.monto);
    if (delta.meta.plazo_meses !== undefined) vals.push(delta.meta.plazo_meses);
  }
  return vals;
}

export interface ExtraccionIncompletaResult {
  extraccionIncompleta: boolean;
  numerosHuerfanos: number[];
  /**
   * PIEZA 2 (8ª tanda) — números del mensaje que el detector VIO pero
   * CLASIFICÓ como NO RELEVANTES (edad, nº de hijos, duración, unidades…):
   * se ignoran y NUNCA degradan `extraction_status` — informativo, para
   * telemetría/depuración, no para preguntar por ellos.
   */
  numerosNoRelevantes: number[];
}

/** ¿Por qué `m` NO es una cifra financiera candidata? `null` si SÍ lo es. */
function razonNoRelevante(text: string, m: NumberMention): "tiempo" | "sustantivo" | null {
  if (esEnumeradorDeLista(text, m)) return null; // ni siquiera es un número candidato real.
  const after = text.slice(m.end, m.end + 20);
  if (TIEMPO_AFTER_RE.test(after)) return "tiempo";
  if (SUSTANTIVO_NO_MONETARIO_AFTER_RE.test(after)) return "sustantivo";
  return null;
}

/**
 * Detector de números huérfanos (PIEZA 1). Puro; corre TRAS extraer el delta,
 * sea por tool call o por fallback regex — ambos producen un
 * `Partial<ScenarioState>`, así que el detector es agnóstico a la vía.
 */
export function detectarNumerosHuerfanos(
  message: string,
  delta: Partial<ScenarioState>,
): ExtraccionIncompletaResult {
  const candidatos = numerosCandidatos(message);
  const asignados = valoresAsignadosEnDelta(message, delta);
  const numerosHuerfanos = candidatos.filter((v) => !coincideConAsignado(v, asignados));
  const numerosNoRelevantes = dedupeOverlaps(findNumberMentions(message))
    .filter((m) => razonNoRelevante(message, m) !== null)
    .map((m) => m.value);
  return { extraccionIncompleta: numerosHuerfanos.length > 0, numerosHuerfanos, numerosNoRelevantes };
}

// ── PIEZA 2 (5ª tanda) — RECONCILIACIÓN ARITMÉTICA ───────────────────────────
//
// CASO REAL (variante): "gasto 1000: 500 arriendo 250 carro 100 ropa" — el
// agregado declarado (1000) NO coincide con la suma del detalle (850). No se
// elige uno en silencio: se pregunta cuál es el correcto.
export interface DiscrepanciaGastosResult {
  discrepancia: boolean;
  agregado?: number;
  suma?: number;
}

/**
 * ¿El agregado declarado (`gastos_mensuales`) y la suma del desglose
 * (`gastos_detalle`) se contradicen? Solo aplica cuando AMBOS llegaron en el
 * MISMO delta (ver `GASTO_AGREGADO_DETALLE_RE` en `extractScenarioDelta`) —
 * el caso normal (solo detalle, sin agregado propio) nunca dispara esto.
 */
export function detectarDiscrepanciaGastos(delta: Partial<ScenarioState>): DiscrepanciaGastosResult {
  if (delta.gastos_mensuales === undefined || !delta.gastos_detalle) return { discrepancia: false };
  const suma = round2(
    delta.gastos_detalle.vitales + delta.gastos_detalle.noVitales + delta.gastos_detalle.desconocidos,
  );
  const agregado = delta.gastos_mensuales;
  if (Math.abs(suma - agregado) <= 1) return { discrepancia: false };
  return { discrepancia: true, agregado, suma };
}

/**
 * Nota de aclaración para el system prompt cuando la extracción es ambigua
 * (PIEZA 1/2 · orquestador).
 *
 * BUG BLOQUEANTE (6ª tanda, testdev5) — la versión anterior de esta pieza
 * hacía que un huérfano DESCARTARA el delta completo (`deltaSeguro`
 * eliminaba ingreso_mensual/gastos_mensuales/credito/meta aunque esos campos
 * se hubieran extraído con confianza). Un mensaje real con ingreso y gastos
 * limpios más un par de cifras de una meta sin decidir aún (p. ej. "casa de
 * 200000 o 300000, quizá 150000") perdía el ingreso y los gastos para
 * SIEMPRE — nada se persistía. Corregido: los huérfanos son SOLO una
 * pregunta de aclaración; NUNCA tocan campos ya extraídos con confianza. Por
 * eso esta nota ya NO dice "cero cifras derivadas" para huérfanos — lo que
 * SÍ se sabe se calcula igual; solo se pide aclarar los números sueltos.
 *
 * La discrepancia de gastos sigue siendo distinta: agregado y desglose son
 * DOS lecturas del MISMO campo que se contradicen, así que ese campo (y solo
 * ese) no se usa hasta reconciliar — ver `deltaSinGastosPorDiscrepancia`.
 *
 * PRIORIDAD: una discrepancia aritmética es más concreta que un huérfano
 * genérico — si hay ambas, se pregunta por la discrepancia primero (el
 * huérfano probablemente sea el mismo número). `null` si nada es ambiguo.
 */
export function notaExtraccionAmbigua(
  huerfanos: ExtraccionIncompletaResult,
  discrepancia: DiscrepanciaGastosResult,
  itemSospechoso?: ItemSospechoso | null,
): string | null {
  if (discrepancia.discrepancia) {
    return (
      `DISCREPANCIA ARITMÉTICA: el usuario declaró un total de gastos de ${discrepancia.agregado} € pero ` +
      `el detalle suma ${discrepancia.suma} €. Pregunta cuál es el correcto antes de dar una cifra de ` +
      "gastos o cualquier derivada que dependa de ellos (sobrante, capacidad, viabilidad de una cuota). " +
      "El resto de los datos que ya tienes (ingreso, meta, crédito…) SÍ los puedes usar con normalidad."
    );
  }
  // PIEZA 6 (8ª tanda) — ítem sospechoso de pegado: más concreto que un
  // huérfano genérico (ya sabemos EXACTAMENTE qué partida dudar), así que
  // tiene prioridad sobre el aviso genérico de huérfanos. El resto de
  // partidas SÍ se usan con normalidad (V1) — solo se pregunta por esta.
  if (itemSospechoso) {
    return (
      `POSIBLE CIFRA PEGADA: ${itemSospechoso.sugerencia} Pregunta con calidez para confirmar la lectura ` +
      "correcta antes de dar por cerrado el desglose de gastos. El resto de las partidas que sí quedaron " +
      "claras las puedes usar con normalidad."
    );
  }
  if (huerfanos.extraccionIncompleta) {
    return (
      `NÚMEROS SIN ASIGNAR: el usuario mencionó ${huerfanos.numerosHuerfanos.join(", ")} y no quedó claro a ` +
      "qué corresponden. Pregúntale a qué se refieren — con calidez, no como un interrogatorio — pero eso " +
      "NO te impide seguir usando con normalidad los datos que SÍ tienes claros de este mismo mensaje " +
      "(ingreso, gastos, meta, crédito…): calcula con esos igual, y añade la pregunta de los números " +
      "sueltos aparte."
    );
  }
  return null;
}

// ── PIEZA 1 (8ª tanda) — EXTRACTION_STATUS ───────────────────────────────────
//
// "Antes de decir que el usuario se contradijo, el sistema debe preguntarse si
// lo leyó bien." Resume en UN valor cuál de las señales ya existentes (huérfanos,
// discrepancia, ítem sospechoso, valor inválido) aplica a este turno — NUNCA
// degrada nada por sí solo: la afectación real ya la deciden esas mismas
// piezas (huérfanos no descartan el delta — V1; discrepancia solo retiene
// gastos; item_sospechoso solo pregunta, el ítem se usa igual).

// Campos con contexto de alta confianza donde un CERO explícito es un
// placeholder rechazable (V8), no un dato real. No cubre negativos: el
// parser de montos (`AMOUNT`) no captura signo, así que un negativo nunca
// llega a `delta` — no hace falta detectarlo aparte.
const CAMPOS_CON_CONTEXTO_CERO: Array<[string, RegExp]> = [
  ["ingreso_mensual", INGRESO_CTX],
  ["gastos_mensuales", GASTO_CTX],
];

/**
 * PIEZA 1 — campos con un CERO explícito mencionado en contexto financiero
 * ("gano 0", "gasto 0 este mes"). Un cero así NUNCA se persiste (V8, ya
 * vigente vía los filtros `> 0` de `extractScenarioDelta`) — esto solo hace
 * VISIBLE por qué ese campo se quedó sin asignar, en vez de fallar en
 * silencio como un huérfano genérico.
 */
export function detectarValoresInvalidos(message: string): string[] {
  const n = norm(message);
  const invalidos: string[] = [];
  for (const [campo, ctxRe] of CAMPOS_CON_CONTEXTO_CERO) {
    if (!ctxRe.test(n)) continue;
    const m = AMOUNT.exec(n.slice(n.search(ctxRe)));
    if (!m) continue;
    const v = parseDigitAmount(m[1]);
    if (Number.isFinite(v) && v <= 0) invalidos.push(campo);
  }
  return invalidos;
}

export interface ExtractionStatusInputs {
  huerfanos: ExtraccionIncompletaResult;
  discrepancia: DiscrepanciaGastosResult;
  itemSospechoso: ItemSospechoso | null;
  camposInvalidos: string[];
}

/**
 * PIEZA 1 — el resumen de una línea que el resto del sistema (eco, telemetría)
 * puede leer sin tener que re-derivar las cuatro señales. Prioridad: INVALID
 * (un campo quedó MISSING por un valor imposible) > AMBIGUOUS (discrepancia o
 * pegado — más concreto) > PARTIAL (huérfanos genéricos) > COMPLETE.
 */
export function computeExtractionStatus(inputs: ExtractionStatusInputs): ExtractionStatus {
  if (inputs.camposInvalidos.length > 0) return "INVALID";
  if (inputs.discrepancia.discrepancia || inputs.itemSospechoso) return "AMBIGUOUS";
  if (inputs.huerfanos.extraccionIncompleta) return "PARTIAL";
  return "COMPLETE";
}

export interface AnalisisExtraccion {
  extraction_status: ExtractionStatus;
  huerfanos: ExtraccionIncompletaResult;
  discrepancia: DiscrepanciaGastosResult;
  itemSospechoso: ItemSospechoso | null;
  camposInvalidos: string[];
}

/**
 * PIEZA 1 — punto de entrada ÚNICO para analizar la honestidad de la
 * extracción de este turno: corre las cuatro señales (huérfanos,
 * discrepancia, ítem sospechoso de pegado, valores inválidos) y resume el
 * resultado en `extraction_status`. Puro; no muta nada — el llamante
 * (route.ts) decide qué hacer con cada señal (igual que ya hacía antes de
 * existir esta función, que solo las agrupa).
 */
export function analizarExtraccion(message: string, delta: Partial<ScenarioState>): AnalisisExtraccion {
  const huerfanos = detectarNumerosHuerfanos(message, delta);
  const discrepancia = detectarDiscrepanciaGastos(delta);
  const itemSospechoso = delta.gastos_es_detalle
    ? parseExpenseListDetallado(message, delta.gastos_mensuales).itemSospechoso
    : null;
  const camposInvalidos = detectarValoresInvalidos(message);
  const extraction_status = computeExtractionStatus({ huerfanos, discrepancia, itemSospechoso, camposInvalidos });
  return { extraction_status, huerfanos, discrepancia, itemSospechoso, camposInvalidos };
}

/**
 * Copia del delta sin los campos DE GASTOS — se usa SOLO cuando hay
 * discrepancia aritmética (agregado ≠ suma del desglose, el mismo campo
 * contándose a sí mismo dos veces de forma contradictoria). El resto del
 * delta (ingreso, crédito, meta, señales no numéricas…) se persiste igual:
 * "ningún dato entra sin que el usuario lo vea" se aplica al campo ambiguo,
 * NUNCA al mensaje entero.
 *
 * BUG BLOQUEANTE (6ª tanda) — esta función reemplaza a la antigua
 * `deltaSeguro`, que despojaba TODO campo financiero (ingreso, crédito, meta
 * incluidos) ante CUALQUIER huérfano en el mensaje, aunque esos campos se
 * hubieran extraído con confianza y no tuvieran nada que ver con la
 * ambigüedad. Un huérfano YA NO despoja nada — ver `notaExtraccionAmbigua`.
 */
export function deltaSinGastosPorDiscrepancia(
  delta: Partial<ScenarioState>,
  discrepancia: DiscrepanciaGastosResult,
): Partial<ScenarioState> {
  if (!discrepancia.discrepancia) return delta;
  const sinGastos = { ...delta };
  delete sinGastos.gastos_mensuales;
  delete sinGastos.gastos_detalle;
  delete sinGastos.gastos_es_detalle;
  return sinGastos;
}

// ── PIEZA 3 (5ª tanda) — ECO DE CONFIRMACIÓN ─────────────────────────────────
//
// El mecanismo GENERAL, no solo para este caso: cuando el turno SÍ extrajo
// datos limpios (sin huérfanos ni discrepancia), la primera línea de la
// respuesta DEBE devolver lo entendido antes de usarlo — así el usuario ve el
// dato y puede corregirlo si está mal, en vez de descubrirlo tres cifras
// derivadas más tarde. Esta función expone los HECHOS de lo que el delta trae;
// la REDACCIÓN (voz, calidez) es del modelo — ver consigliere.ts.
export function renderDatosRecienEntendidos(
  delta: Partial<ScenarioState>,
  message: string,
): string | null {
  const partes: string[] = [];
  if (delta.ingreso_mensual !== undefined) partes.push(`ingreso mensual: ${delta.ingreso_mensual} €`);
  if (delta.gastos_es_detalle && delta.gastos_detalle) {
    // `gastos_mensuales` puede no venir en el delta (el caso normal: solo
    // detalle, sin agregado propio — `mergeScenario` lo recalcula al fusionar).
    // El total a mostrar en el eco es la suma del propio desglose.
    const total = delta.gastos_mensuales ?? round2(
      delta.gastos_detalle.vitales + delta.gastos_detalle.noVitales + delta.gastos_detalle.desconocidos,
    );
    const items = parseExpenseList(message);
    const desglose = items.length > 0 ? ` (${items.map((i) => `${i.name} ${i.amount}`).join(", ")})` : "";
    partes.push(`gastos mensuales: ${total} €${desglose}`);
  } else if (delta.gastos_mensuales !== undefined) {
    partes.push(`gastos mensuales: ${delta.gastos_mensuales} €`);
  }
  if (delta.credito) {
    if (delta.credito.monto) partes.push(`monto del crédito: ${delta.credito.monto} €`);
    if (delta.credito.plazo_meses) partes.push(`plazo: ${delta.credito.plazo_meses} meses`);
    if (delta.credito.tae_pct !== undefined) partes.push(`TAE: ${delta.credito.tae_pct}%`);
  }
  if (delta.meta) {
    if (delta.meta.titulo) partes.push(`meta: ${delta.meta.titulo}`);
    if (delta.meta.monto !== undefined) partes.push(`monto de la meta: ${delta.meta.monto} €`);
    if (delta.meta.plazo_meses !== undefined) partes.push(`plazo de la meta: ${delta.meta.plazo_meses} meses`);
  }
  if (partes.length === 0) return null;
  return (
    `DATOS RECIÉN ENTENDIDOS (este turno): ${partes.join("; ")}. ` +
    "Tu PRIMERA línea devuelve esto de forma compacta y natural (con tu propia voz, no copies este " +
    "formato) antes de usar estas cifras — ver la regla de ECO del prompt. Si el usuario corrige un " +
    "dato, el dato corregido manda. No repitas el eco si ya lo hiciste con los mismos datos."
  );
}

function round2(n: number): number {
  return Math.round((n + Number.EPSILON) * 100) / 100;
}

// ── PIEZA 6 (8ª tanda) — FACT_STATUS: EL ECO COMO PROMOTOR DE CONFIANZA ──────
//
// Por campo: MISSING (nunca se ha visto) → PARSED (extraído, confianza media)
// → CONFIRMED (el eco lo enunció y el usuario NO lo corrigió el turno
// siguiente). El eco YA EXISTE (`renderDatosRecienEntendidos`); esto lo
// convierte en el MECANISMO de promoción — el sistema entrega los datos, la
// frase la redacta el modelo. CONFLICT/ASSUMED/SUPERSEDED son de la tanda
// siguiente: aquí solo hay ida (PARSED→CONFIRMED) y reset ante una corrección
// (un valor nuevo y distinto vuelve a PARSED, nunca se queda CONFIRMED a
// ciegas).

/** Los ocho campos escalares que llevan fact_status. */
function valorCampo(s: Partial<ScenarioState> | undefined, campo: string): unknown {
  switch (campo) {
    case "ingreso_mensual": return s?.ingreso_mensual;
    case "gastos_mensuales": return s?.gastos_mensuales;
    case "credito_monto": return s?.credito?.monto;
    case "credito_plazo": return s?.credito?.plazo_meses;
    case "credito_tae": return s?.credito?.tae_pct;
    case "meta_monto": return s?.meta?.monto;
    case "meta_plazo": return s?.meta?.plazo_meses;
    case "meta_titulo": return s?.meta?.titulo;
    default: return undefined;
  }
}

/** ¿Qué campos escalares trae EXPLÍCITAMENTE este delta (para fact_status y para el eco_pendiente del turno)? */
function camposDelDelta(delta: Partial<ScenarioState>): string[] {
  const campos: string[] = [];
  if (delta.ingreso_mensual !== undefined) campos.push("ingreso_mensual");
  if (delta.gastos_mensuales !== undefined) campos.push("gastos_mensuales");
  if (delta.credito?.monto !== undefined) campos.push("credito_monto");
  if (delta.credito?.plazo_meses !== undefined) campos.push("credito_plazo");
  if (delta.credito?.tae_pct !== undefined) campos.push("credito_tae");
  if (delta.meta?.monto !== undefined) campos.push("meta_monto");
  if (delta.meta?.plazo_meses !== undefined) campos.push("meta_plazo");
  if (delta.meta?.titulo !== undefined) campos.push("meta_titulo");
  return campos;
}

/**
 * Calcula el `factStatus` tras este merge. `base` ya tiene los valores
 * FINALES resueltos (para poder comparar "¿sigue siendo el mismo dato que ya
 * estaba CONFIRMED?"); `prev`/`delta` traen el ANTES y lo que llegó este turno.
 */
function actualizarFactStatus(
  prev: Partial<ScenarioState> | undefined,
  delta: Partial<ScenarioState>,
  base: ScenarioState,
): Record<string, FactStatus> {
  const status: Record<string, FactStatus> = { ...(prev?.factStatus ?? {}) };
  const camposTocados = camposDelDelta(delta);

  // Promoción: un campo que el ECO del turno anterior enunció (`eco_pendiente`)
  // y que este turno NO trajo un valor nuevo para él → el usuario no lo
  // corrigió → sube de PARSED a CONFIRMED.
  for (const campo of prev?.eco_pendiente?.fields ?? []) {
    if (status[campo] === "PARSED" && !camposTocados.includes(campo)) {
      status[campo] = "CONFIRMED";
    }
  }

  // Extracción nueva este turno → PARSED, salvo que sea una REAFIRMACIÓN
  // exacta de un valor ya CONFIRMED (entonces se queda CONFIRMED — repetir lo
  // ya confirmado no es una corrección).
  for (const campo of camposTocados) {
    const yaConfirmado = status[campo] === "CONFIRMED" && valorCampo(prev, campo) === valorCampo(base, campo);
    if (!yaConfirmado) status[campo] = "PARSED";
  }

  return status;
}

/**
 * Fusiona el estado previo con un delta. Merge por campo, ÚLTIMO gana. El crédito
 * se fusiona a nivel de subcampo (una TAE nueva no borra el monto). Si llega una
 * TAE real, `tae_es_referencia` pasa a false. Recalcula `missing`.
 *
 * REGLA DE PERSISTENCIA (transversal a todo el estado): un campo NUNCA se borra
 * por ausencia en un mensaje posterior — el usuario no repite en cada turno lo
 * que ya dijo. Solo se sobreescribe cuando el delta trae un valor NUEVO Y
 * EXPLÍCITO para ese campo exacto (`!== undefined`, nunca "delta no lo menciona
 * → lo borro"). Por eso cada asignación de abajo está guardada tras un
 * `if (delta.x !== undefined)`, y el merge de `credito` parte de `{...base.credito}`
 * en vez de reconstruirlo desde cero.
 */
export function mergeScenario(
  prev: ScenarioState | Partial<ScenarioState> | undefined,
  delta: Partial<ScenarioState>,
): ScenarioState {
  const base: ScenarioState = { missing: [], ...(prev ?? {}) };
  // La señal de cambio de meta es DEL TURNO: nunca se arrastra al estado que se
  // persiste (si lo hiciera, un turno viejo autorizaría cambios futuros).
  delete base.meta_cambio_explicito;

  // ── PIEZA 6 — TRANSICIÓN EXPLÍCITA ──────────────────────────────────────────
  // "cambia la meta", "olvida el carro", "ahora quiero una casa": la meta activa
  // se ARCHIVA (no se borra) y el estado que colgaba de ella se limpia — un
  // crédito abierto pertenecía a la meta abandonada, dejarlo vivo re-derivaría
  // la misma meta en el siguiente merge.
  if (delta.meta_cambio_explicito && base.meta) {
    archivarMeta(base);
    base.meta = undefined;
    base.meta_derivada = undefined;
    base.meta_cerrada = undefined;
    base.credito = undefined;
    base.propuesta_pendiente = undefined;
    base.plan_confirmado = undefined;
  }

  if (delta.ingreso_mensual !== undefined) base.ingreso_mensual = delta.ingreso_mensual;
  if (delta.gastos_mensuales !== undefined) base.gastos_mensuales = delta.gastos_mensuales;
  if (delta.gastos_es_detalle !== undefined) base.gastos_es_detalle = delta.gastos_es_detalle;

  // BUG 1 — el detalle manda SIEMPRE sobre el agregado: si llega un desglose
  // (≥2 ítems — la única forma en que `extractScenarioDelta` produce
  // `gastos_detalle`), `gastos_mensuales` se RECALCULA como la suma de todo el
  // detalle, pisando el agregado previo aunque estuviera obsoleto. Dos fuentes
  // de verdad para el mismo dato es el bug: a partir de aquí solo hay una.
  if (delta.gastos_detalle !== undefined) {
    base.gastos_detalle = delta.gastos_detalle;
    base.gastos_mensuales = round2(
      delta.gastos_detalle.vitales + delta.gastos_detalle.noVitales + delta.gastos_detalle.desconocidos,
    );
  }

  // PIEZA 5 (8ª tanda) — gastos_items se ACUMULA (nunca se pisa): cada turno
  // que aporta partidas se ANOTA con su propio número de turno, para poder
  // auditar cuándo se dijo qué. El turno es 1-indexado y se deriva del máximo
  // ya visto — `extractScenarioDelta`/`toolArgsToScenarioDelta` no conocen el
  // historial, así que dejan `turn: 0` como placeholder.
  if (delta.gastos_items !== undefined && delta.gastos_items.length > 0) {
    const turnoAnterior = base.gastos_items?.reduce((max, i) => Math.max(max, i.turn), 0) ?? 0;
    const nuevos = delta.gastos_items.map((item) => ({ ...item, turn: turnoAnterior + 1 }));
    base.gastos_items = [...(base.gastos_items ?? []), ...nuevos];
  }

  // ── PIEZA 6 — META ACTIVA ÚNICA ─────────────────────────────────────────────
  // La meta activa es UNA. Un delta de meta solo puede:
  //   · ABRIR una meta nueva si no hay ninguna activa del usuario, si la activa
  //     es derivada del crédito, si ya está CERRADA (plan confirmado) o si el
  //     usuario pidió el cambio explícitamente.
  //   · COMPLETAR huecos de la meta activa (el usuario aporta el monto o el
  //     plazo que faltaban).
  // PROHIBIDO que un mensaje ambiguo ("también me vendría bien una casa")
  // sobrescriba el monto o el plazo de una meta activa que el usuario ya fijó.
  if (delta.meta !== undefined) {
    const activaProtegida =
      base.meta !== undefined && !base.meta_derivada && !base.meta_cerrada && !delta.meta_cambio_explicito;

    if (!activaProtegida) {
      if (base.meta !== undefined && base.meta_cerrada) {
        // Meta cerrada + meta nueva → la anterior se archiva y se arranca limpio.
        archivarMeta(base);
        base.meta = { ...delta.meta };
        base.meta_cerrada = false;
      } else {
        base.meta = { ...(base.meta ?? {}), ...delta.meta };
      }
      base.meta_derivada = false;
    } else {
      // Solo se rellenan los huecos; nunca se pisa un valor ya fijado.
      const completada: MetaState = { ...base.meta };
      if (completada.titulo === undefined && delta.meta.titulo !== undefined) completada.titulo = delta.meta.titulo;
      if (completada.monto === undefined && delta.meta.monto !== undefined) completada.monto = delta.meta.monto;
      if (completada.plazo_meses === undefined && delta.meta.plazo_meses !== undefined) {
        completada.plazo_meses = delta.meta.plazo_meses;
      }
      base.meta = completada;
    }
  }

  // FIX C — confirmación corta ("sí") con propuesta pendiente → PB7 ejecuta.
  // Se limpia la pendiente: ya cumplió su propósito, y así una nueva propuesta
  // (route.ts, tras generar la respuesta) puede detectarse limpiamente.
  //
  // PIEZA 6 — confirmar el plan CIERRA la meta activa y la archiva: a partir de
  // aquí (y solo a partir de aquí) puede iniciarse otra sin petición explícita.
  if (delta.plan_confirmado) {
    base.plan_confirmado = true;
    base.propuesta_pendiente = undefined;
    if (base.meta) {
      base.meta_cerrada = true;
      archivarMeta(base);
    }
  }

  if (delta.credito !== undefined) {
    // FIX 1 (7ª tanda) — sin placeholder de 0: si no hay crédito previo, el
    // objeto arranca solo con lo que de verdad se sabe (nada de monto/plazo).
    const merged: CreditoState = { ...(base.credito ?? { tae_es_referencia: true }) };
    if (delta.credito.monto !== undefined) merged.monto = delta.credito.monto;
    if (delta.credito.plazo_meses !== undefined) merged.plazo_meses = delta.credito.plazo_meses;
    if (delta.credito.objeto) merged.objeto = delta.credito.objeto;
    if (delta.credito.tae_pct !== undefined) {
      merged.tae_pct = delta.credito.tae_pct;
      // Una TAE aportada por el usuario deja de ser la de referencia.
      merged.tae_es_referencia = delta.credito.tae_es_referencia;
    }
    base.credito = merged;
  }

  // BUG 3 — si hay un crédito con monto y el usuario nunca dio una meta propia
  // (o la que hay sigue siendo la derivada de un crédito previo), la meta ES el
  // crédito: comprar ese carro/casa/lo-que-sea, en ese monto y ese plazo. Sin
  // esto, `missing` pide "meta" con el carro ya sobre la mesa — el modelo
  // pierde contexto y repite preguntas.
  if (base.credito && base.credito.monto !== undefined && base.credito.monto > 0 && (base.meta === undefined || base.meta_derivada)) {
    base.meta = {
      titulo: base.credito.objeto ? capitalize(base.credito.objeto) : "compra financiada",
      monto: base.credito.monto,
      plazo_meses: base.credito.plazo_meses,
    };
    base.meta_derivada = true;
  }

  // PIEZA 7 (6ª tanda) — expone explícito lo que antes había que inferir del
  // estado: agregado y desglose son necesidades DISTINTAS (calcular vs.
  // recortar), y el prompt no debe adivinar cuál de las dos tiene.
  base.tiene_agregado_gastos = base.gastos_mensuales !== undefined;
  base.tiene_detalle_gastos = base.gastos_detalle !== undefined;

  // PIEZA 6 (8ª tanda) — FACT_STATUS: el eco como promotor de confianza. Se
  // calcula al final, con `base` ya resuelto (necesita el valor FINAL de cada
  // campo para poder comparar "¿es el mismo dato que ya estaba confirmado, o
  // uno nuevo que aún no se confirmó?").
  base.factStatus = actualizarFactStatus(prev, delta, base);
  const camposTocados = camposDelDelta(delta);
  base.eco_pendiente = camposTocados.length > 0 ? { fields: camposTocados } : undefined;

  base.missing = computeMissing(base);
  return base;
}

function capitalize(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

/**
 * PIEZA 6 — archiva la meta activa en `goals_cerradas`. Nunca se borra una meta:
 * el historial de lo que el usuario persiguió es contexto, no ruido. Idempotente
 * (una misma meta no se archiva dos veces).
 */
function archivarMeta(base: ScenarioState): void {
  const meta = base.meta;
  if (!meta) return;
  const archivo = base.goals_cerradas ? [...base.goals_cerradas] : [];
  const yaEsta = archivo.some(
    (g) => g.titulo === meta.titulo && g.monto === meta.monto && g.plazo_meses === meta.plazo_meses,
  );
  if (!yaEsta) archivo.push({ ...meta });
  base.goals_cerradas = archivo;
}

// ── PIEZA 7 — DIGRESIÓN CON RETORNO ──────────────────────────────────────────
//
// El usuario pregunta por el tiempo, por quién eres, por cualquier cosa. Eso NO
// es un fallo: es una conversación. Se le responde con naturalidad y NO se le
// fuerza cierre (el carril META ya garantiza el texto intacto). Solo cuando
// acumula 3 turnos seguidos fuera de la meta activa se le reconduce — con una
// nota al modelo, nunca cortándole en seco.

/** Turnos consecutivos fuera de la meta antes de reconducir. */
export const DIGRESIONES_UMBRAL = 3;

/** ¿Hay una meta activa (existe y no está cerrada)? */
export function tieneMetaActiva(s: Partial<ScenarioState> | undefined): boolean {
  return !!s?.meta && s.meta_cerrada !== true;
}

/**
 * Contador de digresiones tras clasificar el turno. Un turno con contenido
 * financiero real lo reinicia; un turno fuera de la meta lo incrementa; MIXTO
 * lo deja como estaba (el usuario sigue aportando datos, no está divagando).
 *
 * `message` es opcional pero IMPORTA: un mensaje sin señal financiera propia
 * ("¿qué temperatura hace?") se clasifica FINANCIERO por CONTINUIDAD del
 * escenario, y sin mirar el texto contaría como vuelta a la meta cuando en
 * realidad es justo la digresión que esta pieza persigue (Caso B del
 * diagnóstico). Sin `message`, se aplica la regla por carril a secas.
 */
export function actualizarDigresiones(
  prev: Partial<ScenarioState> | undefined,
  carril: Carril,
  message?: string,
): number {
  const actual = prev?.digresiones_seguidas ?? 0;
  const conContenidoFinanciero =
    message === undefined ? carril === "FINANCIERO" : tieneSenalFinanciera(message);

  if (carril === "MIXTO") return actual;                       // charla + datos: no es divagar
  if (carril === "FINANCIERO" && conContenidoFinanciero) return 0;
  if (!tieneMetaActiva(prev)) return actual;                   // sin meta no hay a dónde volver
  return actual + 1;
}

/**
 * Nota de reconducción para el system prompt, o null si aún no toca. Es una
 * INSTRUCCIÓN al modelo, no una plantilla de respuesta: él decide las palabras.
 */
export function notaRetornoMeta(
  s: Partial<ScenarioState> | undefined,
  umbral: number = DIGRESIONES_UMBRAL,
): string | null {
  if (!s || !tieneMetaActiva(s)) return null;
  const n = s.digresiones_seguidas ?? 0;
  if (n < umbral) return null;
  const titulo = s.meta?.titulo ?? "la meta activa";
  return (
    `El usuario lleva ${n} turnos fuera de la meta activa '${titulo}'. ` +
    "Responde su pregunta y reconduce con naturalidad hacia el plan pendiente."
  );
}

// ── FIX 2b (4ª tanda) — AUTO-CHEQUEO DETERMINISTA ────────────────────────────
//
// El bloque de VERIFICACIÓN OBLIGATORIA del prompt (consigliere.ts) le pide al
// modelo que se autochequee, pero no cuesta nada reforzarlo con una señal
// determinista: si el playbook activo (hay crédito o meta sobre la mesa)
// requiere un dato que falta, no hace falta que el modelo "decida" no
// proponer cifras — el orquestador se lo dice directamente.

/** Campo → nombre humano, para la nota de refuerzo (no user-facing). */
const CAMPO_LABEL: Record<string, string> = {
  tae: "la TAE real",
  gastos: "los gastos",
  ingreso: "el ingreso",
  meta_monto: "el monto de la meta",
  plazo: "el plazo",
  monto: "el monto del crédito",
};

/**
 * Nota de refuerzo para el system prompt, o null si no aplica. Solo se activa
 * cuando el playbook activo IMPLICA cifras de plan (hay un crédito o una meta
 * en curso) y falta un dato que ese plan necesita — un `missing` genérico sin
 * un playbook de por medio (p. ej. justo al arrancar la conversación) no
 * dispara nada: no hay plan que frenar todavía.
 */
export function notaSinCifrasDePlan(s: Partial<ScenarioState> | undefined): string | null {
  if (!s) return null;
  const missing = s.missing ?? [];
  if (missing.length === 0) return null;
  const implicaCifrasDePlan = !!s.credito || !!s.meta;
  if (!implicaCifrasDePlan) return null;
  const campo = CAMPO_LABEL[missing[0]] ?? missing[0];
  return `NO propongas cifras de plan en este turno: falta ${campo}. Pídelo con calidez.`;
}

// ── PIEZA 7 (6ª tanda) — AGREGADO BASTA PARA CALCULAR, DETALLE PARA RECORTAR ──
//
// El agregado de gastos (gastos_mensuales) es SUFICIENTE para sobrante,
// capacidad, brecha y viabilidad de una cuota — con eso NUNCA se vuelve a
// preguntar por ingreso ni gastos. El desglose (gastos_detalle) solo hace
// falta para proponer QUÉ partida recortar y cuánto. Pedir el desglose
// cuando nadie pidió un plan de recorte sería el mismo error que este
// principio corrige en otra forma: forzar una pregunta que el turno no
// necesita. Por eso esta nota SOLO se activa cuando el mensaje del usuario
// pide, explícitamente, un plan de recorte.
const RECORTE_REQUEST_RE = new RegExp(
  "\\b(" +
    // ES
    "recortar|recorte|que puedo recortar|donde recorto|reducir (?:mis )?gastos|" +
    "bajar (?:mis )?gastos|plan de ahorro|que puedo cortar|ajustar (?:mis )?gastos|" +
    // PT
    "cortar (?:as )?despesas|reduzir (?:as )?despesas|onde posso cortar|plano de poupanca|" +
    // EN
    "cut (?:my )?expenses|reduce (?:my )?expenses|where can i cut|savings plan|" +
    "trim (?:my )?spending" +
  ")\\b",
);

/** ¿El mensaje pide, explícitamente, un plan de recorte de gastos? */
export function pideRecorte(message: string): boolean {
  return RECORTE_REQUEST_RE.test(norm(message));
}

/**
 * Nota de refuerzo (PIEZA 7) para el system prompt: el usuario pide un plan
 * de recorte, el motor tiene el AGREGADO pero no el DESGLOSE. El código dice
 * QUÉ pedir (el desglose, citando lo ya sabido); el modelo decide CÓMO
 * decirlo. `null` si no aplica — ni cuando no se pidió recorte, ni cuando ya
 * hay desglose, ni cuando ni siquiera hay agregado (ahí manda el `missing`
 * genérico de 'gastos', no esta pieza).
 */
export function notaFaltaDesglose(
  s: Partial<ScenarioState> | undefined,
  message: string,
): string | null {
  if (!s) return null;
  if (!s.tiene_agregado_gastos || s.tiene_detalle_gastos) return null;
  if (!pideRecorte(message)) return null;
  return (
    `El usuario pide un plan de recorte. Ya sabes que gasta ${s.gastos_mensuales} € al mes en total — ` +
    "PROHIBIDO volver a preguntar el ingreso o el total de gastos, ya están en DATOS VERIFICADOS. " +
    "Pide el DESGLOSE por partida (vivienda, comida, transporte, ocio…) citando el total que ya sabes, " +
    "para poder decir exactamente qué recortar."
  );
}

// FIX C — ¿la respuesta del asistente cierra PROPONIENDO un plan concreto
// ("¿quieres que te proyecte el plan?", "¿Confirmamos ese plan?", "¿Arrancamos
// con esto?")? Deliberadamente más estrecho que "termina en pregunta": una
// pregunta de DATO ("¿cuál es tu ingreso?") no es una propuesta de plan — el
// bug real era específicamente el ciclo propuesta→"sí"→re-diagnóstico.
const PROPUESTA_PLAN_RE =
  /\b(el plan|ese plan|este plan|te proyecte|proyectar tu|confirmamos|arrancamos|registramos|seguimos con esto|adelante con esto|quieres que (?:te )?(?:arme|proyecte|calcule)|o plano|avancamos|registamos|the plan|shall we proceed|move forward with this|shall we log it)\b/;

/**
 * ¿La ÚLTIMA frase de `text` es una propuesta de plan que espera confirmación?
 * Pura; no muta nada — el llamante (route.ts) decide qué hacer con el resultado.
 */
export function esPropuestaDePlan(text: string): boolean {
  if (!text || !text.trim().endsWith("?")) return false;
  const ultimaFrase = text.trim().split(/(?<=[.!?])\s+/).at(-1) ?? "";
  return PROPUESTA_PLAN_RE.test(norm(ultimaFrase));
}

/**
 * FIX C — se llama tras generar `finalText` (route.ts), ANTES de persistir el
 * escenario. Si el cierre propone un plan, lo recuerda como
 * `propuesta_pendiente` (para que un "sí" del próximo turno dispare PB7) y
 * apaga `plan_confirmado`: una propuesta NUEVA exige una confirmación NUEVA.
 * Si no propone nada, el escenario vuelve intacto — no borra una pendiente
 * previa que el modelo simplemente no repitió en este turno.
 */
export function registrarPropuestaPendiente(
  scenario: ScenarioState,
  finalText: string,
): ScenarioState {
  if (!esPropuestaDePlan(finalText)) return scenario;
  const tipo = scenario.credito ? "credito" : scenario.meta ? "meta" : "general";
  return {
    ...scenario,
    propuesta_pendiente: { tipo, resumen: finalText.trim() },
    plan_confirmado: false,
  };
}

/**
 * Resumen compacto del estado para inyectar como "ESTADO ACTUAL CONOCIDO" en el
 * prompt (LLAMADA 1 de function calling). Texto plano, sin cifras derivadas: solo
 * lo que el usuario ya nos dijo. "" si no sabemos nada aún.
 */
export function summarizeScenario(s: Partial<ScenarioState> | undefined): string {
  if (!s) return "Nada aún — el usuario no ha aportado datos.";
  const l: string[] = [];
  if (s.ingreso_mensual !== undefined) l.push(`ingreso mensual: ${s.ingreso_mensual} €`);
  if (s.gastos_mensuales !== undefined) l.push(`gastos mensuales: ${s.gastos_mensuales} €`);
  if (s.credito) {
    const tae = s.credito.tae_pct !== undefined && !s.credito.tae_es_referencia
      ? `TAE real ${s.credito.tae_pct}%`
      : "sin TAE real aún";
    l.push(`crédito: ${s.credito.monto || "?"} € a ${s.credito.plazo_meses || "?"} meses (${tae})`);
  }
  if (s.meta) {
    const partes = [s.meta.titulo, s.meta.monto ? `${s.meta.monto} €` : "", s.meta.plazo_meses ? `${s.meta.plazo_meses} meses` : ""].filter(Boolean);
    if (partes.length) {
      // PIEZA 6 — la meta activa es UNA y el modelo tiene que saber si sigue
      // abierta: mientras lo esté, no se abre otra.
      l.push(`meta ${s.meta_cerrada ? "CERRADA" : "activa"} (única): ${partes.join(", ")}`);
    }
  }
  if (s.goals_cerradas && s.goals_cerradas.length > 0) {
    const titulos = s.goals_cerradas.map((g) => g.titulo ?? "sin título").join(", ");
    l.push(`metas ya cerradas: ${titulos}`);
  }
  if (s.missing && s.missing.length) l.push(`falta por saber: ${s.missing.join(", ")}`);
  // FIX C — PB7 EJECUCIÓN: el modelo necesita saber esto YA en la primera
  // llamada (una confirmación corta como "sí" no dispara tool_call, así que no
  // hay una segunda llamada donde colarlo) — si no, sigue diagnosticando en
  // vez de entregar el plan.
  if (s.plan_confirmado) {
    l.push("plan_confirmado: true — el usuario YA confirmó. PROHIBIDO re-diagnosticar: entrega el plan (PLAYBOOK 7).");
  } else if (s.propuesta_pendiente) {
    l.push(`propuesta pendiente de confirmar: "${s.propuesta_pendiente.resumen}"`);
  }
  return l.length ? l.map((x) => `- ${x}`).join("\n") : "Nada aún — el usuario no ha aportado datos.";
}

/**
 * Qué falta para el playbook activo. El playbook activo se infiere del estado:
 * si hay crédito → falta la TAE real y el sobrante; si hay meta → falta plazo o
 * monto; siempre conviene ingreso y gastos para dar capacidad.
 */
function computeMissing(s: ScenarioState): string[] {
  const missing: string[] = [];

  if (s.credito) {
    if (!s.credito.monto) missing.push("monto");
    if (!s.credito.plazo_meses) missing.push("plazo");
    // La TAE real es lo que convierte la simulación en cuota exacta.
    if (s.credito.tae_pct === undefined || s.credito.tae_es_referencia) missing.push("tae");
  }

  if (s.meta) {
    if (s.meta.monto === undefined) missing.push("meta_monto");
    if (s.meta.plazo_meses === undefined) missing.push("plazo");
  }

  if (s.ingreso_mensual === undefined) missing.push("ingreso");
  if (s.gastos_mensuales === undefined) missing.push("gastos");

  // Sin duplicados, preservando orden de prioridad.
  return [...new Set(missing)];
}

// ── PIEZA 4 (6ª tanda) — EL ICA MIDE CONOCIMIENTO, NO CHARLA ─────────────────
//
// Antes, cada turno sumaba +2 al ICA por el simple hecho de escribir
// ('chat_consulta'): un usuario con 13 mensajes y CERO datos aportados
// llegaba al 26%. Esta función compara el estado ANTES y DESPUÉS del merge
// de este turno y devuelve solo los eventos de conocimiento REALMENTE
// nuevos — el evento se dispara la PRIMERA vez que el campo pasa de
// desconocido a conocido, nunca al repetirlo o actualizarlo después (eso ya
// se sabía, no es conocimiento nuevo). `chat_consulta` NO vive aquí: es una
// traza de actividad aparte, no un evento de conocimiento (ver route.ts).

/** ¿Hay una TAE REAL (no de referencia) en `credito`? */
function tieneTaeReal(credito: CreditoState | undefined): boolean {
  return !!credito && credito.tae_pct !== undefined && credito.tae_es_referencia === false;
}

/**
 * Eventos de conocimiento nuevo entre `antes` (estado previo al turno) y
 * `despues` (estado tras el merge de este turno). Puro, determinista — no
 * decide puntos ni toca la BD, solo QUÉ pasó a saberse por primera vez.
 */
export function detectarEventosICA(
  antes: Partial<ScenarioState> | undefined,
  despues: ScenarioState,
): string[] {
  const eventos: string[] = [];

  if (antes?.ingreso_mensual === undefined && despues.ingreso_mensual !== undefined) {
    eventos.push("dato_ingreso");
  }
  if (antes?.gastos_mensuales === undefined && despues.gastos_mensuales !== undefined) {
    eventos.push("dato_gastos");
  }
  if (!antes?.tiene_detalle_gastos && despues.tiene_detalle_gastos) {
    eventos.push("detalle_gastos");
  }

  // Meta DECLARADA por el usuario (no derivada de un crédito): la primera vez
  // que pasa de "nada" o "derivada" a una meta propia.
  const metaAntesPropia = !!antes?.meta && !antes.meta_derivada;
  const metaDespuesPropia = !!despues.meta && !despues.meta_derivada;
  if (!metaAntesPropia && metaDespuesPropia) {
    eventos.push("meta_declarada");
  }

  if (!antes?.credito && despues.credito) {
    eventos.push("credito_declarado");
  }

  const plazoAntes = antes?.credito?.plazo_meses ?? antes?.meta?.plazo_meses;
  const plazoDespues = despues.credito?.plazo_meses ?? despues.meta?.plazo_meses;
  if (plazoAntes === undefined && plazoDespues !== undefined) {
    eventos.push("plazo_declarado");
  }

  if (!tieneTaeReal(antes?.credito) && tieneTaeReal(despues.credito)) {
    eventos.push("tae_declarada");
  }

  return eventos;
}
