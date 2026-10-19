import { MigrationInterface, QueryRunner } from 'typeorm';

export class PlansLicensing1000000000015 implements MigrationInterface {
  name = 'PlansLicensing1000000000015';

  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS public.plans (
          id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
          name VARCHAR(255) UNIQUE NOT NULL,
          price_monthly DECIMAL(10, 2) DEFAULT 0.00,
          limits JSONB NOT NULL,
          features JSONB NOT NULL,
          is_default BOOLEAN DEFAULT false,
          is_custom BOOLEAN DEFAULT false,
          created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );

      CREATE TABLE IF NOT EXISTS public.subscriptions (
          id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
          tenant_id VARCHAR(255) REFERENCES public.tenants(id) ON DELETE CASCADE,
          plan_id UUID REFERENCES public.plans(id) ON DELETE CASCADE,
          status VARCHAR(50) DEFAULT 'active',
          start_date TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
          end_date TIMESTAMP,
          snapshot JSONB,
          created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
          CONSTRAINT unique_tenant_subscription UNIQUE (tenant_id)
      );

      INSERT INTO public.plans (name, price_monthly, limits, features, is_default, is_custom)
      VALUES (
          'trial', 0.00,
          '{
            "max_connections": 2,
            "max_records_per_table": 1000,
            "max_tables": 5,
            "max_triggers": 3,
            "max_replication_tables": 2,
            "max_replication_rows": 500,
            "rate_limit_per_min": 10,
            "rate_limit_per_hour": 100,
            "rate_limit_per_day": 1000
          }'::jsonb,
          '{"trial_period_days": 7}'::jsonb,
          true, false
      ) ON CONFLICT (name) DO NOTHING;

      INSERT INTO public.plans (name, price_monthly, limits, features, is_default, is_custom)
      VALUES (
          'selfhost', 0.00,
          '{
            "max_connections": -1,
            "max_records_per_table": -1,
            "max_tables": -1,
            "max_triggers": -1,
            "max_replication_tables": -1,
            "max_replication_rows": -1,
            "rate_limit_per_min": -1,
            "rate_limit_per_hour": -1,
            "rate_limit_per_day": -1
          }'::jsonb,
          '{"trial_period_days": -1}'::jsonb,
          false, false
      ) ON CONFLICT (name) DO NOTHING;
    `);
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      DROP TABLE IF EXISTS public.subscriptions CASCADE;
      DROP TABLE IF EXISTS public.plans CASCADE;
    `);
  }
}
