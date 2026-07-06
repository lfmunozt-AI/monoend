// Tests del guardarraíl de cifras. Runner nativo de Node (node:test) vía tsx,
// sin añadir framework. Ejecutar: `npm test`.
//
// Incluye los CASOS REALES que fallaron (A1, C1 y el cálculo válido) además de
// cobertura de cada pieza por separado.

import { test } from "node:test";
import assert from "node:assert/strict";

import { extractInputFacts } from "./extract";
import { validateGrounding } from "./validate";
import { applyPolicy } from "./policy";
import { parseModelOutput } from "./schema";
import { parseDigitAmount, findNumberMentions } from "./numbers";
import { runGuardrail } from "./index";

// ── Núcleo numérico ────────────────────────────────────────────────────────────
test("parseDigitAmount: convención es/LatAm", () => {
  assert.equal(parseDigitAmount("40000"), 40000);
  assert.equal(parseDigitAmount("1.200"), 1200);
  assert.equal(parseDigitAmount("1.200,50"), 1200.5);
  assert.equal(parseDigitAmount("1.200.000"), 1200000);
  assert.equal(parseDigitAmount("2000,5"), 2000.5);
});

test("findNumberMentions: dígitos y palabras", () => {
  const vals = (s: string) => findNumberMentions(s).map((m) => m.value).sort((a, b) => a - b);
  assert.deepEqual(vals("tengo 40000 y cuarenta mil"), [40000, 40000]);
  assert.deepEqual(vals("dos mil pesos"), [2000]);
  assert.deepEqual(vals("cien mil"), [100000]);
  assert.deepEqual(vals("tres millones"), [3000000]);
});

// ── PIEZA 1 — extracción de hechos ──────────────────────────────────────────────
test("Pieza 1: '40000 en deudas' → {valor, etiqueta:deuda}", () => {
  const facts = extractInputFacts("Tengo 40000 en deudas");
  assert.equal(facts.length, 1);
  assert.equal(facts[0].valor, 40000);
  assert.equal(facts[0].etiqueta, "deuda");
});

test("Pieza 1: detecta moneda (euros) y etiqueta (ingreso)", () => {
  const facts = extractInputFacts("Gano 8000 euros al mes");
  assert.equal(facts.length, 1);
  assert.equal(facts[0].valor, 8000);
  assert.equal(facts[0].moneda, "EUR");
  assert.equal(facts[0].etiqueta, "ingreso");
});

test("Pieza 1: cifra en palabras con moneda pesos", () => {
  const facts = extractInputFacts("Debo cuarenta mil pesos");
  assert.equal(facts.length, 1);
  assert.equal(facts[0].valor, 40000);
  assert.equal(facts[0].moneda, "pesos");
  assert.equal(facts[0].etiqueta, "deuda");
});

test("Pieza 1: porcentaje se marca como moneda %", () => {
  const facts = extractInputFacts("Quiero ahorrar el 20%");
  assert.equal(facts.length, 1);
  assert.equal(facts[0].valor, 20);
  assert.equal(facts[0].moneda, "%");
});

test("Pieza 1: duración temporal NO es un hecho monetario", () => {
  const facts = extractInputFacts("Quiero un fondo para 6 meses");
  assert.equal(facts.length, 0);
});

test("Pieza 1: sin cifras → lista vacía (sin contexto)", () => {
  assert.deepEqual(extractInputFacts("Hola, ¿cómo administro mejor?"), []);
  assert.deepEqual(extractInputFacts(""), []);
});

// ── PIEZA 2 — validador de grounding ────────────────────────────────────────────
test("CASO A1: '40000 en deudas' + respuesta inventa '1500 de intereses'", () => {
  const facts = extractInputFacts("Tengo 40000 en deudas");
  const respuesta =
    "Con tus 40000 de deuda, pagarías unos 1500 de intereses al mes.";
  const r = validateGrounding(respuesta, facts);

  const aprob = r.cifras_aprobadas.map((c) => c.valor);
  const bloq = r.cifras_bloqueadas.map((c) => c.valor);
  assert.ok(aprob.includes(40000), "40000 debe APROBARSE (dato del usuario)");
  assert.ok(bloq.includes(1500), "1500 debe BLOQUEARSE (monto inventado)");
});

test("CASO C1: 'Gano 8000 euros' + respuesta inventa 'meta de 300000'", () => {
  const facts = extractInputFacts("Gano 8000 euros");
  const respuesta = "Genial, con 8000 mensuales podrías fijar una meta de 300000.";
  const r = validateGrounding(respuesta, facts);

  const aprob = r.cifras_aprobadas.map((c) => c.valor);
  const bloq = r.cifras_bloqueadas.map((c) => c.valor);
  assert.ok(aprob.includes(8000), "8000 debe APROBARSE");
  assert.ok(bloq.includes(300000), "300000 debe BLOQUEARSE");
});

test("CASO cálculo válido: 10000 → 'ahorra 2000 (20%)' se APRUEBA", () => {
  const facts = extractInputFacts("Gano 10000, ¿cuánto ahorro?");
  const respuesta = "Te recomiendo ahorrar 2000 (el 20%).";
  const r = validateGrounding(respuesta, facts);

  assert.equal(r.cifras_bloqueadas.length, 0, "nada debe bloquearse");
  const valores = r.cifras_aprobadas.map((c) => c.valor);
  assert.ok(valores.includes(2000), "2000 aprobado (cálculo)");
  assert.ok(valores.includes(20), "20% aprobado (concepto)");
  const dosmil = r.cifras_aprobadas.find((c) => c.valor === 2000);
  assert.equal(dosmil?.categoria, "calculo");
});

test("Pieza 2: porcentaje y regla temporal se aprueban como concepto", () => {
  const r = validateGrounding(
    "Mantén un fondo de 3 a 6 meses y ahorra un 20%.",
    [], // sin hechos del usuario
  );
  assert.equal(r.cifras_bloqueadas.length, 0);
  const conceptos = r.cifras_aprobadas.filter((c) => c.categoria === "concepto");
  assert.ok(conceptos.length >= 2);
});

test("Pieza 2: conversión mensual→anual (×12) se deriva", () => {
  const facts = extractInputFacts("Pago 1000 de renta al mes");
  const r = validateGrounding("Al año serían 12000 en renta.", facts);
  assert.equal(r.cifras_bloqueadas.length, 0);
  assert.ok(r.cifras_aprobadas.some((c) => c.valor === 12000 && c.categoria === "calculo"));
});

test("Pieza 2: suma de dos hechos se deriva", () => {
  const facts = extractInputFacts("Tengo una deuda de 30000 y otra de 10000");
  const r = validateGrounding("En total debes 40000.", facts);
  assert.ok(r.cifras_aprobadas.some((c) => c.valor === 40000));
  assert.equal(r.cifras_bloqueadas.length, 0);
});

// ── PIEZA 3 — política + log ──────────────────────────────────────────────────
test("Pieza 3: sin bloqueos → respuesta intacta, sin log", () => {
  const facts = extractInputFacts("Tengo 40000 en deudas");
  const respuesta = "Tus 40000 de deuda se pueden refinanciar.";
  const validation = validateGrounding(respuesta, facts);
  const policy = applyPolicy(respuesta, validation, "hash123");
  assert.equal(policy.bloqueado, false);
  assert.equal(policy.texto_final, respuesta);
  assert.equal(policy.logEntries.length, 0);
});

test("Pieza 3 (MVP): reescribe la frase con el monto inventado y loguea metadatos", () => {
  const facts = extractInputFacts("Tengo 40000 en deudas");
  const respuesta =
    "Con tus 40000 de deuda vas bien. Pagarás 1500 de intereses al mes.";
  const validation = validateGrounding(respuesta, facts);
  const policy = applyPolicy(respuesta, validation, "hash123", { dataHint: "tasa de interés" });

  assert.equal(policy.bloqueado, true);
  assert.ok(policy.texto_final.includes("40000"), "conserva la frase válida");
  assert.ok(!policy.texto_final.includes("1500"), "elimina el monto inventado");
  assert.ok(policy.texto_final.includes("tasa de interés"), "pide el dato faltante");
  assert.equal(policy.logEntries.length, 1);
  assert.equal(policy.logEntries[0].cifra_bloqueada, 1500);
  assert.equal(policy.logEntries[0].pregunta_hash, "hash123");
});

test("Pieza 3 (passthrough): no reescribe pero sí loguea", () => {
  const facts = extractInputFacts("Tengo 40000 en deudas");
  const respuesta = "Pagarás 1500 de intereses.";
  const validation = validateGrounding(respuesta, facts);
  const policy = applyPolicy(respuesta, validation, "h", { mode: "passthrough" });
  assert.equal(policy.bloqueado, true);
  assert.equal(policy.texto_final, respuesta);
  assert.equal(policy.logEntries.length, 1);
});

// ── PIEZA 4 — esquema Zod ──────────────────────────────────────────────────────
test("Pieza 4: JSON estructurado válido se parsea", () => {
  const raw = JSON.stringify({
    consejo: "Refinancia tu deuda.",
    cifras_usadas: [{ valor: 40000, fuente: "usuario" }],
  });
  const p = parseModelOutput(raw);
  assert.equal(p.structured, true);
  assert.equal(p.data.consejo, "Refinancia tu deuda.");
  assert.equal(p.data.cifras_usadas[0].valor, 40000);
});

test("Pieza 4: JSON dentro de fences se extrae", () => {
  const raw = "```json\n{\"consejo\":\"Ahorra\",\"cifras_usadas\":[]}\n```";
  const p = parseModelOutput(raw);
  assert.equal(p.structured, true);
  assert.equal(p.data.consejo, "Ahorra");
});

test("Pieza 4: texto plano es tolerado (structured:false, consejo=texto)", () => {
  const p = parseModelOutput("Solo texto, sin JSON.");
  assert.equal(p.structured, false);
  assert.equal(p.data.consejo, "Solo texto, sin JSON.");
  assert.deepEqual(p.data.cifras_usadas, []);
});

// ── Orquestador end-to-end ─────────────────────────────────────────────────────
test("runGuardrail end-to-end: A1 bloquea y reescribe sin tocar DB", async () => {
  const out = await runGuardrail(
    "Tengo 40000 en deudas",
    "Con tus 40000 de deuda, pagarás 1500 de intereses al mes.",
  );
  assert.equal(out.bloqueado, true);
  assert.ok(out.hechos.some((f) => f.valor === 40000));
  assert.ok(!out.texto_final.includes("1500"));
  assert.equal(out.logEntries.length, 1);
  assert.equal(out.logEntries[0].pregunta_hash.length, 16);
});

test("runGuardrail end-to-end: cálculo válido pasa intacto", async () => {
  const out = await runGuardrail(
    "Gano 10000, ¿cuánto ahorro?",
    "Te recomiendo ahorrar 2000 (el 20%).",
  );
  assert.equal(out.bloqueado, false);
  assert.equal(out.texto_final, "Te recomiendo ahorrar 2000 (el 20%).");
});
