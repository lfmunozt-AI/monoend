/**
 * scripts/cleanup-synthetic-profiles.ts
 *
 * Borra todos los usuarios sintéticos (email `synth_*@audit.andgcore.test`)
 * creados por scripts/seed-synthetic-profiles.ts.
 *
 * `ON DELETE CASCADE` en todas las tablas asegura que transacciones,
 * goals, ica_history, conversations, messages, embeddings, subscriptions,
 * fiscal_profiles, profiles, etc. se borren con el usuario.
 *
 * Uso:
 *   ALLOW_SYNTHETIC_CLEANUP=1 npx tsx scripts/cleanup-synthetic-profiles.ts
 *
 * Refusa ejecutarse si la URL parece producción.
 */

import { createClient, SupabaseClient } from '@supabase/supabase-js'

const EMAIL_DOMAIN = 'audit.andgcore.test'
const EMAIL_PREFIX = 'synth_'

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL || process.env.SUPABASE_URL
const SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY

if (!SUPABASE_URL || !SERVICE_ROLE_KEY) {
  console.error('❌ Faltan NEXT_PUBLIC_SUPABASE_URL y/o SUPABASE_SERVICE_ROLE_KEY en el entorno.')
  process.exit(1)
}

if (/prod|production/i.test(SUPABASE_URL)) {
  console.error('❌ La URL parece producción. Abortando por seguridad:', SUPABASE_URL)
  process.exit(1)
}

if (process.env.ALLOW_SYNTHETIC_CLEANUP !== '1') {
  console.error('❌ Falta ALLOW_SYNTHETIC_CLEANUP=1 para confirmar la ejecución.')
  console.error('   URL objetivo:', SUPABASE_URL)
  console.error(`   Esto borrará todos los usuarios con email ${EMAIL_PREFIX}*@${EMAIL_DOMAIN}`)
  process.exit(1)
}

console.log('🧹 Limpiando perfiles sintéticos en:', SUPABASE_URL)

const admin: SupabaseClient = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, {
  auth: { autoRefreshToken: false, persistSession: false },
})

interface ListedUser {
  id: string
  email?: string
}

async function listSyntheticUsers(): Promise<ListedUser[]> {
  const all: ListedUser[] = []
  const perPage = 200
  let page = 1

  while (true) {
    const { data, error } = await admin.auth.admin.listUsers({ page, perPage })
    if (error) {
      console.error('❌ Error listando usuarios:', error.message)
      throw error
    }
    const users = data?.users ?? []
    if (users.length === 0) break

    for (const u of users) {
      const email = u.email ?? ''
      if (email.startsWith(EMAIL_PREFIX) && email.endsWith(`@${EMAIL_DOMAIN}`)) {
        all.push({ id: u.id, email })
      }
    }

    if (users.length < perPage) break
    page++
  }

  return all
}

async function main() {
  const users = await listSyntheticUsers()
  console.log(`Encontrados ${users.length} usuarios sintéticos.`)

  if (users.length === 0) {
    console.log('✅ Nada que borrar.')
    return
  }

  let ok = 0
  let fail = 0
  for (const u of users) {
    const { error } = await admin.auth.admin.deleteUser(u.id)
    if (error) {
      fail++
      console.error(`  ❌ deleteUser ${u.email}: ${error.message}`)
    } else {
      ok++
      console.log(`  ✓ borrado ${u.email}`)
    }
  }

  console.log('─'.repeat(80))
  console.log(`✅ Borrados: ${ok} · Fallidos: ${fail}`)
}

main().catch((err) => {
  console.error('Fallo no capturado:', err)
  process.exit(1)
})
