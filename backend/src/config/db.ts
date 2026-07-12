import { Pool } from 'pg';
import dotenv from 'dotenv';

/**
 * Secondary/standalone Postgres connection pool. Separate from
 * {@link "./database.ts"}'s pool (which carries session-context/RLS
 * helpers) — this one exposes a bare `pg.Pool` for callers that just need a
 * raw connection without tenant-context plumbing. Any error on an idle
 * client is treated as fatal and crashes the process, since a poisoned pool
 * connection is unsafe to keep serving from.
 */

dotenv.config();

const pool = new Pool({
  connectionString: String(process.env.DATABASE_URL || 'postgresql://postgres@localhost:5432/postgres')
});

pool.on('error', (err) => {
  console.error('Unexpected error on idle client', err);
  process.exit(-1);
});

export default pool;
