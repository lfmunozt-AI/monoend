// Tests del orquestador (PIEZA 2) y de su integración con el validador (PIEZA
// 3). Runner nativo de Node (node:test) vía tsx. Ejecutar: `npm test`.

import { test } from "node:test";
import assert from "node:assert/strict";

import { buildVerifiedContext, buildScenarioContext } from "./orchestrator";
import { mergeScenario, extractScenarioDelta, type ScenarioState } from "./scenario";
import { toolArgsToScenarioDelta } from "./tools";
import { validateGrounding } from "../guardrail/validate";

// ── PIEZA 2 — buildVerifiedContext ──────────────────────────────────────────
test("buildVerifiedContext: 'gano 3000, gasto 2000' → realidad con sobrante 1000 y capacidad anual 12000", () => {
  const { bloque, cifrasCalculadas } = buildVerifiedContext("gano 3000, gasto 2000");
  assert.ok(bloque.includes("sobrante_mensual: 1000"), "sobrante 1000 en realidad");
  assert.ok(bloque.includes("capacidad_ahorro_anual: 12000"), "capacidad anual 1000×12");
  // La capacidad real (12000), NO la proyección de la referencia (3600).
  assert.ok(!bloque.includes("3600"), "la vieja proyección del 10% ya no existe");
  assert.ok(cifrasCalculadas.includes(1000));
  assert.ok(cifrasCalculadas.includes(12000));
});

test("buildVerifiedContext: sin hechos → bloque vacío (el modelo pedirá contexto)", () => {
  const r = buildVerifiedContext("Hola, ¿cómo administro mejor?");
  assert.equal(r.bloque, "");
  assert.deepEqual(r.cifrasCalculadas, []);
});

// ── FALLO B — realidad vs referencias ───────────────────────────────────────
test("Fallo B (1): pregunta de capacidad → 12000 del sobrante, NUNCA 3600", () => {
  const { bloque, cifrasCalculadas } = buildVerifiedContext("gano 3000, gasto 2000");
  // La capacidad de ahorro real es sobrante×12 = 12000, no 300×12 = 3600.
  assert.ok(cifrasCalculadas.includes(12000), "12000 es la capacidad verificada");
  assert.ok(!cifrasCalculadas.includes(3600), "3600 (proyección del 10%) NO es realidad");
  assert.ok(bloque.includes("capacidad_ahorro_anual: 12000"));
});

test("Fallo B (2): la referencia va en su sección, etiquetada, y FUERA de cifrasCalculadas", () => {
  const { bloque, cifrasCalculadas } = buildVerifiedContext("gano 3000, gasto 2000");
  assert.ok(bloque.includes("REFERENCIAS ESTÁNDAR"), "sección de referencias presente");
  assert.ok(
    !cifrasCalculadas.includes(300),
    "300 NO alimenta cifrasCalculadas: sin marcador debe poder bloquearse",
  );
});

// ── BUG 2 — referencia como % personalizado; separación capacidad/norma ──────
test("BUG 2: la referencia es un PORCENTAJE, con el monto como aplicación al caso", () => {
  const { bloque, cifrasCalculadas } = buildVerifiedContext("gano 3000, gasto 2000");
  assert.ok(
    bloque.includes("referencia_ahorro_sugerido: 10% del ingreso (= 300 €/mes en tu caso)"),
    `formato nuevo esperado, bloque:\n${bloque}`,
  );
  // El estándar es el %, no el monto: 300 sigue fuera de cifrasCalculadas.
  assert.ok(!cifrasCalculadas.includes(300));
});

test("BUG 2: la sección de REALIDAD no contiene ninguna referencia (capacidad limpia)", () => {
  const { bloque } = buildVerifiedContext("gano 3000, gasto 2000");
  const realidad = bloque.split("REFERENCIAS ESTÁNDAR")[0];
  assert.ok(!realidad.includes("referencia_"), "la sección de capacidad no cita normas");
  assert.ok(!realidad.includes("10%"), "ni el porcentaje normativo");
  // La capacidad real SÍ está para responder a preguntas de capacidad.
  assert.ok(realidad.includes("capacidad_ahorro_anual: 12000"));
});

test("Fallo B (3): no hay re-etiquetado — el sobrante se llama sobrante, no ingreso", () => {
  const { bloque } = buildVerifiedContext("gano 3000, gasto 2000");
  assert.ok(bloque.includes("ingreso_mensual: 3000"), "el ingreso es 3000");
  assert.ok(bloque.includes("sobrante_mensual: 1000"), "el sobrante es 1000, etiqueta propia");
  // El 1000 nunca aparece bajo la etiqueta de ingreso.
  assert.ok(!bloque.includes("ingreso_mensual: 1000"), "el sobrante NO se re-etiqueta como ingreso");
  assert.ok(!/ingreso[^\n]*\b1000\b/.test(bloque.split("REFERENCIAS")[0]), "1000 no cuelga de 'ingreso'");
});

test("Fallo B (4): dos secciones bien formadas y separadas", () => {
  const { bloque } = buildVerifiedContext("gano 3000, gasto 2000");
  const realIdx = bloque.indexOf("TU REALIDAD");
  const refIdx = bloque.indexOf("REFERENCIAS ESTÁNDAR");
  assert.ok(realIdx !== -1, "sección TU REALIDAD");
  assert.ok(refIdx !== -1, "sección REFERENCIAS ESTÁNDAR");
  assert.ok(realIdx < refIdx, "realidad antes que referencias");
  // La referencia no contamina la sección de realidad.
  const seccionRealidad = bloque.slice(realIdx, refIdx);
  assert.ok(!seccionRealidad.includes("referencia_"), "ninguna referencia en TU REALIDAD");
});

test("Fallo B (5): la capacidad verificada 12000 se APRUEBA por el validador", () => {
  const { cifrasCalculadas } = buildVerifiedContext("gano 3000, gasto 2000");
  const r = validateGrounding("Tu capacidad de ahorro anual es de 12000.", [], cifrasCalculadas);
  assert.ok(
    r.cifras_aprobadas.some((c) => c.valor === 12000 && c.categoria === "calculo"),
    "12000 aprobado como cálculo verificado",
  );
  // El 300 de referencia, citado sin marcador, se sigue bloqueando.
  const ref = validateGrounding("Deberías ahorrar 300 al mes.", [], cifrasCalculadas);
  assert.ok(ref.cifras_bloqueadas.some((c) => c.valor === 300), "300 sin marcador → bloqueado");
});

// ── TAREA 2 — cuota de crédito con TAE de referencia ────────────────────────
test("crédito: 'financiar 30000 a 36 meses' → referencia_cuota_credito ~926.31", () => {
  const { bloque, cifrasCalculadas } = buildVerifiedContext("quiero financiar un carro de 30000 a 36 meses");
  assert.ok(bloque.includes("referencia_cuota_credito: 926,31 €/mes"), `bloque:\n${bloque}`);
  assert.ok(bloque.includes("TAE de referencia ~7%"), "marca la simulación explícita");
  assert.ok(bloque.includes("monto 30000 a 36 meses"), "documenta principal y plazo");
  // Excepción de grounding: la cuota SÍ entra en cifrasCalculadas.
  assert.ok(cifrasCalculadas.includes(926.31), "926.31 aprobable por el guardarraíl");
});

test("crédito: la cuota simulada se APRUEBA por el validador (rama c0)", () => {
  const { cifrasCalculadas } = buildVerifiedContext("préstamo de 30000 a 36 meses");
  const r = validateGrounding(
    "Como referencia, con una TAE del 7% la cuota sería 926,31 €/mes.",
    [],
    cifrasCalculadas,
  );
  assert.ok(r.cifras_aprobadas.some((c) => c.valor === 926.31), "cuota aprobada");
  assert.equal(r.cifras_bloqueadas.length, 0);
});

test("crédito: sin palabra de crédito → no se calcula cuota", () => {
  // "30000 en 36 meses" sin verbo de crédito no debe disparar la simulación.
  const { bloque } = buildVerifiedContext("quiero llegar a 30000 en 36 meses");
  assert.ok(!bloque.includes("referencia_cuota_credito"), "no hay escenario de crédito");
});

test("crédito EN: 'loan of 30000 over 36 months' → cuota detectada", () => {
  const { bloque } = buildVerifiedContext("a loan of 30000 over 36 months");
  assert.ok(bloque.includes("referencia_cuota_credito: 926,31 €/mes"), `bloque:\n${bloque}`);
});

// ── PIEZA 1c — lista de gastos clasificada e inyectada ──────────────────────
test("gastos: lista clasificada → vitales/no vitales/recorte/nueva_capacidad", () => {
  const { bloque, cifrasCalculadas } = buildVerifiedContext(
    "gano 10000 gasto 9500. Mis gastos: netflix 100, luz 50, agua 30, cerveza 80, mercado 90.",
  );
  assert.ok(bloque.includes("gastos_vitales: 170 € (luz 50, agua 30, mercado 90)"), `bloque:\n${bloque}`);
  assert.ok(bloque.includes("gastos_no_vitales: 180 € (netflix 100, cerveza 80)"));
  assert.ok(bloque.includes("recorte_propuesto_50pct: 90 € (supuesto: reducir no vitales a la mitad)"));
  assert.ok(bloque.includes("nueva_capacidad: 590 € (sobrante 500 + recorte 90)"));
  // Todas las cifras a grounding, incluidos los montos individuales.
  for (const c of [170, 180, 90, 590, 100, 50, 30, 80]) {
    assert.ok(cifrasCalculadas.includes(c), `${c} debe estar en cifrasCalculadas`);
  }
});

test("gastos: los desconocidos se listan aparte, sin asumir nada", () => {
  const { bloque } = buildVerifiedContext(
    "gano 3000 gasto 2000. Mis gastos: netflix 100, veterinario 200.",
  );
  assert.ok(bloque.includes("gastos_sin_clasificar: veterinario 200 — preguntar si son fijos imprescindibles"), `bloque:\n${bloque}`);
  // El desconocido NO entra al recorte (recorte solo sobre netflix 100 → 50).
  assert.ok(bloque.includes("recorte_propuesto_50pct: 50 €"));
  assert.ok(!bloque.includes("gastos_vitales"), "veterinario no es vital");
});

test("gastos: menos de 2 pares → no se trata como lista", () => {
  const { bloque } = buildVerifiedContext("gano 3000 gasto 2000. pago netflix 100.");
  assert.ok(!bloque.includes("gastos_no_vitales"), "un solo gasto no dispara la clasificación");
});

test("gastos + crédito conviven: cuota y clasificación en el mismo bloque", () => {
  const { bloque } = buildVerifiedContext(
    "gano 10000 gasto 9500. financiar un carro de 30000 a 36 meses. Gastos: netflix 100, luz 50, mercado 90.",
  );
  assert.ok(bloque.includes("referencia_cuota_credito"), "la cuota sigue ahí");
  assert.ok(bloque.includes("gastos_no_vitales: 100 € (netflix 100)"), "y la clasificación también");
  // El carro (30000) no se cuela como gasto; el crédito lo consume aparte.
  assert.ok(!bloque.includes("carro"), "el principal del crédito no entra a la lista de gastos");
});

// ── PIEZA 3 — validateGrounding con cifrasCalculadas ────────────────────────
test("validateGrounding con cifrasCalculadas: aprueba 1000 exacto, bloquea 999", () => {
  const cifras = [1000];

  const aprob = validateGrounding("Tu sobrante mensual es de 1000.", [], cifras);
  assert.ok(
    aprob.cifras_aprobadas.some((c) => c.valor === 1000 && c.categoria === "calculo"),
    "1000 debe aprobarse como cálculo verificado",
  );
  assert.equal(aprob.cifras_bloqueadas.length, 0);

  const bloq = validateGrounding("Tu sobrante mensual es de 999.", [], cifras);
  assert.ok(
    bloq.cifras_bloqueadas.some((c) => c.valor === 999),
    "999 no coincide con ninguna cifra calculada → se bloquea",
  );
});

test("validateGrounding sin cifrasCalculadas mantiene el comportamiento previo", () => {
  // Firma de 2 argumentos intacta: 999 sin respaldo se bloquea igual.
  const r = validateGrounding("Pagarás 999 al mes.", []);
  assert.ok(r.cifras_bloqueadas.some((c) => c.valor === 999));
});

// ── BUG 2 — el déficit es un concepto de primera clase ──────────────────────
test("BUG 2: gastos > ingreso → línea deficit_mensual propia (no un sobrante negativo)", () => {
  const s = mergeScenario(undefined, { ingreso_mensual: 10000, gastos_mensuales: 11000 });
  const { bloque, conceptos, valores } = buildScenarioContext(s, "");
  assert.ok(bloque.includes("deficit_mensual: 1000"), `bloque:\n${bloque}`);
  assert.ok(!bloque.includes("sobrante_mensual: 0"), "el déficit nunca se presenta como sobrante 0");
  assert.ok(bloque.includes("sobrante_mensual: -1000"), "el sobrante real (negativo) sigue en el bloque");
  assert.equal(conceptos.deficit, 1000);
  assert.ok(valores.includes(1000));
  // Con déficit no hay capacidad de ahorro: nunca debe aparecer.
  assert.ok(!bloque.includes("capacidad_ahorro_anual"));
});

test("BUG 2: sobrante positivo → NUNCA aparece deficit_mensual", () => {
  const s = mergeScenario(undefined, { ingreso_mensual: 3000, gastos_mensuales: 2000 });
  const { bloque, conceptos } = buildScenarioContext(s, "");
  assert.ok(!bloque.includes("deficit_mensual"));
  assert.equal(conceptos.deficit, undefined);
});

test("BUG 2: grounding — 'gastas 400 de más' (déficit real 1000) se BLOQUEA, SIN corrección (FIX A)", () => {
  const cif = { valores: [10000, 11000, 1000], conceptos: { ingreso: 10000, gastos: 11000, deficit: 1000 } };
  const r = validateGrounding("Estás en déficit: gastas 400 € de más de lo que ingresas.", [], cif);
  const bloq = r.cifras_bloqueadas.find((c) => c.valor === 400);
  assert.ok(bloq, "400 en posición de déficit se bloquea");
  // FIX A: "déficit" no es un patrón posicional inequívoco (monto/plazo) —
  // ya no se corrige en sitio, se elimina la frase.
  assert.equal(bloq?.correccion, undefined);
});

test("BUG 2: grounding — 'tu déficit mensual es de 1000 €' (correcto) → APROBADA", () => {
  const cif = { valores: [10000, 11000, 1000], conceptos: { ingreso: 10000, gastos: 11000, deficit: 1000 } };
  const r = validateGrounding("Tu déficit mensual es de 1000 €.", [], cif);
  assert.equal(r.cifras_bloqueadas.length, 0);
  assert.ok(r.cifras_aprobadas.some((c) => c.valor === 1000));
});

// ── FIX B — derivadas de decisión (caso real QA: cuota 746,55, sobrante 500) ──
test("FIX B: caso real — cuota 746,55 − sobrante 500 → brecha_mensual 246,55, aprobada", () => {
  const s = mergeScenario(undefined, {
    ingreso_mensual: 2500,
    gastos_mensuales: 2000,
    credito: { monto: 30000, plazo_meses: 48, tae_pct: 9, tae_es_referencia: false },
  });
  const { bloque, conceptos } = buildScenarioContext(s, "");
  assert.ok(bloque.includes("brecha_mensual: 246,55"), `bloque:\n${bloque}`);
  assert.equal(conceptos.cuota, 746.55);
  assert.equal(conceptos.brecha, 246.55);
  assert.equal(conceptos.aumento_necesario, 246.55, "alias de brecha para 'aumentar ingresos'");
  assert.equal(conceptos.recorte_necesario, 246.55, "alias de brecha para 'recorte necesario'");

  const ok = validateGrounding("Te falta una brecha de 246,55 € al mes para cubrir la cuota.", [], { valores: [], conceptos });
  assert.equal(ok.cifras_bloqueadas.length, 0);
  assert.ok(ok.cifras_aprobadas.some((c) => c.valor === 246.55));
});

test("FIX B: brecha citada mal (999 en vez de 246,55) → BLOQUEADA", () => {
  const s = mergeScenario(undefined, {
    ingreso_mensual: 2500,
    gastos_mensuales: 2000,
    credito: { monto: 30000, plazo_meses: 48, tae_pct: 9, tae_es_referencia: false },
  });
  const { conceptos } = buildScenarioContext(s, "");
  const r = validateGrounding("Te falta una brecha de 999 € al mes para cubrir la cuota.", [], { valores: [], conceptos });
  const bloq = r.cifras_bloqueadas.find((c) => c.valor === 999);
  assert.ok(bloq, "999 no coincide con la brecha real (246,55)");
  assert.equal(bloq?.correccion, undefined, "FIX A: se elimina, no se sustituye");
});

test("FIX B: sin brecha (sobrante cubre la cuota) → brecha_mensual NUNCA aparece", () => {
  const s = mergeScenario(undefined, {
    ingreso_mensual: 5000,
    gastos_mensuales: 1000,
    credito: { monto: 10000, plazo_meses: 48, tae_pct: 9, tae_es_referencia: false },
  });
  const { bloque, conceptos } = buildScenarioContext(s, "");
  assert.ok(!bloque.includes("brecha_mensual"), `bloque:\n${bloque}`);
  assert.equal(conceptos.brecha, undefined);
});

test("FIX B: esfuerzo_total = cuota + déficit cuando hay déficit real", () => {
  const s = mergeScenario(undefined, {
    ingreso_mensual: 2000,
    gastos_mensuales: 2500, // déficit 500
    credito: { monto: 30000, plazo_meses: 48, tae_pct: 9, tae_es_referencia: false },
  });
  const { bloque, conceptos } = buildScenarioContext(s, "");
  assert.equal(conceptos.deficit, 500);
  const esfuerzoEsperado = Math.round((conceptos.cuota + 500) * 100) / 100;
  assert.ok(bloque.includes(`esfuerzo_total: ${String(esfuerzoEsperado).replace(".", ",")}`), `bloque:\n${bloque}`);
  assert.equal(conceptos.esfuerzo_total, esfuerzoEsperado);

  const r = validateGrounding(
    `La suma de cuota y déficit es ${String(esfuerzoEsperado).replace(".", ",")} €.`,
    [],
    { valores: [], conceptos },
  );
  assert.equal(r.cifras_bloqueadas.length, 0, "esfuerzo_total correcto se aprueba");
});

test("FIX B: ahorro_necesario_mensual = meta.monto / meta.plazo_meses", () => {
  const s = mergeScenario(undefined, { meta: { titulo: "viaje", monto: 6000, plazo_meses: 12 } });
  const { bloque, conceptos } = buildScenarioContext(s, "");
  assert.ok(bloque.includes("ahorro_necesario_mensual: 500"), `bloque:\n${bloque}`);
  assert.equal(conceptos.ahorro_necesario_mensual, 500);
});

// ── FIX 1/2 (7ª tanda, testdev6) — CERO NO ES UN VALOR + DATOS DECLARADOS
// SIEMPRE EN CONCEPTOS. Bug real: "el banco me ofrece 18%" sobre un crédito
// de 2400€ sin plazo dejaba credito.plazo_meses=0 persistido (placeholder de
// tipo), que invalidaba TODO el bloque de crédito en buildScenarioContext
// (exigía monto>0 Y plazo>0 para exponer siquiera el monto) — el guardarraíl
// bloqueaba "¿A cuántos meses financias esos 2.400€?" por citar una cifra
// "sin respaldo", borrando la propia pregunta que iba a conseguir el plazo.

test("FIX 1: toolArgsToScenarioDelta SIN plazo → credito.plazo_meses ausente, NUNCA 0", () => {
  const delta = toolArgsToScenarioDelta({ credito_monto: 2400, credito_tae_pct: 18 });
  assert.equal(delta.credito?.monto, 2400);
  assert.equal(delta.credito?.plazo_meses, undefined, "plazo_meses debe quedar undefined, no 0");
});

test("FIX 1: extractScenarioDelta 'el banco me ofrece un 18%' (TAE corta) → sin monto/plazo en 0", () => {
  const prev = mergeScenario(undefined, { credito: { monto: 2400, tae_es_referencia: true } });
  const delta = extractScenarioDelta("el banco me ofrece un 18%", "es", prev);
  assert.equal(delta.credito?.tae_pct, 18);
  assert.equal(delta.credito?.monto, undefined, "el delta de la respuesta de TAE no debe traer monto=0");
  assert.equal(delta.credito?.plazo_meses, undefined, "el delta de la respuesta de TAE no debe traer plazo=0");
});

test("FIX 2: crédito con monto y SIN plazo → conceptos.monto presente, conceptos.cuota ausente", () => {
  const s = mergeScenario(
    { ingreso_mensual: 2300, gastos_mensuales: 2200, missing: [] },
    { credito: { monto: 2400, tae_pct: 18, tae_es_referencia: false } },
  );
  assert.equal(s.credito?.plazo_meses, undefined, "precondición: sin plazo declarado");
  const { conceptos, valores } = buildScenarioContext(s, "");
  assert.equal(conceptos.monto, 2400, `conceptos.monto debe estar presente: ${JSON.stringify(conceptos)}`);
  assert.equal(conceptos.tae, 18, "la TAE real también es un dato declarado, no una derivada");
  assert.ok(!("cuota" in conceptos), "sin plazo, la cuota (derivada) NO se calcula");
  assert.ok(valores.includes(2400), "2400 debe estar en valores para que el guardarraíl lo apruebe");
});

test("FIX 2: la pregunta por el plazo sobrevive al grounding (caso real testdev6)", () => {
  const s = mergeScenario(
    { ingreso_mensual: 2300, gastos_mensuales: 2200, missing: [] },
    { credito: { monto: 2400, tae_pct: 18, tae_es_referencia: false } },
  );
  const { conceptos, valores } = buildScenarioContext(s, "");
  const texto = "¿A cuántos meses quieres financiar esos 2.400 €?";
  const r = validateGrounding(texto, [], { valores, conceptos });
  assert.equal(r.cifras_bloqueadas.length, 0, `2.400 no debería bloquearse: ${JSON.stringify(r.cifras_bloqueadas)}`);
});

test("FIX 2: crédito con monto Y plazo → cuota SÍ se calcula (sin regresión)", () => {
  const s = mergeScenario(undefined, { credito: { monto: 2400, plazo_meses: 12, tae_pct: 18, tae_es_referencia: false } });
  const { conceptos } = buildScenarioContext(s, "");
  assert.ok(conceptos.cuota > 0, `con ambos insumos, la cuota SÍ debe calcularse: ${JSON.stringify(conceptos)}`);
});

// ═══════════════════════════════════════════════════════════════════════════
// BLOQUEANTE G1b (follow-up, QA testdev10) — SNAPSHOT ÚNICO POR TURNO.
// "Reducir a la mitad el ocio liberaría 75 €, dejando una capacidad de 375 €"
// combinó el sobrante VIEJO (300 €, de gastos 2200) con la mitad del ocio
// NUEVO (75 €, de gastos 2250) — una cifra que no corresponde a NINGÚN
// snapshot real. `buildScenarioContext` ya es puro (una sola `scenario` de
// entrada); estos tests fijan esa pureza como invariante estructural y
// reproducen la secuencia real para confirmar que, DENTRO DE CADA LLAMADA,
// nunca aparece una `nueva_capacidad`/`sobrante_mensual` mezclando estados.
// El otro extremo del fix (que `route.ts` no deje sobrevivir el borrador de
// LLAMADA 1, generado sobre el snapshot pre-merge, en el historial de
// LLAMADA 2) se fija con un test ESTÁTICO en route.static.test.ts — route.ts
// no se puede ejecutar aquí (depende del runtime de Next.js).
// ═══════════════════════════════════════════════════════════════════════════

test("estructural: nueva_capacidad, cuando aparece, SIEMPRE es sobrante + recorte DE LA MISMA llamada (snapshot único)", () => {
  const s = mergeScenario(
    {},
    extractScenarioDelta("gano 2500 y mis gastos son 2200: arriendo 900, comida 500, luz 400, internet 300, ocio 100"),
  );
  const { conceptos } = buildScenarioContext(s, "");
  if ("nueva_capacidad" in conceptos) {
    assert.equal(
      conceptos.nueva_capacidad,
      round2(conceptos.sobrante + conceptos.recorte),
      "nueva_capacidad debe derivar EXACTAMENTE de sobrante+recorte de esta misma llamada, nunca de otra",
    );
  }
});

test("G1b: secuencia real (T1 establece, T2 corrige ocio → conflicto, T3 pregunta durante el conflicto) — ninguna llamada mezcla estados", () => {
  // T1 — establece ingreso/gastos/ocio=100.
  let s = mergeScenario({}, extractScenarioDelta(
    "gano 2500 y mis gastos son 2200: arriendo 900, comida 500, luz 400, internet 300, ocio 100",
  ));
  const v1 = buildScenarioContext(s, "");
  assert.equal(v1.conceptos.nueva_capacidad, 350, "T1: sobrante 300 + recorte 50 (ocio 100/2), estado consistente");
  assert.equal(s.gastos_conflict, undefined);

  // T2 — corrige el ocio a 150: el agregado (2200) y el detalle (2250) ya no
  // cuadran → conflicto. `verified` (post-merge, EL snapshot que persiste
  // esta llamada) debe OMITIR sobrante/capacidad/recorte — V4.
  const seedT2 = { ...s };
  s = mergeScenario(s, extractScenarioDelta("el ocio en realidad es 150", "es", s));
  assert.ok(s.gastos_conflict, "T2 crea el conflicto (2200 vs 2250)");
  const v2 = buildScenarioContext(s, "");
  assert.ok(!("nueva_capacidad" in v2.conceptos), "T2 post-merge: nueva_capacidad OMITIDA mientras hay conflicto");
  assert.ok(!("sobrante" in v2.conceptos), "T2 post-merge: sobrante OMITIDO mientras hay conflicto");
  // El snapshot PRE-merge de T2 (equivalente a `seed` en route.ts) es una
  // fotografía DISTINTA y válida en sí misma — el bug no es que exista,
  // es que su prosa sobreviva a LLAMADA 2 (fix en route.ts). Aquí solo se
  // confirma que, tomada sola, sigue siendo autoconsistente (ocio 100, no
  // 150 — nunca una mezcla).
  const vSeedT2 = buildScenarioContext(seedT2 as ScenarioState, "el ocio en realidad es 150");
  if ("nueva_capacidad" in vSeedT2.conceptos) {
    assert.equal(vSeedT2.conceptos.recorte, 50, "el snapshot pre-merge de T2 solo conoce el ocio VIEJO (100/2=50), nunca el 150 de este turno");
  }

  // T3 — pregunta durante el conflicto: ambas llamadas (pre-merge y
  // post-merge son el MISMO snapshot ya, porque T3 no trae delta nuevo)
  // deben seguir omitiendo la capacidad.
  const seedT3 = { ...s };
  s = mergeScenario(s, extractScenarioDelta("si reduzco el ocio a la mitad, ¿cuánto me quedaría?", "es", s));
  const v3seed = buildScenarioContext(seedT3 as ScenarioState, "si reduzco el ocio a la mitad, ¿cuánto me quedaría?");
  const v3 = buildScenarioContext(s, "si reduzco el ocio a la mitad, ¿cuánto me quedaría?");
  assert.ok(!("nueva_capacidad" in v3seed.conceptos), "T3 pre-merge: sigue en conflicto, sin capacidad");
  assert.ok(!("nueva_capacidad" in v3.conceptos), "T3 post-merge: sigue en conflicto, sin capacidad");

  // T4 — resuelve el conflicto: ahora SÍ debe aparecer, y con las cifras
  // FRESCAS (sobrante 250, recorte 75 — ocio 150/2), nunca 300/50.
  s = mergeScenario(s, extractScenarioDelta("usa 2250", "es", s));
  assert.equal(s.gastos_conflict, undefined, "T4 resuelve");
  const v4 = buildScenarioContext(s, "");
  assert.equal(v4.conceptos.sobrante, 250);
  assert.equal(v4.conceptos.recorte, 75);
  assert.equal(v4.conceptos.nueva_capacidad, 325, "325 = 250 + 75 — nunca 375 (300 viejo + 75 nuevo)");
});

function round2(n: number): number {
  return Math.round((n + Number.EPSILON) * 100) / 100;
}
