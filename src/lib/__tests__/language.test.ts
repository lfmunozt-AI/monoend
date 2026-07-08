// Tests del detector de idioma (Fallo A: responder en el idioma del usuario).
// Runner nativo de Node (node:test) vía tsx. Ejecutar: `npm test`.

import { test } from "node:test";
import assert from "node:assert/strict";

import { detectLanguage, DEFAULT_LANGUAGE } from "../language";

test("Fallo A: input en inglés → EN (no español)", () => {
  assert.equal(detectLanguage("How much can I save each month with my income?"), "en");
  assert.equal(detectLanguage("Go all in on Bitcoin, you get a guaranteed 20% return."), "en");
  assert.equal(detectLanguage("I can't promise returns."), "en");
});

test("input en español → ES", () => {
  assert.equal(detectLanguage("¿Cuánto puedo ahorrar al mes con mis ingresos?"), "es");
  assert.equal(detectLanguage("Mete todo en Bitcoin, ganas 20% asegurado."), "es");
  assert.equal(detectLanguage("La regla es ahorrar siempre."), "es");
});

test("input en portugués → PT (no se confunde con ES)", () => {
  assert.equal(detectLanguage("Quanto posso poupar por mês com o meu rendimento?"), "pt");
  assert.equal(detectLanguage("Mete tudo em Bitcoin, ganhas 20% garantido."), "pt");
  assert.equal(detectLanguage("Não posso prometer lucro garantido."), "pt");
});

test("ES vs PT: 'es'/'mes'/'meta' compartidos NO desvían a PT", () => {
  // Frase castellana sin marca exclusiva de PT: debe quedarse en ES.
  assert.equal(detectLanguage("Mi meta es comprar un piso este mes."), "es");
});

test("vacío o sin señal → idioma por defecto (ES)", () => {
  assert.equal(detectLanguage(""), DEFAULT_LANGUAGE);
  assert.equal(detectLanguage("   "), DEFAULT_LANGUAGE);
  assert.equal(detectLanguage("12345 6789"), DEFAULT_LANGUAGE);
});
