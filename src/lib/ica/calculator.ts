/**
 * @module ica/calculator
 * Cálculo del ICA — "Lo que sé de ti" (post-pivot AaaS).
 *
 * Fuente canónica de fórmulas: `FORMULAS_IDF_ICA.md` (pendiente en disco;
 * mientras tanto este módulo y sus tests son la referencia). El ICA antiguo
 * (puntos por evento) sigue en `src/lib/ica.ts` para compatibilidad con
 * `ica_history`; este motor lo reemplaza en superficie de producto y
 * coexiste hasta que se complete la migración.
 *
 * No hay función SQL equivalente (a diferencia de IDF): el cálculo es
 * íntegramente TypeScript leyendo de Supabase. Es un agregado relativamente
 * caro (varias queries); pensado para invocarse server-side bajo demanda,
 * no en cada request.
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import { adminClient } from '../supabase/admin';
import type { ICAComponents, ICAResult } from './types';

// ─── Constantes de fórmula ─────────────────────────────────────────────────

/**
 * Pesos por dimensión (suma 1.00). Ver §ICA-Ponderación.
 *
 * Diseño: profundidad e historia priman porque son la base sobre la que el
 * Consigliere puede razonar; engagement no se sobrepondera para evitar
 * gamificar el chat por sí mismo.
 */
const PESOS = {
  perfilCompleto: 0.20,
  profundidadHistorica: 0.25,
  diversidadFuentes: 0.20,
  consistencia: 0.15,
  engagement: 0.20,
} as const;

// ─── Tipos internos de datos ───────────────────────────────────────────────

interface ProfileRow {
  name: string | null;
  country: string | null;
  language: string | null;
  onboarding_done: boolean | null;
  created_at: string | null;
}

interface FiscalRow {
  country: string | null;
  employment_type: string | null;
  monthly_gross: number | null;
}

interface GoalRow {
  category: string | null;
  status: string | null;
}

interface TxLite {
  type: 'income' | 'expense';
  category: string | null;
  date: string; // ISO date
}

/**
 * Datos agregados que alimentan el cálculo. Exportado para tests que
 * quieran ejercitar `computeICAFromData` sin Supabase.
 */
export interface ICAInputs {
  profile: ProfileRow | null;
  fiscal: FiscalRow | null;
  goals: GoalRow[];
  transactions: TxLite[];
  userMessagesLast30d: number;
}

export interface CalcularICAOpts {
  client?: SupabaseClient;
  /** "Ahora" para tests deterministas. */
  now?: Date;
}

// ─── API principal ─────────────────────────────────────────────────────────

/**
 * Calcula el ICA del usuario. Lee de `profiles`, `fiscal_profiles`,
 * `goals`, `transactions` y `messages`.
 *
 * @param userId UUID en `auth.users`.
 * @param opts   Inyecciones opcionales para tests.
 */
export async function calcularICA(
  userId: string,
  opts: CalcularICAOpts = {},
): Promise<ICAResult> {
  const client = opts.client ?? adminClient();
  const now = opts.now ?? new Date();

  const [profile, fiscal, goals, transactions, userMessagesLast30d] = await Promise.all([
    fetchProfile(client, userId),
    fetchFiscal(client, userId),
    fetchGoals(client, userId),
    fetchTransactions(client, userId),
    fetchUserMessagesLast30d(client, userId, now),
  ]);

  return computeICAFromData(
    { profile, fiscal, goals, transactions, userMessagesLast30d },
    now,
  );
}

/**
 * Núcleo puro. Dadas las entradas agregadas, devuelve el ICAResult.
 *
 * Cada dimensión se documenta donde se implementa. Ver §ICA-Núcleo.
 */
export function computeICAFromData(inputs: ICAInputs, now: Date): ICAResult {
  const components: ICAComponents = {
    perfilCompleto: dimPerfilCompleto(inputs.profile, inputs.fiscal),
    profundidadHistorica: dimProfundidadHistorica(inputs.transactions, now),
    diversidadFuentes: dimDiversidadFuentes(inputs.transactions, inputs.goals),
    consistencia: dimConsistencia(inputs.transactions, now),
    engagement: dimEngagement(inputs.userMessagesLast30d),
  };

  const weighted =
    PESOS.perfilCompleto * components.perfilCompleto +
    PESOS.profundidadHistorica * components.profundidadHistorica +
    PESOS.diversidadFuentes * components.diversidadFuentes +
    PESOS.consistencia * components.consistencia +
    PESOS.engagement * components.engagement;

  const score = clamp01_100(Math.round(weighted));

  return {
    score,
    narrativeLevel: narrativeLevelFor(score),
    components,
    computedAt: now.toISOString(),
  };
}

// ─── Dimensiones puras ─────────────────────────────────────────────────────

/**
 * §ICA-1 Perfil completo (peso 20%).
 *
 * Cuenta 6 campos identitarios: name, country, language, onboarding_done,
 * fiscal.country, fiscal.employment_type y fiscal.monthly_gross. Cada uno
 * presente suma ~14.3 puntos (100/7); el límite duro es 100.
 *
 * Decisión: language no descuenta si es el default 'es' (todos los usuarios
 * lo tienen). Solo cuenta si está explícitamente declarado != null.
 */
function dimPerfilCompleto(profile: ProfileRow | null, fiscal: FiscalRow | null): number {
  if (!profile) return 0;
  const FIELDS = 7;
  let filled = 0;
  if (nonEmpty(profile.name)) filled++;
  if (nonEmpty(profile.country)) filled++;
  if (nonEmpty(profile.language)) filled++;
  if (profile.onboarding_done === true) filled++;
  if (fiscal && nonEmpty(fiscal.country)) filled++;
  if (fiscal && nonEmpty(fiscal.employment_type)) filled++;
  if (fiscal && typeof fiscal.monthly_gross === 'number' && fiscal.monthly_gross > 0) filled++;
  return Math.round((filled / FIELDS) * 100);
}

/**
 * §ICA-2 Profundidad histórica (peso 25%).
 *
 * Mide cuántos meses de datos (distintos) ha aportado el usuario. Escala
 * lineal: 0 meses → 0, 12+ meses → 100. Un mes "cuenta" si tiene al menos
 * una transacción.
 */
function dimProfundidadHistorica(txs: TxLite[], now: Date): number {
  if (txs.length === 0) return 0;
  const FULL = 12;
  const months = new Set<string>();
  for (const t of txs) {
    months.add(monthKey(t.date));
  }
  // Tomamos como máximo los últimos 12 meses naturales (incluye el actual).
  const horizon = new Date(now);
  horizon.setUTCMonth(horizon.getUTCMonth() - (FULL - 1));
  const cutoff = monthKey(horizon.toISOString());
  let count = 0;
  for (const k of months) {
    if (k >= cutoff) count++;
  }
  return Math.round((Math.min(count, FULL) / FULL) * 100);
}

/**
 * §ICA-3 Diversidad de fuentes (peso 20%).
 *
 * Cuenta categorías distintas en transacciones (no nulas) + categorías de
 * metas declaradas. 0 categorías → 0; 5+ categorías → 100; lineal.
 *
 * Razón: 5 categorías cubre razonablemente las dimensiones básicas
 * (vivienda, alimentación, transporte, ocio, otros).
 */
function dimDiversidadFuentes(txs: TxLite[], goals: GoalRow[]): number {
  const FULL = 5;
  const cats = new Set<string>();
  for (const t of txs) if (nonEmpty(t.category)) cats.add(t.category!);
  for (const g of goals) if (nonEmpty(g.category)) cats.add(`goal:${g.category}`);
  // Bonus: si hay tanto income como expense cuenta como una "fuente" extra.
  const hasIncome = txs.some(t => t.type === 'income');
  const hasExpense = txs.some(t => t.type === 'expense');
  if (hasIncome && hasExpense) cats.add('__type_mix__');
  return Math.round((Math.min(cats.size, FULL) / FULL) * 100);
}

/**
 * §ICA-4 Consistencia (peso 15%).
 *
 * Porcentaje de semanas activas en las últimas 8: una semana es "activa"
 * si tiene al menos una transacción. 0/8 → 0; 8/8 → 100.
 *
 * Diseño: ventana corta para reflejar comportamiento reciente; el promedio
 * de 8 semanas amortigua semanas atípicas (vacaciones, viajes).
 */
function dimConsistencia(txs: TxLite[], now: Date): number {
  const WEEKS = 8;
  if (txs.length === 0) return 0;
  const cutoff = new Date(now);
  cutoff.setUTCDate(cutoff.getUTCDate() - WEEKS * 7);
  const weeks = new Set<string>();
  for (const t of txs) {
    const d = new Date(t.date);
    if (Number.isNaN(d.getTime())) continue;
    if (d < cutoff) continue;
    weeks.add(weekKey(d));
  }
  return Math.round((Math.min(weeks.size, WEEKS) / WEEKS) * 100);
}

/**
 * §ICA-5 Engagement (peso 20%).
 *
 * Número de mensajes `role='user'` en los últimos 30 días. Escala log-like:
 *   0 mensajes      →   0
 *   1–4             →  20
 *   5–9             →  40
 *   10–19           →  60
 *   20–39           →  80
 *   ≥ 40            → 100
 *
 * Razón: el engagement útil satura rápido — 40+ queries/mes ya implica un
 * usuario que conversa frecuentemente con el Consigliere; subir más no
 * aporta señal adicional para "lo que sé de ti".
 */
function dimEngagement(userMessagesLast30d: number): number {
  if (userMessagesLast30d <= 0) return 0;
  if (userMessagesLast30d < 5) return 20;
  if (userMessagesLast30d < 10) return 40;
  if (userMessagesLast30d < 20) return 60;
  if (userMessagesLast30d < 40) return 80;
  return 100;
}

// ─── Narrative levels ──────────────────────────────────────────────────────

/** §ICA-Niveles narrativos. */
function narrativeLevelFor(score: number): string {
  if (score <= 20) return 'Apenas comenzando';
  if (score <= 40) return 'Construyendo visión';
  if (score <= 60) return 'Dominio en formación';
  if (score <= 80) return 'Visión clara';
  return 'Dominio total';
}

// ─── Fetchers ─────────────────────────────────────────────────────────────

async function fetchProfile(client: SupabaseClient, userId: string): Promise<ProfileRow | null> {
  const { data } = await client
    .from('profiles')
    .select('name, country, language, onboarding_done, created_at')
    .eq('user_id', userId)
    .maybeSingle();
  return (data as ProfileRow | null) ?? null;
}

async function fetchFiscal(client: SupabaseClient, userId: string): Promise<FiscalRow | null> {
  const { data } = await client
    .from('fiscal_profiles')
    .select('country, employment_type, monthly_gross')
    .eq('user_id', userId)
    .maybeSingle();
  return (data as FiscalRow | null) ?? null;
}

async function fetchGoals(client: SupabaseClient, userId: string): Promise<GoalRow[]> {
  const { data } = await client
    .from('goals')
    .select('category, status')
    .eq('user_id', userId);
  return ((data as GoalRow[] | null) ?? []);
}

async function fetchTransactions(client: SupabaseClient, userId: string): Promise<TxLite[]> {
  const { data } = await client
    .from('transactions')
    .select('type, category, date')
    .eq('user_id', userId);
  return ((data as TxLite[] | null) ?? []);
}

async function fetchUserMessagesLast30d(
  client: SupabaseClient,
  userId: string,
  now: Date,
): Promise<number> {
  const since = new Date(now);
  since.setUTCDate(since.getUTCDate() - 30);
  const { count } = await client
    .from('messages')
    .select('id', { count: 'exact', head: true })
    .eq('user_id', userId)
    .eq('role', 'user')
    .gte('created_at', since.toISOString());
  return count ?? 0;
}

// ─── Helpers ──────────────────────────────────────────────────────────────

function nonEmpty(v: string | null | undefined): boolean {
  return typeof v === 'string' && v.trim().length > 0;
}

function clamp01_100(n: number): number {
  return Math.min(100, Math.max(0, n));
}

function monthKey(iso: string): string {
  return iso.slice(0, 7); // 'YYYY-MM'
}

function weekKey(d: Date): string {
  const utc = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
  const dayOfWeek = (utc.getUTCDay() + 6) % 7; // lunes=0
  utc.setUTCDate(utc.getUTCDate() - dayOfWeek);
  return utc.toISOString().slice(0, 10);
}
