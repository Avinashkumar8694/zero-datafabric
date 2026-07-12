import { pool } from '../../config/database';

/**
 * SyncService — data-source synchronization strategy dispatcher.
 *
 * Two strategies are supported for bringing a remote source's data into the
 * fabric: {@link SyncType.VIRTUAL} (zero-copy, delegated to the FDW-based
 * virtualization already handled by IntegrationService) and
 * {@link SyncType.CDC} (physical replication, where rows are captured into a
 * local "shadow" table for durable, tenant-local storage).
 */

/** Synchronization strategy for a registered data source. */
export enum SyncType {
  /** Zero-copy access via a Foreign Data Wrapper — no local data movement. */
  VIRTUAL = 'VIRTUAL',
  /** Physical replication/triggers — rows are captured into a local shadow table. */
  CDC = 'CDC'
}

export class SyncService {
  /**
   * Orchestrate the synchronization strategy for a data source: VIRTUAL is a
   * no-op here (zero-copy FDW access is already wired up by
   * IntegrationService); CDC provisions the local physical shadow table via
   * {@link SyncService.setupPhysicalSync}.
   * @param tenantId - Owning tenant.
   * @param sourceName - Name of the data source being synced.
   * @param type - The sync strategy to apply.
   * @param config - Source-specific configuration (used by CDC to size/shape the shadow table).
   * @returns Resolves once the requested strategy has been initialized.
   */
  static async initializeSync(tenantId: string, sourceName: string, type: SyncType, config: any) {
    if (type === SyncType.VIRTUAL) {
      console.log(`[Sync] Initializing Virtualization (Zero-ETL) for ${sourceName}`);
      // Already implemented in IntegrationService
    } else {
      console.log(`[Sync] Initializing Physical CDC Sync for ${sourceName}`);
      await this.setupPhysicalSync(tenantId, sourceName, config);
    }
  }

  /**
   * Create the tenant's local shadow table for CDC-based physical sync, if it
   * does not already exist. Runs inside a transaction. This creates only the
   * storage target — actual CDC ingestion (e.g. a Debezium connector or a
   * trigger-based listener simulating Kafka CDC events) is not implemented
   * here.
   * @param tenantId - Owning tenant (schema is `tenant_<tenantId>`).
   * @param sourceName - Name of the data source (used to derive the shadow table name `sync_<sourceName>_data`).
   * @param config - Reserved for future connector-specific configuration (currently unused).
   * @returns Resolves once the shadow table is created and the transaction committed.
   * @throws Re-throws any error after rolling back the transaction.
   */
  private static async setupPhysicalSync(tenantId: string, sourceName: string, config: any) {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      
      // 1. Create a local shadow table for the physical sync
      const schemaName = `tenant_${tenantId}`;
      const tableName = `sync_${sourceName}_data`;
      
      await client.query(`
        CREATE TABLE IF NOT EXISTS "${schemaName}"."${tableName}" (
          id SERIAL PRIMARY KEY,
          payload JSONB,
          source_lsn TEXT,
          synced_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        )
      `);

      // 2. In a real scenario, we would register the Debezium connector here
      // For this implementation, we will use a Trigger-based mock listener 
      // that simulates the arrival of Kafka CDC events.
      
      console.log(`[Sync] Physical table ${schemaName}.${tableName} created.`);
      
      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  }
}
