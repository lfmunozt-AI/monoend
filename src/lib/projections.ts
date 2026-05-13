/**
 * @module projections
 * Motor de proyecciones financieras de cierre de mes.
 * Estima ingresos, gastos y saldo final con alertas automáticas.
 */

import type { Transaccion, Perfil, FiscalProfile } from './ica';
import { calcularLiquidezMensual, type TipoEmpleo } from './fiscal/portugal';

export interface Alerta {
  tipo: 'warning' | 'danger' | 'info';
  mensaje: string;
}

export interface ProyeccionCierreMes {
  /** Ingresos netos esperados para el mes completo */
  ingresosEsperados: number;
  /** Gastos proyectados extrapolados a fin de mes */
  gastosProyectados: number;
  /** Saldo estimado: ingresosEsperados − gastosProyectados */
  saldoFinal: number;
  /** Alertas detectadas durante la proyección */
  alertas: Alerta[];
}

/**
 * Proyecta el cierre financiero del mes actual a partir de las transacciones
 * registradas hasta hoy y el perfil fiscal del usuario.
 * @param transacciones - Transacciones del mes en curso
 * @param perfil - Perfil del usuario (metas, métricas)
 * @param fiscalProfile - Perfil fiscal con país, salario y tipo de empleo
 * @returns Proyección de cierre de mes con alertas
 */
export function proyectarCierreMes(
  transacciones: Transaccion[],
  perfil: Perfil,
  fiscalProfile: FiscalProfile,
): ProyeccionCierreMes {
  const hoy = new Date();
  const mes = hoy.getMonth() + 1; // 1–12
  const diasEnMes = new Date(hoy.getFullYear(), mes, 0).getDate();
  const fraccionMes = Math.max(hoy.getDate() / diasEnMes, 0.01); // evita división por cero

  const ingresosEsperados = calcularIngresosEsperados(mes, fiscalProfile);

  const gastosHastaHoy = transacciones
    .filter(t => t.tipo === 'gasto')
    .reduce((sum, t) => sum + t.monto, 0);

  const gastosProyectados = round2(gastosHastaHoy / fraccionMes);
  const saldoFinal = round2(ingresosEsperados - gastosProyectados);

  const alertas: Alerta[] = generarAlertas(
    ingresosEsperados,
    gastosProyectados,
    saldoFinal,
    perfil,
  );

  return { ingresosEsperados, gastosProyectados, saldoFinal, alertas };
}

function calcularIngresosEsperados(mes: number, fiscalProfile: FiscalProfile): number {
  if (fiscalProfile.pais === 'portugal') {
    const tipoEmpleo = (fiscalProfile.tipoEmpleo as TipoEmpleo) ?? 'conta_outrem';
    return calcularLiquidezMensual(mes, fiscalProfile.salarioBruto, tipoEmpleo);
  }
  // Fallback para otros países: estimación neta ~75% del bruto
  return round2(fiscalProfile.salarioBruto * 0.75);
}

function generarAlertas(
  ingresos: number,
  gastos: number,
  saldo: number,
  perfil: Perfil,
): Alerta[] {
  const alertas: Alerta[] = [];

  if (gastos > ingresos) {
    alertas.push({
      tipo: 'danger',
      mensaje: `Gastos proyectados (${gastos.toFixed(2)}€) superan los ingresos esperados (${ingresos.toFixed(2)}€).`,
    });
  } else if (gastos > ingresos * 0.8) {
    alertas.push({
      tipo: 'warning',
      mensaje: `Gastos proyectados representan más del 80% de los ingresos (${Math.round((gastos / ingresos) * 100)}%).`,
    });
  }

  const necesidadMensualMetas = (perfil.metas ?? [])
    .filter(m => !m.completada && m.montoObjetivo > m.montoActual)
    .reduce((sum, m) => sum + (m.montoObjetivo - m.montoActual) / 12, 0);

  if (necesidadMensualMetas > 0 && saldo < necesidadMensualMetas) {
    alertas.push({
      tipo: 'warning',
      mensaje: `Saldo proyectado insuficiente para tus metas activas (necesitas ~${necesidadMensualMetas.toFixed(2)}€/mes).`,
    });
  }

  if ((perfil.extractosSubidos ?? 0) === 0) {
    alertas.push({
      tipo: 'info',
      mensaje: 'Sube tu extracto bancario para mejorar la precisión de la proyección.',
    });
  }

  return alertas;
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}
