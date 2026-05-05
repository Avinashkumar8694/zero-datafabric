import { pool } from '../../config/database';

export class GitOpsService {
  /**
   * Industrial Grade Schema Deployment
   * Executes transactional DDL and records the migration status
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
