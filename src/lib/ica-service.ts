import { adminClient } from './supabase/admin'
import { getICALevel } from './ica'

const EVENTO_DELTA = {
  transaccion_registrada: 5,
  meta_definida: 10,
  extracto_subido: 15,
  onboarding_completado: 20,
  hito_alcanzado: 25,
  // PIEZA 4 (6ª tanda) — el ICA mide CONOCIMIENTO, no charla. Antes, cada
  // consulta al chat sumaba +2 por el simple hecho de escribir (26% de un
  // usuario eran 13 mensajes, no datos aportados). Estos eventos son ADITIVOS
  // a la tabla existente — ninguno de los 5 pesos de arriba cambia — y se
  // disparan SOLO cuando el turno aporta un dato NUEVO y verificable
  // (scenario.ts detecta la transición undefined→definido; ver route.ts).
  dato_ingreso: 5,
  dato_gastos: 5,
  detalle_gastos: 5,
  meta_declarada: 10,
  credito_declarado: 10,
  plazo_declarado: 5,
  tae_declarada: 10,
  // El chat en sí (sin dato nuevo) ya NO puntúa — se conserva como traza de
  // actividad, con delta 0, para no perder el historial de interacción.
  chat_consulta: 0,
} as const

export type ICAEvento = keyof typeof EVENTO_DELTA

export const VALID_EVENTOS = Object.keys(EVENTO_DELTA) as ICAEvento[]

export function isValidEvento(s: string): s is ICAEvento {
  return VALID_EVENTOS.includes(s as ICAEvento)
}

export interface ICAHistoryEntry {
  score: number
  level: string | null
  event_trigger: string | null
  recorded_at: string
}

export function computeNewScore(current: number, evento: string): number {
  const delta = (EVENTO_DELTA as Record<string, number>)[evento] ?? 0
  return Math.min(100, Math.max(0, current + delta))
}

export async function getICAScore(userId: string): Promise<number> {
  const { data, error } = await adminClient()
    .from('ica_history')
    .select('score')
    .eq('user_id', userId)
    .order('recorded_at', { ascending: false })
    .limit(1)
    .maybeSingle()

  if (error) throw error
  return (data as { score: number } | null)?.score ?? 0
}

export async function updateICAScore(
  userId: string,
  evento: string,
): Promise<number> {
  const current = await getICAScore(userId)
  const newScore = computeNewScore(current, evento)
  const level = getICALevel(newScore)
  const sb = adminClient()

  const [histResult, profResult] = await Promise.all([
    sb.from('ica_history').insert({ user_id: userId, score: newScore, level, event_trigger: evento }),
    sb.from('profiles').update({ ica_score: newScore }).eq('user_id', userId),
  ])

  if (histResult.error) throw histResult.error
  if (profResult.error) throw profResult.error

  return newScore
}

export async function getICAHistory(
  userId: string,
  dias: number,
): Promise<ICAHistoryEntry[]> {
  const since = new Date(Date.now() - dias * 24 * 60 * 60 * 1000).toISOString()

  const { data, error } = await adminClient()
    .from('ica_history')
    .select('score, level, event_trigger, recorded_at')
    .eq('user_id', userId)
    .gte('recorded_at', since)
    .order('recorded_at', { ascending: true })

  if (error) throw error
  return (data ?? []) as ICAHistoryEntry[]
}
