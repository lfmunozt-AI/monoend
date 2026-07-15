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

// ── Function calling (OpenAI-compatible: vLLM/Mistral lo soportan) ────────────
// El LLM hace la EXTRACCIÓN (lo que sabe hacer); el código calcula y marca. Se
// mantiene el patrón del Router: env agnóstico, regla de credenciales, nunca
// lanza, `fromFallback`. NO toca callLLM/callLLMJson/callLLMWithHistory.

/** Definición de una tool (JSON Schema estándar). */
export interface ToolDef {
  type: 'function';
  function: { name: string; description: string; parameters: Record<string, unknown> };
}

/** Una llamada a tool emitida por el modelo (args ya parseados). */
export interface ToolCall {
  id: string;
  name: string;
  args: Record<string, unknown>;
}

/** Mensaje de conversación para el flujo con tools (incluye role:'tool'). */
export type ToolChatMessage =
  | { role: 'user' | 'assistant'; content: string }
  | { role: 'assistant'; content: string; toolCalls: ToolCall[] }
  | { role: 'tool'; toolCallId: string; content: string };

export interface LLMToolResponse {
  content: string;
  toolCalls: ToolCall[];
  tokensUsed: number;
  model: string;
  fromFallback: boolean;
}

export interface ToolsOptions {
  /** Cap de tokens. Por defecto 150 (la llamada de tools solo emite el tool_call). */
  maxTokens?: number;
  /** 'auto' (por defecto) deja decidir al modelo; 'none' fuerza texto (2º turno). */
  toolChoice?: 'auto' | 'none';
}

const TOOLS_MAX_TOKENS = 150;

/** Convierte nuestros mensajes al formato de la API (oculta la forma de OpenAI). */
function toApiMessages(
  systemPrompt: string,
  messages: ToolChatMessage[],
): OpenAI.Chat.Completions.ChatCompletionMessageParam[] {
  const out: OpenAI.Chat.Completions.ChatCompletionMessageParam[] = [
    { role: 'system', content: systemPrompt },
  ];
  for (const m of messages) {
    if (m.role === 'tool') {
      out.push({ role: 'tool', tool_call_id: m.toolCallId, content: m.content });
    } else if (m.role === 'assistant' && 'toolCalls' in m) {
      out.push({
        role: 'assistant',
        content: m.content || null,
        tool_calls: m.toolCalls.map((t) => ({
          id: t.id,
          type: 'function',
          function: { name: t.name, arguments: JSON.stringify(t.args) },
        })),
      });
    } else {
      out.push({ role: m.role, content: m.content });
    }
  }
  return out;
}

/**
 * Llama al LLM con function calling. Devuelve el texto y/o los tool_calls
 * (`args` ya parseados). Nunca lanza: ante fallo o sin API key devuelve
 * `fromFallback: true` con content vacío y sin toolCalls, para que el llamante
 * caiga a su ruta determinista (regex).
 */
export async function callLLMWithTools(
  messages: ToolChatMessage[],
  systemPrompt: string,
  tools: ToolDef[],
  options: ToolsOptions = {},
): Promise<LLMToolResponse> {
  let client: OpenAI;
  try {
    client = getClient();
  } catch {
    return { content: '', toolCalls: [], tokensUsed: 0, model: MODEL_PRIMARY, fromFallback: true };
  }

  try {
    const completion = await client.chat.completions.create({
      model: MODEL_PRIMARY,
      temperature: 0.2,
      max_tokens: options.maxTokens ?? TOOLS_MAX_TOKENS,
      tools: tools as unknown as OpenAI.Chat.Completions.ChatCompletionTool[],
      tool_choice: options.toolChoice ?? 'auto',
      messages: toApiMessages(systemPrompt, messages),
    });

    const choice = completion.choices[0]?.message;
    const tokensUsed = completion.usage?.total_tokens ?? 0;

    const toolCalls: ToolCall[] = (choice?.tool_calls ?? [])
      .filter((t) => t.type === 'function')
      .map((t) => {
        const fn = (t as { function: { name: string; arguments: string } }).function;
        let args: Record<string, unknown> = {};
        try {
          args = fn.arguments ? (JSON.parse(fn.arguments) as Record<string, unknown>) : {};
        } catch {
          args = {}; // argumentos malformados → delta vacío, el llamante decide
        }
        return { id: t.id, name: fn.name, args };
      });

    logTokens({ model: MODEL_PRIMARY, tokensUsed, prompt: 'tools' });
    return { content: choice?.content ?? '', toolCalls, tokensUsed, model: MODEL_PRIMARY, fromFallback: false };
  } catch (err) {
    const llmError = classifyError(err);
    console.error(`[llm:tools] ${llmError.code}: ${llmError.message}`);
    return { content: '', toolCalls: [], tokensUsed: 0, model: MODEL_PRIMARY, fromFallback: true };
  }
}
