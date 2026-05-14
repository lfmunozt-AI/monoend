-- Migration 006: función RPC para búsqueda semántica de embeddings (RAG)
-- Requiere la extensión vector (pgvector) ya habilitada en migración 001.

CREATE OR REPLACE FUNCTION match_embeddings(
  query_embedding  vector(1536),
  match_user_id    uuid,
  match_count      int DEFAULT 5
)
RETURNS TABLE (
  id          uuid,
  content     text,
  metadata    jsonb,
  similarity  float
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  RETURN QUERY
  SELECT
    e.id,
    e.content,
    e.metadata,
    -- cosine similarity = 1 - cosine distance (<=>)
    (1 - (e.embedding <=> query_embedding))::float AS similarity
  FROM public.embeddings e
  WHERE e.user_id = match_user_id
  ORDER BY e.embedding <=> query_embedding
  LIMIT match_count;
END;
$$;
