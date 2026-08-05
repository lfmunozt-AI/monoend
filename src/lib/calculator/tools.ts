// Tool de extracción para function calling. El LLM rellena estos campos a partir
// del mensaje del usuario (lo que sabe hacer: entender lenguaje natural); el
// código calcula y marca (lo que sabe hacer: aritmética verificada). La tool es
// pura declaración + un mapper a ScenarioState; SIN llamadas al LLM aquí.

import type { ToolDef } from "../llm";
import type { Language } from "../language";
import { classifyExpenses, classifyExpense, type ExpenseItem } from "./expenses";
import { extractScenarioDelta, type ScenarioState, type CreditoState, type MetaState, type GastoItemEntry } from "./scenario";
import { TAE_REFERENCIA } from "./orchestrator";

/**
 * Tool ÚNICA. Se llama SIEMPRE que el mensaje aporte un dato numérico o meta
 * nueva; nunca si no aporta datos. Todos los campos son opcionales: el modelo
 * rellena solo lo que el usuario menciona.
 */
export const registrarDatosFinancieros: ToolDef = {
  type: "function",
  function: {
    name: "registrar_datos_financieros",
    description:
      "Registra los datos financieros que el usuario menciona en su mensaje. " +
      "Llámala SIEMPRE que el mensaje contenga cualquier dato numérico o meta nueva. " +
      "No la llames si el mensaje no aporta datos nuevos.",
    parameters: {
      type: "object",
      properties: {
        ingreso_mensual: { type: "number", description: "Ingreso NETO mensual del usuario, en euros." },
        gastos_mensuales: { type: "number", description: "Gasto mensual total AGREGADO, en euros. No lo rellenes si el usuario da una lista desglosada; usa gastos_detalle." },
        credito_monto: { type: "number", description: "Importe/precio del bien a financiar (el principal del crédito), en euros." },
        credito_plazo_meses: { type: "number", description: "Plazo del crédito en MESES (convierte años a meses)." },
        credito_tae_pct: { type: "number", description: "TAE/tasa anual REAL que ofrece el banco, en %, SOLO si el usuario la menciona. Nunca inventes ni asumas un valor." },
        meta_titulo: { type: "string", description: "Descripción breve de la meta del usuario (p. ej. 'comprar un piso')." },
        meta_monto: { type: "number", description: "Importe objetivo de la meta, en euros." },
        meta_plazo_meses: { type: "number", description: "Plazo de la meta en MESES." },
        gastos_detalle: {
          type: "array",
          description: "Lista desglosada de gastos con nombre y monto (p. ej. netflix 15, luz 80).",
          items: {
            type: "object",
            properties: {
              nombre: { type: "string", description: "Nombre del gasto." },
              monto: { type: "number", description: "Importe mensual del gasto, en euros." },
            },
            required: ["nombre", "monto"],
          },
        },
      },
    },
  },
};

/** Lee un número de los args de la tool, tolerando strings numéricos. */
function num(v: unknown): number | undefined {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string" && v.trim() !== "") {
    const n = Number(v.replace(",", "."));
    if (Number.isFinite(n)) return n;
  }
  return undefined;
}

/** Solo valores estrictamente positivos (descarta 0 y negativos inventados). */
function pos(v: number | undefined): number | undefined {
  return v !== undefined && v > 0 ? v : undefined;
}

/**
 * Convierte los args de la tool a un delta de ScenarioState. Es el equivalente
 * function-calling de `extractScenarioDelta`: mismo destino, extracción por LLM
 * en vez de regex. Campos ausentes → no se tocan (merge conserva lo previo).
 */
export function toolArgsToScenarioDelta(args: Record<string, unknown>): Partial<ScenarioState> {
  const delta: Partial<ScenarioState> = {};

  const ingreso = num(args.ingreso_mensual);
  if (ingreso !== undefined && ingreso > 0) delta.ingreso_mensual = ingreso;

  const gastos = num(args.gastos_mensuales);
  if (gastos !== undefined && gastos > 0) delta.gastos_mensuales = gastos;

  // Crédito: monto/plazo/tae, solo valores válidos. Si el usuario aporta la TAE
  // → deja de ser referencia.
  const monto = pos(num(args.credito_monto));
  const plazo = pos(num(args.credito_plazo_meses));
  const taeRaw = num(args.credito_tae_pct);
  const tae = taeRaw !== undefined && taeRaw > 0 && taeRaw < 100 ? taeRaw : undefined;
  if (monto !== undefined || plazo !== undefined || tae !== undefined) {
    // FIX 1 (7ª tanda, testdev6) — CERO NO ES UN VALOR: el placeholder
    // `monto ?? 0` / `plazo ?? 0` era la causa raíz del bloqueo circular real
    // ("el banco me ofrece 18%" sin plazo dejaba plazo_meses=0 persistido,
    // que a su vez invalidaba el bloque de crédito entero en
    // buildScenarioContext y borraba la propia pregunta que pedía el plazo).
    // Un campo no declarado queda `undefined`, nunca `0`.
    const credito: CreditoState = { tae_es_referencia: true };
    if (monto !== undefined) credito.monto = monto;
    if (plazo !== undefined) credito.plazo_meses = plazo;
    if (tae !== undefined) {
      credito.tae_pct = tae;
      credito.tae_es_referencia = false;
    }
    delta.credito = credito;
  }

  // Meta.
  const metaMonto = num(args.meta_monto);
  const metaPlazo = num(args.meta_plazo_meses);
  const metaTitulo = typeof args.meta_titulo === "string" ? args.meta_titulo.trim() : undefined;
  if (metaMonto !== undefined || metaPlazo !== undefined || metaTitulo) {
    const meta: MetaState = {};
    if (metaTitulo) meta.titulo = metaTitulo;
    if (metaMonto !== undefined && metaMonto > 0) meta.monto = metaMonto;
    if (metaPlazo !== undefined && metaPlazo > 0) meta.plazo_meses = metaPlazo;
    delta.meta = meta;
  }

  // Lista de gastos desglosada → totales por grupo (defecto B: NO toca el agregado).
  if (Array.isArray(args.gastos_detalle)) {
    const items: ExpenseItem[] = [];
    for (const raw of args.gastos_detalle as unknown[]) {
      if (raw && typeof raw === "object") {
        const nombre = (raw as { nombre?: unknown }).nombre;
        const monto = num((raw as { monto?: unknown }).monto);
        if (typeof nombre === "string" && nombre.trim() && monto !== undefined && monto > 0) {
          items.push({ name: nombre.trim(), amount: monto });
        }
      }
    }
    if (items.length >= 2) {
      const cls = classifyExpenses(items);
      delta.gastos_detalle = {
        vitales: cls.vitales.total,
        noVitales: cls.noVitales.total,
        desconocidos: cls.desconocidos.total,
      };
      delta.gastos_es_detalle = true;
      // PIEZA 5 (8ª tanda) — conserva cada partida individual también cuando
      // viene por tool_call, no solo por el fallback regex. `turn: 0` es un
      // placeholder — `mergeScenario` lo reescribe al acumular.
      delta.gastos_items = items.map(
        (i): GastoItemEntry => ({ name: i.name, amount: i.amount, category: classifyExpense(i.name), source: "tool", turn: 0 }),
      );
    }
  }

  return delta;
}

// ── Helpers del flujo del route (puros y testables) ──────────────────────────

/**
 * Decide el delta del turno: si el modelo emitió el tool_call, se usa su
 * extracción; si no, se CONSERVA la ruta determinista (regex). El fallback
 * mantiene viva la maquinaria probada cuando el LLM no llama la tool.
 */
export function resolveDelta(opts: {
  toolArgs?: Record<string, unknown>;
  message: string;
  lang: Language;
  prev?: Partial<ScenarioState>;
}): { delta: Partial<ScenarioState>; usedTool: boolean } {
  if (opts.toolArgs) return { delta: toolArgsToScenarioDelta(opts.toolArgs), usedTool: true };
  return { delta: extractScenarioDelta(opts.message, opts.lang, opts.prev), usedTool: false };
}

/** Paquete verificado que se pasa al modelo como tool_result (2º turno). */
export interface ToolResultPayload {
  cifras: Record<string, number>;
  bloque: string;
  missing: string[];
  credito: { es_simulacion: boolean | null; tae_usada: number | null };
  /** FIX C — PB7 EJECUCIÓN: si true, el modelo debe entregar el plan, no re-diagnosticar. */
  plan_confirmado: boolean;
}

/**
 * Construye el tool_result con las cifras verificadas y las MARCAS que el modelo
 * debe verbalizar: `es_simulacion` (¿la cuota es una simulación con TAE de
 * referencia?) y `tae_usada` (la TAE con la que se calculó — 7% de referencia o
 * la real del banco).
 */
export function buildToolResult(
  scenario: ScenarioState,
  verified: { conceptos: Record<string, number>; bloque: string; missing: string[] },
): ToolResultPayload {
  const c = scenario.credito;
  const taeUsada = c ? (c.tae_es_referencia || c.tae_pct === undefined ? TAE_REFERENCIA : c.tae_pct) : null;
  return {
    cifras: verified.conceptos,
    bloque: verified.bloque,
    missing: verified.missing,
    credito: { es_simulacion: c?.tae_es_referencia ?? null, tae_usada: taeUsada },
    plan_confirmado: scenario.plan_confirmado === true,
  };
}
