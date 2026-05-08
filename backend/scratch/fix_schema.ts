import { pool } from '../src/config/database';

async function fixSchema() {
  try {
    await pool.query("ALTER TABLE public.data_sources ADD COLUMN IF NOT EXISTS sync_type VARCHAR(50) DEFAULT 'VIRTUAL';");
    console.log('Schema Fixed: sync_type column added.');
    process.exit(0);
  } catch (err) {
    console.error('Schema Fix Failed:', err);
    process.exit(1);
  }
}

fixSchema();
