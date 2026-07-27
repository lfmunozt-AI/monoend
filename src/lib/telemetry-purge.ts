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
// Idempotente: una fila ya purgada (response_raw Y response_final ya NULL) no
// vuelve a aparecer en el filtro — re-ejecutar el mismo día no hace nada.

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
}

function byteLength(s: string | null): number {
  return s ? Buffer.byteLength(s, 'utf8') : 0
}

/**
 * Pone a NULL `response_raw`/`response_final` en las filas de
 * `response_telemetry` con `created_at` anterior al corte (30 días por
 * defecto). Con `dryRun:true` solo cuenta y estima MB — no escribe nada.
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
    .select('id, response_raw, response_final')
    .lt('created_at', cutoffIso)
    .or('response_raw.not.is.null,response_final.not.is.null')

  if (error) throw new Error(`purgeTelemetryText (select): ${error.message}`)

  const rows = (data ?? []) as PurgeCandidateRow[]
  const bytesFreedEstimate = rows.reduce(
    (acc, r) => acc + byteLength(r.response_raw) + byteLength(r.response_final),
    0,
  )

  if (dryRun || rows.length === 0) {
    return { cutoffIso, rowsPurged: rows.length, bytesFreedEstimate, dryRun }
  }

  const ids = rows.map((r) => r.id)
  const { error: updateError } = await admin
    .from('response_telemetry')
    .update({ response_raw: null, response_final: null })
    .in('id', ids)

  if (updateError) throw new Error(`purgeTelemetryText (update): ${updateError.message}`)

  return { cutoffIso, rowsPurged: rows.length, bytesFreedEstimate, dryRun: false }
}
