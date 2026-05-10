import { Pool } from 'pg';
import dotenv from 'dotenv';

dotenv.config();

const pool = new Pool({
  connectionString: String(process.env.DATABASE_URL || 'postgresql://fabric_admin:fabric_password@localhost:5434/datafabric')
});

export { pool };
