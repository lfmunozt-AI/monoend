/**
 * Tests unitarios — LLM Router con mock de fetch.
 * Ejecutar: npx tsx src/lib/llm/__tests__/router.test.ts
 *
 * Estrategia de mock: el SDK de OpenAI v6 usa el `fetch` global por debajo,
 * por lo que sustituimos `globalThis.fetch` para evitar llamadas reales y
 * controlar la respuesta del proveedor.
 */

import { callLLM, LLMError } from '../router'
import type { LLMResponse } from '../types'

// API key dummy — necesario para que el provider OpenAI no falle por AUTH
process.env.OPENAI_API_KEY = 'sk-test-dummy-key-for-mock'

// ─── Mini test runner ────────────────────────────────────────────────────────

let passed = 0
let failed = 0

async function test(name: string, fn: () => void | Promise<void>): Promise<void> {
  try {
    await fn()
    console.log(`  ✓  ${name}`)
    passed++
  } catch (e) {
    console.error(`  ✗  ${name}: ${(e as Error).message}`)
    failed++
  }
}

function assertEqual<T>(actual: T, expected: T, msg = ''): void {
  if (actual !== expected)
    throw new Error(`${msg} esperado ${JSON.stringify(expected)}, obtenido ${JSON.stringify(actual)}`)
}

function assertTrue(cond: boolean, msg: string): void {
  if (!cond) throw new Error(msg)
}

async function assertRejects(p: Promise<unknown>): Promise<unknown> {
  try {
    await p
  } catch (e) {
    return e
  }
  throw new Error('esperaba que la promesa rechazara')
}

// ─── Mock de fetch ───────────────────────────────────────────────────────────

const originalFetch = globalThis.fetch

type FetchHandler = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>

function setFetch(handler: FetchHandler): void {
  globalThis.fetch = handler as typeof globalThis.fetch
}

function restoreFetch(): void {
  globalThis.fetch = originalFetch
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

function mockOpenAISuccess(): void {
  setFetch(async () => {
    // pequeña espera para que latencyMs > 0 incluso en máquinas rápidas
    await new Promise((r) => setTimeout(r, 5))
    return jsonResponse({
      id: 'chatcmpl-test',
      object: 'chat.completion',
      created: Math.floor(Date.now() / 1000),
      model: 'gpt-4o-mini',
      choices: [
        {
          index: 0,
          message: { role: 'assistant', content: 'Hola, soy el Consigliere.' },
          finish_reason: 'stop',
        },
      ],
      usage: { prompt_tokens: 12, completion_tokens: 8, total_tokens: 20 },
    })
  })
}

function mockNetworkError(): void {
  setFetch(async () => {
    throw new TypeError('fetch failed: simulated network error')
  })
}

// ─── Tests ───────────────────────────────────────────────────────────────────

async function run() {
  console.log('\nLLM Router')

  await test('callLLM(openai) → LLMResponse válida', async () => {
    mockOpenAISuccess()
    try {
      const res: LLMResponse = await callLLM({
        provider: 'openai',
        model: 'gpt-4o-mini',
        prompt: 'Hola',
        systemPrompt: 'Eres el Consigliere.',
        temperature: 0.4,
        maxTokens: 100,
      })
      assertEqual(res.provider, 'openai', 'provider')
      assertEqual(res.model, 'gpt-4o-mini', 'model')
      assertEqual(res.text, 'Hola, soy el Consigliere.', 'text')
      assertEqual(res.tokensIn, 12, 'tokensIn')
      assertEqual(res.tokensOut, 8, 'tokensOut')
      assertEqual(res.finishReason, 'stop', 'finishReason')
    } finally {
      restoreFetch()
    }
  })

  await test('LLMResponse contiene latencyMs > 0', async () => {
    mockOpenAISuccess()
    try {
      const res = await callLLM({
        provider: 'openai',
        model: 'gpt-4o-mini',
        prompt: 'ping',
      })
      assertTrue(res.latencyMs > 0, `latencyMs debe ser > 0, obtenido ${res.latencyMs}`)
    } finally {
      restoreFetch()
    }
  })

  await test('callLLM(together) → LLMError NOT_IMPLEMENTED', async () => {
    const err = (await assertRejects(
      callLLM({ provider: 'together', model: 'mixtral-8x7b', prompt: 'hola' }),
    )) as LLMError
    assertTrue(err instanceof LLMError, 'debe ser LLMError')
    assertEqual(err.code, 'NOT_IMPLEMENTED', 'code')
    assertEqual(err.provider, 'together', 'provider')
  })

  await test('callLLM(mistral) → LLMError NOT_IMPLEMENTED', async () => {
    const err = (await assertRejects(
      callLLM({ provider: 'mistral', model: 'mistral-small', prompt: 'hola' }),
    )) as LLMError
    assertTrue(err instanceof LLMError, 'debe ser LLMError')
    assertEqual(err.code, 'NOT_IMPLEMENTED', 'code')
    assertEqual(err.provider, 'mistral', 'provider')
  })

  await test('callLLM(custom) → LLMError NOT_IMPLEMENTED', async () => {
    const err = (await assertRejects(
      callLLM({ provider: 'custom', model: 'andgcore-v1', prompt: 'hola' }),
    )) as LLMError
    assertEqual(err.code, 'NOT_IMPLEMENTED')
    assertEqual(err.provider, 'custom')
  })

  await test('Errores de red se convierten a LLMError', async () => {
    mockNetworkError()
    try {
      const err = (await assertRejects(
        callLLM({ provider: 'openai', model: 'gpt-4o-mini', prompt: 'hola' }),
      )) as LLMError
      assertTrue(err instanceof LLMError, 'debe ser LLMError')
      assertEqual(err.provider, 'openai', 'provider')
      assertTrue(
        err.code === 'NETWORK' || err.code === 'TIMEOUT' || err.code === 'UNKNOWN' || err.code === 'PROVIDER_ERROR',
        `code de red esperado, obtenido ${err.code}`,
      )
    } finally {
      restoreFetch()
    }
  })

  await test('Request inválida (prompt vacío) → LLMError INVALID_REQUEST', async () => {
    const err = (await assertRejects(
      callLLM({ provider: 'openai', model: 'gpt-4o-mini', prompt: '' }),
    )) as LLMError
    assertTrue(err instanceof LLMError, 'debe ser LLMError')
    assertEqual(err.code, 'INVALID_REQUEST', 'code')
  })

  console.log(`\n${passed} passed · ${failed} failed\n`)
  if (failed > 0) process.exit(1)
}

run().catch((e) => {
  console.error('Test runner crash:', e)
  process.exit(1)
})
