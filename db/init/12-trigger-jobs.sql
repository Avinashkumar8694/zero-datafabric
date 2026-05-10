CREATE TABLE IF NOT EXISTS public.trigger_jobs (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id TEXT NOT NULL,
    trigger_id UUID REFERENCES public.trigger_registry(id) ON DELETE SET NULL,
    job_type TEXT NOT NULL,
    payload JSONB NOT NULL DEFAULT '{}'::jsonb,
    status TEXT NOT NULL DEFAULT 'PENDING',
    run_at TIMESTAMP DEFAULT NOW(),
    attempts INT NOT NULL DEFAULT 0,
    max_attempts INT NOT NULL DEFAULT 5,
    last_error TEXT,
    created_by TEXT,
    created_at TIMESTAMP DEFAULT NOW(),
    updated_at TIMESTAMP DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_trigger_jobs_pending ON public.trigger_jobs(status, run_at);

ALTER TABLE public.trigger_jobs ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS trigger_jobs_tenant_policy ON public.trigger_jobs;
CREATE POLICY trigger_jobs_tenant_policy ON public.trigger_jobs
    USING (tenant_id = current_setting('app.tenant_id', true));

GRANT SELECT, INSERT, UPDATE, DELETE ON public.trigger_jobs TO fabric_user;
