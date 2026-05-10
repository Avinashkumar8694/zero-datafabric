import { Pool } from 'pg';
import dotenv from 'dotenv';

dotenv.config();

const pool = new Pool({
  connectionString: String(process.env.DATABASE_URL || 'postgres://fabric_admin:super_secret_password@localhost:5432/datafabric'),
  statement_timeout: 10000, // 10 seconds industrial timeout
});

/**
 * Executes a query within a temporary session context
 * This is critical for Module 3.1 (RLS) and 3.2 (Audit)
 */
async function queryWithContext(sql: string, params: any[], context: { tenantId: string, username: string }) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    
    // 1. Switch to the application role first to ensure settings are correctly scoped
    await client.query(`SET LOCAL ROLE fabric_user`);

    // 2. Inject identity into the Postgres session (Industrial Grade App Context)
    await client.query(`SELECT set_config('app.tenant_id', $1, true)`, [context.tenantId]);
    await client.query(`SELECT set_config('app.user_name', $1, true)`, [context.username]);
    await client.query(`SELECT set_config('app.current_region', $1, true)`, [process.env.DEFAULT_REGION || 'AP']);
    
    // 3. Set Search Path to Tenant Primary + tenant sub-schemas (e.g., tenant_<id>_Global_Supply_Chain)
    const baseSchema = `tenant_${context.tenantId.replace(/[^a-zA-Z0-9_]/g, '')}`;
    const { rows: schemaRows } = await client.query(
      `SELECT schema_name
       FROM information_schema.schemata
       WHERE schema_name = $1 OR schema_name LIKE $2
       ORDER BY (schema_name = $1) DESC, schema_name ASC`,
      [baseSchema, `${baseSchema}_%`]
    );
    const searchPath = schemaRows.length
      ? schemaRows.map(r => `"${r.schema_name}"`).join(', ')
      : `"${baseSchema}"`;
    await client.query(`SET LOCAL search_path TO ${searchPath}, public`);
    
    const result = await client.query(sql, params);
    
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    // Reset role before releasing back to pool
    await client.query('RESET ROLE');
    client.release();
  }
}

pool.on('connect', () => {
  console.log('PostgreSQL Pool Connected');
});

export { pool, queryWithContext };
