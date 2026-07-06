/**
 * @module llm/types
 * Tipos unificados para el LLM Router multiprovider.
 * Server-side only — todos los providers se invocan desde rutas server.
 */

export type LLMProvider = 'openai' | 'together' | 'mistral' | 'custom'

export type LLMModel = string

/** Razón por la que el modelo terminó de generar texto. Normalizada entre providers. */
export type LLMFinishReason =
  | 'stop'
  | 'length'
  | 'content_filter'
  | 'tool_calls'
  | 'error'
  | 'unknown'

/** Códigos de error normalizados entre providers. */
export type LLMErrorCode =
  | 'NOT_IMPLEMENTED'
  | 'INVALID_REQUEST'
  | 'AUTH'
  | 'RATE_LIMIT'
  | 'TIMEOUT'
  | 'NETWORK'
  | 'PROVIDER_ERROR'
  | 'UNKNOWN'

/**
 * Solicitud unificada al LLM Router.
 * `prompt` es el mensaje del usuario; `systemPrompt` es opcional para context.
 */
export interface LLMRequest {
  provider: LLMProvider
  model: LLMModel
  prompt: string
  systemPrompt?: string
  stream?: boolean
  temperature?: number
  maxTokens?: number
}

/**
 * Respuesta unificada del LLM Router.
 * Todos los providers deben mapear su respuesta nativa a esta estructura.
 */
export interface LLMResponse {
  text: string
  tokensIn: number
  tokensOut: number
  latencyMs: number
  provider: LLMProvider
  model: LLMModel
  finishReason: LLMFinishReason
}

/**
 * Error tipado del LLM Router. Encapsula errores de cualquier provider en una
 * estructura común con código normalizado.
 */
export class LLMError extends Error {
  readonly code: LLMErrorCode
  readonly provider: LLMProvider
  readonly cause?: unknown

  constructor(
    message: string,
    code: LLMErrorCode,
    provider: LLMProvider,
    cause?: unknown,
  ) {
    super(message)
    this.name = 'LLMError'
    this.code = code
    this.provider = provider
    this.cause = cause
    Object.setPrototypeOf(this, LLMError.prototype)
  }
}
