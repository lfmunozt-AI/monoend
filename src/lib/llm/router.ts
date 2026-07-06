/**
 * @module llm/router
 * Router unificado para llamadas a LLMs de múltiples providers.
 *
 * Punto de entrada único: `callLLM(req)` despacha al provider correcto,
 * mide latencia y normaliza errores a LLMError.
 *
 * Server-side only — los providers usan claves de API del entorno.
 */

import type { LLMRequest, LLMResponse } from './types'
import { LLMError } from './types'
import { callOpenAI } from './providers/openai'
import { callTogether } from './providers/together'
import { callMistral } from './providers/mistral'
import { callCustom } from './providers/custom'

export type { LLMRequest, LLMResponse, LLMProvider, LLMModel, LLMFinishReason, LLMErrorCode } from './types'
export { LLMError } from './types'

/**
 * Llama al LLM seleccionado y devuelve una respuesta unificada.
 *
 * El router garantiza:
 *  - latencyMs > 0 medido alrededor de la llamada al provider.
 *  - cualquier error se convierte a `LLMError` tipado.
 *  - el provider devuelto en la respuesta coincide con `req.provider`.
 *
 * @throws LLMError siempre que la llamada falle (auth, rate limit, network,
 *                  provider no implementado, etc.)
 */
export async function callLLM(req: LLMRequest): Promise<LLMResponse> {
  validateRequest(req)
  const startedAt = Date.now()

  try {
    const response = await dispatch(req)
    if (!response.latencyMs || response.latencyMs <= 0) {
      return { ...response, latencyMs: Math.max(1, Date.now() - startedAt) }
    }
    return response
  } catch (err) {
    if (err instanceof LLMError) throw err
    const message = err instanceof Error ? err.message : 'Error desconocido en el router LLM'
    throw new LLMError(message, 'UNKNOWN', req.provider, err)
  }
}

function validateRequest(req: LLMRequest): void {
  if (!req || typeof req !== 'object') {
    throw new LLMError('LLMRequest inválido', 'INVALID_REQUEST', 'openai')
  }
  if (!req.provider) {
    throw new LLMError('LLMRequest.provider es requerido', 'INVALID_REQUEST', 'openai')
  }
  if (!req.model || typeof req.model !== 'string') {
    throw new LLMError('LLMRequest.model es requerido', 'INVALID_REQUEST', req.provider)
  }
  if (typeof req.prompt !== 'string' || req.prompt.length === 0) {
    throw new LLMError('LLMRequest.prompt es requerido', 'INVALID_REQUEST', req.provider)
  }
}

function dispatch(req: LLMRequest): Promise<LLMResponse> {
  switch (req.provider) {
    case 'openai':
      return callOpenAI(req)
    case 'together':
      return callTogether(req)
    case 'mistral':
      return callMistral(req)
    case 'custom':
      return callCustom(req)
    default: {
      const exhaustive: never = req.provider
      throw new LLMError(
        `Provider no soportado: ${String(exhaustive)}`,
        'INVALID_REQUEST',
        'openai',
      )
    }
  }
}
