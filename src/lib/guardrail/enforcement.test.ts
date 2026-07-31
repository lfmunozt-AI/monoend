// Tests de la tanda "bloquear lo falso sin sustituir lo bueno" (AG08).
// Runner nativo de Node (node:test) vía tsx. Ejecutar: `npm run test:guardrail`.
//
// Los tres CASOS REALES vienen del diagnóstico forense sobre `response_telemetry`
// (27 turnos, 13 con el texto modificado por nuestras capas):
//   · CASO A (21:03:40) — scenario_missing VACÍO y conceptos COMPLETO; una
//     confirmación natural del modelo se sustituyó por la plantilla que PIDE
//     ingresos y gastos… que el motor ya tenía. Y `mutations` quedó vacío.
//   · CASO B (20:55:55) — el modelo gestionó bien una digresión y volvió a la
//     meta; se sustituyó igual por la plantilla.
//   · CASO C (21:02:58) — "Reserva de Imprevistos … al menos 3 meses de gastos"
//     reescrito a "48 meses" (el plazo del crédito). Absurdo financiero
//     fabricado por NOSOTROS.

import { test } from "node:test";
import assert from "node:assert/strict";

import { parseEnforcementMode, getEnforcementMode, permiteSustitucion } from "./enforcement";
import { ensureSubstance, resolveClosing, applyPolicy, type Mutation } from "./policy";
import { validateGrounding } from "./validate";
import { applyEnforcement, auditarMutaciones } from "./pipeline";

// ── Textos reales del diagnóstico ────────────────────────────────────────────

const CASO_A_RAW =
  "Movimiento registrado. Mantén el control de tus gastos y la disciplina en el pago mensual. " +
  "En 30 días revisamos el avance y ajustamos si hace falta. " +
  "¿Quieres que te prepare un recordatorio mensual para la cuota?";

const CASO_A_PLANTILLA =
  "Para darte una cifra exacta necesito un dato concreto — ¿me compartes tus ingresos y gastos mensuales?";

const CASO_B_RAW =
  "Hoy no puedo mirar el tiempo, pero sí tu plan. Volvamos a la meta: el siguiente hito es el pago de este mes.";

const CASO_C_RAW =
  "Revisa tu Reserva de Imprevistos para asegurar que cubra al menos 3 meses de gastos.";

// Estado real del Caso A: el motor lo sabía TODO (ingreso 2300, gastos 1750,
// sobrante 550, cuota 248,85, plazo 48, TAE 9) y scenario_missing estaba vacío.
const CONCEPTOS_CASO_A: Record<string, number> = {
  ingreso: 2300,
  gastos: 1750,
  sobrante: 550,
  cuota: 248.85,
  plazo: 48,
  tae: 9,
};

// ── PIEZA 1 — flag ENFORCEMENT_MODE ──────────────────────────────────────────

test("PIEZA 1: el modo por defecto es 'full' (no cambia producción sin querer)", () => {
  assert.equal(parseEnforcementMode(undefined), "full");
  assert.equal(parseEnforcementMode(""), "full");
  assert.equal(parseEnforcementMode("cualquier-cosa"), "full");
  assert.equal(parseEnforcementMode("MINIMAL"), "minimal");
  assert.equal(parseEnforcementMode(" minimal "), "minimal");
});

test("PIEZA 1: getEnforcementMode lee la env var y permiteSustitucion la traduce", () => {
  const prev = process.env.ENFORCEMENT_MODE;
  delete process.env.ENFORCEMENT_MODE;
  assert.equal(getEnforcementMode(), "full");
  process.env.ENFORCEMENT_MODE = "minimal";
  assert.equal(getEnforcementMode(), "minimal");
  if (prev === undefined) delete process.env.ENFORCEMENT_MODE;
  else process.env.ENFORCEMENT_MODE = prev;

  assert.equal(permiteSustitucion("full"), true);
  assert.equal(permiteSustitucion("minimal"), false);
});

// ── PIEZA 2 — ensureSubstance acotado ────────────────────────────────────────

test("PIEZA 2 · CASO A: la confirmación del modelo sobrevive INTACTA", () => {
  assert.equal(ensureSubstance(CASO_A_RAW, { lang: "es", missing: [] }), CASO_A_RAW);
});

test("PIEZA 2 · CASO A: con missing VACÍO está PROHIBIDO pedir datos", () => {
  // Ni siquiera con un texto pobre: el motor ya tiene ingreso y gastos.
  const pobre = "Ok.";
  const out = ensureSubstance(pobre, { lang: "es", missing: [] });
  assert.ok(!out.includes("compartes tus ingresos"), `no puede pedir datos: ${out}`);
  assert.notEqual(out, CASO_A_PLANTILLA);
});

test("PIEZA 2 · CASO B: la redirección de una digresión no se toca", () => {
  assert.equal(ensureSubstance(CASO_B_RAW, { lang: "es", missing: ["tae"] }), CASO_B_RAW);
});

test("PIEZA 2: confirmación corta (<220 chars, sin cifras) ya no se destruye", () => {
  const texto = "Movimiento registrado. Seguimos con el plan tal como lo dejamos.";
  assert.equal(ensureSubstance(texto, { lang: "es", missing: ["tae"] }), texto);
});

test("PIEZA 2: propuesta de siguiente paso sin cifras → intacta", () => {
  const texto = "Te propongo empezar por el recorte del ocio antes de tocar nada más.";
  assert.equal(ensureSubstance(texto, { lang: "es", missing: ["gastos"] }), texto);
});

test("PIEZA 2: respuesta REALMENTE vacía (<30 chars, sin verbo) → petición del dato que falta", () => {
  const out = ensureSubstance("Vale.", { lang: "es", missing: ["tae"] });
  assert.match(out, /TAE real de tu banco/);
});

test("PIEZA 2: texto vacío del todo y sin missing → línea neutra, nunca petición de datos", () => {
  const out = ensureSubstance("", { lang: "es", missing: [] });
  assert.ok(out.trim().length > 0, "algo hay que entregar");
  assert.ok(!out.includes("?"), `no pide nada: ${out}`);
});

test("PIEZA 2: en modo minimal ensureSubstance no actúa nunca", () => {
  assert.equal(ensureSubstance("Vale.", { lang: "es", missing: ["tae"], enforcement: "minimal" }), "Vale.");
});

// ── PIEZA 3 — sustitución de cifras solo en contexto inequívoco ──────────────

const CIF_CASO_C = {
  valores: [2300, 1750, 550, 248.85, 48],
  conceptos: CONCEPTOS_CASO_A,
};

test("PIEZA 3 · CASO C: '3 meses' de Reserva de Imprevistos queda INTACTO (plazo=48)", () => {
  const r = validateGrounding(CASO_C_RAW, [], CIF_CASO_C);
  assert.equal(
    r.cifras_bloqueadas.length,
    0,
    `ninguna cifra se bloquea: ${JSON.stringify(r.cifras_bloqueadas)}`,
  );
  const p = applyPolicy(CASO_C_RAW, r, "h");
  assert.equal(p.texto_final, CASO_C_RAW);
  assert.ok(!p.texto_final.includes("48 meses"), "jamás se fabrica el absurdo de 48 meses de reserva");
});

test("PIEZA 3: '3 meses' hablando de ahorro tampoco se toca", () => {
  const texto = "A ese ritmo de ahorro tendrás el colchón en 3 meses.";
  const r = validateGrounding(texto, [], CIF_CASO_C);
  assert.equal(r.cifras_bloqueadas.length, 0);
});

test("PIEZA 3: el plazo SÍ se corrige dentro de una frase de crédito", () => {
  const texto = "El crédito quedaría a 36 meses con la cuota que calculamos.";
  const r = validateGrounding(texto, [], CIF_CASO_C);
  const bloq = r.cifras_bloqueadas.find((c) => c.valor === 36);
  assert.ok(bloq, "36 en posición de plazo dentro de una frase de crédito se bloquea");
  assert.equal(bloq?.correccion, 48, "y se corrige al plazo verificado");
});

test("PIEZA 3: en modo minimal NUNCA se reescribe la cifra — se elimina la frase", () => {
  const texto = "El crédito quedaría a 36 meses. El resto del plan sigue igual.";
  const r = validateGrounding(texto, [], CIF_CASO_C);
  const mutations: Mutation[] = [];
  const p = applyPolicy(texto, r, "h", { enforcement: "minimal", mutations });
  assert.ok(!p.texto_final.includes("36 meses"), "la frase con la cifra no verificable desaparece");
  assert.ok(!p.texto_final.includes("48 meses"), "y no se fabrica ninguna cifra nueva");
  assert.ok(p.texto_final.includes("El resto del plan sigue igual"), "el resto sobrevive");
  assert.ok(mutations.length > 0, "la eliminación queda registrada");
});

// ── PIEZA 4 — el cierre solo añade ───────────────────────────────────────────

test("PIEZA 4: la pregunta propia del modelo sobrevive aunque no coincida con missing[0]", () => {
  const texto =
    "Calculando con una TAE de referencia del 7%, la cuota sería de 452,78 €/mes. ¿Te gustaría proceder con esta compra?";
  const out = resolveClosing(texto, { carril: "FINANCIERO", missing: ["tae"], lang: "es" });
  assert.equal(out, texto);
});

test("PIEZA 4 · CASO A: el cierre del modelo no se pisa con missing vacío", () => {
  const out = resolveClosing(CASO_A_RAW, { carril: "FINANCIERO", missing: [], lang: "es" });
  assert.equal(out, CASO_A_RAW);
});

test("PIEZA 4: sin ningún cierre → se AÑADE la petición canónica", () => {
  const texto = "La cuota de 452,78 €/mes cabe en tu sobrante de 500 €.";
  const out = resolveClosing(texto, { carril: "FINANCIERO", missing: ["tae"], lang: "es" });
  assert.ok(out.startsWith(texto), "el texto del modelo se conserva entero");
  assert.match(out, /¿Qué TAE te ofrece tu banco\?/);
});

test("PIEZA 4: el cierre DELEGATIVO sigue siendo la única sustitución que sobrevive", () => {
  const texto = "Tu sobrante es 500 €. ¿Qué gastos podrías reducir?";
  const out = resolveClosing(texto, { carril: "FINANCIERO", missing: ["tae"], lang: "es" });
  assert.ok(!out.includes("podrías reducir"), "la delegación se elimina");
  assert.match(out, /¿Qué TAE te ofrece tu banco\?/);
});

test("PIEZA 4: en minimal solo se elimina la delegación, nunca se añade cierre", () => {
  const texto = "Tu sobrante es 500 €. ¿Qué gastos podrías reducir?";
  const out = resolveClosing(texto, {
    carril: "FINANCIERO",
    missing: ["tae"],
    lang: "es",
    enforcement: "minimal",
  });
  assert.ok(!out.includes("podrías reducir"));
  assert.ok(!out.includes("TAE te ofrece"), `sin cierre añadido: ${out}`);
});

// ── PIEZA 5 — registro completo de mutaciones ────────────────────────────────

const BASE = {
  userMessage: "Registra el pago de este mes.",
  carril: "FINANCIERO" as const,
  lang: "es" as const,
  missing: [] as string[],
  valores: CIF_CASO_C.valores,
  conceptos: CONCEPTOS_CASO_A,
  esSimulacion: false,
};

test("PIEZA 5 · CASO A: el texto sobrevive y, de cambiar algo, quedaría registrado", async () => {
  const r = await applyEnforcement(CASO_A_RAW, BASE);
  assert.equal(r.texto, CASO_A_RAW, "la respuesta buena se entrega tal cual");
  assert.equal(r.mutations.length, 0, "sin cambios, sin mutaciones");
  assert.ok(auditarMutaciones(CASO_A_RAW, r.texto, r.mutations));
});

test("PIEZA 5: INVARIANTE DE AUDITORÍA — raw !== final implica mutations.length > 0", async () => {
  const casos: Array<{ raw: string; input: typeof BASE }> = [
    // cifra sin respaldo → frase eliminada
    { raw: "Tu sobrante es de 9.999 €. ¿Seguimos?", input: BASE },
    // cierre delegativo → sustituido
    { raw: "Tu sobrante es de 550 €. ¿Qué gastos podrías reducir?", input: BASE },
    // sin cierre y con missing → cierre añadido
    {
      raw: "Tu sobrante es de 550 €.",
      input: { ...BASE, missing: ["tae"] },
    },
    // respuesta vacía → último recurso
    { raw: "Ok.", input: { ...BASE, missing: ["tae"] } },
    // fuga de proveedor → Mandamiento 4
    { raw: "Soy un modelo de OpenAI. Tu sobrante es de 550 €.", input: BASE },
    // concepto sin cálculo → Mandamiento 3
    {
      raw: "Tienes un déficit mensual de 9.500 €.",
      input: { ...BASE, conceptos: { sobrante: 550, ingreso: 2300 } },
    },
  ];

  for (const { raw, input } of casos) {
    for (const enforcement of ["full", "minimal"] as const) {
      const r = await applyEnforcement(raw, { ...input, enforcement });
      assert.ok(
        auditarMutaciones(raw, r.texto, r.mutations),
        `punto ciego con enforcement=${enforcement}: ${JSON.stringify({ raw, final: r.texto })}`,
      );
    }
  }
});

test("PIEZA 5: la ELIMINACIÓN por grounding deja rastro (antes ≠ '', después = '')", async () => {
  const r = await applyEnforcement("Tu sobrante es de 9.999 €. ¿Seguimos?", BASE);
  const borrado = r.mutations.find((m) => m.capa === "grounding" && m.despues === "");
  assert.ok(borrado, `la frase eliminada se registra: ${JSON.stringify(r.mutations)}`);
});

test("PIEZA 5: el modo aplicado viaja en el resultado (telemetría A/B)", async () => {
  const full = await applyEnforcement(CASO_A_RAW, BASE);
  const minimal = await applyEnforcement(CASO_A_RAW, { ...BASE, enforcement: "minimal" });
  assert.equal(full.enforcement, "full");
  assert.equal(minimal.enforcement, "minimal");
});

// ── Los tres casos reales, extremo a extremo ─────────────────────────────────

test("CASO A end-to-end: la plantilla que pedía datos ya conocidos NO aparece", async () => {
  for (const enforcement of ["full", "minimal"] as const) {
    const r = await applyEnforcement(CASO_A_RAW, { ...BASE, enforcement });
    assert.ok(
      !r.texto.includes("compartes tus ingresos"),
      `enforcement=${enforcement} volvió a pedir lo que el motor ya sabe: ${r.texto}`,
    );
  }
});

test("CASO B end-to-end: la digresión bien resuelta sobrevive en ambos modos", async () => {
  // El carril real fue FINANCIERO: "¿qué temperatura hace?" no trae señal
  // financiera ni META, así que classifyTurn lo hereda por CONTINUIDAD del
  // escenario — de ahí que ensureSubstance llegara a ejecutarse y lo destruyera.
  for (const enforcement of ["full", "minimal"] as const) {
    const r = await applyEnforcement(CASO_B_RAW, {
      ...BASE,
      userMessage: "¿qué temperatura hace?",
      carril: "FINANCIERO",
      enforcement,
    });
    assert.equal(r.texto, CASO_B_RAW);
  }
});

test("CASO C end-to-end: la Reserva de Imprevistos nunca pasa a 48 meses", async () => {
  for (const enforcement of ["full", "minimal"] as const) {
    const r = await applyEnforcement(CASO_C_RAW, { ...BASE, enforcement });
    assert.ok(!r.texto.includes("48 meses"), `enforcement=${enforcement}: ${r.texto}`);
  }
});

// ── PIEZA 5a (complemento, 5ª tanda) — FRONTERA DE AUTORIDAD EN TURNOS EMOCIONALES
//
// "La calidez es del modelo, no de las capas": el enforcement solo tiene
// autoridad sobre cifras y hechos verificables. Un turno con esEmocional=true
// corre con la misma frontera reducida de META — grounding, ensureSubstance,
// resolveClosing y enforceMissingClosing se DESACTIVAN — sea cual sea su carril.

test("PIEZA 5a: turno emocional NUNCA recibe cierre forzado, aunque falte un dato", async () => {
  const texto = "Sé que esto pesa, y lo que sientes tiene sentido — no estás fallando.";
  const r = await applyEnforcement(texto, {
    ...BASE,
    userMessage: "estoy frustrado, no consigo trabajo pero quiero ahorrar",
    carril: "FINANCIERO",
    missing: ["ingreso", "gastos"],
    esEmocional: true,
  });
  assert.equal(r.texto, texto, "PROHIBIDO forzar petición de dato en un turno emocional");
});

test("PIEZA 5a: turno emocional NUNCA recibe sustancia forzada, aunque el texto sea corto", async () => {
  const texto = "Entiendo.";
  const r = await applyEnforcement(texto, {
    ...BASE,
    userMessage: "me da vergüenza lo mal que llevo mis cuentas",
    carril: "FINANCIERO",
    missing: ["ingreso"],
    esEmocional: true,
  });
  assert.equal(r.texto, texto, "ensureSubstance no debe tocar un turno emocional");
});

test("PIEZA 5a: el mismo texto CON carril FINANCIERO pero esEmocional=false SÍ recibe cierre", async () => {
  const texto = "Tu sobrante es 500 €.";
  const r = await applyEnforcement(texto, {
    ...BASE,
    carril: "FINANCIERO",
    missing: ["tae"],
    esEmocional: false,
  });
  assert.notEqual(r.texto, texto, "sin la señal emocional, el cierre normal sigue aplicando");
});

test("PIEZA 5a: turno emocional en carril MIXTO también se desactiva (no solo FINANCIERO)", async () => {
  const texto = "Ánimo — vamos paso a paso, hoy solo toca respirar.";
  const r = await applyEnforcement(texto, {
    ...BASE,
    userMessage: "estoy agobiado, gano 2000",
    carril: "MIXTO",
    missing: ["gastos"],
    esEmocional: true,
  });
  assert.equal(r.texto, texto);
});

// ── FIX 5 (7ª tanda, testdev6) — resolveClosing NUNCA deja un segundo cierre ──
// "Si la respuesta YA termina en pregunta, no se añade nada. Sin excepciones."
// Antes la garantía de "una sola pregunta final" solo vivía en Commandments
// (Mandamiento 1), corriendo DESPUÉS de resolveClosing en la cadena —
// `resolveClosing` ahora la aplica a SU PROPIA salida en cada uno de sus
// caminos de retorno.

test("FIX 5: el modelo cierra con DOS preguntas seguidas → resolveClosing colapsa a una sola", () => {
  const texto = "Con 2.400 € de monto, vamos avanzando. ¿Confirmas que esos son tus gastos completos? ¿A cuántos meses quieres financiar esos 2.400 €?";
  const out = resolveClosing(texto, { carril: "FINANCIERO", missing: ["plazo"], lang: "es" });
  assert.equal((out.match(/\?/g) ?? []).length, 1, `debe quedar UNA sola pregunta: ${out}`);
  assert.match(out, /cuantos meses|A cuántos meses/i);
  assert.ok(!out.includes("¿Confirmas que esos son tus gastos completos?"), "la pregunta que no apunta a missing[0] se descarta");
});

test("FIX 5: el modelo YA cierra con la pregunta correcta (una sola) → intacta, sin añadidos", () => {
  const texto = "Con 2.400 € de monto, ¿a cuántos meses quieres financiarlo?";
  const out = resolveClosing(texto, { carril: "FINANCIERO", missing: ["plazo"], lang: "es" });
  assert.equal(out, texto, "una sola pregunta ya presente: nunca se añade nada más");
});

test("FIX 5: cierre delegativo sustituido — el resultado sigue siendo UNA sola pregunta", () => {
  const texto = "Tu sobrante es 500 €. ¿Confirmas que esos son tus gastos completos? ¿Qué gastos podrías reducir?";
  const out = resolveClosing(texto, { carril: "FINANCIERO", missing: ["plazo"], lang: "es" });
  assert.equal((out.match(/\?/g) ?? []).length, 1, `debe quedar UNA sola pregunta: ${out}`);
});

// ── FIX 2c (8ª tanda, testdev7) — enforcement determinista de extracción ─────
// ambigua. El prompt YA le prohíbe al modelo dar plan/cifras derivadas
// cuando la extracción del turno quedó ambigua (huérfanos o discrepancia
// agregado/desglose) — esta es la red de seguridad: si el modelo IGUAL
// entrega una cifra derivada, se sustituye la respuesta ENTERA por la
// pregunta de aclaración, y esa sustitución queda en `mutations`.

const RESPUESTA_ACLARACION = "Antes de seguir: me dijiste 2200 € de gastos, pero el desglose que me diste suma 2250 €. ¿Cuál de los dos uso?";

test("FIX 2c: extraccionAmbigua=true y la respuesta SÍ trae una cifra derivada (sobrante) → se sustituye entera", async () => {
  const texto = "Tu sobrante mensual es de 550 €, así que puedes destinarlo a tu meta cada mes.";
  const r = await applyEnforcement(texto, {
    ...BASE,
    extraccionAmbigua: true,
    respuestaAclaracion: RESPUESTA_ACLARACION,
  });
  assert.equal(r.texto, RESPUESTA_ACLARACION, "debe sustituirse por la pregunta de aclaración");
  assert.ok(r.mutations.some((m) => m.capa === "extraccionAmbigua"), "la sustitución debe quedar registrada en mutations");
  assert.ok(auditarMutaciones(texto, r.texto, r.mutations));
});

test("FIX 2c: extraccionAmbigua=true pero la respuesta NO menciona ninguna cifra derivada → se entrega intacta", async () => {
  const texto = "¿A qué corresponden esos números que mencionaste? Quiero anotarlos bien.";
  const r = await applyEnforcement(texto, {
    ...BASE,
    extraccionAmbigua: true,
    respuestaAclaracion: RESPUESTA_ACLARACION,
  });
  assert.equal(r.texto, texto, "sin cifra derivada, no hay nada que sustituir");
});

test("FIX 2c: extraccionAmbigua=false (turno normal) → aunque haya cifra derivada, NUNCA se sustituye por esta capa", async () => {
  const texto = "Tu sobrante mensual es de 550 €, así que puedes destinarlo a tu meta cada mes.";
  const r = await applyEnforcement(texto, {
    ...BASE,
    extraccionAmbigua: false,
    respuestaAclaracion: RESPUESTA_ACLARACION,
  });
  assert.notEqual(r.texto, RESPUESTA_ACLARACION);
});

test("FIX 2c: extraccionAmbigua=true pero SIN respuestaAclaracion (no se calculó) → no hace nada, evita romper el turno", async () => {
  const texto = "Tu sobrante mensual es de 550 €.";
  const r = await applyEnforcement(texto, {
    ...BASE,
    extraccionAmbigua: true,
    respuestaAclaracion: null,
  });
  assert.notEqual(r.texto, RESPUESTA_ACLARACION);
});
