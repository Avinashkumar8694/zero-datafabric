-- Trigger Control Plane: registry + deployment/execution visibility

CREATE TABLE IF NOT EXISTS public.trigger_registry (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id TEXT NOT NULL,
    schema_name TEXT NOT NULL,
    table_name TEXT NOT NULL,
    trigger_name TEXT NOT NULL,
    definition JSONB NOT NULL,
    status TEXT NOT NULL DEFAULT 'ACTIVE',
    last_deployed_at TIMESTAMP,
    created_by TEXT,
    created_at TIMESTAMP DEFAULT NOW(),
    updated_at TIMESTAMP DEFAULT NOW(),
    UNIQUE (tenant_id, schema_name, table_name, trigger_name)
);

CREATE TABLE IF NOT EXISTS public.trigger_execution_logs (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id TEXT NOT NULL,
    trigger_id UUID REFERENCES public.trigger_registry(id) ON DELETE SET NULL,
    trigger_name TEXT NOT NULL,
    schema_name TEXT,
    table_name TEXT,
    event_type TEXT,
    action TEXT NOT NULL,
    status TEXT NOT NULL,
    detail JSONB,
    created_at TIMESTAMP DEFAULT NOW()
);

ALTER TABLE public.trigger_registry ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS trigger_registry_tenant_policy ON public.trigger_registry;
CREATE POLICY trigger_registry_tenant_policy ON public.trigger_registry
    USING (tenant_id = current_setting('app.tenant_id', true));

ALTER TABLE public.trigger_execution_logs ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS trigger_execution_logs_tenant_policy ON public.trigger_execution_logs;
CREATE POLICY trigger_execution_logs_tenant_policy ON public.trigger_execution_logs
    USING (tenant_id = current_setting('app.tenant_id', true));

GRANT SELECT, INSERT, UPDATE, DELETE ON public.trigger_registry TO fabric_user;
GRANT SELECT, INSERT ON public.trigger_execution_logs TO fabric_user;
