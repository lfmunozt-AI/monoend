// Tests del clasificador de gastos. Runner nativo de Node (node:test) vía tsx.

import { test } from "node:test";
import assert from "node:assert/strict";

import { classifyExpense, classifyExpenses, parseExpenseList, parseExpenseListDetallado, detectarItemSospechosoPorMagnitud } from "./expenses";

test("clasificación ES: vitales, no vitales, desconocido", () => {
  assert.equal(classifyExpense("luz"), "vital");
  assert.equal(classifyExpense("alquiler"), "vital");
  assert.equal(classifyExpense("mercado"), "vital");
  assert.equal(classifyExpense("netflix"), "no_vital");
  assert.equal(classifyExpense("cerveza"), "no_vital");
  assert.equal(classifyExpense("gimnasio"), "no_vital");
  assert.equal(classifyExpense("veterinario"), "desconocido");
});

test("clasificación PT (con y sin acentos)", () => {
  assert.equal(classifyExpense("renda"), "vital");
  assert.equal(classifyExpense("eletricidade"), "vital");
  assert.equal(classifyExpense("saúde"), "vital");
  assert.equal(classifyExpense("cerveja"), "no_vital");
  assert.equal(classifyExpense("assinatura"), "no_vital");
});

test("clasificación EN", () => {
  assert.equal(classifyExpense("rent"), "vital");
  assert.equal(classifyExpense("electricity"), "vital");
  assert.equal(classifyExpense("groceries"), "vital");
  assert.equal(classifyExpense("beer"), "no_vital");
  assert.equal(classifyExpense("gaming"), "no_vital");
  assert.equal(classifyExpense("streaming"), "no_vital");
});

test("no confunde 'aguacate' con 'agua' (palabra completa)", () => {
  assert.equal(classifyExpense("aguacate"), "desconocido");
  assert.equal(classifyExpense("agua"), "vital");
});

test("lista mixta ES/PT/EN → totales correctos por grupo", () => {
  const r = classifyExpenses([
    { name: "luz", amount: 50 },
    { name: "renda", amount: 800 },     // PT vital
    { name: "netflix", amount: 100 },
    { name: "beer", amount: 30 },       // EN no vital
    { name: "veterinario", amount: 60 }, // desconocido
  ]);
  assert.equal(r.vitales.total, 850, "50 + 800");
  assert.equal(r.noVitales.total, 130, "100 + 30");
  assert.equal(r.desconocidos.total, 60);
  assert.equal(r.vitales.items.length, 2);
  assert.equal(r.noVitales.items.length, 2);
  assert.equal(r.desconocidos.items.length, 1);
});

test("recorte = 50% de no vitales; los desconocidos NO entran al recorte", () => {
  const r = classifyExpenses([
    { name: "netflix", amount: 100 },
    { name: "cerveza", amount: 80 },
    { name: "veterinario", amount: 200 }, // desconocido, alto, NO cuenta
  ]);
  assert.equal(r.noVitales.total, 180);
  assert.equal(r.factorRecorte, 0.5);
  assert.equal(r.recortePropuesto, 90, "50% de 180, sin tocar el desconocido");
});

test("caso del reporte: netflix100 luz50 agua30 cerveza80 mercado90", () => {
  const r = classifyExpenses([
    { name: "netflix", amount: 100 },
    { name: "luz", amount: 50 },
    { name: "agua", amount: 30 },
    { name: "cerveza", amount: 80 },
    { name: "mercado", amount: 90 },
  ]);
  assert.equal(r.vitales.total, 170, "luz 50 + agua 30 + mercado 90");
  assert.equal(r.noVitales.total, 180, "netflix 100 + cerveza 80");
  assert.equal(r.recortePropuesto, 90, "mitad de 180");
  assert.equal(r.desconocidos.items.length, 0);
});

test("lista vacía → todo 0, recorte 0", () => {
  const r = classifyExpenses([]);
  assert.equal(r.vitales.total, 0);
  assert.equal(r.noVitales.total, 0);
  assert.equal(r.recortePropuesto, 0);
});

// ── BUG BLOQUEANTE (6ª tanda, testdev5) — nombres que terminan en conector ───
// "...dudo entre 200000, 300000 o 150000" (candidatas de precio de una meta
// sin decidir) se colaba como DOS ítems de gasto: {"dudo entre": 200000} y
// {"o": 150000} — el detalle de gastos se recalculaba mal (BUG 1: el detalle
// manda sobre el agregado) sobre datos que NUNCA fueron gastos.

test("parseExpenseList: 'dudo entre X, Y o Z' NO se confunde con una lista de gastos", () => {
  const msg = "y ademas estoy pensando en comprar una casa, dudo entre 200000, 300000 o 150000";
  assert.deepEqual(parseExpenseList(msg), []);
});

test("parseExpenseList: nombres reales que SÍ terminan en palabra normal siguen funcionando", () => {
  const msg = "netflix 15, luz 80, agua 30";
  const items = parseExpenseList(msg);
  assert.equal(items.length, 3);
  assert.deepEqual(items.map((i) => i.amount).sort((a, b) => a - b), [15, 30, 80]);
});

test("parseExpenseList: 'compras en supermercado 400, luz 50' — el nombre puede contener una preposición EN MEDIO", () => {
  // La exclusión es solo cuando el nombre TERMINA en conector — "en
  // supermercado" no termina en preposición, sigue siendo un nombre válido.
  const items = parseExpenseList("compras en supermercado 400, luz 50");
  const supermercado = items.find((i) => i.name.includes("supermercado"));
  assert.ok(supermercado, `debería reconocer el nombre con preposición interna: ${JSON.stringify(items)}`);
  assert.equal(supermercado?.amount, 400);
});

// ── FIX 6 (7ª tanda, testdev6) — CLASIFICADOR DE GASTOS INOPERANTE ───────────
// "arriendo" (alquiler, término LatAm) y "servicios" (suministros, término
// LatAm) caían a "desconocido" — el diálogo real quedó con
// gastos_detalle={vitales:0, noVitales:0, desconocidos:2200} pese a que el
// usuario listó exactamente esas dos partidas, dejando el clasificador
// inoperante (sin vitales/no vitales no hay plan de recorte posible).

test("FIX 6: 'arriendo' se clasifica como VITAL (vivienda, término LatAm)", () => {
  assert.equal(classifyExpense("arriendo"), "vital");
});

test("FIX 6: 'servicios' se clasifica como VITAL (suministros, término LatAm)", () => {
  assert.equal(classifyExpense("servicios"), "vital");
});

test("FIX 6: caso real testdev6 — 'arriendo 1000, servicios 500' → clasificados, NO desconocidos", () => {
  const items = parseExpenseList("arriendo 1000, servicios 500");
  const r = classifyExpenses(items);
  assert.equal(r.vitales.total, 1500, `arriendo + servicios deben ir a vitales: ${JSON.stringify(r)}`);
  assert.equal(r.desconocidos.total, 0, "nada debería quedar sin clasificar");
});

test("FIX 6: 'renta' NO se añade a vitales (colisión deliberada con 'renta fija'/'renta variable')", () => {
  assert.equal(classifyExpense("renta"), "desconocido");
});

// ── PIEZA 3/4 (8ª tanda, testdev7) — extracción honesta ──────────────────────
// Casos de aceptación obligatorios de "ag08: extracción honesta". Ver también
// scenario.test.ts para los casos que dependen del pipeline completo
// (extraction_status, huérfanos clasificados).

// Caso 9 — "60 100" pegado por el parser numérico: dos números adyacentes
// separados solo por espacio son estructuralmente la MISMA forma que "2 500"
// (caso 10, miles con espacio). Como SÍ hay un nombre disponible después
// (Pañales_Bebe_Vital) para reclamar el segundo número, se separan — pero se
// marca sospechoso para que el eco confirme la lectura.
test("caso 9: 'Telecomunicaciones_Necesario 60 100 Pañales_Bebe_Vital' → 2 ítems + item_sospechoso expuesto", () => {
  const r = parseExpenseListDetallado("Telecomunicaciones_Necesario 60 100 Pañales_Bebe_Vital");
  assert.equal(r.items.length, 2);
  assert.deepEqual(r.items.map((i) => i.amount).sort((a, b) => a - b), [60, 100]);
  assert.ok(r.itemSospechoso, "debería exponer un ítem sospechoso de pegado");
  assert.equal(r.itemSospechoso?.amount, 60100, "la lectura alternativa (glueada) que se le propone al usuario");
});

// Caso 10 — regresión: "2 500" (miles con espacio) NO se separa en dos ítems
// cuando no hay nombre disponible para el segundo número (fin de la partida)
// — es la MISMA convención que el parser general (guardrail/numbers.ts).
test("caso 10: 'alquiler 2 500, luz 80' → alquiler=2500 (miles con espacio), sin sospechoso", () => {
  const r = parseExpenseListDetallado("alquiler 2 500, luz 80");
  assert.equal(r.items.length, 2);
  const alquiler = r.items.find((i) => i.name === "alquiler");
  assert.equal(alquiler?.amount, 2500);
  assert.equal(r.itemSospechoso, null);
});

// Caso 13 — nombres con guion bajo: el regex anterior solo aceptaba letras y
// espacios, así que NINGUNA partida del caso real (todas con "_") matcheaba.
test("caso 13: 'Diezmo_Vital 225, Casa_Vital 700' → 2 ítems con guion bajo en el nombre", () => {
  const items = parseExpenseList("Diezmo_Vital 225, Casa_Vital 700");
  assert.equal(items.length, 2);
  assert.deepEqual(
    items.map((i) => [i.name, i.amount]).sort((a, b) => (a[0] as string).localeCompare(b[0] as string)),
    [["Casa_Vital", 700], ["Diezmo_Vital", 225]],
  );
});

// Caso 14 — sin comas: "nombre monto nombre monto…" corrido.
test("caso 14: 'alquiler 700 comida 450 luz 120' (sin comas) → 3 ítems", () => {
  const items = parseExpenseList("alquiler 700 comida 450 luz 120");
  assert.equal(items.length, 3);
  assert.deepEqual(items.map((i) => i.amount).sort((a, b) => a - b), [120, 450, 700]);
});

// Caso 15 — con dos puntos: "Nombre: Monto, Nombre: Monto".
test("caso 15: 'Alquiler: 700, Comida: 450, Luz: 120' → 3 ítems", () => {
  const items = parseExpenseList("Alquiler: 700, Comida: 450, Luz: 120");
  assert.equal(items.length, 3);
  assert.deepEqual(
    items.map((i) => [i.name, i.amount]).sort((a, b) => (a[1] as number) - (b[1] as number)),
    [["Luz", 120], ["Comida", 450], ["Alquiler", 700]],
  );
});

// Caso 16 — EL MENSAJE REAL (testdev7, 31/07 21:20): 15 partidas mezclando
// "nombre monto", "monto nombre" e incluso ambos órdenes dentro de la MISMA
// partida ("700 Casa_Vital Supermercado_Vital 450"). Suma real 2.250 €.
const MENSAJE_REAL_TESTDEV7 =
  "Diezmo_Vital 225, 700 Casa_Vital Supermercado_Vital 450, 120 Servicios_Vitales, " +
  "Telecomunicaciones_Necesario 60 100 Pañales_Bebe_Vital, Colegio_Niño_Necesario 150 " +
  "Transporte_Necesario 100, 80 Ropa_Posible, Ocio_Familiar 60 40 Farmacia_Vital, " +
  "Suscripciones_Ocio 25 40 Gimnasio_Necesario, 60 Ahorro_Posible Gastos_Varios_Posible 40";

// ── CALIBRACIÓN (revisión adversarial AG01, 2026-08-06) — riesgo de falso
// positivo señalado explícitamente: una hipoteca grande entre gastos
// pequeños NO es un pegado, es un presupuesto real. El umbral literal de
// "10 × mediana" del encargo original SÍ la marcaba (1200 > 10×47.5=475);
// se calibró a 50× tras medir ambos casos reales (ver expenses.ts).
test("detectarItemSospechosoPorMagnitud: hipoteca 1200 entre gastos 40-60 → NO sospechoso (riesgo de falso positivo)", () => {
  const items = [
    { name: "hipoteca", amount: 1200 },
    { name: "luz", amount: 50 },
    { name: "agua", amount: 40 },
    { name: "telefono", amount: 60 },
    { name: "internet", amount: 45 },
  ];
  assert.equal(detectarItemSospechosoPorMagnitud(items), null);
});

test("detectarItemSospechosoPorMagnitud: una cifra ~600× la mediana SÍ se marca (caso real 60100)", () => {
  const items = [
    { name: "a", amount: 90 }, { name: "b", amount: 85 }, { name: "c", amount: 95 },
    { name: "glued", amount: 60100 },
  ];
  const r = detectarItemSospechosoPorMagnitud(items);
  assert.equal(r?.name, "glued");
});

test("detectarItemSospechosoPorMagnitud: con agregado conocido, un ítem < 3× el agregado no se marca aunque supere la mediana", () => {
  // Suelo absoluto: 1200 < 3 × 2000 (agregado) → gasto grande plausible.
  const items = [
    { name: "hipoteca", amount: 1200 },
    { name: "luz", amount: 50 },
    { name: "agua", amount: 40 },
  ];
  assert.equal(detectarItemSospechosoPorMagnitud(items, 2000), null);
});

test("caso 16: mensaje real testdev7 → 15 ítems, suma 2250, buckets coherentes", () => {
  const r = parseExpenseListDetallado(MENSAJE_REAL_TESTDEV7);
  assert.equal(r.items.length, 15, `esperaba 15 ítems: ${JSON.stringify(r.items)}`);
  const suma = r.items.reduce((a, b) => a + b.amount, 0);
  assert.equal(suma, 2250);

  const cls = classifyExpenses(r.items);
  assert.equal(
    cls.vitales.total + cls.noVitales.total + cls.desconocidos.total,
    2250,
    "los buckets deben sumar lo mismo que los ítems — nunca al revés (items → clasificación → buckets)",
  );
});
