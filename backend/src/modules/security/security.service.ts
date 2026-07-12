import { pool } from '../../config/database';

/**
 * SecurityService — native Postgres row-level-security (RLS) and PII helpers.
 *
 * Unlike {@link PolicyService} (which compensates for engines that have no
 * native RLS by injecting predicates and masking result rows), this service
 * drives Postgres's own `ROW LEVEL SECURITY` feature directly: it issues
 * `ALTER TABLE ... ENABLE ROW LEVEL SECURITY` and `CREATE POLICY` DDL so the
 * database itself enforces tenant isolation for every statement PostgREST (or
 * any other client) runs as `fabric_user`, based on the JWT claims the
 * orchestrator injects into `request.jwt.claims` / session GUCs.
 *
 * Also exposes a thin wrapper around `pgcrypto` for at-rest field encryption.
 */
export class SecurityService {
  /**
   * Enable row-level security on a single table and install an advanced
   * tenant-isolation policy that reads the tenant id straight out of the JWT
   * claims PostgREST forwards as `request.jwt.claims`. Applies to `fabric_user`
   * for all commands (`FOR ALL`), so every SELECT/INSERT/UPDATE/DELETE is
   * constrained by `tenant_id = claim.tenant_id` on both read (`USING`) and
   * write (`WITH CHECK`).
   * @param tableName - Fully-qualified table name (e.g. `"schema"."table"`) to enable RLS on.
   * @returns `{ status: 'RLS_APPLIED', table }` once the policy is created.
   * @throws Re-throws any DDL error after logging it (e.g. missing `tenant_id` column).
   */
  static async applyAdvancedRLS(tableName: string) {
    const client = await pool.connect();
    try {
      await client.query(`ALTER TABLE ${tableName} ENABLE ROW LEVEL SECURITY`);

      // Dynamic policy that reads from the JWT claims injected by PostgREST/Orchestrator
      const policySql = `
        CREATE POLICY advanced_tenant_isolation ON ${tableName}
        FOR ALL
        TO fabric_user
        USING (
          tenant_id = current_setting('request.jwt.claims', true)::json->>'tenant_id'
        )
        WITH CHECK (
          tenant_id = current_setting('request.jwt.claims', true)::json->>'tenant_id'
        );
      `;

      await client.query(policySql);
      return { status: 'RLS_APPLIED', table: tableName };
    } catch (err: any) {
      console.error(`[Security] RLS failed: ${err.message}`);
      throw err;
    } finally {
      client.release();
    }
  }

  /**
   * Enable row-level security and a simple `tenant_id = $1` isolation policy
   * on every table in a schema — used when virtualizing an entire tenant
   * schema at once rather than table-by-table. Idempotent: drops any existing
   * `tenant_isolation_policy` on a table before recreating it.
   * @param schemaName - The Postgres schema whose tables should get RLS.
   * @param tenantId - The tenant id the isolation policy binds to (`tenant_id = tenantId`).
   * @returns `{ status: 'RLS_SCHEMA_APPLIED', schema, tableCount }` — the number of tables processed.
   */
  static async applyRLSToSchema(schemaName: string, tenantId: string) {
    const client = await pool.connect();
    try {
      // 1. Get all tables in the schema
      const { rows: tables } = await client.query(
        "SELECT table_name FROM information_schema.tables WHERE table_schema = $1",
        [schemaName]
      );

      for (const table of tables) {
        const tableName = `"${schemaName}"."${table.table_name}"`;
        await client.query(`ALTER TABLE ${tableName} ENABLE ROW LEVEL SECURITY`);

        // Drop existing to avoid conflicts
        await client.query(`DROP POLICY IF EXISTS tenant_isolation_policy ON ${tableName}`);

        await client.query(`
          CREATE POLICY tenant_isolation_policy ON ${tableName}
          FOR ALL
          TO fabric_user
          USING (tenant_id = $1)
          WITH CHECK (tenant_id = $1)
        `, [tenantId]);
      }

      return { status: 'RLS_SCHEMA_APPLIED', schema: schemaName, tableCount: tables.length };
    } finally {
      client.release();
    }
  }

  /**
   * Encrypt a sensitive value at rest using Postgres's `pgcrypto` symmetric
   * encryption (`pgp_sym_encrypt`) — pushes the crypto work to the database so
   * the plaintext key/value never need a separate crypto library in Node.
   * @param value - The plaintext value to encrypt.
   * @param key - The symmetric passphrase used to encrypt (and later decrypt) the value.
   * @returns The PGP-encrypted ciphertext (bytea) as returned by `pgp_sym_encrypt`.
   */
  static async encryptField(value: string, key: string) {
    const { rows } = await pool.query(
      "SELECT pgp_sym_encrypt($1, $2) as encrypted",
      [value, key]
    );
    return rows[0].encrypted;
  }
}
