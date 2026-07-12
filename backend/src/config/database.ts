import { Pool } from 'pg';
import dotenv from 'dotenv';

/**
 * Primary Postgres connection pool + the session-context query helper that
 * underlies the fabric's tenant isolation and auditing.
 *
 * `queryWithContext` is the main entry point used throughout the codebase for
 * any query that must be scoped to a tenant: it switches to the low-privilege
 * `fabric_user` role, injects `app.tenant_id`/`app.user_name`/`app.current_region`
 * session GUCs (read by RLS policies and audit triggers, and by
 * {@link SecurityService}'s `current_setting('request.jwt.claims', ...)`-style
 * policies), and sets `search_path` to the tenant's schema(s) — all inside one
 * transaction so the context and the query are atomic.
 */

dotenv.config();

const pool = new Pool({
  connectionString: String(process.env.DATABASE_URL || 'postgres://fabric_admin:super_secret_password@localhost:5432/datafabric'),
  statement_timeout: 10000, // 10 seconds industrial timeout
});

/**
 * Execute a single SQL statement inside a transaction that has been scoped to
 * a tenant's session context: switches to `fabric_user`, sets the
 * `app.tenant_id` / `app.user_name` / `app.current_region` session GUCs (used
 * by RLS policies and audit triggers), and sets `search_path` to the tenant's
 * primary schema plus any of its sub-schemas (e.g. `tenant_<id>_<logical>`).
 * Commits on success, rolls back and rethrows on error, and always resets the
 * role and releases the client back to the pool.
 * @param sql - The SQL statement to execute.
 * @param params - Positional parameters for the statement.
 * @param context - `{ tenantId, username }` — identity to inject into the session.
 * @returns The `pg` query result for `sql`.
 * @throws Re-throws any error from setting context or running `sql`, after rolling back the transaction.
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
