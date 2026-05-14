/**
 * @module reporte
 * Prompt para reporte mensual en voz del Consigliere.
 * Tono: estratégico, protector, honesto. Máximo 400 palabras.
 */

export interface DatosReporte {
  mes: string;
  transacciones: unknown[];
  icaInicio: number;
  icaFin: number;
  fugas: unknown[];
  logros: string[];
}

/**
 * Genera el prompt para el reporte mensual en voz del Consigliere.
 * Produce un análisis narrativo estratégico, no un resumen de datos.
 */
export function buildReportPrompt(datos: DatosReporte): string {
  const { mes, transacciones, icaInicio, icaFin, fugas, logros } = datos;
  const deltaICA = icaFin - icaInicio;
  const deltaSigno = deltaICA >= 0 ? `+${deltaICA}` : `${deltaICA}`;

  const logrosTexto = logros.length > 0
    ? logros.map((l) => `- ${l}`).join('\n')
    : '- Sin logros registrados este mes';

  return `Eres The Consigliere. Genera el reporte mensual de ${mes} para este usuario.

DATOS DEL MES
Transacciones registradas: ${transacciones.length}
ICA inicio de mes: ${icaInicio}/100
ICA fin de mes: ${icaFin}/100 (${deltaSigno} puntos)
Fugas de Poder identificadas: ${Array.isArray(fugas) ? fugas.length : 0}

LOGROS DEL MES
${logrosTexto}

DATOS COMPLETOS
${JSON.stringify({ transacciones, fugas }, null, 2)}

INSTRUCCIONES DE REDACCIÓN
- Voz: The Consigliere — frío, estratégico, protector, honesto
- NUNCA uses: "¡Excelente!", "¡Bien hecho!", frases motivacionales vacías
- SÍ usa: terminología andgcore (Reserva de Soberanía, Fuga de Poder, Dominio Financiero, etc.)
- Estructura del reporte:
  1. DIAGNÓSTICO (2–3 frases): estado real del mes, sin suavizar
  2. FUGAS IDENTIFICADAS (si las hay): nombra cada una, impacto, acción inmediata
  3. MOVIMIENTO ICA: interpreta el delta, qué lo causó
  4. POSICIÓN ESTRATÉGICA: qué debe hacer el mes siguiente para avanzar hacia Dominio Financiero
- Máximo 400 palabras
- Sin tablas, sin listas largas — narrativa estratégica densa
- Cierra con una sola frase de orientación táctica para el próximo mes`;
}
