// SCENARIO STATE — el motor recuerda entre turnos.
//
// Causa raíz (QA): el motor era stateless (solo veía el último mensaje), así que
// "el banco me ofrece un 9%" no recalculaba nada — no había crédito en contexto
// que actualizar. Este módulo acumula el escenario financiero del diálogo y se
// persiste en conversations.scenario_state (migración 010).
//
// Extracción CONSERVADORA: solo señales de alta confianza. Lo ambiguo NO se
// extrae — mejor no tocar el estado que corromperlo. Código PURO, edge-safe.

import { parseDigitAmount } from "../guardrail/numbers";
import { parseExpenseList, classifyExpenses } from "./expenses";
import type { Language } from "../language";

export interface GastosDetalle {
  vitales: number;
  noVitales: number;
  desconocidos: number;
}

export interface CreditoState {
  monto: number;
  plazo_meses: number;
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
const PRECIO_CTX = /\b(precio|cuesta|vale|financiar|credito|prestamo|emprestimo|loan|financ|carro|coche|auto|casa|piso|vivienda)\b/;
const AMOUNT = /(\d[\d.,]*)/;

// Meta.
const META_CTX = /\b(meta|objetivo|quiero (?:comprar|llegar|ahorrar)|goal|target|juntar|reunir)\b/;

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
        delta.credito = { monto: 0, plazo_meses: 0, tae_pct: tae, tae_es_referencia: false };
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
        delta.credito = { monto: 0, plazo_meses: 0, tae_pct: tae, tae_es_referencia: false };
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
    if (a) {
      const v = parseDigitAmount(a[1]);
      if (Number.isFinite(v) && v > 0) delta.ingreso_mensual = v;
    }
  }

  // ── Gastos ──────────────────────────────────────────────────────────────────
  if (esLista) {
    // Lista desglosada: gastos_detalle con totales por grupo. NO se toca
    // gastos_mensuales (el merge conserva el agregado previo — defecto B).
    const cls = classifyExpenses(listItems);
    delta.gastos_detalle = {
      vitales: cls.vitales.total,
      noVitales: cls.noVitales.total,
      desconocidos: cls.desconocidos.total,
    };
    delta.gastos_es_detalle = true;
  } else if (GASTO_CTX.test(n)) {
    // Agregado en una sola cifra ("mis gastos son 1500").
    const a = AMOUNT.exec(n.slice(n.search(GASTO_CTX)));
    if (a) {
      const v = parseDigitAmount(a[1]);
      if (Number.isFinite(v) && v > 0) delta.gastos_mensuales = v;
    }
  }

  // ── Meta ───────────────────────────────────────────────────────────────────
  if (META_CTX.test(n)) {
    const plazo = PLAZO.exec(n);
    const a = AMOUNT.exec(n.replace(PLAZO, " "));
    const meta: MetaState = {};
    if (a) {
      const v = parseDigitAmount(a[1]);
      if (Number.isFinite(v) && v > 0) meta.monto = v;
    }
    if (plazo) meta.plazo_meses = toMonths(parseDigitAmount(plazo[1]), plazo[2]);
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

function round2(n: number): number {
  return Math.round((n + Number.EPSILON) * 100) / 100;
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

  // Meta EXPLÍCITA del usuario: pisa cualquier meta derivada y apaga el flag
  // para siempre (ver `meta_derivada` más abajo).
  if (delta.meta !== undefined) {
    base.meta = { ...(base.meta ?? {}), ...delta.meta };
    base.meta_derivada = false;
  }

  // FIX C — confirmación corta ("sí") con propuesta pendiente → PB7 ejecuta.
  // Se limpia la pendiente: ya cumplió su propósito, y así una nueva propuesta
  // (route.ts, tras generar la respuesta) puede detectarse limpiamente.
  if (delta.plan_confirmado) {
    base.plan_confirmado = true;
    base.propuesta_pendiente = undefined;
  }

  if (delta.credito !== undefined) {
    const merged: CreditoState = {
      ...(base.credito ?? { monto: 0, plazo_meses: 0, tae_es_referencia: true }),
    };
    if (delta.credito.monto) merged.monto = delta.credito.monto;
    if (delta.credito.plazo_meses) merged.plazo_meses = delta.credito.plazo_meses;
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
  if (base.credito && base.credito.monto > 0 && (base.meta === undefined || base.meta_derivada)) {
    base.meta = {
      titulo: base.credito.objeto ? capitalize(base.credito.objeto) : "compra financiada",
      monto: base.credito.monto,
      plazo_meses: base.credito.plazo_meses,
    };
    base.meta_derivada = true;
  }

  base.missing = computeMissing(base);
  return base;
}

function capitalize(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
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
    if (partes.length) l.push(`meta: ${partes.join(", ")}`);
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
