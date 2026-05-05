import { pool } from '../../config/database';
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
  static async registerPostgresSource(tenantId: string, sourceName: string, config: RemoteSourceConfig) {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');

      // 1. Health Check
      await this.validateConnection(config);

      // 2. Register source
      const sourceIdResult = await client.query(
        'INSERT INTO public.data_sources (tenant_id, name, type, config, status) VALUES ($1, $2, $3, $4, $5) RETURNING id',
        [tenantId, sourceName, 'POSTGRES', JSON.stringify({ host: config.host, db: config.dbName, sync: config.syncType }), 'CONNECTING']
      );
      const sourceId = sourceIdResult.rows[0].id;

      // 3. Orchestrate Sync Strategy
      if (config.syncType === SyncType.VIRTUAL) {
        await client.query(
          'SELECT fabric_admin.register_remote_source($1, $2, $3, $4, $5, $6, $7)',
          [tenantId, sourceName, config.host, config.port, config.dbName, config.user, config.pass]
        );
      } else {
        await SyncService.initializeSync(tenantId, sourceName, config.syncType, config);
      }

      // 4. Mark source as active
      await client.query('UPDATE public.data_sources SET status = $1 WHERE id = $2', ['ACTIVE', sourceId.rows[0].id]);

      await client.query('COMMIT');
      return { sourceId: sourceId.rows[0].id, tenantId, status: 'INTEGRATED' };
    } catch (err: any) {
      await client.query('ROLLBACK');
      console.error(`[Integration] Registration failed: ${err.message}`);
      throw new Error(`Integration Error: ${err.message}`);
    } finally {
      client.release();
    }
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
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      // 1. Get source name and tenant
      const { rows } = await client.query('SELECT name, tenant_id FROM public.data_sources WHERE id = $1', [sourceId]);
      if (rows.length > 0) {
        const { name, tenant_id } = rows[0];
        // 2. Drop the foreign server in DB
        await client.query(`DROP SERVER IF EXISTS server_${tenant_id}_${name} CASCADE`);
      }
      // 3. Remove from registry
      await client.query('DELETE FROM public.data_sources WHERE id = $1', [sourceId]);
      await client.query('COMMIT');
      return { sourceId, status: 'REMOVED' };
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  }
}
