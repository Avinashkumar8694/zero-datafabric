import { MigrationInterface, QueryRunner } from 'typeorm';

export class UserPlansAndTenantLimits1000000000016 implements MigrationInterface {
  name = 'UserPlansAndTenantLimits1000000000016';

  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
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
      -- Add user_id column
      ALTER TABLE public.subscriptions
        ADD COLUMN IF NOT EXISTS user_id UUID;

      -- Drop old unique constraint on tenant_id
      ALTER TABLE public.subscriptions
        DROP CONSTRAINT IF EXISTS unique_tenant_subscription;

      -- Drop old foreign key on tenant_id
      ALTER TABLE public.subscriptions
        DROP CONSTRAINT IF EXISTS subscriptions_tenant_id_fkey;

      -- Remove tenant_id column
      ALTER TABLE public.subscriptions
        DROP COLUMN IF EXISTS tenant_id;

      -- Add new unique constraint on user_id
      ALTER TABLE public.subscriptions
        ADD CONSTRAINT unique_user_subscription UNIQUE (user_id);

      -- Create index on user_id
      CREATE INDEX IF NOT EXISTS idx_subscriptions_user_id ON public.subscriptions(user_id);

      -- 4. Make users.tenant_id nullable (users are not bound to a single tenant)
      ALTER TABLE public.users
        ALTER COLUMN tenant_id DROP NOT NULL;

      -- 5. Update plan limits to include tenant limits
      UPDATE public.plans SET limits = jsonb_set(limits, '{max_tenants}', '3') WHERE name = 'trial';
      UPDATE public.plans SET limits = jsonb_set(limits, '{max_tenants}', '-1') WHERE name = 'selfhost';
    `);
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      -- Revert users.tenant_id to NOT NULL
      ALTER TABLE public.users
        ALTER COLUMN tenant_id SET NOT NULL;

      -- Revert subscriptions back to tenant-based
      ALTER TABLE public.subscriptions
        DROP CONSTRAINT IF EXISTS unique_user_subscription;

      ALTER TABLE public.subscriptions
        DROP COLUMN IF EXISTS user_id;

      ALTER TABLE public.subscriptions
        ADD COLUMN tenant_id VARCHAR(255);

      ALTER TABLE public.subscriptions
        ADD CONSTRAINT unique_tenant_subscription UNIQUE (tenant_id);

      ALTER TABLE public.subscriptions
        ADD CONSTRAINT subscriptions_tenant_id_fkey
          FOREIGN KEY (tenant_id) REFERENCES public.tenants(id) ON DELETE CASCADE;

      CREATE INDEX IF NOT EXISTS idx_subscriptions_tenant_id ON public.subscriptions(tenant_id);

      -- Remove tenant tracking from tenants
      ALTER TABLE public.tenants
        DROP COLUMN IF EXISTS user_id,
        DROP COLUMN IF EXISTS created_by;

      DROP INDEX IF EXISTS idx_tenants_user_id;

      -- Remove added columns from plans
      ALTER TABLE public.plans
        DROP COLUMN IF EXISTS max_tenants,
        DROP COLUMN IF EXISTS status,
        DROP COLUMN IF EXISTS contact_config;
    `);
  }
}
