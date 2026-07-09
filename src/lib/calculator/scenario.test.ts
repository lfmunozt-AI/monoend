// Tests del scenario state (el motor recuerda entre turnos).

import { test } from "node:test";
import assert from "node:assert/strict";

import { extractScenarioDelta, mergeScenario } from "./scenario";

test("merge: TAE 9% real sobre un crédito previo → recalcula tae_es_referencia", () => {
  const prev = mergeScenario(
    { ingreso_mensual: 10000, gastos_mensuales: 9500 },
    extractScenarioDelta("quiero financiar un carro de 30000 a 36 meses"),
  );
  assert.equal(prev.credito?.monto, 30000);
  assert.equal(prev.credito?.plazo_meses, 36);
  assert.equal(prev.credito?.tae_es_referencia, true, "sin TAE aún → referencia");
  assert.ok(prev.missing.includes("tae"), "falta la TAE real");

  const next = mergeScenario(prev, extractScenarioDelta("el banco me ofrece un 9%"));
  assert.equal(next.credito?.tae_pct, 9);
  assert.equal(next.credito?.tae_es_referencia, false, "TAE real → deja de ser referencia");
  assert.equal(next.credito?.monto, 30000, "la TAE nueva NO borra el monto");
  assert.ok(!next.missing.includes("tae"), "ya no falta la TAE");
});

test("merge: cambio de monto sobreescribe (último gana), conserva el resto", () => {
  let s = mergeScenario(undefined, extractScenarioDelta("financiar un carro de 30000 a 36 meses"));
  s = mergeScenario(s, extractScenarioDelta("mejor un coche de 20000 a 36 meses"));
  assert.equal(s.credito?.monto, 20000, "el nuevo monto gana");
  assert.equal(s.credito?.plazo_meses, 36);
});

test("ambiguo → no extrae nada (no corrompe el estado)", () => {
  assert.deepEqual(extractScenarioDelta("hola, no sé muy bien qué hacer"), {});
  assert.deepEqual(extractScenarioDelta("gracias por la ayuda"), {});
  // Un porcentaje SIN contexto de tasa no se toma como TAE.
  assert.deepEqual(extractScenarioDelta("me gusta el 20% de las cosas"), {});
});

test("missing correcto según el playbook activo", () => {
  const soloCredito = mergeScenario(undefined, extractScenarioDelta("un préstamo de 30000 a 24 meses"));
  assert.ok(soloCredito.missing.includes("tae"));
  assert.ok(soloCredito.missing.includes("ingreso"));
  assert.ok(soloCredito.missing.includes("gastos"));

  const completo = mergeScenario(
    { ingreso_mensual: 3000, gastos_mensuales: 2000 },
    extractScenarioDelta("el tipo de interés es 8%"),
  );
  // Sin monto/plazo del crédito aún: faltan monto y plazo.
  assert.ok(completo.missing.includes("monto"));
  assert.ok(completo.missing.includes("plazo"));
  assert.ok(!completo.missing.includes("ingreso"), "ingreso ya está");
});

test("ES: gano/gasto se extraen como ingreso y gastos", () => {
  const s = mergeScenario(undefined, extractScenarioDelta("gano 3000 al mes"));
  assert.equal(s.ingreso_mensual, 3000);
  const g = mergeScenario(undefined, extractScenarioDelta("gasto 2000 al mes"));
  assert.equal(g.gastos_mensuales, 2000);
});

test("PT: 'juros de 9%' → TAE real", () => {
  const d = extractScenarioDelta("o banco oferece juros de 9%");
  assert.equal(d.credito?.tae_pct, 9);
  assert.equal(d.credito?.tae_es_referencia, false);
});

test("EN: '9% apr' y 'loan of 30000 over 36 months'", () => {
  const rate = extractScenarioDelta("the bank offers 9% apr");
  assert.equal(rate.credito?.tae_pct, 9);

  const loan = extractScenarioDelta("a loan of 30000 over 36 months");
  assert.equal(loan.credito?.monto, 30000);
  assert.equal(loan.credito?.plazo_meses, 36);
});

test("plazo en años → meses ('3 años' = 36)", () => {
  const s = extractScenarioDelta("financiar una casa de 200000 a 3 años");
  assert.equal(s.credito?.plazo_meses, 36);
});

// ── DEFECTO A — extracción anclada al contexto (campos cruzados) ─────────────
test("A: 'gano 2500 y quiero un carro de 30000 a 36 meses' → cada campo el suyo", () => {
  const d = extractScenarioDelta("gano 2500 euros al mes y quiero un carro de 30000 a 36 meses");
  assert.equal(d.ingreso_mensual, 2500, "ingreso anclado a 'gano'");
  assert.equal(d.credito?.monto, 30000, "monto anclado al crédito, NO el primer número");
  assert.equal(d.credito?.plazo_meses, 36);
});

test("A: orden inverso (crédito primero) sigue funcionando", () => {
  const d = extractScenarioDelta("quiero un carro de 30000 a 36 meses y gano 2500");
  assert.equal(d.credito?.monto, 30000);
  assert.equal(d.ingreso_mensual, 2500);
});

test("A: ingreso + gastos + crédito en un mismo mensaje, sin cruzarse", () => {
  const d = extractScenarioDelta("gano 2500 euros al mes y mis gastos son 1500. Quiero financiar un carro de 30000 a 36 meses.");
  assert.equal(d.ingreso_mensual, 2500);
  assert.equal(d.gastos_mensuales, 1500);
  assert.equal(d.credito?.monto, 30000);
  assert.equal(d.credito?.plazo_meses, 36);
});

// ── FIX 2 — respuesta corta de TAE con crédito previo ────────────────────────
test("FIX 2: estado con crédito + '18%' → tae 18 real", () => {
  const prev = { credito: { monto: 30000, plazo_meses: 36, tae_es_referencia: true } };
  const d = extractScenarioDelta("18%", "es", prev);
  assert.equal(d.credito?.tae_pct, 18);
  assert.equal(d.credito?.tae_es_referencia, false);
});

test("FIX 2: SIN crédito previo + '18%' → NO extrae nada", () => {
  assert.deepEqual(extractScenarioDelta("18%", "es"), {});
  assert.deepEqual(extractScenarioDelta("18%", "es", {}), {});
});

test("FIX 2: variantes cortas con crédito previo (es un 9 / 9 por ciento / 9 percent)", () => {
  const prev = { credito: { monto: 30000, plazo_meses: 36, tae_es_referencia: true } };
  assert.equal(extractScenarioDelta("es un 9", "es", prev).credito?.tae_pct, 9);
  assert.equal(extractScenarioDelta("9 por ciento", "es", prev).credito?.tae_pct, 9);
  assert.equal(extractScenarioDelta("9 percent", "en", prev).credito?.tae_pct, 9);
});

test("FIX 2: mensaje con otras señales NO se toma como TAE corta", () => {
  const prev = { credito: { monto: 30000, plazo_meses: 36, tae_es_referencia: true } };
  // "gano 2500" no es 'esencialmente un porcentaje' → no toca la TAE.
  assert.equal(extractScenarioDelta("gano 2500", "es", prev).credito?.tae_pct, undefined);
});

// ── DEFECTO B — una lista de gastos NO machaca el agregado ───────────────────
test("B: agregado 2372 en T1; lista en T2 → gastos siguen 2372 (jamás 15)", () => {
  let s = mergeScenario({}, extractScenarioDelta("Gano 2636 euros al mes y mis gastos son 2372."));
  assert.equal(s.gastos_mensuales, 2372);
  s = mergeScenario(s, extractScenarioDelta("Mis gastos: netflix 15, luz 80, agua 30, cerveza 120, mercado 400"));
  assert.equal(s.gastos_mensuales, 2372, "la lista NO sustituye el agregado por el primer ítem (15)");
  assert.equal(s.gastos_es_detalle, true, "pero sí se marca el detalle");
  assert.equal(s.gastos_detalle?.vitales, 510);
  assert.equal(s.gastos_detalle?.noVitales, 135);
});
