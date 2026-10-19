import { MigrationInterface, QueryRunner } from 'typeorm';

export class OrchestrationBase1000000000009 implements MigrationInterface {
  name = 'OrchestrationBase1000000000009';

  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE SCHEMA IF NOT EXISTS fabric_system;

      CREATE TABLE IF NOT EXISTS fabric_system.metadata_history (
          id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
          tenant_id TEXT NOT NULL,
          version_tag TEXT NOT NULL,
          ast_content JSONB NOT NULL,
          applied_at TIMESTAMP DEFAULT NOW(),
          summary JSONB
      );

      CREATE TABLE IF NOT EXISTS fabric_system.downstream_registry (
          tenant_id TEXT NOT NULL,
          target_type TEXT NOT NULL,
          config JSONB,
          status TEXT DEFAULT 'INACTIVE',
          updated_at TIMESTAMP DEFAULT NOW(),
          PRIMARY KEY (tenant_id, target_type)
      );

      CREATE OR REPLACE FUNCTION current_user_id() RETURNS UUID AS $$
      BEGIN
          RETURN COALESCE(
              NULLIF(current_setting('app.user_id', true), '')::UUID,
              '00000000-0000-0000-0000-000000000000'::UUID
          );
      END;
      $$ LANGUAGE plpgsql STABLE;

      GRANT ALL ON SCHEMA fabric_system TO fabric_user;
      GRANT ALL ON ALL TABLES IN SCHEMA fabric_system TO fabric_user;
    `);
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      DROP FUNCTION IF EXISTS current_user_id();
      DROP TABLE IF EXISTS fabric_system.downstream_registry CASCADE;
      DROP TABLE IF EXISTS fabric_system.metadata_history CASCADE;
      DROP SCHEMA IF EXISTS fabric_system CASCADE;
    `);
  }
}
