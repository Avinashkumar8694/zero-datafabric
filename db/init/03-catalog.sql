-- Metadata Catalog & Data Quality Schema

CREATE SCHEMA IF NOT EXISTS fabric_catalog;
GRANT USAGE ON SCHEMA fabric_catalog TO fabric_user;

-- Central Metadata Store
CREATE TABLE fabric_catalog.metadata (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
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
CREATE TABLE fabric_catalog.quality_metrics (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    column_id UUID REFERENCES fabric_catalog.metadata(id),
    metric_type TEXT NOT NULL, -- 'NULL_RATE', 'CARDINALITY', etc.
    metric_value NUMERIC NOT NULL,
    measured_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Enable RLS for Metadata
ALTER TABLE fabric_catalog.metadata ENABLE ROW LEVEL SECURITY;

CREATE POLICY tenant_metadata_policy ON fabric_catalog.metadata
    USING (schema_name = 'tenant_' || (current_setting('request.jwt.claims', true)::json->>'tenant_id'));

GRANT SELECT ON fabric_catalog.metadata TO fabric_user;
GRANT SELECT ON fabric_catalog.quality_metrics TO fabric_user;
