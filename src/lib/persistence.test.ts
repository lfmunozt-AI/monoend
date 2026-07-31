// Tests de persistTurn (AG08, 7ª tanda). Solo la parte pura (serializarError)
// se prueba en unitario — las escrituras reales contra Supabase las cubre el
// E2E (scripts/e2e-turn.ts, npm run test:e2e), no un mock.

import { test } from "node:test";
import assert from "node:assert/strict";

import { serializarError } from "./persistence";

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
