import { MigrationInterface, QueryRunner } from 'typeorm';

export class CatalogResourceDefinitions1000000000010 implements MigrationInterface {
  name = 'CatalogResourceDefinitions1000000000010';

  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE public.catalog_tables ADD COLUMN IF NOT EXISTS resource_type VARCHAR(64) DEFAULT 'TABLE';
      ALTER TABLE public.catalog_tables ADD COLUMN IF NOT EXISTS definition_sql TEXT;
      ALTER TABLE public.catalog_tables ADD COLUMN IF NOT EXISTS definition_ast JSONB;
    `);
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE public.catalog_tables DROP COLUMN IF EXISTS definition_ast;
      ALTER TABLE public.catalog_tables DROP COLUMN IF EXISTS definition_sql;
      ALTER TABLE public.catalog_tables DROP COLUMN IF EXISTS resource_type;
    `);
  }
}
