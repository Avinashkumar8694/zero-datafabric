-- 1. Add user tracking to tenants
ALTER TABLE public.tenants
  ADD COLUMN IF NOT EXISTS user_id UUID,
  ADD COLUMN IF NOT EXISTS created_by UUID;

CREATE INDEX IF NOT EXISTS idx_tenants_user_id ON public.tenants(user_id);

-- 2. Update plans table with tenant limits and contact config
ALTER TABLE public.plans
  ADD COLUMN IF NOT EXISTS max_tenants INTEGER DEFAULT -1,
  ADD COLUMN IF NOT EXISTS status VARCHAR(50) DEFAULT 'active',
  ADD COLUMN IF NOT EXISTS contact_config JSONB;

-- 3. Migrate subscriptions from tenant-based to user-based
ALTER TABLE public.subscriptions
  ADD COLUMN IF NOT EXISTS user_id UUID;

ALTER TABLE public.subscriptions
  DROP CONSTRAINT IF EXISTS unique_tenant_subscription;

ALTER TABLE public.subscriptions
  DROP CONSTRAINT IF EXISTS subscriptions_tenant_id_fkey;

ALTER TABLE public.subscriptions
  DROP COLUMN IF EXISTS tenant_id;

ALTER TABLE public.subscriptions
  DROP CONSTRAINT IF EXISTS unique_user_subscription;

ALTER TABLE public.subscriptions
  ADD CONSTRAINT unique_user_subscription UNIQUE (user_id);

ALTER TABLE public.subscriptions
  DROP CONSTRAINT IF EXISTS fk_subscriptions_user;

ALTER TABLE public.subscriptions
  ADD CONSTRAINT fk_subscriptions_user FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE CASCADE;

CREATE INDEX IF NOT EXISTS idx_subscriptions_user_id ON public.subscriptions(user_id);
