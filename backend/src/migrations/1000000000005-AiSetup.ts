import { MigrationInterface, QueryRunner } from 'typeorm';

export class AiSetup1000000000005 implements MigrationInterface {
  name = 'AiSetup1000000000005';

  async up(queryRunner: QueryRunner): Promise<void> {
    // AI/vector setup is optional — gracefully skipped if pgvector is not installed
    await queryRunner.query(`
      DO $$
      BEGIN
        BEGIN
          CREATE EXTENSION IF NOT EXISTS vector;
        EXCEPTION WHEN OTHERS THEN
          RAISE NOTICE 'Vector extension not available, skipping AI setup.';
          RETURN;
        END;

        CREATE TABLE IF NOT EXISTS metadata_catalog.vector_store (
            id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
            data_source_id UUID REFERENCES public.data_sources(id),
            content TEXT NOT NULL,
            embedding vector(1536),
            metadata JSONB,
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        );

        CREATE INDEX IF NOT EXISTS vector_store_hnsw_idx ON metadata_catalog.vector_store USING hnsw (embedding vector_cosine_ops);

        CREATE OR REPLACE FUNCTION admin_functions.semantic_search(query_embedding vector(1536), match_threshold FLOAT, match_count INT)
        RETURNS TABLE (id UUID, content TEXT, metadata JSONB, similarity FLOAT)
        AS $body$
        BEGIN
            RETURN QUERY
            SELECT v.id, v.content, v.metadata, 1 - (v.embedding <=> query_embedding) AS similarity
            FROM metadata_catalog.vector_store v
            WHERE 1 - (v.embedding <=> query_embedding) > match_threshold
            ORDER BY v.embedding <=> query_embedding
            LIMIT match_count;
        END;
        $body$ LANGUAGE plpgsql SECURITY DEFINER;

        GRANT SELECT ON metadata_catalog.vector_store TO web_anon;
        GRANT EXECUTE ON FUNCTION admin_functions.semantic_search(vector(1536), FLOAT, INT) TO authenticator;
      END $$;
    `);
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      DROP TABLE IF EXISTS metadata_catalog.vector_store CASCADE;
    `);
  }
}
