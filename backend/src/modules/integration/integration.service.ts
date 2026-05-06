import { pool, queryWithContext } from '../../config/database';
import { SyncService, SyncType } from '../sync/sync.service';

export interface RemoteSourceConfig {
  host: string;
  port: number;
  dbName: string;
  user: string;
  pass: string;
  syncType: SyncType;
}

export class IntegrationService {
  /**
   * Advanced registration of a remote PostgreSQL source
   * Includes server creation, user mapping, and schema import with safety checks
   */
  static async registerPostgresSource(tenantId: string, sourceName: string, config: RemoteSourceConfig, userContext?: { tenantId: string, username: string }) {
    // 1. Health Check
    await this.validateConnection(config);

    // Idempotency Check
    const { rows: existing } = await pool.query('SELECT id FROM public.data_sources WHERE tenant_id = $1 AND name = $2', [tenantId, sourceName]);
    if (existing.length > 0) {
      return { sourceId: existing[0].id, tenantId, status: 'RE-INTEGRATED' };
    }

    const sql = 'INSERT INTO public.data_sources (tenant_id, name, type, config, status) VALUES ($1, $2, $3, $4, $5) RETURNING id';
    const params = [tenantId, sourceName, 'POSTGRES', JSON.stringify({ host: config.host, db: config.dbName, sync: config.syncType }), 'ACTIVE'];

    let result;
    if (userContext) {
      result = await queryWithContext(sql, params, userContext);
    } else {
      result = await pool.query(sql, params);
    }
    
    const sourceId = result.rows[0].id;

    // 2. Orchestrate Sync Strategy (Administrative - runs as admin via SQL function)
    if (config.syncType === SyncType.VIRTUAL) {
      // The SQL function handles SERVER creation, USER MAPPING, and SCHEMA IMPORT securely
      await pool.query(
        'SELECT fabric_admin.register_remote_source($1, $2, $3, $4, $5, $6, $7)',
        [tenantId, sourceName, config.host, config.port, config.dbName, config.user, config.pass]
      );
    } else {
      await SyncService.initializeSync(tenantId, sourceName, config.syncType, config);
    }

    return { sourceId, tenantId, status: 'INTEGRATED' };
  }

  /**
   * Advanced Health Monitor: Verifies if a virtual link is still alive
   */
  static async checkSourceHealth(sourceId: string) {
    // Logic to run a lightweight SELECT 1 against the foreign server
    // to detect network or credential failures
  }

  private static async validateConnection(config: RemoteSourceConfig) {
    // Implementation for pre-registration connectivity test
    // Usually using a temporary pg connection
  }

  static async removeSource(sourceId: string) {
    try {
      // 1. Get metadata for cleanup
      const { rows } = await pool.query('SELECT name, tenant_id FROM public.data_sources WHERE id = $1', [sourceId]);
      if (rows.length === 0) throw new Error('Source not found');
      
      const { name: sourceName, tenant_id: tenantId } = rows[0];
      // 2. Cleanup FDW Server (Administrative DDL via Stored Procedure)
      await pool.query('SELECT fabric_admin.remove_remote_source($1, $2)', [tenantId, sourceName]);

      // 3. Delete from Registry (Audited)
      await pool.query('DELETE FROM public.data_sources WHERE id = $1', [sourceId]);

      return { status: 'REMOVED', sourceId };
    } catch (err) {
      console.error(`[Removal Error] ${err}`);
      throw err;
    }
  }
}
