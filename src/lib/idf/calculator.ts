/**
 * @module idf/calculator
 * Calculador del IDF (Índice de Dominio Financiero).
 *
 * Estrategia:
 *  1. PRIMERA OPCIÓN — invocar la función SQL `calcular_idf_dimensions`
 *     (Ag02, `supabase/migrations/008_idf_function.sql`). Las fórmulas viven
 *     en BD para garantizar consistencia entre lecturas server-side y
 *     triggers futuros.
 *  2. FALLBACK — si la RPC aún no está desplegada o falla por código
 *     `42883` ("function does not exist"), recalculamos en TypeScript leyendo
 *     directamente de `goals` y `transactions`. Marcado como TODO: retirar
 *     el fallback cuando 008 esté garantizado en todos los entornos
 *     (incluidos branches QA).
 *
 * Fuente canónica de fórmulas: `FORMULAS_IDF_ICA.md` (pendiente). El
 * contrato vigente es la traducción fiel de `src/lib/idf.ts` reflejada en
 * la migración 008.
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import { adminClient } from '../supabase/admin';
import type { IDFComponents, IDFLevel, IDFResult } from './types';

// ─── Constantes de fórmula ─────────────────────────────────────────────────

/**
 * Pesos por dimensión (deben sumar 1.00). Ver §IDF-Ponderación en
 * FORMULAS_IDF_ICA.md.
 */
const PESOS = {
  progresoMeta: 0.40,
  controlFugas: 0.25,
  estabilidadBase: 0.20,
  velocidadAhorro: 0.15,
} as const;

const FUNCTION_NOT_FOUND_CODE = '42883';
const FUNCTION_NOT_FOUND_HINTS = ['could not find', 'does not exist', 'pgrst202'];

// ─── Tipos internos de datos ───────────────────────────────────────────────

interface GoalRow {
  id: string;
  target_amount: number;
  created_at: string;
  baseline_data: { starting_amount?: number | string } | null;
}

interface TxRow {
  type: 'income' | 'expense';
  amount: number;
  is_leak: boolean | null;
  date: string;
}

/**
 * Inyección de un cliente Supabase alternativo (para tests). Si se omite se
 * usa el `adminClient()` por defecto.
 */
export interface CalcularIDFOpts {
  client?: SupabaseClient;
  /** Marca temporal usada como "ahora" (default: `new Date()`). Útil en tests. */
  now?: Date;
  /**
   * Si es `true`, se salta el intento de RPC y se evalúa directamente la
   * implementación TypeScript. Útil en tests del fallback.
   */
  forceFallback?: boolean;
}

// ─── API principal ─────────────────────────────────────────────────────────

/**
 * Calcula el IDF de un usuario.
 *
 * @param userId UUID del usuario en `auth.users`.
 * @param opts   Inyecciones opcionales para tests.
 * @returns      `IDFResult` con score 0–100 (o `null`), nivel y desglose.
 *
 * @remarks
 *  - Sin meta activa: `score = null`, `level = null`,
 *    `reason = 'no_goal_declared'`, todos los componentes en `null`.
 *  - Si la RPC SQL responde, se mapea su salida a `IDFResult`.
 *  - Si la RPC falla por inexistencia, se cae al cálculo TS (idéntica fórmula).
 */
export async function calcularIDF(
  userId: string,
  opts: CalcularIDFOpts = {},
): Promise<IDFResult> {
  const client = opts.client ?? adminClient();
  const now = opts.now ?? new Date();

  if (!opts.forceFallback) {
    const rpc = await tryRpc(client, userId, now);
    if (rpc !== null) return rpc;
  }

  // TODO(ag06): eliminar este fallback cuando la migración 008 esté
  // confirmada en todos los entornos (production, develop, branches).
  return calcularIDFFallback(client, userId, now);
}

// ─── Path 1: RPC SQL ───────────────────────────────────────────────────────

async function tryRpc(
  client: SupabaseClient,
  userId: string,
  now: Date,
): Promise<IDFResult | null> {
  let res;
  try {
    res = await client.rpc('calcular_idf_dimensions', { p_user_id: userId });
  } catch {
    return null;
  }
  const { data, error } = res;

  if (error) {
    const code = (error.code ?? '').toString();
    const msg = (error.message ?? '').toLowerCase();
    if (code === FUNCTION_NOT_FOUND_CODE) return null;
    if (FUNCTION_NOT_FOUND_HINTS.some(h => msg.includes(h))) return null;
    return null;
  }
  if (!data || typeof data !== 'object') return null;

  return mapRpcPayload(data as Record<string, unknown>, now);
}

/**
 * Convierte la salida JSONB de `calcular_idf_dimensions` (snake_case, escala
 * 0–100 por componente) al contrato `IDFResult` (camelCase). Ver
 * §IDF-Mapeo-RPC en FORMULAS_IDF_ICA.md.
 */
function mapRpcPayload(payload: Record<string, unknown>, now: Date): IDFResult {
  const computedAt = (payload['calculado_en'] as string | undefined) ?? now.toISOString();
  const idfTotal = payload['idf_total'];
  const dataAvailable = payload['datos_disponibles'] === true;

  if (idfTotal === null || idfTotal === undefined) {
    return {
      score: null,
      level: null,
      components: emptyComponents(),
      dataAvailable,
      computedAt,
      reason: (payload['razon'] as string | undefined) ?? 'no_goal_declared',
    };
  }

  const componentes = (payload['componentes_calculables'] as string[] | undefined) ?? [];
  const has = (name: string) => componentes.length === 0 || componentes.includes(name);

  const components: IDFComponents = {
    progresoMeta: has('progreso_meta') ? toIntOrNull(payload['progreso_meta']) : null,
    controlFugas: has('control_fugas') ? toIntOrNull(payload['control_fugas']) : null,
    estabilidadBase: has('estabilidad_base') ? toIntOrNull(payload['estabilidad_base']) : null,
    velocidadAhorro: has('velocidad_ahorro') ? toIntOrNull(payload['velocidad_ahorro']) : null,
  };

  const nivel = (payload['nivel'] as IDFLevel | undefined) ?? levelFromScore(Number(idfTotal));

  return {
    score: Number(idfTotal),
    level: nivel,
    components,
    dataAvailable,
    computedAt,
  };
}

// ─── Path 2: fallback TypeScript ───────────────────────────────────────────

/**
 * Reimplementación TS de las fórmulas. Solo se ejecuta si la RPC no está
 * disponible. Lee directamente `goals` (meta activa más reciente) y
 * `transactions` (mes en curso y desde `goal.created_at`).
 *
 * Mantener fielmente alineada con `008_idf_function.sql`. Ver
 * §IDF-Fallback-TS en FORMULAS_IDF_ICA.md.
 */
async function calcularIDFFallback(
  client: SupabaseClient,
  userId: string,
  now: Date,
): Promise<IDFResult> {
  const computedAt = now.toISOString();

  // 1. Meta activa más reciente
  const goalRes = await client
    .from('goals')
    .select('id, target_amount, created_at, baseline_data')
    .eq('user_id', userId)
    .eq('status', 'active')
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle();

  if (goalRes.error || !goalRes.data) {
    return {
      score: null,
      level: null,
      components: emptyComponents(),
      dataAvailable: false,
      computedAt,
      reason: 'no_goal_declared',
    };
  }
  const goal = goalRes.data as GoalRow;

  // 2. Transacciones del mes en curso (para fugas/estabilidad/velocidad)
  const periodoDesde = firstDayOfMonth(now);
  const periodoHasta = onlyDate(now);
  const txMonthRes = await client
    .from('transactions')
    .select('type, amount, is_leak, date')
    .eq('user_id', userId)
    .gte('date', periodoDesde)
    .lte('date', periodoHasta);

  const txMonth: TxRow[] = ((txMonthRes.data as TxRow[] | null) ?? []).map(normalizeTx);

  // 3. Transacciones desde goal.created_at (para acumulado meta)
  const desdeMeta = onlyDate(new Date(goal.created_at));
  const txGoalRes = await client
    .from('transactions')
    .select('type, amount, is_leak, date')
    .eq('user_id', userId)
    .gte('date', desdeMeta);

  const txDesdeGoal: TxRow[] = ((txGoalRes.data as TxRow[] | null) ?? []).map(normalizeTx);

  return computeFromData(goal, txMonth, txDesdeGoal, computedAt);
}

/**
 * Núcleo puro: dadas la meta y las transacciones, devuelve el `IDFResult`.
 * Exportada para tests deterministas sin Supabase. Ver §IDF-Núcleo en
 * FORMULAS_IDF_ICA.md.
 */
export function computeFromData(
  goal: GoalRow,
  txMonth: TxRow[],
  txDesdeGoal: TxRow[],
  computedAt: string,
): IDFResult {
  const ingresosMes = sum(txMonth, t => t.type === 'income', t => t.amount);
  const gastosMes = sum(txMonth, t => t.type === 'expense', t => t.amount);
  const fugasMes = sum(
    txMonth,
    t => t.type === 'expense' && t.is_leak === true,
    t => t.amount,
  );

  const baseline = toNumber(goal.baseline_data?.starting_amount ?? 0);
  const netDesdeMeta = txDesdeGoal.reduce((s, t) => {
    if (t.type === 'income') return s + t.amount;
    if (t.type === 'expense') return s - t.amount;
    return s;
  }, 0);
  const acumuladoMeta = baseline + netDesdeMeta;

  const hasTxPeriod = txMonth.length > 0;
  const hasTxSinceGoal = txDesdeGoal.length > 0;

  const progresoMeta = dimProgresoMeta(goal.target_amount, acumuladoMeta);
  const controlFugas = dimControlFugas(ingresosMes, fugasMes);
  const estabilidadBase = dimEstabilidadBase(ingresosMes, gastosMes);
  const velocidadAhorro = dimVelocidadAhorro(ingresosMes, gastosMes);

  // `null` significa "no calculable por falta de datos en esa dimensión"
  // (alineado con el array `componentes_calculables` del SQL).
  const components: IDFComponents = {
    progresoMeta: baseline > 0 || hasTxSinceGoal ? progresoMeta : null,
    controlFugas: ingresosMes > 0 || fugasMes > 0 ? controlFugas : null,
    estabilidadBase: hasTxPeriod ? estabilidadBase : null,
    velocidadAhorro: ingresosMes > 0 ? velocidadAhorro : null,
  };

  const total =
    PESOS.progresoMeta * progresoMeta +
    PESOS.controlFugas * controlFugas +
    PESOS.estabilidadBase * estabilidadBase +
    PESOS.velocidadAhorro * velocidadAhorro;
  const score = Math.min(100, Math.max(0, Math.round(total)));

  return {
    score,
    level: levelFromScore(score),
    components,
    dataAvailable: hasTxPeriod || hasTxSinceGoal || baseline > 0,
    computedAt,
  };
}

// ─── Dimensiones puras ─────────────────────────────────────────────────────

/**
 * §IDF-1 Progreso al objetivo (peso 40%). Ratio acumulado/target * 100,
 * cap a 100. Si `target <= 0` → 0.
 */
function dimProgresoMeta(targetAmount: number, acumulado: number): number {
  if (targetAmount <= 0) return 0;
  const ratio = acumulado / targetAmount;
  return Math.min(100, Math.max(0, ratio * 100));
}

/**
 * §IDF-2 Control de fugas (peso 25%). Traducción fiel de
 * `dimControlFugas` (idf.ts) escalada a 0–100:
 *   fugas ≤ 0                → 100
 *   ingresos ≤ 0 con fugas   →  20  (penalización máxima)
 *   ratio < 10%              →  80
 *   ratio < 20%              →  48
 *   ratio ≥ 20%              →  20
 */
function dimControlFugas(ingresos: number, fugas: number): number {
  if (fugas <= 0) return 100;
  if (ingresos <= 0) return 20;
  const ratio = fugas / ingresos;
  if (ratio < 0.10) return 80;
  if (ratio < 0.20) return 48;
  return 20;
}

/**
 * §IDF-3 Estabilidad base (peso 20%).
 *   sin actividad          →   0
 *   ingresos > gastos      → 100
 *   ingresos = gastos      →  50
 *   ingresos < gastos      →   0
 */
function dimEstabilidadBase(ingresos: number, gastos: number): number {
  if (ingresos === 0 && gastos === 0) return 0;
  if (ingresos > gastos) return 100;
  if (ingresos === gastos) return 50;
  return 0;
}

/**
 * §IDF-4 Velocidad de ahorro (peso 15%).
 *   ahorro ≤ 0 o ingresos ≤ 0  →   0
 *   ratio > 20%                → 100
 *   ratio ∈ [10%, 20%]         →  67  (~10/15 · 100)
 *   ratio ∈ [1%, 10%)          →  33  (~5/15 · 100)
 *   ratio < 1%                 →   0
 */
function dimVelocidadAhorro(ingresos: number, gastos: number): number {
  const ahorro = ingresos - gastos;
  if (ahorro <= 0 || ingresos <= 0) return 0;
  const ratio = ahorro / ingresos;
  if (ratio > 0.20) return 100;
  if (ratio >= 0.10) return 67;
  if (ratio >= 0.01) return 33;
  return 0;
}

// ─── Helpers ──────────────────────────────────────────────────────────────

function levelFromScore(score: number): IDFLevel {
  if (score <= 25) return 'bronce';
  if (score <= 50) return 'plata';
  if (score <= 75) return 'oro';
  return 'diamante';
}

function emptyComponents(): IDFComponents {
  return {
    progresoMeta: null,
    controlFugas: null,
    estabilidadBase: null,
    velocidadAhorro: null,
  };
}

function sum<T>(
  arr: T[],
  pred: (t: T) => boolean,
  pick: (t: T) => number,
): number {
  return arr.filter(pred).reduce((s, t) => s + pick(t), 0);
}

function toNumber(v: unknown): number {
  if (typeof v === 'number') return Number.isFinite(v) ? v : 0;
  if (typeof v === 'string') {
    const n = Number(v);
    return Number.isFinite(n) ? n : 0;
  }
  return 0;
}

function toIntOrNull(v: unknown): number | null {
  if (v === null || v === undefined) return null;
  const n = toNumber(v);
  return Math.round(n);
}

function normalizeTx(t: TxRow): TxRow {
  return {
    type: t.type,
    amount: toNumber(t.amount),
    is_leak: t.is_leak ?? false,
    date: t.date,
  };
}

function firstDayOfMonth(d: Date): string {
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, '0');
  return `${y}-${m}-01`;
}

function onlyDate(d: Date): string {
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, '0');
  const day = String(d.getUTCDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

// ─── Tipos auxiliares re-exportados para tests ─────────────────────────────

export type { GoalRow, TxRow };
