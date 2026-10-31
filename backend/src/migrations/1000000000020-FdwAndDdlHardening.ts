import { MigrationInterface, QueryRunner } from 'typeorm';
import fs from 'fs';
import path from 'path';

/**
 * Same DDL as db/init/20-fdw-and-ddl-hardening.sql (single source of truth: the .sql file): collision-free FDW server
 * names with an ownership registry, allow-list based IMPORT FOREIGN SCHEMA, validated inputs. Idempotent.
 */
export class FdwAndDdlHardening1000000000020 implements MigrationInterface {
  name = 'FdwAndDdlHardening1000000000020';

  async up(queryRunner: QueryRunner): Promise<void> {
    const file = path.join(__dirname, '../../../db/init/20-fdw-and-ddl-hardening.sql');
    await queryRunner.query(fs.readFileSync(file, 'utf8'));
  }

  async down(): Promise<void> {
    // Intentionally a no-op: the previous functions were unsafe (name collisions, blacklist import) and servers created
    // under the new scheme must stay addressable. The registry table is kept so ownership information is never lost.
  }
}
