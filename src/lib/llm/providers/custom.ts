/**
 * @module llm/providers/custom
 * Stub del provider "custom" — reservado para el futuro modelo propio
 * hosteado en infraestructura andgcore.
 *
 * TODO: implementar el cliente HTTP cuando el modelo propio esté disponible.
 * Pasos pendientes:
 *   1. Definir endpoint interno (ej. ANDGCORE_LLM_URL) y mecanismo de auth.
 *   2. Establecer contrato request/response del servicio propio y mapearlo
 *      a LLMRequest / LLMResponse.
 *   3. Soportar streaming si la infraestructura propia lo expone.
 *   4. Convertir errores HTTP/red a LLMError con código apropiado.
 */

import type { LLMRequest, LLMResponse } from '../types'
import { LLMError } from '../types'

export async function callCustom(_req: LLMRequest): Promise<LLMResponse> {
  throw new LLMError(
    'Custom andgcore provider not yet implemented',
    'NOT_IMPLEMENTED',
    'custom',
  )
}
