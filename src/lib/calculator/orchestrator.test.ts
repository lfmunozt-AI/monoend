// Tests del orquestador (PIEZA 2) y de su integración con el validador (PIEZA
// 3). Runner nativo de Node (node:test) vía tsx. Ejecutar: `npm test`.

import { test } from "node:test";
import assert from "node:assert/strict";

import { buildVerifiedContext } from "./orchestrator";
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
