import { MigrationInterface, QueryRunner } from 'typeorm';

export class CatalogHardening1000000000008 implements MigrationInterface {
  name = 'CatalogHardening1000000000008';

  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE fabric_catalog.relationships ADD COLUMN IF NOT EXISTS tenant_id TEXT;
      ALTER TABLE fabric_catalog.relationships ADD COLUMN IF NOT EXISTS name TEXT;
      ALTER TABLE fabric_catalog.relationships ADD COLUMN IF NOT EXISTS source_schema TEXT;
      ALTER TABLE fabric_catalog.relationships ADD COLUMN IF NOT EXISTS target_schema TEXT;

      ALTER TABLE fabric_catalog.relationships DROP CONSTRAINT IF EXISTS relationships_schema_name_source_table_source_column_target_key;
      ALTER TABLE fabric_catalog.relationships DROP CONSTRAINT IF EXISTS relationships_tenant_id_source_table_source_column_target_key;
      ALTER TABLE fabric_catalog.relationships DROP CONSTRAINT IF EXISTS relationships_full_identity_key;
      ALTER TABLE fabric_catalog.relationships ADD CONSTRAINT relationships_full_identity_key
      UNIQUE (tenant_id, source_schema, source_table, source_column, target_schema, target_table, target_column);

      ALTER TABLE fabric_catalog.metadata ADD COLUMN IF NOT EXISTS row_count BIGINT DEFAULT 0;
      ALTER TABLE fabric_catalog.metadata ADD COLUMN IF NOT EXISTS last_crawled_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP;

      DROP VIEW IF EXISTS public.metadata_catalog;
      CREATE OR REPLACE VIEW public.metadata_catalog WITH (security_invoker = true) AS SELECT * FROM fabric_catalog.metadata;
      GRANT SELECT ON public.metadata_catalog TO public;
    `);
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE fabric_catalog.relationships DROP CONSTRAINT IF EXISTS relationships_full_identity_key;
      ALTER TABLE fabric_catalog.relationships DROP COLUMN IF EXISTS target_schema;
      ALTER TABLE fabric_catalog.relationships DROP COLUMN IF EXISTS source_schema;
      ALTER TABLE fabric_catalog.relationships DROP COLUMN IF EXISTS name;
      ALTER TABLE fabric_catalog.relationships DROP COLUMN IF EXISTS tenant_id;
      ALTER TABLE fabric_catalog.metadata DROP COLUMN IF EXISTS last_crawled_at;
      ALTER TABLE fabric_catalog.metadata DROP COLUMN IF EXISTS row_count;
    `);
  }
}
