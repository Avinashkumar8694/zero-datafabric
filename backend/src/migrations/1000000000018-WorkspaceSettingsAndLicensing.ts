import { MigrationInterface, QueryRunner } from 'typeorm';
import fs from 'fs';
import path from 'path';

/** Same DDL as db/init/18-workspace-settings-and-licensing.sql (single source of truth: the .sql file). */
export class WorkspaceSettingsAndLicensing1000000000018 implements MigrationInterface {
  name = 'WorkspaceSettingsAndLicensing1000000000018';

  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(fs.readFileSync(path.join(__dirname, '../../../db/init/18-workspace-settings-and-licensing.sql'), 'utf8'));
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      DROP TABLE IF EXISTS public.system_events;
      DROP TABLE IF EXISTS public.plan_requests;
      ALTER TABLE public.tenants DROP COLUMN IF EXISTS settings, DROP COLUMN IF EXISTS plan_name, DROP COLUMN IF EXISTS plan_started_at,
        DROP COLUMN IF EXISTS plan_expires_at, DROP COLUMN IF EXISTS plan_overrides, DROP COLUMN IF EXISTS trial_used_at;
    `);
  }
}
