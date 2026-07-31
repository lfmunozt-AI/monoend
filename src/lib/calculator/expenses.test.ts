// Tests del clasificador de gastos. Runner nativo de Node (node:test) vía tsx.

import { test } from "node:test";
import assert from "node:assert/strict";

import { classifyExpense, classifyExpenses, parseExpenseList } from "./expenses";

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
