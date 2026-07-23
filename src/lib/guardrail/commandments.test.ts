// Tests de enforceCommandments (ex assertOutputInvariants) — AUDITORÍA AG01
// (H2 + H5) + Mandamientos 6-8. Runner nativo de Node (node:test) vía tsx.
// Ejecutar: `npm run test:guardrail`.

import { test } from "node:test";
import assert from "node:assert/strict";

import { enforceCommandments, type CommandmentContext } from "./commandments";
import type { Mutation } from "./policy";

function ctx(overrides: Partial<CommandmentContext> = {}): CommandmentContext {
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
test("caso real: déficit fantasma que se coló hasta el final → eliminado (Mandamiento 3)", () => {
  const r = enforceCommandments(
    "Tienes un déficit mensual de 9500 €. ¿Confirmamos el plan?",
    ctx({ conceptos: { ingreso: 10000, gastos: 9500, sobrante: 500 } }),
  );
  assert.ok(!r.texto.includes("9500"), "el déficit fantasma desaparece");
  assert.ok(r.texto.includes("¿Confirmamos el plan?"), "el cierre válido sobrevive");
  assert.ok(r.violaciones.some((v) => v.mandamiento === 3));
});

// ── Caso real 2 — doble TAE (H2) ──────────────────────────────────────────────
test("caso real: doble TAE (cláusula + cierre) → cláusula recortada, UNA sola mención de 'tu banco'", () => {
  const r = enforceCommandments(
    "La cuota sería de 926,31 € (simulación con TAE de referencia — tu banco te dará la tasa real). " +
      "¿Qué TAE te ofrece tu banco? Con ese dato la cuota es exacta al 100%.",
    ctx({ missing: ["tae"], conceptos: { monto: 30000, plazo: 36, cuota: 926.31 }, esSimulacion: true }),
  );
  const bancoMentions = (r.texto.match(/tu banco/gi) ?? []).length;
  assert.equal(bancoMentions, 1, "una sola mención de 'tu banco'");
  assert.equal(countQuestions(r.texto), 1, "una sola pregunta");
  assert.ok(r.texto.includes("¿Qué TAE te ofrece tu banco?"), "el cierre de TAE sobrevive");
  assert.ok(r.texto.includes("simulación con TAE de referencia del 7%"), "la cláusula queda en su forma corta");
  assert.ok(r.violaciones.some((v) => v.mandamiento === 2));
});

// ── Caso real 3 — contradicción tasa/simulación (H4 que se coló) ─────────────
test("caso real: negador de TAE + cláusula canónica juntos → negador eliminado, sin contradicción", () => {
  const r = enforceCommandments(
    "La cuota sería de 718,39 € (sin considerar la TAE) (simulación con TAE de referencia — tu banco te dará la tasa real).",
    ctx({ conceptos: { monto: 30000, plazo: 48, cuota: 718.39 }, esSimulacion: true }),
  );
  assert.ok(!/sin considerar/i.test(r.texto), "el negador desaparece");
  assert.ok(/simulaci[oó]n/i.test(r.texto), "la cláusula de simulación sobrevive");
  assert.ok(r.violaciones.some((v) => v.mandamiento === 2));
});

// ── Mandamiento 1 — máx. 1 pregunta final ─────────────────────────────────────
test("Mandamiento 1: dos preguntas en el cierre, missing=['tae'] → gana la de missing", () => {
  const r = enforceCommandments(
    "Tu sobrante es de 500 €. ¿Cuál es tu meta? ¿Qué TAE te ofrece tu banco?",
    ctx({ missing: ["tae"], conceptos: { sobrante: 500 } }),
  );
  assert.equal(countQuestions(r.texto), 1);
  assert.ok(r.texto.includes("¿Qué TAE te ofrece tu banco?"));
  assert.ok(!r.texto.includes("¿Cuál es tu meta?"));
  assert.ok(r.violaciones.some((v) => v.mandamiento === 1));
});

test("Mandamiento 1: dos preguntas, missing vacío → gana la ÚLTIMA", () => {
  const r = enforceCommandments(
    "Tu sobrante es de 500 €. ¿Cuál es tu meta? ¿Confirmamos el plan?",
    ctx({ missing: [], conceptos: { sobrante: 500 } }),
  );
  assert.equal(countQuestions(r.texto), 1);
  assert.ok(r.texto.includes("¿Confirmamos el plan?"));
});

test("Mandamiento 1: una sola pregunta → intacto", () => {
  const texto = "Tu sobrante es de 500 €. ¿Cuál es tu meta?";
  const r = enforceCommandments(texto, ctx({ conceptos: { sobrante: 500 } }));
  assert.equal(r.texto, texto);
  assert.equal(r.violaciones.length, 0);
});

// ── Mandamiento 4 — 0 términos de proveedor, en TODOS los carriles ───────────
test("Mandamiento 4: fuga de proveedor en carril META → eliminada", () => {
  const r = enforceCommandments(
    "Soy un modelo de OpenAI. ¿Qué meta quieres conquistar?",
    ctx({ carril: "META" }),
  );
  assert.ok(!/openai/i.test(r.texto));
  assert.ok(r.texto.includes("¿Qué meta quieres conquistar?"));
  assert.ok(r.violaciones.some((v) => v.mandamiento === 4));
});

test("Mandamiento 4: fuga de proveedor en carril FINANCIERO → eliminada igual", () => {
  const r = enforceCommandments(
    "Uso Claude de Anthropic. Tu sobrante es de 500 €.",
    ctx({ conceptos: { sobrante: 500 } }),
  );
  assert.ok(!/claude|anthropic/i.test(r.texto));
  assert.ok(r.texto.includes("500"));
});

// ── Mandamiento 5 — 0 cierres delegativos, en TODOS los carriles ─────────────
test("Mandamiento 5: cierre delegativo sobrevivió hasta el final → eliminado", () => {
  const r = enforceCommandments(
    "Tu sobrante es de 500 €. ¿Qué gastos podrías reducir?",
    ctx({ conceptos: { sobrante: 500 } }),
  );
  assert.ok(!/podrías reducir/i.test(r.texto));
  assert.ok(r.violaciones.some((v) => v.mandamiento === 5));
});

test("Mandamiento 5 en META: cierre delegativo también se elimina", () => {
  const r = enforceCommandments(
    "Claro. ¿Qué gastos podrías reducir?",
    ctx({ carril: "META" }),
  );
  assert.ok(!/podrías reducir/i.test(r.texto));
});

// ── Mandamiento 6 — VALOR DE EJEMPLO DECLARADO ────────────────────────────────
test("Mandamiento 6: ejemplo de ingreso sin declarar → se inserta la declaración", () => {
  const r = enforceCommandments(
    "Muchos usuarios con 2000 € de ingreso ahorran cómodamente. ¿Cuál es tu ingreso neto mensual?",
    ctx({ missing: ["ingreso"], conceptos: { ejemplo_ingreso: 2000 } }),
  );
  assert.ok(/como ejemplo|ilustrativ/i.test(r.texto), `debía declarar el ejemplo: ${r.texto}`);
  assert.ok(r.violaciones.some((v) => v.mandamiento === 6));
});

test("Mandamiento 6: ejemplo YA declarado → intacto", () => {
  const texto = "Como ejemplo ilustrativo, con 2000 € de ingreso el plan cuadra. ¿Cuál es tu ingreso?";
  const r = enforceCommandments(texto, ctx({ missing: ["ingreso"], conceptos: { ejemplo_ingreso: 2000 } }));
  assert.equal(r.texto, texto);
});

test("Mandamiento 6: sin ejemplo_<campo> en conceptos → no aplica nada", () => {
  const texto = "Muchos usuarios con 2000 € de ingreso ahorran cómodamente. ¿Cuál es tu ingreso?";
  const r = enforceCommandments(texto, ctx({ missing: ["ingreso"], conceptos: {} }));
  assert.equal(r.texto, texto);
});

// ── Mandamiento 7 — IDIOMA DE ENTRADA ─────────────────────────────────────────
test("Mandamiento 7: frase en inglés dentro de una respuesta en español → eliminada", () => {
  const r = enforceCommandments(
    "Tu sobrante es de 500 €. By the way, this is really good news for your savings plan. ¿Cuál es tu meta?",
    ctx({ conceptos: { sobrante: 500 }, lang: "es" }),
  );
  assert.ok(!/really good news/i.test(r.texto));
  assert.ok(r.violaciones.some((v) => v.mandamiento === 7));
});

test("Mandamiento 7: términos técnicos exentos (TAE, APR, ETF) NO se tocan", () => {
  const texto = "Tu TAE es del 9%. Compara siempre el APR y evita comisiones altas en un ETF. ¿Cuál es tu meta?";
  const r = enforceCommandments(texto, ctx({ conceptos: { sobrante: 500 }, lang: "es" }));
  assert.ok(r.texto.includes("TAE") && r.texto.includes("APR") && r.texto.includes("ETF"));
});

test("Mandamiento 7: carril META también lo aplica", () => {
  const r = enforceCommandments(
    "Hola. By the way, I think this is great. ¿En qué te ayudo?",
    ctx({ carril: "META", lang: "es" }),
  );
  assert.ok(!/i think this is great/i.test(r.texto));
});

// ── Mandamiento 8 — ORDINALES NO SON CIFRAS (vía registro de mutaciones) ──────
test("Mandamiento 8: una mutación reescribió un enumerador → se revierte", () => {
  const mutations: Mutation[] = [{ capa: "grounding", regla: "posicional_monto", antes: "1", despues: "7000" }];
  const r = enforceCommandments(
    "7000. Ajustar el ocio\n2. Aumentar ingresos",
    ctx({ mutations }),
  );
  assert.ok(r.texto.startsWith("1. Ajustar el ocio"), `debía revertir a '1.': ${r.texto}`);
  const v = r.violaciones.find((x) => x.mandamiento === 8);
  assert.ok(v);
  assert.equal(v?.capa, "grounding", "identifica la capa culpable");
});

test("Mandamiento 8: sin mutaciones sospechosas → no toca nada", () => {
  const mutations: Mutation[] = [{ capa: "grounding", regla: "posicional_monto", antes: "425.81", despues: "30000" }];
  const texto = "Para el carro de 30000 € a 36 meses, la cuota es de 953,99 €.";
  const r = enforceCommandments(texto, ctx({ mutations, conceptos: { monto: 30000, plazo: 36, cuota: 953.99 } }));
  assert.equal(r.texto, texto);
});

// ── Carril META: Mandamientos 1/2/3/6 NO aplican ──────────────────────────────
test("META: NO toca conceptos sin cálculo ni simulación ni cierre (solo aplican 4/5/7)", () => {
  const texto = "Tienes un déficit mensual de 9500 €. ¿Cuál es tu meta? ¿Qué TAE te ofrece tu banco?";
  const r = enforceCommandments(texto, ctx({ carril: "META", conceptos: {}, missing: ["tae"] }));
  assert.equal(r.texto, texto, "META no aplica 1/2/3/6 — el texto se deja intacto salvo 4/5/7");
});

// ── Texto vacío / sin violaciones ──────────────────────────────────────────────
test("texto vacío → devuelto tal cual, sin violaciones", () => {
  const r = enforceCommandments("", ctx());
  assert.equal(r.texto, "");
  assert.deepEqual(r.violaciones, []);
});

test("texto limpio sin ninguna violación → intacto", () => {
  const texto = "Tu sobrante mensual es de 500 €. ¿Cuál es tu meta?";
  const r = enforceCommandments(texto, ctx({ conceptos: { sobrante: 500 } }));
  assert.equal(r.texto, texto);
  assert.deepEqual(r.violaciones, []);
});

// ── Idempotencia (contrato: aplicarla dos veces da el mismo resultado) ────────
test("idempotencia: aplicar enforceCommandments dos veces da el mismo texto", () => {
  const contexto = ctx({ missing: ["tae"], conceptos: { monto: 30000, plazo: 36, cuota: 926.31 }, esSimulacion: true });
  const once = enforceCommandments(
    "La cuota sería de 926,31 € (simulación con TAE de referencia — tu banco te dará la tasa real). " +
      "¿Qué TAE te ofrece tu banco? Con ese dato la cuota es exacta al 100%.",
    contexto,
  );
  const twice = enforceCommandments(once.texto, contexto);
  assert.equal(once.texto, twice.texto);
});

test("idempotencia: caso del déficit fantasma también es idempotente", () => {
  const contexto = ctx({ conceptos: { ingreso: 10000, gastos: 9500, sobrante: 500 } });
  const once = enforceCommandments("Tienes un déficit mensual de 9500 €. ¿Confirmamos el plan?", contexto);
  const twice = enforceCommandments(once.texto, contexto);
  assert.equal(once.texto, twice.texto);
});
