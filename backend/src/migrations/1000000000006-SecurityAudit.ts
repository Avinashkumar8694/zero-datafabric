import { MigrationInterface, QueryRunner } from 'typeorm';

export class SecurityAudit1000000000006 implements MigrationInterface {
  name = 'SecurityAudit1000000000006';

  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE SCHEMA IF NOT EXISTS fabric_admin;

      CREATE TABLE IF NOT EXISTS fabric_admin.audit_logs (
          id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
          tenant_id TEXT,
          user_name TEXT,
          action TEXT NOT NULL,
          table_name TEXT NOT NULL,
          row_id TEXT,
          old_data JSONB,
          new_data JSONB,
          changed_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );

      CREATE OR REPLACE FUNCTION fabric_admin.audit_trigger_func()
      RETURNS TRIGGER AS $$
      DECLARE
          v_tenant_id TEXT := 'SYSTEM';
          v_user_name TEXT := 'SYSTEM';
      BEGIN
          v_tenant_id := current_setting('app.tenant_id', true);
          v_user_name := current_setting('app.user_name', true);
          IF v_tenant_id IS NULL OR v_tenant_id = '' THEN v_tenant_id := 'SYSTEM'; END IF;
          IF v_user_name IS NULL OR v_user_name = '' THEN v_user_name := 'SYSTEM'; END IF;
          IF (TG_OP = 'DELETE') THEN
              INSERT INTO fabric_admin.audit_logs (tenant_id, user_name, action, table_name, row_id, old_data)
              VALUES (v_tenant_id, v_user_name, 'DELETE', TG_TABLE_NAME, OLD.id::text, to_jsonb(OLD));
              RETURN OLD;
          ELSIF (TG_OP = 'UPDATE') THEN
              INSERT INTO fabric_admin.audit_logs (tenant_id, user_name, action, table_name, row_id, old_data, new_data)
              VALUES (v_tenant_id, v_user_name, 'UPDATE', TG_TABLE_NAME, NEW.id::text, to_jsonb(OLD), to_jsonb(NEW));
              RETURN NEW;
          ELSIF (TG_OP = 'INSERT') THEN
              INSERT INTO fabric_admin.audit_logs (tenant_id, user_name, action, table_name, row_id, new_data)
              VALUES (v_tenant_id, v_user_name, 'INSERT', TG_TABLE_NAME, NEW.id::text, to_jsonb(NEW));
              RETURN NEW;
          END IF;
          RETURN NULL;
      END;
      $$ LANGUAGE plpgsql SECURITY DEFINER;

      DROP TRIGGER IF EXISTS audit_tenants_trigger ON public.tenants;
      CREATE TRIGGER audit_tenants_trigger AFTER INSERT OR UPDATE OR DELETE ON public.tenants FOR EACH ROW EXECUTE FUNCTION fabric_admin.audit_trigger_func();

      DROP TRIGGER IF EXISTS audit_data_sources_trigger ON public.data_sources;
      CREATE TRIGGER audit_data_sources_trigger AFTER INSERT OR UPDATE OR DELETE ON public.data_sources FOR EACH ROW EXECUTE FUNCTION fabric_admin.audit_trigger_func();

      ALTER TABLE fabric_admin.audit_logs ENABLE ROW LEVEL SECURITY;
      DROP POLICY IF EXISTS audit_isolation_policy ON fabric_admin.audit_logs;
      CREATE POLICY audit_isolation_policy ON fabric_admin.audit_logs
          USING (
              tenant_id::text = current_setting('app.tenant_id', true)::text
              OR tenant_id::text = current_setting('request.jwt.claims', true)::json->>'tenant_id'
              OR current_user = 'fabric_admin'
          );
      GRANT SELECT ON fabric_admin.audit_logs TO fabric_user;

      CREATE OR REPLACE VIEW public.audit_logs AS SELECT * FROM fabric_admin.audit_logs;
      GRANT SELECT ON public.audit_logs TO fabric_user;
    `);
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      DROP VIEW IF EXISTS public.audit_logs;
      DROP TABLE IF EXISTS fabric_admin.audit_logs CASCADE;
      DROP FUNCTION IF EXISTS fabric_admin.audit_trigger_func();
    `);
  }
}
