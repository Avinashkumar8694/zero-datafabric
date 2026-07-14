import { Pool } from 'pg';

// Build DATABASE_URL from individual DB_* vars if not explicitly set.
// All DB details come from environment — the database can be hosted anywhere.
const buildConnectionString = () => {
  const host = process.env.DB_HOST || 'localhost';
  const port = process.env.DB_PORT || '5432';
  const user = process.env.DB_USERNAME || 'fabric_admin';
  const pass = process.env.DB_PASSWORD || '';
  const db   = process.env.DB_DATABASE || process.env.DB_NAME || 'datafabric';
  return `postgres://${encodeURIComponent(user)}:${encodeURIComponent(pass)}@${host}:${port}/${db}`;
};

const pool = new Pool({
  connectionString: process.env.DATABASE_URL || buildConnectionString(),
  statement_timeout: 10000,
});

export { pool };
