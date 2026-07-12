/**
 * Metadata manifest orchestrator.
 * --------------------------------
 * The top-level entry point for the manifest apply/diff/rollback lifecycle:
 * validates a manifest structurally and against the tenant's registered data
 * sources, computes the required changes via `DiffEngine`, compiles them to
 * engine-native statements via `Transpiler`, and executes them — Hub Postgres
 * DDL transactionally, remote/heterogeneous engines best-effort (SAGA-style)
 * via `HeterogeneousDispatcher` so a remote outage degrades rather than
 * rolling back the whole apply. After provisioning it synchronizes the fabric
 * catalog (schemas/tables/triggers/policies/constraints/relationships) so the
 * UI Explorer, Policy Engine and Constraint Engine stay consistent with what
 * was just applied, then reconciles downstream sync targets via
 * `DownstreamService`. Every successful apply is recorded to
 * `fabric_system.metadata_history`, which also backs `rollback` (re-apply of
 * a prior manifest snapshot with `force: true`).
 */
import { PoolClient } from 'pg';
import { pool } from '../../config/database';
import { DiffEngine } from './diff_engine';
import { Transpiler } from './transpiler';
import { MetadataManifest } from './types';
import { DownstreamService } from './downstream_service';
import { HeterogeneousDispatcher } from './dispatcher';
import { PolicyService } from '../security/policy.service';
import { ConstraintService } from '../query-engine/constraint.service';
import { GrantService } from '../security/grant.service';

/**
 * Orchestrates the full lifecycle of applying, planning and rolling back a
 * tenant's metadata manifest across the Fabric Hub and any registered
 * heterogeneous/remote data sources.
 */
export class MetadataOrchestrator {
    /**
     * Applies a manifest to a tenant's fabric: validates it, computes a plan
     * of required changes, and executes that plan. Hub Postgres provisioning
     * runs inside a single transaction (raised to a 180s statement timeout
     * for heavier DDL); provisioning against remote/heterogeneous sources is
     * dispatched best-effort per resource and marked `DEGRADED` on failure
     * rather than aborting the transaction. After provisioning, synchronizes
     * the fabric catalog, tenant schema privileges and downstream targets,
     * then commits. Any error during Hub provisioning or catalog sync rolls
     * back the entire transaction.
     * @param tenantId Tenant scope the manifest is applied for.
     * @param manifest The declarative manifest to apply.
     * @param options.force When true, skips the high-risk-change guard and ensures every declared schema has a `CREATE_SCHEMA` diff even if the plan didn't already include one.
     * @returns `(status: 'APPLIED', manifestVersion, appliedCount, plan, results, downstream)` describing what was executed.
     * @throws {Error} If manifest validation fails, a referenced data source is missing/inactive, the plan contains high-risk changes without `force`, or Hub Postgres provisioning/catalog sync fails (transaction is rolled back first).
     */
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

    /**
     * Grants the `fabric_user` role standard privileges (USAGE on schema,
     * SELECT/INSERT/UPDATE/DELETE on tables, SELECT/USAGE on sequences, plus
     * matching default privileges for future objects) on every one of the
     * manifest's physical schemas that actually exists. Skips schemas that
     * were never created (defensive: avoids failing the whole apply if one
     * schema's provisioning was itself skipped) and no-ops entirely if the
     * `fabric_user` role doesn't exist.
     * @param client Open transactional pool client (part of the apply transaction).
     * @param tenantId Tenant scope; physical schema names are derived as `tenant_{tenantId}_(schema.name)`.
     * @param manifest The manifest whose schemas' privileges are ensured.
     */
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

    /**
     * Validates that every non-Hub data source the manifest references
     * (`manifest.targetSource`, federated view queries, and relationship
     * `source` fields) is registered in the tenant's catalog and currently
     * `ACTIVE`. `'Fabric_Hub_Postgres'` is treated as always available and
     * skipped.
     * @param tenantId Tenant scope.
     * @param manifest The manifest whose referenced data sources are validated.
     * @throws {Error} If a referenced data source isn't found in the catalog, or exists but isn't `ACTIVE`.
     */
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

    /**
     * Recursively walks a `QueryAST` (a view's query definition) collecting
     * every `source` name referenced by its FROM target, joins, CTE bases,
     * and set-operation branches (UNION/INTERSECT/EXCEPT), so federated views
     * can be validated against the tenant's registered data sources.
     * @param query The query AST fragment to scan (may be `null`/`undefined`, in which case this is a no-op).
     * @param sources Accumulator set that discovered source names are added to.
     */
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

    /**
     * Ensures the platform-level infrastructure every manifest apply depends
     * on exists before any tenant DDL runs: the core extensions
     * (`CORE_EXTENSIONS`), the `fabric_system` schema, and the fabric
     * primitive functions/sequence (`ensureFabricPrimitives`). Idempotent.
     * @param client Open Postgres client/pool to run the setup statements on.
     */
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
     * @param client Open Postgres client/pool to create the primitives on. Each statement's failure is caught and logged individually so one unsupported primitive doesn't block the rest.
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
            // SECURITY DEFINER so it runs as the owner (fabric_admin) and can write the
            // control-plane audit table even when a restricted tenant role fired the trigger.
            // The inner handler swallows missing-table AND permission errors so auditing can
            // never block the business write it observes.
            `CREATE OR REPLACE FUNCTION public.audit_log_fn() RETURNS trigger AS $$
                BEGIN
                    BEGIN
                        INSERT INTO fabric_admin.audit_logs (table_name, action, new_data, user_name, changed_at)
                        VALUES (TG_TABLE_NAME, TG_OP, to_jsonb(NEW), current_setting('app.user_name', true), NOW());
                    EXCEPTION WHEN undefined_table OR insufficient_privilege THEN NULL; END;
                    RETURN COALESCE(NEW, OLD);
                END; $$ LANGUAGE plpgsql SECURITY DEFINER`,
        ];
        for (const s of stmts) {
            try { await client.query(s); } catch (e: any) { console.warn(`[Orchestrator] primitive skipped: ${e.message}`); }
        }
    }

    /**
     * Computes a dry-run plan of the changes a manifest apply would make,
     * without executing any of them. Ensures base infrastructure exists (so
     * the diff queries against `fabric_system`/extensions are valid), then
     * delegates to `DiffEngine.compare`.
     * @param tenantId Tenant scope.
     * @param manifest The manifest to plan against current catalog state.
     * @returns `(status: 'PLAN_READY', summary: ( total, highRisk, quarantine ), changes)` where `changes` is the ordered diff list.
     */
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

    /**
     * Synchronizes the fabric catalog and downstream engine registries with
     * the manifest that was just applied, so every consumer of catalog state
     * stays consistent with the physical result of this apply:
     *  - Logs the manifest + plan summary to `fabric_system.metadata_history` (backs `rollback`).
     *  - Upserts `public.data_sources` / `catalog_schemas` / `catalog_tables` per resource,
     *    preserving each resource's compiled SQL and definition AST for round-tripping
     *    (`MetadataService.exportManifest`) and UI Explorer display.
     *  - Syncs table-scoped triggers and RLS policies as child catalog rows.
     *  - Syncs engine-agnostic access policies/masking/grants to the Policy/Grant Engines
     *    (`PolicyService`, `GrantService`) so non-RLS engines (Mongo/ES/remote) enforce
     *    row filters and column masking too.
     *  - Syncs engine-agnostic column/table constraints to the Constraint Engine
     *    (`ConstraintService`) so non-SQL engines get NOT NULL/UNIQUE/ENUM/CHECK/FK
     *    compensation at write time.
     *  - Persists declared relationships to `fabric_catalog.relationships` for ER
     *    diagrams/lineage (best-effort per relationship; a persist failure for one
     *    relationship is logged and skipped rather than aborting the whole sync).
     * @param client Open transactional pool client (part of the apply transaction).
     * @param tenantId Tenant scope.
     * @param manifest The manifest that was applied.
     * @param summary The plan summary (`(total, highRisk, quarantine)`) recorded alongside the manifest in history.
     * @param definitions Map of `schema.resource` → `(sql, ast)` compiled during apply, used to persist each resource's definition.
     * @param manifestResources Map of `schema.resource` → the manifest's resource object, used as the definitive AST when available.
     */
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

                // Sync ENGINE-AGNOSTIC access policies for the Policy Engine, so row
                // predicates + column masking are enforced on non-RLS engines (Mongo/ES/
                // remote), not just Postgres. Two sources:
                //   (a) security.accessPolicies — structured, engine-agnostic policies.
                //   (b) security.masking        — the legacy masking field (previously a
                //       no-op comment) is mapped to a masking-only fabric policy.
                if (resource.type === 'TABLE' && resource.security) {
                    const sec: any = resource.security;
                    for (const ap of (sec.accessPolicies || [])) {
                        await PolicyService.upsertPolicy(tenantId, {
                            name: ap.name, schema: physicalSchema, table: resource.name,
                            roles: ap.roles, rowFilter: ap.rowFilter, masking: ap.masking,
                        }, 'MANIFEST');
                    }
                    // Engine-agnostic grants → fabric access gate for non-SQL engines.
                    if (Array.isArray(sec.grants) && sec.grants.length) {
                        await GrantService.upsert(tenantId, physicalSchema, resource.name,
                            sec.grants.map((g: any) => ({ role: g.role, privileges: g.privileges || [] })), 'MANIFEST');
                    }
                    if (Array.isArray(sec.masking) && sec.masking.length) {
                        await PolicyService.upsertPolicy(tenantId, {
                            name: `${resource.name}_masking`, schema: physicalSchema, table: resource.name,
                            masking: sec.masking.map((m: any) => ({
                                column: m.column,
                                roles: m.roles,
                                strategy: /null/i.test(m.expression || '') ? 'NULL'
                                    : /hash/i.test(m.expression || '') ? 'HASH'
                                    : /partial|last4/i.test(m.expression || '') ? 'PARTIAL' : 'REDACT',
                            })),
                        }, 'MANIFEST');
                    }
                }

                // Sync ENGINE-AGNOSTIC constraints so the fabric can enforce
                // NOT NULL / UNIQUE / ENUM / CHECK / FK on non-SQL engines at write
                // time (Postgres enforces natively; this compensates elsewhere).
                if (resource.type === 'TABLE') {
                    const enums: Record<string, string[]> = {};
                    for (const r of (schema.resources || [])) if (r.type === 'ENUM') enums[r.name] = r.values || [];
                    const spec = ConstraintService.specFromManifestTable(resource, enums, []);
                    if (spec.columns.length || spec.checks.length) {
                        await ConstraintService.upsert(tenantId, physicalSchema, resource.name, spec, 'MANIFEST');
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

    /**
     * Lists a tenant's manifest apply history, most recent first.
     * @param tenantId Tenant scope.
     * @returns Rows of `(id, version_tag, summary, applied_at)` from `fabric_system.metadata_history`.
     */
    async getHistory(tenantId: string) {
        const { rows } = await pool.query(`SELECT id, version_tag, summary, applied_at FROM fabric_system.metadata_history WHERE tenant_id = $1 ORDER BY applied_at DESC`, [tenantId]);
        return rows;
    }

    /**
     * Rolls back a tenant's fabric to a prior manifest snapshot by re-running
     * `apply` against the historical manifest content, forced (bypassing the
     * high-risk-change guard) since rollback is an intentional operator action.
     * @param tenantId Tenant scope.
     * @param versionId `fabric_system.metadata_history` row id identifying the snapshot to restore.
     * @returns The same result shape as `apply`.
     * @throws {Error} If no history row matches `versionId` for this tenant.
     */
    async rollback(tenantId: string, versionId: string) {
        const { rows } = await pool.query(`SELECT ast_content FROM fabric_system.metadata_history WHERE id = $1 AND tenant_id = $2`, [versionId, tenantId]);
        if (rows.length === 0) throw new Error('Version not found');
        return await this.apply(tenantId, rows[0].ast_content, { force: true });
    }

    /**
     * Structural validation performed before any diffing/provisioning: a
     * manifest must declare a `version` and at least one schema.
     * @param manifest The manifest to validate.
     * @throws {Error} If `version` is missing, or `schemas` is missing/empty.
     */
    private validateManifest(manifest: MetadataManifest) {
        if (!manifest.version) throw new Error('Industrial Integrity Violation: Manifest version required');
        if (!manifest.schemas || manifest.schemas.length === 0) throw new Error('Industrial Integrity Violation: At least one schema required');
    }
}
