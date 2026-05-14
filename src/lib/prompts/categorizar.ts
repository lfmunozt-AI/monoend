/**
 * @module categorizar
 * Prompt de categorización de transacciones con detección de Fugas de Poder.
 */

export interface CategorizacionResultado {
  categoria: string;
  is_leak: boolean;
  power_law: string;
  confianza: number; // 0.0–1.0
}

/**
 * Genera el prompt para categorizar una transacción y detectar si es una Fuga de Poder.
 * El LLM debe retornar JSON estricto: { categoria, is_leak, power_law, confianza }
 */
export function buildCategorizationPrompt(descripcion: string, monto: number): string {
  return `Analiza esta transacción financiera y categorízala con precisión.

TRANSACCIÓN
Descripción: "${descripcion}"
Monto: ${monto.toFixed(2)} €

CATEGORÍAS DISPONIBLES
vivienda, alimentación, transporte, salud, educación, entretenimiento,
suscripciones, restaurantes, ropa, tecnología, seguros, inversión,
transferencia, salario, freelance, otros

DETECCIÓN DE FUGA DE PODER
Una transacción es Fuga de Poder si cumple al menos uno:
- Gasto recurrente de bajo valor percibido (suscripciones olvidadas, etc.)
- Consumo impulsivo no planificado
- Servicio duplicado o sustituible
- Gasto social por presión externa, no por valor real

LEYES DEL PODER FINANCIERO
Asigna la ley más relevante según el patrón detectado:
- "Ley de la Reserva": el gasto reduce la capacidad de Reserva de Soberanía
- "Ley del Foco": recursos dispersos en múltiples frentes sin retorno
- "Ley del Escudo": gasto que debería estar cubierto por Escudo Familiar
- "Ley de la Visibilidad": gasto opaco que dificulta el control financiero
- "Ley del Dominio": gasto alineado con metas — no es fuga, es inversión
- "Ley Neutral": transacción necesaria sin patrón de poder identificable

INSTRUCCIONES
- Retorna ÚNICAMENTE JSON válido, sin texto adicional
- confianza: número entre 0.0 y 1.0 que refleja tu certeza en la categorización
- Si la descripción es ambigua, prioriza la categoría más probable y baja confianza

FORMATO DE RESPUESTA
{
  "categoria": "<categoria>",
  "is_leak": <true|false>,
  "power_law": "<nombre de la ley>",
  "confianza": <0.0-1.0>
}`;
}
