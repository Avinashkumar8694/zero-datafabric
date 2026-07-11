import { PoolClient } from 'pg';
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

        if (options.force) {
            for (const schema of manifest.schemas) {
                if (!plan.changes.find(c => c.action === 'CREATE_SCHEMA' && c.name === schema.name)) {
                    plan.changes.unshift({ action: 'CREATE_SCHEMA', name: schema.name, targetSource: schema.targetSource || manifest.targetSource, risk: 'LOW' });
                }
            }
        }

        const client = await pool.connect();
        const results: any[] = [];

        try {
            await client.query('BEGIN');
            // DDL provisioning (distributed tables, EXCLUDE/GIST, matviews) can exceed the
            // pool's 10s query-safety statement_timeout — raise it for this apply transaction.
            await client.query(`SET LOCAL statement_timeout = '180s'`);

            await this.ensureBaseInfrastructure(client);

            // Provision Manifest Extensions
            if (manifest.extensions) {
                const extSqls = await Transpiler.toSql({ action: 'PROVISION_EXTENSIONS', extensions: manifest.extensions }, tenantId, manifest);
                for (const sql of extSqls) {
                    console.log(`[Orchestrator] Executing Extension SQL: ${sql}`);
                    await client.query(sql);
                }
            }

            const resourceDefinitions: Map<string, { sql: string, ast: any }> = new Map();
            const manifestResources: Map<string, any> = new Map();
            for (const schema of manifest.schemas) {
                for (const res of schema.resources) {
                    manifestResources.set(`${schema.name}.${res.name}`, res);
                }
            }

            for (const diff of plan.changes) {
                const targetSource = diff.targetSource || manifest.targetSource || 'Fabric_Hub_Postgres';
                const isMongo = targetSource.toLowerCase().includes('mongo');
                const sqls = isMongo ? [] : await Transpiler.toSql(diff, tenantId, manifest);
                
                const resourceName = diff.table || diff.name || (diff as any).resource;
                const schemaName = diff.schema || (diff.action === 'CREATE_SCHEMA' ? diff.name : null);
                
                // 1. Capture Technical Specifications
                if (resourceName && schemaName) {
                    const key = `${schemaName}.${resourceName}`;
                    resourceDefinitions.set(key, {
                        sql: sqls.filter(s => !s.toUpperCase().includes('DROP')).join(';\n'),
                        ast: manifestResources.get(key) || diff
                    });
                }

                // 2. Physical Deployment.
                // Hub (local Postgres) DDL is transactional and MUST succeed (fatal on error).
                // Remote engines (Mongo / warehouse) are dispatched best-effort (SAGA): a remote
                // outage must NOT roll back the core Postgres provisioning — it degrades instead.
                let deployStatus = 'SUCCESS';
                if (isMongo) {
                    // The local Postgres namespace (catalog/metadata home) is created transactionally.
                    if (diff.action === 'CREATE_SCHEMA') {
                        await client.query(`CREATE SCHEMA IF NOT EXISTS "tenant_${tenantId}_${diff.name}"`);
                    }
                    try {
                        const ops = await Transpiler.toMongo(diff, tenantId, manifest);
                        await HeterogeneousDispatcher.execute(tenantId, targetSource, ops);
                    } catch (e: any) {
                        deployStatus = 'DEGRADED';
                        console.warn(`[Orchestrator] Remote(Mongo) dispatch degraded for ${resourceName}@${targetSource}: ${e.message}`);
                    }
                } else if (targetSource === 'Fabric_Hub_Postgres') {
                    for (const sql of sqls) {
                        console.log(`[Orchestrator:Hub] Executing: ${sql}`);
                        await client.query(sql);
                    }
                } else {
                    // Remote non-Mongo (e.g. warehouse Postgres): local namespace transactional, dispatch best-effort.
                    if (diff.action === 'CREATE_SCHEMA') {
                        const schemaName = `tenant_${tenantId}_${diff.name}`;
                        await client.query(`CREATE SCHEMA IF NOT EXISTS "${schemaName}"`);
                    }
                    try {
                        await HeterogeneousDispatcher.execute(tenantId, targetSource, sqls);
                    } catch (e: any) {
                        deployStatus = 'DEGRADED';
                        console.warn(`[Orchestrator] Remote dispatch degraded for ${resourceName}@${targetSource}: ${e.message}`);
                    }
                }

                results.push({ action: diff.action, name: resourceName, targetSource, status: deployStatus });
            }

            // 3. Catalog Synchronization (Universal Refresh)
            await this.persistMetadataState(client, tenantId, manifest, plan.summary, resourceDefinitions, manifestResources);
            await this.ensureTenantSchemaPrivileges(client, tenantId, manifest);

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

    private async ensureTenantSchemaPrivileges(client: PoolClient, tenantId: string, manifest: MetadataManifest) {
        for (const schema of manifest.schemas) {
            const schemaName = `tenant_${tenantId}_${schema.name}`;
            // Skip schemas that have no local Postgres namespace (defensive — avoids a
            // whole-apply rollback if provisioning of one schema was skipped).
            const exists = await client.query(`SELECT 1 FROM information_schema.schemata WHERE schema_name = $1`, [schemaName]);
            if (exists.rows.length === 0) continue;
            await client.query(`DO $$ BEGIN IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'fabric_user') THEN EXECUTE 'GRANT USAGE ON SCHEMA "${schemaName}" TO fabric_user'; END IF; END $$;`);
            await client.query(`DO $$ BEGIN IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'fabric_user') THEN EXECUTE 'GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA "${schemaName}" TO fabric_user'; END IF; END $$;`);
            await client.query(`DO $$ BEGIN IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'fabric_user') THEN EXECUTE 'GRANT SELECT, USAGE ON ALL SEQUENCES IN SCHEMA "${schemaName}" TO fabric_user'; END IF; END $$;`);
            await client.query(`DO $$ BEGIN IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'fabric_user') THEN EXECUTE 'ALTER DEFAULT PRIVILEGES IN SCHEMA "${schemaName}" GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO fabric_user'; END IF; END $$;`);
            await client.query(`DO $$ BEGIN IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'fabric_user') THEN EXECUTE 'ALTER DEFAULT PRIVILEGES IN SCHEMA "${schemaName}" GRANT USAGE, SELECT ON SEQUENCES TO fabric_user'; END IF; END $$;`);
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
        await this.ensureFabricPrimitives(client);
    }

    /**
     * Platform primitives that manifests are allowed to reference in column defaults,
     * generators and triggers (uuid_generate_v7, current_user_id, current_tenant,
     * generate_tenant_id, audit_log_fn). Created in `public` so they resolve from any
     * tenant schema's search_path. Idempotent (CREATE OR REPLACE).
     */
    private async ensureFabricPrimitives(client: any) {
        const stmts = [
            // RFC-9562 UUIDv7 (time-ordered) — uuid-ossp only ships v1/v4.
            `CREATE OR REPLACE FUNCTION public.uuid_generate_v7() RETURNS uuid AS $$
                SELECT encode(
                    set_bit(set_bit(
                        overlay(uuid_send(gen_random_uuid())
                            placing substring(int8send((extract(epoch FROM clock_timestamp()) * 1000)::bigint) FROM 3)
                            FROM 1 FOR 6),
                        52, 1), 53, 1), 'hex')::uuid;
            $$ LANGUAGE sql VOLATILE`,
            // Identity helpers backed by the session GUCs set by queryWithContext.
            `CREATE OR REPLACE FUNCTION public.current_tenant() RETURNS text AS $$
                SELECT current_setting('app.tenant_id', true) $$ LANGUAGE sql STABLE`,
            `CREATE OR REPLACE FUNCTION public.current_user_id() RETURNS text AS $$
                SELECT current_setting('app.user_name', true) $$ LANGUAGE sql STABLE`,
            `CREATE OR REPLACE FUNCTION public.generate_tenant_id(p_tenant text DEFAULT NULL) RETURNS text AS $$
                SELECT COALESCE(p_tenant, current_setting('app.tenant_id', true)) || '-' || nextval('fabric_system.global_seq')::text $$ LANGUAGE sql VOLATILE`,
            `CREATE SEQUENCE IF NOT EXISTS fabric_system.global_seq`,
            // Generic audit trigger fn manifests can attach (writes to fabric_admin.audit_logs if present).
            `CREATE OR REPLACE FUNCTION public.audit_log_fn() RETURNS trigger AS $$
                BEGIN
                    BEGIN
                        INSERT INTO fabric_admin.audit_logs (table_name, action, new_data, user_name, changed_at)
                        VALUES (TG_TABLE_NAME, TG_OP, to_jsonb(NEW), current_setting('app.user_name', true), NOW());
                    EXCEPTION WHEN undefined_table THEN NULL; END;
                    RETURN NEW;
                END; $$ LANGUAGE plpgsql`,
        ];
        for (const s of stmts) {
            try { await client.query(s); } catch (e: any) { console.warn(`[Orchestrator] primitive skipped: ${e.message}`); }
        }
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

    private async persistMetadataState(
        client: PoolClient, 
        tenantId: string, 
        manifest: MetadataManifest, 
        summary: any, 
        definitions: Map<string, { sql: string, ast: any }>,
        manifestResources: Map<string, any>
    ) {
        // 1. Log History
        await client.query(`
            INSERT INTO fabric_system.metadata_history (tenant_id, version_tag, ast_content, summary)
            VALUES ($1, $2, $3, $4)
        `, [tenantId, manifest.version, JSON.stringify(manifest), JSON.stringify(summary)]);

        // 2. Sync Catalog (Industrial Integrity: Ensure UI Explorer works)
        for (const schema of manifest.schemas) {
            const targetSourceName = schema.targetSource || manifest.targetSource || 'Fabric_Hub_Postgres';
            let { rows: sourceRows } = await client.query(
                'SELECT id FROM public.data_sources WHERE tenant_id = $1 AND name = $2',
                [tenantId, targetSourceName]
            );

            // Keep Explorer in sync even when Hub source was not pre-seeded for this tenant.
            if (sourceRows.length === 0 && targetSourceName === 'Fabric_Hub_Postgres') {
                const upsert = await client.query(`
                    INSERT INTO public.data_sources (tenant_id, name, type, config, sync_type, status)
                    VALUES ($1, $2, $3, $4, $5, $6)
                    ON CONFLICT (tenant_id, name) DO UPDATE SET status = EXCLUDED.status
                    RETURNING id
                `, [tenantId, targetSourceName, 'POSTGRES', JSON.stringify({ local: true }), 'VIRTUAL', 'ACTIVE']);
                sourceRows = upsert.rows;
            }

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

            for (const resource of schema.resources) {
                // Keep physical_name as object name only; schema is tracked separately in catalog_schemas.
                const physicalName = `${resource.name}`;
                const defKey = `${schema.name}.${resource.name}`;
                const def = definitions.get(defKey);
                const finalAst = manifestResources.get(defKey) || def?.ast || null;

                await client.query(`
                    INSERT INTO public.catalog_tables (schema_id, name, physical_name, resource_type, definition_sql, definition_ast)
                    VALUES ($1, $2, $3, $4, $5, $6)
                    ON CONFLICT (schema_id, physical_name) DO UPDATE SET 
                        last_crawled_at = NOW(), 
                        resource_type = EXCLUDED.resource_type,
                        definition_sql = COALESCE(EXCLUDED.definition_sql, public.catalog_tables.definition_sql),
                        definition_ast = COALESCE(EXCLUDED.definition_ast, public.catalog_tables.definition_ast)
                `, [schemaId, resource.name, physicalName, resource.type, def?.sql || null, finalAst ? JSON.stringify(finalAst) : null]);

                // Sync Internal Triggers
                if (resource.type === 'TABLE' && resource.triggers) {
                    for (const trg of resource.triggers) {
                        const trgKey = trg.name; // Transpiler might need adjustment to return trigger SQL keyed by name
                        await client.query(`
                            INSERT INTO public.catalog_tables (schema_id, name, physical_name, resource_type, definition_ast)
                            VALUES ($1, $2, $3, 'TRIGGER', $4)
                            ON CONFLICT (schema_id, physical_name) DO UPDATE SET last_crawled_at = NOW(), definition_ast = EXCLUDED.definition_ast
                        `, [schemaId, `${resource.name}.${trg.name}`, `${physicalName}.${trg.name}`, JSON.stringify(trg)]);
                    }
                }

                // Sync RLS Policies
                if (resource.type === 'TABLE' && resource.security?.policies) {
                    for (const pol of resource.security.policies) {
                        await client.query(`
                            INSERT INTO public.catalog_tables (schema_id, name, physical_name, resource_type, definition_ast)
                            VALUES ($1, $2, $3, 'POLICY', $4)
                            ON CONFLICT (schema_id, physical_name) DO UPDATE SET last_crawled_at = NOW(), definition_ast = EXCLUDED.definition_ast
                        `, [schemaId, `${resource.name}.${pol.name}`, `${physicalName}.${pol.name}`, JSON.stringify(pol)]);
                    }
                }
            }
        }

        // Persist declared relationships so ER diagrams / lineage have real data.
        if (Array.isArray(manifest.relationships)) {
            for (const rel of manifest.relationships) {
                const card = rel.cardinality === 'M:N' ? 'M:M' : rel.cardinality; // table CHECK uses M:M
                const fromSchema = (rel.from as any).source || manifest.namespace || 'default';
                const toSchema = (rel.to as any).source || manifest.namespace || 'default';
                try {
                    await client.query(`
                        INSERT INTO fabric_catalog.relationships
                            (tenant_id, name, schema_name, source_schema, source_table, source_column, target_schema, target_table, target_column, cardinality)
                        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
                        ON CONFLICT ON CONSTRAINT relationships_full_identity_key DO UPDATE SET cardinality = EXCLUDED.cardinality
                    `, [tenantId, rel.name, fromSchema, fromSchema, rel.from.resource, rel.from.field, toSchema, rel.to.resource, rel.to.field, card]);
                } catch (e: any) {
                    // Fall back to the base unique key if the hardened constraint name differs.
                    console.warn(`[Orchestrator] relationship persist skipped for ${rel.name}: ${e.message}`);
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
