/**
 * @module llm
 * Cliente LLM — OpenAI gpt-4o-mini con fallback y registro de tokens.
 * API key solo en servidor. No importar desde componentes cliente.
 */

import OpenAI from 'openai';

export interface LLMResponse {
  content: string;
  tokensUsed: number;
  model: string;
  fromFallback: boolean;
}

export interface LLMError {
  code: 'api_error' | 'timeout' | 'rate_limit' | 'invalid_key' | 'unknown';
  message: string;
}

const MODEL_PRIMARY = 'gpt-4o-mini';
const TIMEOUT_MS = 30_000;

/**
 * Cap de generación del chat. El Consigliere responde en ≤120 palabras (ver
 * REGLAS DE CONDUCTA en prompts/consigliere.ts); 400 tokens dan margen de sobra
 * y recortan la latencia, que es lineal en tokens generados.
 */
const CHAT_MAX_TOKENS = 400;

function getClient(): OpenAI {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    throw new Error('OPENAI_API_KEY no configurada en el servidor');
  }
  return new OpenAI({ apiKey, timeout: TIMEOUT_MS });
}

function classifyError(err: unknown): LLMError {
  if (err instanceof OpenAI.APIConnectionTimeoutError) {
    return { code: 'timeout', message: 'Timeout al conectar con OpenAI' };
  }
  if (err instanceof OpenAI.RateLimitError) {
    return { code: 'rate_limit', message: 'Límite de tasa de OpenAI alcanzado' };
  }
  if (err instanceof OpenAI.AuthenticationError) {
    return { code: 'invalid_key', message: 'API key de OpenAI inválida o expirada' };
  }
  if (err instanceof OpenAI.APIError) {
    return { code: 'api_error', message: `Error de API OpenAI: ${err.message}` };
  }
  const message = err instanceof Error ? err.message : 'Error desconocido';
  return { code: 'unknown', message };
}

const FALLBACK_RESPONSE =
  'El Consigliere no está disponible en este momento. Revisa tu conexión o intenta en unos minutos.';

/**
 * Llama al LLM con el prompt del usuario y el system prompt del Consigliere.
 * Registra tokens usados y retorna fallback si OpenAI falla.
 *
 * @param prompt - Mensaje del usuario
 * @param systemPrompt - System prompt generado por buildSystemPrompt()
 * @returns LLMResponse con contenido, tokens y metadata
 * @throws never — siempre retorna, usa fromFallback=true en caso de error
 */
export async function callLLM(
  prompt: string,
  systemPrompt: string,
): Promise<LLMResponse> {
  let client: OpenAI;

  try {
    client = getClient();
  } catch {
    return {
      content: FALLBACK_RESPONSE,
      tokensUsed: 0,
      model: MODEL_PRIMARY,
      fromFallback: true,
    };
  }

  try {
    const completion = await client.chat.completions.create({
      model: MODEL_PRIMARY,
      temperature: 0.4,
      max_tokens: 600,
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: prompt },
      ],
    });

    const choice = completion.choices[0];
    const content = choice?.message?.content ?? FALLBACK_RESPONSE;
    const tokensUsed = completion.usage?.total_tokens ?? 0;

    logTokens({ model: MODEL_PRIMARY, tokensUsed, prompt: prompt.slice(0, 80) });

    return {
      content,
      tokensUsed,
      model: MODEL_PRIMARY,
      fromFallback: false,
    };
  } catch (err) {
    const llmError = classifyError(err);
    console.error(`[llm] ${llmError.code}: ${llmError.message}`);

    return {
      content: FALLBACK_RESPONSE,
      tokensUsed: 0,
      model: MODEL_PRIMARY,
      fromFallback: true,
    };
  }
}

/**
 * Variante para prompts que deben retornar JSON (categorización, detección de fugas).
 * Usa response_format json_object y retorna string parseado o null.
 */
export async function callLLMJson<T = unknown>(
  prompt: string,
  systemPrompt: string,
): Promise<T | null> {
  let client: OpenAI;

  try {
    client = getClient();
  } catch {
    return null;
  }

  try {
    const completion = await client.chat.completions.create({
      model: MODEL_PRIMARY,
      temperature: 0.2,
      max_tokens: 800,
      response_format: { type: 'json_object' },
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: prompt },
      ],
    });

    const content = completion.choices[0]?.message?.content;
    const tokensUsed = completion.usage?.total_tokens ?? 0;

    logTokens({ model: MODEL_PRIMARY, tokensUsed, prompt: prompt.slice(0, 80) });

    if (!content) return null;
    return JSON.parse(content) as T;
  } catch (err) {
    const llmError = classifyError(err);
    console.error(`[llm:json] ${llmError.code}: ${llmError.message}`);
    return null;
  }
}

/** Opciones del chat. Todas opcionales: la firma previa sigue siendo válida. */
export interface ChatOptions {
  /** Cap de tokens generados. Por defecto `CHAT_MAX_TOKENS` (400). */
  maxTokens?: number;
}

/**
 * Variante con historial de conversación para el chat CFO.
 * Acepta el array completo de mensajes (incluyendo el último mensaje del usuario).
 * Nunca lanza — retorna fromFallback=true si OpenAI falla.
 */
export async function callLLMWithHistory(
  messages: Array<{ role: 'user' | 'assistant'; content: string }>,
  systemPrompt: string,
  options: ChatOptions = {},
): Promise<LLMResponse> {
  let client: OpenAI;

  try {
    client = getClient();
  } catch {
    return { content: FALLBACK_RESPONSE, tokensUsed: 0, model: MODEL_PRIMARY, fromFallback: true };
  }

  const lastPrompt = messages.at(-1)?.content ?? '';
  const maxTokens = Math.min(options.maxTokens ?? CHAT_MAX_TOKENS, CHAT_MAX_TOKENS);

  try {
    const completion = await client.chat.completions.create({
      model: MODEL_PRIMARY,
      temperature: 0.4,
      max_tokens: maxTokens,
      messages: [
        { role: 'system', content: systemPrompt },
        ...messages.map((m) => ({ role: m.role, content: m.content })),
      ],
    });

    const content = completion.choices[0]?.message?.content ?? FALLBACK_RESPONSE;
    const tokensUsed = completion.usage?.total_tokens ?? 0;

    logTokens({ model: MODEL_PRIMARY, tokensUsed, prompt: lastPrompt.slice(0, 80) });

    return { content, tokensUsed, model: MODEL_PRIMARY, fromFallback: false };
  } catch (err) {
    const llmError = classifyError(err);
    console.error(`[llm:history] ${llmError.code}: ${llmError.message}`);
    return { content: FALLBACK_RESPONSE, tokensUsed: 0, model: MODEL_PRIMARY, fromFallback: true };
  }
}

function logTokens(entry: { model: string; tokensUsed: number; prompt: string }): void {
  if (process.env.NODE_ENV === 'development') {
    console.log(`[llm] tokens_used=${entry.tokensUsed} model=${entry.model} prompt="${entry.prompt}..."`);
  }
}
