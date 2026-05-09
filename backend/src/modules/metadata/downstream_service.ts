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
            let detail = {};

            if (target.enabled) {
                switch (target.type.toUpperCase()) {
                    case 'ELASTICSEARCH':
                        detail = await this.provisionElasticsearch(tenantId, target, manifest);
                        status = 'ACTIVE';
                        break;
                    case 'SNOWFLAKE':
                        detail = await this.provisionSnowflake(tenantId, target, manifest);
                        status = 'ACTIVE';
                        break;
                }
            }

            // Persist Status in Registry
            await pool.query(`
                INSERT INTO fabric_system.downstream_registry (tenant_id, target_type, config, status, updated_at)
                VALUES ($1, $2, $3, $4, NOW())
                ON CONFLICT (tenant_id, target_type) 
                DO UPDATE SET config = EXCLUDED.config, status = EXCLUDED.status, updated_at = NOW()
            `, [tenantId, target.type, JSON.stringify(target), status]);

            results.push({ type: target.type, status, ...detail });
        }

        return results;
    }

    private static async provisionElasticsearch(tenantId: string, config: any, manifest: MetadataManifest) {
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
        return { type: 'ELASTICSEARCH', status: 'PROVISIONED', indicesCount: indices.length, fallback: config.fallback };
    }

    private static async provisionSnowflake(tenantId: string, config: any, manifest: MetadataManifest) {
        console.log(`[Snowflake] Setting up CDC Stream for ${tenantId}. Strategy: ${config.strategy}`);
        // In a real system, this would provision Snowflake Pipes or CDC Connectors
        return { type: 'SNOWFLAKE', status: 'CDC_ENABLED', strategy: config.strategy, schema: `SNOWFLAKE_FABRIC_${tenantId.toUpperCase()}` };
    }
}
