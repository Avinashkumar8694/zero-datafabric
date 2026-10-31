import { Pool } from 'pg';
import dotenv from 'dotenv';
import { requestPolicy } from '../modules/tenancy/request-context';
import { escapeLike, belongsToTenant } from '../utils/identifiers';

/**
 * Primary Postgres connection pool + the session-context query helper that
 * underlies the fabric's tenant isolation and auditing.
 *
 * `queryWithContext` is the main entry point used throughout the codebase for
 * any query that must be scoped to a tenant: it switches to the low-privilege
 * `fabric_user` role, injects `app.tenant_id`/`app.user_name`/`app.current_region`
 * session GUCs (read by RLS policies and audit triggers, and by
 * (@link SecurityService)'s `current_setting('request.jwt.claims', ...)`-style
 * policies), and sets `search_path` to the tenant's schema(s) — all inside one
 * transaction so the context and the query are atomic.
 */

dotenv.config();

// Build the connection string from individual DB_* vars if DATABASE_URL is not set.
// This ensures the replication-engine (which imports this module) works in Docker
// even when DATABASE_URL is not explicitly defined in the environment file.
const buildConnectionString = () => {
  const host = process.env.DB_HOST || 'localhost';
  const port = process.env.DB_PORT || '5432';
  const user = process.env.DB_USERNAME || 'fabric_admin';
  const pass = process.env.DB_PASSWORD || 'super_secret_password';
  const db   = process.env.DB_DATABASE || process.env.DB_NAME || 'datafabric';
  return `postgres://${encodeURIComponent(user)}:${encodeURIComponent(pass)}@${host}:${port}/${db}`;
};

const connectionString = process.env.DATABASE_URL || buildConnectionString();

const pool = new Pool({
  connectionString,
  max: Number(process.env.DB_POOL_MAX || 50),
  min: Number(process.env.DB_POOL_MIN || 5),
  idleTimeoutMillis: Number(process.env.DB_POOL_IDLE_TIMEOUT || 30000),
  connectionTimeoutMillis: Number(process.env.DB_POOL_CONNECT_TIMEOUT || 10000),
  statement_timeout: 10000, // 10 seconds industrial timeout
});

/**
 * Builds the `search_path` value for a tenant: its primary schema `tenant_<id>` first, then its logical sub-schemas
 * `tenant_<id>_<logical>`, then `public`. Matching is exact: LIKE wildcards in the tenant id are escaped and every
 * candidate is re-checked with `belongsToTenant`, so `t_ac` never picks up `tenant_t_ac_foo` of tenant `t_ac_foo`
 * (creation additionally enforces the no-prefix-overlap rule on tenant ids).
 */
async function tenantSearchPath(client: { query: (t: string, v?: any[]) => Promise<{ rows: any[] }> }, tenantId: string): Promise<string> {
  const cleanTenant = String(tenantId).replace(/[^a-zA-Z0-9_]/g, '');
  const baseSchema = `tenant_${cleanTenant}`;
  const { rows } = await client.query(
    `SELECT schema_name
     FROM information_schema.schemata
     WHERE schema_name = $1 OR schema_name LIKE $2 ESCAPE '\\'
     ORDER BY (schema_name = $1) DESC, schema_name ASC`,
    [baseSchema, `${escapeLike(baseSchema + '_')}%`]
  );
  const names: string[] = rows.map((r: any) => String(r.schema_name)).filter((n: string) => belongsToTenant(n, cleanTenant));
  const quoted = (names.length ? names : [baseSchema]).map((n) => `"${n.replace(/"/g, '""')}"`);
  return `${quoted.join(', ')}, public`;
}

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
 * @param context - `(tenantId, username)` — identity to inject into the session.
 * @returns The `pg` query result for `sql`.
 * @throws Re-throws any error from setting context or running `sql`, after rolling back the transaction.
 */
async function queryWithContext(sql: string, params: any[], context: { tenantId: string, username: string, role?: string }) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    
    // 1. Switch to the application role first to ensure settings are correctly scoped
    await client.query(`SET LOCAL ROLE fabric_user`);
    const policyTimeout = requestPolicy.getStore()?.timeoutMs;
    if (policyTimeout && Number.isInteger(policyTimeout)) await client.query(`SET LOCAL statement_timeout = ${policyTimeout}`);

    // 2. Inject identity into the Postgres session (Industrial Grade App Context)
    await client.query(`SELECT set_config('app.tenant_id', $1, true)`, [context.tenantId]);
    await client.query(`SELECT set_config('app.user_name', $1, true)`, [context.username]);
    await client.query(`SELECT set_config('app.current_region', $1, true)`, [process.env.DEFAULT_REGION || 'AP']);
    
    // 2.5 Inject request.jwt.claims to satisfy RLS policies checking role/internal_role GUC
    const claims = {
      tenant_id: context.tenantId,
      username: context.username,
      internal_role: context.role || 'USER'
    };
    await client.query(`SELECT set_config('request.jwt.claims', $1, true)`, [JSON.stringify(claims)]);
    
    // 3. Set Search Path to Tenant Primary + tenant sub-schemas (e.g., tenant_<id>_Global_Supply_Chain)
    await client.query(`SET LOCAL search_path TO ${await tenantSearchPath(client, context.tenantId)}`);
    
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

export { pool, queryWithContext, tenantSearchPath };
