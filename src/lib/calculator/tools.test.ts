// Tests del mapeo de args de la tool a ScenarioState (function calling).

import { test } from "node:test";
import assert from "node:assert/strict";

import { toolArgsToScenarioDelta, registrarDatosFinancieros, resolveDelta, buildToolResult } from "./tools";
import { mergeScenario } from "./scenario";
import { buildScenarioContext } from "./orchestrator";

test("mapeo: ingreso + gastos + crédito con TAE real → delta correcto", () => {
  const d = toolArgsToScenarioDelta({
    ingreso_mensual: 2500,
    gastos_mensuales: 1500,
    credito_monto: 30000,
    credito_plazo_meses: 36,
    credito_tae_pct: 9,
  });
  assert.equal(d.ingreso_mensual, 2500);
  assert.equal(d.gastos_mensuales, 1500);
  assert.equal(d.credito?.monto, 30000);
  assert.equal(d.credito?.plazo_meses, 36);
  assert.equal(d.credito?.tae_pct, 9);
  assert.equal(d.credito?.tae_es_referencia, false, "TAE aportada → deja de ser referencia");
});

test("mapeo: crédito SIN TAE → tae_es_referencia true", () => {
  const d = toolArgsToScenarioDelta({ credito_monto: 30000, credito_plazo_meses: 48 });
  assert.equal(d.credito?.tae_es_referencia, true);
  assert.equal(d.credito?.tae_pct, undefined);
});

test("mapeo: solo la TAE (2º turno) → subcampo que el merge fusiona", () => {
  const d = toolArgsToScenarioDelta({ credito_tae_pct: 9 });
  assert.equal(d.credito?.tae_pct, 9);
  assert.equal(d.credito?.tae_es_referencia, false);
  // Fusiona sobre un crédito previo sin borrar monto/plazo.
  const s = mergeScenario({ credito: { monto: 30000, plazo_meses: 48, tae_es_referencia: true } }, d);
  assert.equal(s.credito?.monto, 30000);
  assert.equal(s.credito?.plazo_meses, 48);
  assert.equal(s.credito?.tae_pct, 9);
  assert.equal(s.credito?.tae_es_referencia, false);
});

test("mapeo: gastos_detalle → clasificado, gastos_es_detalle, NO machaca agregado", () => {
  const d = toolArgsToScenarioDelta({
    gastos_detalle: [
      { nombre: "netflix", monto: 15 },
      { nombre: "luz", monto: 80 },
      { nombre: "cerveza", monto: 120 },
    ],
  });
  assert.equal(d.gastos_es_detalle, true);
  assert.equal(d.gastos_detalle?.noVitales, 135, "netflix 15 + cerveza 120");
  assert.equal(d.gastos_detalle?.vitales, 80, "luz 80");
  assert.equal(d.gastos_mensuales, undefined, "no toca el agregado");
});

test("mapeo: meta con título, monto y plazo", () => {
  const d = toolArgsToScenarioDelta({ meta_titulo: "comprar un piso", meta_monto: 12000, meta_plazo_meses: 24 });
  assert.equal(d.meta?.titulo, "comprar un piso");
  assert.equal(d.meta?.monto, 12000);
  assert.equal(d.meta?.plazo_meses, 24);
});

test("mapeo: args vacíos o basura → delta vacío (no inventa)", () => {
  assert.deepEqual(toolArgsToScenarioDelta({}), {});
  assert.deepEqual(toolArgsToScenarioDelta({ ingreso_mensual: 0, credito_monto: -5 }), {});
  // TAE fuera de rango se ignora.
  const d = toolArgsToScenarioDelta({ credito_tae_pct: 250 });
  assert.equal(d.credito?.tae_pct, undefined);
});

test("mapeo: strings numéricos tolerados ('2500', '9,5')", () => {
  const d = toolArgsToScenarioDelta({ ingreso_mensual: "2500", credito_tae_pct: "9,5", credito_monto: 30000, credito_plazo_meses: 36 });
  assert.equal(d.ingreso_mensual, 2500);
  assert.equal(d.credito?.tae_pct, 9.5);
});

test("end-to-end: tool args → merge → buildScenarioContext recalcula la cuota real", () => {
  let s = mergeScenario({ ingreso_mensual: 2500, gastos_mensuales: 1500 },
    toolArgsToScenarioDelta({ credito_monto: 30000, credito_plazo_meses: 36 }));
  // 2º turno: solo la TAE real.
  s = mergeScenario(s, toolArgsToScenarioDelta({ credito_tae_pct: 9 }));
  const ctx = buildScenarioContext(s, "");
  assert.ok(Math.abs((ctx.conceptos.cuota ?? 0) - 953.99) <= 1, `cuota ≈ 953,99 (fue ${ctx.conceptos.cuota})`);
  assert.equal(s.credito?.tae_es_referencia, false, "TAE real → no es simulación");
});

// ── resolveDelta — decisión toolCall vs fallback regex ────────────────────────
test("resolveDelta: CON toolArgs → usa la extracción del tool (usedTool)", () => {
  const r = resolveDelta({ toolArgs: { ingreso_mensual: 2500 }, message: "gano 2500", lang: "es" });
  assert.equal(r.usedTool, true);
  assert.equal(r.delta.ingreso_mensual, 2500);
});

test("resolveDelta: SIN toolArgs → FALLBACK a extractScenarioDelta (regex)", () => {
  const r = resolveDelta({ message: "gano 2500 euros al mes", lang: "es" });
  assert.equal(r.usedTool, false);
  assert.equal(r.delta.ingreso_mensual, 2500, "la ruta regex sigue viva");
});

test("resolveDelta: SIN toolArgs + TAE corta con crédito previo → regex FIX 2", () => {
  const prev = { credito: { monto: 30000, plazo_meses: 36, tae_es_referencia: true } };
  const r = resolveDelta({ message: "9%", lang: "es", prev });
  assert.equal(r.usedTool, false);
  assert.equal(r.delta.credito?.tae_pct, 9, "el fallback regex conserva la TAE corta");
});

// ── buildToolResult — marcas es_simulacion / tae_usada ────────────────────────
test("buildToolResult: crédito sin TAE → es_simulacion true, tae_usada 7 (referencia)", () => {
  const s = mergeScenario({ ingreso_mensual: 10000, gastos_mensuales: 9500 },
    toolArgsToScenarioDelta({ credito_monto: 30000, credito_plazo_meses: 48 }));
  const ctx = buildScenarioContext(s, "");
  const tr = buildToolResult(s, ctx);
  assert.equal(tr.credito.es_simulacion, true);
  assert.equal(tr.credito.tae_usada, 7);
  assert.deepEqual(tr.missing, ["tae"]);
  assert.ok(Math.abs((tr.cifras.cuota ?? 0) - 718.39) <= 1, "cuota de referencia 718,39");
});

test("buildToolResult: crédito con TAE real → es_simulacion false, tae_usada = la real", () => {
  let s = mergeScenario({ ingreso_mensual: 10000, gastos_mensuales: 9500 },
    toolArgsToScenarioDelta({ credito_monto: 30000, credito_plazo_meses: 48 }));
  s = mergeScenario(s, toolArgsToScenarioDelta({ credito_tae_pct: 9 }));
  const ctx = buildScenarioContext(s, "");
  const tr = buildToolResult(s, ctx);
  assert.equal(tr.credito.es_simulacion, false);
  assert.equal(tr.credito.tae_usada, 9);
  assert.ok(!tr.missing.includes("tae"), "ya no falta la TAE");
});

test("buildToolResult: sin crédito → es_simulacion null, tae_usada null", () => {
  const s = mergeScenario({ ingreso_mensual: 2500, gastos_mensuales: 1500 }, {});
  const tr = buildToolResult(s, buildScenarioContext(s, ""));
  assert.equal(tr.credito.es_simulacion, null);
  assert.equal(tr.credito.tae_usada, null);
});

test("la tool declara el nombre y los campos esperados", () => {
  assert.equal(registrarDatosFinancieros.function.name, "registrar_datos_financieros");
  const props = (registrarDatosFinancieros.function.parameters as { properties: Record<string, unknown> }).properties;
  for (const k of ["ingreso_mensual", "gastos_mensuales", "credito_monto", "credito_plazo_meses", "credito_tae_pct", "meta_titulo", "meta_monto", "meta_plazo_meses", "gastos_detalle"]) {
    assert.ok(k in props, `falta el campo ${k}`);
  }
});
