// Tests del clasificador de gastos. Runner nativo de Node (node:test) vía tsx.

import { test } from "node:test";
import assert from "node:assert/strict";

import { classifyExpense, classifyExpenses } from "./expenses";

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
