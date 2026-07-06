// PIEZA 2 — Orquestador del motor financiero.
//
// Puente entre el extractor del guardarraíl (Pieza 1 de lib/guardrail) y la
// calculadora (lib/calculator/operations). A partir del mensaje del usuario:
//   1. reutiliza extractInputFacts() del guardarraíl (NO duplica el extractor),
//   2. según las ETIQUETAS detectadas decide qué operaciones aplican,
//   3. ejecuta las operaciones y arma un bloque de texto con cada cifra, su
//      etiqueta y su fórmula, para inyectar en el prompt,
//   4. devuelve {bloque, cifrasCalculadas} — la lista de cifras la usa el
//      validador (Pieza 3) para aprobar coincidencias EXACTAS.
//
// Si no hay hechos suficientes, el bloque es "" y el modelo pedirá contexto
// (comportamiento ya entrenado en el system prompt de AG08).
//
// Código PURO, edge-safe, SIN llamadas a ningún LLM.

import { extractInputFacts, type VerifiedFact } from "../guardrail/extract";
import {
  sobrante,
  porcentajeDe,
  proyeccion,
  fondoEmergencia,
  regla503020,
  ratioDeuda,
  tiempoHastaMeta,
} from "./operations";

// ── Supuestos del modelo financiero (documentados y configurables) ──────────
// Estas constantes definen las recomendaciones por defecto. Se centralizan aquí
// para que Luis pueda ajustarlas sin tocar la lógica.
const TASA_AHORRO_SUGERIDA = 30; // % del SOBRANTE mensual destinado a ahorro.
const HORIZONTE_MESES = 12; // proyección anual del ahorro.
const MESES_FONDO = 6; // colchón de emergencia por defecto (tope del rango 3-6).
const AHORRO_INGRESO_PCT = 20; // % del ingreso a ahorrar cuando no hay sobrante.

export interface VerifiedContext {
  /** Bloque de texto a inyectar en el prompt ("" si no hay nada que calcular). */
  bloque: string;
  /** Cifras calculadas por el motor; el validador aprueba coincidencias exactas. */
  cifrasCalculadas: number[];
}

/**
 * Mapa etiqueta→operaciones (documentado):
 *
 *   ingreso + gasto → sobrante → ahorro sugerido (30% del sobrante) → proyección 12m
 *   ingreso (solo)  → regla 50/30/20
 *   gasto (solo)    → fondo de emergencia (6 meses)
 *   deuda + ingreso → ratio de deuda (ingreso anualizado ×12)
 *   meta + aporte   → meses hasta la meta
 *
 * Cada operación se ejecuta solo si tiene sus entradas; si la operación
 * devuelve error tipado, se OMITE (nunca se inyecta basura al modelo).
 */
export function buildVerifiedContext(userMessage: string): VerifiedContext {
  const facts = extractInputFacts(userMessage);
  const byLabel = firstByLabel(facts);

  const lineas: string[] = [];
  const cifras: number[] = [];
  const push = (etiqueta: string, valor: number, formula: string) => {
    lineas.push(`- ${etiqueta}: ${valor} (${formula})`);
    cifras.push(valor);
  };

  const ingreso = byLabel.get("ingreso");
  const gasto = byLabel.get("gasto");
  const deuda = byLabel.get("deuda");
  const meta = byLabel.get("meta");

  // Aporte mensual que quede disponible para la meta (lo fija la primera regla
  // que aplique).
  let aporteMensual: number | null = null;

  // ── ingreso + gasto → sobrante, ahorro sugerido, proyección ───────────────
  if (ingreso !== undefined && gasto !== undefined) {
    const s = sobrante(ingreso, gasto);
    if (s.ok) {
      push(s.etiqueta, s.valor, s.formula);
      if (s.valor > 0) {
        const ap = porcentajeDe(s.valor, TASA_AHORRO_SUGERIDA);
        if (ap.ok) {
          aporteMensual = ap.valor;
          push("ahorro sugerido (mensual)", ap.valor, ap.formula);
          const proy = proyeccion(ap.valor, HORIZONTE_MESES);
          if (proy.ok) push(proy.etiqueta, proy.valor, proy.formula);
        }
      }
    }
  } else if (ingreso !== undefined) {
    // ── ingreso solo → regla 50/30/20 ───────────────────────────────────────
    const r = regla503020(ingreso);
    if (r.ok) {
      push("necesidades (50%)", r.necesidades, `50% de ${ingreso} = ${r.necesidades}`);
      push("ocio (30%)", r.ocio, `30% de ${ingreso} = ${r.ocio}`);
      push("ahorro (20%)", r.ahorro, `20% de ${ingreso} = ${r.ahorro}`);
      aporteMensual = r.ahorro;
    }
  }

  // ── gasto solo → fondo de emergencia ──────────────────────────────────────
  if (gasto !== undefined && ingreso === undefined) {
    const f = fondoEmergencia(gasto, MESES_FONDO);
    if (f.ok) push(f.etiqueta, f.valor, f.formula);
  }

  // ── deuda + ingreso → ratio de deuda (ingreso anualizado) ─────────────────
  if (deuda !== undefined && ingreso !== undefined) {
    const rd = ratioDeuda(deuda, ingreso * 12);
    if (rd.ok) push(rd.etiqueta, rd.valor, `${rd.formula} (ingreso anualizado ${ingreso} x 12)`);
  }

  // ── meta → meses hasta la meta ────────────────────────────────────────────
  if (meta !== undefined) {
    let ap = aporteMensual;
    if (ap === null && ingreso !== undefined) {
      const s = porcentajeDe(ingreso, AHORRO_INGRESO_PCT);
      if (s.ok) ap = s.valor;
    }
    if (ap !== null && ap > 0) {
      const t = tiempoHastaMeta(meta, ap);
      if (t.ok) push(t.etiqueta, t.valor, t.formula);
    }
  }

  if (lineas.length === 0) {
    return { bloque: "", cifrasCalculadas: [] };
  }

  const bloque = [
    "DATOS VERIFICADOS DE ESTA CONSULTA (usa EXCLUSIVAMENTE estas cifras; no inventes ni redondees a otras):",
    ...lineas,
  ].join("\n");

  return { bloque, cifrasCalculadas: cifras };
}

/** Primer valor por etiqueta (ignora etiquetas vacías). */
function firstByLabel(facts: VerifiedFact[]): Map<string, number> {
  const m = new Map<string, number>();
  for (const f of facts) {
    if (f.etiqueta && !m.has(f.etiqueta)) m.set(f.etiqueta, f.valor);
  }
  return m;
}
