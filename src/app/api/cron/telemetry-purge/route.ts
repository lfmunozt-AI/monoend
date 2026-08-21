import { adminClient } from '@/lib/supabase/admin'
import { purgeTelemetryText } from '@/lib/telemetry-purge'
import { NextResponse } from 'next/server'

// Cron diario (vercel.json, 04:00 UTC — una hora después de la revisión de
// AG07 en 03:00 UTC, para no solaparse) — purga a NULL response_raw/
// response_final de las filas de response_telemetry con más de 30 días.
// Misma lógica que `scripts/telemetry-purge.ts` (compartida vía
// `@/lib/telemetry-purge`, ninguno duplica el corte ni el estimado de bytes).
//
// Protegido por CRON_SECRET: Vercel Cron llama con
// `Authorization: Bearer ${CRON_SECRET}` (ver vercel.json + docs de Vercel
// Cron Jobs). Cualquier otro caller (incluida una invocación manual sin el
// secreto) recibe 401 — esta ruta escribe sobre telemetría interna del
// piloto, nunca debe quedar abierta.
export async function GET(request: Request) {
  const secret = process.env.CRON_SECRET
  const auth = request.headers.get('authorization')
  if (!secret || auth !== `Bearer ${secret}`) {
    return NextResponse.json({ error: 'No autorizado' }, { status: 401 })
  }

  const admin = adminClient()

  try {
    const result = await purgeTelemetryText(admin)
    return NextResponse.json(result)
  } catch (err) {
    console.error('[cron/telemetry-purge] fallo:', err)
    return NextResponse.json({ error: 'Fallo en la purga de telemetría' }, { status: 500 })
  }
}
