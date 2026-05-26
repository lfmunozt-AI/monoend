/**
 * @module llm/providers/openai
 * Implementación real del provider OpenAI usando el SDK oficial.
 * Mapea respuestas nativas a LLMResponse y normaliza errores a LLMError.
 *
 * Server-side only — usa OPENAI_API_KEY del entorno.
 */

import OpenAI from 'openai'
import type { LLMRequest, LLMResponse, LLMFinishReason } from '../types'
import { LLMError } from '../types'

const DEFAULT_TIMEOUT_MS = 30_000

function getClient(): OpenAI {
  const apiKey = process.env.OPENAI_API_KEY
  if (!apiKey) {
    throw new LLMError(
      'OPENAI_API_KEY no configurada en el servidor',
      'AUTH',
      'openai',
    )
  }
  return new OpenAI({ apiKey, timeout: DEFAULT_TIMEOUT_MS })
}

function mapFinishReason(reason: string | null | undefined): LLMFinishReason {
  switch (reason) {
    case 'stop':
      return 'stop'
    case 'length':
      return 'length'
    case 'content_filter':
      return 'content_filter'
    case 'tool_calls':
    case 'function_call':
      return 'tool_calls'
    default:
      return reason ? 'unknown' : 'stop'
  }
}

function toLLMError(err: unknown): LLMError {
  if (err instanceof LLMError) return err
  if (err instanceof OpenAI.APIConnectionTimeoutError) {
    return new LLMError('Timeout al conectar con OpenAI', 'TIMEOUT', 'openai', err)
  }
  if (err instanceof OpenAI.RateLimitError) {
    return new LLMError('Rate limit de OpenAI alcanzado', 'RATE_LIMIT', 'openai', err)
  }
  if (err instanceof OpenAI.AuthenticationError) {
    return new LLMError('API key de OpenAI inválida', 'AUTH', 'openai', err)
  }
  if (err instanceof OpenAI.APIConnectionError) {
    return new LLMError(`Error de red OpenAI: ${err.message}`, 'NETWORK', 'openai', err)
  }
  if (err instanceof OpenAI.BadRequestError) {
    return new LLMError(`Solicitud inválida: ${err.message}`, 'INVALID_REQUEST', 'openai', err)
  }
  if (err instanceof OpenAI.APIError) {
    return new LLMError(`Error de API OpenAI: ${err.message}`, 'PROVIDER_ERROR', 'openai', err)
  }
  const message = err instanceof Error ? err.message : 'Error desconocido en OpenAI'
  return new LLMError(message, 'UNKNOWN', 'openai', err)
}

function buildMessages(req: LLMRequest): Array<{ role: 'system' | 'user'; content: string }> {
  const messages: Array<{ role: 'system' | 'user'; content: string }> = []
  if (req.systemPrompt) messages.push({ role: 'system', content: req.systemPrompt })
  messages.push({ role: 'user', content: req.prompt })
  return messages
}

async function callOpenAINonStreaming(req: LLMRequest, startedAt: number): Promise<LLMResponse> {
  const client = getClient()
  const completion = await client.chat.completions.create({
    model: req.model,
    messages: buildMessages(req),
    temperature: req.temperature,
    max_tokens: req.maxTokens,
    stream: false,
  })

  const choice = completion.choices[0]
  const text = choice?.message?.content ?? ''
  const tokensIn = completion.usage?.prompt_tokens ?? 0
  const tokensOut = completion.usage?.completion_tokens ?? 0

  return {
    text,
    tokensIn,
    tokensOut,
    latencyMs: Math.max(1, Date.now() - startedAt),
    provider: 'openai',
    model: req.model,
    finishReason: mapFinishReason(choice?.finish_reason),
  }
}

async function callOpenAIStreaming(req: LLMRequest, startedAt: number): Promise<LLMResponse> {
  const client = getClient()
  const stream = await client.chat.completions.create({
    model: req.model,
    messages: buildMessages(req),
    temperature: req.temperature,
    max_tokens: req.maxTokens,
    stream: true,
    stream_options: { include_usage: true },
  })

  let text = ''
  let tokensIn = 0
  let tokensOut = 0
  let finishReasonRaw: string | null | undefined = null

  for await (const chunk of stream) {
    const delta = chunk.choices[0]?.delta?.content
    if (delta) text += delta
    if (chunk.choices[0]?.finish_reason) finishReasonRaw = chunk.choices[0].finish_reason
    if (chunk.usage) {
      tokensIn = chunk.usage.prompt_tokens ?? tokensIn
      tokensOut = chunk.usage.completion_tokens ?? tokensOut
    }
  }

  return {
    text,
    tokensIn,
    tokensOut,
    latencyMs: Math.max(1, Date.now() - startedAt),
    provider: 'openai',
    model: req.model,
    finishReason: mapFinishReason(finishReasonRaw),
  }
}

/**
 * Llama a OpenAI usando el SDK oficial. Soporta streaming y no-streaming.
 * Mide latencia y mapea respuesta/errores al formato unificado.
 *
 * @throws LLMError siempre que falle (auth, rate limit, network, etc.)
 */
export async function callOpenAI(req: LLMRequest): Promise<LLMResponse> {
  const startedAt = Date.now()
  try {
    return req.stream
      ? await callOpenAIStreaming(req, startedAt)
      : await callOpenAINonStreaming(req, startedAt)
  } catch (err) {
    throw toLLMError(err)
  }
}
