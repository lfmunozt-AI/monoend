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

test("BUG 3: sin objeto reconocible en el mensaje → título genérico 'compra financiada'", () => {
  const s = mergeScenario(undefined, extractScenarioDelta("Quiero financiar 30000 a 36 meses."));
  assert.equal(s.meta?.titulo, "compra financiada");
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
  assert.match(nota!, /3 turnos fuera de la meta activa 'Carro'/);
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
