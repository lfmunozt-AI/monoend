// Tests del scenario state (el motor recuerda entre turnos).

import { test } from "node:test";
import assert from "node:assert/strict";

import { toolArgsToScenarioDelta } from "./tools";
import {
  extractScenarioDelta,
  mergeScenario,
  registrarPropuestaPendiente,
  esConfirmacionCorta,
  esPropuestaDePlan,
  esRespuestaRepetida,
  esEstructuraRepetida,
  actualizarDigresiones,
  notaRetornoMeta,
  notaSinCifrasDePlan,
  detectarNumerosHuerfanos,
  detectarDiscrepanciaGastos,
  notaExtraccionAmbigua,
  deltaSinGastosPorDiscrepancia,
  renderDatosRecienEntendidos,
  pideRecorte,
  notaFaltaDesglose,
  notaDetalleSinConfirmar,
  detectarEventosICA,
  analizarExtraccion,
  computeExtractionStatus,
  aplicarGuardaDeSanidad,
  detectarCorreccionDeItem,
  numerosCandidatos,
  detectarResolucionConflicto,
  notaConflictoGastos,
  splitScenarioState,
  mergeEstadoPersistido,
  CAMPOS_HECHOS,
  CAMPOS_DIALOGO,
  CAMPOS_TRANSITORIOS,
  itemsGastoActivos,
  contarRepeticionesMensajeUsuario,
  type ScenarioState,
} from "./scenario";
import { buildScenarioContext } from "./orchestrator";

test("merge: TAE 9% real sobre un crédito previo → recalcula tae_es_referencia", () => {
  const prev = mergeScenario(
    { ingreso_mensual: 10000, gastos_mensuales: 9500 },
    extractScenarioDelta("quiero financiar un carro de 30000 a 36 meses"),
  );
  assert.equal(prev.credito?.monto, 30000);
  assert.equal(prev.credito?.plazo_meses, 36);
  assert.equal(prev.credito?.tae_es_referencia, true, "sin TAE aún → referencia");
  assert.ok(prev.missing.includes("tae"), "falta la TAE real");

  const next = mergeScenario(prev, extractScenarioDelta("el banco me ofrece un 9%"));
  assert.equal(next.credito?.tae_pct, 9);
  assert.equal(next.credito?.tae_es_referencia, false, "TAE real → deja de ser referencia");
  assert.equal(next.credito?.monto, 30000, "la TAE nueva NO borra el monto");
  assert.ok(!next.missing.includes("tae"), "ya no falta la TAE");
});

test("merge: cambio de monto sobreescribe (último gana), conserva el resto", () => {
  let s = mergeScenario(undefined, extractScenarioDelta("financiar un carro de 30000 a 36 meses"));
  s = mergeScenario(s, extractScenarioDelta("mejor un coche de 20000 a 36 meses"));
  assert.equal(s.credito?.monto, 20000, "el nuevo monto gana");
  assert.equal(s.credito?.plazo_meses, 36);
});

test("ambiguo → no extrae nada (no corrompe el estado)", () => {
  // FIX V14-3 (11ª tanda) — extraction_status SIEMPRE viene definido en el
  // delta (ley de conservación); estos mensajes no tienen NINGÚN dato
  // financiero real, así que ese es el ÚNICO campo esperado.
  assert.deepEqual(extractScenarioDelta("hola, no sé muy bien qué hacer"), { extraction_status: "COMPLETE" });
  assert.deepEqual(extractScenarioDelta("gracias por la ayuda"), { extraction_status: "COMPLETE" });
  // Un porcentaje SIN contexto de tasa no se toma como TAE — pero SÍ es un
  // número candidato sin destino (huérfano relevante) → PARTIAL, no COMPLETE.
  assert.deepEqual(extractScenarioDelta("me gusta el 20% de las cosas"), { extraction_status: "PARTIAL" });
});

test("missing correcto según el playbook activo", () => {
  const soloCredito = mergeScenario(undefined, extractScenarioDelta("un préstamo de 30000 a 24 meses"));
  assert.ok(soloCredito.missing.includes("tae"));
  assert.ok(soloCredito.missing.includes("ingreso"));
  assert.ok(soloCredito.missing.includes("gastos"));

  const completo = mergeScenario(
    { ingreso_mensual: 3000, gastos_mensuales: 2000 },
    extractScenarioDelta("el tipo de interés es 8%"),
  );
  // Sin monto/plazo del crédito aún: faltan monto y plazo.
  assert.ok(completo.missing.includes("monto"));
  assert.ok(completo.missing.includes("plazo"));
  assert.ok(!completo.missing.includes("ingreso"), "ingreso ya está");
});

test("ES: gano/gasto se extraen como ingreso y gastos", () => {
  const s = mergeScenario(undefined, extractScenarioDelta("gano 3000 al mes"));
  assert.equal(s.ingreso_mensual, 3000);
  const g = mergeScenario(undefined, extractScenarioDelta("gasto 2000 al mes"));
  assert.equal(g.gastos_mensuales, 2000);
});

test("PT: 'juros de 9%' → TAE real", () => {
  const d = extractScenarioDelta("o banco oferece juros de 9%");
  assert.equal(d.credito?.tae_pct, 9);
  assert.equal(d.credito?.tae_es_referencia, false);
});

test("EN: '9% apr' y 'loan of 30000 over 36 months'", () => {
  const rate = extractScenarioDelta("the bank offers 9% apr");
  assert.equal(rate.credito?.tae_pct, 9);

  const loan = extractScenarioDelta("a loan of 30000 over 36 months");
  assert.equal(loan.credito?.monto, 30000);
  assert.equal(loan.credito?.plazo_meses, 36);
});

test("plazo en años → meses ('3 años' = 36)", () => {
  const s = extractScenarioDelta("financiar una casa de 200000 a 3 años");
  assert.equal(s.credito?.plazo_meses, 36);
});

// ── DEFECTO A — extracción anclada al contexto (campos cruzados) ─────────────
test("A: 'gano 2500 y quiero un carro de 30000 a 36 meses' → cada campo el suyo", () => {
  const d = extractScenarioDelta("gano 2500 euros al mes y quiero un carro de 30000 a 36 meses");
  assert.equal(d.ingreso_mensual, 2500, "ingreso anclado a 'gano'");
  assert.equal(d.credito?.monto, 30000, "monto anclado al crédito, NO el primer número");
  assert.equal(d.credito?.plazo_meses, 36);
});

test("A: orden inverso (crédito primero) sigue funcionando", () => {
  const d = extractScenarioDelta("quiero un carro de 30000 a 36 meses y gano 2500");
  assert.equal(d.credito?.monto, 30000);
  assert.equal(d.ingreso_mensual, 2500);
});

test("A: ingreso + gastos + crédito en un mismo mensaje, sin cruzarse", () => {
  const d = extractScenarioDelta("gano 2500 euros al mes y mis gastos son 1500. Quiero financiar un carro de 30000 a 36 meses.");
  assert.equal(d.ingreso_mensual, 2500);
  assert.equal(d.gastos_mensuales, 1500);
  assert.equal(d.credito?.monto, 30000);
  assert.equal(d.credito?.plazo_meses, 36);
});

// ── FIX 2 — respuesta corta de TAE con crédito previo ────────────────────────
test("FIX 2: estado con crédito + '18%' → tae 18 real", () => {
  const prev = { credito: { monto: 30000, plazo_meses: 36, tae_es_referencia: true } };
  const d = extractScenarioDelta("18%", "es", prev);
  assert.equal(d.credito?.tae_pct, 18);
  assert.equal(d.credito?.tae_es_referencia, false);
});

test("FIX 2: SIN crédito previo + '18%' → NO extrae nada", () => {
  // FIX V14-3 (11ª tanda) — extraction_status siempre definido; "18%" sin
  // contexto de crédito es un número candidato sin destino → PARTIAL.
  assert.deepEqual(extractScenarioDelta("18%", "es"), { extraction_status: "PARTIAL" });
  assert.deepEqual(extractScenarioDelta("18%", "es", {}), { extraction_status: "PARTIAL" });
});

test("FIX 2: variantes cortas con crédito previo (es un 9 / 9 por ciento / 9 percent)", () => {
  const prev = { credito: { monto: 30000, plazo_meses: 36, tae_es_referencia: true } };
  assert.equal(extractScenarioDelta("es un 9", "es", prev).credito?.tae_pct, 9);
  assert.equal(extractScenarioDelta("9 por ciento", "es", prev).credito?.tae_pct, 9);
  assert.equal(extractScenarioDelta("9 percent", "en", prev).credito?.tae_pct, 9);
});

test("FIX 2: mensaje con otras señales NO se toma como TAE corta", () => {
  const prev = { credito: { monto: 30000, plazo_meses: 36, tae_es_referencia: true } };
  // "gano 2500" no es 'esencialmente un porcentaje' → no toca la TAE.
  assert.equal(extractScenarioDelta("gano 2500", "es", prev).credito?.tae_pct, undefined);
});

// ── DEFECTO B — una lista de gastos NUNCA la pisa el primer ítem suelto ──────
// ACTUALIZADO (12ª tanda, §6): la 6ª tanda hacía que el detalle pisara SIEMPRE
// al agregado, sin mirar la magnitud del salto. El contrato ahora exige
// materialidad — 2372 (agregado) vs. 645 (detalle: 15+80+30+120+400) es un
// salto del 72,8%, muy por encima del 5% elegible para conflicto: es "fallo
// de comprensión" (§6), no una corrección legítima del mismo dato, así que la
// captura de gastos se REINICIA en vez de que el detalle pise ciegamente.
test("B (12ª tanda): agregado 2372 en T1; lista MUY distinta en T2 → >5% reinicia captura, NUNCA el primer ítem (15)", () => {
  const s = mergeScenario({}, extractScenarioDelta("Gano 2636 euros al mes y mis gastos son 2372."));
  assert.equal(s.gastos_mensuales, 2372);
  const s2 = mergeScenario(s, extractScenarioDelta("Mis gastos: netflix 15, luz 80, agua 30, cerveza 120, mercado 400"));
  assert.notEqual(s2.gastos_mensuales, 15, "la lista NO se toma como si el primer ítem fuera el agregado");
  assert.notEqual(s2.gastos_mensuales, 2372, "tampoco se queda pegado al agregado obsoleto");
  assert.equal(s2.gastos_mensuales, undefined, "salto >5% (§6) → fallo de comprensión, se reinicia la captura");
  assert.equal(s2.gastos_conflict, undefined, "un salto >5% no es CONFLICT elegible, es reinicio directo");
});

// ── BUG 1 (6ª tanda) — el detalle manda SIEMPRE sobre el agregado ───────────
// ACTUALIZADO (12ª tanda, §6): aquel fix asumía que CUALQUIER desglose nuevo
// debía pisar el agregado, sin mirar la magnitud del salto. Con materialidad
// (§6), 10000 (agregado) vs. 11000 (detalle) es un salto del 10% — por encima
// del 5% elegible para CONFLICT — así que ya no "pisa silenciosamente": se
// trata como fallo de comprensión y la captura se reinicia (ninguna de las
// dos cifras queda como verdad hasta que el usuario aporte un dato limpio).
test("BUG 1 (12ª tanda): caso real QA — agregado 10000 vs. detalle 11000 (10% > 5%) → reinicia, no pisa en silencio", () => {
  let s = mergeScenario({}, extractScenarioDelta("Gano 10000 euros al mes y mis gastos son 10000."));
  assert.equal(s.gastos_mensuales, 10000);
  s = mergeScenario(
    s,
    extractScenarioDelta("vitales: alquiler 2000, seguro 1000, comida 2000. no vitales: ocio 3000, ropa 1000, gimnasio 2000"),
  );
  assert.equal(s.gastos_mensuales, undefined, "10% > 5% (§6): fallo de comprensión, se reinicia la captura");
  assert.equal(s.gastos_detalle, undefined, "el detalle tampoco queda como verdad silenciosa");
});

test("BUG 1: un solo ítem NO genera detalle (extractScenarioDelta ya lo exige) → no pisa el agregado", () => {
  let s = mergeScenario({}, extractScenarioDelta("Gano 3000 euros al mes y mis gastos son 2000."));
  s = mergeScenario(s, extractScenarioDelta("Netflix 15"));
  assert.equal(s.gastos_mensuales, 2000, "un ítem suelto no es una lista (<2) — el agregado queda intacto");
  assert.equal(s.gastos_detalle, undefined);
});

test("BUG 1: agregado sin detalle nunca se toca por defecto", () => {
  const s = mergeScenario({}, extractScenarioDelta("Gano 3000 euros al mes y mis gastos son 1800."));
  assert.equal(s.gastos_mensuales, 1800);
  assert.equal(s.gastos_detalle, undefined);
});

// ── BUG 3 — la meta se deriva del crédito ─────────────────────────────────────
test("BUG 3: crédito de carro sin meta → meta derivada (título, monto, plazo), missing SIN meta", () => {
  const s = mergeScenario(
    { ingreso_mensual: 10000, gastos_mensuales: 9500 },
    extractScenarioDelta("Quiero financiar un carro de 30000 a 36 meses."),
  );
  assert.equal(s.meta?.titulo, "Carro");
  assert.equal(s.meta?.monto, 30000);
  assert.equal(s.meta?.plazo_meses, 36);
  assert.equal(s.meta_derivada, true);
  assert.ok(!s.missing.includes("meta_monto"), "la meta derivada ya tiene monto");
  assert.ok(!s.missing.includes("plazo") || s.credito?.plazo_meses === 36, "el plazo ya lo trae el crédito");
});

// ACTUALIZADO (follow-up, tono/jerga interna QA testdev10) — "compra
// financiada" era el título genérico que se filtraba tal cual a la salida
// del modelo ("Tu meta activa es una compra financiada"). Ya no se inventa
// un título de relleno: sin objeto reconocible, `titulo` queda SIN VALOR
// (el monto/plazo siguen ahí; el modelo nombra la meta con su propia voz).
test("BUG 3: sin objeto reconocible en el mensaje → SIN título de relleno (nunca 'compra financiada')", () => {
  const s = mergeScenario(undefined, extractScenarioDelta("Quiero financiar 30000 a 36 meses."));
  assert.equal(s.meta?.titulo, undefined);
  assert.equal(s.meta?.monto, 30000);
});

test("BUG 3: meta EXPLÍCITA del usuario nunca se pisa por la derivada del crédito", () => {
  let s = mergeScenario(undefined, extractScenarioDelta("Mi meta es juntar 50000 en 48 meses."));
  assert.equal(s.meta?.monto, 50000);
  assert.equal(s.meta_derivada, false);

  s = mergeScenario(s, extractScenarioDelta("Quiero financiar un carro de 30000 a 36 meses."));
  assert.equal(s.meta?.monto, 50000, "la meta explícita del usuario sigue mandando, no la del crédito");
  assert.equal(s.meta?.plazo_meses, 48);
  assert.ok(!s.meta_derivada, "nunca se marca como derivada tras una meta explícita");
});

test("BUG 3: meta derivada se actualiza si el crédito cambia de monto (sigue siendo derivada)", () => {
  let s = mergeScenario(undefined, extractScenarioDelta("Quiero financiar un carro de 30000 a 36 meses."));
  assert.equal(s.meta?.monto, 30000);
  s = mergeScenario(s, extractScenarioDelta("Mejor un carro de 20000 a 36 meses."));
  assert.equal(s.meta?.monto, 20000, "la meta derivada sigue el crédito mientras nadie la fije a mano");
  assert.equal(s.meta_derivada, true);
});

// ── Persistencia — un campo nunca se borra por ausencia en un turno posterior ─
test("persistencia: crédito con monto+plazo; turno posterior sin mencionarlos → se conservan", () => {
  let s = mergeScenario(undefined, extractScenarioDelta("Quiero financiar un carro de 30000 a 36 meses."));
  s = mergeScenario(s, extractScenarioDelta("El banco me ofrece 9%"));
  assert.equal(s.credito?.monto, 30000, "el monto no se borra porque el turno nuevo no lo menciona");
  assert.equal(s.credito?.plazo_meses, 36);
  assert.equal(s.credito?.objeto, "carro", "el objeto persiste igual, aunque el turno de la TAE no lo mencione");
});

test("persistencia: ingreso fijado en T1 sobrevive intacto varios turnos sin mencionarlo", () => {
  let s = mergeScenario(undefined, extractScenarioDelta("Gano 3000 euros al mes."));
  s = mergeScenario(s, extractScenarioDelta("Mi meta es juntar 12000 en 24 meses."));
  s = mergeScenario(s, extractScenarioDelta("¿Cuánto es mi capacidad de ahorro anual?"));
  assert.equal(s.ingreso_mensual, 3000, "ningún turno posterior lo tocó ni lo borró");
});

// ── FIX C — PB7 ejecución tras confirmación (bug real: 5 turnos idénticos) ───

test("esPropuestaDePlan: '¿quieres que te proyecte el plan?' → true", () => {
  assert.equal(esPropuestaDePlan("Con esto cuadra el número. ¿Quieres que te proyecte el plan?"), true);
});

test("esPropuestaDePlan: '¿Confirmamos ese plan?' → true; pregunta de DATO → false", () => {
  assert.equal(esPropuestaDePlan("Tu sobrante es de 500 €. ¿Confirmamos ese plan?"), true);
  assert.equal(esPropuestaDePlan("¿Cuál es tu ingreso neto mensual?"), false, "pedir un dato no es proponer un plan");
});

test("registrarPropuestaPendiente: cierre de propuesta → queda pendiente, plan_confirmado se apaga", () => {
  const s = mergeScenario(undefined, { ingreso_mensual: 3000, gastos_mensuales: 2000 });
  const conPropuesta = registrarPropuestaPendiente(s, "Tu sobrante es de 1000 €. ¿Quieres que te proyecte el plan?");
  assert.ok(conPropuesta.propuesta_pendiente, "queda registrada la propuesta");
  assert.equal(conPropuesta.propuesta_pendiente?.tipo, "general");
  assert.equal(conPropuesta.plan_confirmado, false);
});

test("registrarPropuestaPendiente: cierre que NO propone plan → escenario intacto", () => {
  const s = mergeScenario(undefined, { ingreso_mensual: 3000 });
  const out = registrarPropuestaPendiente(s, "¿Cuáles son tus gastos mensuales?");
  assert.equal(out, s, "sin propuesta, no se toca el escenario");
});

test("esConfirmacionCorta: 'sí'/'ok'/'dale'/'arrancamos'/'sim'/'yes' → true; frase larga → false", () => {
  for (const msg of ["sí", "Sí!", "ok", "vale", "dale", "arrancamos", "sim", "yes", "yep"]) {
    assert.equal(esConfirmacionCorta(msg), true, `"${msg}" debía ser confirmación corta`);
  }
  assert.equal(esConfirmacionCorta("sí, pero antes dime cuánto es la cuota"), false, "no es una confirmación pura");
});

test("FIX C: confirmación tras propuesta pendiente → plan_confirmado=true, pendiente se limpia", () => {
  let s = mergeScenario(undefined, { ingreso_mensual: 2500, gastos_mensuales: 1500 });
  s = registrarPropuestaPendiente(s, "Tu sobrante es de 1000 €. ¿Quieres que te proyecte el plan?");
  assert.ok(s.propuesta_pendiente);

  s = mergeScenario(s, extractScenarioDelta("sí", "es", s));
  assert.equal(s.plan_confirmado, true, "PB7 debe ejecutar, no re-diagnosticar");
  assert.equal(s.propuesta_pendiente, undefined, "la pendiente se limpia al confirmarse");
});

test("FIX C: 'sí' SIN propuesta pendiente → no marca nada", () => {
  const s = mergeScenario(undefined, { ingreso_mensual: 2500, gastos_mensuales: 1500 });
  assert.equal(s.propuesta_pendiente, undefined);

  const s2 = mergeScenario(s, extractScenarioDelta("sí", "es", s));
  assert.equal(s2.plan_confirmado, undefined, "sin propuesta pendiente, un 'sí' suelto no dispara nada");
});

test("FIX C: una propuesta NUEVA siempre exige una confirmación NUEVA", () => {
  let s = mergeScenario(undefined, { ingreso_mensual: 2500, gastos_mensuales: 1500 });
  s = registrarPropuestaPendiente(s, "¿Confirmamos ese plan?");
  s = mergeScenario(s, extractScenarioDelta("sí", "es", s));
  assert.equal(s.plan_confirmado, true);

  // El siguiente turno propone un plan DISTINTO (p. ej. el sprint del primer
  // hito): plan_confirmado se apaga hasta la nueva confirmación.
  s = registrarPropuestaPendiente(s, "Arrancamos. Primer hito: recortar 100 € en 30 días. ¿Registramos?");
  assert.equal(s.plan_confirmado, false);
  assert.ok(s.propuesta_pendiente);
});

// ── FIX C — anti-repetición (bug real: 5 turnos con la misma respuesta) ──────
test("esRespuestaRepetida: texto casi idéntico (≥90%) → true", () => {
  const anterior = "Con tus datos, ¿quieres que te proyecte el plan completo?";
  const actual = "Con tus datos, ¿quieres que te proyecte el plan completo?";
  assert.equal(esRespuestaRepetida(actual, anterior), true);
});

test("esRespuestaRepetida: texto claramente distinto → false", () => {
  const anterior = "Con tus datos, ¿quieres que te proyecte el plan completo?";
  const actual = "Arrancamos. Primer hito: recorta 100 € en ocio antes del día 30. ¿Registramos el acuerdo?";
  assert.equal(esRespuestaRepetida(actual, anterior), false);
});

test("esRespuestaRepetida: sin respuesta anterior → false (nada que comparar)", () => {
  assert.equal(esRespuestaRepetida("Cualquier cosa.", undefined), false);
});

// ── esEstructuraRepetida (MAYOR, tono, QA testdev10) — caso real: la misma
// construcción de apertura 4 veces con cifras distintas cada vez.
test("esEstructuraRepetida: misma apertura, cifras distintas → true (esRespuestaRepetida NO lo cazaría)", () => {
  const anterior = "Reducir a la mitad el ocio liberaría 75 €, dejando una capacidad de 375 €.";
  const actual = "Reducir a la mitad el transporte liberaría 40 €, dejando una capacidad de 290 €.";
  assert.equal(esRespuestaRepetida(actual, anterior), false, "texto crudo, con cifras distintas, cae bajo el 90%");
  assert.equal(esEstructuraRepetida(actual, anterior), true, "misma construcción de apertura, normalizando dígitos");
});

test("esEstructuraRepetida: aperturas distintas → false", () => {
  const anterior = "Reducir a la mitad el ocio liberaría 75 €, dejando una capacidad de 375 €.";
  const actual = "Con tu ritmo actual, la meta se atrasa 3 meses — no es motivo para abandonarla.";
  assert.equal(esEstructuraRepetida(actual, anterior), false);
});

test("esEstructuraRepetida: sin respuesta anterior → false", () => {
  assert.equal(esEstructuraRepetida("Cualquier cosa.", undefined), false);
});

// ── PIEZA 6 — META ACTIVA ÚNICA CON TRANSICIÓN EXPLÍCITA ─────────────────────
//
// Diseño de Luis: la meta activa es UNA. Se cierra al confirmar el plan; se
// modifica o elimina SOLO si el usuario lo pide explícitamente; ningún mensaje
// ambiguo puede sobrescribirla; al abrir otra, la anterior se ARCHIVA.

/** Estado con una meta EXPLÍCITA del usuario (no derivada de un crédito). */
function conMetaActiva() {
  return mergeScenario(
    { ingreso_mensual: 2300, gastos_mensuales: 1750 },
    { meta: { titulo: "Carro", monto: 30000, plazo_meses: 48 } },
  );
}

test("PIEZA 6: confirmar el plan CIERRA la meta y la archiva", () => {
  const activa = conMetaActiva();
  const conPropuesta = registrarPropuestaPendiente(activa, "¿Confirmamos el plan?");
  const cerrada = mergeScenario(conPropuesta, extractScenarioDelta("sí", "es", conPropuesta));

  assert.equal(cerrada.plan_confirmado, true);
  assert.equal(cerrada.meta_cerrada, true, "la meta queda cerrada");
  assert.equal(cerrada.goals_cerradas?.length, 1, "y archivada");
  assert.equal(cerrada.goals_cerradas?.[0].titulo, "Carro");
});

test("PIEZA 6: mención AMBIGUA de otro objetivo NO cambia la meta activa", () => {
  const activa = conMetaActiva();
  const delta = extractScenarioDelta("también me gustaría una meta de 200000 algún día");
  const despues = mergeScenario(activa, delta);

  assert.equal(despues.meta?.titulo, "Carro", "la meta activa sobrevive");
  assert.equal(despues.meta?.monto, 30000, "PROHIBIDO que un mensaje ambiguo pise el monto");
  assert.equal(despues.meta?.plazo_meses, 48);
  assert.equal(despues.goals_cerradas, undefined, "no se archiva nada");
});

test("PIEZA 6: la mención ambigua sí COMPLETA un hueco de la meta activa", () => {
  const parcial = mergeScenario({}, { meta: { titulo: "Piso" } });
  const despues = mergeScenario(parcial, extractScenarioDelta("mi meta son 200000 en 120 meses"));

  assert.equal(despues.meta?.titulo, "Piso", "el título no se pierde");
  assert.equal(despues.meta?.monto, 200000, "el hueco se rellena");
  assert.equal(despues.meta?.plazo_meses, 120);
});

test("PIEZA 6: petición EXPLÍCITA ('olvida el carro') archiva y limpia la meta", () => {
  const activa = conMetaActiva();
  const delta = extractScenarioDelta("olvida el carro");
  assert.equal(delta.meta_cambio_explicito, true, "la señal viaja en el delta");

  const despues = mergeScenario(activa, delta);
  assert.equal(despues.meta, undefined, "la meta activa se retira");
  assert.equal(despues.goals_cerradas?.[0].titulo, "Carro", "pero se archiva, nunca se borra");
  assert.equal(despues.meta_cambio_explicito, undefined, "la señal no se persiste");
});

test("PIEZA 6: 'ahora quiero una casa de 200000 en 120 meses' sí cambia la meta", () => {
  const activa = conMetaActiva();
  const despues = mergeScenario(
    activa,
    extractScenarioDelta("ahora quiero una casa, mi meta son 200000 en 120 meses"),
  );

  assert.equal(despues.meta?.monto, 200000, "la meta nueva manda");
  assert.equal(despues.meta?.plazo_meses, 120);
  assert.equal(despues.goals_cerradas?.[0].monto, 30000, "la anterior queda archivada");
});

test("PIEZA 6: con la meta CERRADA, una meta nueva puede abrirse sin petición explícita", () => {
  const activa = conMetaActiva();
  const conPropuesta = registrarPropuestaPendiente(activa, "¿Confirmamos el plan?");
  const cerrada = mergeScenario(conPropuesta, extractScenarioDelta("sí", "es", conPropuesta));

  const nueva = mergeScenario(cerrada, { meta: { titulo: "Piso", monto: 200000, plazo_meses: 120 } });
  assert.equal(nueva.meta?.titulo, "Piso");
  assert.equal(nueva.meta_cerrada, false, "la meta nueva nace abierta");
  assert.equal(nueva.goals_cerradas?.length, 1, "la anterior sigue archivada una sola vez");
});

// ── PIEZA 7 — DIGRESIÓN CON RETORNO ──────────────────────────────────────────

test("PIEZA 7: un turno META con meta activa suma digresión; FINANCIERO la reinicia", () => {
  const activa = conMetaActiva();
  let n = actualizarDigresiones(activa, "META");
  assert.equal(n, 1);
  n = actualizarDigresiones({ ...activa, digresiones_seguidas: n }, "META");
  assert.equal(n, 2);
  n = actualizarDigresiones({ ...activa, digresiones_seguidas: n }, "FINANCIERO");
  assert.equal(n, 0, "cualquier turno financiero reinicia el contador");
});

test("PIEZA 7: sin meta activa no se cuentan digresiones", () => {
  assert.equal(actualizarDigresiones({ missing: [] }, "META"), 0);
});

test("PIEZA 7: MIXTO deja el contador como estaba (el usuario sigue aportando datos)", () => {
  const activa = { ...conMetaActiva(), digresiones_seguidas: 2 };
  assert.equal(actualizarDigresiones(activa, "MIXTO"), 2);
});

test("PIEZA 7: la nota de reconducción aparece al 3.º turno fuera, no antes", () => {
  const activa = conMetaActiva();
  assert.equal(notaRetornoMeta({ ...activa, digresiones_seguidas: 2 }), null);

  const nota = notaRetornoMeta({ ...activa, digresiones_seguidas: 3 });
  assert.ok(nota, "al tercero se reconduce");
  // ACTUALIZADO (follow-up, tono/jerga interna QA testdev10) — el aviso ya
  // no usa la frase "meta activa" (prohibida en la salida, ver
  // consigliere.ts); el título de la meta va solo, sin la etiqueta.
  assert.match(nota!, /3 turnos fuera de 'Carro'/);
  assert.match(nota!, /reconduce con naturalidad/);
});

test("PIEZA 7: con la meta cerrada no hay nada a lo que reconducir", () => {
  const cerrada = { ...conMetaActiva(), meta_cerrada: true, digresiones_seguidas: 5 };
  assert.equal(notaRetornoMeta(cerrada), null);
});

test("PIEZA 7 · CASO B: una digresión sin señal financiera cuenta aunque el carril sea FINANCIERO por continuidad", () => {
  // "¿qué temperatura hace?" no trae cifra ni keyword financiera: classifyTurn
  // lo manda a FINANCIERO por CONTINUIDAD del escenario, pero el usuario está
  // fuera de la meta. Sin mirar el mensaje, el contador se reiniciaría siempre.
  const activa = conMetaActiva();
  const n = actualizarDigresiones(activa, "FINANCIERO", "¿qué temperatura hace?");
  assert.equal(n, 1);

  const vuelta = actualizarDigresiones(
    { ...activa, digresiones_seguidas: n },
    "FINANCIERO",
    "mis gastos ahora son 1800",
  );
  assert.equal(vuelta, 0, "un turno con contenido financiero real sí reinicia");
});

// ── FIX 2b (4ª tanda) — AUTO-CHEQUEO DETERMINISTA ─────────────────────────────

test("FIX 2b: sin missing → sin nota", () => {
  const s = mergeScenario({}, extractScenarioDelta("quiero financiar un carro de 30000 a 36 meses"));
  // tiene crédito pero le falta la TAE — missing NO está vacío en este caso,
  // así que probamos aparte con un estado sin nada faltante.
  const completo = { ...s, missing: [], credito: { ...s.credito!, tae_pct: 9, tae_es_referencia: false } };
  assert.equal(notaSinCifrasDePlan(completo), null);
});

test("FIX 2b: missing no vacío pero SIN crédito ni meta → sin nota (nada que frenar)", () => {
  assert.equal(notaSinCifrasDePlan({ missing: ["ingreso"] }), null);
});

test("FIX 2b: crédito activo + falta la TAE → nota de refuerzo con el campo correcto", () => {
  const s = mergeScenario({}, extractScenarioDelta("quiero financiar un carro de 30000 a 36 meses"));
  const nota = notaSinCifrasDePlan(s);
  assert.ok(nota, `debería haber nota: ${JSON.stringify(s)}`);
  assert.match(nota!, /NO propongas cifras de plan/);
  assert.match(nota!, /TAE real/);
  assert.match(nota!, /Pídelo con calidez/);
});

test("FIX 2b: meta activa sin monto → nota pide el campo que falta", () => {
  const s = mergeScenario({}, { meta: { titulo: "Piso" } });
  const nota = notaSinCifrasDePlan(s);
  assert.ok(nota);
  assert.match(nota!, /monto de la meta/);
});

test("FIX 2b: undefined → sin nota (compatibilidad)", () => {
  assert.equal(notaSinCifrasDePlan(undefined), null);
});

// ── PIEZA 1/2/3 (5ª tanda) — CIERRE DE LA CLASE DE EXTRACCIÓN ─────────────────
// CASO REAL (testdev4, 31/07 09:19): "gano 2300 y gasto= 1000 arriendo 500
// servicios 250 carro 100 ropa" se extrajo como gastos=1000 (el primer número
// tras "gasto"). Real: gastos 1850 (la suma del desglose). Los 5 escenarios
// requeridos por el protocolo de entrega, más un caso limpio de control.

test("escenario 1 · mensaje real: sin huérfanos, gastos = 1850 (suma del desglose)", () => {
  const msg = "peinso que mi ahorro es una desastre, gano 2300 y gasto= 1000 arriendo 500 servicios 250 carro 100 ropa";
  const delta = extractScenarioDelta(msg);
  const huerfanos = detectarNumerosHuerfanos(msg, delta);
  const discrepancia = detectarDiscrepanciaGastos(delta);
  assert.equal(huerfanos.extraccionIncompleta, false, `no debería haber huérfanos: ${JSON.stringify(huerfanos)}`);
  assert.equal(discrepancia.discrepancia, false);
  assert.equal(delta.ingreso_mensual, 2300);
  const s = mergeScenario({}, delta);
  assert.equal(s.gastos_mensuales, 1850, "1000 arriendo + 500 servicios + 250 carro + 100 ropa");
});

test("escenario 2 · '1000 arriendo 500 servicios 250 carro 100 ropa' (sin 'gano') → mismo comportamiento", () => {
  const msg = "1000 arriendo 500 servicios 250 carro 100 ropa";
  const delta = extractScenarioDelta(msg);
  const huerfanos = detectarNumerosHuerfanos(msg, delta);
  assert.equal(huerfanos.extraccionIncompleta, false, `no debería haber huérfanos: ${JSON.stringify(huerfanos)}`);
  const s = mergeScenario({}, delta);
  assert.equal(s.gastos_mensuales, 1850);
});

test("escenario 3 · 'gasto 1000: 500 arriendo 250 carro 100 ropa' → discrepancia (850 ≠ 1000)", () => {
  const msg = "gasto 1000: 500 arriendo 250 carro 100 ropa";
  const delta = extractScenarioDelta(msg);
  const discrepancia = detectarDiscrepanciaGastos(delta);
  assert.equal(discrepancia.discrepancia, true, `debería reconciliar mal: ${JSON.stringify(delta)}`);
  assert.equal(discrepancia.agregado, 1000);
  assert.equal(discrepancia.suma, 850);
  const nota = notaExtraccionAmbigua(detectarNumerosHuerfanos(msg, delta), discrepancia);
  assert.match(nota!, /DISCREPANCIA ARITMÉTICA/);
  assert.match(nota!, /1000/);
  assert.match(nota!, /850/);
});

test("escenario 4 · 'gano entre 2000 y 2500' → huérfano (rango, no asigna)", () => {
  const msg = "gano entre 2000 y 2500";
  const delta = extractScenarioDelta(msg);
  const huerfanos = detectarNumerosHuerfanos(msg, delta);
  assert.equal(huerfanos.extraccionIncompleta, true, `debería quedar ambiguo: ${JSON.stringify({ delta, huerfanos })}`);
  const nota = notaExtraccionAmbigua(huerfanos, detectarDiscrepanciaGastos(delta));
  assert.match(nota!, /NÚMEROS SIN ASIGNAR/);
});

test("escenario 5 · 'gano 27600 al año' → no asume mensual (huérfano, no 27600 como ingreso mensual)", () => {
  const msg = "gano 27600 al año";
  const delta = extractScenarioDelta(msg);
  assert.notEqual(delta.ingreso_mensual, 27600, "27600 NO debe asignarse tal cual como ingreso mensual");
  const huerfanos = detectarNumerosHuerfanos(msg, delta);
  assert.equal(huerfanos.extraccionIncompleta, true, `27600 debe quedar huérfano si no se asignó: ${JSON.stringify({ delta, huerfanos })}`);
});

test("escenario 5b · una extracción que SÍ normaliza explícitamente 27600/año a 2300/mes no se marca huérfana", () => {
  // Vía tool-call (LLM): el delta ya trae el valor MENSUAL normalizado.
  const delta = { ingreso_mensual: 2300 };
  const huerfanos = detectarNumerosHuerfanos("gano 27600 al año", delta);
  assert.equal(huerfanos.extraccionIncompleta, false, "la conversión año→mes con tolerancia debe reconocer 27600/12 ≈ 2300");
});

test("escenario 6 · 'gano 2300 y gasto 1850' → limpio, sin huérfanos, calcula normal", () => {
  const msg = "gano 2300 y gasto 1850";
  const delta = extractScenarioDelta(msg);
  const huerfanos = detectarNumerosHuerfanos(msg, delta);
  const discrepancia = detectarDiscrepanciaGastos(delta);
  assert.equal(huerfanos.extraccionIncompleta, false);
  assert.equal(discrepancia.discrepancia, false);
  assert.equal(delta.ingreso_mensual, 2300);
  assert.equal(delta.gastos_mensuales, 1850);
  assert.equal(notaExtraccionAmbigua(huerfanos, discrepancia), null);
});

test("detectarNumerosHuerfanos: '3 hijos' no cuenta el 3 como huérfano (sustantivo no monetario)", () => {
  const msg = "tengo 3 hijos y gano 2000";
  const delta = extractScenarioDelta(msg);
  const huerfanos = detectarNumerosHuerfanos(msg, delta);
  assert.equal(huerfanos.extraccionIncompleta, false, `3 no debería contar: ${JSON.stringify(huerfanos)}`);
});

test("detectarDiscrepanciaGastos: sin agregado+detalle simultáneos → sin discrepancia", () => {
  assert.deepEqual(detectarDiscrepanciaGastos({}), { discrepancia: false });
  assert.deepEqual(
    detectarDiscrepanciaGastos({ gastos_mensuales: 1000 }),
    { discrepancia: false },
  );
});

test("deltaSinGastosPorDiscrepancia: SIN discrepancia → no-op, devuelve el delta intacto", () => {
  const delta = {
    ingreso_mensual: 2300,
    gastos_mensuales: 1850,
    credito: { monto: 30000, plazo_meses: 36, tae_es_referencia: true },
    meta: { titulo: "carro" },
  };
  const out = deltaSinGastosPorDiscrepancia(delta, { discrepancia: false });
  assert.deepEqual(out, delta);
});

test("deltaSinGastosPorDiscrepancia: CON discrepancia → despoja SOLO los 3 campos de gastos, conserva el resto", () => {
  const delta = {
    ingreso_mensual: 2300,
    gastos_mensuales: 1000,
    gastos_detalle: { vitales: 500, noVitales: 300, desconocidos: 200 },
    gastos_es_detalle: true,
    credito: { monto: 30000, plazo_meses: 36, tae_es_referencia: true },
    meta: { titulo: "carro" },
    meta_cambio_explicito: true,
  };
  const sinGastos = deltaSinGastosPorDiscrepancia(delta, { discrepancia: true, agregado: 1000, suma: 1000 });
  assert.equal(sinGastos.gastos_mensuales, undefined);
  assert.equal(sinGastos.gastos_detalle, undefined);
  assert.equal(sinGastos.gastos_es_detalle, undefined);
  // TODO lo demás sobrevive — a diferencia de la vieja deltaSeguro (bug testdev5).
  assert.equal(sinGastos.ingreso_mensual, 2300);
  assert.deepEqual(sinGastos.credito, delta.credito);
  assert.deepEqual(sinGastos.meta, delta.meta);
  assert.equal(sinGastos.meta_cambio_explicito, true);
});

// ── PIEZA 1 (6ª tanda) — BUG BLOQUEANTE testdev5: huérfanos NUNCA descartan ──
// El mensaje real traía ingreso y gastos limpios MÁS un par de cifras de una
// meta sin decidir (candidatas de precio de casa). La versión anterior
// (deltaSeguro) descartaba TODO el delta ante cualquier huérfano — ingreso y
// gastos se perdían para siempre. Ahora los huérfanos son solo una pregunta;
// lo demás se persiste con normalidad.

test("testdev5 · ingreso y gastos limpios (extraídos por extractScenarioDelta) sobreviven a huérfanos de una meta sin decidir", () => {
  // "gano 2300 y gasto 2000 al mes" es el fragmento REAL que fija ingreso y
  // gastos (extraído por el mismo extractScenarioDelta que usa producción);
  // los huérfanos (200000/300000/150000, candidatas de precio de una casa que
  // el usuario aún no decide) se simulan aparte para no depender de la
  // fragilidad del parser de listas de gastos ante números sueltos sin
  // contexto — eso es harina de otro costal, no de esta pieza.
  const fragmentoLimpio = "gano 2300 y gasto 2000 al mes";
  const delta = extractScenarioDelta(fragmentoLimpio);
  assert.equal(delta.ingreso_mensual, 2300, "el ingreso se extrae con confianza");
  assert.equal(delta.gastos_mensuales, 2000, "los gastos se extraen con confianza");

  const msgConHuerfanos = fragmentoLimpio + ". Para la casa todavía dudo entre 200000, 300000 y 150000.";
  const huerfanos = detectarNumerosHuerfanos(msgConHuerfanos, delta);
  const discrepancia = detectarDiscrepanciaGastos(delta);
  assert.ok(huerfanos.extraccionIncompleta, "las cifras de la casa sin decidir SÍ deben quedar huérfanas");
  assert.deepEqual(huerfanos.numerosHuerfanos.sort((a, b) => a - b), [150000, 200000, 300000]);

  const deltaAPersistir = deltaSinGastosPorDiscrepancia(delta, discrepancia);
  const s = mergeScenario({}, deltaAPersistir);
  assert.equal(s.ingreso_mensual, 2300, "BUG testdev5: el ingreso NO debe perderse por los huérfanos");
  assert.equal(s.gastos_mensuales, 2000, "BUG testdev5: los gastos NO deben perderse por los huérfanos");
  assert.ok(!s.missing.includes("ingreso"));
  assert.ok(!s.missing.includes("gastos"));
});

test("rango a nivel de CAMPO: 'gano entre 2000 y 2500' no asigna ninguno de los dos (baja confianza)", () => {
  const msg = "gano entre 2000 y 2500";
  const delta = extractScenarioDelta(msg);
  assert.equal(delta.ingreso_mensual, undefined, "un rango no es una cifra: ningún valor se asigna a ciegas");
  const huerfanos = detectarNumerosHuerfanos(msg, delta);
  assert.deepEqual(huerfanos.numerosHuerfanos.sort((a, b) => a - b), [2000, 2500]);
});

// ── PIEZA 5 (6ª tanda) — INVARIANTE: ingreso/gastos conocidos NUNCA en missing ─

test("invariante: con ingreso_mensual y gastos_mensuales presentes, 'ingreso'/'gastos' nunca están en missing", () => {
  const s = mergeScenario({}, { ingreso_mensual: 2300, gastos_mensuales: 2000 });
  assert.ok(!s.missing.includes("ingreso"));
  assert.ok(!s.missing.includes("gastos"));
});

// ── PIEZA 7 (6ª tanda) — AGREGADO BASTA PARA CALCULAR, DETALLE PARA RECORTAR ──

test("tiene_agregado_gastos / tiene_detalle_gastos: solo agregado", () => {
  const s = mergeScenario({}, { gastos_mensuales: 2000 });
  assert.equal(s.tiene_agregado_gastos, true);
  assert.equal(s.tiene_detalle_gastos, false);
});

test("tiene_agregado_gastos / tiene_detalle_gastos: agregado + detalle (lista desglosada)", () => {
  const s = mergeScenario({}, extractScenarioDelta("netflix 15, luz 80, agua 30"));
  assert.equal(s.tiene_agregado_gastos, true, "el detalle SIEMPRE recalcula el agregado (BUG 1)");
  assert.equal(s.tiene_detalle_gastos, true);
});

test("pideRecorte: detecta la petición de un plan de recorte (ES/PT/EN)", () => {
  assert.equal(pideRecorte("¿qué puedo recortar?"), true);
  assert.equal(pideRecorte("quiero reducir mis gastos"), true);
  assert.equal(pideRecorte("onde posso cortar despesas?"), true);
  assert.equal(pideRecorte("where can I cut expenses?"), true);
  assert.equal(pideRecorte("¿cuánto puedo ahorrar al año?"), false);
});

test("notaFaltaDesglose: agregado sin detalle + petición de recorte → pide el desglose citando el total", () => {
  const s = mergeScenario({}, { gastos_mensuales: 2000 });
  const nota = notaFaltaDesglose(s, "¿qué puedo recortar?");
  assert.ok(nota);
  assert.match(nota!, /2000/);
  assert.match(nota!, /PROHIBIDO volver a preguntar/);
  assert.match(nota!, /DESGLOSE/);
});

test("notaFaltaDesglose: sin petición de recorte → null (no se fuerza la pregunta)", () => {
  const s = mergeScenario({}, { gastos_mensuales: 2000 });
  assert.equal(notaFaltaDesglose(s, "¿cuánto puedo ahorrar al año?"), null);
});

test("notaFaltaDesglose: ya hay detalle → null (nada que pedir)", () => {
  const s = mergeScenario({}, extractScenarioDelta("netflix 15, luz 80, agua 30"));
  assert.equal(notaFaltaDesglose(s, "¿qué puedo recortar?"), null);
});

test("notaFaltaDesglose: sin agregado siquiera → null (lo cubre el missing genérico de 'gastos')", () => {
  assert.equal(notaFaltaDesglose(mergeScenario({}, {}), "¿qué puedo recortar?"), null);
});

test("renderDatosRecienEntendidos: null si el delta no trae nada", () => {
  assert.equal(renderDatosRecienEntendidos({}, "hola"), null);
});

test("renderDatosRecienEntendidos: caso real → ingreso, gastos y desglose", () => {
  const msg = "peinso que mi ahorro es una desastre, gano 2300 y gasto= 1000 arriendo 500 servicios 250 carro 100 ropa";
  const delta = extractScenarioDelta(msg);
  const nota = renderDatosRecienEntendidos(delta, msg);
  assert.ok(nota);
  assert.match(nota!, /ingreso mensual: 2300/);
  assert.match(nota!, /gastos mensuales: 1850/);
  assert.match(nota!, /arriendo 1000/);
  assert.match(nota!, /DATOS RECIÉN ENTENDIDOS/);
});

// ── PIEZA 4 (6ª tanda) — EL ICA MIDE CONOCIMIENTO, NO CHARLA ─────────────────

test("detectarEventosICA: turno sin datos nuevos → []", () => {
  const s = mergeScenario({}, { ingreso_mensual: 2300 });
  assert.deepEqual(detectarEventosICA(s, mergeScenario(s, {})), []);
});

test("detectarEventosICA: primer ingreso y gastos → dato_ingreso + dato_gastos", () => {
  const antes = mergeScenario({}, {});
  const despues = mergeScenario(antes, { ingreso_mensual: 2300, gastos_mensuales: 2000 });
  const eventos = detectarEventosICA(antes, despues);
  assert.ok(eventos.includes("dato_ingreso"));
  assert.ok(eventos.includes("dato_gastos"));
});

test("detectarEventosICA: repetir el MISMO ingreso en un turno posterior → NO vuelve a disparar dato_ingreso", () => {
  const antes = mergeScenario({}, { ingreso_mensual: 2300 });
  const despues = mergeScenario(antes, { ingreso_mensual: 2300 });
  assert.ok(!detectarEventosICA(antes, despues).includes("dato_ingreso"));
});

test("detectarEventosICA: cambiar el ingreso (ya conocido → otro valor) NO cuenta como dato nuevo", () => {
  const antes = mergeScenario({}, { ingreso_mensual: 2300 });
  const despues = mergeScenario(antes, { ingreso_mensual: 2500 });
  assert.ok(!detectarEventosICA(antes, despues).includes("dato_ingreso"), "actualizar no es 'aprender por primera vez'");
});

// ACTUALIZADO (12ª tanda, §6): el desglose original (netflix 15, luz 80, agua
// 30 = 125) se alejaba un 93,75% del agregado previo (2000) — con
// materialidad eso ya no es "detalle nuevo", es un reinicio de captura (§6),
// así que `tiene_detalle_gastos` nunca llegaba a ser true y el evento no
// disparaba. Se ajusta el desglose para que COINCIDA con el agregado (dentro
// de la tolerancia de redondeo ≤1€, banda CONSISTENT de §6) — el caso que
// este test quiere cubrir es la promoción a "detalle_gastos", no la
// materialidad en sí (que tiene su propia cobertura en los casos 1-8 del
// contrato).
test("detectarEventosICA: desglose nuevo → detalle_gastos", () => {
  const antes = mergeScenario({}, { gastos_mensuales: 2000 });
  const despues = mergeScenario(antes, extractScenarioDelta("netflix 1000, luz 1000"));
  assert.ok(detectarEventosICA(antes, despues).includes("detalle_gastos"));
});

test("detectarEventosICA: meta derivada de un crédito NO cuenta como meta_declarada", () => {
  const antes = mergeScenario({}, {});
  const despues = mergeScenario(antes, extractScenarioDelta("quiero financiar un carro de 30000 a 36 meses"));
  assert.ok(despues.meta_derivada, "precondición: la meta quedó derivada");
  assert.ok(!detectarEventosICA(antes, despues).includes("meta_declarada"));
  assert.ok(detectarEventosICA(antes, despues).includes("credito_declarado"));
  assert.ok(detectarEventosICA(antes, despues).includes("plazo_declarado"));
});

test("detectarEventosICA: meta declarada explícitamente por el usuario → meta_declarada", () => {
  const antes = mergeScenario({}, {});
  const despues = mergeScenario(antes, { meta: { titulo: "casa", monto: 150000 } });
  assert.ok(detectarEventosICA(antes, despues).includes("meta_declarada"));
});

test("detectarEventosICA: TAE real nueva (antes de referencia) → tae_declarada", () => {
  const antes = mergeScenario({}, extractScenarioDelta("quiero financiar un carro de 30000 a 36 meses"));
  const despues = mergeScenario(antes, extractScenarioDelta("el banco me ofrece un 9%"));
  assert.ok(detectarEventosICA(antes, despues).includes("tae_declarada"));
});

test("detectarEventosICA: antes undefined (primer turno de la conversación) no rompe", () => {
  const despues = mergeScenario({}, { ingreso_mensual: 2300 });
  assert.deepEqual(detectarEventosICA(undefined, despues), ["dato_ingreso"]);
});

// ── PIEZA 1 (8ª tanda, testdev7) — EXTRACTION_STATUS: casos de aceptación ────
// "Antes de decir que el usuario se contradijo, el sistema debe preguntarse
// si lo leyó bien." Estos son los 9 casos obligatorios del encargo, a nivel
// del pipeline completo (extractScenarioDelta → analizarExtraccion). Los
// casos puramente de parseo de listas (9, 10, 13, 14, 15, 16) también tienen
// cobertura directa en expenses.test.ts.

test("caso 9 (pipeline): 'Telecomunicaciones_Necesario 60 100 Pañales_Bebe_Vital' → AMBIGUOUS", () => {
  const msg = "Telecomunicaciones_Necesario 60 100 Pañales_Bebe_Vital";
  const delta = extractScenarioDelta(msg);
  const analisis = analizarExtraccion(msg, delta);
  assert.equal(analisis.extraction_status, "AMBIGUOUS");
  assert.ok(analisis.itemSospechoso, "debe exponer el ítem sospechoso de pegado");
  assert.equal(analisis.discrepancia.discrepancia, false, "AMBIGUOUS por pegado, no por discrepancia aritmética");
});

test("caso 10 (regresión): 'gasto 2 500 €' → 2500, COMPLETE (miles con espacio, no romper)", () => {
  const msg = "gasto 2 500 €";
  const delta = extractScenarioDelta(msg);
  assert.equal(delta.gastos_mensuales, 2500);
  const analisis = analizarExtraccion(msg, delta);
  assert.equal(analisis.extraction_status, "COMPLETE");
});

test("caso 11: 'gano 2300, tengo 43 años, 2 hijos, gasto 2200' → COMPLETE, NO pregunta por 43 ni 2", () => {
  const msg = "gano 2300, tengo 43 años, 2 hijos, gasto 2200";
  const delta = extractScenarioDelta(msg);
  assert.equal(delta.ingreso_mensual, 2300);
  assert.equal(delta.gastos_mensuales, 2200);
  const analisis = analizarExtraccion(msg, delta);
  assert.equal(analisis.extraction_status, "COMPLETE", `no debería preguntar por la edad ni los hijos: ${JSON.stringify(analisis)}`);
  assert.deepEqual(analisis.huerfanos.numerosHuerfanos, []);
  assert.deepEqual(analisis.huerfanos.numerosNoRelevantes.sort((a, b) => a - b), [2, 43], "43 (edad) y 2 (hijos) se CLASIFICAN, no se ignoran en silencio");
});

test("caso 12: 'gano 2300 y gasto 2200 y 450' → PARTIAL, usa 2300 y 2200, pregunta por 450", () => {
  const msg = "gano 2300 y gasto 2200 y 450";
  const delta = extractScenarioDelta(msg);
  assert.equal(delta.ingreso_mensual, 2300, "el ingreso se usa con confianza (V1)");
  assert.equal(delta.gastos_mensuales, 2200, "el gasto se usa con confianza (V1)");
  const analisis = analizarExtraccion(msg, delta);
  assert.equal(analisis.extraction_status, "PARTIAL");
  assert.deepEqual(analisis.huerfanos.numerosHuerfanos, [450]);
});

// Caso 16 a nivel de escenario completo: el mensaje real produce gastos_items
// con las 15 partidas y buckets coherentes tras el merge (no solo el parser
// aislado — ver expenses.test.ts para esa capa).
const MENSAJE_REAL_TESTDEV7_SCENARIO =
  "Diezmo_Vital 225, 700 Casa_Vital Supermercado_Vital 450, 120 Servicios_Vitales, " +
  "Telecomunicaciones_Necesario 60 100 Pañales_Bebe_Vital, Colegio_Niño_Necesario 150 " +
  "Transporte_Necesario 100, 80 Ropa_Posible, Ocio_Familiar 60 40 Farmacia_Vital, " +
  "Suscripciones_Ocio 25 40 Gimnasio_Necesario, 60 Ahorro_Posible Gastos_Varios_Posible 40";

test("caso 16 (pipeline): mensaje real testdev7 → scenario.gastos_items 15 entradas, turno 1, suma 2250", () => {
  const delta = extractScenarioDelta(MENSAJE_REAL_TESTDEV7_SCENARIO);
  assert.equal(delta.gastos_es_detalle, true);
  const s = mergeScenario(undefined, delta);
  assert.equal(s.gastos_items?.length, 15, `esperaba 15 items: ${JSON.stringify(s.gastos_items)}`);
  assert.ok(s.gastos_items?.every((i) => i.turn === 1), "primer turno de la conversación → turn 1 en todos los items");
  assert.equal(s.gastos_items?.reduce((a, i) => a + i.amount, 0), 2250);
  assert.equal(s.gastos_mensuales, 2250, "el agregado se deriva de la suma del desglose (BUG 1, invariante ya vigente)");
});

test("caso 17 (regresión): crédito con monto y SIN plazo → plazo_meses queda MISSING, nunca 0", () => {
  // extractScenarioDelta (fallback regex) solo captura crédito cuando monto Y
  // plazo llegan JUNTOS en el mismo mensaje — un monto sin plazo llega por la
  // tool del LLM (toolArgsToScenarioDelta), que sí soporta campos parciales.
  const s = mergeScenario(undefined, toolArgsToScenarioDelta({ credito_monto: 30000 }));
  assert.equal(s.credito?.monto, 30000, "el monto sobrevive el guardarraíl");
  assert.equal(s.credito?.plazo_meses, undefined, "el plazo NUNCA es 0 — queda MISSING");
  assert.ok(s.missing.includes("plazo"), "se pregunta por el plazo explícitamente");
});

test("computeExtractionStatus: prioridad INVALID > AMBIGUOUS > PARTIAL > COMPLETE", () => {
  const limpio = { huerfanos: { extraccionIncompleta: false, numerosHuerfanos: [], numerosNoRelevantes: [] }, discrepancia: { discrepancia: false }, itemSospechoso: null, camposInvalidos: [] };
  assert.equal(computeExtractionStatus(limpio), "COMPLETE");
  assert.equal(computeExtractionStatus({ ...limpio, huerfanos: { ...limpio.huerfanos, extraccionIncompleta: true, numerosHuerfanos: [450] } }), "PARTIAL");
  assert.equal(computeExtractionStatus({ ...limpio, discrepancia: { discrepancia: true, agregado: 1000, suma: 850 } }), "AMBIGUOUS");
  assert.equal(computeExtractionStatus({ ...limpio, itemSospechoso: { name: "x", amount: 60100, sugerencia: "?" } }), "AMBIGUOUS");
  assert.equal(computeExtractionStatus({ ...limpio, camposInvalidos: ["ingreso_mensual"] }), "INVALID");
});

// ── PIEZA 6 (8ª tanda) — FACT_STATUS: el eco como promotor de confianza ──────

test("factStatus: dato recién extraído → PARSED (no CONFIRMED todavía)", () => {
  const s = mergeScenario(undefined, { ingreso_mensual: 2300 });
  assert.equal(s.factStatus?.ingreso_mensual, "PARSED");
  assert.deepEqual(s.eco_pendiente?.fields, ["ingreso_mensual"]);
});

test("factStatus: el usuario NO corrige el turno siguiente → PARSED sube a CONFIRMED", () => {
  const t1 = mergeScenario(undefined, { ingreso_mensual: 2300 });
  assert.equal(t1.factStatus?.ingreso_mensual, "PARSED");
  // Turno 2: el usuario aporta OTRO dato (gastos) — no toca el ingreso, no lo corrige.
  const t2 = mergeScenario(t1, { gastos_mensuales: 1500 });
  assert.equal(t2.factStatus?.ingreso_mensual, "CONFIRMED", "el eco lo enunció en T1 y no se corrigió en T2 → CONFIRMED");
  assert.equal(t2.factStatus?.gastos_mensuales, "PARSED", "gastos es la extracción NUEVA de este turno");
});

test("factStatus: el usuario SÍ corrige con un valor distinto → vuelve a PARSED, no se queda CONFIRMED a ciegas", () => {
  const t1 = mergeScenario(undefined, { ingreso_mensual: 2300 });
  const t2 = mergeScenario(t1, {}); // nada nuevo → promueve a CONFIRMED
  assert.equal(t2.factStatus?.ingreso_mensual, "CONFIRMED");
  const t3 = mergeScenario(t2, { ingreso_mensual: 2500 }); // corrección real
  assert.equal(t3.factStatus?.ingreso_mensual, "PARSED", "un valor NUEVO y distinto reabre la confianza");
  assert.equal(t3.ingreso_mensual, 2500);
});

test("factStatus: reafirmar EXACTAMENTE el mismo valor ya CONFIRMED se queda CONFIRMED", () => {
  const t1 = mergeScenario(undefined, { ingreso_mensual: 2300 });
  const t2 = mergeScenario(t1, {}); // promueve a CONFIRMED
  assert.equal(t2.factStatus?.ingreso_mensual, "CONFIRMED");
  const t3 = mergeScenario(t2, { ingreso_mensual: 2300 }); // el usuario repite el mismo dato
  assert.equal(t3.factStatus?.ingreso_mensual, "CONFIRMED", "repetir lo ya confirmado no es una corrección");
});

test("factStatus: campo nunca visto → ausente (MISSING implícito, no aparece en el mapa)", () => {
  const s = mergeScenario(undefined, { ingreso_mensual: 2300 });
  assert.equal(s.factStatus?.gastos_mensuales, undefined);
});

// ── FIX 1/2/3 (9ª tanda) — PRECEDENCIA DECLARATIVO > LISTA ───────────────────
// Regresión bloqueante real: el parser de listas secuestraba números que ya
// pertenecían a campos declarados. V1 (nunca se descarta un dato con
// confianza), V12 (el ingreso nunca es gasto), V13 (un número no puede
// pertenecer a dos campos) — los 6 tests obligatorios del encargo.

test("TEST OBLIGATORIO 1: 'gano 2300 y gasto aproximadamente 2000 entre vivienda, comida, servicios, ocio'", () => {
  const msg = "gano 2300 y gasto aproximadamente 2000 entre vivienda, comida, servicios, ocio";
  const delta = extractScenarioDelta(msg);
  assert.equal(delta.ingreso_mensual, 2300);
  assert.equal(delta.gastos_mensuales, 2000, `V1: el dato declarativo debe persistir: ${JSON.stringify(delta)}`);
  assert.ok(!delta.gastos_items || delta.gastos_items.length === 0, `gastos_items debe estar VACÍO: ${JSON.stringify(delta.gastos_items)}`);
  assert.ok(
    !delta.gastos_items?.some((i) => i.name.toLowerCase().includes("aproximadamente")),
    "ningún ítem debe llamarse 'aproximadamente'",
  );
  assert.ok(!delta.gastos_items?.some((i) => i.amount === 2300), "V12: el ingreso (2300) NUNCA como gasto");
});

test("TEST OBLIGATORIO 2: mensaje completo del e2e con 'dudo entre 200000, 300000 o 150000'", () => {
  const msg =
    "gano 2300 y gasto aproximadamente 2000 entre vivienda, comida, servicios, ocio, y ademas estoy " +
    "pensando en comprar una casa, dudo entre 200000, 300000 o 150000";
  const delta = extractScenarioDelta(msg);
  assert.equal(delta.ingreso_mensual, 2300);
  assert.equal(delta.gastos_mensuales, 2000);
  assert.ok(!delta.gastos_items || delta.gastos_items.length === 0, "sin ítems inventados de la casa");
  const huerfanos = detectarNumerosHuerfanos(msg, delta);
  assert.ok(huerfanos.extraccionIncompleta, "PARTIAL: los montos de la casa deben quedar como huérfanos");
  assert.deepEqual(huerfanos.numerosHuerfanos.sort((a, b) => a - b), [150000, 200000, 300000]);
});

test("TEST OBLIGATORIO 3 (regresión): 'gano 2300 y gasto 2200' → 2300/2200, sin ítems", () => {
  const delta = extractScenarioDelta("gano 2300 y gasto 2200");
  assert.equal(delta.ingreso_mensual, 2300);
  assert.equal(delta.gastos_mensuales, 2200);
  assert.ok(!delta.gastos_items || delta.gastos_items.length === 0);
});

test("TEST OBLIGATORIO 4 (regresión): 'arriendo 700, comida 450, luz 120' → 3 ítems", () => {
  const delta = extractScenarioDelta("arriendo 700, comida 450, luz 120");
  assert.equal(delta.gastos_items?.length, 3);
  assert.equal(delta.gastos_es_detalle, true);
});

test("TEST OBLIGATORIO 5 (regresión, no romper caso 16): 15 partidas testdev7 → 15 ítems, suma 2250", () => {
  const real =
    "Diezmo_Vital 225, 700 Casa_Vital Supermercado_Vital 450, 120 Servicios_Vitales, " +
    "Telecomunicaciones_Necesario 60 100 Pañales_Bebe_Vital, Colegio_Niño_Necesario 150 " +
    "Transporte_Necesario 100, 80 Ropa_Posible, Ocio_Familiar 60 40 Farmacia_Vital, " +
    "Suscripciones_Ocio 25 40 Gimnasio_Necesario, 60 Ahorro_Posible Gastos_Varios_Posible 40";
  const delta = extractScenarioDelta(real);
  assert.equal(delta.gastos_items?.length, 15);
  assert.equal(delta.gastos_items?.reduce((a, i) => a + i.amount, 0), 2250);
});

test("TEST OBLIGATORIO 6: 'gano 2500, gasto 1800: arriendo 900, comida 500, luz 400' → agregado Y detalle coexisten", () => {
  const delta = extractScenarioDelta("gano 2500, gasto 1800: arriendo 900, comida 500, luz 400");
  assert.equal(delta.ingreso_mensual, 2500);
  assert.equal(delta.gastos_mensuales, 1800);
  assert.equal(delta.gastos_items?.length, 3);
  assert.equal(delta.gastos_items?.reduce((a, i) => a + i.amount, 0), 1800);
});

// ── FIX 4 (9ª tanda) — GUARDA DE SANIDAD ─────────────────────────────────────

test("aplicarGuardaDeSanidad: V12 — un ítem con el mismo importe que el ingreso descarta el detalle entero", () => {
  const delta = {
    ingreso_mensual: 2300,
    gastos_mensuales: 4300,
    gastos_es_detalle: true,
    gastos_detalle: { vitales: 2000, noVitales: 0, desconocidos: 2300 },
    gastos_items: [
      { name: "aproximadamente", amount: 2300, category: "desconocido" as const, source: "regex" as const, turn: 0 },
      { name: "vivienda", amount: 2000, category: "vital" as const, source: "regex" as const, turn: 0 },
    ],
  };
  const limpio = aplicarGuardaDeSanidad(delta);
  assert.equal(limpio.gastos_items, undefined);
  assert.equal(limpio.gastos_detalle, undefined);
  assert.equal(limpio.gastos_es_detalle, undefined);
  assert.equal(limpio.ingreso_mensual, 2300, "V1: el ingreso NUNCA se toca");
});

test("aplicarGuardaDeSanidad: magnitud absurda (suma > 3× ingreso) descarta el detalle", () => {
  const delta = {
    ingreso_mensual: 1000,
    gastos_es_detalle: true,
    gastos_items: [
      { name: "a", amount: 2000, category: "desconocido" as const, source: "regex" as const, turn: 0 },
      { name: "b", amount: 2000, category: "desconocido" as const, source: "regex" as const, turn: 0 },
    ],
  };
  const limpio = aplicarGuardaDeSanidad(delta);
  assert.equal(limpio.gastos_items, undefined);
});

test("aplicarGuardaDeSanidad: detalle normal (sin duplicar ingreso, magnitud razonable) sobrevive intacto", () => {
  const delta = {
    ingreso_mensual: 2300,
    gastos_es_detalle: true,
    gastos_items: [
      { name: "arriendo", amount: 700, category: "vital" as const, source: "regex" as const, turn: 0 },
      { name: "comida", amount: 450, category: "vital" as const, source: "regex" as const, turn: 0 },
    ],
  };
  const limpio = aplicarGuardaDeSanidad(delta);
  assert.equal(limpio.gastos_items?.length, 2);
});

// ── FIX 5 (9ª tanda) — DETALLE_CONFIRMADO ────────────────────────────────────

test("FIX 5 — T1 desglose de 3 partidas → detalle_confirmado false, pendiente de eco", () => {
  const t1 = mergeScenario(undefined, extractScenarioDelta("arriendo 700, comida 450, luz 120"));
  assert.equal(t1.detalle_confirmado, false);
  assert.ok(t1.eco_pendiente?.fields.includes("gastos_detalle"));
});

test("FIX 5 — T2 'sí, correcto' → detalle_confirmado true, ya puede proponer recortes", () => {
  const t1 = mergeScenario(undefined, extractScenarioDelta("arriendo 700, comida 450, luz 120"));
  const t2 = mergeScenario(t1, extractScenarioDelta("sí, correcto", "es", t1));
  assert.equal(t2.detalle_confirmado, true);
});

test("FIX 5 — T2 'la luz son 150' → corrección aplicada, el resto conservado, y confirma el desglose", () => {
  const t1 = mergeScenario(undefined, extractScenarioDelta("arriendo 700, comida 450, luz 120"));
  const t2 = mergeScenario(t1, extractScenarioDelta("la luz son 150", "es", t1));
  assert.equal(t2.detalle_confirmado, true);
  const luz = t2.gastos_items?.find((i) => i.name === "luz");
  assert.equal(luz?.amount, 150);
  assert.equal(t2.gastos_items?.find((i) => i.name === "arriendo")?.amount, 700, "arriendo se conserva");
  assert.equal(t2.gastos_items?.find((i) => i.name === "comida")?.amount, 450, "comida se conserva");
  assert.equal(t2.gastos_mensuales, 1300, "700 + 450 + 150");
});

test("FIX 5 — T2 sin corregir ni confirmar explícitamente → promoción automática (eco no corregido)", () => {
  const t1 = mergeScenario(undefined, extractScenarioDelta("arriendo 700, comida 450, luz 120"));
  const t2 = mergeScenario(t1, extractScenarioDelta("gracias, lo reviso luego", "es", t1));
  assert.equal(t2.detalle_confirmado, true);
});

test("detectarCorreccionDeItem: no dispara si el nombre no coincide con ningún ítem previo", () => {
  const items = [{ name: "arriendo", amount: 700, category: "vital" as const, source: "regex" as const, turn: 1 }];
  assert.equal(detectarCorreccionDeItem("el gimnasio son 40", items), null);
});

test("notaDetalleSinConfirmar: bloquea recorte por partida sin confirmar, no bloquea con confirmación", () => {
  const t1 = mergeScenario(undefined, extractScenarioDelta("arriendo 700, comida 450, luz 120"));
  const notaSinConfirmar = notaDetalleSinConfirmar(t1, "¿qué puedo recortar?");
  assert.ok(notaSinConfirmar, "debe pedir confirmación antes de proponer recortes");
  assert.match(notaSinConfirmar!, /confirm/i);

  const t2 = mergeScenario(t1, extractScenarioDelta("sí, correcto", "es", t1));
  assert.equal(notaDetalleSinConfirmar(t2, "¿qué puedo recortar?"), null, "ya confirmado, no bloquea");
});

test("notaDetalleSinConfirmar: null si no se pide recorte (sobrante/capacidad siguen sin bloqueo)", () => {
  const t1 = mergeScenario(undefined, extractScenarioDelta("arriendo 700, comida 450, luz 120"));
  assert.equal(notaDetalleSinConfirmar(t1, "¿cuánto me queda al mes?"), null);
});

// ── FIX V13 (10ª tanda) — TOKEN RECLAMADO = FRONTERA, NUNCA SE ELIMINA ───────
// Regresión bloqueante real: eliminar el token reclamado del array fusionaba
// los fragmentos de nombre vecinos ("gano"+"y pago arriendo" se validaban
// JUNTOS y NO_ES_GASTO los rechazaba enteros, perdiendo la partida). El
// disparador exacto: un ítem de gasto comparte SEGMENTO DE COMA con la
// palabra de ingreso (con punto ya funcionaba, porque el punto ya separa en
// segmentos distintos).

test("TEST OBLIGATORIO V13-1: 'gano 700 y pago arriendo 650, comida 200, luz 50' → ingreso 700, gastos 900, DÉFICIT", () => {
  const delta = extractScenarioDelta("gano 700 y pago arriendo 650, comida 200, luz 50");
  assert.equal(delta.ingreso_mensual, 700);
  // gastos_mensuales se DERIVA en el merge (suma del detalle — BUG 1, el
  // detalle manda), no viaja directo en el delta cuando es una lista.
  const s = mergeScenario(undefined, delta);
  assert.equal(s.gastos_mensuales, 900, `V1: el arriendo (650) no debe perderse: ${JSON.stringify(delta)}`);
  const sobrante = (s.ingreso_mensual ?? 0) - (s.gastos_mensuales ?? 0);
  assert.equal(sobrante, -200, "DÉFICIT, nunca superávit");
  assert.ok(delta.gastos_items?.some((i) => i.amount === 650 && i.name.toLowerCase().includes("arriendo")), "la partida de 650 (arriendo) no puede perderse");
  assert.ok(delta.gastos_items?.some((i) => i.amount === 200), "comida (200) presente");
  assert.ok(delta.gastos_items?.some((i) => i.amount === 50), "luz (50) presente");
  assert.ok(!delta.gastos_items?.some((i) => i.amount === 700), "V12: el ingreso (700) nunca como ítem de gasto");
});

test("TEST OBLIGATORIO V13-2: 'mi sueldo es 2500 y el arriendo 800, comida 300, luz 90' → ingreso 2500, gastos 1190, sobrante +1310", () => {
  const delta = extractScenarioDelta("mi sueldo es 2500 y el arriendo 800, comida 300, luz 90");
  assert.equal(delta.ingreso_mensual, 2500);
  const s = mergeScenario(undefined, delta);
  assert.equal(s.gastos_mensuales, 1190, `800 + 300 + 90: ${JSON.stringify(delta)}`);
  assert.equal((s.ingreso_mensual ?? 0) - (s.gastos_mensuales ?? 0), 1310);
  assert.ok(delta.gastos_items?.some((i) => i.amount === 800 && i.name.toLowerCase().includes("arriendo")));
  assert.ok(!delta.gastos_items?.some((i) => i.amount === 2500), "V12: el ingreso (2500) nunca como ítem de gasto");
});

test("TEST OBLIGATORIO V13-3 (control, ya funcionaba): 'gano 700. pago arriendo 650, comida 200, luz 50' → idéntico", () => {
  const delta = extractScenarioDelta("gano 700. pago arriendo 650, comida 200, luz 50");
  assert.equal(delta.ingreso_mensual, 700);
  const s = mergeScenario(undefined, delta);
  assert.equal(s.gastos_mensuales, 900);
  assert.equal(delta.gastos_items?.length, 3);
  assert.equal(delta.gastos_items?.find((i) => i.name.includes("arriendo"))?.amount, 650);
});

test("TEST OBLIGATORIO V13-4 (no-destructividad de spans, permutación distinta): 'gano 1500 y pago comida 300, luz 80, agua 40'", () => {
  // Mismo patrón estructural que V13-1/V13-2 (ingreso + lista en el MISMO
  // segmento de coma) con nombres/montos distintos — prueba que el mecanismo
  // generaliza y no es un parche memorizado sobre esas cadenas exactas.
  const delta = extractScenarioDelta("gano 1500 y pago comida 300, luz 80, agua 40");
  assert.equal(delta.ingreso_mensual, 1500);
  assert.equal(delta.gastos_items?.length, 3, `ninguna partida debe fusionarse/perderse: ${JSON.stringify(delta.gastos_items)}`);
  const s = mergeScenario(undefined, delta);
  assert.equal(s.gastos_mensuales, 420, "300 + 80 + 40 — ninguna partida perdida ni el ingreso colado como gasto");
  assert.ok(delta.gastos_items?.some((i) => i.amount === 300 && i.name.toLowerCase().includes("comida")));
  assert.ok(delta.gastos_items?.some((i) => i.amount === 80 && i.name === "luz"), "luz no debe fusionarse con nada del fragmento anterior");
  assert.ok(delta.gastos_items?.some((i) => i.amount === 40 && i.name === "agua"));
});

test("TEST OBLIGATORIO V13-5 (regresión V12): ningún ítem con el mismo importe que el ingreso, en ninguno de los casos de esta tanda", () => {
  for (const msg of [
    "gano 700 y pago arriendo 650, comida 200, luz 50",
    "mi sueldo es 2500 y el arriendo 800, comida 300, luz 90",
    "gano 1500 y pago comida 300, luz 80, agua 40",
  ]) {
    const delta = extractScenarioDelta(msg);
    assert.ok(
      !delta.gastos_items?.some((i) => i.amount === delta.ingreso_mensual),
      `V12 violado en "${msg}": ${JSON.stringify(delta)}`,
    );
  }
});

test("TEST OBLIGATORIO V13-6 (regresión, los 6 mensajes obligatorios de la tanda anterior siguen verdes)", () => {
  const d1 = extractScenarioDelta("gano 2300 y gasto aproximadamente 2000 entre vivienda, comida, servicios, ocio");
  assert.equal(d1.ingreso_mensual, 2300);
  assert.equal(d1.gastos_mensuales, 2000);
  assert.ok(!d1.gastos_items || d1.gastos_items.length === 0);

  const d3 = extractScenarioDelta("gano 2300 y gasto 2200");
  assert.equal(d3.ingreso_mensual, 2300);
  assert.equal(d3.gastos_mensuales, 2200);

  const d4 = extractScenarioDelta("arriendo 700, comida 450, luz 120");
  assert.equal(d4.gastos_items?.length, 3);

  const real =
    "Diezmo_Vital 225, 700 Casa_Vital Supermercado_Vital 450, 120 Servicios_Vitales, " +
    "Telecomunicaciones_Necesario 60 100 Pañales_Bebe_Vital, Colegio_Niño_Necesario 150 " +
    "Transporte_Necesario 100, 80 Ropa_Posible, Ocio_Familiar 60 40 Farmacia_Vital, " +
    "Suscripciones_Ocio 25 40 Gimnasio_Necesario, 60 Ahorro_Posible Gastos_Varios_Posible 40";
  const d5 = extractScenarioDelta(real);
  assert.equal(d5.gastos_items?.length, 15);
  assert.equal(d5.gastos_items?.reduce((a, i) => a + i.amount, 0), 2250);

  const d6 = extractScenarioDelta("gano 2500, gasto 1800: arriendo 900, comida 500, luz 400");
  assert.equal(d6.ingreso_mensual, 2500);
  assert.equal(d6.gastos_mensuales, 1800);
  assert.equal(d6.gastos_items?.length, 3);
});

// ── FIX V14 (11ª tanda) — FRONTERAS POSICIONALES + LEY DE CONSERVACIÓN ───────
// Tercer rechazo sobre esta pieza: el conjunto de fronteras de la 10ª tanda
// guardaba STRINGS, no posiciones — una palabra-frontera se volvía una regla
// GLOBAL que destruía cualquier partida homónima del mensaje ("casa" del
// crédito destruía también "casa 700", una partida de gasto sin relación).

/**
 * TEST DE CONSERVACIÓN (V14, estructural) — para un mensaje y su delta,
 * verifica INDEPENDIENTEMENTE (sin pasar por `valoresAsignadosEnDelta`) que
 * todo número candidato del mensaje aparece en ALGÚN campo del delta o en la
 * lista de huérfanos. Caza la CLASE de bug (un número que desaparece sin
 * dejar rastro), no solo los dos casos concretos de este encargo.
 */
function todosLosCandidatosTienenDestino(message: string, delta: Partial<ScenarioState>): { ok: boolean; sinDestino: number[] } {
  const candidatos = numerosCandidatos(message);
  const huerfanos = detectarNumerosHuerfanos(message, delta).numerosHuerfanos;
  const valoresEnDelta: number[] = [];
  if (delta.ingreso_mensual !== undefined) valoresEnDelta.push(delta.ingreso_mensual);
  if (delta.gastos_mensuales !== undefined) valoresEnDelta.push(delta.gastos_mensuales);
  for (const item of delta.gastos_items ?? []) valoresEnDelta.push(item.amount);
  if (delta.credito?.monto !== undefined) valoresEnDelta.push(delta.credito.monto);
  if (delta.credito?.plazo_meses !== undefined) valoresEnDelta.push(delta.credito.plazo_meses);
  if (delta.credito?.tae_pct !== undefined) valoresEnDelta.push(delta.credito.tae_pct);
  if (delta.meta?.monto !== undefined) valoresEnDelta.push(delta.meta.monto);
  if (delta.meta?.plazo_meses !== undefined) valoresEnDelta.push(delta.meta.plazo_meses);
  const sinDestino = candidatos.filter((v) => !valoresEnDelta.includes(v) && !huerfanos.includes(v));
  return { ok: sinDestino.length === 0, sinDestino };
}

test("TEST OBLIGATORIO V14-1 (bloqueante B1): 'gano 2000 y gasto en arriendo 800, comida 300, luz 100'", () => {
  const msg = "gano 2000 y gasto en arriendo 800, comida 300, luz 100";
  const delta = extractScenarioDelta(msg);
  assert.equal(delta.ingreso_mensual, 2000);
  assert.ok(delta.gastos_items?.some((i) => i.amount === 800 && i.name.toLowerCase().includes("arriendo")), `el arriendo (800) no puede perderse: ${JSON.stringify(delta)}`);
  assert.ok(delta.gastos_items?.some((i) => i.amount === 300));
  assert.ok(delta.gastos_items?.some((i) => i.amount === 100));
  const s = mergeScenario(undefined, delta);
  assert.equal(s.gastos_mensuales, 1200, "800 + 300 + 100");
  assert.equal((s.ingreso_mensual ?? 0) - (s.gastos_mensuales ?? 0), 800, "sobrante +800");
  const conservacion = todosLosCandidatosTienenDestino(msg, delta);
  assert.ok(conservacion.ok, `V14: números sin destino: ${JSON.stringify(conservacion.sinDestino)}`);
});

test("TEST OBLIGATORIO V14-2 (bloqueante B2): 'gano 1500, quiero una casa de 200000 a 240 meses, casa 700, comida 300, luz 90'", () => {
  const msg = "gano 1500, quiero una casa de 200000 a 240 meses, casa 700, comida 300, luz 90";
  const delta = extractScenarioDelta(msg);
  assert.equal(delta.ingreso_mensual, 1500);
  assert.equal(delta.credito?.monto, 200000, "el crédito de la casa sigue intacto");
  assert.equal(delta.credito?.plazo_meses, 240);
  assert.ok(delta.gastos_items?.some((i) => i.amount === 700 && i.name.toLowerCase().includes("casa")), `la partida "casa 700" no puede perderse: ${JSON.stringify(delta)}`);
  assert.ok(delta.gastos_items?.some((i) => i.amount === 300));
  assert.ok(delta.gastos_items?.some((i) => i.amount === 90));
  const s = mergeScenario(undefined, delta);
  assert.equal(s.gastos_mensuales, 1090, "700 + 300 + 90");
  assert.equal((s.ingreso_mensual ?? 0) - (s.gastos_mensuales ?? 0), 410, "sobrante +410");
  const conservacion = todosLosCandidatosTienenDestino(msg, delta);
  assert.ok(conservacion.ok, `V14: números sin destino: ${JSON.stringify(conservacion.sinDestino)}`);
});

test("TEST OBLIGATORIO V14-3 (independencia de orden): 'quiero FINANCIAR una casa...' → resultado IDÉNTICO al V14-2", () => {
  const msgFinanciar = "gano 1500, quiero financiar una casa de 200000 a 240 meses, casa 700, comida 300, luz 90";
  const msgCasa = "gano 1500, quiero una casa de 200000 a 240 meses, casa 700, comida 300, luz 90";
  const deltaFinanciar = extractScenarioDelta(msgFinanciar);
  const deltaCasa = extractScenarioDelta(msgCasa);
  const sFinanciar = mergeScenario(undefined, deltaFinanciar);
  const sCasa = mergeScenario(undefined, deltaCasa);
  assert.equal(sFinanciar.gastos_mensuales, sCasa.gastos_mensuales, "el orden de la palabra de contexto (financiar/casa) no debe cambiar el resultado");
  assert.equal(deltaFinanciar.gastos_items?.length, deltaCasa.gastos_items?.length);
  assert.ok(deltaFinanciar.gastos_items?.some((i) => i.amount === 700 && i.name.toLowerCase().includes("casa")));
  assert.equal(deltaFinanciar.credito?.monto, 200000);
  assert.equal(deltaFinanciar.credito?.plazo_meses, 240);
});

test("TEST OBLIGATORIO V14-6 (ley de conservación, estructural): ningún número desaparece en silencio, en los 5 mensajes V13/V14 ni en los 6 obligatorios anteriores", () => {
  const mensajes = [
    "gano 700 y pago arriendo 650, comida 200, luz 50",
    "mi sueldo es 2500 y el arriendo 800, comida 300, luz 90",
    "gano 2000 y gasto en arriendo 800, comida 300, luz 100",
    "gano 1500, quiero una casa de 200000 a 240 meses, casa 700, comida 300, luz 90",
    "gano 1500, quiero financiar una casa de 200000 a 240 meses, casa 700, comida 300, luz 90",
    "gano 2300 y gasto aproximadamente 2000 entre vivienda, comida, servicios, ocio",
    "gano 2300 y gasto 2200",
    "arriendo 700, comida 450, luz 120",
    "gano 2500, gasto 1800: arriendo 900, comida 500, luz 400",
  ];
  for (const msg of mensajes) {
    const delta = extractScenarioDelta(msg);
    const { ok, sinDestino } = todosLosCandidatosTienenDestino(msg, delta);
    assert.ok(ok, `V14 violado en "${msg}": números sin destino ${JSON.stringify(sinDestino)} — delta: ${JSON.stringify(delta)}`);
    assert.ok(delta.extraction_status !== undefined, `extraction_status debe estar SIEMPRE definido: "${msg}"`);
  }

  // El mensaje real de testdev7 (15 partidas) por separado — no tiene ingreso
  // ni crédito, así que se prueba aparte para no diluir la lista de arriba.
  const real =
    "Diezmo_Vital 225, 700 Casa_Vital Supermercado_Vital 450, 120 Servicios_Vitales, " +
    "Telecomunicaciones_Necesario 60 100 Pañales_Bebe_Vital, Colegio_Niño_Necesario 150 " +
    "Transporte_Necesario 100, 80 Ropa_Posible, Ocio_Familiar 60 40 Farmacia_Vital, " +
    "Suscripciones_Ocio 25 40 Gimnasio_Necesario, 60 Ahorro_Posible Gastos_Varios_Posible 40";
  const deltaReal = extractScenarioDelta(real);
  assert.ok(deltaReal.extraction_status !== undefined);
});

test("TEST OBLIGATORIO V14-7 (regresiones): testdev7 (15/2250) · 'gasto 2 500 €' → 2500 · 'aproximadamente' sin ítems", () => {
  const real =
    "Diezmo_Vital 225, 700 Casa_Vital Supermercado_Vital 450, 120 Servicios_Vitales, " +
    "Telecomunicaciones_Necesario 60 100 Pañales_Bebe_Vital, Colegio_Niño_Necesario 150 " +
    "Transporte_Necesario 100, 80 Ropa_Posible, Ocio_Familiar 60 40 Farmacia_Vital, " +
    "Suscripciones_Ocio 25 40 Gimnasio_Necesario, 60 Ahorro_Posible Gastos_Varios_Posible 40";
  const deltaReal = extractScenarioDelta(real);
  assert.equal(deltaReal.gastos_items?.length, 15);
  assert.equal(deltaReal.gastos_items?.reduce((a, i) => a + i.amount, 0), 2250);

  const delta2500 = extractScenarioDelta("gasto 2 500 €");
  assert.equal(delta2500.gastos_mensuales, 2500);

  const deltaAprox = extractScenarioDelta("gano 2300 y gasto aproximadamente 2000 entre vivienda, comida, servicios, ocio");
  assert.equal(deltaAprox.ingreso_mensual, 2300);
  assert.equal(deltaAprox.gastos_mensuales, 2000);
  assert.ok(!deltaAprox.gastos_items || deltaAprox.gastos_items.length === 0);
});

// ═══════════════════════════════════════════════════════════════════════════
// 12ª TANDA — RECONCILIACIÓN CROSS-TURNO (Gate G1c) — §2/§4/§6/§7/§8, E8
// Los 8 casos de aceptación de docs/CONTRATO_TRUTH_ENGINE.md §10 (sección
// "Reconciliación"), literales, más los casos extra pedidos en la tanda.
// ═══════════════════════════════════════════════════════════════════════════

test("CASO 1 (§10): declarado 2200 · detalle 2200 → CONSISTENT, calcula normal", () => {
  const s = mergeScenario({}, extractScenarioDelta("gasto 2200: 1200 arriendo 1000 comida"));
  assert.equal(s.gastos_mensuales, 2200);
  assert.equal(s.gastos_conflict, undefined, "sin conflicto: la diferencia está dentro de la tolerancia de redondeo");
  assert.equal(s.factStatus?.gastos_mensuales, "PARSED");
});

test("CASO 2 (§10): mismo turno, 2200 + detalle 2250 → CONFLICT +50, sobrante bloqueado", () => {
  const s = mergeScenario({}, extractScenarioDelta("gasto 2200: 1200 arriendo 1050 comida"));
  assert.equal(s.gastos_conflict?.agregado, 2200);
  assert.equal(s.gastos_conflict?.detalle, 2250);
  assert.equal(s.gastos_conflict?.diff, 50);
  assert.equal(s.factStatus?.gastos_mensuales, "CONFLICT");
  // PIEZA 4 (§7) — sobrante bloqueado: buildScenarioContext no expone
  // gastos_mensuales ni sobrante_mensual mientras el conflicto esté activo.
  const ctx = buildScenarioContext({ ...s, ingreso_mensual: 2636 }, "");
  assert.ok(!("gastos" in ctx.conceptos), "gastos_mensuales bloqueado en conceptos");
  assert.ok(!("sobrante" in ctx.conceptos), "sobrante bloqueado en conceptos");
});

test("CASO 3 (§10): 2200 vs detalle 2150 → CONFLICT −50", () => {
  const s = mergeScenario({}, extractScenarioDelta("gasto 2200: 1200 arriendo 950 comida"));
  assert.equal(s.gastos_conflict?.agregado, 2200);
  assert.equal(s.gastos_conflict?.detalle, 2150);
  assert.equal(s.gastos_conflict?.diff, -50);
});

test("CASO 4 (§10): T1 agregado 2200 → T2 detalle 2250 → CONFLICT +50 (caso real de origen)", () => {
  const s1 = mergeScenario({}, extractScenarioDelta("Gano 2636 euros al mes y mis gastos son 2200."));
  assert.equal(s1.gastos_mensuales, 2200);
  assert.equal(s1.gastos_conflict, undefined, "T1 solo: nada con qué compararlo todavía");
  const s2 = mergeScenario(s1, extractScenarioDelta("Mis gastos: arriendo 1200, comida 1050"));
  assert.equal(s2.gastos_conflict?.agregado, 2200);
  assert.equal(s2.gastos_conflict?.detalle, 2250);
  assert.equal(s2.gastos_conflict?.diff, 50);
  assert.equal(s2.factStatus?.gastos_mensuales, "CONFLICT");
});

test("CASO 5 (§10): T1 detalle 2250 → T2 agregado 2200 → CONFLICT +50, IDÉNTICO al caso 4 (bidireccional, Gate G1c)", () => {
  const s1 = mergeScenario({}, extractScenarioDelta("Mis gastos: arriendo 1200, comida 1050"));
  assert.equal(s1.gastos_mensuales, 2250);
  assert.equal(s1.gastos_conflict, undefined, "T1 solo: nada con qué compararlo todavía");
  const s2 = mergeScenario(s1, extractScenarioDelta("Gano 2636 euros al mes y mis gastos son 2200."));
  assert.equal(s2.gastos_conflict?.agregado, 2200);
  assert.equal(s2.gastos_conflict?.detalle, 2250);
  assert.equal(s2.gastos_conflict?.diff, 50);
  // Bidireccionalidad — mismo núcleo (agregado/detalle/diff/diffPct) que el
  // caso 4, con independencia de en qué turno llegó cada fuente.
  const s4b = mergeScenario(
    mergeScenario({}, extractScenarioDelta("Gano 2636 euros al mes y mis gastos son 2200.")),
    extractScenarioDelta("Mis gastos: arriendo 1200, comida 1050"),
  );
  assert.equal(s2.gastos_conflict?.agregado, s4b.gastos_conflict?.agregado);
  assert.equal(s2.gastos_conflict?.detalle, s4b.gastos_conflict?.detalle);
  assert.equal(s2.gastos_conflict?.diff, s4b.gastos_conflict?.diff);
  assert.equal(s2.gastos_conflict?.diffPct, s4b.gastos_conflict?.diffPct);
});

test("CASO 6 (§10): T1 2200 · T2 2250 (CONFLICT) · T3 'eran 2250' → RESOLVED: 2250 CONFIRMED, 2200 SUPERSEDED", () => {
  let s = mergeScenario({}, extractScenarioDelta("Gano 2636 euros al mes y mis gastos son 2200."));
  s = mergeScenario(s, extractScenarioDelta("Mis gastos: arriendo 1200, comida 1050"));
  assert.ok(s.gastos_conflict, "precondición: conflicto activo antes de T3");

  // V6/PIEZA 3 — resolución robusta ("eran 2250" mapea al valor del desglose).
  const resolucion = detectarResolucionConflicto("eran 2250", s.gastos_conflict!);
  assert.deepEqual(resolucion, { tipo: "detalle", valorConfirmado: 2250 });

  s = mergeScenario(s, extractScenarioDelta("eran 2250", "es", s));
  assert.equal(s.gastos_mensuales, 2250, "el ganador es el valor confirmado");
  assert.equal(s.gastos_conflict, undefined, "el conflicto se cierra al resolverse");
  assert.equal(s.factStatus?.gastos_mensuales, "CONFIRMED");
  // V7 — el perdedor se conserva, nunca se borra.
  assert.equal(s.gastos_superseded?.length, 1);
  assert.equal(s.gastos_superseded?.[0].valor, 2200);
  assert.equal(s.gastos_superseded?.[0].motivo, "USER_CORRECTION");
});

test("CASO 7 (§10): T1 2200 · T2 2250 (CONFLICT) · dos peticiones sin resolver → ASSUMED 2250, declarado como supuesto", () => {
  let s = mergeScenario({}, extractScenarioDelta("Gano 2636 euros al mes y mis gastos son 2200."));
  s = mergeScenario(s, extractScenarioDelta("Mis gastos: arriendo 1200, comida 1050"));
  assert.equal(s.gastos_conflict?.attempts, 0);

  s = mergeScenario(s, extractScenarioDelta("no estoy seguro", "es", s));
  assert.ok(s.gastos_conflict, "primer intento sin resolver: el conflicto sigue activo");
  assert.equal(s.gastos_conflict?.attempts, 1);
  assert.equal(s.gastos_assumed, undefined);

  s = mergeScenario(s, extractScenarioDelta("no lo tengo claro todavía", "es", s));
  assert.equal(s.gastos_conflict, undefined, "segundo intento: escapa a ASSUMED");
  assert.equal(s.gastos_assumed?.valor, 2250, "adopta el DETALLE (V6/§6)");
  assert.equal(s.gastos_assumed?.fuente, "detalle");
  assert.equal(s.gastos_mensuales, 2250);
  assert.equal(s.factStatus?.gastos_mensuales, "ASSUMED");

  // V6 — ASSUMED es revocable y re-emergente: una confirmación corta lo cierra.
  const nota = notaConflictoGastos(s);
  assert.ok(nota?.includes("SUPUESTO ACTIVO"), "PROHIBIDO texto enlatado: el sistema entrega hechos, no la frase final");
  assert.ok(nota?.includes("2250"));
});

test("CASO 8 (§10): 2200 vs 6000 (>5%) → CONFLICT NO elegible para escape; NUNCA ASSUMED; reinicia captura", () => {
  const s = mergeScenario({}, extractScenarioDelta("gasto 2200: 1200 arriendo 4800 comida"));
  assert.equal(s.gastos_conflict, undefined, ">5% no es CONFLICT elegible — es fallo de comprensión, se reinicia");
  assert.equal(s.gastos_assumed, undefined);
  assert.equal(s.gastos_mensuales, undefined, "ninguna de las dos cifras queda como verdad");
  assert.equal(s.gastos_detalle, undefined);
});

test("PIEZA 4 (§7): gastos en CONFLICT NO bloquea la cuota del crédito ni la clasificación vital/no-vital", () => {
  let s = mergeScenario({}, extractScenarioDelta("Gano 2636 euros al mes y mis gastos son 2200."));
  s = mergeScenario(s, extractScenarioDelta("Mis gastos: arriendo 1200, comida 1050"));
  s = mergeScenario(s, extractScenarioDelta("quiero financiar un carro de 12000 a 36 meses"));
  assert.ok(s.gastos_conflict, "precondición: conflicto de gastos activo");

  const ctx = buildScenarioContext(s, "quiero financiar un carro de 12000 a 36 meses");
  assert.ok("cuota" in ctx.conceptos, "la cuota del crédito SÍ se calcula con gastos en conflicto");
  assert.ok(ctx.bloque.includes("referencia_cuota_credito"));
  assert.ok(!("sobrante" in ctx.conceptos), "sobrante SÍ sigue bloqueado");
  assert.ok(!("brecha" in ctx.conceptos), "brecha SÍ sigue bloqueada");

  // La clasificación vital/no-vital de una lista de gastos EN EL MENSAJE (no
  // el gastos_mensuales disputado) tampoco se bloquea.
  const ctxLista = buildScenarioContext(s, "vitales: arriendo 1200, comida 1050");
  assert.ok("gastos_vitales" in ctxLista.conceptos || ctxLista.bloque.includes("gastos_vitales"));
});

test("V15/E8 (12ª tanda): 'gasto 1500 en total: casa 700, comida 300' → atribución correcta (no huérfano)", () => {
  const delta = extractScenarioDelta("gasto 1500 en total: casa 700, comida 300");
  assert.equal(delta.gastos_mensuales, 1500);
  assert.equal(delta.gastos_items?.find((i) => i.name === "casa")?.amount, 700);
  assert.equal(delta.gastos_items?.find((i) => i.name === "comida")?.amount, 300);
});

test("V15/E3 (12ª tanda): 'gano 2300 y quiero una casa' → meta.monto NO es el ingreso (2300)", () => {
  const delta = extractScenarioDelta("gano 2300 y quiero una casa");
  assert.equal(delta.ingreso_mensual, 2300);
  assert.notEqual(delta.meta?.monto, 2300, "un número reclamado por 'gano' no puede ser el monto de la meta");
});

test("REGRESIÓN (12ª tanda): V14 (fronteras posicionales) y ley de conservación siguen intactas", () => {
  const s = mergeScenario({}, extractScenarioDelta("gano 1500, quiero una casa de 200000 a 240 meses, casa 700, comida 300, luz 90"));
  assert.equal(s.credito?.monto, 200000, "el crédito de la primera 'casa' no lo destruye la segunda");
  assert.equal(s.gastos_items?.find((i) => i.name === "casa")?.amount, 700, "la segunda 'casa' sigue siendo gasto");
  const real =
    "Diezmo_Vital 225, 700 Casa_Vital Supermercado_Vital 450, 120 Servicios_Vitales, " +
    "Telecomunicaciones_Necesario 60 100 Pañales_Bebe_Vital, Colegio_Niño_Necesario 150 " +
    "Transporte_Necesario 100, 80 Ropa_Posible, Ocio_Familiar 60 40 Farmacia_Vital, " +
    "Suscripciones_Ocio 25 40 Gimnasio_Necesario, 60 Ahorro_Posible Gastos_Varios_Posible 40";
  const deltaReal = extractScenarioDelta(real);
  assert.equal(deltaReal.gastos_items?.length, 15, "testdev7 sigue verde");
  assert.equal(deltaReal.gastos_items?.reduce((a, i) => a + i.amount, 0), 2250);
});

// ═══════════════════════════════════════════════════════════════════════════
// CORRECCIONES TANDA 2 (revisión adversarial AG01) — V16 doble conteo,
// G1c en la ruta de escape, ASSUMED revocable, cap de historial verificado.
// ═══════════════════════════════════════════════════════════════════════════

// ── BLOQUEANTE 1 — V16: ningún número se cuenta dos veces ───────────────────
test("BLOQUEANTE 1: 'gasté 1800: renta 900, comida 500, luz 400' → 1800, 3 ítems, CONSISTENT (no 3600)", () => {
  const delta = extractScenarioDelta("gasté 1800: renta 900, comida 500, luz 400");
  assert.equal(delta.gastos_mensuales, 1800);
  assert.equal(delta.gastos_items?.length, 3, "el agregado NO debe colarse como un cuarto ítem");
  assert.ok(!delta.gastos_items?.some((i) => i.amount === 1800), "el ítem fantasma (1800) no debe existir");
  const s = mergeScenario({}, delta);
  assert.equal(s.gastos_mensuales, 1800, "nunca 3600 — el doble conteo no debe producirse");
  assert.equal(s.gastos_conflict, undefined, "CONSISTENT: 900+500+400=1800, coincide con el agregado");
});

test("BLOQUEANTE 1: 'gasto 2200: renta 900, comida 500, luz 400' → agregado 2200, detalle 1800 (18,2% > 5% → reinicia, NO 'CONFLICT −400' literal)", () => {
  // NOTA DE DISCREPANCIA (declarada en el reporte Fase 4): el encargo describe
  // este caso como "CONFLICT −400", pero 400/2200 = 18,18 % excede el 5 %
  // de materialidad ya APROBADO y protegido explícitamente en esta misma
  // corrección ("no debes tocar... materialidad exacta en las tres
  // fronteras"). Producir CONFLICT aquí exigiría debilitar ese umbral ya
  // verificado (AG01 confirmó la frontera exacta en 5% / 5.045% en su
  // revisión). Se prioriza la consistencia con la materialidad aprobada.
  const delta = extractScenarioDelta("gasto 2200: renta 900, comida 500, luz 400");
  assert.equal(delta.gastos_mensuales, 2200);
  const s = mergeScenario({}, delta);
  assert.equal(s.gastos_conflict, undefined, ">5% no es CONFLICT elegible bajo la materialidad ya aprobada");
  assert.equal(s.gastos_mensuales, undefined, "reinicio de captura — ninguna cifra queda como verdad");
});

test("BLOQUEANTE 1 (V15, ya verificado por AG01): 'gastos 1500 en total: casa 700, comida 300' → atribución correcta", () => {
  const delta = extractScenarioDelta("gastos 1500 en total: casa 700, comida 300");
  assert.equal(delta.gastos_mensuales, 1500);
  assert.equal(delta.gastos_items?.find((i) => i.name === "casa")?.amount, 700, "NUNCA 1500 — el 700 no debe quedar huérfano");
  assert.equal(delta.gastos_items?.find((i) => i.name === "comida")?.amount, 300);
});

test("BLOQUEANTE 1: guarda V16 explícita — ítem con el mismo importe que el agregado se descarta quirúrgicamente", () => {
  // Prueba directa de la guarda (no solo de su disparador conocido): un
  // desglose de 3 ítems donde UNO coincide exactamente con el agregado
  // declarado en el MISMO delta — el resto de partidas reales se conservan.
  const delta = extractScenarioDelta("gasto 900: renta 900, comida 500, luz 400");
  assert.ok(delta.gastos_items?.every((i) => i.amount !== 900) ?? true, "ningún ítem debe quedar con el importe del agregado (900)");
});

// ── BLOQUEANTE 2 — G1c en la ruta de escape (detalle PARTIAL) ───────────────
test("BLOQUEANTE 2: escape con detalle PARTIAL → NUNCA asume, en ambos sentidos, mismo estado final", () => {
  // Desglose con un huérfano genuino (400 sin asignar) → PARTIAL.
  const msgDetallePartial = "Mis gastos: arriendo 1200, comida 1050. Quizas 300 o 400 mas, no estoy seguro.";
  const deltaDetalle = extractScenarioDelta(msgDetallePartial);
  assert.equal(deltaDetalle.extraction_status, "PARTIAL", "precondición: el desglose debe ser PARTIAL");

  const dosIntentosSinResolver = (inicial: ReturnType<typeof mergeScenario>) => {
    let s = mergeScenario(inicial, extractScenarioDelta("no lo se", "es", inicial));
    s = mergeScenario(s, extractScenarioDelta("no estoy seguro todavia", "es", s));
    return s;
  };

  // Sentido A: detalle PARTIAL (T1) → agregado (T2) → 2 intentos.
  let a = mergeScenario({}, deltaDetalle);
  a = mergeScenario(a, extractScenarioDelta("Gano 2636 euros al mes y mis gastos son 2500."));
  assert.equal(a.gastos_conflict?.detalleCompleta, false, "el desglose que originó el conflicto era PARTIAL");
  a = dosIntentosSinResolver(a);

  // Sentido B: agregado (T1) → detalle PARTIAL (T2) → 2 intentos.
  let b = mergeScenario({}, extractScenarioDelta("Gano 2636 euros al mes y mis gastos son 2500."));
  b = mergeScenario(b, deltaDetalle);
  assert.equal(b.gastos_conflict?.detalleCompleta, false, "el desglose que originó el conflicto era PARTIAL (rama traeAgregado)");
  b = dosIntentosSinResolver(b);

  // G1c: mismo par de hechos, orden distinto → mismo estado final.
  assert.equal(a.gastos_assumed, undefined, "NUNCA escapa a ASSUMED con detalle PARTIAL (sentido A)");
  assert.equal(b.gastos_assumed, undefined, "NUNCA escapa a ASSUMED con detalle PARTIAL (sentido B)");
  assert.ok(a.gastos_conflict, "el conflicto sigue activo, sin resolver (sentido A)");
  assert.ok(b.gastos_conflict, "el conflicto sigue activo, sin resolver (sentido B)");
  assert.equal(a.gastos_conflict?.attempts, b.gastos_conflict?.attempts, "mismos intentos en ambos sentidos");
  assert.equal(a.gastos_conflict?.detalleCompleta, b.gastos_conflict?.detalleCompleta, "misma calidad de detalle en ambos sentidos");
});

test("BLOQUEANTE 2: comentario corregido — gastos_detalle_origen NO se fija solo con COMPLETE (regresión del bug real)", () => {
  const msgDetallePartial = "Mis gastos: arriendo 1200, comida 1050. Quizas 300 o 400 mas, no estoy seguro.";
  const s = mergeScenario({}, extractScenarioDelta(msgDetallePartial));
  assert.equal(s.gastos_detalle_origen?.completa, false, "el origen SÍ se fija con PARTIAL, y ahora lo declara honestamente");
});

// ── BLOQUEANTE 3 — ASSUMED es revocable (V6, "siempre") ──────────────────────
function llegarAAssumedParaTest() {
  let s = mergeScenario({}, extractScenarioDelta("Gano 2636 euros al mes y mis gastos son 2200."));
  s = mergeScenario(s, extractScenarioDelta("Mis gastos: arriendo 1200, comida 1050"));
  s = mergeScenario(s, extractScenarioDelta("no lo se", "es", s));
  s = mergeScenario(s, extractScenarioDelta("no estoy seguro todavia", "es", s));
  assert.equal(s.gastos_assumed?.valor, 2250, "precondición: ASSUMED activo con 2250");
  return s;
}

const CORRECCIONES_ASSUMED = [
  "en realidad son 2200",
  "no, son 2200",
  "corrige: 2200",
  "usa 2200",
  "eran 2200",
  "me equivoque, son 2200",
  "el correcto es el total",
  "quedate con el agregado",
];

test("BLOQUEANTE 3: 8 formas de corrección sobre un ASSUMED activo → las 8 revocan a CONFIRMED 2200", () => {
  for (const frase of CORRECCIONES_ASSUMED) {
    const s = llegarAAssumedParaTest();
    const s2 = mergeScenario(s, extractScenarioDelta(frase, "es", s));
    assert.equal(s2.gastos_mensuales, 2200, `"${frase}" debe revocar el supuesto y confirmar 2200`);
    assert.equal(s2.gastos_assumed, undefined, `"${frase}" debe limpiar el ASSUMED`);
    assert.equal(s2.gastos_conflict, undefined, `"${frase}" no debe dejar un CONFLICT abierto`);
    assert.equal(s2.factStatus?.gastos_mensuales, "CONFIRMED", `"${frase}" → factStatus CONFIRMED`);
    assert.ok(
      s2.gastos_superseded?.some((sp) => sp.valor === 2250 && sp.motivo === "USER_CORRECTION"),
      `"${frase}" debe archivar el 2250 asumido como SUPERSEDED (V7, nunca se borra)`,
    );
  }
});

const CONFIRMACIONES_ASSUMED = ["si", "vale", "ok", "si, correcto", "correcto", "confirmo", "exacto", "asi es"];

test("BLOQUEANTE 3 (MAYOR 1): 8 formas de confirmación sobre un ASSUMED activo → las 8 confirman", () => {
  for (const frase of CONFIRMACIONES_ASSUMED) {
    assert.ok(esConfirmacionCorta(frase), `"${frase}" debe reconocerse como confirmación corta`);
    const s = llegarAAssumedParaTest();
    const s2 = mergeScenario(s, extractScenarioDelta(frase, "es", s));
    assert.equal(s2.gastos_mensuales, 2250, `"${frase}" confirma el valor asumido (2250)`);
    assert.equal(s2.gastos_assumed, undefined, `"${frase}" limpia el ASSUMED`);
    assert.equal(s2.factStatus?.gastos_mensuales, "CONFIRMED", `"${frase}" → factStatus CONFIRMED`);
  }
});

test("BLOQUEANTE 3: ASSUMED + valor nuevo discrepante → CONFLICT, NUNCA los dos estados a la vez", () => {
  const s = llegarAAssumedParaTest();
  const s2 = mergeScenario(s, extractScenarioDelta("mis gastos son 2200", "es", s));
  assert.ok(s2.gastos_conflict, "el valor discrepante (2200) contra el asumido (2250) debe abrir CONFLICT");
  assert.equal(s2.gastos_assumed, undefined, "el ASSUMED se archiva — mutuamente excluyente con CONFLICT");
  assert.ok(
    s2.gastos_superseded?.some((sp) => sp.valor === 2250 && sp.motivo === "ASSUMED_SUPERSEDED_BY_NEW_DATA"),
    "el supuesto archivado debe quedar en el historial, nunca borrado en silencio (V7)",
  );
});

test("BLOQUEANTE 3: confirmación negativa no dispara ninguna transición (regresión, sin falsos positivos)", () => {
  for (const frase of ["no", "tal vez", "mmm no se"]) {
    assert.equal(esConfirmacionCorta(frase), false, `"${frase}" NO debe confirmar nada`);
  }
});

// ── MAYOR 4 — cap de historial (§8) verificado por la vía pública ───────────
test("MAYOR 4: 8 ciclos CONFLICT→resolución del mismo campo → cap de 5 en gastos_superseded, resto colapsado a contador", () => {
  let s = mergeScenario({}, extractScenarioDelta("Gano 2636 euros al mes y mis gastos son 2200."));
  s = mergeScenario(s, extractScenarioDelta("Mis gastos: arriendo 1200, comida 1050"));
  s = mergeScenario(s, extractScenarioDelta("usa 2250", "es", s));
  assert.equal(s.gastos_superseded?.length, 1);
  assert.equal(s.gastos_superseded_colapsados ?? 0, 0);

  for (let i = 2; i <= 8; i++) {
    s = mergeScenario(s, extractScenarioDelta("Gano 2636 euros al mes y mis gastos son 2200."));
    s = mergeScenario(s, extractScenarioDelta("usa 2250", "es", s));
  }

  assert.equal(s.gastos_superseded?.length, 5, "§8: cap de 5 versiones — el array nunca crece más allá de eso");
  assert.equal(s.gastos_superseded_colapsados, 3, "8 correcciones − 5 que caben = 3 colapsadas al contador");
  assert.ok(s.gastos_superseded?.every((sp) => sp.valor === 2200 && sp.motivo === "USER_CORRECTION"));
});

// ═══════════════════════════════════════════════════════════════════════════
// BUG tiene_detalle_gastos (T4 del e2e) — POSESIÓN vs. USABILIDAD.
// ═══════════════════════════════════════════════════════════════════════════

const TESTDEV7_REAL =
  "Diezmo_Vital 225, 700 Casa_Vital Supermercado_Vital 450, 120 Servicios_Vitales, " +
  "Telecomunicaciones_Necesario 60 100 Pañales_Bebe_Vital, Colegio_Niño_Necesario 150 " +
  "Transporte_Necesario 100, 80 Ropa_Posible, Ocio_Familiar 60 40 Farmacia_Vital, " +
  "Suscripciones_Ocio 25 40 Gimnasio_Necesario, 60 Ahorro_Posible Gastos_Varios_Posible 40";

test("BUG tiene_detalle_gastos (2): gastos 2200 → 15 partidas (2250) → posesión true, conflicto activo, agregado intacto", () => {
  let s = mergeScenario({}, extractScenarioDelta("gano 2300 y gasto 2200"));
  s = mergeScenario(s, extractScenarioDelta(TESTDEV7_REAL));
  assert.equal(s.gastos_items?.length, 15, "las 15 partidas se conservan (V14, ley de conservación)");
  assert.equal(s.tiene_detalle_gastos, true, "POSESIÓN: hay ítems, da igual que haya conflicto");
  assert.ok(s.gastos_conflict, "G1c: la reconciliación cross-turno SÍ detecta la discrepancia");
  assert.equal(s.gastos_conflict?.agregado, 2200);
  assert.equal(s.gastos_conflict?.detalle, 2250);
  assert.equal(s.gastos_conflict?.diff, 50);
  assert.equal(s.gastos_mensuales, 2200, "V2: el agregado NUNCA se sobrescribe mientras el conflicto está activo");
});

test("BUG tiene_detalle_gastos (3): con detalle en conflicto, la nota pide RESOLVER, nunca vuelve a pedir el desglose", () => {
  let s = mergeScenario({}, extractScenarioDelta("gano 2300 y gasto 2200"));
  s = mergeScenario(s, extractScenarioDelta(TESTDEV7_REAL));
  const msg = "¿qué puedo recortar?";
  assert.equal(notaFaltaDesglose(s, msg), null, "NUNCA vuelve a pedir el desglose — ya lo tiene (E4)");
  assert.ok(notaConflictoGastos(s)?.includes("CONFLICTO SIN RESOLVER"), "pide resolver la discrepancia, no el desglose");
});

test("BUG tiene_detalle_gastos (4): con gastos_items vacío, SÍ se pide el desglose", () => {
  const s = mergeScenario({}, extractScenarioDelta("gano 2300 y gasto 2200"));
  assert.equal(s.gastos_items, undefined);
  assert.equal(s.tiene_detalle_gastos, false, "POSESIÓN: sin ítems, no hay nada que posea");
  const nota = notaFaltaDesglose(s, "¿qué puedo recortar?");
  assert.ok(nota?.includes("DESGLOSE"), "sin ítems, la nota SÍ debe pedirlo");
});

test("BUG tiene_detalle_gastos (5): con detalle en conflicto, NO se propone recorte por partida", () => {
  let s = mergeScenario({}, extractScenarioDelta("gano 2300 y gasto 2200"));
  s = mergeScenario(s, extractScenarioDelta(TESTDEV7_REAL));
  const ctx = buildScenarioContext(s, TESTDEV7_REAL);
  assert.ok(!("recorte" in ctx.conceptos), "recorte_propuesto_50pct sigue bloqueado con conflicto activo (§7, ya vigente)");
  assert.ok(!ctx.bloque.includes("recorte_propuesto"));
  // notaDetalleSinConfirmar cede el turno a notaConflictoGastos: no debe
  // emitir su propia (y contradictoria) instrucción de "sobrante SÍ" cuando
  // el propio agregado está en disputa.
  assert.equal(notaDetalleSinConfirmar(s, "¿qué puedo recortar?"), null, "cede a notaConflictoGastos, sin contradicción");
});

test("BUG tiene_detalle_gastos: guarda de autoconsistencia — el flag nunca puede ser false con ítems presentes", () => {
  let s = mergeScenario({}, extractScenarioDelta("gano 2300 y gasto 2200"));
  s = mergeScenario(s, extractScenarioDelta(TESTDEV7_REAL));
  // Invariante verificado directamente (la guarda interna loguea si esto
  // llegara a divergir — aquí se comprueba que, de hecho, nunca diverge).
  assert.equal((s.gastos_items?.length ?? 0) > 0, s.tiene_detalle_gastos, "posesión y longitud de ítems siempre coinciden");
});

test("BUG tiene_detalle_gastos: evento ICA 'detalle_gastos' SÍ se dispara aunque el desglose entre en conflicto", () => {
  // Efecto colateral correcto del fix: con la semántica vieja (gastos_detalle
  // !== undefined), un desglose que colisiona con el agregado NUNCA disparaba
  // este evento — el usuario aportó 15 partidas y el ICA no lo registraba.
  const antes = mergeScenario({}, extractScenarioDelta("gano 2300 y gasto 2200"));
  const despues = mergeScenario(antes, extractScenarioDelta(TESTDEV7_REAL));
  assert.ok(detectarEventosICA(antes, despues).includes("detalle_gastos"));
});

// ═══════════════════════════════════════════════════════════════════════════
// 13ª TANDA — V16 (doble conteo con palabra intermedia) + V15 (atribución
// única) + el test estructural que cierra la familia V14/V15/V16.
// ═══════════════════════════════════════════════════════════════════════════

// ── BLOQUEANTE A — V16: doble conteo con palabra intermedia ─────────────────

test("V16-A1: 'mis gastos fueron 1200: internet 300, agua 400, gas 500' → 1200, 3 ítems, CONSISTENT (nunca 2400)", () => {
  const msg = "mis gastos fueron 1200: internet 300, agua 400, gas 500";
  const delta = extractScenarioDelta(msg);
  assert.equal(delta.gastos_mensuales, 1200, "el agregado declarado se reclama pese a la palabra intermedia 'fueron'");
  assert.equal(delta.gastos_items?.length, 3, "3 partidas — el agregado NO puede colarse como un cuarto ítem");
  assert.ok(!delta.gastos_items?.some((i) => i.amount === 1200), "ningún ítem puede llevar el importe del agregado");
  const s = mergeScenario({}, delta);
  assert.equal(s.gastos_mensuales, 1200, "NUNCA 2400 — el doble conteo no debe producirse");
  assert.equal(s.gastos_conflict, undefined, "CONSISTENT: 300+400+500 = 1200, coincide con el agregado");
});

test("V16-A2: 'gastamos 950 al mes: mercado 500, gasolina 250, farmacia 200' → 950, 3 ítems, CONSISTENT (nunca 1900)", () => {
  const msg = "gastamos 950 al mes: mercado 500, gasolina 250, farmacia 200";
  const delta = extractScenarioDelta(msg);
  assert.equal(delta.gastos_mensuales, 950, "'gastamos' + 'al mes' entre keyword y cifra");
  assert.equal(delta.gastos_items?.length, 3);
  assert.ok(!delta.gastos_items?.some((i) => i.amount === 950));
  const s = mergeScenario({}, delta);
  assert.equal(s.gastos_mensuales, 950, "NUNCA 1900");
  assert.equal(s.gastos_conflict, undefined, "CONSISTENT: 500+250+200 = 950");
});

// Cuatro formas PROPIAS (no presentes en ningún test anterior) que ejercitan
// otras alternativas del conector declarativo, en los tres idiomas.
test("V16-A3 (forma propia): 'mis gastos mensuales son 800: luz 200, agua 250, internet 350' → 800, 3 ítems, CONSISTENT", () => {
  const delta = extractScenarioDelta("mis gastos mensuales son 800: luz 200, agua 250, internet 350");
  assert.equal(delta.gastos_mensuales, 800);
  assert.equal(delta.gastos_items?.length, 3);
  assert.equal(mergeScenario({}, delta).gastos_mensuales, 800);
});

test("V16-A4 (forma propia): 'gastos aproximadamente 600: transporte 200, ocio 150, ropa 250' → 600, 3 ítems", () => {
  const delta = extractScenarioDelta("gastos aproximadamente 600: transporte 200, ocio 150, ropa 250");
  assert.equal(delta.gastos_mensuales, 600);
  assert.equal(delta.gastos_items?.length, 3);
  assert.ok(!delta.gastos_items?.some((i) => i.amount === 600));
});

test("V16-A5 (forma propia, PT): 'as despesas foram 900: renda 400, comida 300, luz 200' → 900, 3 ítems", () => {
  const delta = extractScenarioDelta("as despesas foram 900: renda 400, comida 300, luz 200");
  assert.equal(delta.gastos_mensuales, 900);
  assert.equal(delta.gastos_items?.length, 3);
  assert.ok(!delta.gastos_items?.some((i) => i.amount === 900));
});

test("V16-A6 (forma propia, EN): 'my expenses were 700: rent 400, food 200, power 100' → 700, 3 ítems", () => {
  const delta = extractScenarioDelta("my expenses were 700: rent 400, food 200, power 100");
  assert.equal(delta.gastos_mensuales, 700);
  assert.equal(delta.gastos_items?.length, 3);
  assert.ok(!delta.gastos_items?.some((i) => i.amount === 700));
});

test("V16-A7 (regresión tanda 2): 'gasté 1800: renta 900, comida 500, luz 400' → 1800, 3 ítems", () => {
  const delta = extractScenarioDelta("gasté 1800: renta 900, comida 500, luz 400");
  assert.equal(delta.gastos_mensuales, 1800);
  assert.equal(delta.gastos_items?.length, 3);
});

// ── BLOQUEANTE B — V15: atribución correcta ────────────────────────────────

test("V15-B1: 'gasto 1500 en total: casa 700, comida 300' → casa=700 (NUNCA 1500), agregado 1500", () => {
  const delta = extractScenarioDelta("gasto 1500 en total: casa 700, comida 300");
  assert.equal(delta.gastos_mensuales, 1500);
  assert.equal(delta.gastos_items?.find((i) => i.name === "casa")?.amount, 700, "el ítem conserva SU importe, no el del agregado");
  assert.equal(delta.gastos_items?.find((i) => i.name === "comida")?.amount, 300);
});

test("V15-B2: 'gasto 1500 en total: casa 700, comida 300, luz 500' → suma exacta 1500 → CONSISTENT", () => {
  const delta = extractScenarioDelta("gasto 1500 en total: casa 700, comida 300, luz 500");
  assert.equal(delta.gastos_mensuales, 1500);
  assert.equal(delta.gastos_items?.length, 3);
  const s = mergeScenario({}, delta);
  assert.equal(s.gastos_mensuales, 1500);
  assert.equal(s.gastos_conflict, undefined, "700+300+500 = 1500 exacto → CONSISTENT, sin conflicto");
});

test("V15-B3: 'gano 2300 y quiero una casa' → meta.monto NUNCA es el ingreso (2300)", () => {
  const delta = extractScenarioDelta("gano 2300 y quiero una casa");
  assert.equal(delta.ingreso_mensual, 2300);
  assert.notEqual(delta.meta?.monto, 2300, "un número reclamado por 'gano' no puede ser el monto de la meta");
});

test("V15-B4: 'sueldo 3000, quiero un piso de 200000' → ingreso 3000 y meta 200000, nunca cruzados", () => {
  const delta = extractScenarioDelta("sueldo 3000, quiero un piso de 200000");
  assert.equal(delta.ingreso_mensual, 3000, "el sueldo es el ingreso");
  assert.equal(delta.meta?.monto, 200000, "el precio del piso es el monto de la meta, no un huérfano");
  assert.notEqual(delta.meta?.monto, 3000, "jamás cruzados");
  assert.notEqual(delta.ingreso_mensual, 200000);
});

// ── INVARIANTE DE CIERRE — ATRIBUCIÓN ÚNICA (estructural) ──────────────────
//
// Cierra la familia V14/V15/V16 de una vez: recorre los mensajes de las tandas
// 1, 2 y 3 y afirma, para CADA cifra del mensaje, que aparece en EXACTAMENTE
// UN destino. Ni cero (V14: desapareció en silencio) ni dos (V16: se contó
// dos veces).
//
// DOS ARMAS, deliberadamente — y esto importa: la primera SOLA no habría
// cazado el bloqueante A de esta tanda. En aquel bug el agregado (1200) se
// atribuía a UN destino (un ítem llamado "fueron"), no a dos: la cuenta de
// destinos cuadraba perfectamente, y aun así el total salía duplicado porque
// el destino era el EQUIVOCADO. La segunda arma es la que caza esa clase:
// ningún ítem puede llamarse como una palabra funcional del patrón
// declarativo — si eso pasa, el agregado se coló en la lista.

/** Multiconjunto de valores → cuántas veces aparece cada uno. */
function multisetDeValores(vals: number[]): Map<number, number> {
  const m = new Map<number, number>();
  for (const v of vals) m.set(v, (m.get(v) ?? 0) + 1);
  return m;
}

/**
 * Todos los destinos posibles de una cifra en el delta. `credito` y `meta`
 * comparten monto/plazo de forma LEGÍTIMA y por diseño (crédito↔meta: "la
 * meta ES el crédito" — ver `rangosParaMeta` en scenario.ts y la derivación
 * BUG 3 de `mergeScenario`), así que ese alias cuenta como UN solo destino.
 */
function destinosDeCadaCifra(delta: Partial<ScenarioState>, huerfanos: number[]): number[] {
  const d: number[] = [];
  if (delta.ingreso_mensual !== undefined) d.push(delta.ingreso_mensual);
  if (delta.gastos_mensuales !== undefined) d.push(delta.gastos_mensuales);
  for (const item of delta.gastos_items ?? []) d.push(item.amount);
  if (delta.credito?.monto !== undefined) d.push(delta.credito.monto);
  if (delta.credito?.plazo_meses !== undefined) d.push(delta.credito.plazo_meses);
  if (delta.credito?.tae_pct !== undefined) d.push(delta.credito.tae_pct);
  if (delta.meta?.monto !== undefined && delta.meta.monto !== delta.credito?.monto) d.push(delta.meta.monto);
  if (delta.meta?.plazo_meses !== undefined && delta.meta.plazo_meses !== delta.credito?.plazo_meses) {
    d.push(delta.meta.plazo_meses);
  }
  d.push(...huerfanos);
  return d;
}

/** Palabras funcionales del patrón declarativo: JAMÁS son el nombre de una partida. */
const PALABRAS_NUNCA_ITEM =
  /^(?:gasto|gastos|gaste|gastamos|gastaron|gastabamos|despesas?|expenses?|spent|gano|sueldo|salario|ingreso|ingresos|fueron|fue|son|es|eran|era|foram|foi|sao|were|was|are|is|al|mes|mensuales?|total|aproximadamente|aprox|unos|unas|cerca|alrededor)$/;

/** Los mensajes de las tres tandas, en un solo corpus. */
const CORPUS_ATRIBUCION = [
  // — tanda 1 (V13/V14: fronteras posicionales + conservación)
  "gano 2000 y gasto en arriendo 800, comida 300, luz 100",
  "gano 1500, quiero una casa de 200000 a 240 meses, casa 700, comida 300, luz 90",
  "gano 1500, quiero financiar una casa de 200000 a 240 meses, casa 700, comida 300, luz 90",
  "gano 700 y pago arriendo 650, comida 200, luz 50",
  "mi sueldo es 2500 y el arriendo 800, comida 300, luz 90",
  "gasto 2 500 €",
  "gano 2300 y gasto aproximadamente 2000 entre vivienda, comida, servicios, ocio",
  // — tanda 2 (G1c: reconciliación cross-turno + V16 v1)
  "gasto 2200: 1200 arriendo 1050 comida",
  "Gano 2636 euros al mes y mis gastos son 2200.",
  "Mis gastos: arriendo 1200, comida 1050",
  "gasté 1800: renta 900, comida 500, luz 400",
  "gasto 1500 en total: casa 700, comida 300",
  "gano 2300 y quiero una casa",
  "el banco me ofrece un 9%",
  // — tanda 3 (esta: V16 palabra intermedia + V15 atribución)
  "mis gastos fueron 1200: internet 300, agua 400, gas 500",
  "gastamos 950 al mes: mercado 500, gasolina 250, farmacia 200",
  "mis gastos mensuales son 800: luz 200, agua 250, internet 350",
  "gastos aproximadamente 600: transporte 200, ocio 150, ropa 250",
  "as despesas foram 900: renda 400, comida 300, luz 200",
  "my expenses were 700: rent 400, food 200, power 100",
  "gasto 1500 en total: casa 700, comida 300, luz 500",
  "sueldo 3000, quiero un piso de 200000",
];

test("INVARIANTE DE CIERRE (V14+V15+V16): cada cifra en EXACTAMENTE un destino, y ninguna palabra funcional como ítem", () => {
  const fallos: string[] = [];

  for (const msg of CORPUS_ATRIBUCION) {
    const delta = extractScenarioDelta(msg);
    const huerfanos = detectarNumerosHuerfanos(msg, delta).numerosHuerfanos;

    // ARMA 1 — atribución única: ni cero (V14) ni dos (V16).
    const candidatos = multisetDeValores(numerosCandidatos(msg));
    const destinos = multisetDeValores(destinosDeCadaCifra(delta, huerfanos));
    for (const [valor, veces] of candidatos) {
      const enDestino = destinos.get(valor) ?? 0;
      if (enDestino === 0) fallos.push(`V14 "${msg}": ${valor} desapareció (0 destinos)`);
      else if (enDestino > veces) fallos.push(`V16 "${msg}": ${valor} se contó ${enDestino} veces, el mensaje lo dice ${veces}`);
      else if (enDestino < veces) fallos.push(`V14 "${msg}": ${valor} aparece ${veces} veces y solo ${enDestino} tienen destino`);
    }

    // ARMA 2 — ninguna palabra funcional del patrón declarativo puede ser el
    // NOMBRE de una partida: esa es la firma exacta del doble conteo del
    // bloqueante A ("fueron"=1200, "gastamos"=950, "gasté"=1800).
    for (const item of delta.gastos_items ?? []) {
      const primeraPalabra = item.name.trim().split(/\s+/)[0] ?? "";
      const n = primeraPalabra.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();
      if (PALABRAS_NUNCA_ITEM.test(n)) {
        fallos.push(`V16 "${msg}": el ítem "${item.name}"=${item.amount} lleva una palabra declarativa por nombre — el agregado se coló en la lista`);
      }
    }
  }

  assert.deepEqual(fallos, [], `ATRIBUCIÓN ÚNICA violada:\n${fallos.join("\n")}`);
});

// ═══════════════════════════════════════════════════════════════════════════
// 13ª TANDA — MEMORIA A NIVEL DE USUARIO: partición hechos / diálogo.
// ═══════════════════════════════════════════════════════════════════════════

test("split: cada campo de HECHOS va a `hechos` y ninguno se filtra a `dialogo`", () => {
  const estado: Partial<ScenarioState> = {
    ingreso_mensual: 2300,
    gastos_mensuales: 2200,
    gastos_detalle: { vitales: 1200, noVitales: 1000, desconocidos: 0 },
    gastos_es_detalle: true,
    gastos_items: [{ name: "arriendo", amount: 1200, category: "vital", source: "regex", turn: 1 }],
    gastos_items_colapsados: 2,
    tiene_agregado_gastos: true,
    tiene_detalle_gastos: true,
    credito: { monto: 30000, plazo_meses: 36, tae_es_referencia: true },
    meta: { titulo: "casa", monto: 150000 },
    meta_derivada: false,
    goals_cerradas: [{ titulo: "moto", monto: 5000 }],
    extraction_status: "COMPLETE",
    factStatus: { ingreso_mensual: "CONFIRMED" },
    detalle_confirmado: true,
    gastos_conflict: { agregado: 2200, agregadoTurn: 1, detalle: 2250, detalleTurn: 2, diff: 50, diffPct: 2.27, attempts: 2, detalleCompleta: true },
    gastos_assumed: { valor: 2250, fuente: "detalle", turn: 4 },
    gastos_superseded: [{ valor: 2200, motivo: "USER_CORRECTION", turn: 3 }],
    gastos_superseded_colapsados: 1,
    gastos_agregado_origen: { valor: 2200, turn: 1 },
    gastos_detalle_origen: { valor: 2250, turn: 2, completa: true },
    turn: 5,
  };
  const { hechos, dialogo } = splitScenarioState(estado);

  for (const campo of CAMPOS_HECHOS) {
    assert.ok(campo in hechos, `${campo} debe ir a HECHOS (viaja entre conversaciones)`);
    assert.ok(!(campo in dialogo), `${campo} NUNCA debe quedarse en el estado de diálogo`);
  }
  // El ciclo de conflicto viaja íntegro, `attempts` incluido: abrir un chat
  // nuevo no puede reiniciar el contador previo al escape (§6).
  assert.equal(hechos.gastos_conflict?.attempts, 2, "los intentos son un HECHO del usuario, no de la conversación");
});

test("split: cada campo de DIÁLOGO va a `dialogo` y ninguno se filtra a `hechos`", () => {
  const estado: Partial<ScenarioState> = {
    propuesta_pendiente: { tipo: "plan", turno: 3 } as never,
    plan_confirmado: true,
    meta_cerrada: true,
    digresiones_seguidas: 2,
    eco_pendiente: { fields: ["gastos_detalle"] },
    missing: ["tae"],
  };
  const { hechos, dialogo } = splitScenarioState(estado);

  for (const campo of CAMPOS_DIALOGO) {
    assert.ok(campo in dialogo, `${campo} debe quedarse en el DIÁLOGO (no viaja)`);
    assert.ok(!(campo in hechos), `${campo} NUNCA debe viajar como si fuera un hecho del usuario`);
  }
});

test("split: las señales del TURNO se descartan — no van a hechos ni a diálogo", () => {
  const estado: Partial<ScenarioState> = {
    ingreso_mensual: 2300,
    meta_cambio_explicito: true,
    detalle_confirmado_explicito: true,
    gastos_item_correccion: { name: "luz", amount: 150 },
    gastos_resolucion: { tipo: "detalle", valorConfirmado: 2250 },
    gastos_assumed_confirmado: true,
  };
  const { hechos, dialogo } = splitScenarioState(estado);
  for (const campo of CAMPOS_TRANSITORIOS) {
    assert.ok(!(campo in hechos) && !(campo in dialogo), `${campo} es señal del turno: no se persiste en ningún lado`);
  }
  assert.equal(hechos.ingreso_mensual, 2300, "el resto del estado sí se clasifica con normalidad");
});

test("split: un campo DESCONOCIDO hace FALLAR — nunca se asume un lado por defecto", () => {
  const conCampoNuevo = { ingreso_mensual: 2300, campo_inventado_sin_clasificar: 42 } as unknown as Partial<ScenarioState>;
  assert.throws(
    () => splitScenarioState(conCampoNuevo),
    /campo\(s\) sin clasificar[\s\S]*campo_inventado_sin_clasificar/,
    "añadir un campo al estado sin clasificarlo debe reventar, no degradarse en silencio",
  );
});

test("split: cobertura total — un estado REAL de varios turnos no deja ningún campo sin clasificar", () => {
  // Regresión de la clase de bug: si una tanda futura añade un campo al
  // estado y olvida clasificarlo, este test falla aquí (no en producción).
  let s = mergeScenario({}, extractScenarioDelta("gano 2300 y gasto 2200"));
  s = mergeScenario(s, extractScenarioDelta("quiero financiar un carro de 30000 a 36 meses"));
  s = mergeScenario(s, extractScenarioDelta("Mis gastos: arriendo 1200, comida 1050"));
  assert.doesNotThrow(() => splitScenarioState(s));

  const { hechos, dialogo } = splitScenarioState(s);
  const total = Object.keys(hechos).length + Object.keys(dialogo).length;
  const transitoriosPresentes = (CAMPOS_TRANSITORIOS as readonly string[]).filter((c) => c in s).length;
  assert.equal(total + transitoriosPresentes, Object.keys(s).length, "todo campo del estado real acaba clasificado");
});

test("mergeEstadoPersistido: reconstruye la MISMA forma; los hechos mandan sobre el diálogo", () => {
  const hechos: Partial<ScenarioState> = { ingreso_mensual: 2300, gastos_mensuales: 2200, turn: 7 };
  const dialogo: Partial<ScenarioState> = { missing: ["meta"], digresiones_seguidas: 1, plan_confirmado: true };
  const fusionado = mergeEstadoPersistido(hechos, dialogo);

  assert.equal(fusionado.ingreso_mensual, 2300);
  assert.equal(fusionado.gastos_mensuales, 2200);
  assert.equal(fusionado.turn, 7);
  assert.equal(fusionado.digresiones_seguidas, 1, "el diálogo de ESTA conversación se conserva");
  assert.equal(fusionado.plan_confirmado, true);
  assert.deepEqual(fusionado.missing, ["meta"]);
});

test("mergeEstadoPersistido: sin fila de hechos, el estado de la conversación actúa de RESPALDO (nunca arranca vacío)", () => {
  // Usuario anterior a la migración 021, o backfill parcial: todo lo que tenga
  // la conversación debe sobrevivir y promoverse en la primera escritura.
  const soloConversacion: Partial<ScenarioState> = { ingreso_mensual: 2300, gastos_mensuales: 2200, missing: [] };
  const fusionado = mergeEstadoPersistido(undefined, soloConversacion);
  assert.equal(fusionado.ingreso_mensual, 2300, "NUNCA se arranca vacío habiendo datos en la conversación");
  assert.equal(fusionado.gastos_mensuales, 2200);
});

test("split + merge es IDEMPOTENTE: partir y volver a fusionar devuelve el mismo estado persistible", () => {
  // La garantía central de la restricción de diseño: la FORMA de ScenarioState
  // no cambia — partirlo para persistirlo y reconstruirlo al leer es una
  // operación sin pérdida (salvo las señales del turno, que por definición no
  // se persisten y que `mergeScenario` ya borra antes de llegar aquí).
  let s = mergeScenario({}, extractScenarioDelta("gano 2300 y gasto 2200"));
  s = mergeScenario(s, extractScenarioDelta("Mis gastos: arriendo 1200, comida 1050"));
  const { hechos, dialogo } = splitScenarioState(s);
  const reconstruido = mergeEstadoPersistido(hechos, dialogo);

  // La comparación se hace sobre el round-trip JSON porque ESE es el camino
  // real: `state`/`scenario_state` son jsonb, y jsonb no distingue entre "la
  // clave no está" y "la clave está con undefined" — `JSON.stringify` elimina
  // las segundas. `mergeScenario` deja algunas claves presentes con valor
  // undefined (p. ej. `gastos_assumed` cuando no hay supuesto activo);
  // exigir que sobrevivan sería exigir una fidelidad que la BD no da, y
  // afirmaría una garantía falsa.
  const comoLoDevuelveLaBD = (x: unknown) => JSON.parse(JSON.stringify(x));
  assert.deepEqual(comoLoDevuelveLaBD(reconstruido), comoLoDevuelveLaBD(s), "ida y vuelta sin pérdida ni deformación");
});

// ═══════════════════════════════════════════════════════════════════════════
// QA testdev8 (14 ago) — bloqueantes 3/4/5 y mayores 6/7
// ═══════════════════════════════════════════════════════════════════════════

test("BLOQUEANTE 5a: 'mis gastos fueron 2 200: arriendo 900, comida 500, luz 400, internet 300, ocio 100' → 5 ítems correctos, sin 'fueron'", () => {
  const delta = extractScenarioDelta(
    "mis gastos fueron 2 200: arriendo 900, comida 500, luz 400, internet 300, ocio 100",
  );
  assert.equal(delta.gastos_mensuales, 2200, "el agregado con miles-con-espacio se lee completo");
  assert.ok(delta.gastos_items, "debe traer desglose");
  assert.equal(delta.gastos_items!.length, 5, "5 partidas reales, no 11 ni ítems espurios");
  assert.ok(
    !delta.gastos_items!.some((i) => i.name.toLowerCase() === "fueron"),
    "'fueron' nunca es nombre de partida",
  );
  const arriendo = delta.gastos_items!.find((i) => i.name.toLowerCase() === "arriendo");
  assert.ok(arriendo, "debe existir la partida arriendo");
  assert.equal(arriendo!.amount, 900, "arriendo no se confunde con el resto del agregado partido");
  const suma = delta.gastos_items!.reduce((acc, i) => acc + i.amount, 0);
  assert.equal(suma, 2200, "suma de ítems = agregado declarado");
});

test("BLOQUEANTE 5b: un ítem repetido en un turno posterior SUPERSEDE al anterior (dedup por nombre, el log completo se conserva)", () => {
  let s = mergeScenario({}, extractScenarioDelta("arriendo 900, comida 500, luz 400, internet 300, ocio 100"));
  assert.equal(itemsGastoActivos(s.gastos_items).length, 5);
  assert.equal(s.gastos_mensuales, 2200);

  const deltaTool = toolArgsToScenarioDelta({
    gastos_detalle: [
      { nombre: "arriendo", monto: 900 },
      { nombre: "comida", monto: 500 },
      { nombre: "luz", monto: 400 },
      { nombre: "internet", monto: 300 },
      { nombre: "ocio", monto: 150 },
    ],
  });
  s = mergeScenario(s, deltaTool);

  const activos = itemsGastoActivos(s.gastos_items);
  assert.equal(activos.length, 5, "sigue habiendo 5 categorías activas, no 10");
  assert.equal(s.gastos_items!.length, 10, "el log completo SÍ acumula — nunca se borra (V7)");
  const ocio = activos.find((i) => i.name.toLowerCase() === "ocio");
  assert.equal(ocio?.amount, 150, "el más reciente gana");
  const sumaActivos = activos.reduce((acc, i) => acc + i.amount, 0);
  assert.equal(sumaActivos, 2250, "la suma de ítems activos coincide con el nuevo total declarado");
  assert.equal(s.gastos_mensuales, 2250, "gastos_mensuales se recalcula del desglose ya deduplicado");
});

test("MAYOR 6: renderDatosRecienEntendidos ENUNCIA la corrección de un ítem (antes devolvía null si no había otro dato nuevo)", () => {
  const delta = { gastos_item_correccion: { name: "ocio", amount: 150 } };
  const nota = renderDatosRecienEntendidos(delta, "me equivoqué, el ocio son 150");
  assert.ok(nota, "debe generar una nota");
  assert.ok(nota!.includes("ocio") && nota!.includes("150"));
  assert.match(nota!, /CORRECCIÓN/i);
});

test("MAYOR 6: una corrección de ítem que ya NO cuadra con el agregado declarado abre el ciclo de conflicto (no se pisa en silencio)", () => {
  let s = mergeScenario(
    {},
    extractScenarioDelta("mis gastos son 2200: arriendo 900, comida 500, luz 400, internet 300, ocio 100"),
  );
  assert.equal(s.gastos_mensuales, 2200);
  assert.equal(s.gastos_agregado_origen?.valor, 2200);
  assert.equal(s.gastos_conflict, undefined, "sin conflicto todavía");

  const delta2 = extractScenarioDelta("me equivoqué, el ocio son 150", "es", s);
  assert.deepEqual(delta2.gastos_item_correccion, { name: "ocio", amount: 150 });

  s = mergeScenario(s, delta2);
  const ocio = itemsGastoActivos(s.gastos_items).find((i) => i.name.toLowerCase() === "ocio");
  assert.equal(ocio?.amount, 150, "la corrección SÍ se aplica al ítem");
  assert.ok(s.gastos_conflict, "la divergencia con el agregado declarado abre el ciclo de conflicto");
  assert.equal(s.gastos_conflict!.detalle, 2250);
  assert.equal(s.gastos_conflict!.agregado, 2200);
});

test("MAYOR 7: contarRepeticionesMensajeUsuario detecta la PREGUNTA repetida, no la respuesta", () => {
  const previos = ["¿cuánto me queda al mes?", "¿me haces un resumen?"];
  assert.equal(contarRepeticionesMensajeUsuario("¿cuánto me queda al mes?", previos), 1);
  assert.equal(
    contarRepeticionesMensajeUsuario("¿cuánto me queda al mes?", [...previos, "¿cuánto me queda al mes?"]),
    2,
    "R1 y R3 idénticas, aunque R2 (que no cuenta aquí) fuera distinta",
  );
  assert.equal(contarRepeticionesMensajeUsuario("otra pregunta completamente distinta", previos), 0);
});

test("BLOQUEANTE 4: el desglose persistido se expone en TU REALIDAD aunque el mensaje de este turno no traiga lista", () => {
  const scenario = mergeScenario(
    {},
    extractScenarioDelta("mis gastos son 2200: arriendo 900, comida 500, luz 400, internet 300, ocio 100"),
  );
  const ctx = buildScenarioContext(scenario, "¿qué gastos tengo?");
  assert.ok(
    ctx.bloque.includes("gastos_vitales") || ctx.bloque.includes("gastos_no_vitales"),
    "el desglose por partida debe aparecer aunque el mensaje sea una pregunta pura",
  );
  assert.ok(ctx.bloque.includes("arriendo"), "las partidas individuales deben verse en la fórmula");
});

test("BLOQUEANTE 3: la cuota se recalcula del estado persistido aunque el mensaje no aporte nada nuevo (sesión nueva, crédito completo)", () => {
  let s = mergeScenario({}, extractScenarioDelta("quiero financiar un carro de 30000 a 48 meses"));
  s = mergeScenario(s, extractScenarioDelta("el banco me ofrece 18%", "es", s));
  assert.equal(s.credito?.monto, 30000);
  assert.equal(s.credito?.plazo_meses, 48);
  assert.equal(s.credito?.tae_pct, 18);
  assert.equal(s.credito?.tae_es_referencia, false);
  assert.ok(!s.missing.includes("tae"), "con TAE real, 'tae' ya no falta");

  const ctx = buildScenarioContext(s, "¿me dices la cuota mensual que pagas?");
  assert.ok("cuota" in ctx.conceptos, "la cuota se calcula aunque el mensaje sea una pregunta pura, sin datos nuevos");
  assert.ok(
    Math.abs(ctx.conceptos.cuota - 881.25) < 1,
    `cuota esperada ~881.25 (30.000€ a 48 meses, TAE 18%), obtuvo ${ctx.conceptos.cuota}`,
  );
});

// ═══════════════════════════════════════════════════════════════════════════
// Revisión adversarial AG01 sobre la tanda QA testdev8 — bloqueante 2, mayor 3, m1
// ═══════════════════════════════════════════════════════════════════════════

test("BLOQUEANTE 2 (revisión AG01): T1 lista parcial → T2 lista parcial con nombres nuevos → suma(items activos) == suma(buckets) == gastos_mensuales", () => {
  let s = mergeScenario({}, extractScenarioDelta("gano 3000, arriendo 900, comida 500"));
  s = mergeScenario(s, extractScenarioDelta("luz 100, internet 50", "es", s));

  const activos = itemsGastoActivos(s.gastos_items);
  const sumaItems = activos.reduce((acc, i) => acc + i.amount, 0);
  const sumaBuckets = (s.gastos_detalle?.vitales ?? 0) + (s.gastos_detalle?.noVitales ?? 0) + (s.gastos_detalle?.desconocidos ?? 0);

  assert.equal(sumaItems, 1550, "4 partidas acumuladas: 900+500+100+50");
  assert.equal(sumaBuckets, 1550, "los buckets reflejan TODOS los ítems acumulados, no solo el último turno");
  assert.equal(s.gastos_mensuales, 1550, "gastos_mensuales ya no se queda en 150 (solo T2)");

  // El bloque que ve el modelo no puede contradecirse: sobrante correcto.
  const ctxV = buildScenarioContext(s, "luz 100, internet 50");
  assert.ok(ctxV.bloque.includes("gastos_mensuales: 1550"));
  assert.ok(ctxV.bloque.includes("sobrante_mensual: 1450"), "sobrante real: 3000 - 1550, nunca 2850");
  assert.ok(!ctxV.bloque.includes("gastos_mensuales: 150"), "la cifra vieja e incoherente no sobrevive");
});

test("MAYOR 3 (revisión AG01): el mensaje del bloqueante 5 ya NO produce una pregunta de aclaración fantasma", () => {
  const msg = "mis gastos fueron 2 200: arriendo 900, comida 500, luz 400, internet 300, ocio 100";
  const delta = extractScenarioDelta(msg);
  const analisis = analizarExtraccion(msg, delta);
  assert.equal(analisis.extraction_status, "COMPLETE", "sin fronteras, el re-parseo marcaba '2 200' como pegado consigo mismo");
  assert.equal(analisis.itemSospechoso, null);
});

test("MAYOR 3 (revisión AG01): 'gasto unos 2 000 al mes: alquiler 1000, comida 600, transporte 400' → COMPLETE", () => {
  const msg = "gasto unos 2 000 al mes: alquiler 1000, comida 600, transporte 400";
  const delta = extractScenarioDelta(msg);
  const analisis = analizarExtraccion(msg, delta);
  assert.equal(analisis.extraction_status, "COMPLETE");
  assert.equal(analisis.itemSospechoso, null);
});

test("m1 (revisión AG01): precedencia tool > regex en la dedup de gastos_items", () => {
  let s = mergeScenario(
    {},
    toolArgsToScenarioDelta({
      gastos_detalle: [
        { nombre: "ocio", monto: 150 },
        { nombre: "casa", monto: 900 },
      ],
    }),
  );
  let activos = itemsGastoActivos(s.gastos_items);
  assert.equal(activos.find((i) => i.name === "ocio")?.amount, 150);
  assert.equal(activos.find((i) => i.name === "ocio")?.source, "tool");

  // T2 por regex intenta pisar los mismos nombres con otros importes.
  s = mergeScenario(s, extractScenarioDelta("ocio 100, casa 900"));
  activos = itemsGastoActivos(s.gastos_items);
  assert.equal(activos.length, 2, "sigue habiendo 2 categorías activas, el regex no añadió duplicados");
  assert.equal(activos.find((i) => i.name === "ocio")?.amount, 150, "el tool_call previo GANA — el regex no lo sustituye");
  assert.equal(activos.find((i) => i.name === "ocio")?.source, "tool");
});

test("m1 (revisión AG01): un tool_call posterior SÍ sustituye a un ítem previo por tool o por regex", () => {
  let s = mergeScenario({}, extractScenarioDelta("ocio 100, casa 900"));
  let activos = itemsGastoActivos(s.gastos_items);
  assert.equal(activos.find((i) => i.name === "ocio")?.amount, 100);

  s = mergeScenario(
    s,
    toolArgsToScenarioDelta({ gastos_detalle: [{ nombre: "ocio", monto: 150 }, { nombre: "casa", monto: 900 }] }),
  );
  activos = itemsGastoActivos(s.gastos_items);
  assert.equal(activos.length, 2);
  assert.equal(activos.find((i) => i.name === "ocio")?.amount, 150, "tool SÍ sustituye a un regex previo");
  assert.equal(activos.find((i) => i.name === "ocio")?.source, "tool");
});

// ═══════════════════════════════════════════════════════════════════════════
// BLOQUEANTE M1 (follow-up QA testdev8) — REGLA ESTRUCTURAL DEL AGREGADO.
// "una cifra seguida de ':' y una lista de ≥2 partidas ES el agregado, sin
// importar qué palabras haya entre la keyword y la cifra" — 10 fraseos: los
// 4 "conocidos" del encargo, más 6 NUEVOS inventados aquí (distintos de los
// que probó AG01 en su revisión), incluido el caso que antes fallaba
// ("del mes pasado fueron de 1500" atribuía 1500 a la primera partida).
// ═══════════════════════════════════════════════════════════════════════════

const CASOS_AGREGADO_ESTRUCTURAL: Array<[string, number, number]> = [
  // conocidos (los cuatro exigidos por el encargo)
  ["mis gastos fueron 1200: internet 300, agua 400, gas 500", 1200, 3],
  ["mis gastos del mes son 1200: internet 300, agua 400, gas 500", 1200, 3],
  ["gastamos 950 al mes: mercado 500, gasolina 250, farmacia 200", 950, 3],
  ["gasté 1800: renta 900, comida 500, luz 400", 1800, 3],
  // 6 fraseos NUEVOS (distintos de los cuatro que inventó AG01 en su
  // revisión: "rondan los X al mes", "he gastado X en total", "del mes
  // pasado fueron de X", "unos X al mes") — cada uno mete palabras
  // arbitrarias entre la keyword y la cifra, o entre la cifra y ":".
  ["en mi casa gasto normalmente 1300: comida 500, transporte 400, ocio 400", 1300, 3],
  ["el total que gasto se ubica en 1100: renta 600, luz 300, agua 200", 1100, 3],
  ["gasté, calculando todo, 1700 el mes pasado: hipoteca 900, super 500, gasolina 300", 1700, 3],
  ["gasto, sin contar imprevistos, 1450: arriendo 800, comida 450, internet 200", 1450, 3],
  ["mis gastos terminan siendo 2100 cada mes: colegio 1200, mercado 600, seguro 300", 2100, 3],
  ["gastamos, entre todos los del hogar, 1600 mensuales: agua 300, gas 300, internet 1000", 1600, 3],
];

for (const [msg, agregadoEsperado, itemsEsperados] of CASOS_AGREGADO_ESTRUCTURAL) {
  test(`BLOQUEANTE M1 estructural: "${msg}" → agregado ${agregadoEsperado}, ${itemsEsperados} ítems`, () => {
    const delta = extractScenarioDelta(msg);
    assert.equal(delta.gastos_mensuales, agregadoEsperado);
    assert.equal(delta.gastos_items?.length, itemsEsperados);
    const suma = delta.gastos_items!.reduce((acc, i) => acc + i.amount, 0);
    assert.equal(suma, agregadoEsperado, "suma de ítems = agregado (sin doble conteo, sin atribución cruzada)");
  });
}

test("BLOQUEANTE M1: el caso que AG01 encontró roto ('del mes pasado fueron de 1500') ya NO le atribuye el agregado a la primera partida", () => {
  const delta = extractScenarioDelta(
    "mis gastos del mes pasado fueron de 1500: hipoteca 800, comida 400, luz 300",
  );
  assert.equal(delta.gastos_mensuales, 1500);
  const hipoteca = delta.gastos_items?.find((i) => i.name === "hipoteca");
  assert.equal(hipoteca?.amount, 800, "la hipoteca real (800), nunca el agregado completo (1500)");
});

test("BLOQUEANTE M1: la enumeración de conectores sigue funcionando como RESPALDO cuando la estructura no valida (mensaje corto, sin lista real)", () => {
  // Un ":" sin una lista de ≥2 partidas detrás no activa la regla
  // estructural — cae al comportamiento previo (missing/huérfano), nunca
  // inventa un agregado sin desglose que lo respalde.
  const delta = extractScenarioDelta("mis gastos fueron 1200: no sé bien en qué");
  assert.equal(delta.gastos_es_detalle, undefined, "sin ≥2 partidas reales, no hay desglose que fijar");
});

// ═══════════════════════════════════════════════════════════════════════════
// MENOR — cap de gastos_items por partida (§8 del contrato: máx 5 versiones)
// ═══════════════════════════════════════════════════════════════════════════

test("MENOR §8: gastos_items respeta el cap de 5 versiones por partida — el activo nunca se pierde", () => {
  let s = mergeScenario(
    {},
    toolArgsToScenarioDelta({ gastos_detalle: [{ nombre: "ocio", monto: 100 }, { nombre: "casa", monto: 900 }] }),
  );
  // 7 correcciones más del mismo nombre ("ocio") — 8 versiones en total.
  for (let i = 1; i <= 7; i++) {
    s = mergeScenario(
      s,
      toolArgsToScenarioDelta({ gastos_detalle: [{ nombre: "ocio", monto: 100 + i * 10 }, { nombre: "casa", monto: 900 }] }),
    );
  }

  const todasLasVersionesDeOcio = (s.gastos_items ?? []).filter((it) => it.name === "ocio");
  assert.ok(todasLasVersionesDeOcio.length <= 5, `nunca más de 5 versiones de 'ocio' en el estado: ${todasLasVersionesDeOcio.length}`);

  const activo = itemsGastoActivos(s.gastos_items).find((it) => it.name === "ocio");
  assert.equal(activo?.amount, 170, "el ACTIVO es siempre el más reciente (100 + 7×10), el cap nunca lo recorta");

  assert.ok((s.gastos_items_colapsados ?? 0) >= 3, `las versiones más viejas de 'ocio' que excedieron el cap se cuentan: ${s.gastos_items_colapsados}`);

  // 'casa' se re-declaró con el MISMO valor cada turno (el tool_call exige
  // ≥2 partidas para registrar algo) — el cap la alcanza igual, pero el
  // activo sigue siendo el correcto.
  const versionesDeCasa = (s.gastos_items ?? []).filter((it) => it.name === "casa");
  assert.ok(versionesDeCasa.length <= 5, `'casa' también respeta el cap: ${versionesDeCasa.length}`);
  assert.equal(itemsGastoActivos(s.gastos_items).find((it) => it.name === "casa")?.amount, 900);
});

// ═══════════════════════════════════════════════════════════════════════════
// P1 (follow-up ronda 4) — LA ESTRUCTURA ES EL ANCLA, SIN REQUERIR KEYWORD.
// `GASTO_CTX` deja de ser requisito de `detectarAgregadoEstructural`: una
// cifra + ":" + lista real de ≥2 partidas ES el agregado, con o sin verbo de
// gasto reconocido. 12 fraseos: los 7 del diagnóstico + 5 nuevos, uno de
// ellos SIN ninguna palabra de gasto.
// ═══════════════════════════════════════════════════════════════════════════

const CASOS_AGREGADO_SIN_KEYWORD: Array<[string, number]> = [
  // Los 7 del diagnóstico de esta tanda
  ["gastando 1200 al mes: internet 300, agua 400, gas 500", 1200],
  ["mis desembolsos son 1200: internet 300, agua 400, gas 500", 1200],
  ["mis salidas mensuales 1200: internet 300, agua 400, gas 500", 1200],
  ["pago 1200 en total: internet 300, agua 400, gas 500", 1200],
  ["se me van 1200: internet 300, agua 400, gas 500", 1200],
  ["presupuesto mensual 1200: internet 300, agua 400, gas 500", 1200],
  ["mis gastos fueron 1200: internet 300, agua 400, gas 500", 1200],
  // 5 fraseos NUEVOS — el primero SIN ninguna palabra de gasto en absoluto.
  ["1200: internet 300, agua 400, gas 500", 1200],
  ["estoy gastando 1300 mensuales: renta 700, comida 400, transporte 200", 1300],
  ["he acabado gastando 1600 este mes: hipoteca 900, super 450, gasolina 250", 1600],
  ["gastándome 1600 al mes: hipoteca 900, super 450, gasolina 250", 1600],
  ["mis egresos son 1600: hipoteca 900, super 450, gasolina 250", 1600],
];

for (const [msg, esperado] of CASOS_AGREGADO_SIN_KEYWORD) {
  test(`P1 sin ancla léxica: "${msg}" → agregado ${esperado}, 3 ítems, CONSISTENT`, () => {
    const delta = extractScenarioDelta(msg);
    assert.equal(delta.gastos_mensuales, esperado);
    assert.equal(delta.gastos_items?.length, 3);
    const suma = delta.gastos_items!.reduce((acc, i) => acc + i.amount, 0);
    assert.equal(suma, esperado, "suma de ítems = agregado — nunca el doble (sin señal de duda)");
    const analisis = analizarExtraccion(msg, delta);
    assert.equal(analisis.extraction_status, "COMPLETE");
  });
}

test("P1: REGRESIÓN — dos listas seguidas ('vitales: ... . no vitales: ...') NUNCA inventan un agregado cruzado", () => {
  // Caso real atrapado por test:regression (escenario deficit_detalle_manda):
  // el punto entre "comida 2000." y "no vitales:" no lleva mayúscula
  // después — `segmentSentences` (numeric-safe pero exige mayúscula tras el
  // punto) no lo reconocía como límite, y el "2000" de "comida" se colaba
  // como agregado de "no vitales:", duplicando el gasto. El límite de
  // cláusula de esta función es más simple y NO exige mayúscula.
  const msg = "vitales: alquiler 2000, seguro 1000, comida 2000. no vitales: ocio 3000, ropa 1000, gimnasio 2000";
  const delta = extractScenarioDelta(msg);
  assert.equal(delta.gastos_mensuales, undefined, "ni 'vitales:' ni 'no vitales:' tienen una cifra propia que declarar");
  assert.equal(delta.gastos_items?.length, 6, "las 6 partidas de ambas listas se conservan igual");
  assert.equal(delta.gastos_items?.reduce((a, i) => a + i.amount, 0), 11000);
});

test("P1: regresión — 'gasto 2 500 €' sigue dando 2500 (sin ':', sin lista — no pasa por la regla estructural)", () => {
  const delta = extractScenarioDelta("gasto 2 500 €");
  assert.equal(delta.gastos_mensuales, 2500);
});

test("P1: regresión — una lista SIN cifra previa ('internet 300, agua 400') sigue siendo solo detalle, sin agregado inventado", () => {
  const delta = extractScenarioDelta("internet 300, agua 400");
  assert.equal(delta.gastos_mensuales, undefined);
  assert.equal(delta.gastos_items?.length, 2);
});

test("P1: regresión — las 15 partidas de testdev7 (sin ':') no se ven afectadas por la regla estructural", () => {
  const delta = extractScenarioDelta(MENSAJE_REAL_TESTDEV7_SCENARIO);
  assert.equal(delta.gastos_es_detalle, true);
  const s = mergeScenario(undefined, delta);
  assert.equal(s.gastos_items?.length, 15);
  assert.equal(s.gastos_items?.reduce((a, i) => a + i.amount, 0), 2250);
});

test("P1: regresión — G1c bidireccional (agregado→detalle y detalle→agregado) da el MISMO conflicto", () => {
  let s1 = mergeScenario({}, extractScenarioDelta("mis gastos son 2200"));
  s1 = mergeScenario(s1, extractScenarioDelta("arriendo 900, comida 500, luz 400, internet 300, ocio 150", "es", s1));
  assert.ok(s1.gastos_conflict, "T1 agregado → T2 detalle: conflicto detectado");
  assert.equal(s1.gastos_conflict?.agregado, 2200);
  assert.equal(s1.gastos_conflict?.detalle, 2250);

  let s2 = mergeScenario({}, extractScenarioDelta("arriendo 900, comida 500, luz 400, internet 300, ocio 150"));
  s2 = mergeScenario(s2, extractScenarioDelta("mis gastos son 2200", "es", s2));
  assert.ok(s2.gastos_conflict, "T1 detalle → T2 agregado: conflicto detectado (bidireccional)");
  assert.equal(s2.gastos_conflict?.agregado, 2200);
  assert.equal(s2.gastos_conflict?.detalle, 2250);
});

// ═══════════════════════════════════════════════════════════════════════════
// Follow-up (tercer diseño) — LA ARITMÉTICA DECIDE EL AGREGADO.
// Tres compuertas en orden: (1) la coma corta la cláusula, (2) el candidato
// no puede estar ya reclamado (V13), (3) reconciliación aritmética contra la
// suma de la lista (umbral de materialidad de §6, MATERIALIDAD_MAX_PCT=5%).
// V19 (nuevo): un agregado ambiguo nunca descarta el resto del delta.
// ═══════════════════════════════════════════════════════════════════════════

test("Compuerta 2: 'gano 2300: arriendo 900, comida 500' — 2300 reclamado por ingreso, gastos = suma del detalle (V19: ingreso SÍ se persiste)", () => {
  const s = mergeScenario({}, extractScenarioDelta("gano 2300: arriendo 900, comida 500"));
  assert.equal(s.ingreso_mensual, 2300);
  assert.equal(s.gastos_mensuales, 1400);
  assert.equal(s.gastos_items?.length, 2);
});

test("Compuerta 2: 'quiero una casa de 150000: arriendo 900, comida 500' — 150000 reclamado por la meta (V19: meta SÍ se persiste)", () => {
  const s = mergeScenario({}, extractScenarioDelta("quiero una casa de 150000: arriendo 900, comida 500"));
  assert.equal(s.meta?.monto, 150000);
  assert.equal(s.gastos_mensuales, 1400);
  assert.equal(s.gastos_items?.length, 2);
});

// ACTUALIZADO (follow-up, crédito fantasma) — esta aserción decía
// `s.credito?.plazo_meses === 48`: exactamente el defecto que esta misma
// tanda corrige (un plazo suelto sin crédito real NO debe persistir). El
// resto del test (Compuerta 2 protege a "cuota" de la mala atribución) sigue
// vigente igual — ver también la cobertura dedicada del fix en
// "crédito fantasma: 'a 48 meses: ...'" más abajo.
test("Compuerta 2: 'a 48 meses: cuota 900, seguro 50' — el plazo reclama su rango como frontera de lista, pero ya NO crea crédito fantasma", () => {
  const s = mergeScenario({}, extractScenarioDelta("a 48 meses: cuota 900, seguro 50"));
  assert.equal(s.credito, undefined, "un plazo suelto sin crédito real no se persiste (fix crédito fantasma)");
  assert.equal(s.gastos_mensuales, 950);
  assert.equal(s.gastos_items?.length, 2);
  const cuota = s.gastos_items?.find((i) => i.name === "cuota");
  assert.equal(cuota?.amount, 900, "'cuota' es una partida de 900, nunca el plazo (48) mal atribuido");
});

test("Compuerta 1 (la coma corta) + Compuerta 3 (rechazo aritmético): 'gano 2300, arriendo 900: comida 500, luz 120' — 900 no reconcilia (45%>5%), se incorpora como ítem", () => {
  const s = mergeScenario({}, extractScenarioDelta("gano 2300, arriendo 900: comida 500, luz 120"));
  assert.equal(s.ingreso_mensual, 2300);
  assert.equal(s.gastos_items?.length, 3, "arriendo se suma como partida, no se descarta");
  const arriendo = s.gastos_items?.find((i) => i.name === "arriendo");
  assert.equal(arriendo?.amount, 900);
  assert.equal(s.gastos_mensuales, 1520, "900 (arriendo) + 500 (comida) + 120 (luz)");
});

test("Compuerta 3 (caso origen, dentro del 5%): 'gasto 2200: [ítems que suman 2250]' → agregado con CONFLICTO material, nunca doble conteo", () => {
  const delta = extractScenarioDelta("gasto 2200: arriendo 900, comida 500, luz 400, internet 300, ocio 150");
  assert.equal(delta.gastos_mensuales, 2200, "2,3% ≤ 5% — SÍ es candidato a agregado");
  const s = mergeScenario({}, delta);
  assert.ok(s.gastos_conflict, "dentro del umbral de materialidad: conflicto, no fusión silenciosa");
  assert.equal(s.gastos_conflict?.agregado, 2200);
  assert.equal(s.gastos_conflict?.detalle, 2250);
  assert.equal(s.gastos_conflict?.diff, 50);
});

test("V19: una lista SIN cifra previa ('internet 300, agua 400, gas 500') → gastos = suma del detalle, sin agregado inventado", () => {
  const s = mergeScenario({}, extractScenarioDelta("internet 300, agua 400, gas 500"));
  assert.equal(s.gastos_mensuales, 1200);
  assert.equal(s.gastos_items?.length, 3);
});

// ── 6 fraseos NUEVOS de esta tanda (distintos de los anteriores) — al menos
// dos SIN ninguna palabra de gasto.
const CASOS_NUEVOS_ARITMETICA: Array<[string, Partial<{ gastos: number; ingreso: number; metaMonto: number; metaPlazo: number; plazo: number; items: number }>]> = [
  ["sueldo 2500, alquiler 950: comida 600, ocio 200", { gastos: 1750, ingreso: 2500, items: 3 }],
  ["el objetivo es 80000: colegio 400, transporte 300", { gastos: 700, metaMonto: 80000, items: 2 }],
  // ACTUALIZADO (follow-up, crédito fantasma) — `plazo: 24` se retira de la
  // expectativa: un plazo suelto sin crédito real ya no se persiste (ver
  // "crédito fantasma: 'a 48 meses: ...'" para la cobertura dedicada).
  ["en 24 meses: cuota 500, mantenimiento 80", { gastos: 580, items: 2 }], // sin palabra de gasto
  ["cobro 1800, luz 300: agua 150, internet 100", { gastos: 550, ingreso: 1800, items: 3 }],
  ["2500: renta 1200, comida 700, transporte 300, ocio 300", { gastos: 2500, items: 4 }], // sin palabra de gasto
  ["mi meta es 90000 a 60 meses: hipoteca 700, seguro 100", { gastos: 800, metaMonto: 90000, metaPlazo: 60, items: 2 }],
];

for (const [msg, esperado] of CASOS_NUEVOS_ARITMETICA) {
  test(`follow-up aritmética, fraseo nuevo: "${msg}"`, () => {
    const s = mergeScenario({}, extractScenarioDelta(msg));
    if (esperado.gastos !== undefined) assert.equal(s.gastos_mensuales, esperado.gastos);
    if (esperado.ingreso !== undefined) assert.equal(s.ingreso_mensual, esperado.ingreso);
    if (esperado.metaMonto !== undefined) assert.equal(s.meta?.monto, esperado.metaMonto);
    if (esperado.metaPlazo !== undefined) assert.equal(s.meta?.plazo_meses, esperado.metaPlazo);
    if (esperado.plazo !== undefined) assert.equal(s.credito?.plazo_meses, esperado.plazo);
    if (esperado.items !== undefined) assert.equal(s.gastos_items?.length, esperado.items);
  });
}

test("regresión: dedup del mensaje de testdev8 sigue en 5 ítems (no 11), suma 2200", () => {
  const delta = extractScenarioDelta(
    "mis gastos fueron 2 200: arriendo 900, comida 500, luz 400, internet 300, ocio 100",
  );
  assert.equal(delta.gastos_mensuales, 2200);
  assert.equal(delta.gastos_items?.length, 5);
  assert.equal(delta.gastos_items?.reduce((a, i) => a + i.amount, 0), 2200);
});

// ═══════════════════════════════════════════════════════════════════════════
// Follow-up (crédito fantasma) — un plazo suelto NUNCA crea `credito` por sí
// solo. Solo completa un crédito que YA EXISTE (monto en este mensaje o en
// el estado persistido); si no, queda como número huérfano relevante (V14)
// y `extraction_status` degrada a PARTIAL, en vez de inventar un crédito.
// ═══════════════════════════════════════════════════════════════════════════

test("crédito fantasma: 'a 48 meses: cuota 900, seguro 50' — credito NULL, gastos 950, 48 huérfano relevante", () => {
  const delta = extractScenarioDelta("a 48 meses: cuota 900, seguro 50");
  assert.equal(delta.credito, undefined, "sin monto ni contexto de crédito, no se crea el objeto");
  const s = mergeScenario({}, delta);
  assert.equal(s.credito, undefined);
  assert.equal(s.gastos_mensuales, 950);
  const cuota = s.gastos_items?.find((i) => i.name === "cuota");
  assert.equal(cuota?.amount, 900, "el 48 no contamina el importe de la primera partida");

  // 48 no cae en `numerosCandidatos` (el filtro general excluye números
  // seguidos de unidad de tiempo), pero SÍ debe registrarse como huérfano
  // relevante de forma explícita — es exactamente el mismo cómputo que usa
  // route.ts de forma independiente sobre (mensaje, delta).
  const analisis = analizarExtraccion("a 48 meses: cuota 900, seguro 50", delta);
  assert.equal(analisis.extraction_status, "PARTIAL");
  assert.ok(analisis.huerfanos.numerosHuerfanos.includes(48), "el plazo suelto se pregunta, no se pierde");
});

test("crédito fantasma: 'quiero un carro de 30000 a 48 meses' — no rompe el caso normal (monto+plazo juntos)", () => {
  const delta = extractScenarioDelta("quiero un carro de 30000 a 48 meses");
  assert.equal(delta.credito?.monto, 30000);
  assert.equal(delta.credito?.plazo_meses, 48);
  const analisis = analizarExtraccion("quiero un carro de 30000 a 48 meses", delta);
  assert.equal(analisis.extraction_status, "COMPLETE");
  assert.equal(analisis.huerfanos.extraccionIncompleta, false, "48 asignado a credito.plazo_meses, no es huérfano aquí");
});

test("crédito fantasma: T1 plazo suelto + T2 'quiero un carro de 30000 a 36 meses' — el crédito real de T2 NO hereda el 48 fantasma de T1", () => {
  let s = mergeScenario({}, extractScenarioDelta("a 48 meses: cuota 900, seguro 50"));
  assert.equal(s.credito, undefined, "T1: sin crédito");
  s = mergeScenario(s, extractScenarioDelta("quiero un carro de 30000 a 36 meses", "es", s));
  assert.equal(s.credito?.monto, 30000);
  assert.equal(s.credito?.plazo_meses, 36, "el crédito real de T2 usa SU PROPIO plazo (36), nunca el 48 fantasma de T1 (G1b)");
});

// ── Hueco verificado (pedido aparte de crédito fantasma) — "quiero un carro
// de 30000 con TAE 9" no extrae ni monto ni TAE. CONFIRMADO, doble causa
// independiente: (1) el bloque de Crédito exige `plazo && amount` EN EL
// MISMO match (sin plazo, no escribe nada) y (2) `PERCENT` exige el símbolo
// "%" literal (sin él, "9" nunca se lee como tasa). Se probó relajar (1) —
// bloque de Crédito con monto sin plazo — y rompió 7 tests ya establecidos:
// `PRECIO_CTX` matchea "carro"/"casa"/"piso" en CUALQUIER posición, incluido
// como NOMBRE DE PARTIDA dentro de una lista de gastos ("...servicios 250
// carro 100 ropa"); `plazo && amount` no era solo "el caso normal", era la
// red de seguridad que evitaba que esa palabra genérica reclamara cualquier
// número cercano. Revertido — este hueco queda DOCUMENTADO, no corregido en
// esta tanda: requiere su propia tanda dedicada (acotar `PRECIO_CTX` a una
// posición de declaración real, no cualquier mención de la palabra), con
// revisión adversarial propia, no un añadido de última hora al fix de
// crédito fantasma.
test("documentado (no corregido): 'quiero un carro de 30000 con TAE 9' no extrae monto ni TAE — el 30000 sigue sin reclamar y el bloque de Meta se lo apropia", () => {
  const delta = extractScenarioDelta("quiero un carro de 30000 con TAE 9");
  assert.equal(delta.credito, undefined, "confirmado: sin plazo en el mensaje, el bloque de crédito no escribe nada");
  assert.equal(delta.meta?.monto, 30000, "confirmado: el 30000 sin reclamar cae en Meta — comportamiento incorrecto, documentado");
});

// ═══════════════════════════════════════════════════════════════════════════
// COMPUERTA G1d — FIDELIDAD DE EXTRACCIÓN (evento de producción, 22 ago).
// V14 (ley de conservación) verificaba la conservación por PERTENENCIA de
// valor ("¿existe algún asignado con este número?"), no por MULTISET: una
// partida capturada podía "cubrir" TODAS las apariciones futuras del mismo
// importe, incluida una partida DISTINTA sin capturar. 6 de 17 partidas
// reales (Amazon Prime 5, Claude 20, Google 10, filtro de agua 10, ayuda a
// la madre 50, ayuda a la suegra 30 — 125 €) se perdieron y el sistema
// certificó COMPLETE con 2.080 € en vez de PARTIAL con 2.205 €, porque sus
// importes coincidían por VALOR con otras partidas SÍ capturadas.
// ═══════════════════════════════════════════════════════════════════════════

// CRITERIO A — fixture PERMANENTE: el mensaje real de las 17 partidas.
const MENSAJE_17_PARTIDAS_G1D =
  "gano 2300 y mis gastos son: arriendo 920, comida 130, colegio 350, transporte 160, " +
  "gasolina 60, cuota del carro 50, seguro 30, gimnasio 80, internet 50, luz 230, " +
  "amazon prime 5, claude 20, spotify 20, google 10, filtro de agua 10, " +
  "ayuda a mi madre 50, ayuda a mi suegra 30";

test("G1d Criterio A: las 17 partidas reales — captura las 17 y suma 2.205 €, NUNCA COMPLETE con 2.080 €", () => {
  const delta = extractScenarioDelta(MENSAJE_17_PARTIDAS_G1D);
  const suma = delta.gastos_items?.reduce((a, i) => a + i.amount, 0) ?? 0;
  if (delta.extraction_status === "COMPLETE") {
    // Si certifica COMPLETE, tiene que ser con las 17 partidas y 2.205 € —
    // PROHIBIDO COMPLETE con 11 partidas y 2.080 € (el incidente real).
    assert.equal(delta.gastos_items?.length, 17, `COMPLETE exige las 17 partidas, no ${delta.gastos_items?.length}`);
    assert.equal(suma, 2205, `COMPLETE exige la suma real (2.205 €), nunca 2.080 €. Suma real: ${suma}`);
  } else {
    // Si no captura las 17, DEBE degradar y citar lo que falta — nunca
    // publicar 2.080 € como si fuera el total real.
    assert.equal(delta.extraction_status, "PARTIAL", `si no hay 17 partidas, el estado debe ser PARTIAL, no ${delta.extraction_status}`);
    assert.notEqual(suma, 2080, "PROHIBIDO publicar 2.080 € (la suma incompleta del incidente real) sin degradar");
  }
  assert.notEqual(delta.gastos_mensuales, 2080, "PROHIBIDO COMPLETE con 2.080 € bajo ninguna circunstancia");
});

// CRITERIO A (regresión directa del incidente) — reproduce el fallo EXACTO:
// un delta que capturó 11 de 17 partidas (simula lo que hizo el tool_call
// real en producción) debe degradar a PARTIAL citando las 6 que faltan —
// nunca certificar COMPLETE con la suma incompleta.
test("G1d: delta incompleto (11 de 17 partidas, simula el tool_call real) → PARTIAL citando las 6 que faltan, NUNCA COMPLETE", () => {
  const capturados: Array<[string, number]> = [
    ["arriendo", 920], ["comida", 130], ["colegio", 350], ["transporte", 160],
    ["gasolina", 60], ["cuota del carro", 50], ["seguro", 30], ["gimnasio", 80],
    ["internet", 50], ["luz", 230], ["spotify", 20],
  ];
  const gastos_items = capturados.map(([name, amount]) => ({
    name, amount, category: "desconocido" as const, source: "regex" as const, turn: 0,
  }));
  const suma = gastos_items.reduce((a, i) => a + i.amount, 0);
  assert.equal(suma, 2080, "confirma la reconstrucción: 11 partidas capturadas suman 2.080 € (el incidente real)");
  const deltaIncompleto = { ingreso_mensual: 2300, gastos_mensuales: suma, gastos_items, gastos_es_detalle: true };
  const analisis = analizarExtraccion(MENSAJE_17_PARTIDAS_G1D, deltaIncompleto);
  assert.equal(analisis.extraction_status, "PARTIAL", "11 de 17 partidas NUNCA es COMPLETE");
  const faltantes = [5, 20, 10, 10, 50, 30];
  for (const v of faltantes) {
    assert.ok(analisis.huerfanos.numerosHuerfanos.includes(v), `${v} debe citarse como huérfano (partida perdida)`);
  }
  assert.equal(analisis.huerfanos.numerosHuerfanos.length, 6, "las 6 partidas perdidas, ni una más ni una menos");
});

// CRITERIO B — AUSENCIA DE FALSOS PARTIAL. Los 5 mensajes exigidos + 3
// inventados: ninguno debe degradar.
const MENSAJES_SIN_FALSO_PARTIAL_G1D = [
  "gano 2300, tengo 43 años y 2 hijos, gasto 2200",
  "quiero una casa de 150000 a 30 años",
  "gano 2500 y gasto 1800",
  "mis gastos fueron 1200: internet 300, agua 400, gas 500",
  "quiero un carro de 30000 a 48 meses con TAE 9",
  // 3 inventados
  "trabajo 8 horas al día, gano 2800 y gasto 2100",
  "mi meta es ahorrar 20000 en 24 meses, gano 3000 y gasto 2200",
  "gano 4000 y gasto 3200 hace 5 años que vivo así",
];

for (const msg of MENSAJES_SIN_FALSO_PARTIAL_G1D) {
  test(`G1d Criterio B (sin falso PARTIAL): "${msg}"`, () => {
    const delta = extractScenarioDelta(msg);
    const analisis = analizarExtraccion(msg, delta);
    assert.equal(
      analisis.extraction_status,
      "COMPLETE",
      `no debe degradar — huérfanos: ${JSON.stringify(analisis.huerfanos.numerosHuerfanos)}`,
    );
  });
}

// V13 explícito — un número YA RECLAMADO por un patrón declarativo (ingreso)
// no puede ADEMÁS contarse como huérfano sin asignar (si no, el ingreso
// dispararía PARTIAL en cada mensaje).
test("G1d respeta V13: el ingreso reclamado no se cuenta dos veces como huérfano", () => {
  const delta = extractScenarioDelta("gano 2300 y gasto 1800");
  const analisis = analizarExtraccion("gano 2300 y gasto 1800", delta);
  assert.equal(analisis.extraction_status, "COMPLETE");
  assert.equal(analisis.huerfanos.numerosHuerfanos.length, 0);
});

// Salvaguarda del nuevo clasificador de tasas: no debe absorber un IMPORTE
// monetario real solo porque una palabra de tasa/interés aparece cerca —
// solo excluye el número cuando NO hay "%" NI marca de moneda después.
test("G1d: 'intereses de 500 euros' (importe real, no tasa) sigue contando como candidato financiero", () => {
  const delta = extractScenarioDelta("gano 2300 y pago intereses de 500 euros al mes");
  const analisis = analizarExtraccion("gano 2300 y pago intereses de 500 euros al mes", delta);
  assert.ok(
    analisis.huerfanos.numerosHuerfanos.includes(500) || delta.gastos_mensuales === 500 || delta.credito?.monto === 500,
    "500 € de intereses reales no debe desaparecer silenciosamente clasificado como 'tasa sin signo'",
  );
});

test("G1d: 'TAE 9%' (con signo) sigue capturándose con normalidad — el clasificador de tasas no interfiere", () => {
  const delta = extractScenarioDelta("quiero un carro de 30000 a 48 meses con TAE 9%");
  assert.equal(delta.credito?.tae_pct, 9);
  assert.equal(delta.extraction_status, "COMPLETE");
});

// ═══════════════════════════════════════════════════════════════════════════
// CIERRE G1d — RESERVA DE AG01: la tolerancia ÷12/×12 (año↔mes) sin marca
// anual explícita era una puerta trasera del multiset. "renta 1000, comida
// 200, luz 100" con solo 2 de 3 partidas capturadas (agregado=1200, la suma
// de las 2 capturadas) daba COMPLETE porque 1200/12 = 100 — el AGREGADO
// "cubría" por aritmética pura la partida perdida (luz, 100), sin relación
// real entre ambos números. Fix: la tolerancia ÷12/×12 exige que el
// candidato traiga una marca anual explícita ("al año", "anual"…) en el
// propio mensaje — sin ella, solo se admite el redondeo ±1.
// ═══════════════════════════════════════════════════════════════════════════

test("G1d (reserva AG01): 'renta 1000, comida 200, luz 100' con solo 2 de 3 capturadas → PARTIAL citando el 100, NUNCA COMPLETE por ÷12", () => {
  const mensaje = "renta 1000, comida 200, luz 100";
  const deltaIncompleto = {
    gastos_mensuales: 1200, // suma de las 2 partidas SÍ capturadas — el agregado real
    gastos_items: [
      { name: "renta", amount: 1000, category: "vital" as const, source: "regex" as const, turn: 0 },
      { name: "comida", amount: 200, category: "vital" as const, source: "regex" as const, turn: 0 },
    ],
  };
  const analisis = analizarExtraccion(mensaje, deltaIncompleto);
  assert.equal(analisis.extraction_status, "PARTIAL", "1200/12=100 NO debe cubrir la partida perdida (luz, sin marca anual)");
  assert.ok(analisis.huerfanos.numerosHuerfanos.includes(100), "el 100 de 'luz' debe citarse como huérfano");
});

test("G1d (reserva AG01): control — 'renta 1000, comida 200, luz 150' con la misma pérdida (2 de 3) → PARTIAL", () => {
  const mensaje = "renta 1000, comida 200, luz 150";
  const deltaIncompleto = {
    gastos_mensuales: 1200,
    gastos_items: [
      { name: "renta", amount: 1000, category: "vital" as const, source: "regex" as const, turn: 0 },
      { name: "comida", amount: 200, category: "vital" as const, source: "regex" as const, turn: 0 },
    ],
  };
  const analisis = analizarExtraccion(mensaje, deltaIncompleto);
  assert.equal(analisis.extraction_status, "PARTIAL");
  assert.ok(analisis.huerfanos.numerosHuerfanos.includes(150));
});

test("G1d (reserva AG01): 'gano 27600 al año' con delta ingreso_mensual 2300 (extractor que SÍ anualiza) → sigue COMPLETE, sin huérfanos", () => {
  const mensaje = "gano 27600 al año";
  const delta = { ingreso_mensual: 2300 };
  const analisis = analizarExtraccion(mensaje, delta);
  assert.equal(analisis.extraction_status, "COMPLETE", "la marca 'al año' SÍ autoriza la tolerancia ÷12 (27600/12=2300)");
  assert.equal(analisis.huerfanos.numerosHuerfanos.length, 0);
});

test("G1d (reserva AG01): el mismo importe SIN 'al año' no goza de la tolerancia ÷12/×12", () => {
  const mensaje = "gano 27600 este mes";
  const delta = { ingreso_mensual: 2300 };
  const analisis = analizarExtraccion(mensaje, delta);
  assert.equal(analisis.extraction_status, "PARTIAL", "sin marca anual, 27600 no puede cubrirse con un ingreso_mensual de 2300");
  assert.ok(analisis.huerfanos.numerosHuerfanos.includes(27600));
});
