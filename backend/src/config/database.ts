import { Pool } from 'pg';
import dotenv from 'dotenv';

dotenv.config();

export const pool = new Pool({
  connectionString: process.env.DATABASE_URL || 'postgres://fabric_admin:super_secret_password@localhost:5432/datafabric',
});

pool.on('connect', () => {
  console.log('PostgreSQL Pool Connected');
});
