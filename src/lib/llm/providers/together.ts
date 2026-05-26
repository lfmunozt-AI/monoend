/**
 * @module llm/providers/together
 * Stub del provider Together AI.
 *
 * TODO: implementar llamada real a la API de Together AI.
 * Pasos pendientes:
 *   1. Añadir TOGETHER_API_KEY al entorno.
 *   2. Hacer fetch a https://api.together.xyz/v1/chat/completions con auth Bearer.
 *   3. Soportar streaming (SSE) y no-streaming, igual que el provider OpenAI.
 *   4. Mapear `usage.prompt_tokens` / `usage.completion_tokens` y `finish_reason`
 *      a la estructura LLMResponse.
 *   5. Convertir errores HTTP/red a LLMError con código apropiado.
 */

import type { LLMRequest, LLMResponse } from '../types'
import { LLMError } from '../types'

export async function callTogether(_req: LLMRequest): Promise<LLMResponse> {
  throw new LLMError(
    'Together AI provider not yet implemented',
    'NOT_IMPLEMENTED',
    'together',
  )
}
