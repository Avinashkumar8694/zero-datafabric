import { Pool } from 'pg';

const pool = new Pool({
  connectionString: String(process.env.DATABASE_URL || 'postgres://fabric_admin:super_secret_password@localhost:5432/datafabric')
});

export { pool };
