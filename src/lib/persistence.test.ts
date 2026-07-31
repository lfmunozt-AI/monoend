// Tests de persistTurn (AG08, 7ª tanda). Solo la parte pura (serializarError)
// se prueba en unitario — las escrituras reales contra Supabase las cubre el
// E2E (scripts/e2e-turn.ts, npm run test:e2e), no un mock.

import { test } from "node:test";
import assert from "node:assert/strict";

import { serializarError, seleccionarMetaActivaAActualizar } from "./persistence";

// ── FIX 7 (7ª tanda, testdev6) — LOG DE ERROR LEGIBLE ────────────────────────
// `err instanceof Error ? err.message : String(err)` serializaba un
// PostgrestError (objeto plano, NO instancia de Error) como "[object Object]"
// — inútil para depurar un fallo real de escritura en producción.

test("FIX 7: PostgrestError (objeto plano, NO instancia de Error) se desglosa en message/code/details", () => {
  const postgrestError = {
    message: "duplicate key value violates unique constraint",
    code: "23505",
    details: "Key (id)=(x) already exists.",
    hint: null,
  };
  assert.equal(postgrestError instanceof Error, false, "precondición: PostgrestError NO es instanceof Error");
  const out = serializarError(postgrestError);
  assert.equal(out.message, "duplicate key value violates unique constraint");
  assert.equal(out.code, "23505");
  assert.equal(out.details, "Key (id)=(x) already exists.");
});

test("FIX 7: un Error nativo se sigue serializando por su .message", () => {
  const out = serializarError(new Error("algo falló"));
  assert.equal(out.message, "algo falló");
  assert.equal(out.code, undefined);
});

test("FIX 7: un valor no-objeto (string/undefined) no rompe — cae a String(err)", () => {
  assert.equal(serializarError("fallo plano").message, "fallo plano");
  assert.equal(serializarError(undefined).message, "undefined");
});

test("FIX 7: NUNCA produce '[object Object]' para un objeto con .message", () => {
  const out = serializarError({ message: "algo pasó" });
  assert.notEqual(out.message, "[object Object]");
});

// ── FIX 5 (8ª tanda, testdev7) — UNA META, UNA FILA ──────────────────────────
// BUG real: `scenario.meta.titulo` es texto libre que el usuario refina turno
// a turno ("ahorrar para un auto" → "ahorrar 15.000€ para un auto usado") —
// el match ANTERIOR (título EXACTO) archivaba la fila vieja e insertaba una
// nueva cada vez que el texto cambiaba, aunque fuera la MISMA meta. Ahora se
// matchea por categoría inferida (o por ser la única activa) — solo un
// cambio de CATEGORÍA con más de una activa dispara una fila nueva.

test("FIX 5: una sola meta activa → SIEMPRE se actualiza, aunque la categoría nueva difiera (sin ambigüedad posible)", () => {
  const activas = [{ id: "g1", title: "ahorrar para un auto", category: "vehicle" }];
  const out = seleccionarMetaActivaAActualizar(activas, "property");
  assert.equal(out?.id, "g1");
});

test("FIX 5: refinamiento de título con la MISMA categoría → actualiza la existente, no inserta", () => {
  const activas = [{ id: "g1", title: "ahorrar para un auto", category: "vehicle" }];
  const out = seleccionarMetaActivaAActualizar(activas, "vehicle");
  assert.equal(out?.id, "g1");
});

test("FIX 5: sin ninguna meta activa → undefined (el turno inserta la primera fila)", () => {
  assert.equal(seleccionarMetaActivaAActualizar([], "vehicle"), undefined);
});

test("FIX 5: varias activas (duplicados heredados) y una coincide en categoría → esa se actualiza", () => {
  const activas = [
    { id: "g1", title: "fondo de emergencia", category: "emergency_fund" },
    { id: "g2", title: "comprar un auto", category: "vehicle" },
  ];
  const out = seleccionarMetaActivaAActualizar(activas, "vehicle");
  assert.equal(out?.id, "g2");
});

test("FIX 5: varias activas y NINGUNA coincide en categoría → undefined (cambio explícito: archiva todas, inserta nueva)", () => {
  const activas = [
    { id: "g1", title: "fondo de emergencia", category: "emergency_fund" },
    { id: "g2", title: "comprar un auto", category: "vehicle" },
  ];
  assert.equal(seleccionarMetaActivaAActualizar(activas, "property"), undefined);
});
