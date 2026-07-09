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
  credito?: CreditoState;
  meta?: MetaState;
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

// Plazo en meses o años.
const PLAZO = /(\d[\d.,]*)\s*(a[ñn]os?|anos?|years?|meses|mes|months?)\b/;

// Monto con contexto de ingreso / gasto / precio.
const INGRESO_CTX = /\b(gano|ingreso|ingresos|sueldo|salario|cobro|rendimento|income|earn|salary)\b/;
const GASTO_CTX = /\b(gasto|gastos|gasta|despesas?|spend|expenses?)\b/;
const PRECIO_CTX = /\b(precio|cuesta|vale|financiar|credito|prestamo|emprestimo|loan|financ|carro|coche|auto|casa|piso|vivienda)\b/;
const AMOUNT = /(\d[\d.,]*)/;

// Meta.
const META_CTX = /\b(meta|objetivo|quiero (?:comprar|llegar|ahorrar)|goal|target|juntar|reunir)\b/;

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
): Partial<ScenarioState> {
  void lang; // los patrones ya cubren ES/PT/EN; el idioma queda para afinar a futuro
  const delta: Partial<ScenarioState> = {};
  const n = norm(message);

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

  // ── Crédito: monto + plazo en la misma frase de precio/financiación ───────
  if (PRECIO_CTX.test(n)) {
    const plazo = PLAZO.exec(n);
    const amount = AMOUNT.exec(n.replace(PLAZO, " ")); // no confundir el plazo con el monto
    if (plazo && amount) {
      const meses = toMonths(parseDigitAmount(plazo[1]), plazo[2]);
      const monto = parseDigitAmount(amount[1]);
      if (Number.isFinite(monto) && monto > 0 && meses > 0) {
        delta.credito = {
          ...(delta.credito ?? { tae_es_referencia: true }),
          monto,
          plazo_meses: meses,
        };
      }
    }
  }

  // ── Ingreso ────────────────────────────────────────────────────────────────
  if (INGRESO_CTX.test(n)) {
    const a = AMOUNT.exec(n.slice(n.search(INGRESO_CTX)));
    if (a) {
      const v = parseDigitAmount(a[1]);
      if (Number.isFinite(v) && v > 0) delta.ingreso_mensual = v;
    }
  }

  // ── Gasto (agregado) ───────────────────────────────────────────────────────
  if (GASTO_CTX.test(n)) {
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

/**
 * Fusiona el estado previo con un delta. Merge por campo, ÚLTIMO gana. El crédito
 * se fusiona a nivel de subcampo (una TAE nueva no borra el monto). Si llega una
 * TAE real, `tae_es_referencia` pasa a false. Recalcula `missing`.
 */
export function mergeScenario(
  prev: ScenarioState | Partial<ScenarioState> | undefined,
  delta: Partial<ScenarioState>,
): ScenarioState {
  const base: ScenarioState = { missing: [], ...(prev ?? {}) };

  if (delta.ingreso_mensual !== undefined) base.ingreso_mensual = delta.ingreso_mensual;
  if (delta.gastos_mensuales !== undefined) base.gastos_mensuales = delta.gastos_mensuales;
  if (delta.gastos_detalle !== undefined) base.gastos_detalle = delta.gastos_detalle;
  if (delta.meta !== undefined) base.meta = { ...(base.meta ?? {}), ...delta.meta };

  if (delta.credito !== undefined) {
    const merged: CreditoState = {
      ...(base.credito ?? { monto: 0, plazo_meses: 0, tae_es_referencia: true }),
    };
    if (delta.credito.monto) merged.monto = delta.credito.monto;
    if (delta.credito.plazo_meses) merged.plazo_meses = delta.credito.plazo_meses;
    if (delta.credito.tae_pct !== undefined) {
      merged.tae_pct = delta.credito.tae_pct;
      // Una TAE aportada por el usuario deja de ser la de referencia.
      merged.tae_es_referencia = delta.credito.tae_es_referencia;
    }
    base.credito = merged;
  }

  base.missing = computeMissing(base);
  return base;
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
