// Tests del clasificador de gastos. Runner nativo de Node (node:test) vía tsx.

import { test } from "node:test";
import assert from "node:assert/strict";

import { classifyExpense, classifyExpenses, parseExpenseList, extraerDesgloseIrregular } from "./expenses";

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

// ── FIX 3 (8ª tanda, testdev7) — DESGLOSE IRREGULAR ──────────────────────────
// "Diezmo_Vital 225, 700 Casa_Vital..." — 15 partidas, orden mixto
// (nombre-monto Y monto-nombre en el MISMO mensaje), etiquetas con guion
// bajo. `parseExpenseList` fallaba por completo (0 partidas, las 15 cifras
// caían a huérfano). Suma real: 2.250 € — el usuario había declarado 2.200 €
// antes: una trampa de 50 € que el propio usuario no notó.
const MSG_TESTDEV7 =
  "Diezmo_Vital 225, 700 Casa_Vital Supermercado_Vital 450, 120 Servicios_Vitales, " +
  "Telecomunicaciones_Necesario 60 100 Pañales_Bebe_Vital, Colegio_Niño_Necesario 150 " +
  "Transporte_Necesario 100, 80 Ropa_Posible, Ocio_Familiar 60 40 Farmacia_Vital, " +
  "Suscripciones_Ocio 25 40 Gimnasio_Necesario, 60 Ahorro_Posible Gastos_Varios_Posible 40";

test("FIX 3: caso real testdev7 — 15 partidas extraídas, suma exacta 2.250 €", () => {
  const items = extraerDesgloseIrregular(MSG_TESTDEV7);
  assert.ok(items, "debe extraer un desglose (≥4 partidas)");
  assert.equal(items!.length, 15, `esperaba 15 partidas: ${JSON.stringify(items)}`);
  const suma = items!.reduce((a, b) => a + b.amount, 0);
  assert.equal(suma, 2250, `la suma debe ser exactamente 2250: ${JSON.stringify(items)}`);
});

test("FIX 3: nombre-monto y monto-nombre mezclados en el MISMO mensaje, ambos órdenes correctos", () => {
  const items = extraerDesgloseIrregular(MSG_TESTDEV7);
  const porNombre = new Map(items!.map((i) => [i.name, i.amount]));
  assert.equal(porNombre.get("Diezmo Vital"), 225, "orden nombre-monto");
  assert.equal(porNombre.get("Casa Vital"), 700, "orden monto-nombre");
});

test("FIX 3: menos de 4 pares → null (no lo suficientemente inequívoco)", () => {
  assert.equal(extraerDesgloseIrregular("Diezmo_Vital 225, 700 Casa_Vital"), null);
});

test("FIX 3: NO reabre el bug de la 5ª/6ª tanda — 'gano 2300 y gasto= 1000 arriendo 500 servicios 250 carro 100 ropa' sigue dando SOLO las 4 partidas reales", () => {
  const msg = "peinso que mi ahorro es una desastre, gano 2300 y gasto= 1000 arriendo 500 servicios 250 carro 100 ropa";
  const items = extraerDesgloseIrregular(msg);
  assert.ok(items, "debe extraer un desglose");
  assert.equal(items!.length, 4, `NUNCA debe capturar 'gano'/'gasto=' como partidas: ${JSON.stringify(items)}`);
  const nombres = items!.map((i) => i.name).sort();
  assert.deepEqual(nombres, ["arriendo", "carro", "ropa", "servicios"]);
});

test("FIX 3: etiqueta compuesta que CONTIENE una palabra de NO_ES_GASTO ('Ahorro_Posible') SÍ se acepta", () => {
  // Distinto del caso anterior: "ahorro" suelto se excluye, pero
  // "Ahorro_Posible" es una CATEGORÍA compuesta propia del usuario dentro de
  // un desglose ya inequívoco (≥4 partidas) — no una mención aislada.
  const items = extraerDesgloseIrregular(MSG_TESTDEV7);
  const porNombre = new Map(items!.map((i) => [i.name, i.amount]));
  assert.equal(porNombre.get("Ahorro Posible"), 60);
  assert.equal(porNombre.get("Gastos Varios Posible"), 40);
});
