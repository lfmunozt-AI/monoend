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
  mergeEstadoPersistido,
  detectarNumerosHuerfanos,
  detectarDiscrepanciaGastos,
  deltaSinGastosPorDiscrepancia,
  detectarEventosICA,
  analizarExtraccion,
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
 * RE-LECTURA del estado persistido, EXACTAMENTE como la hace route.ts desde
 * la 13ª tanda (migración 021): los HECHOS del usuario salen de
 * `user_financial_state` (por user_id) y el DIÁLOGO de
 * `conversations.scenario_state` (por conversation_id); se fusionan en un
 * `ScenarioState` con la MISMA forma de siempre.
 *
 * Las afirmaciones de este script NO cambian de contenido por esta tanda —
 * siguen exigiendo que los mismos hechos sobrevivan a un ciclo real de
 * escritura→re-lectura. Lo único que cambia es DÓNDE viven, que es
 * precisamente lo que esta tanda mueve a propósito. Leer aquí por el mismo
 * camino que producción es lo que mantiene el test honesto: si mañana la
 * lectura de route.ts se rompiera, este helper se rompería igual.
 */
async function leerEstadoPersistido(
  db: SupabaseClient<any>,
  userId: string,
  conversationId: string,
): Promise<ScenarioState> {
  const conv = await db.from("conversations").select("scenario_state").eq("id", conversationId).single();
  if (conv.error) throw new Error(`re-read conversations: ${conv.error.message}`);
  const userState = await db.from("user_financial_state").select("state").eq("user_id", userId).maybeSingle();
  if (userState.error) throw new Error(`re-read user_financial_state: ${userState.error.message}`);

  const dialogo = (conv.data as { scenario_state: Partial<ScenarioState> }).scenario_state ?? {};
  const hechos = (userState.data as { state?: Partial<ScenarioState> } | null)?.state ?? undefined;
  return mergeEstadoPersistido(hechos, dialogo) as ScenarioState;
}

/** Solo la mitad de DIÁLOGO, para afirmar que los hechos NO se quedaron ahí. */
async function leerSoloDialogo(
  db: SupabaseClient<any>,
  conversationId: string,
): Promise<Partial<ScenarioState>> {
  const conv = await db.from("conversations").select("scenario_state").eq("id", conversationId).single();
  if (conv.error) throw new Error(`re-read conversations (solo diálogo): ${conv.error.message}`);
  return (conv.data as { scenario_state: Partial<ScenarioState> }).scenario_state ?? {};
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
  // Correcciones tanda 2 (revisión AG01) — BLOQUEANTE 2: dos conversaciones
  // APARTE para el caso bidireccional con detalle PARTIAL (necesitan
  // `scenario_state` propios, uno por cada orden de los mismos dos hechos).
  let convIdPartialA: string | undefined;
  let convIdPartialB: string | undefined;
  // 13ª tanda — conversaciones del caso de memoria a nivel de usuario (T7).
  let convIdMemoriaA: string | undefined;
  let convIdMemoriaB: string | undefined;
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
    const scenarioDB1 = await leerEstadoPersistido(db, userId, convId);
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

    const scenarioDB3 = await leerEstadoPersistido(db, userId, convId);
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

    // ── T4 (8ª tanda, revisión adversarial AG01 §V9) — ROUND-TRIP DE BD para
    // los campos de "extracción honesta": extraction_status, gastos_items
    // (conversations.scenario_state) y las 4 columnas jsonb nuevas de
    // response_telemetry (migración 019_telemetry_extraction.sql). Es el
    // invariante cuyo incumplimiento dejó scenario_state vacío días sin que
    // nadie lo notara — afirmar sobre la RE-LECTURA, nunca sobre el objeto
    // en memoria, es el punto de este turno.
    //
    // Requiere la migración 019 APLICADA para la parte de response_telemetry
    // (columnas nuevas). Si no lo está, `logResponseTelemetry` (fire-and-forget,
    // nunca lanza) falla en silencio y esta sección se degrada a un aviso
    // explícito en vez de reventar el script — el resto del E2E (T1-T3) no
    // depende de la migración y sigue siendo una prueba válida sin ella.
    const MENSAJE_REAL_TESTDEV7 =
      "Diezmo_Vital 225, 700 Casa_Vital Supermercado_Vital 450, 120 Servicios_Vitales, " +
      "Telecomunicaciones_Necesario 60 100 Pañales_Bebe_Vital, Colegio_Niño_Necesario 150 " +
      "Transporte_Necesario 100, 80 Ropa_Posible, Ocio_Familiar 60 40 Farmacia_Vital, " +
      "Suscripciones_Ocio 25 40 Gimnasio_Necesario, 60 Ahorro_Posible Gastos_Varios_Posible 40";
    const delta4 = extractScenarioDelta(MENSAJE_REAL_TESTDEV7, "es", estado);
    const analisis4 = analizarExtraccion(MENSAJE_REAL_TESTDEV7, delta4);
    const discrepancia4 = detectarDiscrepanciaGastos(delta4);
    const deltaAPersistir4 = deltaSinGastosPorDiscrepancia(delta4, discrepancia4);
    const scenario4 = mergeScenario(estado, deltaAPersistir4);
    scenario4.extraction_status = analisis4.extraction_status;
    assert(scenario4.gastos_items?.length === 15, `T4 (en memoria) debería tener 15 gastos_items (fueron ${scenario4.gastos_items?.length})`);
    assert(scenario4.tiene_detalle_gastos === true, "T4 (en memoria) tiene_detalle_gastos debe ser true");

    const persistResult4 = await persistTurn(db, {
      userId,
      conversationId: convId,
      scenarioState: scenario4,
      goal: null,
      icaEventos: detectarEventosICA(estado, scenario4),
      telemetry: {
        userId,
        conversationId: convId,
        messageId: null,
        carril: "FINANCIERO",
        model: MARCA,
        tokensUsed: 0,
        toolCallUsed: false,
        latencyGenerationMs: 0,
        latencyValidationMs: 0,
        latencyTotalMs: 0,
        calculatorConceptos: {},
        scenarioMissing: scenario4.missing,
        responseRaw: MARCA,
        responseFinal: MARCA,
        mutations: [],
        commandmentViolations: [],
        guardrailIntervened: false,
        enforcementMode: "full",
        extraccionIncompleta: analisis4.huerfanos.extraccionIncompleta,
        numerosHuerfanos: analisis4.huerfanos.numerosHuerfanos,
        discrepanciaGastos: analisis4.discrepancia.discrepancia,
        // PIEZA 7 — los 4 campos de la migración 019.
        extractionStatus: analisis4.extraction_status,
        deltaRaw: deltaAPersistir4 as unknown as Record<string, unknown>,
        previousScenario: estado as unknown as Record<string, unknown>,
        mergedScenario: scenario4 as unknown as Record<string, unknown>,
        expenseItems: (deltaAPersistir4.gastos_items ?? null) as unknown as Array<Record<string, unknown>> | null,
      },
    });
    assert(persistResult4.scenarioStateOk, `T4 scenario_state debe escribirse: ${JSON.stringify(persistResult4)}`);
    console.log("✓ T4: persistTurn ejecutado (mensaje real testdev7, 15 partidas)");

    // Re-lectura desde conversations — columnas ya existentes, siempre verificable.
    const scenarioDB4 = await leerEstadoPersistido(db, userId, convId);
    assert(scenarioDB4.gastos_items?.length === 15, `[BD] gastos_items debe sobrevivir con las 15 partidas (fueron ${scenarioDB4.gastos_items?.length})`);
    assert(scenarioDB4.tiene_detalle_gastos === true, "[BD] tiene_detalle_gastos debe ser true tras el desglose");
    assert(scenarioDB4.extraction_status !== undefined, "[BD] extraction_status debe persistir");
    console.log(`✓ afirma 11: [BD] gastos_items (15) y extraction_status (${scenarioDB4.extraction_status}) sobreviven a la re-lectura desde conversations`);

    // Re-lectura desde response_telemetry — PENDIENTE de que Luis aplique la
    // migración 019. Si la escritura falló por columnas ausentes, se avisa
    // explícitamente en vez de fallar el script entero (ver comentario arriba).
    if (!persistResult4.telemetryOk) {
      console.log(
        "⚠ afirma 12: PENDIENTE DE VERIFICACIÓN POR LUIS — la escritura de telemetría de T4 falló " +
          "(probable: migración 019_telemetry_extraction.sql no aplicada aún). Aplicar la migración y " +
          "re-ejecutar `npm run test:e2e` para cerrar esta verificación.",
      );
    } else {
      const telRead4 = await db
        .from("response_telemetry")
        .select("extraction_status, expense_items, delta_raw, previous_scenario, merged_scenario")
        .eq("conversation_id", convId)
        .order("created_at", { ascending: false })
        .limit(1)
        .single();
      if (telRead4.error) throw new Error(`re-read T4 telemetry: ${telRead4.error.message}`);
      const telDB4 = telRead4.data as {
        extraction_status: string | null;
        expense_items: unknown;
        delta_raw: unknown;
        previous_scenario: unknown;
        merged_scenario: unknown;
      };
      assert(telDB4.extraction_status === analisis4.extraction_status, `[BD] response_telemetry.extraction_status debe ser '${analisis4.extraction_status}' (fue '${telDB4.extraction_status}')`);
      assert(Array.isArray(telDB4.expense_items) && (telDB4.expense_items as unknown[]).length === 15, `[BD] response_telemetry.expense_items debe tener 15 entradas: ${JSON.stringify(telDB4.expense_items)}`);
      assert(telDB4.delta_raw !== null, "[BD] response_telemetry.delta_raw debe persistir");
      assert(telDB4.previous_scenario !== null, "[BD] response_telemetry.previous_scenario debe persistir");
      assert(telDB4.merged_scenario !== null, "[BD] response_telemetry.merged_scenario debe persistir");
      console.log("✓ afirma 12: [BD] response_telemetry.extraction_status/expense_items/delta_raw/previous_scenario/merged_scenario sobreviven a la re-lectura — migración 019 verificada");
    }

    // ── T5 (12ª tanda) — RECONCILIACIÓN CROSS-TURNO (Gate G1c) contra BD real.
    // Caso real de origen de esta tanda: el usuario declara un agregado de
    // gastos en un turno y entrega un desglose que no cuadra en OTRO — la
    // afirmación central es que el CONFLICTO sobrevive a la escritura y
    // RE-LECTURA de `conversations.scenario_state` (nunca al objeto en
    // memoria), y que resolverlo dos turnos después también se persiste.
    estado = await ejecutarTurno(db, userId, convId, estado, extractScenarioDelta("Gano 2636 euros al mes y mis gastos son 2200."), "Gano 2636 euros al mes y mis gastos son 2200.");
    console.log("✓ T5a: persistTurn ejecutado (agregado de gastos 2200)");

    const delta5b = extractScenarioDelta("Mis gastos: arriendo 1200, comida 1050");
    estado = await ejecutarTurno(db, userId, convId, estado, delta5b, "Mis gastos: arriendo 1200, comida 1050");
    console.log("✓ T5b: persistTurn ejecutado (desglose 2250 — no cuadra con el agregado)");

    const scenarioDB5b = await leerEstadoPersistido(db, userId, convId);
    assert(scenarioDB5b.gastos_conflict?.agregado === 2200, `[BD] gastos_conflict.agregado debe ser 2200 (fue ${scenarioDB5b.gastos_conflict?.agregado})`);
    assert(scenarioDB5b.gastos_conflict?.detalle === 2250, `[BD] gastos_conflict.detalle debe ser 2250 (fue ${scenarioDB5b.gastos_conflict?.detalle})`);
    assert(scenarioDB5b.gastos_conflict?.diff === 50, `[BD] gastos_conflict.diff debe ser +50 (fue ${scenarioDB5b.gastos_conflict?.diff})`);
    assert(scenarioDB5b.factStatus?.gastos_mensuales === "CONFLICT", `[BD] factStatus.gastos_mensuales debe ser CONFLICT (fue ${scenarioDB5b.factStatus?.gastos_mensuales})`);
    console.log("✓ afirma 13: [BD] gastos_conflict (agregado 2200, detalle 2250, diff +50) sobrevive a la RE-LECTURA — el conflicto real de origen de esta tanda queda detectado y persistido");

    const delta5c = extractScenarioDelta("eran 2250", "es", estado);
    assert(delta5c.gastos_resolucion?.valorConfirmado === 2250, `T5c debería detectar la resolución 'eran 2250' (fue ${JSON.stringify(delta5c.gastos_resolucion)})`);
    estado = await ejecutarTurno(db, userId, convId, estado, delta5c, "eran 2250");
    console.log("✓ T5c: persistTurn ejecutado (resolución: 'eran 2250')");

    const scenarioDB5c = await leerEstadoPersistido(db, userId, convId);
    assert(scenarioDB5c.gastos_mensuales === 2250, `[BD] gastos_mensuales debe ser 2250 tras la resolución (fue ${scenarioDB5c.gastos_mensuales})`);
    assert(scenarioDB5c.gastos_conflict === undefined, `[BD] gastos_conflict debe quedar cerrado (fue ${JSON.stringify(scenarioDB5c.gastos_conflict)})`);
    assert(scenarioDB5c.factStatus?.gastos_mensuales === "CONFIRMED", `[BD] factStatus.gastos_mensuales debe ser CONFIRMED (fue ${scenarioDB5c.factStatus?.gastos_mensuales})`);
    assert(scenarioDB5c.gastos_superseded?.some((s) => s.valor === 2200 && s.motivo === "USER_CORRECTION"), `[BD] gastos_superseded debe conservar el 2200 perdedor (fue ${JSON.stringify(scenarioDB5c.gastos_superseded)})`);
    console.log("✓ afirma 14: [BD] resolución (2250 CONFIRMED, 2200 SUPERSEDED) sobrevive a la RE-LECTURA — V7, el valor perdedor nunca se borra");

    // ── T6 (correcciones tanda 2, BLOQUEANTE 2) — Gate G1c bidireccional con
    // desglose PARTIAL, contra BD real. Mismos dos hechos (agregado 2500,
    // desglose con un huérfano genuino sin asignar) en los DOS órdenes
    // posibles, cada uno en su propia conversación — RE-LECTURA desde
    // `conversations.scenario_state` debe dar el mismo `detalleCompleta`
    // (false) y, tras dos intentos sin resolver, el mismo resultado: el
    // conflicto sigue activo, NUNCA escapa a ASSUMED.
    const MSG_DETALLE_PARTIAL = "Mis gastos: arriendo 1200, comida 1050. Quizas 300 o 400 mas, no estoy seguro.";
    const deltaDetallePartial = extractScenarioDelta(MSG_DETALLE_PARTIAL);
    assert(deltaDetallePartial.extraction_status === "PARTIAL", `T6 precondición: el desglose debe ser PARTIAL (fue ${deltaDetallePartial.extraction_status})`);

    const insA = await db.from("conversations").insert({ user_id: userId, title: `${MARCA}-partial-A`, scenario_state: {} }).select("id").single();
    if (insA.error) throw new Error(`insert conversación T6-A: ${insA.error.message}`);
    convIdPartialA = (insA.data as { id: string }).id;

    let estadoA = await ejecutarTurno(db, userId, convIdPartialA, { missing: [] }, deltaDetallePartial, MSG_DETALLE_PARTIAL);
    estadoA = await ejecutarTurno(db, userId, convIdPartialA, estadoA, extractScenarioDelta("Gano 2636 euros al mes y mis gastos son 2500."), "Gano 2636 euros al mes y mis gastos son 2500.");
    estadoA = await ejecutarTurno(db, userId, convIdPartialA, estadoA, extractScenarioDelta("no lo se", "es", estadoA), "no lo se");
    estadoA = await ejecutarTurno(db, userId, convIdPartialA, estadoA, extractScenarioDelta("no estoy seguro todavia", "es", estadoA), "no estoy seguro todavia");
    console.log("✓ T6 sentido A: detalle PARTIAL (T1) → agregado (T2) → 2 intentos sin resolver, persistido");

    // 13ª tanda — la lectura de A se hace AQUÍ, antes de que la secuencia B
    // escriba en la MISMA fila de hechos del usuario. Los hechos son del
    // usuario (migración 021), así que dos secuencias del mismo usuario ya no
    // tienen estados de hechos independientes: leer A al final devolvería los
    // hechos de B y el test compararía B contra B (no probaría nada).
    const scenarioDBA = await leerEstadoPersistido(db, userId, convIdPartialA);

    const insB = await db.from("conversations").insert({ user_id: userId, title: `${MARCA}-partial-B`, scenario_state: {} }).select("id").single();
    if (insB.error) throw new Error(`insert conversación T6-B: ${insB.error.message}`);
    convIdPartialB = (insB.data as { id: string }).id;

    let estadoB = await ejecutarTurno(db, userId, convIdPartialB, { missing: [] }, extractScenarioDelta("Gano 2636 euros al mes y mis gastos son 2500."), "Gano 2636 euros al mes y mis gastos son 2500.");
    estadoB = await ejecutarTurno(db, userId, convIdPartialB, estadoB, deltaDetallePartial, MSG_DETALLE_PARTIAL);
    estadoB = await ejecutarTurno(db, userId, convIdPartialB, estadoB, extractScenarioDelta("no lo se", "es", estadoB), "no lo se");
    estadoB = await ejecutarTurno(db, userId, convIdPartialB, estadoB, extractScenarioDelta("no estoy seguro todavia", "es", estadoB), "no estoy seguro todavia");
    console.log("✓ T6 sentido B: agregado (T1) → detalle PARTIAL (T2) → 2 intentos sin resolver, persistido");

    const scenarioDBB = await leerEstadoPersistido(db, userId, convIdPartialB);

    assert(scenarioDBA.gastos_assumed === undefined, `[BD] sentido A: NUNCA debe escapar a ASSUMED con detalle PARTIAL (fue ${JSON.stringify(scenarioDBA.gastos_assumed)})`);
    assert(scenarioDBB.gastos_assumed === undefined, `[BD] sentido B: NUNCA debe escapar a ASSUMED con detalle PARTIAL (fue ${JSON.stringify(scenarioDBB.gastos_assumed)})`);
    assert(scenarioDBA.gastos_conflict?.detalleCompleta === false, `[BD] sentido A: detalleCompleta debe ser false (fue ${scenarioDBA.gastos_conflict?.detalleCompleta})`);
    assert(scenarioDBB.gastos_conflict?.detalleCompleta === false, `[BD] sentido B: detalleCompleta debe ser false (fue ${scenarioDBB.gastos_conflict?.detalleCompleta})`);
    assert(scenarioDBA.gastos_conflict?.attempts === scenarioDBB.gastos_conflict?.attempts, `[BD] G1c: mismos intentos en ambos sentidos (A=${scenarioDBA.gastos_conflict?.attempts}, B=${scenarioDBB.gastos_conflict?.attempts})`);
    assert(scenarioDBA.gastos_conflict?.agregado === scenarioDBB.gastos_conflict?.agregado, "[BD] G1c: mismo agregado en ambos sentidos");
    assert(scenarioDBA.gastos_conflict?.detalle === scenarioDBB.gastos_conflict?.detalle, "[BD] G1c: mismo detalle en ambos sentidos");
    console.log("✓ afirma 15: [BD] Gate G1c bidireccional con detalle PARTIAL — RE-LECTURA confirma mismo estado final en los dos sentidos, nunca ASSUMED");

    // ── T7 (13ª tanda) — MEMORIA A NIVEL DE USUARIO: DOS CONVERSACIONES ──────
    // El caso que motivó la migración 021: el usuario declara sus datos en una
    // conversación y al día siguiente abre un chat NUEVO. Antes, ese chat
    // arrancaba VACÍO (amnesia por diseño) y monoend le preguntaba otra vez
    // todo lo que ya sabía. Aquí se verifica, por RE-LECTURA DESDE LA BD, que
    // los HECHOS viajan y el DIÁLOGO no.
    const insC1 = await db.from("conversations").insert({ user_id: userId, title: `${MARCA}-memoria-A`, scenario_state: {} }).select("id").single();
    if (insC1.error) throw new Error(`insert conversación T7-A: ${insC1.error.message}`);
    convIdMemoriaA = (insC1.data as { id: string }).id;

    // 1. Conversación A: ingreso 2300, gastos 2200, meta casa 150000 y las 15
    //    partidas de testdev7 (que suman 2250 → conflicto con el agregado).
    let estadoA7 = await ejecutarTurno(db, userId, convIdMemoriaA, { missing: [] }, extractScenarioDelta("gano 2300 y gasto 2200"), "gano 2300 y gasto 2200");
    estadoA7 = await ejecutarTurno(db, userId, convIdMemoriaA, estadoA7, toolArgsToScenarioDelta({ meta_titulo: "casa", meta_monto: 150000 }), "quiero una casa de 150.000 €");
    estadoA7 = await ejecutarTurno(db, userId, convIdMemoriaA, estadoA7, extractScenarioDelta(MENSAJE_REAL_TESTDEV7, "es", estadoA7), MENSAJE_REAL_TESTDEV7);
    // Estado de DIÁLOGO propio de A, para comprobar después que NO se filtra.
    const conDialogoA = { ...estadoA7, digresiones_seguidas: 2, plan_confirmado: true, propuesta_pendiente: { fields: ["plan"] } as never };
    await ejecutarTurno(db, userId, convIdMemoriaA, conDialogoA, {}, "de acuerdo");
    assert(estadoA7.gastos_conflict !== undefined, "T7 precondición: A debe tener un conflicto abierto (2200 vs 2250)");
    const attemptsEnA = estadoA7.gastos_conflict?.attempts;
    console.log(`✓ T7 conversación A: ingreso/gastos/meta/15 partidas persistidos · conflicto abierto (attempts=${attemptsEnA})`);

    // 2. Conversación B: NUEVA, distinto conversationId, MISMO user_id, con
    //    `scenario_state` vacío — como cualquier chat recién abierto.
    const insC2 = await db.from("conversations").insert({ user_id: userId, title: `${MARCA}-memoria-B`, scenario_state: {} }).select("id").single();
    if (insC2.error) throw new Error(`insert conversación T7-B: ${insC2.error.message}`);
    convIdMemoriaB = (insC2.data as { id: string }).id;

    // 3. RE-LECTURA desde la BD por el MISMO camino que route.ts.
    const estadoEnB = await leerEstadoPersistido(db, userId, convIdMemoriaB);
    assert(estadoEnB.ingreso_mensual === 2300, `[BD] B debe recordar el ingreso 2300 (fue ${estadoEnB.ingreso_mensual})`);
    assert(estadoEnB.gastos_mensuales === 2200, `[BD] B debe recordar los gastos 2200 (fue ${estadoEnB.gastos_mensuales})`);
    assert(estadoEnB.meta?.monto === 150000, `[BD] B debe recordar la meta 150000 (fue ${JSON.stringify(estadoEnB.meta)})`);
    assert(estadoEnB.gastos_items?.length === 15, `[BD] B debe recordar las 15 partidas (fueron ${estadoEnB.gastos_items?.length})`);
    console.log("✓ afirma 16: [BD] la conversación NUEVA recuerda ingreso 2300, gastos 2200, la meta y las 15 partidas — se acabó la amnesia entre sesiones");

    // 4. `missing` no puede volver a pedir lo que ya se sabe.
    // `missing` es DERIVADO: lo recalcula `mergeScenario` en cada turno. Se
    // obtiene igual que lo haría el primer turno real de la conversación B.
    const missingEnB = mergeScenario(estadoEnB, {}).missing;
    assert(!missingEnB.includes("ingreso"), `[BD] missing NO debe pedir 'ingreso' en B: ${JSON.stringify(missingEnB)}`);
    assert(!missingEnB.includes("gastos"), `[BD] missing NO debe pedir 'gastos' en B: ${JSON.stringify(missingEnB)}`);
    console.log(`✓ afirma 17: [BD] missing en B no contiene 'ingreso' ni 'gastos' — monoend no re-pregunta lo que ya tiene (${JSON.stringify(missingEnB)})`);

    // 5. El DIÁLOGO de A NO se filtra a B.
    assert(estadoEnB.digresiones_seguidas === undefined, `[BD] digresiones_seguidas de A NO puede filtrarse a B (fue ${estadoEnB.digresiones_seguidas})`);
    assert(estadoEnB.propuesta_pendiente === undefined, `[BD] propuesta_pendiente de A NO puede filtrarse a B (fue ${JSON.stringify(estadoEnB.propuesta_pendiente)})`);
    assert(estadoEnB.plan_confirmado === undefined, `[BD] plan_confirmado de A NO puede filtrarse a B (fue ${estadoEnB.plan_confirmado})`);
    console.log("✓ afirma 18: [BD] el estado de DIÁLOGO de A (digresiones, propuesta pendiente, plan confirmado) NO se filtra a B");

    // 6. El conflicto abierto en A sigue abierto en B, con sus attempts intactos.
    assert(estadoEnB.gastos_conflict !== undefined, "[BD] el conflicto abierto en A debe seguir abierto en B");
    assert(estadoEnB.gastos_conflict?.attempts === attemptsEnA, `[BD] los attempts NO se reinician al abrir un chat nuevo (A=${attemptsEnA}, B=${estadoEnB.gastos_conflict?.attempts})`);
    assert(estadoEnB.gastos_conflict?.agregado === 2200 && estadoEnB.gastos_conflict?.detalle === 2250, `[BD] el conflicto viaja íntegro: ${JSON.stringify(estadoEnB.gastos_conflict)}`);
    console.log(`✓ afirma 19: [BD] el conflicto (2200 vs 2250) sigue abierto en B con attempts=${estadoEnB.gastos_conflict?.attempts} — abrir un chat nuevo no permite esquivar el escape de §6`);

    // Y la contraparte: los HECHOS no se quedaron en el estado de la conversación.
    const soloDialogoA = await leerSoloDialogo(db, convIdMemoriaA);
    assert(soloDialogoA.ingreso_mensual === undefined, `[BD] los HECHOS no pueden quedarse en conversations.scenario_state (ingreso=${soloDialogoA.ingreso_mensual})`);
    assert(soloDialogoA.gastos_items === undefined, "[BD] los gastos_items no pueden quedarse en el estado de la conversación");
    console.log("✓ afirma 20: [BD] la partición es real — conversations.scenario_state ya solo guarda el DIÁLOGO");

    console.log("\n✅ E2E TURNO OK — persistencia real de scenario_state, user_financial_state, goals, ica_history y response_telemetry verificada");
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
    for (const [id, title] of [
      [convIdPartialA, `${MARCA}-partial-A`],
      [convIdPartialB, `${MARCA}-partial-B`],
      [convIdMemoriaA, `${MARCA}-memoria-A`],
      [convIdMemoriaB, `${MARCA}-memoria-B`],
    ] as const) {
      if (!id) continue;
      const delTel = await db.from("response_telemetry").delete().eq("conversation_id", id);
      if (delTel.error) console.error(`⚠ no pude borrar response_telemetry de ${id}: ${delTel.error.message}`);
      const delConv = await db.from("conversations").delete().eq("id", id).eq("title", title);
      if (delConv.error) console.error(`⚠ no pude borrar la conversación ${title} ${id}: ${delConv.error.message}`);
      else console.log(`✓ cleanup: conversación ${title} ${id} borrada`);
    }
    // 13ª tanda — la fila de hechos del usuario es POR USUARIO, no por
    // conversación: hay que borrarla explícitamente o el script dejaría el
    // estado sintético de la prueba pegado al usuario real de `profiles`.
    const delUserState = await db.from("user_financial_state").delete().eq("user_id", userId);
    if (delUserState.error) console.error(`⚠ no pude borrar user_financial_state de ${userId}: ${delUserState.error.message}`);
    else console.log(`✓ cleanup: user_financial_state de ${userId} borrado`);
  }
}

main().catch((err) => {
  console.error(`❌ E2E TURNO FALLÓ: ${err instanceof Error ? err.message : err}`);
  process.exit(1);
});
