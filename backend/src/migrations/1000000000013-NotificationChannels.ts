import { MigrationInterface, QueryRunner } from 'typeorm';

export class NotificationChannels1000000000013 implements MigrationInterface {
  name = 'NotificationChannels1000000000013';

  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS public.notification_channels (
          id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
          tenant_id TEXT NOT NULL REFERENCES public.tenants(id) ON DELETE CASCADE,
          channel_type TEXT NOT NULL,
          name TEXT NOT NULL,
          config JSONB NOT NULL DEFAULT '{}'::jsonb,
          is_default BOOLEAN NOT NULL DEFAULT false,
          status TEXT NOT NULL DEFAULT 'ACTIVE',
          created_at TIMESTAMP DEFAULT NOW(),
          updated_at TIMESTAMP DEFAULT NOW(),
          UNIQUE (tenant_id, channel_type, name)
      );

      ALTER TABLE public.notification_channels ENABLE ROW LEVEL SECURITY;
      DROP POLICY IF EXISTS notification_channels_tenant_policy ON public.notification_channels;
      CREATE POLICY notification_channels_tenant_policy ON public.notification_channels
        USING (
          tenant_id::text = current_setting('app.tenant_id', true)::text
          OR (current_setting('request.jwt.claims', true)::json->>'internal_role' = 'ADMIN')
          OR current_user = 'fabric_admin'
        );

      GRANT SELECT, INSERT, UPDATE, DELETE ON public.notification_channels TO fabric_user;
    `);
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      DROP TABLE IF EXISTS public.notification_channels CASCADE;
    `);
  }
}
