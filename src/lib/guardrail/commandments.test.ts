// Tests de enforceCommandments (ex assertOutputInvariants) — AUDITORÍA AG01
// (H2 + H5) + Mandamientos 6-8. Runner nativo de Node (node:test) vía tsx.
// Ejecutar: `npm run test:guardrail`.

import { test } from "node:test";
import assert from "node:assert/strict";

import { enforceCommandments, type CommandmentContext } from "./commandments";
import type { Mutation } from "./policy";
import { applyEnforcement } from "./pipeline";
import { cifraPedidaAusente, conceptsInSentence, conceptosPedidosEnPregunta } from "./context";

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

// ── Mandamiento 10 (QA testdev8, REDISEÑADO tras revisión AG01 — bloqueante 1) ─
//
// La primera versión revertía al RAW (texto sin validar) y podía resucitar
// una cifra inventada que el Mandamiento 3 había eliminado con razón —
// violaba G1b. El rediseño NUNCA vuelve al raw: repara la anáfora en sitio
// con una cifra de `conceptos` (verificada), o elimina la frase sin
// respaldo. Los cuatro tests obligatorios de la revisión, TODOS con el
// pipeline completo (`applyEnforcement`, no `enforceCommandments` aislado) y
// pasando `userMessage`/`raw` como hace `pipeline.ts:249` en producción —
// invocar sin esos dos argumentos es exactamente el "test que no prueba
// nada" que la revisión señaló como defecto (V11, cuarto caso de la serie).

test("Mandamiento 10 · OBLIGATORIO 1 — regresión del déficit fantasma CON el pipeline completo: NO republica el déficit inventado", async () => {
  const userMessage = "¿cuánto me queda al mes?";
  const conceptos = { sobrante: 250 }; // SIN 'deficit' — el motor nunca lo calculó
  const raw = "Te quedan 250 € al mes aunque arrastras un déficit de 9500 € que hay que cerrar.";
  const r = await applyEnforcement(raw, {
    userMessage,
    carril: "FINANCIERO",
    lang: "es",
    missing: [],
    valores: [250],
    conceptos,
    esSimulacion: false,
  });
  assert.ok(!r.texto.includes("9500") && !r.texto.includes("9.500"), `el déficit fantasma NUNCA se publica: ${r.texto}`);
  // La cifra pedida (250) no la reconstruye M10 aquí — la frase entera cayó
  // por la contradicción de signo (grounding), sin anáfora que reparar. Esa
  // es justamente la señal que dispara el reintento acotado de route.ts
  // (`cifraPedidaAusente`, la MISMA función que usa M10): se prueba aquí,
  // en frío, que la señal es correcta — sin necesitar mock de LLM.
  const seguimiento = cifraPedidaAusente(userMessage, r.texto, conceptos);
  assert.equal(seguimiento.ausente, true, "el sistema SABE que aún falta publicar el sobrante");
  assert.deepEqual(seguimiento.conceptosPedidos, ["sobrante"]);
});

test("Mandamiento 10 · OBLIGATORIO 2 — anáfora cuya cifra SÍ está en conceptos → reinsertada (nunca la cifra ausente/inventada)", async () => {
  const r = await applyEnforcement(
    "Te quedan 250 € al mes y podrías ahorrar 9.999 € al año sin esfuerzo. Eso te deja margen.",
    {
      userMessage: "¿cuánto me queda al mes?",
      carril: "FINANCIERO",
      lang: "es",
      missing: [],
      valores: [250],
      conceptos: { sobrante: 250 },
      esSimulacion: false,
    },
  );
  assert.ok(r.texto.includes("250"), `la cifra verificada se reinserta: ${r.texto}`);
  assert.ok(!r.texto.includes("9.999") && !r.texto.includes("9999"), `la cifra inventada NUNCA se publica: ${r.texto}`);
  assert.ok(r.violaciones.some((v) => v.mandamiento === 10));
});

// ── FIXTURE CANÓNICA REPUESTA (MAYOR 1, revisión follow-up QA testdev8) ─────
// V11: este test EXISTÍA con esta frase EXACTA en la tanda que introdujo el
// Mandamiento 10 y se ELIMINÓ en la tanda siguiente porque la regex de
// entonces (demostrativo + SUSTANTIVO, o "eso" desnudo) no la detectaba —
// se sustituyó por fixtures que sí pasaban en vez de arreglar la detección.
// Eso es exactamente la violación que V11 prohíbe: "si el test fallaba, el
// código estaba mal, no el test". La frase es la real del incidente QA que
// originó el mandamiento (demostrativo + verbo copulativo, "Esa es…") — la
// forma que además motivó M10 en primer lugar.
test("Mandamiento 10 · CANÓNICO (repuesto, V11) — 'Esa es tu capacidad real para destinar a ahorro o pago de deudas.' (demostrativo + verbo) se repara con la cifra verificada", async () => {
  const r = await applyEnforcement(
    "Esa es tu capacidad real para destinar a ahorro o pago de deudas.",
    {
      userMessage: "¿cuánto me queda al mes?",
      carril: "FINANCIERO",
      lang: "es",
      missing: [],
      valores: [250],
      conceptos: { sobrante: 250 },
      esSimulacion: false,
    },
  );
  assert.ok(r.texto.includes("250"), `la cifra verificada se reinserta en la frase canónica: ${r.texto}`);
  assert.ok(
    /250\s*€\s+es\s+tu\s+capacidad\s+real/i.test(r.texto),
    `solo el demostrativo se sustituye — el verbo y el resto de la frase sobreviven intactos: ${r.texto}`,
  );
  assert.ok(r.violaciones.some((v) => v.mandamiento === 10));
});

test("Mandamiento 10 · CANÓNICO — variantes de demostrativo+verbo (ES/PT) que antes se escapaban, todas detectadas", async () => {
  const BASE = {
    userMessage: "¿cuánto me queda al mes?",
    carril: "FINANCIERO" as const,
    lang: "es" as const,
    missing: [] as string[],
    valores: [250],
    conceptos: { sobrante: 250 },
    esSimulacion: false,
  };
  const formas = [
    "Ese sería el margen disponible este mes.",
    "Eso te deja margen para maniobrar.",
    "Esa te permite cubrir imprevistos sin apuros.",
    "Esta es la base para tu plan de ahorro.",
    "Esto queda disponible para tu meta.",
  ];
  for (const raw of formas) {
    const r = await applyEnforcement(raw, BASE);
    assert.ok(r.texto.includes("250"), `"${raw}" debe reparar con la cifra verificada, dio: "${r.texto}"`);
  }
});

test("Mandamiento 10 · CANÓNICO — forma PT con verbo acentuado ('é') se detecta (antes '\\b' de ASCII no reconocía 'é' como palabra)", async () => {
  const r = await applyEnforcement("Essa é a tua margem mensal.", {
    userMessage: "quanto me sobra por mês?",
    carril: "FINANCIERO",
    lang: "pt",
    missing: [],
    valores: [250],
    conceptos: { sobrante: 250 },
    esSimulacion: false,
  });
  assert.ok(r.texto.includes("250"), `PT con verbo acentuado debe repararse: ${r.texto}`);
});

test("Mandamiento 10 · OBLIGATORIO 3 — anáfora cuya cifra NO está en conceptos → la frase se ELIMINA (nunca se inventa)", async () => {
  const r = await applyEnforcement("Con ese monto podrás cerrar tu meta antes de lo previsto.", {
    userMessage: "¿cuál es mi situación?",
    carril: "FINANCIERO",
    lang: "es",
    missing: [],
    valores: [],
    conceptos: {},
    esSimulacion: false,
  });
  assert.ok(!/\bese\s+monto\b/i.test(r.texto), "la anáfora sin respaldo no sobrevive");
  assert.ok(!/\d/.test(r.texto), "ninguna cifra inventada se cuela en su lugar");
});

test("Mandamiento 10 · OBLIGATORIO 4 — regresión del Mandamiento 3 CON el pipeline completo: sigue bloqueando el concepto sin cálculo", async () => {
  const r = await applyEnforcement("Tienes un déficit mensual de 9500 €. ¿Confirmamos el plan?", {
    userMessage: "¿tengo déficit?",
    carril: "FINANCIERO",
    lang: "es",
    missing: [],
    valores: [10000, 9500, 500],
    conceptos: { ingreso: 10000, gastos: 9500, sobrante: 500 },
    esSimulacion: false,
  });
  assert.ok(!r.texto.includes("9500") && !r.texto.includes("9.500"), `M3 sigue bloqueando el déficit fantasma: ${r.texto}`);
});

test("Mandamiento 10: sin userMessage no hay nada que comprobar — nunca se activa", () => {
  const texto = "Eso te deja margen.";
  const r = enforceCommandments(texto, ctx({ conceptos: { sobrante: 250 } }));
  assert.equal(r.texto, texto);
  assert.ok(!r.violaciones.some((v) => v.mandamiento === 10));
});

// ── MAYOR 4 (revisión AG01, QA testdev8) — "queda/quedan" NUNCA en el ──────
// grounding de SALIDA (CONCEPT_KEYWORDS); solo en la tabla exclusiva de
// PREGUNTA (conceptosPedidosEnPregunta, guardrail/context.ts).
test("MAYOR 4: 'Te queda un saldo pendiente de 30000 € y te quedan 250 € al mes.' sobrevive intacta (antes se borraba entera)", () => {
  const texto = "Te queda un saldo pendiente de 30000 € y te quedan 250 € al mes.";
  const r = enforceCommandments(
    texto,
    ctx({ conceptos: { ingreso: 2500, gastos: 2250, sobrante: 250, cuota: 881.25, plazo: 48, monto: 30000 } }),
  );
  assert.equal(r.texto, texto, "los 30.000 € son 'monto', un concepto verificado — la frase es correcta");
  assert.deepEqual(r.violaciones, []);
});

test("MAYOR 4: 'queda/quedan' NO está en conceptsInSentence (grounding de salida) pero SÍ en conceptosPedidosEnPregunta (lectura de pregunta)", () => {
  assert.deepEqual(
    conceptsInSentence("Te quedan 250 € al mes."),
    [],
    "el grounding de SALIDA no debe reconocer 'quedan' — rompía frases legítimas de la respuesta",
  );
  assert.deepEqual(conceptosPedidosEnPregunta("¿cuánto me queda al mes?"), ["sobrante"]);
  assert.deepEqual(conceptosPedidosEnPregunta("¿cuánto tengo de gastos?").sort(), ["gastos"]);
  assert.deepEqual(
    cifraPedidaAusente("¿cuánto me queda al mes?", "Tomo nota. Seguimos con tu plan.", { sobrante: 250 }),
    { ausente: true, conceptosPedidos: ["sobrante"] },
  );
  assert.deepEqual(
    cifraPedidaAusente("¿cuánto me queda al mes?", "Te quedan 250 € libres este mes.", { sobrante: 250 }),
    { ausente: false, conceptosPedidos: ["sobrante"] },
  );
});
