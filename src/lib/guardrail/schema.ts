// PIEZA 4 — Esquema de salida estructurada (Zod).
//
// Estructura la salida del modelo separando el consejo de las cifras que dice
// haber usado y su fuente. Permite validar la forma ANTES de procesarla.
//
// NOTA de integración: hoy el chat (app/api/chat/route.ts) emite texto libre en
// streaming, no JSON. Por eso `parseModelOutput` es TOLERANTE: si el modelo SÍ
// devuelve JSON {consejo, cifras_usadas} lo valida con Zod; si devuelve texto
// plano, el orquestador lo envuelve como `consejo` y deja que las Piezas 1-2
// (regex) sigan siendo la fuente de verdad del grounding. Así el esquema queda
// listo para cuando el modelo se cambie a salida estructurada, sin romper el
// streaming actual (ver docs/GUARDRAIL.md).

import { z } from "zod";

/** Cada cifra que el modelo declara haber usado, con su origen declarado. */
export const CifraUsadaSchema = z.object({
  valor: z.number(),
  fuente: z.string(),
});

/** Salida estructurada esperada del modelo. */
export const ModelOutputSchema = z.object({
  consejo: z.string().min(1),
  cifras_usadas: z.array(CifraUsadaSchema).default([]),
});

export type CifraUsada = z.infer<typeof CifraUsadaSchema>;
export type ModelOutput = z.infer<typeof ModelOutputSchema>;

export interface ParseResult {
  /** true si la respuesta era JSON válido conforme al esquema. */
  structured: boolean;
  data: ModelOutput;
  /** Mensaje de error de validación, si la hubo. */
  error?: string;
}

/** Extrae un objeto JSON de un texto que puede venir envuelto en ```fences```. */
function extractJsonCandidate(raw: string): unknown {
  const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const body = (fenced ? fenced[1] : raw).trim();
  const first = body.indexOf("{");
  const last = body.lastIndexOf("}");
  if (first === -1 || last === -1 || last < first) {
    throw new Error("sin objeto JSON");
  }
  return JSON.parse(body.slice(first, last + 1));
}

/**
 * Intenta interpretar la respuesta del modelo como salida estructurada.
 * - Si es JSON válido conforme al esquema → { structured: true, data }.
 * - Si no (texto plano, JSON inválido) → { structured: false, data } donde
 *   `data.consejo` es el texto completo y `cifras_usadas` queda vacío. Nunca
 *   lanza: el guardarraíl debe poder seguir con la vía de regex.
 */
export function parseModelOutput(raw: string): ParseResult {
  try {
    const candidate = extractJsonCandidate(raw);
    const data = ModelOutputSchema.parse(candidate);
    return { structured: true, data };
  } catch (err) {
    return {
      structured: false,
      data: { consejo: raw, cifras_usadas: [] },
      error: err instanceof Error ? err.message : String(err),
    };
  }
}
