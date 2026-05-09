import { MetadataManifest } from './types';
import { pool } from '../../config/database';

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
        // In a real system, this would call the ES Mapping API
        // We'll simulate creating an index for each table
        const indices = [];
        for (const schema of manifest.schemas) {
            for (const resource of schema.resources) {
                if (resource.type === 'TABLE') {
                    indices.push(`${tenantId}_${resource.name}`.toLowerCase());
                }
            }
        }
        return {
            type: 'ELASTICSEARCH',
            status: 'PROVISIONED',
            indicesCount: indices.length,
            fallback: config.fallback,
            connector: connector.name
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
}
