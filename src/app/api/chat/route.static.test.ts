// PIEZA 8a (AG08, 6ª tanda) — verificación ESTÁTICA de que route.ts persiste
// el turno por el punto único correcto.
//
// route.ts no se puede importar ni ejecutar aquí (depende del runtime de
// Next.js — cookies, headers, el cliente de Supabase por request). Extraer su
// lógica a una función pura (`processTurn`) habría sido lo ideal para
// probarla end-to-end sin HTTP, pero exigiría reestructurar el flujo de
// llamadas/reintentos completo bajo el mismo cambio que ya introdujo
// `persistTurn` — demasiado riesgo de regresión para esta tanda (REGLA DE
// NO-REEMPLAZO). En su lugar: esta prueba ESTÁTICA confirma que route.ts
// importa `persistTurn` de `@/lib/persistence` y lo INVOCA — no queda una
// escritura suelta (scenario_state/goals/ica_history/telemetry) fuera del
// punto único. El E2E real (scripts/e2e-turn.ts) prueba que `persistTurn`
// en sí escribe correctamente contra la BD.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const ROUTE_PATH = resolve(__dirname, "route.ts");

function leerRoute(): string {
  return readFileSync(ROUTE_PATH, "utf8");
}

test("route.ts importa persistTurn de @/lib/persistence", () => {
  const src = leerRoute();
  assert.match(src, /import\s*\{[^}]*persistTurn[^}]*\}\s*from\s*['"]@\/lib\/persistence['"]/);
});

test("route.ts INVOCA persistTurn (no solo lo importa)", () => {
  const src = leerRoute();
  assert.match(src, /await\s+persistTurn\s*\(/);
});

test("route.ts ya NO escribe scenario_state por fuera de persistTurn", () => {
  const src = leerRoute();
  // La única escritura a `conversations.scenario_state` debe vivir dentro de
  // `persistTurn` (persistence.ts) — un `.update(...scenario_state...)`
  // suelto en route.ts sería exactamente el punto ciego que causó el
  // incidente testdev5.
  assert.ok(
    !/conversations['"]\)\s*\n?\s*\.update\(\{[^}]*scenario_state/.test(src),
    "no debe haber un update directo de scenario_state fuera de persistTurn",
  );
});

test("route.ts ya NO inserta en ica_history por fuera de persistTurn", () => {
  const src = leerRoute();
  assert.ok(
    !/from\(['"]ica_history['"]\)\s*\n?\s*\.insert/.test(src),
    "no debe haber un insert directo en ica_history fuera de persistTurn",
  );
});

test("route.ts ya NO llama a logResponseTelemetry directamente (vive dentro de persistTurn)", () => {
  const src = leerRoute();
  assert.ok(
    !/\blogResponseTelemetry\s*\(/.test(src),
    "logResponseTelemetry debe invocarse solo desde persistence.ts, nunca desde route.ts",
  );
});

// ── QA testdev8 — verificación ESTÁTICA de los fixes de esta tanda ──────────
// Mismo motivo que arriba: route.ts depende del runtime de Next.js y no se
// puede importar/ejecutar aquí. Estas pruebas confirman que el código de los
// bloqueantes/mayores sigue presente — un refactor futuro que borre alguna de
// estas piezas por error revienta aquí, no en producción.

test("BLOQUEANTE 3/4: la LLAMADA 1 recibe las derivadas recalculadas del estado persistido (verifiedSeed)", () => {
  const src = leerRoute();
  assert.match(src, /buildScenarioContext\(seed as ScenarioState, cleanMessage\)/);
  assert.match(src, /notaDatosCalculados/);
});

test("BLOQUEANTE 1/2: reintento acotado cuando la cifra pedida por el usuario está ausente de la respuesta", () => {
  const src = leerRoute();
  assert.match(src, /cifraPedidaAusente\(cleanMessage, finalContent, verified\.conceptos\)/);
});

test("MAYOR 7: se detecta la repetición del MENSAJE del usuario, no solo de la respuesta", () => {
  const src = leerRoute();
  assert.match(src, /contarRepeticionesMensajeUsuario\(/);
  assert.match(src, /notaRepeticionMensaje/);
});

// ── QA testdev10 — verificación ESTÁTICA de los fixes de esta tanda ─────────

test("BLOQUEANTE G1b: el borrador de LLAMADA 1 (snapshot pre-merge) NUNCA sobrevive al historial de LLAMADA 2", () => {
  const src = leerRoute();
  // `messages2` debe llevar el toolCall con content vacío, no `call1.content`
  // — si `call1.content` reaparece aquí, el modelo puede volver a mezclar una
  // derivada calculada sobre `seed` (pre-merge) con una fresca de este mismo
  // turno (el incidente real: "capacidad de 375€" = sobrante viejo + ocio
  // nuevo). Ver `orchestrator.test.ts` para la mitad del fix que SÍ se puede
  // probar sin el runtime de Next.js (pureza de snapshot único).
  assert.match(src, /\{\s*role:\s*'assistant'\s*as\s*const,\s*content:\s*'',\s*toolCalls:\s*\[toolCall\]\s*\}/);
  assert.ok(
    !/content:\s*call1\.content,\s*toolCalls/.test(src),
    "call1.content no debe viajar como texto del asistente hacia LLAMADA 2",
  );
});

test("MAYOR (tono): un conflicto de gastos ya abierto autoriza agregado/detalle/valor_adoptado para el guardarraíl", () => {
  const src = leerRoute();
  // Antes, solo `discrepancia.suma` (señal del turno que CREA el conflicto)
  // quedaba autorizada — en los turnos POSTERIORES, mientras el conflicto
  // sigue abierto, ni agregado ni detalle lo estaban, y el grounding
  // eliminaba la frase que los citaba: quedaba publicada solo la pregunta
  // desnuda, sin el contexto que la motiva.
  assert.match(src, /scenario\.gastos_conflict\.agregado,\s*scenario\.gastos_conflict\.detalle/);
  assert.match(src, /scenario\.gastos_assumed\.valor/);
});

test("MAYOR (tono): la anti-repetición también detecta estructura repetida, no solo texto idéntico", () => {
  const src = leerRoute();
  assert.match(src, /esEstructuraRepetida\(/);
  assert.match(src, /repiteEstructura/);
});
