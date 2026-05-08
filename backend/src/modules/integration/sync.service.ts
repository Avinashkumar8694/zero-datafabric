import { pool } from '../../config/database';
import { ConnectorFactory } from '../metadata/connectors/factory';

export class SyncService {
    /**
     * Initializes a sync process for a data source
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
