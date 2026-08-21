// PURGA DE TEXTO DE TELEMETRÍA — ciclo de vida GDPR desde el día 1 (AG02).
//
// Núcleo COMPARTIDO entre `scripts/telemetry-purge.ts` (CLI manual) y
// `src/app/api/cron/telemetry-purge/route.ts` (cron diario 04:00 UTC): ambos
// llaman a `purgeTelemetryText`. Ninguno duplica el corte ni el estimado de
// bytes (mismo patrón que AG07 con `telemetry-review.ts`).
//
// `response_telemetry` (migración 011) guarda `response_raw`/`response_final`
// completos — necesarios para la revisión nocturna (G1b) mientras el turno es
// reciente, pero ~3-5 KB/fila es insostenible a escala (~2 GB/mes con 1.000
// usuarios). Esta purga pone esas dos columnas a NULL pasados 30 días; el
// resto de columnas (latencias, tokens, model, carril, conceptos, mutations,
// commandment_violations) se CONSERVA íntegro — son las que alimentan D5
// (métricas) y no contienen texto libre. Ver docs/TELEMETRIA_RETENCION.md.
//
// PIEZA 7 (8ª tanda, AG08) — migración 019_telemetry_extraction.sql añadió
// `delta_raw`/`previous_scenario`/`merged_scenario`/`expense_items` (jsonb):
// a diferencia de las métricas de arriba, estos SÍ llevan texto/cifras
// literales del usuario (nombres de partidas, montos, metas) — misma clase de
// sensibilidad que `response_raw`/`response_final`, así que entran en la
// MISMA purga de 30 días, no en la retención indefinida de las métricas.
//
// Idempotente: una fila ya purgada (las cinco columnas ya NULL) no vuelve a
// aparecer en el filtro — re-ejecutar el mismo día no hace nada.

import type { SupabaseClient } from '@supabase/supabase-js'

export interface PurgeResult {
  /** Corte ISO — se purgan filas con created_at anterior a esto. */
  cutoffIso: string
  /** Filas con texto pendiente de purgar (o ya purgadas, si dryRun=false). */
  rowsPurged: number
  /** Estimado por longitud de texto (bytes UTF-8) de lo liberado/a liberar. */
  bytesFreedEstimate: number
  dryRun: boolean
}

interface PurgeCandidateRow {
  id: string
  response_raw: string | null
  response_final: string | null
  delta_raw: unknown
  previous_scenario: unknown
  merged_scenario: unknown
  expense_items: unknown
}

function byteLength(s: string | null): number {
  return s ? Buffer.byteLength(s, 'utf8') : 0
}

function jsonByteLength(v: unknown): number {
  if (v === null || v === undefined) return 0
  return Buffer.byteLength(JSON.stringify(v), 'utf8')
}

/**
 * Pone a NULL `response_raw`/`response_final` y los jsonb de depuración de
 * extracción (PIEZA 7, 8ª tanda) en las filas de `response_telemetry` con
 * `created_at` anterior al corte (30 días por defecto). Con `dryRun:true`
 * solo cuenta y estima MB — no escribe nada.
 */
export async function purgeTelemetryText(
  admin: SupabaseClient,
  options: { olderThanDays?: number; dryRun?: boolean; now?: Date } = {},
): Promise<PurgeResult> {
  const olderThanDays = options.olderThanDays ?? 30
  const dryRun = options.dryRun ?? false
  const now = options.now ?? new Date()
  const cutoffIso = new Date(now.getTime() - olderThanDays * 24 * 60 * 60 * 1000).toISOString()

  const { data, error } = await admin
    .from('response_telemetry')
    .select('id, response_raw, response_final, delta_raw, previous_scenario, merged_scenario, expense_items')
    .lt('created_at', cutoffIso)
    .or(
      'response_raw.not.is.null,response_final.not.is.null,delta_raw.not.is.null,' +
        'previous_scenario.not.is.null,merged_scenario.not.is.null,expense_items.not.is.null',
    )

  if (error) throw new Error(`purgeTelemetryText (select): ${error.message}`)

  const rows = (data ?? []) as PurgeCandidateRow[]
  const bytesFreedEstimate = rows.reduce(
    (acc, r) =>
      acc +
      byteLength(r.response_raw) +
      byteLength(r.response_final) +
      jsonByteLength(r.delta_raw) +
      jsonByteLength(r.previous_scenario) +
      jsonByteLength(r.merged_scenario) +
      jsonByteLength(r.expense_items),
    0,
  )

  if (dryRun || rows.length === 0) {
    return { cutoffIso, rowsPurged: rows.length, bytesFreedEstimate, dryRun }
  }

  const ids = rows.map((r) => r.id)
  const { error: updateError } = await admin
    .from('response_telemetry')
    .update({
      response_raw: null,
      response_final: null,
      delta_raw: null,
      previous_scenario: null,
      merged_scenario: null,
      expense_items: null,
    })
    .in('id', ids)

  if (updateError) throw new Error(`purgeTelemetryText (update): ${updateError.message}`)

  return { cutoffIso, rowsPurged: rows.length, bytesFreedEstimate, dryRun: false }
}
