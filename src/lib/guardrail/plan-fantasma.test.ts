// Tests de la tanda "validación cifra a cifra + plan fantasma" (AG08, 2ª
// tanda del 2026-07-30). Runner nativo de Node (node:test) vía tsx. Ejecutar:
// `npm run test:guardrail`.
//
// CASO REAL (telemetría, usuario testdev2, 30/07 19:24:43, ENFORCEMENT_MODE=
// full, gpt-4.1-mini). conceptos verificados EXACTOS (reproducidos ejecutando
// el motor real: ingreso 2300, gastos 1750, crédito 30000 a 48 meses, TAE 9%):
//   cuota:746.55, sobrante:550, brecha:196.55, gastos:1750, ingreso:2300,
//   monto:30000, plazo:48, capacidad_anual:6600, aumento_necesario:196.55,
//   recorte_necesario:196.55, ahorro_necesario_mensual:625
//
// RAW real: "Para que la cuota de 746,55 € sea viable con tu sobrante de
// 550 €, debes aumentar ingresos o reducir gastos en al menos 196,55 €
// mensuales.\n1. Identificar y recortar una Fuga de Poder o gasto no vital
// por 100 €.\n2. Buscar un ingreso extra de 100 € al mes.\n3. Mantener la
// Reserva de Imprevistos intacta.\n4. Revisar progreso en 30 días para
// ajustar.\n¿Arrancamos con este plan?"
//
// FINAL real (el bug): "Propongo un plan concreto:\n1.2.3. Mantener la
// Reserva de Imprevistos intacta.\n4. Revisar progreso en 30 días para
// ajustar.\n¿Arrancamos con este plan?" — TODAS las cifras borradas eran
// correctas; el usuario confirmó un plan vacío.

import { test } from "node:test";
import assert from "node:assert/strict";

import { validateGrounding } from "./validate";
import { applyPolicy, renumberLists, resolveClosing, esTextoCanonico } from "./policy";
import { enforceCommandments, type CommandmentContext } from "./commandments";
import { applyEnforcement } from "./pipeline";

const CONCEPTOS_REALES: Record<string, number> = {
  cuota: 746.55,
  sobrante: 550,
  brecha: 196.55,
  gastos: 1750,
  ingreso: 2300,
  monto: 30000,
  plazo: 48,
  capacidad_anual: 6600,
  aumento_necesario: 196.55,
  recorte_necesario: 196.55,
  ahorro_necesario_mensual: 625,
};

const CIF_REALES = {
  valores: [746.55, 550, 196.55, 1750, 2300, 30000, 48, 6600, 625, 100],
  conceptos: CONCEPTOS_REALES,
};

const RAW_REAL =
  "Para que la cuota de 746,55 € sea viable con tu sobrante de 550 €, debes aumentar ingresos o " +
  "reducir gastos en al menos 196,55 € mensuales.\n" +
  "1. Identificar y recortar una Fuga de Poder o gasto no vital por 100 €.\n" +
  "2. Buscar un ingreso extra de 100 € al mes.\n" +
  "3. Mantener la Reserva de Imprevistos intacta.\n" +
  "4. Revisar progreso en 30 días para ajustar.\n" +
  "¿Arrancamos con este plan?";

// ── FIX 1 — validación cifra a cifra ─────────────────────────────────────────

test("FIX 1 · caso real: la frase de apertura completa (cuota+sobrante+brecha) queda INTACTA", () => {
  const frase =
    "Para que la cuota de 746,55 € sea viable con tu sobrante de 550 €, debes aumentar ingresos o " +
    "reducir gastos en al menos 196,55 € mensuales.";
  const r = validateGrounding(frase, [], CIF_REALES);
  assert.equal(r.cifras_bloqueadas.length, 0, `nada bloqueado: ${JSON.stringify(r.cifras_bloqueadas)}`);
  assert.equal(r.cifras_aprobadas.length, 3, "cuota, sobrante y brecha, las tres");
});

test("FIX 1: 'Los 6.600 € son tu capacidad anual: 550 € de sobrante × 12' → INTACTA", () => {
  const cif = { valores: [6600, 550], conceptos: { capacidad_anual: 6600, sobrante: 550 } };
  const r = validateGrounding("Los 6.600 € son tu capacidad anual: 550 € de sobrante × 12.", [], cif);
  assert.equal(r.cifras_bloqueadas.length, 0, `nada bloqueado: ${JSON.stringify(r.cifras_bloqueadas)}`);
});

test("FIX 1: NO reabre la regresión del defecto C (ingreso/gastos/sobrante = 500 los tres)", () => {
  const cif = { valores: [10000, 9500, 500, 6000], conceptos: { ingreso: 10000, gastos: 9500, sobrante: 500 } };
  const r = validateGrounding(
    "Tus ingresos son de 500 € y tus gastos son de 500 €, lo que te deja un sobrante de 500 €.",
    [],
    cif,
  );
  assert.equal(r.cifras_aprobadas.length, 1, "solo el sobrante (correcto) sobrevive");
  assert.equal(r.cifras_bloqueadas.length, 2, "ingreso y gastos hallucinados siguen bloqueados");
});

// ── FIX 2 — cifras de propuesta ──────────────────────────────────────────────

test("FIX 2: '1. Identificar y recortar... por 100 €' con gastos=1750 → INTACTA", () => {
  const r = validateGrounding("1. Identificar y recortar una Fuga de Poder o gasto no vital por 100 €.", [], CIF_REALES);
  assert.equal(r.cifras_bloqueadas.length, 0, `100 € es una propuesta ≤ gastos: ${JSON.stringify(r.cifras_bloqueadas)}`);
});

test("FIX 2: la MISMA propuesta con '5.000 €' (supera gastos=1750) → BLOQUEADA", () => {
  const r = validateGrounding("1. Identificar y recortar una Fuga de Poder o gasto no vital por 5.000 €.", [], CIF_REALES);
  const bloq = r.cifras_bloqueadas.find((c) => c.valor === 5000);
  assert.ok(bloq, `5000 supera el techo (gastos=1750): ${JSON.stringify(r.cifras_bloqueadas)}`);
});

test("FIX 2: '2. Buscar un ingreso extra de 100 € al mes.' con ingreso=2300 → INTACTA", () => {
  const r = validateGrounding("2. Buscar un ingreso extra de 100 € al mes.", [], CIF_REALES);
  assert.equal(r.cifras_bloqueadas.length, 0);
});

test("FIX 2: propuesta SIN verbo/enumerador (no es frase de acción) NO se exime", () => {
  // Misma cifra, misma keyword de concepto, pero como AFIRMACIÓN declarativa,
  // no como propuesta — no debe activarse la exención.
  const r = validateGrounding("Tus gastos no vitales son de 5.000 € al mes.", [], CIF_REALES);
  const bloq = r.cifras_bloqueadas.find((c) => c.valor === 5000);
  assert.ok(bloq, "declarativa, no propuesta: sigue el camino normal de grounding");
});

// ── FIX 3 — renumerar listas ──────────────────────────────────────────────────

test("FIX 3: colapsa el run pegado '1.2.3.' y renumera 1..N la racha contigua", () => {
  const texto = "1.2.3. Mantener la Reserva de Imprevistos intacta.\n4. Revisar progreso en 30 días para ajustar.";
  const r = renumberLists(texto);
  assert.equal(
    r.texto,
    "1. Mantener la Reserva de Imprevistos intacta.\n2. Revisar progreso en 30 días para ajustar.",
  );
  assert.equal(r.corregido, true);
});

test("FIX 3: eliminación de un ítem INTERMEDIO (2 de 4) también renumera bien", () => {
  const texto = "1. item uno\n2.3. item tres\n4. item cuatro";
  const r = renumberLists(texto);
  assert.equal(r.texto, "1. item uno\n2. item tres\n3. item cuatro");
});

test("FIX 3: lista sin cambios (ya bien numerada) → intacta", () => {
  const texto = "1. paso uno\n2. paso dos\n3. paso tres";
  const r = renumberLists(texto);
  assert.equal(r.texto, texto);
  assert.equal(r.corregido, false);
});

test("FIX 3: texto sin ninguna lista → intacto", () => {
  const texto = "Tu sobrante es de 550 €. ¿Confirmamos el plan?";
  const r = renumberLists(texto);
  assert.equal(r.texto, texto);
  assert.equal(r.corregido, false);
});

// ── FIX 4 — Mandamiento 9: PLAN FANTASMA ─────────────────────────────────────

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

test("Mandamiento 9: el FINAL vaciado del caso real se detecta y se revierte al raw", () => {
  const raw = "Propongo un plan concreto: te doy 3 pasos con cifras reales. ¿Arrancamos con este plan?";
  const vaciado = "Propongo un plan concreto:\n1.2.3. Mantener la Reserva de Imprevistos intacta.\n" +
    "4. Revisar progreso en 30 días para ajustar.\n¿Arrancamos con este plan?";
  // "Mantener..." y "Revisar... 30 días" no traen NINGUNA cifra monetaria real
  // (30 es unidad de tiempo) — plan fantasma: anuncia plan + pide confirmación
  // + cero cifras.
  const r = enforceCommandments(vaciado, ctx({ raw }));
  const m9 = r.violaciones.find((v) => v.mandamiento === 9);
  assert.ok(m9, `M9 debe dispararse: ${JSON.stringify(r.violaciones)}`);
  assert.equal(r.texto, raw);
});

test("Mandamiento 9: NO se dispara si el texto SÍ trae cifras reales (plan legítimo)", () => {
  const raw = "Propongo un plan: recorta 100 € en ocio. ¿Arrancamos con este plan?";
  const r = enforceCommandments(raw, ctx({ raw }));
  assert.equal(r.violaciones.some((v) => v.mandamiento === 9), false);
  assert.equal(r.texto, raw);
});

test("Mandamiento 9: NO se dispara sin `raw` (compatibilidad hacia atrás)", () => {
  const vaciado = "Propongo un plan concreto:\n1.2.3. Mantener la Reserva de Imprevistos intacta.\n¿Arrancamos con este plan?";
  const r = enforceCommandments(vaciado, ctx());
  assert.equal(r.violaciones.some((v) => v.mandamiento === 9), false, "sin raw, nada a lo que revertir");
});

test("Mandamiento 9: NO se dispara si el texto no anuncia plan/confirmación", () => {
  const raw = "Tu sobrante es de 550 €. Registrado.";
  const vaciado = "Registrado.";
  const r = enforceCommandments(vaciado, ctx({ raw }));
  assert.equal(r.violaciones.some((v) => v.mandamiento === 9), false, "no hay anuncio de plan ni pregunta de confirmación");
});

// ── FIX 5 — resolveClosing: cualquier dato concreto ──────────────────────────

test("FIX 5: cierre que pide OTRO dato concreto (no missing[0]) se conserva intacto", () => {
  const texto = "Aún no tengo el crédito completo. Dime el precio del carro y en cuántos meses planeas comprarlo.";
  const out = resolveClosing(texto, { carril: "FINANCIERO", missing: ["ingreso"], lang: "es" });
  assert.equal(out, texto);
  assert.ok(!out.includes("ingreso neto mensual"), "no se sustituye por el cierre canónico de missing[0]");
});

test("FIX 5: sin marcador interrogativo Y sin campo concreto, sigue añadiéndose el cierre canónico", () => {
  const texto = "Tu sobrante es de 550 €.";
  const out = resolveClosing(texto, { carril: "FINANCIERO", missing: ["ingreso"], lang: "es" });
  assert.ok(out.includes("ingreso neto mensual"), "sin ningún cierre propio, se añade el canónico");
});

test("FIX 5: frase puramente declarativa (nombra un campo, no pregunta nada) NO cuenta como cierre", () => {
  const texto = "Tu meta es un carro de 30000 en 36 meses.";
  const out = resolveClosing(texto, { carril: "FINANCIERO", missing: ["ingreso"], lang: "es" });
  assert.ok(out.includes("ingreso neto mensual"), "declarativa, no pide nada: el cierre canónico se añade igual");
});

// ── FIX 6 — textos canónicos propios inmunes ─────────────────────────────────

test("FIX 6: el cierre canónico de TAE es reconocido como texto propio", () => {
  assert.ok(esTextoCanonico("¿Qué TAE te ofrece tu banco? Con ese dato la cuota es exacta al 100%."));
});

test("FIX 6: 'Con ese dato la cuota es exacta al 100%' sobrevive al Mandamiento 3 aunque falte 'cuota' en conceptos", () => {
  const texto = "¿Qué TAE te ofrece tu banco? Con ese dato la cuota es exacta al 100%.";
  const r = enforceCommandments(texto, ctx({ missing: ["tae"], conceptos: {} }));
  assert.equal(r.texto, texto, "texto canónico propio, inmune al Mandamiento 3");
  assert.equal(r.violaciones.some((v) => v.mandamiento === 3), false);
});

test("FIX 6: una frase del MODELO que mencione 'cuota' sin respaldo SIGUE bloqueada (no es inmunidad general)", () => {
  const texto = "La cuota de tu préstamo será perfecta, confía en el plan.";
  const r = enforceCommandments(texto, ctx({ conceptos: {} }));
  assert.notEqual(r.texto, texto, "no es un texto canónico nuestro: sigue sujeta al Mandamiento 3");
});

// ── Caso real, extremo a extremo ─────────────────────────────────────────────

const BASE_REAL = {
  userMessage: "El banco me ofrece un 9%.",
  carril: "FINANCIERO" as const,
  lang: "es" as const,
  missing: [] as string[],
  valores: CIF_REALES.valores,
  conceptos: CONCEPTOS_REALES,
  esSimulacion: false,
};

test("CASO REAL end-to-end: el plan de 4 pasos sobrevive INTACTO, sin '1.2.3.'", async () => {
  for (const enforcement of ["full", "minimal"] as const) {
    const r = await applyEnforcement(RAW_REAL, { ...BASE_REAL, enforcement });
    assert.ok(r.texto.includes("746,55"), `enforcement=${enforcement}: falta 746,55 — ${r.texto}`);
    assert.ok(r.texto.includes("196,55"), `enforcement=${enforcement}: falta 196,55 — ${r.texto}`);
    assert.ok(r.texto.includes("100 €"), `enforcement=${enforcement}: falta 100 € — ${r.texto}`);
    assert.ok(!r.texto.includes("1.2.3."), `enforcement=${enforcement}: numeración pegada — ${r.texto}`);
    assert.equal(r.violaciones.some((v) => v.mandamiento === 9), false, `M9 no debería hacer falta: ${r.texto}`);
  }
});

test("CASO REAL: applyPolicy no bloquea nada de la frase de apertura", () => {
  const frase =
    "Para que la cuota de 746,55 € sea viable con tu sobrante de 550 €, debes aumentar ingresos o " +
    "reducir gastos en al menos 196,55 € mensuales.";
  const v = validateGrounding(frase, [], CIF_REALES);
  const p = applyPolicy(frase, v, "h");
  assert.equal(p.texto_final, frase);
  assert.equal(p.bloqueado, false);
});
