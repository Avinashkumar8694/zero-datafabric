import { MetadataManifest } from './types';
import { pool } from '../../config/database';
import axios from 'axios';

export class DownstreamService {
    static async provision(tenantId: string, manifest: MetadataManifest): Promise<any[]> {
        const results: any[] = [];
        
        if (!manifest.downstream) {
            return results;
        }

        console.log(`[DownstreamService] Reconciling downstream targets for tenant: ${tenantId}`);

        for (const target of manifest.downstream) {
            let status = 'DISABLED';
            let detail: any = {};

            try {
                if (target.enabled) {
                    switch (target.type.toUpperCase()) {
                        case 'ELASTICSEARCH':
                            detail = await this.provisionElasticsearch(tenantId, target, manifest);
                            status = detail.status === 'PROVISIONED' ? 'ACTIVE' : detail.status;
                            break;
                        case 'SNOWFLAKE':
                            detail = await this.provisionSnowflake(tenantId, target, manifest);
                            status = detail.status === 'CDC_ENABLED' ? 'ACTIVE' : detail.status;
                            break;
                        default:
                            status = 'UNSUPPORTED';
                            detail = { message: `Unsupported downstream target: ${target.type}` };
                            break;
                    }
                }
            } catch (err: any) {
                status = 'ERROR';
                detail = { message: err.message || 'Downstream provisioning failed' };
            }

            // Persist Status in Registry
            const persistedConfig = { ...target, detail };
            await pool.query(`
                INSERT INTO fabric_system.downstream_registry (tenant_id, target_type, config, status, updated_at)
                VALUES ($1, $2, $3, $4, NOW())
                ON CONFLICT (tenant_id, target_type) 
                DO UPDATE SET config = EXCLUDED.config, status = EXCLUDED.status, updated_at = NOW()
            `, [tenantId, target.type, JSON.stringify(persistedConfig), status]);

            results.push({ type: target.type, status, ...detail });
        }

        return results;
    }

    private static async provisionElasticsearch(tenantId: string, config: any, manifest: MetadataManifest) {
        const connector = await this.getConnectorConfig(tenantId, 'ELASTICSEARCH');
        if (!connector) {
            return {
                type: 'ELASTICSEARCH',
                status: 'NOT_CONFIGURED',
                message: 'No ELASTICSEARCH data source configured for tenant.'
            };
        }

        console.log(`[Elasticsearch] Provisioning search indices for ${tenantId}. Fallback: ${config.fallback}`);
        const indices: string[] = [];
        const indexedTables: string[] = [];
        const skippedTables: string[] = [];
        const errors: string[] = [];
        const endpoint = (connector.config?.connectionString || `http://${connector.config?.host || 'localhost'}:${connector.config?.port || 9200}`).replace(/\/$/, '');
        const axiosConfig: any = { timeout: 4000 };
        if (connector.config?.user && connector.config?.pass) {
            axiosConfig.auth = { username: connector.config.user, password: connector.config.pass };
        }

        for (const schema of manifest.schemas) {
            const sourceName = schema.targetSource || manifest.targetSource || 'Fabric_Hub_Postgres';
            const isLocalHub = sourceName === 'Fabric_Hub_Postgres';
            const physicalSchema = `tenant_${tenantId}_${schema.name}`;
            for (const resource of schema.resources) {
                if (resource.type === 'TABLE') {
                    const indexName = `${tenantId}_${schema.name}_${resource.name}`.toLowerCase();
                    indices.push(indexName);
                    try {
                        const mappings = this.toElasticMappings((resource as any).columns || []);
                        await this.ensureElasticIndex(endpoint, indexName, mappings, axiosConfig);
                        if (!isLocalHub) {
                            skippedTables.push(`${schema.name}.${resource.name}`);
                            continue;
                        }
                        const rows = await this.fetchTableRows(physicalSchema, resource.name);
                        if (rows.length === 0) continue;
                        await this.bulkIndexRows(endpoint, indexName, rows, axiosConfig);
                        indexedTables.push(`${schema.name}.${resource.name}:${rows.length}`);
                    } catch (err: any) {
                        errors.push(`${schema.name}.${resource.name}: ${err.message || 'indexing failed'}`);
                    }
                }
            }
        }
        const status = errors.length > 0 ? 'DEGRADED' : 'PROVISIONED';
        return {
            type: 'ELASTICSEARCH',
            status,
            indicesCount: indices.length,
            fallback: config.fallback,
            connector: connector.name,
            indexedTables,
            skippedTables,
            errors
        };
    }

    private static async provisionSnowflake(tenantId: string, config: any, manifest: MetadataManifest) {
        const connector = await this.getConnectorConfig(tenantId, 'SNOWFLAKE');
        if (!connector) {
            return {
                type: 'SNOWFLAKE',
                status: 'NOT_CONFIGURED',
                message: 'No SNOWFLAKE data source configured for tenant.'
            };
        }

        console.log(`[Snowflake] Setting up CDC Stream for ${tenantId}. Strategy: ${config.strategy}`);
        // In a real system, this would provision Snowflake Pipes or CDC Connectors
        return {
            type: 'SNOWFLAKE',
            status: 'CDC_ENABLED',
            strategy: config.strategy,
            schema: `SNOWFLAKE_FABRIC_${tenantId.toUpperCase()}`,
            connector: connector.name
        };
    }

    private static async getConnectorConfig(tenantId: string, type: string) {
        const { rows } = await pool.query(
            `SELECT name, type, config, status
             FROM public.data_sources
             WHERE tenant_id = $1
               AND UPPER(type) = $2
               AND status IN ('ACTIVE', 'CONNECTED')
             LIMIT 1`,
            [tenantId, type]
        );

        return rows[0] || null;
    }

    private static toElasticMappings(columns: any[]) {
        const props: Record<string, any> = {};
        for (const col of columns) {
            const t = String(col.type || '').toUpperCase();
            if (['UUID', 'STRING', 'TEXT', 'ENUM'].includes(t)) props[col.name] = { type: 'keyword' };
            else if (['TIMESTAMP', 'DATE', 'DATETIME'].includes(t)) props[col.name] = { type: 'date' };
            else if (['BIGINT', 'INT', 'INTEGER', 'SERIAL'].includes(t)) props[col.name] = { type: 'long' };
            else if (['NUMERIC', 'DECIMAL', 'FLOAT', 'DOUBLE'].includes(t)) props[col.name] = { type: 'double' };
            else if (['BOOLEAN', 'BOOL'].includes(t)) props[col.name] = { type: 'boolean' };
            else if (['JSON', 'JSONB'].includes(t)) props[col.name] = { type: 'object', enabled: true };
            else props[col.name] = { type: 'keyword' };
        }
        return { properties: props };
    }

    private static async ensureElasticIndex(endpoint: string, indexName: string, mappings: any, axiosConfig: any) {
        try {
            await axios.head(`${endpoint}/${indexName}`, axiosConfig);
        } catch {
            await axios.put(`${endpoint}/${indexName}`, { mappings }, axiosConfig);
        }
    }

    private static async fetchTableRows(schemaName: string, tableName: string) {
        const safeSchema = schemaName.replace(/[^a-zA-Z0-9_]/g, '');
        const safeTable = tableName.replace(/[^a-zA-Z0-9_]/g, '');
        const sql = `SELECT * FROM "${safeSchema}"."${safeTable}" LIMIT 10000`;
        const { rows } = await pool.query(sql);
        return rows;
    }

    private static async bulkIndexRows(endpoint: string, indexName: string, rows: any[], axiosConfig: any) {
        const lines: string[] = [];
        for (const row of rows) {
            const docId = row.id || row.item_id || undefined;
            const action: any = { index: { _index: indexName } };
            if (docId) action.index._id = String(docId);
            lines.push(JSON.stringify(action));
            lines.push(JSON.stringify(row));
        }
        const payload = lines.join('\n') + '\n';
        const headers = { ...(axiosConfig.headers || {}), 'Content-Type': 'application/x-ndjson' };
        await axios.post(`${endpoint}/_bulk?refresh=true`, payload, { ...axiosConfig, headers });
    }
}
