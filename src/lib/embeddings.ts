/**
 * @module embeddings
 * Generación y búsqueda de embeddings con text-embedding-3-small.
 * Server-side only — no importar desde componentes cliente.
 */

import OpenAI from 'openai'
import { adminClient } from './supabase/admin'

const EMBEDDING_MODEL = 'text-embedding-3-small'

function getOpenAIClient(): OpenAI {
  const apiKey = process.env.OPENAI_API_KEY
  if (!apiKey) throw new Error('[embeddings] OPENAI_API_KEY not configured')
  return new OpenAI({ apiKey })
}

/**
 * Genera un vector de embedding para el texto dado.
 * Trunca a 8192 caracteres para mantenerse dentro del límite de tokens.
 */
export async function generateEmbedding(text: string): Promise<number[]> {
  const client = getOpenAIClient()
  const response = await client.embeddings.create({
    model: EMBEDDING_MODEL,
    input: text.slice(0, 8192),
  })
  return response.data[0].embedding
}

/**
 * Persiste un embedding en la tabla embeddings via service role.
 * Usa adminClient para bypassear RLS en operaciones servidor-a-servidor.
 */
export async function storeEmbedding(
  userId: string,
  content: string,
  embedding: number[],
  metadata: Record<string, unknown>,
): Promise<void> {
  const sb = adminClient()
  const { error } = await (sb as any)
    .from('embeddings')
    .insert({
      user_id: userId,
      content,
      embedding: `[${embedding.join(',')}]`,
      metadata,
    })
  if (error) throw error
}

export interface SimilarTransaction {
  id: string
  content: string
  metadata: Record<string, unknown>
  similarity: number
}

/**
 * Busca transacciones similares usando cosine similarity (RAG).
 * Requiere la función match_embeddings en Supabase (migración 006).
 */
export async function searchSimilarTransactions(
  userId: string,
  query: string,
  limit = 5,
): Promise<SimilarTransaction[]> {
  const embedding = await generateEmbedding(query)
  const sb = adminClient()

  const { data, error } = await (sb as any).rpc('match_embeddings', {
    query_embedding: `[${embedding.join(',')}]`,
    match_user_id: userId,
    match_count: limit,
  })

  if (error) {
    console.error('[embeddings] searchSimilarTransactions failed:', {
      code: error.code,
      message: error.message,
    })
    throw error
  }

  return (data ?? []) as SimilarTransaction[]
}
