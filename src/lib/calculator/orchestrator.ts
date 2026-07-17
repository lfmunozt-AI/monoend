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
import { parseDigitAmount, findNumberMentions, dedupeOverlaps } from "../guardrail/numbers";
import {
  sobrante,
  porcentajeDe,
  proyeccion,
  fondoEmergencia,
  regla503020,
  ratioDeuda,
  tiempoHastaMeta,
  loanPayment,
} from "./operations";
import { classifyExpenses, parseExpenseList, type ExpenseItem } from "./expenses";
import type { ScenarioState } from "./scenario";

// ── Supuestos del modelo financiero (documentados y configurables) ──────────
// Estas constantes definen las recomendaciones por defecto. Se centralizan aquí
// para que Luis pueda ajustarlas sin tocar la lógica.
const HORIZONTE_MESES = 12; // proyección anual del sobrante.
const MESES_FONDO = 6; // colchón de emergencia por defecto (tope del rango 3-6).
const AHORRO_SUGERIDO_PCT = 10; // % del INGRESO: referencia estándar de ahorro.
export const TAE_REFERENCIA = 7; // % TAE de referencia para simular cuotas de crédito.

function normaliza(s: string): string {
  return s.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase();
}

function round2(n: number): number {
  return Math.round((n + Number.EPSILON) * 100) / 100;
}

// Palabras que señalan un escenario de crédito/financiación (ES/PT/EN).
const LOAN_KEYWORDS =
  /\b(credito|creditos|financiar|financiacion|financiamento|cuota|cuotas|prestamo|prestamos|emprestimo|prestacao|prestacoes|parcelas?|loan|financing|installments?)\b/;

// Un número seguido de una unidad de plazo → meses del préstamo.
const PLAZO_MESES =
  /(\d[\d.,]*)\s*(?:meses|mes|months?|parcelas|prestacoes|cuotas)\b/;

/**
 * Detecta un escenario de crédito en el mensaje: palabra de crédito + un plazo
 * en meses + un principal.
 *
 * El principal NO puede salir de `extractInputFacts`: "30000 a 36 meses" casa
 * con el patrón de rango temporal ("N a M meses") y el extractor descarta el
 * 30000 como si fuera una duración. Por eso se toma de `findNumberMentions`
 * directamente: el mayor monto que no sea el plazo ni un ingreso/gasto ya
 * etiquetado. Devuelve null si falta cualquiera de las tres señales.
 */
function detectLoanScenario(
  message: string,
  facts: VerifiedFact[],
): { principal: number; months: number } | null {
  const n = normaliza(message);
  if (!LOAN_KEYWORDS.test(n)) return null;

  const m = PLAZO_MESES.exec(n);
  if (!m) return null;
  const months = parseDigitAmount(m[1]);
  if (!Number.isFinite(months) || months <= 0) return null;

  const ingresoGasto = new Set(
    facts.filter((f) => f.etiqueta === "ingreso" || f.etiqueta === "gasto").map((f) => f.valor),
  );
  const candidatos = dedupeOverlaps(findNumberMentions(message))
    .map((x) => x.value)
    .filter((v) => v > 0 && v !== months && !ingresoGasto.has(v));
  if (candidatos.length === 0) return null;

  const principal = Math.max(...candidatos);
  return { principal, months };
}

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
  /** Unidad tras el valor. "€" por defecto; "meses"/"%" para plazo/tae. */
  unidad?: string;
}

function render(l: Linea): string {
  // Coma decimal (convención es/LatAm): el parser del guardarraíl lee "953,99"
  // como 953.99; con punto lo trocearía. Los enteros quedan igual.
  const unidad = l.unidad ?? "€";
  return `- ${l.etiqueta}: ${String(l.valor).replace(".", ",")} ${unidad} (${l.formula})`;
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
  // Las referencias se guardan ya renderizadas: su titular es el PORCENTAJE
  // (el estándar) y el monto es solo su aplicación al caso del usuario. No
  // alimentan cifrasCalculadas, así que no necesitan `valor`.
  const referencias: string[] = [];
  const refLine = (etiqueta: string, pct: number, monto: number) =>
    `- ${etiqueta}: ${pct}% del ingreso (= ${monto} €/mes en tu caso)`;

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
      // Referencia normativa: el estándar es el %, el monto es su aplicación al
      // caso. NO es un dato del usuario y NO entra en cifrasCalculadas.
      const ref = porcentajeDe(ingreso, AHORRO_SUGERIDO_PCT);
      if (ref.ok) {
        referencias.push(refLine("referencia_ahorro_sugerido", AHORRO_SUGERIDO_PCT, ref.valor));
      }
    }
  } else if (ingreso !== undefined) {
    // ── ingreso solo → la regla 50/30/20 es NORMA, va a referencias ─────────
    realidad.push({ etiqueta: "ingreso_mensual", valor: ingreso, formula: "dato que aportaste" });
    const r = regla503020(ingreso);
    if (r.ok) {
      referencias.push(refLine("referencia_necesidades", 50, r.necesidades));
      referencias.push(refLine("referencia_ocio", 30, r.ocio));
      referencias.push(refLine("referencia_ahorro", 20, r.ahorro));
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

  // ── crédito/financiación → cuota simulada con TAE de referencia ───────────
  // Excepción de grounding: a diferencia del resto de referencias, la cuota SÍ
  // alimenta cifrasCalculadas para que el guardarraíl apruebe la cifra cuando el
  // modelo la cite. Su etiqueta la mantiene explícitamente como simulación.
  const cuotaCifras: number[] = [];
  const loan = detectLoanScenario(userMessage, facts);
  if (loan) {
    const cuota = loanPayment({
      principal: loan.principal,
      months: loan.months,
      annualRatePct: TAE_REFERENCIA,
    });
    if (cuota.ok) {
      // Coma decimal (convención es/LatAm): el parser del guardarraíl lee "926,31"
      // como 926.31. Con punto ("926.31") lo trocearía en 926 y 31 y no aprobaría
      // la cuota citada.
      const cuotaEs = String(cuota.valor).replace(".", ",");
      referencias.push(
        `- referencia_cuota_credito: ${cuotaEs} €/mes (simulación con TAE de referencia ~${TAE_REFERENCIA}% — NO es la tasa real del usuario; monto ${loan.principal} a ${loan.months} meses)`,
      );
      cuotaCifras.push(cuota.valor);
    }
  }

  // ── lista de gastos → clasificación + recorte del 50% de los no vitales ───
  // Va a TU REALIDAD: son cifras del usuario (o derivadas de ellas). Todas
  // alimentan cifrasCalculadas. El recorte usa un supuesto EXPLÍCITO (mitad de
  // los no vitales); los desconocidos se listan aparte, sin asumir nada.
  const gastosSinClasificar: string[] = [];
  const itemCifras: number[] = [];
  const items = parseExpenseList(userMessage);
  if (items.length >= 2) {
    const cls = classifyExpenses(items);
    // Todos los montos individuales entran a grounding: si el modelo cita "tu
    // netflix de 100 €", el guardarraíl debe aprobarlo.
    itemCifras.push(...items.map((i) => i.amount));
    const lista = (g: ExpenseItem[]) => g.map((i) => `${i.name} ${i.amount}`).join(", ");

    if (cls.vitales.items.length > 0) {
      realidad.push({ etiqueta: "gastos_vitales", valor: cls.vitales.total, formula: lista(cls.vitales.items) });
    }
    if (cls.noVitales.items.length > 0) {
      realidad.push({ etiqueta: "gastos_no_vitales", valor: cls.noVitales.total, formula: lista(cls.noVitales.items) });
      realidad.push({
        etiqueta: "recorte_propuesto_50pct",
        valor: cls.recortePropuesto,
        formula: "supuesto: reducir no vitales a la mitad",
      });
      // nueva_capacidad solo si conocemos el sobrante real.
      if (capacidadMensual !== null) {
        realidad.push({
          etiqueta: "nueva_capacidad",
          valor: round2(capacidadMensual + cls.recortePropuesto),
          formula: `sobrante ${capacidadMensual} + recorte ${cls.recortePropuesto}`,
        });
      }
    }
    if (cls.desconocidos.items.length > 0) {
      gastosSinClasificar.push(
        `gastos_sin_clasificar: ${lista(cls.desconocidos.items)} — preguntar si son fijos imprescindibles`,
      );
    }
  }

  if (realidad.length === 0 && referencias.length === 0 && gastosSinClasificar.length === 0) {
    return { bloque: "", cifrasCalculadas: [] };
  }

  const secciones: string[] = [];
  if (realidad.length > 0 || gastosSinClasificar.length > 0) {
    secciones.push(
      "TU REALIDAD (datos verificados — usa EXCLUSIVAMENTE estas cifras, no inventes ni redondees a otras):",
      ...realidad.map(render),
      // Desconocidos: se listan sin monto agregado; no se asume nada sobre ellos.
      ...gastosSinClasificar.map((l) => `- ${l}`),
    );
  }
  if (referencias.length > 0) {
    if (secciones.length > 0) secciones.push("");
    secciones.push(
      "REFERENCIAS ESTÁNDAR (NO son datos del usuario; solo puedes citarlas etiquetadas como referencia, nunca como su cifra real; NO las menciones en preguntas de capacidad):",
      ...referencias,
    );
  }

  // La realidad alimenta cifrasCalculadas; las referencias normativas NO (una
  // cifra normativa sin marcador debe seguir bloqueándose). Excepción: la cuota
  // de crédito simulada SÍ entra, para que el guardarraíl apruebe la cifra que
  // el modelo va a citar como simulación.
  const cifrasCalculadas = [...realidad.map((l) => l.valor), ...cuotaCifras, ...itemCifras];

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

/** Convierte un number a la convención es/LatAm ("926.31" → "926,31"). */
function esNum(n: number): string {
  return String(n).replace(".", ",");
}

export interface ScenarioContext {
  /** Bloque a inyectar en el prompt ("TU REALIDAD…" / "REFERENCIAS…"). */
  bloque: string;
  /** Mapa semántico concepto→valor exacto para el grounding (PIEZA 2). */
  conceptos: Record<string, number>;
  /** Todas las cifras aprobables por el guardarraíl (superset de `conceptos`). */
  valores: number[];
  /** Qué falta para el playbook activo (de scenario.missing). */
  missing: string[];
}

/**
 * Construye el contexto a partir del ESTADO COMPLETO del escenario (no solo el
 * último mensaje). Es la pieza que corrige la causa raíz: "el banco me ofrece un
 * 9%" recalcula la cuota porque el crédito (monto+plazo) vive en el estado.
 *
 * - crédito con TAE real → cuota en TU REALIDAD, sin etiqueta de simulación.
 * - crédito sin TAE → cuota en REFERENCIAS con TAE de referencia del 7%.
 * - lista de gastos en el mensaje → clasificación + recorte del 50%.
 * `conceptos` alimenta el grounding semántico; `valores` es el superset numérico.
 */
export function buildScenarioContext(
  scenario: ScenarioState,
  userMessage: string,
): ScenarioContext {
  const realidad: Linea[] = [];
  const referencias: string[] = [];
  const sinClasificar: string[] = [];
  const conceptos: Record<string, number> = {};
  const extraValores: number[] = [];

  const ingreso = scenario.ingreso_mensual;
  const gasto = scenario.gastos_mensuales;

  let capacidadMensual: number | null = null;

  if (ingreso !== undefined) {
    realidad.push({ etiqueta: "ingreso_mensual", valor: ingreso, formula: "dato que aportaste" });
  }
  if (gasto !== undefined) {
    realidad.push({ etiqueta: "gastos_mensuales", valor: gasto, formula: "dato que aportaste" });
  }
  if (ingreso !== undefined && gasto !== undefined) {
    const s = sobrante(ingreso, gasto);
    if (s.ok) {
      realidad.push({ etiqueta: "sobrante_mensual", valor: s.valor, formula: `ingreso ${ingreso} − gastos ${gasto}` });
      if (s.valor > 0) {
        capacidadMensual = s.valor;
        const anual = proyeccion(s.valor, HORIZONTE_MESES);
        if (anual.ok) {
          realidad.push({ etiqueta: "capacidad_ahorro_anual", valor: anual.valor, formula: `sobrante ${s.valor} × 12` });
        }
      }
    }
    const ref = porcentajeDe(ingreso, AHORRO_SUGERIDO_PCT);
    if (ref.ok) referencias.push(refLineFor("referencia_ahorro_sugerido", AHORRO_SUGERIDO_PCT, ref.valor));
  }

  // ── Crédito desde el estado ────────────────────────────────────────────────
  if (scenario.credito && scenario.credito.monto > 0 && scenario.credito.plazo_meses > 0) {
    const c = scenario.credito;
    const usarReferencia = c.tae_es_referencia || c.tae_pct === undefined;
    const tae = usarReferencia ? TAE_REFERENCIA : (c.tae_pct as number);

    // FIX 1 — monto, plazo y TAE son DATOS DE PRIMERA CLASE: van a TU REALIDAD y
    // de ahí `deriveConceptos` los promueve a `conceptos` (ver más abajo), antes
    // que la cuota. Así el 30000 tiene su hueco (y entra a `valores`), y el
    // grounding puede distinguir monto de cuota en vez de que el modelo cite una
    // como la otra.
    realidad.push({ etiqueta: "monto_credito", valor: c.monto, formula: "dato que aportaste" });
    realidad.push({ etiqueta: "plazo_credito_meses", valor: c.plazo_meses, formula: "dato que aportaste", unidad: "meses" });
    if (!usarReferencia) {
      realidad.push({ etiqueta: "tae_credito_pct", valor: tae, formula: "TAE real de tu banco", unidad: "%" });
    }

    const cuota = loanPayment({ principal: c.monto, months: c.plazo_meses, annualRatePct: tae });
    if (cuota.ok) {
      // Excepción: la cuota simulada (usarReferencia) NUNCA entra a `realidad`
      // (va a REFERENCIAS ESTÁNDAR), así que `deriveConceptos` no la vería. Se
      // fija aquí a mano; en el caso TAE real, cuota_credito SÍ vive en
      // `realidad` y `deriveConceptos` la fijaría igual (mismo valor, idempotente).
      conceptos.cuota = cuota.valor;
      extraValores.push(cuota.valor);
      if (usarReferencia) {
        referencias.push(
          `- referencia_cuota_credito: ${esNum(cuota.valor)} €/mes (simulación con TAE de referencia ~${TAE_REFERENCIA}% — NO es la tasa real del usuario; monto ${c.monto} a ${c.plazo_meses} meses)`,
        );
      } else {
        // TAE real del usuario: la cuota es su cifra real, no una simulación.
        realidad.push({
          etiqueta: "cuota_credito",
          valor: cuota.valor,
          formula: `TAE real ${tae}% del banco; monto ${c.monto} a ${c.plazo_meses} meses`,
        });
      }
    }
  }

  // ── Lista de gastos en el mensaje → clasificación ─────────────────────────
  const items = parseExpenseList(userMessage);
  if (items.length >= 2) {
    const cls = classifyExpenses(items);
    const listaTxt = (g: ExpenseItem[]) => g.map((i) => `${i.name} ${i.amount}`).join(", ");
    extraValores.push(...items.map((i) => i.amount));
    if (cls.vitales.items.length > 0) {
      realidad.push({ etiqueta: "gastos_vitales", valor: cls.vitales.total, formula: listaTxt(cls.vitales.items) });
    }
    if (cls.noVitales.items.length > 0) {
      realidad.push({ etiqueta: "gastos_no_vitales", valor: cls.noVitales.total, formula: listaTxt(cls.noVitales.items) });
      realidad.push({ etiqueta: "recorte_propuesto_50pct", valor: cls.recortePropuesto, formula: "supuesto: reducir no vitales a la mitad" });
      if (capacidadMensual !== null) {
        realidad.push({ etiqueta: "nueva_capacidad", valor: round2(capacidadMensual + cls.recortePropuesto), formula: `sobrante ${capacidadMensual} + recorte ${cls.recortePropuesto}` });
      }
    }
    if (cls.desconocidos.items.length > 0) {
      sinClasificar.push(`gastos_sin_clasificar: ${listaTxt(cls.desconocidos.items)} — preguntar si son fijos imprescindibles`);
    }
  }

  // ── Meta ───────────────────────────────────────────────────────────────────
  if (scenario.meta?.monto !== undefined && capacidadMensual !== null && capacidadMensual > 0) {
    const t = tiempoHastaMeta(scenario.meta.monto, capacidadMensual);
    if (t.ok) {
      realidad.push({ etiqueta: "meses_hasta_meta", valor: t.valor, formula: `meta ${scenario.meta.monto} ÷ capacidad ${capacidadMensual}/mes` });
    }
  }

  // FIX 1 — deriva el resto de `conceptos` automáticamente de TODAS las líneas
  // de realidad ya acumuladas (ingreso, gastos, sobrante, capacidad anual,
  // monto/plazo/tae de crédito, recorte, nueva_capacidad…). Reemplaza la lista
  // manual de asignaciones `conceptos.x = y` dispersa por la función: si se
  // añade una línea nueva a `realidad`, basta con registrarla en
  // ETIQUETA_A_CONCEPTO para que el grounding la cubra.
  deriveConceptos(realidad, conceptos);

  const secciones: string[] = [];
  if (realidad.length > 0 || sinClasificar.length > 0) {
    secciones.push(
      "TU REALIDAD (datos verificados — usa EXCLUSIVAMENTE estas cifras, no inventes ni redondees a otras):",
      ...realidad.map(render),
      ...sinClasificar.map((l) => `- ${l}`),
    );
  }
  if (referencias.length > 0) {
    if (secciones.length > 0) secciones.push("");
    secciones.push(
      "REFERENCIAS ESTÁNDAR (NO son datos del usuario; solo puedes citarlas etiquetadas como referencia, nunca como su cifra real; NO las menciones en preguntas de capacidad):",
      ...referencias,
    );
  }

  const valores = [...realidad.map((l) => l.valor), ...extraValores];
  return { bloque: secciones.join("\n"), conceptos, valores, missing: scenario.missing ?? [] };
}

function refLineFor(etiqueta: string, pct: number, monto: number): string {
  return `- ${etiqueta}: ${pct}% del ingreso (= ${monto} €/mes en tu caso)`;
}

// Mapa etiqueta de línea (TU REALIDAD) → concepto de grounding (PIEZA 2). Regla
// permanente: toda línea nueva de realidad DEBE mapear a un concepto — si añades
// un campo aquí, añade sus keywords en context.ts (CONCEPT_KEYWORDS / detectLabel).
const ETIQUETA_A_CONCEPTO: Record<string, string> = {
  ingreso_mensual: "ingreso",
  gastos_mensuales: "gastos",
  sobrante_mensual: "sobrante",
  capacidad_ahorro_anual: "capacidad_anual",
  monto_credito: "monto",
  plazo_credito_meses: "plazo",
  tae_credito_pct: "tae",
  cuota_credito: "cuota",
  recorte_propuesto_50pct: "recorte",
  nueva_capacidad: "nueva_capacidad",
};

/**
 * Deriva `conceptos` automáticamente a partir de las líneas de TU REALIDAD, en
 * vez de una lista manual mantenida a mano (HUECO QA: ingreso/gastos nunca
 * tenían concepto → el modelo alucinaba "tus ingresos son de 500 €" y el
 * guardarraíl no tenía cómo rechazarlo). No pisa conceptos ya fijados por una
 * excepción explícita (p. ej. la cuota simulada, que no vive en `realidad`).
 */
function deriveConceptos(realidad: Linea[], conceptos: Record<string, number>): void {
  for (const l of realidad) {
    const concepto = ETIQUETA_A_CONCEPTO[l.etiqueta];
    if (concepto && !(concepto in conceptos)) conceptos[concepto] = l.valor;
  }
}
