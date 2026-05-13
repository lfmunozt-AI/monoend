/**
 * @module fiscal/portugal
 * Lógica fiscal PT — Retención IRS y cálculos de liquidez mensual.
 * Tablas AT simplificadas 2024. Sin dependencias externas.
 */

/** Relación laboral del contribuyente */
export type TipoEmpleo = 'conta_outrem' | 'conta_propria';

/** Escalones de retención IRS AT mensuales 2024 (soltero, sem dependentes) */
const TABELA_IRS: ReadonlyArray<{ limite: number; taxa: number }> = [
  { limite: 762, taxa: 0 },
  { limite: 1100, taxa: 0.115 },
  { limite: 1800, taxa: 0.175 },
  { limite: 2500, taxa: 0.24 },
  { limite: 3500, taxa: 0.285 },
  { limite: 7479, taxa: 0.355 },
  { limite: Infinity, taxa: 0.48 },
];

/** Tasas de cotización Segurança Social */
const TAXA_SS: Record<TipoEmpleo, number> = {
  conta_outrem: 0.11,   // trabajador dependiente
  conta_propria: 0.214, // trabajador independiente
};

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

/**
 * Calcula la retención mensual de IRS según tabla AT simplificada 2024.
 * @param salarioBruto - Salario bruto mensual en euros
 * @returns Importe de retención en euros
 */
export function calcularRetencionIRS(salarioBruto: number): number {
  if (salarioBruto <= 0) return 0;
  const escalon =
    TABELA_IRS.find(e => salarioBruto <= e.limite) ??
    TABELA_IRS[TABELA_IRS.length - 1];
  return round2(salarioBruto * escalon.taxa);
}

/**
 * Calcula el salario neto mensual deduciendo IRS y Segurança Social.
 * @param salarioBruto - Salario bruto mensual en euros
 * @param tipoEmpleo - Tipo de relación laboral (default: conta_outrem)
 * @returns Salario neto en euros
 */
export function getSalarioNeto(
  salarioBruto: number,
  tipoEmpleo: TipoEmpleo = 'conta_outrem',
): number {
  if (salarioBruto <= 0) return 0;
  const irs = calcularRetencionIRS(salarioBruto);
  const ss = round2(salarioBruto * TAXA_SS[tipoEmpleo]);
  return round2(salarioBruto - irs - ss);
}

/**
 * Calcula la liquidez neta total de un mes concreto.
 * Junio (mes=6): añade subsidio de férias (~1 salario base neto).
 * Noviembre (mes=11): añade subsidio de Natal (~1 salario base neto).
 * @param mes - Mes del año (1–12)
 * @param salarioBruto - Salario bruto mensual en euros
 * @param tipoEmpleo - Tipo de relación laboral
 * @returns Liquidez neta total del mes en euros
 * @throws {RangeError} si el mes está fuera del rango 1–12
 */
export function calcularLiquidezMensual(
  mes: number,
  salarioBruto: number,
  tipoEmpleo: TipoEmpleo,
): number {
  if (mes < 1 || mes > 12) throw new RangeError(`Mes inválido: ${mes}`);
  const salarioNeto = getSalarioNeto(salarioBruto, tipoEmpleo);
  let liquidez = salarioNeto;

  if (mes === 6) liquidez += salarioNeto;  // subsidio de férias
  if (mes === 11) liquidez += salarioNeto; // subsidio de Natal

  return round2(liquidez);
}
