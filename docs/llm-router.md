# LLM Router — cómo añadir un nuevo provider

El LLM Router (`src/lib/llm/`) es la abstracción única para llamar a modelos de
lenguaje desde el código de aplicación. Tiene una sola función pública:

```ts
import { callLLM, LLMError } from '@/lib/llm/router'

const res = await callLLM({
  provider: 'openai',
  model: 'gpt-4o-mini',
  prompt: '¿Cómo está mi flujo de caja?',
  systemPrompt: 'Eres el Consigliere.',
  temperature: 0.4,
  maxTokens: 600,
})
// res: { text, tokensIn, tokensOut, latencyMs, provider, model, finishReason }
```

Todos los errores se convierten a `LLMError` con `code`, `provider` y `cause`.

## Estructura

```
src/lib/llm/
  ├─ types.ts          ← tipos compartidos (LLMRequest, LLMResponse, LLMError…)
  ├─ router.ts         ← callLLM() despacha al provider correcto
  ├─ providers/
  │   ├─ openai.ts     ← real, usa el SDK oficial
  │   ├─ together.ts   ← stub
  │   ├─ mistral.ts    ← stub
  │   └─ custom.ts     ← stub (modelo propio andgcore)
  └─ __tests__/router.test.ts
```

## Añadir un nuevo provider

Sigue estos pasos cuando quieras implementar (o sustituir un stub por) un
provider real.

### 1. Declarar el provider en `types.ts`

Si es un proveedor nuevo (no uno de los stubs existentes), añade el literal al
tipo `LLMProvider`:

```ts
export type LLMProvider = 'openai' | 'together' | 'mistral' | 'custom' | 'anthropic'
```

### 2. Crear el archivo `providers/<nombre>.ts`

Exporta una función con la firma:

```ts
import type { LLMRequest, LLMResponse } from '../types'
import { LLMError } from '../types'

export async function callAnthropic(req: LLMRequest): Promise<LLMResponse> {
  const startedAt = Date.now()
  try {
    // 1. Validar / obtener API key del entorno (lanza LLMError 'AUTH' si falta).
    // 2. Hacer la llamada HTTP (fetch o SDK). Soportar req.stream cuando aplique.
    // 3. Mapear la respuesta nativa a LLMResponse:
    //    - text:        contenido textual concatenado del modelo
    //    - tokensIn:    tokens de entrada (prompt)
    //    - tokensOut:   tokens de salida (completion)
    //    - latencyMs:   Math.max(1, Date.now() - startedAt)
    //    - provider:    'anthropic'
    //    - model:       req.model
    //    - finishReason: mapear al enum LLMFinishReason
    // 4. Capturar errores y lanzarlos como LLMError con el código apropiado.
    throw new Error('TODO')
  } catch (err) {
    if (err instanceof LLMError) throw err
    throw new LLMError(
      err instanceof Error ? err.message : 'Error desconocido',
      'PROVIDER_ERROR',
      'anthropic',
      err,
    )
  }
}
```

### 3. Registrar el provider en el `dispatch` del router

En `router.ts`:

```ts
import { callAnthropic } from './providers/anthropic'

function dispatch(req: LLMRequest): Promise<LLMResponse> {
  switch (req.provider) {
    case 'openai':    return callOpenAI(req)
    case 'anthropic': return callAnthropic(req)
    // …
  }
}
```

TypeScript se encargará de que el `switch` siga siendo exhaustivo gracias al
`never` del caso `default`.

### 4. Añadir variables de entorno

- Documenta la clave (`ANTHROPIC_API_KEY`, etc.) en `.env.example`.
- Lee la variable solo dentro del provider; **nunca** desde código de UI.

### 5. Tests

Añade al menos un caso a `src/lib/llm/__tests__/router.test.ts`:

- Mock de `globalThis.fetch` (o equivalente) que devuelva una respuesta válida.
- Verifica el mapeo a `LLMResponse` (`text`, `tokensIn/Out`, `latencyMs > 0`,
  `finishReason`).
- Un caso de error de red → debe convertirse en `LLMError`.

Ejecutar:

```bash
npx tsx src/lib/llm/__tests__/router.test.ts
npx tsc --noEmit
```

## Códigos de error

`LLMError.code` está normalizado entre providers:

| Código             | Cuándo usarlo                                      |
| ------------------ | -------------------------------------------------- |
| `NOT_IMPLEMENTED`  | Provider todavía es un stub                        |
| `INVALID_REQUEST`  | Parámetros mal formados antes de salir al provider |
| `AUTH`             | Falta API key o credenciales inválidas             |
| `RATE_LIMIT`       | El provider devolvió 429                           |
| `TIMEOUT`          | La petición superó el tiempo máximo                |
| `NETWORK`          | Error de conectividad antes de tener respuesta     |
| `PROVIDER_ERROR`   | El provider devolvió 4xx/5xx genérico              |
| `UNKNOWN`          | Fallback para errores no clasificables             |

## Reglas

- El router **siempre** lanza `LLMError`; nunca filtra errores nativos del SDK.
- Los providers **deben** medir `latencyMs` desde antes de la llamada HTTP.
- No mutar `req` dentro del provider; tratarlo como inmutable.
- No registrar prompts completos en logs (PII); truncar a 80 caracteres si hace falta.
