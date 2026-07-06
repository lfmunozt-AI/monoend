// Tests del orquestador (PIEZA 2) y de su integración con el validador (PIEZA
// 3). Runner nativo de Node (node:test) vía tsx. Ejecutar: `npm test`.

import { test } from "node:test";
import assert from "node:assert/strict";

import { buildVerifiedContext } from "./orchestrator";
import { validateGrounding } from "../guardrail/validate";

// ── PIEZA 2 — buildVerifiedContext ──────────────────────────────────────────
test("buildVerifiedContext: 'gano 2500, gasto 1500' → bloque con 1000, 300, 3600", () => {
  const { bloque, cifrasCalculadas } = buildVerifiedContext("gano 2500, gasto 1500");
  assert.ok(bloque.includes("1000"), "el bloque debe contener el sobrante 1000");
  assert.ok(bloque.includes("300"), "el bloque debe contener el ahorro sugerido 300");
  assert.ok(bloque.includes("3600"), "el bloque debe contener la proyección 3600");
  assert.ok(cifrasCalculadas.includes(1000));
  assert.ok(cifrasCalculadas.includes(300));
  assert.ok(cifrasCalculadas.includes(3600));
});

test("buildVerifiedContext: sin hechos → bloque vacío (el modelo pedirá contexto)", () => {
  const r = buildVerifiedContext("Hola, ¿cómo administro mejor?");
  assert.equal(r.bloque, "");
  assert.deepEqual(r.cifrasCalculadas, []);
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
