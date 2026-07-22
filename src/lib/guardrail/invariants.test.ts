// Tests de assertOutputInvariants — AUDITORÍA AG01 (H2 + H5). Runner nativo de
// Node (node:test) vía tsx. Ejecutar: `npm run test:guardrail`.

import { test } from "node:test";
import assert from "node:assert/strict";

import { assertOutputInvariants, type OutputInvariantContext } from "./invariants";

function ctx(overrides: Partial<OutputInvariantContext> = {}): OutputInvariantContext {
  return {
    carril: "FINANCIERO",
    lang: "es",
    missing: [],
    conceptos: {},
    esSimulacion: false,
    ...overrides,
  };
}

function countQuestions(t: string): number {
  return (t.match(/\?/g) ?? []).length;
}

// ── Caso real 1 — déficit fantasma (defensa en profundidad de H1) ────────────
test("caso real: déficit fantasma que se coló hasta el final → eliminado (invariante c)", () => {
  const r = assertOutputInvariants(
    "Tienes un déficit mensual de 9500 €. ¿Confirmamos el plan?",
    ctx({ conceptos: { ingreso: 10000, gastos: 9500, sobrante: 500 } }),
  );
  assert.ok(!r.texto.includes("9500"), "el déficit fantasma desaparece");
  assert.ok(r.texto.includes("¿Confirmamos el plan?"), "el cierre válido sobrevive");
  assert.ok(r.violaciones.some((v) => v.id === "c"));
});

// ── Caso real 2 — doble TAE (H2) ──────────────────────────────────────────────
test("caso real: doble TAE (cláusula + cierre) → cláusula recortada, UNA sola mención de 'tu banco'", () => {
  const r = assertOutputInvariants(
    "La cuota sería de 926,31 € (simulación con TAE de referencia — tu banco te dará la tasa real). " +
      "¿Qué TAE te ofrece tu banco? Con ese dato la cuota es exacta al 100%.",
    ctx({ missing: ["tae"], conceptos: { monto: 30000, plazo: 36, cuota: 926.31 }, esSimulacion: true }),
  );
  const bancoMentions = (r.texto.match(/tu banco/gi) ?? []).length;
  assert.equal(bancoMentions, 1, "una sola mención de 'tu banco'");
  assert.equal(countQuestions(r.texto), 1, "una sola pregunta");
  assert.ok(r.texto.includes("¿Qué TAE te ofrece tu banco?"), "el cierre de TAE sobrevive");
  assert.ok(r.texto.includes("simulación con TAE de referencia del 7%"), "la cláusula queda en su forma corta");
  assert.ok(r.violaciones.some((v) => v.id === "b"));
});

// ── Caso real 3 — contradicción tasa/simulación (H4 que se coló) ─────────────
test("caso real: negador de TAE + cláusula canónica juntos → negador eliminado, sin contradicción", () => {
  const r = assertOutputInvariants(
    "La cuota sería de 718,39 € (sin considerar la TAE) (simulación con TAE de referencia — tu banco te dará la tasa real).",
    ctx({ conceptos: { monto: 30000, plazo: 48, cuota: 718.39 }, esSimulacion: true }),
  );
  assert.ok(!/sin considerar/i.test(r.texto), "el negador desaparece");
  assert.ok(/simulaci[oó]n/i.test(r.texto), "la cláusula de simulación sobrevive");
  assert.ok(r.violaciones.some((v) => v.id === "b"));
});

// ── (a) máx. 1 pregunta final ──────────────────────────────────────────────────
test("(a): dos preguntas en el cierre, missing=['tae'] → gana la de missing", () => {
  const r = assertOutputInvariants(
    "Tu sobrante es de 500 €. ¿Cuál es tu meta? ¿Qué TAE te ofrece tu banco?",
    ctx({ missing: ["tae"], conceptos: { sobrante: 500 } }),
  );
  assert.equal(countQuestions(r.texto), 1);
  assert.ok(r.texto.includes("¿Qué TAE te ofrece tu banco?"));
  assert.ok(!r.texto.includes("¿Cuál es tu meta?"));
  assert.ok(r.violaciones.some((v) => v.id === "a"));
});

test("(a): dos preguntas, missing vacío → gana la ÚLTIMA", () => {
  const r = assertOutputInvariants(
    "Tu sobrante es de 500 €. ¿Cuál es tu meta? ¿Confirmamos el plan?",
    ctx({ missing: [], conceptos: { sobrante: 500 } }),
  );
  assert.equal(countQuestions(r.texto), 1);
  assert.ok(r.texto.includes("¿Confirmamos el plan?"));
});

test("(a): una sola pregunta → intacto", () => {
  const texto = "Tu sobrante es de 500 €. ¿Cuál es tu meta?";
  const r = assertOutputInvariants(texto, ctx({ conceptos: { sobrante: 500 } }));
  assert.equal(r.texto, texto);
  assert.equal(r.violaciones.length, 0);
});

// ── (d) 0 términos de proveedor — en TODOS los carriles, incluido META ────────
test("(d): fuga de proveedor en carril META → eliminada", () => {
  const r = assertOutputInvariants(
    "Soy un modelo de OpenAI. ¿Qué meta quieres conquistar?",
    ctx({ carril: "META" }),
  );
  assert.ok(!/openai/i.test(r.texto));
  assert.ok(r.texto.includes("¿Qué meta quieres conquistar?"));
  assert.ok(r.violaciones.some((v) => v.id === "d"));
});

test("(d): fuga de proveedor en carril FINANCIERO → eliminada igual", () => {
  const r = assertOutputInvariants(
    "Uso Claude de Anthropic. Tu sobrante es de 500 €.",
    ctx({ conceptos: { sobrante: 500 } }),
  );
  assert.ok(!/claude|anthropic/i.test(r.texto));
  assert.ok(r.texto.includes("500"));
});

// ── (e) 0 cierres delegativos — en TODOS los carriles ─────────────────────────
test("(e): cierre delegativo sobrevivió hasta el final → eliminado", () => {
  const r = assertOutputInvariants(
    "Tu sobrante es de 500 €. ¿Qué gastos podrías reducir?",
    ctx({ conceptos: { sobrante: 500 } }),
  );
  assert.ok(!/podrías reducir/i.test(r.texto));
  assert.ok(r.violaciones.some((v) => v.id === "e"));
});

test("(e) en META: cierre delegativo también se elimina", () => {
  const r = assertOutputInvariants(
    "Claro. ¿Qué gastos podrías reducir?",
    ctx({ carril: "META" }),
  );
  assert.ok(!/podrías reducir/i.test(r.texto));
});

// ── Carril META: (a)/(b)/(c) NO aplican ───────────────────────────────────────
test("META: NO toca conceptos sin cálculo ni simulación ni cierre (solo aplican d/e)", () => {
  const texto = "Tienes un déficit mensual de 9500 €. ¿Cuál es tu meta? ¿Qué TAE te ofrece tu banco?";
  const r = assertOutputInvariants(texto, ctx({ carril: "META", conceptos: {}, missing: ["tae"] }));
  assert.equal(r.texto, texto, "META no aplica a/b/c — el texto se deja intacto salvo d/e");
});

// ── Texto vacío / sin violaciones ──────────────────────────────────────────────
test("texto vacío → devuelto tal cual, sin violaciones", () => {
  const r = assertOutputInvariants("", ctx());
  assert.equal(r.texto, "");
  assert.deepEqual(r.violaciones, []);
});

test("texto limpio sin ninguna violación → intacto", () => {
  const texto = "Tu sobrante mensual es de 500 €. ¿Cuál es tu meta?";
  const r = assertOutputInvariants(texto, ctx({ conceptos: { sobrante: 500 } }));
  assert.equal(r.texto, texto);
  assert.deepEqual(r.violaciones, []);
});

// ── Idempotencia (contrato: aplicarla dos veces da el mismo resultado) ────────
test("idempotencia: aplicar assertOutputInvariants dos veces da el mismo texto", () => {
  const contexto = ctx({ missing: ["tae"], conceptos: { monto: 30000, plazo: 36, cuota: 926.31 }, esSimulacion: true });
  const once = assertOutputInvariants(
    "La cuota sería de 926,31 € (simulación con TAE de referencia — tu banco te dará la tasa real). " +
      "¿Qué TAE te ofrece tu banco? Con ese dato la cuota es exacta al 100%.",
    contexto,
  );
  const twice = assertOutputInvariants(once.texto, contexto);
  assert.equal(once.texto, twice.texto);
});

test("idempotencia: caso del déficit fantasma también es idempotente", () => {
  const contexto = ctx({ conceptos: { ingreso: 10000, gastos: 9500, sobrante: 500 } });
  const once = assertOutputInvariants("Tienes un déficit mensual de 9500 €. ¿Confirmamos el plan?", contexto);
  const twice = assertOutputInvariants(once.texto, contexto);
  assert.equal(once.texto, twice.texto);
});
