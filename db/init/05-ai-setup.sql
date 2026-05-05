-- Module 12: AI & Machine Learning Readiness Setup

-- Enable pgvector extension
-- Note: This requires the pgvector extension to be installed in the Postgres image.
-- For the standard postgres:16 image, this will fail unless it's a custom build like 'pgvector/pgvector:pg16'.
-- We'll assume the user is using an image with pgvector or we will just lay down the schema.
CREATE EXTENSION IF NOT EXISTS vector;

-- Table to store AI embeddings for semantic search over virtualized data
CREATE TABLE metadata_catalog.vector_store (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    data_source_id UUID REFERENCES public.data_sources(id),
    content TEXT NOT NULL,
    embedding vector(1536), -- Standard OpenAI embedding size
    metadata JSONB,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Index for fast vector similarity search (HNSW)
CREATE INDEX ON metadata_catalog.vector_store USING hnsw (embedding vector_cosine_ops);

-- Function to perform semantic search
CREATE OR REPLACE FUNCTION admin_functions.semantic_search(query_embedding vector(1536), match_threshold FLOAT, match_count INT)
RETURNS TABLE (
    id UUID,
    content TEXT,
    metadata JSONB,
    similarity FLOAT
) AS $$
BEGIN
    RETURN QUERY
    SELECT
        v.id,
        v.content,
        v.metadata,
        1 - (v.embedding <=> query_embedding) AS similarity
    FROM metadata_catalog.vector_store v
    WHERE 1 - (v.embedding <=> query_embedding) > match_threshold
    ORDER BY v.embedding <=> query_embedding
    LIMIT match_count;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

GRANT SELECT ON metadata_catalog.vector_store TO web_anon;
GRANT EXECUTE ON FUNCTION admin_functions.semantic_search(vector(1536), FLOAT, INT) TO authenticator;
