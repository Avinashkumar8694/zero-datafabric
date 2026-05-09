-- Industrial Orchestration Base Infrastructure
CREATE SCHEMA IF NOT EXISTS fabric_system;

-- Metadata Orchestration History (Plan & Apply audit trail)
CREATE TABLE IF NOT EXISTS fabric_system.metadata_history (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id TEXT NOT NULL,
    version_tag TEXT NOT NULL,
    ast_content JSONB NOT NULL,
    applied_at TIMESTAMP DEFAULT NOW(),
    summary JSONB
);

-- Downstream Service Registry (Target connectivity & sync status)
CREATE TABLE IF NOT EXISTS fabric_system.downstream_registry (
    tenant_id TEXT NOT NULL,
    target_type TEXT NOT NULL,
    config JSONB,
    status TEXT DEFAULT 'INACTIVE',
    updated_at TIMESTAMP DEFAULT NOW(),
    PRIMARY KEY (tenant_id, target_type)
);

-- Utility Functions (referenced by tenant schemas for audit defaults)
CREATE OR REPLACE FUNCTION current_user_id() RETURNS UUID AS $$
BEGIN
    RETURN COALESCE(
        NULLIF(current_setting('app.user_id', true), '')::UUID,
        '00000000-0000-0000-0000-000000000000'::UUID
    );
END;
$$ LANGUAGE plpgsql STABLE;


-- Security: Grant access to fabric_user
GRANT ALL ON SCHEMA fabric_system TO fabric_user;
GRANT ALL ON ALL TABLES IN SCHEMA fabric_system TO fabric_user;
