import { Pool } from 'pg';

// Build DATABASE_URL from individual DB_* vars if not explicitly set.
// This allows the trigger-engine to work as a fully isolated microservice
// with only DB_HOST / DB_PORT / DB_USERNAME / DB_PASSWORD / DB_NAME injected.
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
