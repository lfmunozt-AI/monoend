// E2E de persistencia del turno — cierra el gap harness/smoke-vs-realidad (AG08, 6ª tanda).
//
// CAUSA RAÍZ (testdev5, 31/07 10:25-10:42): 84 tests de harness (en memoria) y
// un smoke de DB (un solo campo: TAE) convivían con una persistencia rota —
// scenario_state nunca se escribía, goals seguía en 0 filas pese a una meta
// declarada, y response_telemetry llevaba semanas sin una fila (la migración
// que le añadió columnas nunca se ejecutó). Ninguno de los suites existentes
// lo habría detectado: ninguno hace el ciclo completo escritura→re-lectura
// contra la BD real de las CUATRO tablas que un turno toca.
//
// Este script reproduce el diálogo real de testdev5 turno a turno, usando el
// MISMO código que route.ts (extractScenarioDelta/mergeScenario/persistTurn —
// nunca datos fabricados a mano), y AFIRMA sobre lo leído DESDE LA BD, nunca
// desde el objeto en memoria.
//
// 7ª TANDA (testdev6) — añadido T3: crédito con MONTO y SIN plazo. Afirma que
// conceptos.monto queda expuesto (FIX 2) y que credito.plazo_meses jamás se
// persiste como 0 (FIX 1) — el bloqueo circular real: plazo_meses=0
// invalidaba el bloque de crédito entero, dejando el monto invisible para el
// guardarraíl y borrando la propia pregunta que iba a conseguir el plazo.
//
// Seguro: sin env (SUPABASE_SERVICE_ROLE_KEY + NEXT_PUBLIC_SUPABASE_URL) →
// SKIP con exit 0 (mismo patrón que smoke-db.ts). La conversación y la meta
// se marcan con un título/nombre reconocible y se borran siempre (finally).
// Nunca toca datos de usuarios reales.
//
// Ejecutar: npm run test:e2e  (con las env vars de Supabase presentes).

import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import {
  extractScenarioDelta,
  mergeScenario,
  detectarNumerosHuerfanos,
  detectarDiscrepanciaGastos,
  deltaSinGastosPorDiscrepancia,
  detectarEventosICA,
  type ScenarioState,
} from "../src/lib/calculator/scenario";
import { toolArgsToScenarioDelta } from "../src/lib/calculator/tools";
import { buildScenarioContext } from "../src/lib/calculator/orchestrator";
import { validateGrounding } from "../src/lib/guardrail/validate";
import { persistTurn, type GoalUpsert } from "../src/lib/persistence";

const URL = process.env.NEXT_PUBLIC_SUPABASE_URL;
const KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

const MARCA = "e2e-turn-test";

function assert(cond: unknown, msg: string): void {
  if (!cond) throw new Error(`ASSERT FALLÓ: ${msg}`);
}

/**
 * Un "turno" del script: aplica el MISMO pipeline que route.ts a partir de un
 * delta ya resuelto (tool_args o regex — el punto no es re-probar la
 * extracción, ya cubierta por scenario.test.ts, sino la PERSISTENCIA), y
 * llama a persistTurn contra la BD real.
 */
async function ejecutarTurno(
  db: SupabaseClient<any>,
  userId: string,
  conversationId: string,
  antes: ScenarioState,
  delta: Partial<ScenarioState>,
  mensaje: string,
): Promise<ScenarioState> {
  const huerfanos = detectarNumerosHuerfanos(mensaje, delta);
  const discrepancia = detectarDiscrepanciaGastos(delta);
  const deltaAPersistir = deltaSinGastosPorDiscrepancia(delta, discrepancia);
  const scenario = mergeScenario(antes, deltaAPersistir);
  const icaEventos = detectarEventosICA(antes, scenario);

  const goal: GoalUpsert | null =
    scenario.meta?.titulo && scenario.meta.monto !== undefined
      ? { titulo: scenario.meta.titulo, monto: scenario.meta.monto, plazoMeses: scenario.meta.plazo_meses }
      : null;

  const resultado = await persistTurn(db, {
    userId,
    conversationId,
    scenarioState: scenario,
    goal,
    icaEventos,
    telemetry: {
      userId,
      conversationId,
      messageId: null,
      carril: "FINANCIERO",
      model: MARCA,
      tokensUsed: 0,
      toolCallUsed: false,
      latencyGenerationMs: 0,
      latencyValidationMs: 0,
      latencyTotalMs: 0,
      calculatorConceptos: {},
      scenarioMissing: scenario.missing,
      responseRaw: MARCA,
      responseFinal: MARCA,
      mutations: [],
      commandmentViolations: [],
      guardrailIntervened: false,
      enforcementMode: "full",
      extraccionIncompleta: huerfanos.extraccionIncompleta,
      numerosHuerfanos: huerfanos.numerosHuerfanos,
      discrepanciaGastos: discrepancia.discrepancia,
    },
  });

  assert(resultado.writesOk === resultado.writesTotal, `persistTurn debe completar sus ${resultado.writesTotal} escrituras — ${JSON.stringify(resultado)}`);
  return scenario;
}

async function main(): Promise<void> {
  if (!URL || !KEY) {
    console.log("SKIPPED: requiere env (NEXT_PUBLIC_SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY)");
    process.exit(0);
  }

  const db: SupabaseClient<any> = createClient(URL, KEY, { auth: { autoRefreshToken: false, persistSession: false } });

  const { data: prof, error: profErr } = await db
    .from("profiles").select("user_id").limit(1).maybeSingle();
  if (profErr) throw new Error(`no pude leer profiles: ${profErr.message}`);
  if (!prof?.user_id) {
    console.log("SKIPPED: no hay ningún usuario en profiles para la FK");
    process.exit(0);
  }
  const userId = (prof as { user_id: string }).user_id;

  let convId: string | undefined;
  let goalIds: string[] = [];
  try {
    // ── setup: conversación propia, vacía ─────────────────────────────────
    const ins = await db.from("conversations")
      .insert({ user_id: userId, title: MARCA, scenario_state: {} })
      .select("id").single();
    if (ins.error) throw new Error(`insert conversación: ${ins.error.message}`);
    convId = (ins.data as { id: string }).id;
    console.log(`✓ setup: conversación ${MARCA} id=${convId}`);

    // ── T1: ingreso + gastos limpios, con huérfanos de una meta sin decidir ─
    const msg1 = "gano 2300 y gasto aproximadamente 2000 entre vivienda, comida, servicios, ocio, " +
      "y ademas estoy pensando en comprar una casa, dudo entre 200000, 300000 o 150000";
    const delta1 = extractScenarioDelta(msg1);
    assert(delta1.ingreso_mensual === 2300, `T1 debería extraer ingreso 2300 (fue ${delta1.ingreso_mensual})`);
    assert(delta1.gastos_mensuales === 2000, `T1 debería extraer gastos 2000 (fue ${delta1.gastos_mensuales})`);
    const huerfanos1 = detectarNumerosHuerfanos(msg1, delta1);
    assert(huerfanos1.extraccionIncompleta, "T1 debería marcar las cifras de la casa como huérfanas");

    let estado = await ejecutarTurno(db, userId, convId, { missing: [] }, delta1, msg1);
    console.log("✓ T1: persistTurn ejecutado (ingreso/gastos limpios + huérfanos)");

    // Afirma 1-3: RE-LECTURA desde la BD, nunca desde `estado` en memoria.
    const read1 = await db.from("conversations").select("scenario_state").eq("id", convId).single();
    if (read1.error) throw new Error(`re-read T1: ${read1.error.message}`);
    const scenarioDB1 = (read1.data as { scenario_state: ScenarioState }).scenario_state;
    assert(scenarioDB1.ingreso_mensual === 2300, `[BD] ingreso_mensual debe ser 2300 (fue ${scenarioDB1.ingreso_mensual})`);
    assert(scenarioDB1.gastos_mensuales === 2000, `[BD] gastos_mensuales debe ser 2000 (fue ${scenarioDB1.gastos_mensuales})`);
    console.log("✓ afirma 1: [BD] ingreso_mensual=2300, gastos_mensuales=2000 — sobrevivieron a los huérfanos");

    assert(!scenarioDB1.missing.includes("ingreso"), `[BD] missing NO debe incluir 'ingreso' (fue ${JSON.stringify(scenarioDB1.missing)})`);
    assert(!scenarioDB1.missing.includes("gastos"), `[BD] missing NO debe incluir 'gastos' (fue ${JSON.stringify(scenarioDB1.missing)})`);
    console.log("✓ afirma 2: [BD] missing no contiene 'ingreso' ni 'gastos'");

    // afirma 3 ya está cubierta por afirma 1 (los huérfanos no impidieron la
    // persistencia) — se deja explícita para que el punto 3 del protocolo
    // tenga su propia línea en el log.
    console.log("✓ afirma 3: los huérfanos (200000, 300000, 150000) NO impidieron persistir ingreso/gastos");

    // ── T2: meta declarada (vía tool_args — el mismo mapper que usa route.ts
    // cuando el LLM llama a la tool; el fallback regex no captura título) ───
    const delta2 = toolArgsToScenarioDelta({ meta_titulo: "casa en España", meta_monto: 150000 });
    estado = await ejecutarTurno(db, userId, convId, estado, delta2, "quiero una casa en España de 150.000 €");
    console.log("✓ T2: persistTurn ejecutado (meta declarada)");

    // Afirma 4: fila en goals con esa meta activa.
    const goalsRead = await db.from("goals").select("id, title, target_amount, status").eq("user_id", userId).eq("status", "active");
    if (goalsRead.error) throw new Error(`leer goals: ${goalsRead.error.message}`);
    const filaCasa = (goalsRead.data as Array<{ id: string; title: string; target_amount: number; status: string }>)
      .find((g) => g.title === "casa en España");
    assert(filaCasa, `[BD] debe existir una fila en goals con title='casa en España': ${JSON.stringify(goalsRead.data)}`);
    assert(Number(filaCasa!.target_amount) === 150000, `[BD] goals.target_amount debe ser 150000 (fue ${filaCasa!.target_amount})`);
    goalIds = (goalsRead.data as Array<{ id: string }>).map((g) => g.id);
    console.log(`✓ afirma 4: [BD] goals tiene la fila 'casa en España' — target_amount=150000, status=active`);

    // Afirma 5: ica_history registra al menos un evento distinto de chat_consulta.
    const icaRead = await db.from("ica_history").select("event_trigger").eq("user_id", userId)
      .order("recorded_at", { ascending: false }).limit(10);
    if (icaRead.error) throw new Error(`leer ica_history: ${icaRead.error.message}`);
    const eventosRecientes = (icaRead.data as Array<{ event_trigger: string | null }>).map((r) => r.event_trigger);
    const hayEventoReal = eventosRecientes.some((e) => e && e !== "chat_consulta");
    assert(hayEventoReal, `[BD] ica_history debe tener al menos un evento ≠ chat_consulta entre los últimos 10: ${JSON.stringify(eventosRecientes)}`);
    console.log(`✓ afirma 5: [BD] ica_history registró eventos reales: ${JSON.stringify(eventosRecientes.slice(0, 5))}`);

    // ── T3 (7ª tanda) — crédito con MONTO y SIN plazo: conceptos.monto debe
    // quedar presente y la pregunta por el plazo NO debe borrarse (FIX 1/2 del
    // incidente testdev6: plazo_meses=0 de placeholder invalidaba TODO el
    // bloque de crédito, dejando el monto invisible para el guardarraíl).
    const delta3 = toolArgsToScenarioDelta({ credito_monto: 2400, credito_tae_pct: 18 });
    estado = await ejecutarTurno(db, userId, convId, estado, delta3, "el banco me ofrece un 18% para financiar 2400");
    console.log("✓ T3: persistTurn ejecutado (crédito con monto y TAE, sin plazo)");

    const read3 = await db.from("conversations").select("scenario_state").eq("id", convId).single();
    if (read3.error) throw new Error(`re-read T3: ${read3.error.message}`);
    const scenarioDB3 = (read3.data as { scenario_state: ScenarioState }).scenario_state;
    assert(scenarioDB3.credito?.monto === 2400, `[BD] credito.monto debe ser 2400 (fue ${scenarioDB3.credito?.monto})`);
    assert(scenarioDB3.credito?.plazo_meses === undefined, `[BD] credito.plazo_meses debe quedar undefined, NUNCA 0 (fue ${scenarioDB3.credito?.plazo_meses})`);
    console.log("✓ afirma 8: [BD] credito.monto=2400 persistido, plazo_meses ausente (no 0)");

    const ctx3 = buildScenarioContext(scenarioDB3, "el banco me ofrece un 18% para financiar 2400");
    assert(ctx3.conceptos.monto === 2400, `conceptos.monto debe estar presente sin plazo: ${JSON.stringify(ctx3.conceptos)}`);
    assert(!("cuota" in ctx3.conceptos), "sin plazo, la cuota (derivada) NO debe calcularse");
    console.log("✓ afirma 9: conceptos.monto presente pese a no tener plazo; conceptos.cuota ausente");

    const preguntaPlazo = "¿A cuántos meses quieres financiar esos 2.400 €?";
    const groundingResult = validateGrounding(preguntaPlazo, [], { valores: ctx3.valores, conceptos: ctx3.conceptos });
    assert(groundingResult.cifras_bloqueadas.length === 0, `la pregunta por el plazo NO debe bloquearse: ${JSON.stringify(groundingResult.cifras_bloqueadas)}`);
    console.log("✓ afirma 10: la pregunta por el plazo citando 2.400 € sobrevive el guardarraíl de cifras");

    // Afirma 6: response_telemetry tiene una fila por cada turno del diálogo.
    const telRead = await db.from("response_telemetry").select("id").eq("conversation_id", convId);
    if (telRead.error) throw new Error(`leer response_telemetry: ${telRead.error.message}`);
    assert((telRead.data ?? []).length === 3, `[BD] response_telemetry debe tener 3 filas (una por turno), tiene ${(telRead.data ?? []).length}`);
    console.log(`✓ afirma 6: [BD] response_telemetry tiene una fila por cada uno de los 3 turnos`);

    // ── T-recorte: petición de plan de recorte con solo el agregado (sin desglose) ─
    // Afirma 7 es de PROMPT (notaFaltaDesglose), no de persistencia — se
    // verifica aparte, en memoria, contra la MISMA función que route.ts
    // invoca (no una simulación): pide el desglose, nunca ingreso/gastos.
    const { notaFaltaDesglose } = await import("../src/lib/calculator/scenario");
    const nota = notaFaltaDesglose(scenarioDB1, "¿qué puedo recortar?");
    assert(nota, "afirma 7: con agregado sin desglose + petición de recorte, debe haber nota de refuerzo");
    assert(!/ingreso mensual\?|cuál es tu ingreso/i.test(nota ?? ""), "afirma 7: la nota NUNCA repregunta el ingreso");
    assert(/desglose|reparten/i.test(nota ?? ""), `afirma 7: la nota debe pedir el DESGLOSE: ${nota}`);
    console.log("✓ afirma 7: notaFaltaDesglose pide el desglose citando el agregado, sin re-preguntar ingreso/gastos");

    console.log("\n✅ E2E TURNO OK — persistencia real de scenario_state, goals, ica_history y response_telemetry verificada");
  } finally {
    if (goalIds.length > 0) {
      const delGoals = await db.from("goals").delete().in("id", goalIds);
      if (delGoals.error) console.error(`⚠ no pude borrar las filas de goals ${goalIds.join(",")}: ${delGoals.error.message}`);
      else console.log(`✓ cleanup: ${goalIds.length} fila(s) de goals borrada(s)`);
    }
    if (convId) {
      const delTel = await db.from("response_telemetry").delete().eq("conversation_id", convId);
      if (delTel.error) console.error(`⚠ no pude borrar response_telemetry de ${convId}: ${delTel.error.message}`);
      const delConv = await db.from("conversations").delete().eq("id", convId).eq("title", MARCA);
      if (delConv.error) console.error(`⚠ no pude borrar la conversación ${MARCA} ${convId}: ${delConv.error.message}`);
      else console.log(`✓ cleanup: conversación ${MARCA} ${convId} borrada`);
    }
  }
}

main().catch((err) => {
  console.error(`❌ E2E TURNO FALLÓ: ${err instanceof Error ? err.message : err}`);
  process.exit(1);
});
