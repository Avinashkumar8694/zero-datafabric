import { MigrationInterface, QueryRunner } from 'typeorm';
import fs from 'fs';
import path from 'path';

/** Same DDL as db/init/19-security-hardening.sql (single source of truth: the .sql file; idempotent). */
export class SecurityHardening1000000000019 implements MigrationInterface {
  name = 'SecurityHardening1000000000019';

  async up(queryRunner: QueryRunner): Promise<void> {
    const file = path.join(__dirname, '../../../db/init/19-security-hardening.sql');
    await queryRunner.query(fs.readFileSync(file, 'utf8'));
  }

  /** Re-opening privileges would re-introduce the isolation holes, so there is deliberately nothing to revert. */
  async down(): Promise<void> {
    /* no-op */
  }
}
