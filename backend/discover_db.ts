import { pool } from './src/config/database';

async function discover() {
  console.log('--- GLOBAL RELATION DISCOVERY ---');
  try {
    const { rows: schemas } = await pool.query("SELECT schema_name FROM information_schema.schemata");
    console.log('SCHEMAS:', schemas.map(s => s.schema_name));

    const { rows: tables } = await pool.query("SELECT table_schema, table_name FROM information_schema.tables WHERE table_schema NOT IN ('pg_catalog', 'information_schema')");
    console.log('TABLES:', tables);

    process.exit(0);
  } catch (err) {
    console.error(err);
    process.exit(1);
  }
}

discover();
