// Tests de la tanda "persona cálida + auto-chequeo + factibilidad + M9
// estricto" (AG08, 4ª tanda del 2026-07-30). Runner nativo de Node (node:test)
// vía tsx. Ejecutar: `npm run test:guardrail`.
//
// Evidencia de producción (telemetría, testdev3, 30/07 21:03-21:12,
// ENFORCEMENT_MODE=full, gpt-4.1-mini): cuatro fallos, ninguno causado por las
// capas de enforcement (el tono hostil sale directo del system prompt — ver
// consigliere.ts). Aquí se cubren FIX 3 (factibilidad), FIX 4 (Mandamiento 9
// estricto) y FIX 5 (espacio entre frases).

import { test } from "node:test";
import assert from "node:assert/strict";

import { validateGrounding } from "./validate";
import { cleanup } from "./policy";
import { enforceCommandments, type CommandmentContext } from "./commandments";
import { systemPromptConsigliere } from "../prompts/consigliere";

// ── FIX 1 — verificación estática del prompt (persona cálida) ───────────────

test("FIX 1: las 4 frases hostiles reales están explícitamente PROHIBIDAS en el prompt", () => {
  assert.match(systemPromptConsigliere, /Saludo registrado/);
  assert.match(systemPromptConsigliere, /No es relevante cómo estoy/);
  assert.match(systemPromptConsigliere, /No busco ser grosero/);
  assert.match(systemPromptConsigliere, /"No\." como frase inicial/);
});

test("FIX 1: el prompt ya NO describe al Consigliere como 'frío'", () => {
  assert.ok(!/estratega financiero frío/.test(systemPromptConsigliere), "IDENTIDAD reescrita a 'cercano'");
});

test("FIX 1: el bloque TONO exige calidez explícita", () => {
  assert.match(systemPromptConsigliere, /TONO — CÁLIDO ANTES QUE EFICIENTE/);
  assert.match(systemPromptConsigliere, /Nunca corrijas al usuario en seco/);
});

// ── FIX 2a — verificación estática del bloque de auto-chequeo ───────────────

test("FIX 2a: el prompt trae el bloque de verificación obligatoria de 3 puntos", () => {
  assert.match(systemPromptConsigliere, /VERIFICACIÓN OBLIGATORIA ANTES DE RESPONDER/);
  assert.match(systemPromptConsigliere, /Preguntar es mejor que asumir/);
});

// ── FIX 3 — REGLA DE FACTIBILIDAD ────────────────────────────────────────────

const CIF_FACTIBLE = {
  valores: [2300, 1750, 450],
  conceptos: { ingreso: 2300, gastos: 1750, sobrante: 450 },
};

test("FIX 3 · caso real: 'ahorrar 746,55 € en 30 días' con sobrante 450 → BLOQUEADA", () => {
  const r = validateGrounding("Podrías ahorrar 746,55 € en 30 días.", [], CIF_FACTIBLE);
  const bloq = r.cifras_bloqueadas.find((c) => c.valor === 746.55);
  assert.ok(bloq, `746,55 supera el sobrante (450): ${JSON.stringify(r.cifras_bloqueadas)}`);
  assert.match(bloq!.motivo, /supera el sobrante real/);
});

test("FIX 3: 'ahorra 300 €' con sobrante 450 → APROBADA (dentro del sobrante)", () => {
  const r = validateGrounding("Ahorra 300 € este mes.", [], CIF_FACTIBLE);
  assert.equal(r.cifras_bloqueadas.length, 0, `300 ≤ 450 no debería bloquearse: ${JSON.stringify(r.cifras_bloqueadas)}`);
  assert.ok(r.cifras_aprobadas.some((c) => c.valor === 300));
});

test("FIX 3: 'recorta 5.000 €' con gastos 1750 → BLOQUEADA (supera el gasto real)", () => {
  const r = validateGrounding("Deberías recortar 5.000 € este mes.", [], CIF_FACTIBLE);
  const bloq = r.cifras_bloqueadas.find((c) => c.valor === 5000);
  assert.ok(bloq, `5000 supera gastos (1750): ${JSON.stringify(r.cifras_bloqueadas)}`);
  assert.match(bloq!.motivo, /supera el gasto real/);
});

test("FIX 3: 'recorta 100 €' con gastos 1750 → APROBADA", () => {
  const r = validateGrounding("Recorta 100 € de suscripciones.", [], CIF_FACTIBLE);
  assert.equal(r.cifras_bloqueadas.length, 0);
});

test("FIX 3: el verbo NO tiene que abrir la frase ('Podrías ahorrar...')", () => {
  const r = validateGrounding("Este mes podrías destinar 900 € a tu meta.", [], CIF_FACTIBLE);
  const bloq = r.cifras_bloqueadas.find((c) => c.valor === 900);
  assert.ok(bloq, "900 > 450 (sobrante), aunque 'podrías destinar' no abra la frase");
});

test("FIX 3: sin conceptos.sobrante/gastos definidos → no interviene (nada que comparar)", () => {
  const r = validateGrounding("Ahorra 5000 € este mes.", [], { valores: [], conceptos: {} });
  // Sin sobrante conocido, cae al resto del pipeline (probablemente bloqueada
  // por falta de respaldo general, pero NO por la regla de factibilidad).
  const bloq = r.cifras_bloqueadas.find((c) => c.valor === 5000);
  if (bloq) assert.ok(!bloq.motivo.includes("sobrante real"), "no debe citar la regla de factibilidad sin sobrante conocido");
});

// ── FIX 4 — Mandamiento 9 endurecido (plan mutilado) ─────────────────────────

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

test("FIX 4 · caso real: raw 3 pasos → final 1 paso (sin cifra) → REVERTIDO", () => {
  const raw =
    "Propongo estos pasos:\n" +
    "1. Recorta 100 € de suscripciones.\n" +
    "2. Aumenta tus ingresos en 100 € extra.\n" +
    "3. Mantén la Reserva de Imprevistos intacta.\n" +
    "¿Registramos?";
  const mutilado = "Propongo estos pasos:\n1. Mantén la Reserva de Imprevistos intacta.\n¿Registramos?";
  const r = enforceCommandments(mutilado, ctx({ raw }));
  const m9 = r.violaciones.find((v) => v.mandamiento === 9);
  assert.ok(m9, `M9 debe detectar el plan mutilado: ${JSON.stringify(r.violaciones)}`);
  assert.equal(r.texto, raw);
});

test("FIX 4: ENDURECIMIENTO real — el paso superviviente SÍ trae una cifra, pero el plan sigue mutilado", () => {
  // La condición vieja (sin ninguna cifra monetaria) NO habría disparado aquí:
  // el único paso que sobrevive trae 100 €. El conteo de ítems (3 → 1) es lo
  // que debe disparar M9 — "no basta con que quede alguna cifra".
  const raw =
    "Propongo estos pasos:\n" +
    "1. Recorta 100 € de suscripciones.\n" +
    "2. Aumenta tus ingresos en 100 € extra.\n" +
    "3. Mantén la Reserva de Imprevistos intacta.\n" +
    "¿Registramos?";
  const mutiladoConCifra = "Propongo estos pasos:\n1. Recorta 100 € de suscripciones.\n¿Registramos?";
  const r = enforceCommandments(mutiladoConCifra, ctx({ raw }));
  const m9 = r.violaciones.find((v) => v.mandamiento === 9);
  assert.ok(m9, `M9 debe disparar aunque quede una cifra — plan mutilado: ${JSON.stringify(r.violaciones)}`);
  assert.equal(r.texto, raw);
});

test("FIX 4: plan con el MISMO número de pasos que el raw → NO se dispara M9 por mutilación", () => {
  const raw =
    "Propongo estos pasos:\n1. Recorta 100 €.\n2. Aumenta ingresos en 100 €.\n¿Registramos?";
  const r = enforceCommandments(raw, ctx({ raw }));
  assert.equal(r.violaciones.some((v) => v.mandamiento === 9), false, "raw === final, nada que revertir");
});

test("FIX 4: raw SIN lista numerada → el chequeo de mutilación no aplica (nRaw=0)", () => {
  const raw = "Propongo un plan: recorta 100 € en ocio. ¿Arrancamos con este plan?";
  const r = enforceCommandments(raw, ctx({ raw }));
  assert.equal(r.violaciones.some((v) => v.mandamiento === 9), false);
});

// ── FIX 5 — espacio garantizado entre frases ─────────────────────────────────

test("FIX 5 · caso real: 'justa.Confirma' → se inserta el espacio faltante", () => {
  const out = cleanup("Tu observación es justa.Confirma si quieres seguir.");
  assert.equal(out, "Tu observación es justa. Confirma si quieres seguir.");
});

test("FIX 5: no toca separadores de miles ('1.234')", () => {
  const out = cleanup("Tu cuota es de 1.234 € al mes.");
  assert.equal(out, "Tu cuota es de 1.234 € al mes.");
});

test("FIX 5: no toca decimales con coma ni texto ya bien espaciado", () => {
  const out = cleanup("Tu sobrante es 550,00 €. Confirma si quieres seguir.");
  assert.equal(out, "Tu sobrante es 550,00 €. Confirma si quieres seguir.");
});

test("FIX 5: también cubre ¿ y ¡ pegados tras el punto", () => {
  const out = cleanup("Entendido.¿Seguimos con el plan?");
  assert.equal(out, "Entendido. ¿Seguimos con el plan?");
});
