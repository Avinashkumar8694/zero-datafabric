import { MigrationInterface, QueryRunner } from 'typeorm';
import fs from 'fs';
import path from 'path';

/** Same DDL as db/init/17-worker-nodes-and-api-tokens.sql (single source of truth: the .sql file). */
export class WorkerNodesAndApiTokens1000000000017 implements MigrationInterface {
  name = 'WorkerNodesAndApiTokens1000000000017';

  async up(queryRunner: QueryRunner): Promise<void> {
    const file = path.join(__dirname, '../../../db/init/17-worker-nodes-and-api-tokens.sql');
    await queryRunner.query(fs.readFileSync(file, 'utf8'));
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      DROP TABLE IF EXISTS public.api_tokens;
      DROP TABLE IF EXISTS public.fabric_worker_events;
      DROP TABLE IF EXISTS public.fabric_worker_nodes;
    `);
  }
}
