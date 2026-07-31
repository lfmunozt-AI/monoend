// Tests del parser numérico: sufijo "k" ("2,5k") y la convención de millares
// es/LatAm (punto = miles, coma = decimal). El espacio COMO separador de
// miles se retiró en la 8ª tanda (FIX 1, testdev7) — ver los tests de esa
// sección más abajo. Runner nativo de Node (node:test) vía tsx. Ejecutar:
// `npm test`.

import { test } from "node:test";
import assert from "node:assert/strict";

import { parseDigitAmount, findNumberMentions } from "./numbers";

// FIX 1 (8ª tanda, testdev7) — BUG BLOQUEANTE: el espacio como separador de
// miles fusionaba partidas SIN relación entre sí ("60 100" de un desglose de
// gastos → 60100, un error aritmético de cientos de euros). El separador de
// miles real en ES/PT es el PUNTO; el espacio ya NO agrupa — dos números
// separados por un espacio son DOS números.
test("numbers: el espacio YA NO es separador de miles — 'tengo 2 500 pesos' → dos números [2, 500]", () => {
  const vals = findNumberMentions("tengo 2 500 pesos").map((m) => m.value);
  assert.deepEqual(vals, [2, 500]);
});

test("numbers: caso real testdev7 — '60 100' (dos partidas de un desglose) → [60, 100], NUNCA 60100", () => {
  const vals = findNumberMentions("Telecomunicaciones 60 100 Pañales").map((m) => m.value);
  assert.ok(!vals.includes(60100), `60100 NUNCA debe aparecer: ${JSON.stringify(vals)}`);
  assert.ok(vals.includes(60) && vals.includes(100), `esperaba 60 y 100 por separado: ${JSON.stringify(vals)}`);
});

test("numbers: '2.400 €' (punto = millares, la convención real) SIGUE uniéndose en 2400", () => {
  const vals = findNumberMentions("cuesta 2.400 €").map((m) => m.value);
  assert.deepEqual(vals, [2400]);
});

test("numbers: sufijo k '2,5k' → 2500", () => {
  const vals = findNumberMentions("ahorro 2,5k al mes").map((m) => m.value);
  assert.ok(vals.includes(2500), `esperaba 2500 en ${JSON.stringify(vals)}`);
});

test("numbers: sufijo k entero '3k' → 3000", () => {
  const vals = findNumberMentions("gano 3k").map((m) => m.value);
  assert.ok(vals.includes(3000), `esperaba 3000 en ${JSON.stringify(vals)}`);
});

test("numbers: NO rompe convención es/LatAm existente", () => {
  assert.equal(parseDigitAmount("40000"), 40000);
  assert.equal(parseDigitAmount("1.200"), 1200);
  assert.equal(parseDigitAmount("1.200,50"), 1200.5);
  assert.equal(parseDigitAmount("1.200.000"), 1200000);
  assert.deepEqual(findNumberMentions("tengo 40000").map((m) => m.value), [40000]);
});

test("numbers: 'k' pegada a otra letra NO se interpreta como miles ('2kg')", () => {
  const vals = findNumberMentions("compré 2kg de café").map((m) => m.value);
  assert.ok(vals.includes(2), `esperaba 2 en ${JSON.stringify(vals)}`);
  assert.ok(!vals.includes(2000), "no debe convertir 2kg en 2000");
});
