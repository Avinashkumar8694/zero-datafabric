-- Industrial Catalog Hardening for Multi-Schema Orchestration
ALTER TABLE fabric_catalog.relationships ADD COLUMN IF NOT EXISTS tenant_id TEXT;
ALTER TABLE fabric_catalog.relationships ADD COLUMN IF NOT EXISTS name TEXT;
ALTER TABLE fabric_catalog.relationships ADD COLUMN IF NOT EXISTS source_schema TEXT;
ALTER TABLE fabric_catalog.relationships ADD COLUMN IF NOT EXISTS target_schema TEXT;

-- Drop old unique constraint if it exists and create a more comprehensive one
ALTER TABLE fabric_catalog.relationships DROP CONSTRAINT IF EXISTS relationships_schema_name_source_table_source_column_target_key;
ALTER TABLE fabric_catalog.relationships DROP CONSTRAINT IF EXISTS relationships_tenant_id_source_table_source_column_target_key;

-- New Industrial Constraint: Multi-schema uniqueness
ALTER TABLE fabric_catalog.relationships DROP CONSTRAINT IF EXISTS relationships_full_identity_key;
ALTER TABLE fabric_catalog.relationships ADD CONSTRAINT relationships_full_identity_key 
UNIQUE (tenant_id, source_schema, source_table, source_column, target_schema, target_table, target_column);

-- Metadata enrichment
ALTER TABLE fabric_catalog.metadata ADD COLUMN IF NOT EXISTS row_count BIGINT DEFAULT 0;
ALTER TABLE fabric_catalog.metadata ADD COLUMN IF NOT EXISTS last_crawled_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP;

-- Recreate view to include new columns (Postgres requirement)
DROP VIEW IF EXISTS public.metadata_catalog;
CREATE OR REPLACE VIEW public.metadata_catalog WITH (security_invoker = true) AS SELECT * FROM fabric_catalog.metadata;
GRANT SELECT ON public.metadata_catalog TO public;
