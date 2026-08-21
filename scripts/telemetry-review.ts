// scripts/telemetry-review.ts — AG07
//
// Ejecución MANUAL de la revisión nocturna (misma lógica que el cron diario,
// `src/app/api/cron/telemetry-review/route.ts` — ambos llaman a
// `src/lib/telemetry-review.ts`, ninguno duplica la detección D1-D5).
//
// Uso:
//   npm run telemetry:review                    # ayer (UTC), por defecto
//   npm run telemetry:review -- --date=2026-07-26   # re-ejecuta un día concreto
//   npm run telemetry:review -- --no-email       # persiste pero no envía el digest
//
// Requiere NEXT_PUBLIC_SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY. El digest por
// email requiere además RESEND_API_KEY + PILOT_ALERT_EMAIL — sin ellos, se
// persiste igual en `telemetry_alerts` y se avisa por consola (best-effort).

import { createClient } from '@supabase/supabase-js'
import {
  runTelemetryReview,
  persistReviewResults,
  buildDigestEmail,
  sendDigestEmail,
  yesterdayUtc,
} from '../src/lib/telemetry-review'

const URL = process.env.NEXT_PUBLIC_SUPABASE_URL
const KEY = process.env.SUPABASE_SERVICE_ROLE_KEY

function parseArgs(argv: string[]): { date: string; sendEmail: boolean } {
  const dateArg = argv.find((a) => a.startsWith('--date='))
  const date = dateArg ? dateArg.slice('--date='.length) : yesterdayUtc()
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    throw new Error(`--date inválido: "${date}" (formato esperado YYYY-MM-DD)`)
  }
  return { date, sendEmail: !argv.includes('--no-email') }
}

async function main(): Promise<void> {
  if (!URL || !KEY) {
    console.error('Faltan NEXT_PUBLIC_SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY en el entorno.')
    process.exit(1)
  }

  const { date, sendEmail } = parseArgs(process.argv.slice(2))
  const admin = createClient(URL, KEY, { auth: { autoRefreshToken: false, persistSession: false } })

  console.log(`Revisión nocturna de telemetría — ${date}`)
  const result = await runTelemetryReview(admin, date)
  console.log(`  turnos analizados: ${result.rowCount}`)
  console.log(`  eventos: ${result.events.length} (G1b: ${result.events.filter((e) => e.severity === 'G1b').length})`)

  await persistReviewResults(admin, result)
  console.log(`  telemetry_alerts: ${result.events.length + 1} filas (D1-D4 + 1 fila D5 de métricas)`)

  const digest = buildDigestEmail(result)
  console.log('')
  console.log(digest.text)

  if (sendEmail) {
    await sendDigestEmail(digest)
  } else {
    console.log('\n(--no-email: digest no enviado, solo impreso arriba)')
  }

  const g1bCount = result.events.filter((e) => e.severity === 'G1b').length
  process.exit(g1bCount > 0 ? 1 : 0)
}

main().catch((err) => {
  console.error('Fallo no capturado de telemetry-review:', err)
  process.exit(1)
})
