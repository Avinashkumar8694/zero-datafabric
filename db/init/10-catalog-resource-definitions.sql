-- Explorer enrichment columns for resource-aware catalog rendering
ALTER TABLE public.catalog_tables
    ADD COLUMN IF NOT EXISTS resource_type VARCHAR(64) DEFAULT 'TABLE';

ALTER TABLE public.catalog_tables
    ADD COLUMN IF NOT EXISTS definition_sql TEXT;

ALTER TABLE public.catalog_tables
    ADD COLUMN IF NOT EXISTS definition_ast JSONB;
