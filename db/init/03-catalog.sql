-- Metadata Catalog & Data Quality Schema

CREATE SCHEMA IF NOT EXISTS fabric_catalog;
GRANT ALL ON SCHEMA fabric_catalog TO public;

-- Central Metadata Store
CREATE TABLE IF NOT EXISTS fabric_catalog.metadata (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    source_id UUID REFERENCES public.data_sources(id),
    schema_name TEXT NOT NULL,
    table_name TEXT NOT NULL,
    column_name TEXT NOT NULL,
    data_type TEXT NOT NULL,
    is_nullable BOOLEAN,
    description TEXT,
    last_crawled_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    UNIQUE (schema_name, table_name, column_name)
);

-- Quality Metrics Store
CREATE TABLE IF NOT EXISTS fabric_catalog.quality_metrics (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    column_id UUID REFERENCES fabric_catalog.metadata(id),
    metric_type TEXT NOT NULL, -- 'NULL_RATE', 'CARDINALITY', etc.
    metric_value NUMERIC NOT NULL,
    measured_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Enable RLS for Metadata
ALTER TABLE fabric_catalog.metadata ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS tenant_metadata_policy ON fabric_catalog.metadata;
CREATE POLICY tenant_metadata_policy ON fabric_catalog.metadata
    USING (schema_name = 'tenant_' || current_setting('app.tenant_id', true));

GRANT ALL ON ALL TABLES IN SCHEMA fabric_catalog TO public;
GRANT ALL ON ALL SEQUENCES IN SCHEMA fabric_catalog TO public;

-- 3. Public View for Management Orchestration
CREATE OR REPLACE VIEW public.metadata_catalog AS SELECT * FROM fabric_catalog.metadata;
GRANT SELECT ON public.metadata_catalog TO public;
