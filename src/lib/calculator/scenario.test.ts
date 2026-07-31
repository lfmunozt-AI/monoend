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
