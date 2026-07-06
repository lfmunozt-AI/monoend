// PIEZA 1 — Calculadora financiera: funciones puras.
//
// El modelo LLM no sabe calcular (dijo "100" donde 2500-1500=1000). La
// arquitectura objetivo invierte la responsabilidad: el CÓDIGO calcula, el
// modelo solo redacta alrededor de cifras verificadas. Este módulo es ese
// motor de cálculo.
//
// Reglas: TypeScript PURO, sin dependencias, edge-safe, redondeo a 2 decimales.
// NUNCA devuelve NaN silencioso: ante división por cero, valores negativos o
// entradas no finitas devuelve un error TIPADO (`CalcError`). El llamante
// (orchestrator) descarta los errores en vez de propagar basura al modelo.

/** Códigos de error del motor. Tipados para poder ramificar sin strings sueltos. */
export type CalcErrorCode =
  | "entrada_invalida" // NaN / Infinity
  | "valor_negativo" // un input que no admite signo negativo lo trae
  | "division_por_cero" // denominador 0
  | "rango_invalido"; // input fuera del rango admitido (p. ej. meses del fondo)

/** Resultado escalar correcto: un único valor con su etiqueta y su fórmula. */
export interface CalcValor {
  ok: true;
  valor: number;
  etiqueta: string;
  formula: string;
}

/** Resultado de la regla 50/30/20: tres partidas en vez de un escalar. */
export interface CalcRegla {
  ok: true;
  etiqueta: string;
  formula: string;
  necesidades: number;
  ocio: number;
  ahorro: number;
}

/** Error tipado. Sustituye a cualquier NaN/Infinity que se colaría. */
export interface CalcError {
  ok: false;
  error: CalcErrorCode;
  etiqueta: string;
  mensaje: string;
}

// ── Utilidades internas ─────────────────────────────────────────────────────

/** Redondeo a 2 decimales estable (evita 1.005 → 1.00 por binario). */
function round2(n: number): number {
  return Math.round((n + Number.EPSILON) * 100) / 100;
}

function todosFinitos(...xs: number[]): boolean {
  return xs.every((x) => Number.isFinite(x));
}

function todosNoNegativos(...xs: number[]): boolean {
  return xs.every((x) => x >= 0);
}

function err(
  error: CalcErrorCode,
  etiqueta: string,
  mensaje: string,
): CalcError {
  return { ok: false, error, etiqueta, mensaje };
}

/** Valida que las entradas sean finitas y no negativas; si no, error tipado. */
function guardEntradas(
  etiqueta: string,
  ...xs: number[]
): CalcError | null {
  if (!todosFinitos(...xs)) {
    return err("entrada_invalida", etiqueta, "entrada no numérica o no finita");
  }
  if (!todosNoNegativos(...xs)) {
    return err("valor_negativo", etiqueta, "no se admiten valores negativos");
  }
  return null;
}

// ── Operaciones ─────────────────────────────────────────────────────────────

/**
 * Sobrante mensual: cuánto queda tras cubrir los gastos.
 * El RESULTADO sí puede ser negativo (déficit real, no un error): por eso solo
 * se validan las entradas, no el signo del resultado.
 */
export function sobrante(ingresos: number, gastos: number): CalcValor | CalcError {
  const bad = guardEntradas("sobrante mensual", ingresos, gastos);
  if (bad) return bad;
  const valor = round2(ingresos - gastos);
  return { ok: true, valor, etiqueta: "sobrante mensual", formula: `${ingresos} - ${gastos} = ${valor}` };
}

/** Porcentaje de una base: base × pct / 100. */
export function porcentajeDe(base: number, pct: number): CalcValor | CalcError {
  const bad = guardEntradas("porcentaje", base, pct);
  if (bad) return bad;
  const valor = round2((base * pct) / 100);
  return { ok: true, valor, etiqueta: "porcentaje", formula: `${pct}% de ${base} = ${valor}` };
}

/**
 * Regla 50/30/20 sobre el ingreso: 50% necesidades, 30% ocio, 20% ahorro.
 * Devuelve las tres partidas (no un escalar).
 */
export function regla503020(ingreso: number): CalcRegla | CalcError {
  const bad = guardEntradas("regla 50/30/20", ingreso);
  if (bad) return bad;
  return {
    ok: true,
    etiqueta: "regla 50/30/20",
    formula: `50/30/20 de ${ingreso}`,
    necesidades: round2(ingreso * 0.5),
    ocio: round2(ingreso * 0.3),
    ahorro: round2(ingreso * 0.2),
  };
}

/**
 * Fondo de emergencia: gastos mensuales × meses de colchón.
 * El colchón recomendado es de 3 a 6 meses; fuera de ese rango → error tipado
 * (decisión documentada: no calculamos fondos "raros" sin que el llamante lo
 * pida explícitamente).
 */
export function fondoEmergencia(
  gastosMensuales: number,
  meses: number,
): CalcValor | CalcError {
  const etiqueta = "fondo de emergencia";
  const bad = guardEntradas(etiqueta, gastosMensuales, meses);
  if (bad) return bad;
  if (meses < 3 || meses > 6) {
    return err("rango_invalido", etiqueta, "el fondo recomendado es de 3 a 6 meses");
  }
  const valor = round2(gastosMensuales * meses);
  return { ok: true, valor, etiqueta, formula: `${gastosMensuales} x ${meses} meses = ${valor}` };
}

/** Proyección lineal: aporte mensual × número de meses. */
export function proyeccion(
  aporteMensual: number,
  meses: number,
): CalcValor | CalcError {
  const etiqueta = "proyección de ahorro";
  const bad = guardEntradas(etiqueta, aporteMensual, meses);
  if (bad) return bad;
  const valor = round2(aporteMensual * meses);
  return { ok: true, valor, etiqueta, formula: `${aporteMensual} x ${meses} = ${valor}` };
}

/**
 * Meses hasta alcanzar una meta: techo(meta / aporte mensual).
 * aporte 0 → división por cero (error tipado, nunca Infinity).
 */
export function tiempoHastaMeta(
  meta: number,
  aporteMensual: number,
): CalcValor | CalcError {
  const etiqueta = "meses hasta la meta";
  const bad = guardEntradas(etiqueta, meta, aporteMensual);
  if (bad) return bad;
  if (aporteMensual <= 0) {
    return err("division_por_cero", etiqueta, "el aporte mensual debe ser mayor que 0");
  }
  const valor = Math.ceil(meta / aporteMensual);
  return { ok: true, valor, etiqueta, formula: `techo(${meta} / ${aporteMensual}) = ${valor} meses` };
}

/**
 * Ratio de deuda: deuda total / ingreso anual, expresado en %.
 * ingreso anual 0 → división por cero (error tipado, nunca Infinity).
 */
export function ratioDeuda(
  deudaTotal: number,
  ingresoAnual: number,
): CalcValor | CalcError {
  const etiqueta = "ratio de deuda";
  const bad = guardEntradas(etiqueta, deudaTotal, ingresoAnual);
  if (bad) return bad;
  if (ingresoAnual <= 0) {
    return err("division_por_cero", etiqueta, "el ingreso anual debe ser mayor que 0");
  }
  const valor = round2((deudaTotal / ingresoAnual) * 100);
  return { ok: true, valor, etiqueta, formula: `${deudaTotal} / ${ingresoAnual} = ${valor}%` };
}

/**
 * Interés compuesto: capital × (1 + tasa)^años.
 * `tasaAnual` se interpreta como PORCENTAJE (5 = 5%), coherente con
 * `porcentajeDe`. Documentado así para evitar ambigüedad 0.05 vs 5.
 */
export function interesCompuesto(
  capital: number,
  tasaAnual: number,
  anios: number,
): CalcValor | CalcError {
  const etiqueta = "interés compuesto";
  const bad = guardEntradas(etiqueta, capital, tasaAnual, anios);
  if (bad) return bad;
  const valor = round2(capital * Math.pow(1 + tasaAnual / 100, anios));
  return {
    ok: true,
    valor,
    etiqueta,
    formula: `${capital} x (1 + ${tasaAnual}%)^${anios} = ${valor}`,
  };
}
