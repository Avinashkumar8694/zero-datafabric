import 'reflect-metadata';
import { DataSource } from 'typeorm';
import * as dotenv from 'dotenv';
import * as path from 'path';

dotenv.config({ path: path.resolve(__dirname, '../../.env') });

/**
 * TypeORM DataSource — single source of truth for DB connection config
 * and migration tracking.
 *
 * The `fabric_migrations` table is created automatically by TypeORM in the
 * default `public` schema and records every migration that has been applied.
 * Running `migration:run` is fully idempotent — already-applied migrations
 * are skipped; only new ones run.
 *
 * Usage:
 *   npm run migration:run     — apply all pending migrations (safe to re-run)
 *   npm run migration:revert  — roll back the last applied migration
 *   npm run migration:status  — list which migrations have / haven't run
 *   npm run migration:create  — scaffold a new migration file
 */
export const AppDataSource = new DataSource({
  type: 'postgres',
  url: process.env.DATABASE_URL || 'postgresql://fabric_admin:fabric_password@localhost:5434/datafabric',

  // Migration files — loaded by ts-node at runtime (no build step needed in dev)
  migrations: [path.join(__dirname, '../migrations/*.ts')],

  // TypeORM stores its own migration history here — separate from app tables
  migrationsTableName: 'fabric_migrations',

  // Run each migration in its own transaction (rollback on failure)
  migrationsTransactionMode: 'each',

  // No entities needed — we use raw SQL migrations only
  entities: [],

  logging: ['migration'],
});
