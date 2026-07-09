// Smoke de integración con la DB real — cierra el gap harness-vs-realidad.
//
// El harness de regresión es puro en memoria (no toca DB). Este smoke ejecuta el
// CICLO REAL que hace el route: insert de una conversación con scenario_state →
// read → mergeScenario(delta TAE 9%) → update → re-read → assert del estado y de
// buildScenarioContext(estado).conceptos.cuota ≈ 953,99 → delete de la fila.
//
// Seguro: sin env (SUPABASE_SERVICE_ROLE_KEY + URL) → SKIP con exit 0. La fila se
// marca con título 'smoke-test' y se borra siempre (finally). Nunca toca datos
// reales.
//
// Ejecutar: npm run smoke:db  (con las env vars de Supabase presentes).

import { createClient } from "@supabase/supabase-js";
import { extractScenarioDelta, mergeScenario, type ScenarioState } from "../src/lib/calculator/scenario";
import { buildScenarioContext } from "../src/lib/calculator/orchestrator";

const URL = process.env.NEXT_PUBLIC_SUPABASE_URL;
const KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

function assert(cond: unknown, msg: string): void {
  if (!cond) throw new Error(`ASSERT FALLÓ: ${msg}`);
}

async function main(): Promise<void> {
  if (!URL || !KEY) {
    console.log("SKIPPED: requiere env (NEXT_PUBLIC_SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY)");
    process.exit(0);
  }

  const db = createClient(URL, KEY, { auth: { autoRefreshToken: false, persistSession: false } });

  // conversations.user_id → auth.users(id): necesitamos un usuario existente.
  const { data: prof, error: profErr } = await db
    .from("profiles").select("user_id").limit(1).maybeSingle();
  if (profErr) throw new Error(`no pude leer profiles: ${profErr.message}`);
  if (!prof?.user_id) {
    console.log("SKIPPED: no hay ningún usuario en profiles para la FK");
    process.exit(0);
  }
  const userId = (prof as { user_id: string }).user_id;

  // Estado inicial: crédito del carro, aún con TAE de referencia.
  const estadoInicial: ScenarioState = {
    ingreso_mensual: 2500,
    gastos_mensuales: 1500,
    credito: { monto: 30000, plazo_meses: 36, tae_es_referencia: true },
    missing: ["tae"],
  };

  let convId: string | undefined;
  try {
    // 1) INSERT
    const ins = await db.from("conversations")
      .insert({ user_id: userId, title: "smoke-test", scenario_state: estadoInicial })
      .select("id, scenario_state").single();
    if (ins.error) throw new Error(`insert: ${ins.error.message}`);
    convId = (ins.data as { id: string }).id;
    console.log(`✓ insert conversación smoke-test id=${convId}`);

    // 2) READ
    const read1 = await db.from("conversations").select("scenario_state").eq("id", convId).single();
    if (read1.error) throw new Error(`read: ${read1.error.message}`);
    const prev = (read1.data as { scenario_state: ScenarioState }).scenario_state;
    assert(prev?.credito?.monto === 30000, "estado leído conserva monto 30000");
    console.log("✓ read: scenario_state persistido");

    // 3) mergeScenario con la TAE real → 4) UPDATE
    const delta = extractScenarioDelta("el banco me ofrece un 9%", "es", prev);
    const merged = mergeScenario(prev, delta);
    const upd = await db.from("conversations").update({ scenario_state: merged }).eq("id", convId);
    if (upd.error) throw new Error(`update: ${upd.error.message}`);
    console.log("✓ update: TAE real fusionada");

    // 5) RE-READ + asserts del estado
    const read2 = await db.from("conversations").select("scenario_state").eq("id", convId).single();
    if (read2.error) throw new Error(`re-read: ${read2.error.message}`);
    const estado = (read2.data as { scenario_state: ScenarioState }).scenario_state;
    assert(estado.credito?.tae_pct === 9, "TAE real 9 persistida");
    assert(estado.credito?.tae_es_referencia === false, "deja de ser referencia");
    assert(estado.credito?.monto === 30000, "monto intacto tras el merge");

    // 6) buildScenarioContext sobre el estado real → cuota ≈ 953,99
    const ctx = buildScenarioContext(estado, "el banco me ofrece un 9%");
    const cuota = ctx.conceptos.cuota ?? 0;
    assert(Math.abs(cuota - 953.99) <= 1, `conceptos.cuota ≈ 953.99 (fue ${cuota})`);
    console.log(`✓ re-read + build: conceptos.cuota = ${cuota}`);

    console.log("\n✅ SMOKE DB OK — el ciclo real insert→merge→update→read→calc funciona");
  } finally {
    if (convId) {
      const del = await db.from("conversations").delete().eq("id", convId).eq("title", "smoke-test");
      if (del.error) console.error(`⚠ no pude borrar la fila smoke-test ${convId}: ${del.error.message}`);
      else console.log(`✓ cleanup: fila smoke-test ${convId} borrada`);
    }
  }
}

main().catch((err) => {
  console.error(`❌ SMOKE DB FALLÓ: ${err instanceof Error ? err.message : err}`);
  process.exit(1);
});
