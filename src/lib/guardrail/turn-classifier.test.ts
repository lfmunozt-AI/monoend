// Tests del clasificador de turno (carril). Runner nativo de Node (node:test)
// vía tsx. Ejecutar: `npm run test:guardrail`.

import { test } from "node:test";
import assert from "node:assert/strict";

import { classifyTurn, esTonoEmocional } from "./turn-classifier";

test("META: '¿qué modelo eres?' → META", () => {
  assert.equal(classifyTurn("¿qué modelo eres?", undefined), "META");
});

test("META: 'hola' → META", () => {
  assert.equal(classifyTurn("hola", undefined), "META");
});

test("META: 'gracias' → META", () => {
  assert.equal(classifyTurn("gracias", undefined), "META");
});

test("FINANCIERO: 'gano 3000' → FINANCIERO", () => {
  assert.equal(classifyTurn("gano 3000", undefined), "FINANCIERO");
});

test("FINANCIERO: '9%' con crédito activo → FINANCIERO", () => {
  const scenario = { credito: { monto: 30000, plazo_meses: 36, tae_es_referencia: true } };
  assert.equal(classifyTurn("9%", scenario), "FINANCIERO");
});

test("continuidad: 'ninguno' con scenario activo → FINANCIERO", () => {
  const scenario = { ingreso_mensual: 3000, gastos_mensuales: 2000 };
  assert.equal(classifyTurn("ninguno", scenario), "FINANCIERO");
});

test("continuidad: 'ninguno' sin scenario → META", () => {
  assert.equal(classifyTurn("ninguno", undefined), "META");
  assert.equal(classifyTurn("ninguno", {}), "META");
});

test("MIXTO: 'hola, gano 3000' → MIXTO", () => {
  assert.equal(classifyTurn("hola, gano 3000", undefined), "MIXTO");
});

// ── PT ─────────────────────────────────────────────────────────────────────
test("PT: 'olá' → META", () => {
  assert.equal(classifyTurn("olá", undefined), "META");
});

test("PT: 'ganho 3000 por mês' → FINANCIERO", () => {
  assert.equal(classifyTurn("ganho 3000 por mês", undefined), "FINANCIERO");
});

test("PT: 'obrigado' → META", () => {
  assert.equal(classifyTurn("obrigado", undefined), "META");
});

test("PT: 'quem te criou?' → META (sondeo de identidad)", () => {
  assert.equal(classifyTurn("quem te criou?", undefined), "META");
});

// ── EN ─────────────────────────────────────────────────────────────────────
test("EN: 'hi' → META", () => {
  assert.equal(classifyTurn("hi", undefined), "META");
});

test("EN: 'I earn 3000 a month' → FINANCIERO", () => {
  assert.equal(classifyTurn("I earn 3000 a month", undefined), "FINANCIERO");
});

test("EN: 'thanks' → META", () => {
  assert.equal(classifyTurn("thanks", undefined), "META");
});

test("EN: 'what model are you?' → META (sondeo de identidad)", () => {
  assert.equal(classifyTurn("what model are you?", undefined), "META");
});

test("EN: 'hi, I earn 3000' → MIXTO", () => {
  assert.equal(classifyTurn("hi, I earn 3000", undefined), "MIXTO");
});

// ── casos adicionales ────────────────────────────────────────────────────────
test("META: meta-ayuda 'no entendí, explícame' → META", () => {
  assert.equal(classifyTurn("no entendí, ¿me explicas?", undefined), "META");
});

test("FINANCIERO: 'quiero financiar un carro de 30000 a 36 meses' → FINANCIERO", () => {
  assert.equal(classifyTurn("quiero financiar un carro de 30000 a 36 meses", undefined), "FINANCIERO");
});

test("META: saludo + pregunta de identidad (dos señales META, cero financieras) → META", () => {
  assert.equal(classifyTurn("hola, ¿qué modelo eres?", undefined), "META");
});

// ── PIEZA 5c (complemento, 5ª tanda) — TONO EMOCIONAL ────────────────────────

test("esTonoEmocional: 'estoy frustrado, no consigo trabajo' → true", () => {
  assert.equal(esTonoEmocional("estoy frustrado, no consigo trabajo pero quiero ahorrar"), true);
});

test("esTonoEmocional: 'me da vergüenza lo mal que llevo mis cuentas' → true", () => {
  assert.equal(esTonoEmocional("me da vergüenza lo mal que llevo mis cuentas"), true);
});

test("esTonoEmocional: 'me despidieron' / 'tengo miedo' → true", () => {
  assert.equal(esTonoEmocional("me despidieron ayer, tengo miedo de no llegar a fin de mes"), true);
});

test("esTonoEmocional: '¿qué tiempo hace?' → false", () => {
  assert.equal(esTonoEmocional("¿qué tiempo hace?"), false);
});

test("esTonoEmocional: 'gano 2300 y gasto 1850' → false", () => {
  assert.equal(esTonoEmocional("gano 2300 y gasto 1850"), false);
});

test("esTonoEmocional PT: 'estou sem emprego, tenho medo' → true", () => {
  assert.equal(esTonoEmocional("estou sem emprego, tenho medo do que vem"), true);
});

test("esTonoEmocional EN: 'I got fired, I'm scared' → true", () => {
  assert.equal(esTonoEmocional("I got fired last week, I'm scared about money"), true);
});
