import { adminClient } from '@/lib/supabase/admin'
import {
  runTelemetryReview,
  persistReviewResults,
  buildDigestEmail,
  sendDigestEmail,
  yesterdayUtc,
} from '@/lib/telemetry-review'
import { NextResponse } from 'next/server'

// Cron diario (vercel.json, 03:00 UTC) — revisa el día UTC anterior completo.
// Misma lógica que `scripts/telemetry-review.ts` (compartida vía
// `@/lib/telemetry-review`, ninguno duplica la detección D1-D5).
//
// Protegido por CRON_SECRET: Vercel Cron llama con
// `Authorization: Bearer ${CRON_SECRET}` (ver vercel.json + docs de Vercel
// Cron Jobs). Cualquier otro caller (incluida una invocación manual sin el
// secreto) recibe 401 — esta ruta lee/escribe telemetría interna del piloto,
// nunca debe quedar abierta.
export async function GET(request: Request) {
  const secret = process.env.CRON_SECRET
  const auth = request.headers.get('authorization')
  if (!secret || auth !== `Bearer ${secret}`) {
    return NextResponse.json({ error: 'No autorizado' }, { status: 401 })
  }

  const url = new URL(request.url)
  const dateParam = url.searchParams.get('date')
  const date = dateParam && /^\d{4}-\d{2}-\d{2}$/.test(dateParam) ? dateParam : yesterdayUtc()

  const admin = adminClient()

  try {
    const result = await runTelemetryReview(admin, date)
    await persistReviewResults(admin, result)
    const digest = buildDigestEmail(result)
    await sendDigestEmail(digest)

    const g1bCount = result.events.filter((e) => e.severity === 'G1b').length
    return NextResponse.json({
      reviewDate: date,
      rowCount: result.rowCount,
      eventCount: result.events.length,
      g1bCount,
    })
  } catch (err) {
    console.error('[cron/telemetry-review] fallo:', err)
    return NextResponse.json({ error: 'Fallo en la revisión de telemetría' }, { status: 500 })
  }
}
