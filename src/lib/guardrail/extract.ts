// PIEZA 1 — Extractor de cifras de entrada.
//
// Recibe el mensaje del usuario y devuelve los "hechos verificados": las cifras
// que el usuario SÍ aportó, con su etiqueta y moneda. Es la fuente de verdad
// contra la que la Pieza 2 valida lo que dice el modelo.
//
// Código PURO (regex + lógica), edge-safe, SIN llamadas a ningún LLM (~ms).

import { findNumberMentions, dedupeOverlaps } from "./numbers";
import { detectCurrency, detectLabel, isTimeUnit, type Moneda } from "./context";

/** Un hecho verificado aportado por el usuario. */
export interface VerifiedFact {
  /** Valor numérico (normalizado a number). */
  valor: number;
  /** A qué se refiere ("deuda", "ingreso"…) o "" si no hay contexto claro. */
  etiqueta: string;
  /** Moneda/contexto detectado (EUR, pesos, %, $…) o null. */
  moneda: Moneda;
}

/**
 * Extrae los hechos verificados del mensaje del usuario.
 *
 * - Detecta montos en dígitos (40000, 1.200,50) y en palabras (mil, millones).
 * - Detecta la moneda/contexto si está presente (euros, pesos, %).
 * - Asocia cada cifra a su etiqueta por proximidad ("40000 en deudas" → deuda).
 * - Si no hay cifras, devuelve [] (caso "sin contexto").
 *
 * Las duraciones temporales ("3 meses") NO son hechos monetarios y se omiten.
 */
export function extractInputFacts(message: string): VerifiedFact[] {
  if (!message || !message.trim()) return [];

  const mentions = dedupeOverlaps(findNumberMentions(message));
  const facts: VerifiedFact[] = [];

  for (const m of mentions) {
    // Una duración ("contrato a 12 meses") no es un monto: no es un "hecho cifra".
    if (isTimeUnit(message, m)) continue;

    facts.push({
      valor: m.value,
      etiqueta: detectLabel(message, m),
      moneda: detectCurrency(message, m),
    });
  }

  return facts;
}
