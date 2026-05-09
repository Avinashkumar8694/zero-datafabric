import { pool } from '../../config/database';
import { DiffEngine } from './diff_engine';
import { Transpiler } from './transpiler';
import { MetadataManifest } from './types';
import { DownstreamService } from './downstream_service';
import { HeterogeneousDispatcher } from './dispatcher';

export class MetadataOrchestrator {
    async apply(tenantId: string, manifest: MetadataManifest, options: { force?: boolean } = {}) {
        this.validateManifest(manifest); // Stage 1: Structural Validation
        await this.validateDataSources(tenantId, manifest); // Stage 2: Connectivity Validation

        const plan = await this.plan(tenantId, manifest);
        
        if (plan.summary.highRisk > 0 && !options.force) {
            throw new Error(`CRITICAL: ${plan.summary.highRisk} High-Risk changes detected. Use force=true to override.`);
        }

        const client = await pool.connect();
        const results: any[] = [];

        try {
            await client.query('BEGIN');
            
            await this.ensureBaseInfrastructure(client);

            // Provision Manifest Extensions
            if (manifest.extensions) {
                const extSqls = await Transpiler.toSql({ action: 'PROVISION_EXTENSIONS', extensions: manifest.extensions }, tenantId, manifest);
                for (const sql of extSqls) {
                    console.log(`[Orchestrator] Executing Extension SQL: ${sql}`);
                    await client.query(sql);
                }
            }

            for (const diff of plan.changes) {
                const targetSource = diff.targetSource || manifest.targetSource || 'Fabric_Hub_Postgres';
                
                if (targetSource.toLowerCase().includes('mongo')) {
                    const ops = await Transpiler.toMongo(diff, tenantId, manifest);
                    await HeterogeneousDispatcher.execute(tenantId, targetSource, ops);
                } else {
                    const sqls = await Transpiler.toSql(diff, tenantId, manifest);
                    // Hub Postgres is already connected via 'client', but other Postgres sources need dispatcher
                    if (targetSource === 'Fabric_Hub_Postgres') {
                        for (const sql of sqls) {
                            console.log(`[Orchestrator] Executing Hub SQL: ${sql}`);
                            await client.query(sql);
                        }
                    } else {
                        await HeterogeneousDispatcher.execute(tenantId, targetSource, sqls);
                    }
                }
                
                results.push({ action: diff.action, name: diff.name || diff.table, targetSource, status: 'SUCCESS' });
            }

            await this.persistMetadataState(client, tenantId, manifest, plan.summary);

            // Step 4: Downstream Orchestration (Industrial Fabric Extension)
            const downstreamResults = await DownstreamService.provision(tenantId, manifest);

            await client.query('COMMIT');
            return {
                status: 'APPLIED',
                manifestVersion: manifest.version,
                appliedCount: results.length,
                plan: plan.changes,
                results: results,
                downstream: downstreamResults
            };
        } catch (err: any) {
            await client.query('ROLLBACK');
            console.error(`[Orchestrator] CRITICAL ERROR during apply: ${err.message}`);
            console.error(err.stack);
            if (err.detail) console.error(`[Orchestrator] Error Detail: ${err.detail}`);
            throw err;
        } finally {
            client.release();
        }
    }

    private async validateDataSources(tenantId: string, manifest: MetadataManifest) {
        const referencedSources = new Set<string>();
        
        if (manifest.targetSource) referencedSources.add(manifest.targetSource);
        
        if (manifest.schemas) {
            for (const schema of manifest.schemas) {
                if (schema.resources) {
                    for (const res of schema.resources) {
                        if (res.type === 'VIEW' && res.query) {
                            // Deep scan query for source references
                            this.findSourcesInQuery(res.query, referencedSources);
                        }
                    }
                }
            }
        }

        if (manifest.relationships) {
            for (const rel of manifest.relationships) {
                if (rel.from.source) referencedSources.add(rel.from.source);
                if (rel.to.source) referencedSources.add(rel.to.source);
            }
        }

        // Validate each referenced source against the catalog
        for (const sourceName of referencedSources) {
            // "Fabric_Hub_Postgres" is a reserved name for the local hub
            if (sourceName === 'Fabric_Hub_Postgres') continue;

            const { rows } = await pool.query(
                `SELECT id, status FROM public.data_sources WHERE tenant_id = $1 AND name = $2`,
                [tenantId, sourceName]
            );

            if (rows.length === 0) {
                throw new Error(`Industrial Orchestration Failed: Referenced Data Source "${sourceName}" not found in Catalog.`);
            }

            if (rows[0].status !== 'ACTIVE') {
                throw new Error(`Industrial Orchestration Failed: Referenced Data Source "${sourceName}" is currently ${rows[0].status}. Connectivity required.`);
            }
        }
    }

    private findSourcesInQuery(query: any, sources: Set<string>) {
        if (!query) return;
        if (query.from && query.from.source) sources.add(query.from.source);
        if (query.joins) {
            for (const join of query.joins) {
                if (join.source) sources.add(join.source);
            }
        }
        if (query.union) query.union.forEach((q: any) => this.findSourcesInQuery(q, sources));
        if (query.intersect) query.intersect.forEach((q: any) => this.findSourcesInQuery(q, sources));
        if (query.except) query.except.forEach((q: any) => this.findSourcesInQuery(q, sources));
        if (query.with) {
            for (const cte of query.with) {
                this.findSourcesInQuery(cte.base, sources);
                if (cte.unionAll) this.findSourcesInQuery(cte.unionAll, sources);
            }
        }
    }

    private static CORE_EXTENSIONS = ['uuid-ossp', 'pg_stat_statements', 'pgcrypto', 'btree_gist'];

    private async ensureBaseInfrastructure(client: any) {
        for (const ext of MetadataOrchestrator.CORE_EXTENSIONS) {
            await client.query(`CREATE EXTENSION IF NOT EXISTS "${ext}"`);
        }
        await client.query(`CREATE SCHEMA IF NOT EXISTS fabric_system`);
    }

    async plan(tenantId: string, manifest: MetadataManifest) {
        const client = await pool.connect();
        try {
            await this.ensureBaseInfrastructure(client);
            const diffs = await DiffEngine.compare(tenantId, manifest, client);
            return {
                status: 'PLAN_READY',
                summary: {
                    total: diffs.length,
                    highRisk: diffs.filter(d => d.risk === 'HIGH').length,
                    quarantine: diffs.filter(d => d.action === 'QUARANTINE_TABLE').length
                },
                changes: diffs
            };
        } finally {
            client.release();
        }
    }

    private async persistMetadataState(client: any, tenantId: string, manifest: MetadataManifest, summary: any) {
        // 1. Log History
        await client.query(`
            INSERT INTO fabric_system.metadata_history (tenant_id, version_tag, ast_content, summary)
            VALUES ($1, $2, $3, $4)
        `, [tenantId, manifest.version, JSON.stringify(manifest), JSON.stringify(summary)]);

        // 2. Sync Catalog (Industrial Integrity: Ensure UI Explorer works)
        for (const schema of manifest.schemas) {
            const targetSourceName = schema.targetSource || manifest.targetSource || 'Fabric_Hub_Postgres';
            const { rows: sourceRows } = await client.query('SELECT id FROM public.data_sources WHERE name = $1', [targetSourceName]);
            if (sourceRows.length === 0) continue;

            const sourceId = sourceRows[0].id;

            const physicalSchema = `tenant_${tenantId}_${schema.name}`;
            const { rows: schemaRows } = await client.query(`
                INSERT INTO public.catalog_schemas (source_id, name, physical_name)
                VALUES ($1, $2, $3)
                ON CONFLICT (source_id, physical_name) DO UPDATE SET name = EXCLUDED.name
                RETURNING id
            `, [sourceId, schema.name, physicalSchema]);

            const schemaId = schemaRows[0].id;
            const schemaPrefix = `${physicalSchema}.`;

            // Sync All Resources (Tables, Views, Sequences, etc.)
            for (const resource of schema.resources) {
                const physicalName = `${schemaPrefix}${resource.name}`;
                await client.query(`
                    INSERT INTO public.catalog_tables (schema_id, name, physical_name, resource_type)
                    VALUES ($1, $2, $3, $4)
                    ON CONFLICT (schema_id, physical_name) DO UPDATE SET last_crawled_at = NOW(), resource_type = EXCLUDED.resource_type
                `, [schemaId, resource.name, physicalName, resource.type]);

                // Industrial Enhancement: Sync Internal Triggers as sub-resources
                if (resource.type === 'TABLE' && resource.triggers) {
                    for (const trg of resource.triggers) {
                        await client.query(`
                            INSERT INTO public.catalog_tables (schema_id, name, physical_name, resource_type)
                            VALUES ($1, $2, $3, 'TRIGGER')
                            ON CONFLICT (schema_id, physical_name) DO UPDATE SET last_crawled_at = NOW()
                        `, [schemaId, `${resource.name}.${trg.name}`, `${physicalName}.${trg.name}`]);
                    }
                }

                // Sync RLS Policies
                if (resource.type === 'TABLE' && resource.security?.policies) {
                    for (const pol of resource.security.policies) {
                        await client.query(`
                            INSERT INTO public.catalog_tables (schema_id, name, physical_name, resource_type)
                            VALUES ($1, $2, $3, 'POLICY')
                            ON CONFLICT (schema_id, physical_name) DO UPDATE SET last_crawled_at = NOW()
                        `, [schemaId, `${resource.name}.${pol.name}`, `${physicalName}.${pol.name}`]);
                    }
                }
            }
        }
    }

    async getHistory(tenantId: string) {
        const { rows } = await pool.query(`SELECT id, version_tag, summary, applied_at FROM fabric_system.metadata_history WHERE tenant_id = $1 ORDER BY applied_at DESC`, [tenantId]);
        return rows;
    }

    async rollback(tenantId: string, versionId: string) {
        const { rows } = await pool.query(`SELECT ast_content FROM fabric_system.metadata_history WHERE id = $1 AND tenant_id = $2`, [versionId, tenantId]);
        if (rows.length === 0) throw new Error('Version not found');
        return await this.apply(tenantId, rows[0].ast_content, { force: true });
    }

    private validateManifest(manifest: MetadataManifest) {
        if (!manifest.version) throw new Error('Industrial Integrity Violation: Manifest version required');
        if (!manifest.schemas || manifest.schemas.length === 0) throw new Error('Industrial Integrity Violation: At least one schema required');
    }
}
