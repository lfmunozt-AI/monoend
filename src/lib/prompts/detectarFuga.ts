/**
 * @module detectarFuga
 * Prompt de análisis de patrones para identificar Fugas de Poder recurrentes.
 */

export interface FugaDetectada {
  descripcion: string;
  categoria: string;
  frecuencia: 'diaria' | 'semanal' | 'mensual' | 'irregular';
  impactoMensual: number;
  patron: string;
  accion: string;
}

export interface ResultadoDeteccionFugas {
  fugas: FugaDetectada[];
  impactoTotalMensual: number;
  prioridad: 'critica' | 'moderada' | 'baja';
  resumen: string;
}

/**
 * Genera el prompt para análisis de patrones de Fugas de Poder en las últimas transacciones.
 * Analiza hasta 30 transacciones para identificar fugas recurrentes.
 */
export function buildLeakDetectionPrompt(transacciones: unknown[]): string {
  const muestra = transacciones.slice(0, 30);
  const transaccionesJSON = JSON.stringify(muestra, null, 2);

  return `Eres un analizador de patrones financieros. Detecta Fugas de Poder en estas transacciones.

DEFINICIÓN DE FUGA DE PODER
Gasto que drena patrimonio sin retorno proporcional de valor:
- Suscripciones activas pero no usadas
- Gastos recurrentes de bajo valor percibido
- Compras impulsivas con patrón de repetición
- Servicios duplicados
- Gastos sociales por presión, no por elección estratégica

TRANSACCIONES (últimas ${muestra.length})
${transaccionesJSON}

ANÁLISIS REQUERIDO
1. Agrupa transacciones por patrón (no por transacción individual)
2. Calcula impacto mensual estimado por patrón detectado
3. Clasifica frecuencia: diaria · semanal · mensual · irregular
4. Propone acción concreta para eliminar o reducir cada fuga
5. Determina prioridad global: crítica (>15% ingreso) · moderada (5–15%) · baja (<5%)

INSTRUCCIONES
- Retorna ÚNICAMENTE JSON válido
- Si no hay fugas claras, retorna array fugas vacío
- impactoMensual en euros (€), estimado si la frecuencia lo requiere
- accion: una frase concreta y ejecutable, máximo 15 palabras

FORMATO DE RESPUESTA
{
  "fugas": [
    {
      "descripcion": "<qué es el patrón>",
      "categoria": "<categoria>",
      "frecuencia": "<diaria|semanal|mensual|irregular>",
      "impactoMensual": <número>,
      "patron": "<descripción del patrón detectado>",
      "accion": "<acción concreta para eliminarla>"
    }
  ],
  "impactoTotalMensual": <suma de todos impactoMensual>,
  "prioridad": "<critica|moderada|baja>",
  "resumen": "<1 frase sobre el estado de fugas del usuario>"
}`;
}
