// Tests del scenario state (el motor recuerda entre turnos).

import { test } from "node:test";
import assert from "node:assert/strict";

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
  detectarEventosICA,
} from "./scenario";

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
  assert.deepEqual(extractScenarioDelta("hola, no sé muy bien qué hacer"), {});
  assert.deepEqual(extractScenarioDelta("gracias por la ayuda"), {});
  // Un porcentaje SIN contexto de tasa no se toma como TAE.
  assert.deepEqual(extractScenarioDelta("me gusta el 20% de las cosas"), {});
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
  assert.deepEqual(extractScenarioDelta("18%", "es"), {});
  assert.deepEqual(extractScenarioDelta("18%", "es", {}), {});
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
test("B: agregado 2372 en T1; lista en T2 → gastos NUNCA el primer ítem (15)", () => {
  const s = mergeScenario({}, extractScenarioDelta("Gano 2636 euros al mes y mis gastos son 2372."));
  assert.equal(s.gastos_mensuales, 2372);
  const s2 = mergeScenario(s, extractScenarioDelta("Mis gastos: netflix 15, luz 80, agua 30, cerveza 120, mercado 400"));
  assert.notEqual(s2.gastos_mensuales, 15, "la lista NO se toma como si el primer ítem fuera el agregado");
  assert.equal(s2.gastos_es_detalle, true, "se marca el detalle");
  assert.equal(s2.gastos_detalle?.vitales, 510);
  assert.equal(s2.gastos_detalle?.noVitales, 135);
});

// ── BUG 1 — el detalle manda SIEMPRE sobre el agregado ───────────────────────
// QA real: vitales 2000+1000+2000=5000, no vitales 3000+1000+2000=6000 → total
// 11.000. El motor reportaba 10.000 (el agregado viejo, obsoleto) y sobrante 0.
test("BUG 1: caso real QA — el detalle (11000) pisa el agregado viejo (10000), no se queda en 10000", () => {
  let s = mergeScenario({}, extractScenarioDelta("Gano 10000 euros al mes y mis gastos son 10000."));
  assert.equal(s.gastos_mensuales, 10000);
  s = mergeScenario(
    s,
    extractScenarioDelta("vitales: alquiler 2000, seguro 1000, comida 2000. no vitales: ocio 3000, ropa 1000, gimnasio 2000"),
  );
  assert.equal(s.gastos_detalle?.vitales, 5000);
  assert.equal(s.gastos_detalle?.noVitales, 6000);
  assert.equal(s.gastos_mensuales, 11000, "el detalle (5000+6000) pisa el agregado obsoleto (10000)");
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

test("detectarEventosICA: desglose nuevo → detalle_gastos", () => {
  const antes = mergeScenario({}, { gastos_mensuales: 2000 });
  const despues = mergeScenario(antes, extractScenarioDelta("netflix 15, luz 80, agua 30"));
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
