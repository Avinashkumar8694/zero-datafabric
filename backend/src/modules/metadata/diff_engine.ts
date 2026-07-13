/**
 * Manifest diff engine.
 * ---------------------
 * Compares a `MetadataManifest` against the live catalog (Postgres `information_schema`
 * for engines that support introspection, or assume-provision for engines that don't)
 * to compute the ordered list of changes (`diffs`) needed to reconcile reality with
 * the declared manifest.
 *
 * Engine-aware: instead of hardcoding `if (targetSource !== 'Fabric_Hub_Postgres')`,
 * each diff method consults the `EngineCapabilityRegistry` to determine whether the
 * target engine supports the resource type natively. When it does NOT, a **fabric
 * compensation action** is emitted (e.g. `REGISTER_FABRIC_SEQUENCE`) so the hub can
 * provide the equivalent capability at write-time.
 *
 * Each diff entry is a plain object carrying at minimum `(action, risk, engineType)`
 * plus action-specific fields; `Transpiler.toSql`/`toMysql`/`toOracle`/`toMongo`
 * later compiles these diffs into engine-native DDL/operations, and
 * `MetadataOrchestrator` decides whether high-risk diffs require an explicit `force`.
 */
import { pool } from '../../config/database';
import { MetadataManifest, SchemaDefinition, ResourceDefinition, EnumDefinition, SequenceDefinition, TableDefinition, ViewDefinition, FunctionDefinition } from './types';
import { EngineCapabilityRegistry, EngineCapability, EngineType, ENGINE_CAPABILITIES } from './engine_capabilities';

/**
 * Computes the set of provisioning changes required to reconcile a tenant's
 * live catalog with a declared manifest.
 * @class
 * @hideconstructor
 */
export class DiffEngine {
    /**
     * Compares a manifest against live catalog state and returns the ordered
     * list of diffs required to reconcile them. Diffs are emitted per schema
     * (schema existence, then resources in dependency order, then retired
     * tables), followed by manifest-wide relationship, extension and
     * downstream-target checks.
     *
     * Engine-aware: resolves each schema's `targetSource` to an engine type
     * and passes capabilities to all diff methods.
     *
     * @param tenantId Tenant scope; physical schema names are derived as `tenant_{tenantId}_(schema.name)`.
     * @param manifest The declarative manifest to diff against the live catalog.
     * @param client An open Postgres client/pool connection used for catalog introspection queries.
     * @returns A flat array of diff objects (each with at least `action` and `risk`) in the order they should be applied.
     * @throws Rethrows any error encountered while querying the catalog.
     */
    static async compare(tenantId: string, manifest: MetadataManifest, client: any) {
        const diffs: any[] = [];

        try {
            for (const schema of manifest.schemas) {
                const targetSource = schema.targetSource || manifest.targetSource || 'Fabric_Hub_Postgres';
                const schemaName = `tenant_${tenantId}_${schema.name}`;

                // Resolve engine type and capabilities dynamically
                let engineType: EngineType;
                let caps: EngineCapability;
                try {
                    const resolved = await EngineCapabilityRegistry.resolve(tenantId, targetSource);
                    engineType = resolved.engineType;
                    caps = resolved.caps;
                } catch {
                    // Fallback: if source isn't registered yet (first-time apply), infer from name patterns
                    engineType = this.inferEngineType(targetSource);
                    caps = ENGINE_CAPABILITIES[engineType];
                }

                // 1. Schema Check
                if (caps.catalogIntrospection && caps.supportsSchemas) {
                    const schemaExists = await client.query(`SELECT 1 FROM information_schema.schemata WHERE schema_name = $1`, [schemaName]);
                    if (schemaExists.rows.length === 0) {
                        diffs.push({ action: 'CREATE_SCHEMA', name: schema.name, targetSource, engineType, risk: 'LOW' });
                    }
                } else if (caps.supportsSchemas) {
                    // Engine supports schemas but no catalog introspection — emit CREATE (idempotent)
                    diffs.push({ action: 'CREATE_SCHEMA', name: schema.name, targetSource, engineType, risk: 'LOW' });
                }
                // Engines without schema support (Mongo/ES) skip schema creation entirely

                // 2. Sort Resources by Dependency (DAG)
                const sortedResources = this.sortResources(schema.resources || []);

                for (const resource of sortedResources) {
                    await this.processResourceDiff(client, schemaName, schema.name, resource, diffs, targetSource, engineType, caps);
                }

                // 4. Logical Deletion / Quarantine
                await this.detectRetiredResources(client, schemaName, schema, diffs, targetSource, engineType, caps);
            }

            // 3. Relationship Check - OUTSIDE schema loop
            if (manifest.relationships) {
                for (const rel of manifest.relationships) {
                    // Find which schema to use (default to first if not specified)
                    const schema = manifest.schemas?.[0]?.name || 'public';
                    diffs.push({ action: 'PROVISION_RELATIONSHIP', schema, ...rel });
                }
            }

            // 4. Extension Check (Postgres-only capability)
            if (manifest.extensions) {
                const { rows: liveExts } = await client.query('SELECT extname FROM pg_extension');
                const liveExtNames = liveExts.map((e: any) => e.extname);
                const missing = manifest.extensions.filter((e: string) => !liveExtNames.includes(e));
                if (missing.length > 0) {
                    diffs.push({ action: 'PROVISION_EXTENSIONS', extensions: missing, risk: 'LOW' });
                }
            }

            // 5. Downstream Target Check
            if (manifest.downstream) {
                for (const target of manifest.downstream) {
                    const exists = await client.query('SELECT 1 FROM fabric_system.downstream_registry WHERE tenant_id = $1 AND target_type = $2', [tenantId, target.type]);
                    if (exists.rows.length === 0 || target.enabled) { // Always include if enabled to ensure sync state
                        diffs.push({ action: 'PROVISION_DOWNSTREAM', ...target, risk: 'LOW' });
                    }
                }
            }

            return diffs;
        } catch (err) {
            throw err;
        }
    }

    /**
     * Infers engine type from a source name when the source isn't yet registered
     * in `data_sources` (e.g. during first-time manifest application).
     * Falls back to POSTGRES if no pattern matches.
     * @param sourceName The data source name to infer from.
     * @returns Best-guess engine type.
     */
    private static inferEngineType(sourceName: string): EngineType {
        const lower = sourceName.toLowerCase();
        if (lower.includes('mongo'))         return 'MONGODB';
        if (lower.includes('mysql'))         return 'MYSQL';
        if (lower.includes('elastic') || lower.includes('opensearch')) return 'ELASTICSEARCH';
        if (lower.includes('oracle'))        return 'ORACLE';
        if (lower.includes('snowflake'))     return 'SNOWFLAKE';
        return 'POSTGRES';
    }

    /**
     * Orders resources so dependencies are diffed (and later applied) before
     * their dependents: ENUM, SEQUENCE, then FUNCTION/PROCEDURE, then TABLE,
     * then VIEW/MATERIALIZED_VIEW.
     * @param resources Resources declared in a schema, in manifest order.
     * @returns A new array of the same resources sorted into dependency order.
     */
    private static sortResources(resources: ResourceDefinition[]): ResourceDefinition[] {
        const order = { 'ENUM': 1, 'SEQUENCE': 2, 'FUNCTION': 3, 'PROCEDURE': 3, 'TABLE': 4, 'VIEW': 5, 'MATERIALIZED_VIEW': 6 };
        return [...resources].sort((a, b) => (order[a.type] || 99) - (order[b.type] || 99));
    }

    /**
     * Dispatches a single resource to its type-specific diff routine, pushing
     * any resulting diff onto the shared `diffs` accumulator. Now passes engine
     * capabilities to each diff method.
     * @param client Open Postgres client/pool used for catalog introspection.
     * @param schemaName Physical (tenant-qualified) schema name.
     * @param shortSchemaName Logical (manifest) schema name, used in diff entries for readability.
     * @param resource The resource definition to diff.
     * @param diffs Shared accumulator array that diffs are pushed onto.
     * @param targetSource Data source this resource is provisioned against.
     * @param engineType Resolved engine type for the target source.
     * @param caps Engine capability descriptor.
     */
    private static async processResourceDiff(client: any, schemaName: string, shortSchemaName: string, resource: ResourceDefinition, diffs: any[], targetSource: string, engineType: EngineType, caps: EngineCapability) {
        switch (resource.type) {
            case 'ENUM':
                await this.diffEnum(client, schemaName, shortSchemaName, resource, diffs, targetSource, engineType, caps);
                break;
            case 'SEQUENCE':
                await this.diffSequence(client, schemaName, shortSchemaName, resource, diffs, targetSource, engineType, caps);
                break;
            case 'TABLE':
                await this.diffTable(client, schemaName, shortSchemaName, resource, diffs, targetSource, engineType, caps);
                break;
            case 'VIEW':
            case 'MATERIALIZED_VIEW':
                await this.diffView(client, schemaName, shortSchemaName, resource, diffs, targetSource, engineType, caps);
                break;
            case 'FUNCTION':
            case 'PROCEDURE':
                await this.diffFunction(client, schemaName, shortSchemaName, resource, diffs, targetSource, engineType, caps);
                break;
        }
    }

    /**
     * Diffs a declared ENUM against the target engine.
     * - Engines with native enum support (Postgres): checks `pg_type`, emits `CREATE_ENUM` if missing.
     * - Engines without enum support (MySQL, Oracle, Mongo, ES): emits `REGISTER_FABRIC_ENUM`
     *   to record allowed values in the fabric catalog for application-level validation.
     */
    private static async diffEnum(client: any, schemaName: string, shortSchemaName: string, res: EnumDefinition, diffs: any[], targetSource: string, engineType: EngineType, caps: EngineCapability) {
        if (caps.supportsEnums) {
            // Native enum support (Postgres) — check catalog before creating
            const exists = await client.query(`SELECT 1 FROM pg_type t JOIN pg_namespace n ON n.oid = t.typnamespace WHERE n.nspname = $1 AND t.typname = $2`, [schemaName, res.name]);
            if (exists.rows.length === 0) {
                diffs.push({ action: 'CREATE_ENUM', schema: shortSchemaName, targetSource, engineType, ...res, risk: 'LOW' });
            }
        } else {
            // No native enum: register in fabric catalog for application-level validation
            diffs.push({ action: 'REGISTER_FABRIC_ENUM', schema: shortSchemaName, targetSource, engineType, ...res, risk: 'LOW' });
        }
    }

    /**
     * Diffs a declared SEQUENCE against the target engine.
     * - Engines with native sequence support (Postgres, Oracle, Snowflake): checks catalog, emits `CREATE_SEQUENCE`.
     * - Engines without (MySQL, Mongo, ES): emits `REGISTER_FABRIC_SEQUENCE` so
     *   `FabricSequenceService` provides the sequence at write-time.
     */
    private static async diffSequence(client: any, schemaName: string, shortSchemaName: string, res: SequenceDefinition, diffs: any[], targetSource: string, engineType: EngineType, caps: EngineCapability) {
        if (caps.supportsSequences) {
            // Native sequence support — check catalog before creating
            if (caps.catalogIntrospection) {
                const exists = await client.query(`SELECT 1 FROM information_schema.sequences WHERE sequence_schema = $1 AND sequence_name = $2`, [schemaName, res.name]);
                if (exists.rows.length === 0) {
                    diffs.push({ action: 'CREATE_SEQUENCE', schema: shortSchemaName, targetSource, engineType, ...res, risk: 'LOW' });
                }
            } else {
                // Engine supports sequences but no introspection — emit CREATE (idempotent)
                diffs.push({ action: 'CREATE_SEQUENCE', schema: shortSchemaName, targetSource, engineType, ...res, risk: 'LOW' });
            }
        } else {
            // No native sequences: register in FabricSequenceService for write-time compensation
            diffs.push({ action: 'REGISTER_FABRIC_SEQUENCE', schema: shortSchemaName, targetSource, engineType, ...res, risk: 'LOW' });
        }
    }

    /**
     * Diffs a declared TABLE against the target engine.
     * - Engines with catalog introspection (Postgres, MySQL, Oracle): checks if table exists,
     *   emits `CREATE_TABLE` or `ADD_COLUMN` as needed.
     * - Engines without introspection (Mongo, ES): always emits `CREATE_TABLE`
     *   (transpiler converts to createCollection / index template as appropriate).
     */
    private static async diffTable(client: any, schemaName: string, shortSchemaName: string, res: TableDefinition, diffs: any[], targetSource: string, engineType: EngineType, caps: EngineCapability) {
        if (caps.catalogIntrospection) {
            const exists = await client.query(`SELECT 1 FROM information_schema.tables WHERE table_schema = $1 AND table_name = $2 AND table_type = 'BASE TABLE'`, [schemaName, res.name]);
            if (exists.rows.length === 0) {
                diffs.push({ action: 'CREATE_TABLE', schema: shortSchemaName, targetSource, engineType, table: res.name, ...res, risk: 'LOW' });
            } else {
                for (const col of res.columns) {
                    const colExists = await client.query(`SELECT data_type FROM information_schema.columns WHERE table_schema = $1 AND table_name = $2 AND column_name = $3`, [schemaName, res.name, col.name]);
                    if (colExists.rows.length === 0) {
                        diffs.push({ action: 'ADD_COLUMN', schema: shortSchemaName, targetSource, engineType, table: res.name, column: col, risk: 'LOW' });
                    }
                }
            }
        } else {
            // No catalog introspection (Mongo, ES): assume creation needed
            diffs.push({ action: 'CREATE_TABLE', schema: shortSchemaName, targetSource, engineType, table: res.name, ...res, risk: 'LOW' });
        }
    }

    /**
     * Diffs a declared VIEW/MATERIALIZED_VIEW against the target engine.
     * - Engines with native view support (Postgres, MySQL, Oracle, Snowflake): checks catalog, emits CREATE_VIEW.
     * - Engines without (Mongo, ES): registers as a virtual/federated view in the Fabric query engine.
     */
    private static async diffView(client: any, schemaName: string, shortSchemaName: string, res: ViewDefinition, diffs: any[], targetSource: string, engineType: EngineType, caps: EngineCapability) {
        const isMaterialized = res.type === 'MATERIALIZED_VIEW' || res.materialized;

        if (isMaterialized && !caps.supportsMaterializedViews) {
            // Downgrade: engine doesn't support mviews — register as virtual in fabric
            diffs.push({ action: 'REGISTER_VIRTUAL_VIEW', schema: shortSchemaName, targetSource, engineType, ...res, risk: 'LOW' });
            return;
        }

        if (!caps.supportsViews) {
            // Engine doesn't support views at all — register as virtual in fabric engine
            diffs.push({ action: 'REGISTER_VIRTUAL_VIEW', schema: shortSchemaName, targetSource, engineType, ...res, risk: 'LOW' });
            return;
        }

        // Engine supports views natively — check catalog if possible
        if (caps.catalogIntrospection) {
            const exists = await client.query(`SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = $1 AND c.relname = $2 AND c.relkind IN ('v', 'm')`, [schemaName, res.name]);
            if (exists.rows.length === 0) {
                const action = isMaterialized ? 'CREATE_MATERIALIZED_VIEW' : 'CREATE_VIEW';
                diffs.push({ action, schema: shortSchemaName, targetSource, engineType, ...res, risk: 'LOW' });
            }
        } else {
            // Supports views but no introspection — emit CREATE (idempotent via OR REPLACE)
            const action = isMaterialized ? 'CREATE_MATERIALIZED_VIEW' : 'CREATE_VIEW';
            diffs.push({ action, schema: shortSchemaName, targetSource, engineType, ...res, risk: 'LOW' });
        }
    }

    /**
     * Diffs a declared FUNCTION/PROCEDURE against the target engine.
     * - Engines with native function support (Postgres, MySQL, Oracle, Snowflake): checks catalog, emits CREATE_FUNCTION.
     * - Engines without (Mongo, ES): provisions the function on the **hub Postgres** and
     *   registers it as a callable value-service via `REGISTER_HUB_FUNCTION`.
     */
    private static async diffFunction(client: any, schemaName: string, shortSchemaName: string, res: FunctionDefinition, diffs: any[], targetSource: string, engineType: EngineType, caps: EngineCapability) {
        if (caps.supportsFunctions) {
            // Native function support — check catalog before creating
            if (caps.catalogIntrospection) {
                const exists = await client.query(`SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace WHERE n.nspname = $1 AND p.proname = $2`, [schemaName, res.name]);
                if (exists.rows.length === 0) {
                    const action = res.type === 'PROCEDURE' ? 'CREATE_PROCEDURE' : 'CREATE_FUNCTION';
                    diffs.push({ action, schema: shortSchemaName, targetSource, engineType, ...res, risk: 'LOW' });
                }
            } else {
                // Supports functions but no pg_proc introspection — emit CREATE (idempotent via OR REPLACE)
                const action = res.type === 'PROCEDURE' ? 'CREATE_PROCEDURE' : 'CREATE_FUNCTION';
                diffs.push({ action, schema: shortSchemaName, targetSource, engineType, ...res, risk: 'LOW' });
            }
        } else {
            // No native function support: provision on the HUB and register as a value-service
            diffs.push({ action: 'REGISTER_HUB_FUNCTION', schema: shortSchemaName, targetSource, engineType, ...res, risk: 'LOW' });
        }
    }

    /**
     * Detects tables that physically exist in the schema but are no longer
     * declared in the manifest, and flags each for quarantine rather than
     * silent/destructive drop. Only runs on engines that support catalog introspection.
     */
    private static async detectRetiredResources(client: any, schemaName: string, schema: SchemaDefinition, diffs: any[], targetSource: string, engineType: EngineType, caps: EngineCapability) {
        if (!schema.resources || !caps.catalogIntrospection) return;

        const { rows: liveTables } = await client.query(`SELECT table_name FROM information_schema.tables WHERE table_schema = $1 AND table_type = 'BASE TABLE'`, [schemaName]);
        const astTableNames = schema.resources.filter(r => r.type === 'TABLE').map(r => r.name);

        for (const live of liveTables) {
            if (!astTableNames.includes(live.table_name) && !live.table_name.startsWith('__deleted')) {
                diffs.push({ action: 'QUARANTINE_TABLE', schema: schema.name, targetSource, engineType, table: live.table_name, risk: 'HIGH' });
            }
        }
    }
}
