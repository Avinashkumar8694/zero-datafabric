CREATE TABLE IF NOT EXISTS public.es_mutation_jobs (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id TEXT NOT NULL,
    schema_name TEXT NOT NULL,
    table_name TEXT NOT NULL,
    action TEXT NOT NULL,
    payload JSONB NOT NULL DEFAULT '{}'::jsonb,
    status TEXT NOT NULL DEFAULT 'PENDING',
    attempts INT NOT NULL DEFAULT 0,
    max_attempts INT NOT NULL DEFAULT 8,
    last_error TEXT,
    run_at TIMESTAMP DEFAULT NOW(),
    created_at TIMESTAMP DEFAULT NOW(),
    updated_at TIMESTAMP DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_es_mutation_jobs_pending ON public.es_mutation_jobs(status, run_at);

ALTER TABLE public.es_mutation_jobs ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS es_mutation_jobs_tenant_policy ON public.es_mutation_jobs;
CREATE POLICY es_mutation_jobs_tenant_policy ON public.es_mutation_jobs
    USING (tenant_id = current_setting('app.tenant_id', true));

GRANT SELECT, INSERT, UPDATE, DELETE ON public.es_mutation_jobs TO fabric_user;
