// Tests de la calculadora financiera (PIEZA 1). Runner nativo de Node
// (node:test) vía tsx — mismo runner que el guardarraíl. Ejecutar: `npm test`.
//
// Incluye el CASO CANÓNICO que el modelo falló ("100" en vez de 1000) y la
// cobertura de redondeo, división por cero y valores negativos.

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  sobrante,
  regla503020,
  proyeccion,
  porcentajeDe,
  fondoEmergencia,
  tiempoHastaMeta,
  ratioDeuda,
  interesCompuesto,
} from "./operations";

// ── Caso canónico ──────────────────────────────────────────────────────────
test("CANÓNICO: sobrante(2500, 1500) → 1000 (NUNCA 100)", () => {
  const r = sobrante(2500, 1500);
  if (!r.ok) return assert.fail(`esperaba ok, error: ${r.error}`);
  assert.equal(r.valor, 1000);
});

test("regla503020(2500) → {1250, 750, 500}", () => {
  const r = regla503020(2500);
  if (!r.ok) return assert.fail(`esperaba ok, error: ${r.error}`);
  assert.equal(r.necesidades, 1250);
  assert.equal(r.ocio, 750);
  assert.equal(r.ahorro, 500);
});

test("proyeccion(300, 12) → 3600", () => {
  const r = proyeccion(300, 12);
  if (!r.ok) return assert.fail(`esperaba ok, error: ${r.error}`);
  assert.equal(r.valor, 3600);
});

// ── Cobertura adicional de las operaciones ──────────────────────────────────
test("sobrante admite déficit (resultado negativo NO es error)", () => {
  const r = sobrante(1500, 2500);
  if (!r.ok) return assert.fail(`esperaba ok, error: ${r.error}`);
  assert.equal(r.valor, -1000);
});

test("porcentajeDe(1000, 30) → 300", () => {
  const r = porcentajeDe(1000, 30);
  if (!r.ok) return assert.fail(`esperaba ok, error: ${r.error}`);
  assert.equal(r.valor, 300);
});

test("porcentajeDe redondea a 2 decimales", () => {
  const r = porcentajeDe(333, 33); // 109.89
  if (!r.ok) return assert.fail(`esperaba ok, error: ${r.error}`);
  assert.equal(r.valor, 109.89);
});

test("fondoEmergencia(1500, 6) → 9000; fuera de 3-6 → rango_invalido", () => {
  const ok = fondoEmergencia(1500, 6);
  if (!ok.ok) return assert.fail(`esperaba ok, error: ${ok.error}`);
  assert.equal(ok.valor, 9000);

  const malo = fondoEmergencia(1500, 12);
  assert.equal(malo.ok, false);
  assert.equal(malo.ok === false && malo.error, "rango_invalido");
});

test("tiempoHastaMeta redondea hacia arriba y bloquea aporte 0", () => {
  const r = tiempoHastaMeta(1000, 300); // ceil(3.33) = 4
  if (!r.ok) return assert.fail(`esperaba ok, error: ${r.error}`);
  assert.equal(r.valor, 4);

  const cero = tiempoHastaMeta(1000, 0);
  assert.equal(cero.ok, false);
  assert.equal(cero.ok === false && cero.error, "division_por_cero");
});

test("ratioDeuda(20000, 40000) → 50 (%); ingreso 0 → division_por_cero", () => {
  const r = ratioDeuda(20000, 40000);
  if (!r.ok) return assert.fail(`esperaba ok, error: ${r.error}`);
  assert.equal(r.valor, 50);

  const cero = ratioDeuda(20000, 0);
  assert.equal(cero.ok, false);
  assert.equal(cero.ok === false && cero.error, "division_por_cero");
});

test("interesCompuesto(1000, 10, 2) → 1210 (tasa como %)", () => {
  const r = interesCompuesto(1000, 10, 2); // 1000*(1.1)^2 = 1210
  if (!r.ok) return assert.fail(`esperaba ok, error: ${r.error}`);
  assert.equal(r.valor, 1210);
});

test("valores negativos → error tipado, nunca NaN", () => {
  const r = porcentajeDe(-100, 20);
  assert.equal(r.ok, false);
  assert.equal(r.ok === false && r.error, "valor_negativo");

  const nan = sobrante(NaN, 10);
  assert.equal(nan.ok, false);
  assert.equal(nan.ok === false && nan.error, "entrada_invalida");
});
