import { pool } from '../../config/database';
import { ConnectorFactory } from '../metadata/connectors/factory';

/**
 * SyncService (integration module) — physical ("SYNC"/CDC-style) data
 * ingestion: crawls every schema/table a connector exposes and copies rows
 * into tenant-local Hub tables, as opposed to the zero-copy FDW virtualization
 * path handled elsewhere in (@link IntegrationService).
 */
export class SyncService {
    /**
     * Run a one-shot full sync of a data source: discovers every schema and
     * table the connector exposes, then copies each table's rows into the
     * tenant's Hub schema via (@link SyncService.syncTable). Always closes the
     * connector connection, even on failure.
     * @param tenantId - Owning tenant (target schema is `tenant_<tenantId>`).
     * @param sourceName - Name of the data source (used as a table-name prefix in the Hub).
     * @param syncType - Sync type label (used only for logging here).
     * @param config - Connector configuration; `config.type` selects the connector (defaults to `'postgres'`).
     * @returns Resolves once every discovered table has been synced.
     * @throws Re-throws any connector/discovery/query error after logging it.
     */
    static async initializeSync(tenantId: string, sourceName: string, syncType: string, config: any) {
        console.log(`[SyncService] Initializing ${syncType} for ${sourceName} (Tenant: ${tenantId})`);
        
        const connector = ConnectorFactory.getConnector(config.type || 'postgres', config);
        
        try {
            const schemas = await connector.discoverSchemas();
            for (const schema of schemas) {
                const tables = await connector.discoverTables(schema.physicalName);
                for (const table of tables) {
                    await this.syncTable(tenantId, sourceName, schema.physicalName, table.name, connector);
                }
            }
            console.log(`[SyncService] Initial sync complete for ${sourceName}`);
        } catch (err: any) {
            console.error(`[SyncService] Sync failed: ${err.message}`);
            throw err;
        } finally {
            await connector.close();
        }
    }

    /**
     * Copy up to 1000 rows of a single source table into a tenant Hub table,
     * creating the target schema/table on first use. All columns are created
     * as TEXT (a simple, lossless-but-untyped landing format), and inserts use
     * `ON CONFLICT DO NOTHING` so re-running the sync is idempotent for rows
     * that already exist. A no-op if the source table has zero rows (the
     * target table is not even created in that case).
     * @param tenantId - Owning tenant; sanitized and used to derive the target schema `tenant_<cleanTenant>`.
     * @param sourceName - Name of the data source; combined with `table` (sanitized) for the target table name.
     * @param schema - Source schema name to read from.
     * @param table - Source table name to read from.
     * @param connector - The connector instance used to query the source (must implement `query(schema, table, opts)`).
     * @returns Resolves once the batch has been inserted (or immediately if the source table is empty).
     */
    private static async syncTable(tenantId: string, sourceName: string, schema: string, table: string, connector: any) {
        const cleanTenant = tenantId.replace(/[^a-zA-Z0-9_]/g, '');
        const targetSchema = `tenant_${cleanTenant}`;
        const targetTable = `${sourceName}_${table}`.replace(/[^a-zA-Z0-9_]/g, '');

        console.log(`[SyncService] Syncing ${schema}.${table} to ${targetSchema}.${targetTable}`);

        // 1. Fetch data from source
        const data = await connector.query(schema, table, { limit: 1000 }); 

        if (data.length === 0) return;

        // 2. Create target table in Hub if not exists
        const columns = Object.keys(data[0]);
        const colDefs = columns.map(col => `"${col}" TEXT`).join(', '); 
        
        await pool.query(`CREATE SCHEMA IF NOT EXISTS "${targetSchema}"`);
        await pool.query(`CREATE TABLE IF NOT EXISTS "${targetSchema}"."${targetTable}" (${colDefs})`);

        // 3. Batch Insert into Hub
        const placeholders = data.map((_: any, i: number) => 
            '(' + columns.map((__: any, j: number) => `$${i * columns.length + j + 1}`).join(', ') + ')'
        ).join(', ');
        
        const values = data.flatMap((row: any) => columns.map(col => row[col]));
        
        await pool.query(
            `INSERT INTO "${targetSchema}"."${targetTable}" (${columns.map(c => `"${c}"`).join(', ')}) VALUES ${placeholders}
             ON CONFLICT DO NOTHING`,
            values
        );
    }
}
