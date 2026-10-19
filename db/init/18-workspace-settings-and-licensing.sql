-- System + workspace settings, per-workspace plan assignment, plan requests, system audit.

CREATE TABLE IF NOT EXISTS public.settings (
    key VARCHAR(100) PRIMARY KEY,
    value JSONB
);

ALTER TABLE public.tenants
    ADD COLUMN IF NOT EXISTS settings        JSONB       NOT NULL DEFAULT '{}'::jsonb,
    ADD COLUMN IF NOT EXISTS plan_name       VARCHAR(255),
    ADD COLUMN IF NOT EXISTS plan_started_at TIMESTAMPTZ,
    ADD COLUMN IF NOT EXISTS plan_expires_at TIMESTAMPTZ,
    ADD COLUMN IF NOT EXISTS plan_overrides  JSONB       NOT NULL DEFAULT '{}'::jsonb,
    ADD COLUMN IF NOT EXISTS trial_used_at   TIMESTAMPTZ,
    ADD COLUMN IF NOT EXISTS user_id         UUID,
    ADD COLUMN IF NOT EXISTS created_by      UUID;

ALTER TABLE public.plans
    ADD COLUMN IF NOT EXISTS status         VARCHAR(50) DEFAULT 'active',
    ADD COLUMN IF NOT EXISTS description    TEXT,
    ADD COLUMN IF NOT EXISTS contact_config JSONB,
    ADD COLUMN IF NOT EXISTS max_tenants    INTEGER DEFAULT -1;

CREATE TABLE IF NOT EXISTS public.plan_requests (
    id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id   VARCHAR(255) NOT NULL REFERENCES public.tenants(id) ON DELETE CASCADE,
    requested_by VARCHAR(255),
    plan_name   VARCHAR(255) NOT NULL,
    message     TEXT,
    status      VARCHAR(20) NOT NULL DEFAULT 'open' CHECK (status IN ('open','approved','rejected','closed')),
    resolved_by VARCHAR(255),
    resolved_at TIMESTAMPTZ,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_plan_requests_tenant ON public.plan_requests (tenant_id, status);

CREATE TABLE IF NOT EXISTS public.system_events (
    id         BIGSERIAL PRIMARY KEY,
    actor      VARCHAR(255),
    action     VARCHAR(60) NOT NULL,
    tenant_id  VARCHAR(255),
    detail     JSONB NOT NULL DEFAULT '{}'::jsonb,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_system_events_created ON public.system_events (created_at DESC);
CREATE INDEX IF NOT EXISTS idx_system_events_tenant ON public.system_events (tenant_id, created_at DESC);

-- Platform tables are never reachable by the tenant role.
REVOKE ALL ON public.settings, public.plan_requests, public.system_events FROM PUBLIC;
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'fabric_user') THEN
    EXECUTE 'REVOKE ALL ON public.settings, public.plan_requests, public.system_events FROM fabric_user';
  END IF;
END $$;

-- The unlimited self-host plan is assigned by a platform admin / licence only, never self-selected.
UPDATE public.plans SET status = 'hidden' WHERE name = 'selfhost' AND COALESCE(status, 'active') = 'active';
