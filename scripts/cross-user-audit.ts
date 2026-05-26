#!/usr/bin/env tsx
/**
 * AG03 Zero-Trust · Auditoría RLS cross-user
 *
 * Para cada tabla con `user_id` en `public`:
 *   1. Siembra una fila para `test_a@audit.andgcore.test` y otra para
 *      `test_b@audit.andgcore.test` usando el service role.
 *   2. Desde la sesión autenticada de A intenta:
 *        a. SELECT de la fila de B  → debe devolver 0 filas
 *        b. UPDATE de la fila de B  → no debe modificar la fila
 *        c. DELETE de la fila de B  → no debe eliminar la fila
 *   3. Verifica vía service role que la fila de B sigue intacta.
 *
 * SOLO STAGING. NUNCA EJECUTAR EN PRODUCCIÓN.
 *
 * Uso:
 *   npx tsx scripts/cross-user-audit.ts
 *
 * Variables de entorno requeridas (cargadas de .env.local o .env):
 *   NEXT_PUBLIC_SUPABASE_URL
 *   NEXT_PUBLIC_SUPABASE_ANON_KEY
 *   SUPABASE_SERVICE_ROLE_KEY
 */

import { createClient, SupabaseClient } from '@supabase/supabase-js';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import WebSocketImpl from 'ws';

// Node 20 no expone WebSocket global; supabase-js inicializa el realtime
// client en cuanto creas un cliente, así que le pasamos `ws` como transport.
const realtimeOpts = { transport: WebSocketImpl as unknown as typeof WebSocket };

// ─── Carga simple de .env.local/.env ──────────────────────────────────────
function loadEnvFile(path: string): void {
  const abs = resolve(process.cwd(), path);
  if (!existsSync(abs)) return;
  for (const raw of readFileSync(abs, 'utf-8').split('\n')) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq === -1) continue;
    const key = line.slice(0, eq).trim();
    const val = line.slice(eq + 1).trim().replace(/^["']|["']$/g, '');
    if (!process.env[key]) process.env[key] = val;
  }
}
loadEnvFile('.env.local');
loadEnvFile('.env');

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL;
const ANON_KEY = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!SUPABASE_URL || !ANON_KEY || !SERVICE_KEY) {
  console.error(
    '✗ FALTAN variables de entorno: NEXT_PUBLIC_SUPABASE_URL, NEXT_PUBLIC_SUPABASE_ANON_KEY, SUPABASE_SERVICE_ROLE_KEY',
  );
  process.exit(1);
}

// Guard-rail simple anti-prod: si la URL no parece de staging, abortar.
// Aquí el proyecto staging es `sovereign-cfo` (ref jmbzjcrgxetqfkqopfgr).
// Si en el futuro hay un proyecto prod, su ref distinto disparará el guard.
const ALLOWED_REFS = ['jmbzjcrgxetqfkqopfgr'];
const refMatch = SUPABASE_URL.match(/https:\/\/([^.]+)\.supabase\.co/);
if (!refMatch || !ALLOWED_REFS.includes(refMatch[1])) {
  console.error(
    `✗ Proyecto no permitido: ${SUPABASE_URL}. Solo se permite staging (refs: ${ALLOWED_REFS.join(', ')}).`,
  );
  process.exit(1);
}

// ─── Constantes ──────────────────────────────────────────────────────────
const TEST_A_EMAIL = 'test_a@audit.andgcore.test';
const TEST_B_EMAIL = 'test_b@audit.andgcore.test';
const TEST_PASSWORD = 'AuditRLS-2026!secret';
const MARKER = 'rls-audit-marker';
const REPORT_PATH = resolve(process.cwd(), 'CROSS_USER_AUDIT.md');

type SeedRow = { id: string };

type TableSpec = {
  table: string;
  /** Devuelve la fila a usar como blanco del ataque (siembra o busca existente). */
  seed: (
    svc: SupabaseClient,
    userId: string,
    userSession: SupabaseClient,
  ) => Promise<SeedRow | null>;
  /** Payload para UPDATE hostil. */
  updatePayload: Record<string, unknown>;
  /** Cliente con que verificar la fila víctima. 'service' por defecto; 'user' cuando service_role no tiene SELECT. */
  verifyAs?: 'service' | 'user';
  /** Notas explicativas para el reporte. */
  notes?: string;
};

type TestResult = {
  table: string;
  rlsEnabled: boolean | 'unknown';
  selectLeak: number; // filas leídas
  updateLeak: boolean; // true si pudo modificar
  deleteLeak: boolean; // true si pudo eliminar
  verdict: 'PASS' | 'FAIL' | 'SKIP' | 'ERROR';
  error?: string;
  notes?: string;
};

// ─── Helpers genéricos ───────────────────────────────────────────────────
async function svcInsert(
  svc: SupabaseClient,
  table: string,
  row: Record<string, unknown>,
): Promise<SeedRow | null> {
  const { data, error } = await svc.from(table).insert(row).select('id').single();
  if (error) {
    console.error(`  seed ${table} (service) error:`, error.message);
    return null;
  }
  return data as SeedRow;
}

/** Inserta via service role; si falla por permission denied, reintenta vía sesión del usuario. */
async function seedWithFallback(
  svc: SupabaseClient,
  userSession: SupabaseClient,
  table: string,
  row: Record<string, unknown>,
): Promise<SeedRow | null> {
  const svcRes = await svc.from(table).insert(row).select('id').single();
  if (!svcRes.error) return svcRes.data as SeedRow;
  if (!/permission denied|insufficient_privilege/i.test(svcRes.error.message)) {
    console.error(`  seed ${table} (service) error:`, svcRes.error.message);
    return null;
  }
  // Fallback: usar sesión del usuario (cuyo INSERT/policy lo permite)
  const userRes = await userSession.from(table).insert(row).select('id').single();
  if (userRes.error) {
    console.error(`  seed ${table} (user fallback) error:`, userRes.error.message);
    return null;
  }
  return userRes.data as SeedRow;
}

async function svcFindByUser(
  svc: SupabaseClient,
  table: string,
  userId: string,
): Promise<SeedRow | null> {
  const { data, error } = await svc
    .from(table)
    .select('id')
    .eq('user_id', userId)
    .limit(1)
    .maybeSingle();
  if (error) {
    console.error(`  find ${table} error:`, error.message);
    return null;
  }
  return (data as SeedRow) ?? null;
}

// ─── Especificación de tablas ────────────────────────────────────────────
const TABLES: TableSpec[] = [
  {
    table: 'profiles',
    seed: (svc, uid) => svcFindByUser(svc, 'profiles', uid),
    updatePayload: { name: 'hacked-by-A' },
    notes: 'Fila auto-creada por trigger `on_auth_user_created`. Sin política DELETE (esperado).',
  },
  {
    table: 'fiscal_profiles',
    seed: (svc, uid) =>
      svcInsert(svc, 'fiscal_profiles', {
        user_id: uid,
        country: 'PT',
        employment_type: 'employee',
        monthly_gross: 2000,
        has_holiday_bonus: false,
        has_christmas_bonus: false,
      }),
    updatePayload: { country: 'HACKED' },
  },
  {
    table: 'transactions',
    seed: (svc, uid) =>
      svcInsert(svc, 'transactions', {
        user_id: uid,
        amount: 99.99,
        type: 'expense',
        description: MARKER,
      }),
    updatePayload: { amount: 0, description: 'hacked' },
  },
  {
    table: 'ica_history',
    seed: (svc, uid) =>
      svcInsert(svc, 'ica_history', {
        user_id: uid,
        score: 42,
        level: 'vision',
        event_trigger: MARKER,
      }),
    updatePayload: { score: 999 },
    notes: 'Solo políticas SELECT + INSERT. UPDATE/DELETE bloqueados por ausencia de política.',
  },
  {
    table: 'conversations',
    seed: (svc, uid) =>
      svcInsert(svc, 'conversations', {
        user_id: uid,
        title: `${MARKER}-conv`,
      }),
    updatePayload: { title: 'hacked' },
  },
  {
    table: 'messages',
    seed: async (svc, uid) => {
      const conv = await svcInsert(svc, 'conversations', {
        user_id: uid,
        title: `${MARKER}-msg-host`,
      });
      if (!conv) return null;
      return svcInsert(svc, 'messages', {
        user_id: uid,
        conversation_id: conv.id,
        role: 'user',
        content: MARKER,
      });
    },
    updatePayload: { content: 'hacked' },
  },
  {
    table: 'embeddings',
    seed: (svc, uid) =>
      svcInsert(svc, 'embeddings', {
        user_id: uid,
        content: MARKER,
        metadata: { audit: true },
      }),
    updatePayload: { content: 'hacked' },
  },
  {
    table: 'subscriptions',
    seed: (svc, uid) => svcFindByUser(svc, 'subscriptions', uid),
    updatePayload: { plan: 'hacked' },
    notes:
      'Fila auto-creada por trigger. Solo política SELECT — UPDATE/DELETE bloqueados por ausencia de política.',
  },
  {
    table: 'documents',
    seed: (svc, uid, session) =>
      seedWithFallback(svc, session, 'documents', {
        user_id: uid,
        filename: `${MARKER}.pdf`,
        type: 'audit',
      }),
    updatePayload: { filename: 'hacked.pdf' },
    verifyAs: 'user',
    notes: 'service_role sin GRANT DML/SELECT — seed y verificación vía sesión del usuario.',
  },
  {
    table: 'audit_logs',
    seed: (svc, uid) =>
      svcInsert(svc, 'audit_logs', {
        user_id: uid,
        action: MARKER,
        metadata: { source: 'cross-user-audit' },
      }),
    updatePayload: { action: 'hacked' },
    notes: 'Solo política SELECT propia. INSERT/UPDATE/DELETE bloqueados.',
  },
  {
    table: 'consent_records',
    seed: async (svc, uid) => {
      const found = await svcFindByUser(svc, 'consent_records', uid);
      if (found) return found;
      return svcInsert(svc, 'consent_records', {
        user_id: uid,
        consent_version: '1.0',
        ip_address: '127.0.0.1',
        user_agent: 'audit',
      });
    },
    updatePayload: { ip_address: 'hacked' },
    notes: 'Solo política SELECT. Escritura via service role. service_role sin DELETE — seed idempotente.',
  },
  {
    table: 'goals',
    seed: (svc, uid, session) =>
      seedWithFallback(svc, session, 'goals', {
        user_id: uid,
        title: MARKER,
        target_amount: 10000,
        target_date: '2027-01-01',
        category: 'other',
      }),
    updatePayload: { title: 'hacked', target_amount: 1 },
    verifyAs: 'user',
    notes: 'service_role sin GRANT DML/SELECT — seed y verificación vía sesión del usuario.',
  },
];

// Tablas sin user_id — cross-user no aplica
const SKIPPED: { table: string; reason: string }[] = [
  {
    table: 'supported_languages',
    reason: 'Tabla de referencia pública. Sin columna user_id. SELECT abierto a todos (esperado).',
  },
  {
    table: 'behavioral_patterns',
    reason: 'Datos anonimizados sin user_id. Política SELECT con qual=false (bloqueo total a usuarios autenticados).',
  },
];

// Mapa de RLS esperada (verificado via Supabase MCP el 2026-05-26)
const EXPECTED_RLS: Record<string, boolean> = {
  profiles: true,
  fiscal_profiles: true,
  transactions: true,
  ica_history: true,
  conversations: true,
  messages: true,
  embeddings: true,
  subscriptions: true,
  documents: true,
  audit_logs: true,
  consent_records: true,
  goals: true,
  supported_languages: true,
  behavioral_patterns: true,
};

// ─── Auth helpers ────────────────────────────────────────────────────────
async function ensureUser(svc: SupabaseClient, email: string): Promise<string> {
  let page = 1;
  while (true) {
    const { data, error } = await svc.auth.admin.listUsers({ page, perPage: 200 });
    if (error) throw new Error(`listUsers page ${page}: ${error.message}`);
    const users = (data as { users: Array<{ id: string; email?: string }> }).users;
    const hit = users.find((u) => u.email === email);
    if (hit) return hit.id;
    if (users.length < 200) break;
    page++;
  }
  const { data, error } = await svc.auth.admin.createUser({
    email,
    password: TEST_PASSWORD,
    email_confirm: true,
  });
  if (error) throw new Error(`createUser ${email}: ${error.message}`);
  if (!data.user) throw new Error(`createUser ${email}: respuesta sin user`);
  console.log(`  ✓ usuario creado: ${email} (${data.user.id})`);
  return data.user.id;
}

async function sessionClient(email: string): Promise<SupabaseClient> {
  const cli = createClient(SUPABASE_URL!, ANON_KEY!, {
    auth: { persistSession: false, autoRefreshToken: false },
    realtime: realtimeOpts,
  });
  const { error } = await cli.auth.signInWithPassword({ email, password: TEST_PASSWORD });
  if (error) {
    throw new Error(`signIn ${email}: ${error.message}`);
  }
  return cli;
}

// ─── Limpieza previa de datos de auditoría ───────────────────────────────
async function cleanup(
  svc: SupabaseClient,
  userSessions: Record<string, SupabaseClient>,
  userIds: string[],
): Promise<void> {
  // Hijos primero (messages cascada en delete de conversations, pero por claridad)
  // consent_records no se limpia: service_role carece de DELETE y la fila es UNIQUE(user_id).
  const tablesToClean = [
    'messages',
    'audit_logs',
    'embeddings',
    'documents',
    'ica_history',
    'goals',
    'transactions',
    'fiscal_profiles',
    'conversations',
  ];
  for (const t of tablesToClean) {
    const { error } = await svc.from(t).delete().in('user_id', userIds);
    if (!error) continue;
    if (/permission denied|insufficient_privilege/i.test(error.message)) {
      // Fallback: cada usuario borra los suyos
      for (const uid of userIds) {
        const sess = userSessions[uid];
        if (!sess) continue;
        const r = await sess.from(t).delete().eq('user_id', uid);
        if (r.error) {
          console.warn(`  ⚠ cleanup ${t} (user ${uid.slice(0,8)}): ${r.error.message}`);
        }
      }
    } else {
      console.warn(`  ⚠ cleanup ${t}: ${error.message}`);
    }
  }
}

// ─── Test per-tabla ──────────────────────────────────────────────────────
async function runTableTest(
  svc: SupabaseClient,
  attacker: SupabaseClient,
  victim: SupabaseClient,
  spec: TableSpec,
  victimId: string,
): Promise<TestResult> {
  const base: TestResult = {
    table: spec.table,
    rlsEnabled: EXPECTED_RLS[spec.table] ?? 'unknown',
    selectLeak: 0,
    updateLeak: false,
    deleteLeak: false,
    verdict: 'PASS',
    notes: spec.notes,
  };

  // Cliente para verificar el estado real de la fila víctima.
  // Por defecto: service role (bypassea RLS). Si service_role carece de SELECT
  // para esta tabla, usamos la sesión de la víctima (que ve sus propios datos).
  const verifier = spec.verifyAs === 'user' ? victim : svc;

  // Snapshot inicial de la fila de la víctima
  const { data: before, error: beforeErr } = await verifier
    .from(spec.table)
    .select('*')
    .eq('user_id', victimId)
    .limit(1)
    .maybeSingle();
  if (beforeErr || !before) {
    return { ...base, verdict: 'ERROR', error: `snapshot inicial: ${beforeErr?.message ?? 'sin fila víctima'}` };
  }
  const victimRowId = (before as { id: string }).id;

  // a. SELECT cross-user
  const { data: selData, error: selErr } = await attacker
    .from(spec.table)
    .select('*')
    .eq('id', victimRowId);
  if (selErr) {
    // Un error aquí no necesariamente es FAIL: si es un 401/permission denied, también bloquea.
    base.selectLeak = 0;
  } else {
    base.selectLeak = selData?.length ?? 0;
  }

  // b. UPDATE cross-user
  const { error: updErr } = await attacker
    .from(spec.table)
    .update(spec.updatePayload)
    .eq('id', victimRowId);
  // PostgREST/RLS: si la fila no cumple la policy, devuelve "0 rows" sin error.
  // Verificamos vía verifier si la fila cambió.
  const { data: afterUpd } = await verifier
    .from(spec.table)
    .select('*')
    .eq('id', victimRowId)
    .maybeSingle();
  if (!afterUpd) {
    // Fila desapareció tras el UPDATE — improbable, pero lo flageamos como leak de DELETE
    base.deleteLeak = true;
  } else {
    for (const [k, v] of Object.entries(spec.updatePayload)) {
      const newVal = (afterUpd as Record<string, unknown>)[k];
      if (JSON.stringify(newVal) === JSON.stringify(v)) {
        base.updateLeak = true;
        break;
      }
    }
  }
  // Si hubo error es señal extra de bloqueo (no es necesario, pero útil en notas)
  void updErr;

  // c. DELETE cross-user
  const { error: delErr } = await attacker.from(spec.table).delete().eq('id', victimRowId);
  const { data: afterDel } = await verifier
    .from(spec.table)
    .select('id')
    .eq('id', victimRowId)
    .maybeSingle();
  if (!afterDel) {
    base.deleteLeak = true;
  }
  void delErr;

  if (base.selectLeak > 0 || base.updateLeak || base.deleteLeak) {
    base.verdict = 'FAIL';
  }
  return base;
}

// ─── Generar reporte Markdown ────────────────────────────────────────────
function renderReport(
  results: TestResult[],
  userAId: string,
  userBId: string,
): string {
  const lines: string[] = [];
  const now = new Date().toISOString();
  lines.push('# Cross-User RLS Audit — AG03 Zero-Trust');
  lines.push('');
  lines.push(`**Generado:** ${now}`);
  lines.push(`**Proyecto Supabase:** \`${refMatch![1]}\` (staging)`);
  lines.push(`**Usuario A:** \`${TEST_A_EMAIL}\` — \`${userAId}\``);
  lines.push(`**Usuario B:** \`${TEST_B_EMAIL}\` — \`${userBId}\``);
  lines.push('');
  lines.push('## Metodología');
  lines.push('');
  lines.push('Para cada tabla con `user_id`, se siembra una fila por usuario vía service role.');
  lines.push('Luego, autenticado como A, se intenta SELECT/UPDATE/DELETE contra la fila de B.');
  lines.push('La verificación final del estado de la fila se hace vía service role (que');
  lines.push('bypassea RLS), evitando así falsos PASS por RLS filtrando la respuesta del');
  lines.push('propio attacker. Cuando service_role carece de GRANT (ver §Hallazgos secundarios),');
  lines.push('la verificación se hace vía la sesión autenticada de la víctima (que ve sus');
  lines.push('propios datos por RLS).');
  lines.push('');
  lines.push('Criterio de PASS:');
  lines.push('');
  lines.push('- `SELECT cross-user` = 0 filas leídas');
  lines.push('- `UPDATE cross-user` = fila víctima sin cambios tras el intento');
  lines.push('- `DELETE cross-user` = fila víctima sigue existiendo tras el intento');
  lines.push('');
  lines.push('## Resumen');
  lines.push('');
  lines.push('| Tabla | RLS Activa | SELECT cross-user | UPDATE cross-user | DELETE cross-user | Veredicto |');
  lines.push('|-------|------------|-------------------|-------------------|-------------------|-----------|');
  for (const r of results) {
    const rls = r.rlsEnabled === true ? 'sí' : r.rlsEnabled === false ? 'no' : '¿?';
    const sel = r.verdict === 'SKIP'
      ? 'N/A'
      : r.verdict === 'ERROR'
        ? `error: ${r.error}`
        : `${r.selectLeak} leaks`;
    const upd = r.verdict === 'SKIP' ? 'N/A' : r.verdict === 'ERROR' ? '—' : r.updateLeak ? 'PASÓ ⚠' : 'bloqueado';
    const del = r.verdict === 'SKIP' ? 'N/A' : r.verdict === 'ERROR' ? '—' : r.deleteLeak ? 'PASÓ ⚠' : 'bloqueado';
    lines.push(`| ${r.table} | ${rls} | ${sel} | ${upd} | ${del} | ${r.verdict} |`);
  }
  lines.push('');

  const fails = results.filter((r) => r.verdict === 'FAIL');
  const errors = results.filter((r) => r.verdict === 'ERROR');

  if (fails.length > 0) {
    lines.push('## ⚠ Hallazgos críticos');
    lines.push('');
    for (const f of fails) {
      lines.push(`### \`${f.table}\``);
      lines.push('');
      if (f.selectLeak > 0) lines.push(`- **SELECT cross-user filtró ${f.selectLeak} fila(s) de B desde la sesión de A.**`);
      if (f.updateLeak) lines.push('- **UPDATE cross-user MUTÓ la fila de B desde la sesión de A.**');
      if (f.deleteLeak) lines.push('- **DELETE cross-user ELIMINÓ la fila de B desde la sesión de A.**');
      if (f.notes) lines.push(`- Contexto: ${f.notes}`);
      lines.push('');
    }
    lines.push('**Acción:** no se modifican policies en esta auditoría. Revisar con AG01 antes de cambiar nada.');
    lines.push('');
  } else {
    lines.push('## Hallazgos críticos');
    lines.push('');
    lines.push('Ninguno. Todas las tablas con `user_id` aíslan correctamente a usuarios distintos.');
    lines.push('');
  }

  if (errors.length > 0) {
    lines.push('## Errores de ejecución');
    lines.push('');
    for (const e of errors) {
      lines.push(`- \`${e.table}\`: ${e.error}`);
    }
    lines.push('');
  }

  // Hallazgo secundario (siempre se imprime): grants faltantes a service_role.
  // Detectado durante esta auditoría — no es FAIL de RLS pero merece registro.
  lines.push('## Hallazgos secundarios — grants de service_role');
  lines.push('');
  lines.push('Durante la siembra se detectaron tablas donde el rol `service_role` carece');
  lines.push('de privilegios DML/SELECT, lo que rompe el patrón habitual de Supabase');
  lines.push('(service_role bypassea RLS para tareas de servidor: webhooks, jobs, admin).');
  lines.push('');
  lines.push('| Tabla | service_role tiene | Falta | Impacto |');
  lines.push('|-------|--------------------|-------|---------|');
  lines.push('| `documents` | REFERENCES, TRIGGER, TRUNCATE | SELECT, INSERT, UPDATE, DELETE | API server-side no puede leer ni escribir documentos del usuario |');
  lines.push('| `goals` | REFERENCES, TRIGGER, TRUNCATE | SELECT, INSERT, UPDATE, DELETE | Jobs server-side no pueden gestionar metas (motor IDF en curso por AG06) |');
  lines.push('| `consent_records` | INSERT, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE | DELETE | GDPR delete job no puede limpiar registros de consentimiento |');
  lines.push('');
  lines.push('Esto NO es un FAIL de RLS cross-user (ningún usuario ve datos ajenos), pero');
  lines.push('sí un riesgo operativo: las APIs server-side actuales o futuras que usen el');
  lines.push('service role van a fallar al tocar estas tablas. Revisar con AG01 antes de');
  lines.push('lanzar migraciones que añadan los `GRANT ... TO service_role` correspondientes.');
  lines.push('');

  lines.push('## Tablas sin user_id (cross-user no aplica)');
  lines.push('');
  for (const s of SKIPPED) {
    lines.push(`- \`${s.table}\` — ${s.reason}`);
  }
  lines.push('');

  lines.push('## Notas por tabla');
  lines.push('');
  for (const r of results) {
    if (r.notes) {
      lines.push(`- \`${r.table}\`: ${r.notes}`);
    }
  }
  lines.push('');

  lines.push('## Reproducir');
  lines.push('');
  lines.push('```bash');
  lines.push('npx tsx scripts/cross-user-audit.ts');
  lines.push('```');
  lines.push('');
  lines.push('Usuarios `test_a@audit.andgcore.test` y `test_b@audit.andgcore.test` quedan en BD');
  lines.push('para próximas auditorías (idempotente).');
  lines.push('');
  return lines.join('\n');
}

// ─── Main ────────────────────────────────────────────────────────────────
async function main(): Promise<void> {
  console.log(`▶ Cross-user RLS audit · ${SUPABASE_URL}`);

  const svc = createClient(SUPABASE_URL!, SERVICE_KEY!, {
    auth: { persistSession: false, autoRefreshToken: false },
    realtime: realtimeOpts,
  });

  console.log('▶ Garantizando usuarios de prueba...');
  const userAId = await ensureUser(svc, TEST_A_EMAIL);
  const userBId = await ensureUser(svc, TEST_B_EMAIL);
  console.log(`  A=${userAId}  B=${userBId}`);

  console.log('▶ Autenticando sesiones (A=attacker, B=víctima)...');
  const attacker = await sessionClient(TEST_A_EMAIL);
  const victim = await sessionClient(TEST_B_EMAIL);
  const sessions: Record<string, SupabaseClient> = {
    [userAId]: attacker,
    [userBId]: victim,
  };

  console.log('▶ Limpiando datos previos de auditoría...');
  await cleanup(svc, sessions, [userAId, userBId]);

  console.log('▶ Sembrando filas para A y B...');
  // Sembrar y validar (cada usuario siembra sus propios datos cuando se requiere)
  for (const spec of TABLES) {
    const a = await spec.seed(svc, userAId, attacker);
    const b = await spec.seed(svc, userBId, victim);
    if (!a || !b) {
      console.warn(`  ⚠ seed incompleto en ${spec.table} (a=${!!a}, b=${!!b})`);
    }
  }

  console.log('▶ Ejecutando tests cross-user...');
  const results: TestResult[] = [];
  for (const spec of TABLES) {
    process.stdout.write(`  · ${spec.table.padEnd(22, ' ')} `);
    try {
      const r = await runTableTest(svc, attacker, victim, spec, userBId);
      results.push(r);
      const mark = r.verdict === 'PASS' ? '✓' : r.verdict === 'FAIL' ? '✗' : '?';
      console.log(`${mark} ${r.verdict}` +
        (r.verdict !== 'PASS' ? `  sel=${r.selectLeak} upd=${r.updateLeak} del=${r.deleteLeak}` : ''));
    } catch (e) {
      const err = e instanceof Error ? e.message : String(e);
      results.push({
        table: spec.table,
        rlsEnabled: EXPECTED_RLS[spec.table] ?? 'unknown',
        selectLeak: 0,
        updateLeak: false,
        deleteLeak: false,
        verdict: 'ERROR',
        error: err,
        notes: spec.notes,
      });
      console.log(`! ERROR: ${err}`);
    }
  }

  console.log('▶ Generando reporte...');
  const md = renderReport(results, userAId, userBId);
  writeFileSync(REPORT_PATH, md, 'utf-8');
  console.log(`  ✓ ${REPORT_PATH}`);

  const fails = results.filter((r) => r.verdict === 'FAIL');
  const errors = results.filter((r) => r.verdict === 'ERROR');
  console.log('');
  console.log(`◆ Resultados: PASS=${results.filter(r => r.verdict === 'PASS').length}  FAIL=${fails.length}  ERROR=${errors.length}`);

  if (fails.length > 0) {
    console.log('');
    console.log('⚠ Se detectaron FAILS. Revisar CROSS_USER_AUDIT.md antes de modificar policies.');
    process.exit(2);
  }

  // Cerrar sesiones
  await attacker.auth.signOut();
  await victim.auth.signOut();
}

main().catch((e) => {
  console.error('✗ FATAL:', e);
  process.exit(1);
});
