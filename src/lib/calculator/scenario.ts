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
