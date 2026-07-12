import { pool } from '../../config/database';

/**
 * GitOpsService — versioned, transactional schema deployment for a tenant,
 * modelling a GitOps-style "apply this migration script and record its
 * outcome" workflow (analogous to the migration runner in
 * (@link "../../config/migrate.ts") but scoped per-tenant and driven from the
 * application layer rather than the startup migration script).
 */
export class GitOpsService {
  /**
   * Apply a DDL migration script to a tenant's schema and record the
   * deployment in `public.schema_migrations`. Scopes `search_path` to the
   * tenant's schema (falling back to `public`) for the duration of the
   * transaction, then runs the script and the audit insert atomically — both
   * succeed or both are rolled back.
   * @param tenantId - Tenant the migration targets (schema `tenant_<tenantId>`).
   * @param sqlScript - The raw DDL script to execute.
   * @param version - Version label recorded alongside the migration outcome.
   * @returns `(version, status: 'DEPLOYED')` on success.
   * @throws Re-throws any error after rolling back the transaction and logging it (no `schema_migrations` row is written on failure).
   */
  static async deploySchema(tenantId: string, sqlScript: string, version: string) {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      
      // 1. Set context for the migration
      await client.query(`SET LOCAL search_path TO tenant_${tenantId}, public`);
      
      // 2. Execute the DDL script
      await client.query(sqlScript);
      
      // 3. Record the deployment in the audit history
      // (Assumes a schema_migrations table exists as per Module 10 LLD)
      await client.query(`
        INSERT INTO public.schema_migrations (version, tenant_id, status)
        VALUES ($1, $2, 'SUCCESS')
      `, [version, tenantId]);

      await client.query('COMMIT');
      return { version, status: 'DEPLOYED' };
    } catch (err: any) {
      await client.query('ROLLBACK');
      console.error(`[GitOps] Deployment failed: ${err.message}`);
      throw err;
    } finally {
      client.release();
    }
  }
}
