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
const HORIZONTE_MESES = 12; // proyección anual del sobrante.
const MESES_FONDO = 6; // colchón de emergencia por defecto (tope del rango 3-6).
const AHORRO_SUGERIDO_PCT = 10; // % del INGRESO: referencia estándar de ahorro.

export interface VerifiedContext {
  /** Bloque de texto a inyectar en el prompt ("" si no hay nada que calcular). */
  bloque: string;
  /**
   * Cifras que el validador puede aprobar como "cálculo verificado". SOLO las de
   * TU REALIDAD (sección a). Las de REFERENCIAS ESTÁNDAR (sección b) quedan FUERA
   * a propósito: una cifra normativa citada SIN marcador de referencia debe
   * seguir bloqueándose (ver tercera vía en guardrail/validate.ts).
   */
  cifrasCalculadas: number[];
}

/** Una línea del bloque: etiqueta semántica inequívoca, valor y fórmula. */
interface Linea {
  etiqueta: string;
  valor: number;
  formula: string;
}

function render(l: Linea): string {
  return `- ${l.etiqueta}: ${l.valor} € (${l.formula})`;
}

/**
 * Construye el paquete verificado a partir del mensaje del usuario.
 *
 * FALLO B (QA): el bloque mezclaba realidad y norma en una sola lista, y el
 * modelo tomó el "ahorro sugerido" (10% del ingreso = 300) y su proyección
 * (3600) como si fueran EL dato, ignorando el sobrante real (1000 → 12000/año) y
 * re-etiquetando el sobrante como ingreso. Solución: DOS secciones con semántica
 * separada.
 *
 * a) TU REALIDAD (datos verificados): ingreso, gastos, sobrante, capacidad de
 *    ahorro anual (sobrante × 12). Cada cifra con etiqueta inequívoca. Alimentan
 *    `cifrasCalculadas`.
 * b) REFERENCIAS ESTÁNDAR (no son datos del usuario): porcentajes normativos.
 *    NO entran en `cifrasCalculadas`.
 *
 * Mapa etiqueta→operaciones:
 *   ingreso + gasto → sobrante, capacidad anual · ref: ahorro sugerido (10%)
 *   ingreso (solo)  → ref: regla 50/30/20
 *   gasto (solo)    → fondo de emergencia (6 meses)  [realidad: deriva de gastos]
 *   deuda + ingreso → ratio de deuda (ingreso anualizado ×12)
 *   meta + sobrante → meses hasta la meta según la capacidad REAL
 *
 * Cada operación se ejecuta solo si tiene sus entradas; si devuelve error tipado,
 * se OMITE (nunca se inyecta basura al modelo).
 */
export function buildVerifiedContext(userMessage: string): VerifiedContext {
  const facts = extractInputFacts(userMessage);
  const byLabel = firstByLabel(facts);

  const realidad: Linea[] = [];
  const referencias: Linea[] = [];

  const ingreso = byLabel.get("ingreso");
  const gasto = byLabel.get("gasto");
  const deuda = byLabel.get("deuda");
  const meta = byLabel.get("meta");

  // Capacidad de ahorro REAL disponible para la meta (el sobrante, no la norma).
  let capacidadMensual: number | null = null;

  // ── ingreso + gasto → sobrante, capacidad anual (realidad) + ref ──────────
  if (ingreso !== undefined && gasto !== undefined) {
    realidad.push({ etiqueta: "ingreso_mensual", valor: ingreso, formula: "dato que aportaste" });
    realidad.push({ etiqueta: "gastos_mensuales", valor: gasto, formula: "dato que aportaste" });

    const s = sobrante(ingreso, gasto);
    if (s.ok) {
      realidad.push({
        etiqueta: "sobrante_mensual",
        valor: s.valor,
        formula: `ingreso ${ingreso} − gastos ${gasto}`,
      });
      if (s.valor > 0) {
        capacidadMensual = s.valor;
        const anual = proyeccion(s.valor, HORIZONTE_MESES);
        if (anual.ok) {
          realidad.push({
            etiqueta: "capacidad_ahorro_anual",
            valor: anual.valor,
            formula: `sobrante ${s.valor} × 12`,
          });
        }
      }
      // Referencia normativa: NO es un dato del usuario, va aparte y fuera de
      // cifrasCalculadas.
      const ref = porcentajeDe(ingreso, AHORRO_SUGERIDO_PCT);
      if (ref.ok) {
        referencias.push({
          etiqueta: "referencia_ahorro_sugerido",
          valor: ref.valor,
          formula: "estándar 10% del ingreso — usar solo como referencia etiquetada según la tercera vía",
        });
      }
    }
  } else if (ingreso !== undefined) {
    // ── ingreso solo → la regla 50/30/20 es NORMA, va a referencias ─────────
    realidad.push({ etiqueta: "ingreso_mensual", valor: ingreso, formula: "dato que aportaste" });
    const r = regla503020(ingreso);
    if (r.ok) {
      referencias.push({ etiqueta: "referencia_necesidades", valor: r.necesidades, formula: "estándar 50% del ingreso" });
      referencias.push({ etiqueta: "referencia_ocio", valor: r.ocio, formula: "estándar 30% del ingreso" });
      referencias.push({ etiqueta: "referencia_ahorro", valor: r.ahorro, formula: "estándar 20% del ingreso" });
    }
  }

  // ── gasto solo → fondo de emergencia (deriva de la realidad del usuario) ──
  if (gasto !== undefined && ingreso === undefined) {
    realidad.push({ etiqueta: "gastos_mensuales", valor: gasto, formula: "dato que aportaste" });
    const f = fondoEmergencia(gasto, MESES_FONDO);
    if (f.ok) {
      realidad.push({ etiqueta: "reserva_imprevistos_objetivo", valor: f.valor, formula: `gastos ${gasto} × 6 meses` });
    }
  }

  // ── deuda + ingreso → ratio de deuda (ingreso anualizado) ─────────────────
  if (deuda !== undefined && ingreso !== undefined) {
    const rd = ratioDeuda(deuda, ingreso * 12);
    if (rd.ok) {
      realidad.push({
        etiqueta: "ratio_deuda_ingreso",
        valor: rd.valor,
        formula: `${rd.formula} (ingreso anualizado ${ingreso} × 12)`,
      });
    }
  }

  // ── meta → meses hasta la meta según la capacidad REAL (nunca la norma) ───
  if (meta !== undefined && capacidadMensual !== null && capacidadMensual > 0) {
    const t = tiempoHastaMeta(meta, capacidadMensual);
    if (t.ok) {
      realidad.push({
        etiqueta: "meses_hasta_meta",
        valor: t.valor,
        formula: `meta ${meta} ÷ capacidad ${capacidadMensual}/mes`,
      });
    }
  }

  if (realidad.length === 0 && referencias.length === 0) {
    return { bloque: "", cifrasCalculadas: [] };
  }

  const secciones: string[] = [];
  if (realidad.length > 0) {
    secciones.push(
      "TU REALIDAD (datos verificados — usa EXCLUSIVAMENTE estas cifras, no inventes ni redondees a otras):",
      ...realidad.map(render),
    );
  }
  if (referencias.length > 0) {
    if (secciones.length > 0) secciones.push("");
    secciones.push(
      "REFERENCIAS ESTÁNDAR (NO son datos del usuario; solo puedes citarlas etiquetadas como referencia, nunca como su cifra real):",
      ...referencias.map(render),
    );
  }

  // Solo la realidad alimenta cifrasCalculadas: las referencias sin marcador
  // deben seguir bloqueándose.
  const cifrasCalculadas = realidad.map((l) => l.valor);

  return { bloque: secciones.join("\n"), cifrasCalculadas };
}

/** Primer valor por etiqueta (ignora etiquetas vacías). */
function firstByLabel(facts: VerifiedFact[]): Map<string, number> {
  const m = new Map<string, number>();
  for (const f of facts) {
    if (f.etiqueta && !m.has(f.etiqueta)) m.set(f.etiqueta, f.valor);
  }
  return m;
}
