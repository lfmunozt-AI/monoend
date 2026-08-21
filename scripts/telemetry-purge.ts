// scripts/telemetry-purge.ts — AG02
//
// Ejecución MANUAL de la purga de texto (misma lógica que el cron diario,
// `src/app/api/cron/telemetry-purge/route.ts` — ambos llaman a
// `purgeTelemetryText` en `src/lib/telemetry-purge.ts`, ninguno duplica el
// corte ni el estimado de bytes).
//
// Uso:
//   npm run telemetry:purge                              # purga texto de filas > 30 días
//   npm run telemetry:purge -- --dry-run                  # solo cuenta y estima MB, no modifica
//   npm run telemetry:purge -- --older-than-days=0        # cierre del piloto: purga TODO el texto
//
// Requiere NEXT_PUBLIC_SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY.

import { createClient } from '@supabase/supabase-js'
import { purgeTelemetryText } from '../src/lib/telemetry-purge'

const URL = process.env.NEXT_PUBLIC_SUPABASE_URL
const KEY = process.env.SUPABASE_SERVICE_ROLE_KEY

function parseOlderThanDays(argv: string[]): number | undefined {
  const arg = argv.find((a) => a.startsWith('--older-than-days='))
  if (!arg) return undefined
  const value = Number(arg.slice('--older-than-days='.length))
  if (!Number.isFinite(value) || value < 0) {
    throw new Error(`--older-than-days inválido: "${arg}" (esperado un número >= 0)`)
  }
  return value
}

async function main(): Promise<void> {
  if (!URL || !KEY) {
    console.error('Faltan NEXT_PUBLIC_SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY en el entorno.')
    process.exit(1)
  }

  const dryRun = process.argv.includes('--dry-run')
  const olderThanDays = parseOlderThanDays(process.argv.slice(2))
  const admin = createClient(URL, KEY, { auth: { autoRefreshToken: false, persistSession: false } })

  console.log(`Purga de telemetría (>${olderThanDays ?? 30} días) — ${dryRun ? 'DRY RUN' : 'EJECUCIÓN'}`)
  const result = await purgeTelemetryText(admin, { dryRun, olderThanDays })
  const mb = (result.bytesFreedEstimate / (1024 * 1024)).toFixed(3)

  console.log(`  corte: created_at < ${result.cutoffIso}`)
  console.log(`  filas ${dryRun ? 'a purgar' : 'purgadas'}: ${result.rowsPurged}`)
  console.log(`  MB ${dryRun ? 'a liberar (estimado)' : 'liberados (estimado)'}: ${mb}`)
}

main().catch((err) => {
  console.error('Fallo no capturado de telemetry-purge:', err)
  process.exit(1)
})
