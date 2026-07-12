/**
 * Manifest diff engine.
 * ---------------------
 * Compares a `MetadataManifest` against the live Postgres catalog (and, for
 * heterogeneous targets, assumes provisioning is required since no live
 * introspection connector is consulted here) to compute the ordered list of
 * changes (`diffs`) needed to reconcile reality with the declared manifest:
 * schema/enum/sequence/table/column/view/function creation, relationship and
 * extension provisioning, downstream target sync, and quarantine of tables
 * that exist physically but are no longer declared in the manifest.
 *
 * Each diff entry is a plain object carrying at minimum `{ action, risk }`
 * plus action-specific fields; `Transpiler.toSql`/`toMongo` later compiles
 * these diffs into engine-native DDL/operations, and `MetadataOrchestrator`
 * decides whether high-risk diffs require an explicit `force` to apply.
 */
import { pool } from '../../config/database';
import { MetadataManifest, SchemaDefinition, ResourceDefinition, EnumDefinition, SequenceDefinition, TableDefinition, ViewDefinition, FunctionDefinition } from './types';

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
     * @param tenantId Tenant scope; physical schema names are derived as `tenant_{tenantId}_{schema.name}`.
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
                
                // 1. Schema Check
                if (targetSource === 'Fabric_Hub_Postgres') {
                    const schemaExists = await client.query(`SELECT 1 FROM information_schema.schemata WHERE schema_name = $1`, [schemaName]);
                    if (schemaExists.rows.length === 0) {
                        diffs.push({ action: 'CREATE_SCHEMA', name: schema.name, targetSource, risk: 'LOW' });
                    }
                } else {
                    // For heterogeneous sources, we'll emit CREATE_SCHEMA but it might be a no-op depending on engine
                    diffs.push({ action: 'CREATE_SCHEMA', name: schema.name, targetSource, risk: 'LOW' });
                }

                // 2. Sort Resources by Dependency (DAG)
                const sortedResources = this.sortResources(schema.resources || []);

                for (const resource of sortedResources) {
                    await this.processResourceDiff(client, schemaName, schema.name, resource, diffs, targetSource);
                }

                // 4. Logical Deletion / Quarantine
                await this.detectRetiredResources(client, schemaName, schema, diffs, targetSource);
            }

            // 3. Relationship Check - OUTSIDE schema loop
            if (manifest.relationships) {
                for (const rel of manifest.relationships) {
                    // Find which schema to use (default to first if not specified)
                    const schema = manifest.schemas?.[0]?.name || 'public';
                    diffs.push({ action: 'PROVISION_RELATIONSHIP', schema, ...rel });
                }
            }

            // 4. Extension Check
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
     * any resulting diff onto the shared `diffs` accumulator.
     * @param client Open Postgres client/pool used for catalog introspection.
     * @param schemaName Physical (tenant-qualified) schema name.
     * @param shortSchemaName Logical (manifest) schema name, used in diff entries for readability.
     * @param resource The resource definition to diff.
     * @param diffs Shared accumulator array that diffs are pushed onto.
     * @param targetSource Data source this resource is provisioned against.
     */
    private static async processResourceDiff(client: any, schemaName: string, shortSchemaName: string, resource: ResourceDefinition, diffs: any[], targetSource: string) {
        switch (resource.type) {
            case 'ENUM':
                await this.diffEnum(client, schemaName, shortSchemaName, resource, diffs, targetSource);
                break;
            case 'SEQUENCE':
                await this.diffSequence(client, schemaName, shortSchemaName, resource, diffs, targetSource);
                break;
            case 'TABLE':
                await this.diffTable(client, schemaName, shortSchemaName, resource, diffs, targetSource);
                break;
            case 'VIEW':
            case 'MATERIALIZED_VIEW':
                await this.diffView(client, schemaName, shortSchemaName, resource, diffs, targetSource);
                break;
            case 'FUNCTION':
            case 'PROCEDURE':
                await this.diffFunction(client, schemaName, shortSchemaName, resource, diffs, targetSource);
                break;
        }
    }

    /**
     * Diffs a declared ENUM against `pg_type`; emits `CREATE_ENUM` if missing.
     * No-ops for non-Postgres targets, since enum types are Postgres-specific.
     * @param client Open Postgres client/pool used for catalog introspection.
     * @param schemaName Physical (tenant-qualified) schema name.
     * @param shortSchemaName Logical (manifest) schema name included in the diff entry.
     * @param res The enum definition to check for.
     * @param diffs Shared accumulator array that a `CREATE_ENUM` diff is pushed onto when needed.
     * @param targetSource Data source this enum is provisioned against.
     */
    private static async diffEnum(client: any, schemaName: string, shortSchemaName: string, res: EnumDefinition, diffs: any[], targetSource: string) {
        if (targetSource !== 'Fabric_Hub_Postgres') return; // Enums are Postgres-specific in this spec
        const exists = await client.query(`SELECT 1 FROM pg_type t JOIN pg_namespace n ON n.oid = t.typnamespace WHERE n.nspname = $1 AND t.typname = $2`, [schemaName, res.name]);
        if (exists.rows.length === 0) {
            diffs.push({ action: 'CREATE_ENUM', schema: shortSchemaName, targetSource, ...res, risk: 'LOW' });
        }
    }

    /**
     * Diffs a declared SEQUENCE against `information_schema.sequences`; emits
     * `CREATE_SEQUENCE` if missing. No-ops for non-Postgres targets.
     * @param client Open Postgres client/pool used for catalog introspection.
     * @param schemaName Physical (tenant-qualified) schema name.
     * @param shortSchemaName Logical (manifest) schema name included in the diff entry.
     * @param res The sequence definition to check for.
     * @param diffs Shared accumulator array that a `CREATE_SEQUENCE` diff is pushed onto when needed.
     * @param targetSource Data source this sequence is provisioned against.
     */
    private static async diffSequence(client: any, schemaName: string, shortSchemaName: string, res: SequenceDefinition, diffs: any[], targetSource: string) {
        if (targetSource !== 'Fabric_Hub_Postgres') return;
        const exists = await client.query(`SELECT 1 FROM information_schema.sequences WHERE sequence_schema = $1 AND sequence_name = $2`, [schemaName, res.name]);
        if (exists.rows.length === 0) {
            diffs.push({ action: 'CREATE_SEQUENCE', schema: shortSchemaName, targetSource, ...res, risk: 'LOW' });
        }
    }

    /**
     * Diffs a declared TABLE against `information_schema.tables`/`columns`.
     * Emits `CREATE_TABLE` if the table doesn't exist on the Hub; otherwise
     * checks each declared column and emits `ADD_COLUMN` for any missing one.
     * For non-Hub (heterogeneous) targets, always emits `CREATE_TABLE` since
     * no live introspection connector is consulted here.
     * @param client Open Postgres client/pool used for catalog introspection.
     * @param schemaName Physical (tenant-qualified) schema name.
     * @param shortSchemaName Logical (manifest) schema name included in the diff entry.
     * @param res The table definition to check for.
     * @param diffs Shared accumulator array that `CREATE_TABLE`/`ADD_COLUMN` diffs are pushed onto.
     * @param targetSource Data source this table is provisioned against.
     */
    private static async diffTable(client: any, schemaName: string, shortSchemaName: string, res: TableDefinition, diffs: any[], targetSource: string) {
        if (targetSource === 'Fabric_Hub_Postgres') {
            const exists = await client.query(`SELECT 1 FROM information_schema.tables WHERE table_schema = $1 AND table_name = $2 AND table_type = 'BASE TABLE'`, [schemaName, res.name]);
            if (exists.rows.length === 0) {
                diffs.push({ action: 'CREATE_TABLE', schema: shortSchemaName, targetSource, ...res, risk: 'LOW' });
            } else {
                for (const col of res.columns) {
                    const colExists = await client.query(`SELECT data_type FROM information_schema.columns WHERE table_schema = $1 AND table_name = $2 AND column_name = $3`, [schemaName, res.name, col.name]);
                    if (colExists.rows.length === 0) {
                        diffs.push({ action: 'ADD_COLUMN', schema: shortSchemaName, targetSource, table: res.name, column: col, risk: 'LOW' });
                    }
                }
            }
        } else {
            // For Heterogeneous sources, we assume creation if we don't have a connector to check yet
            // But let's at least pass the targetSource
            diffs.push({ action: 'CREATE_TABLE', schema: shortSchemaName, targetSource, ...res, risk: 'LOW' });
        }
    }

    /**
     * Diffs a declared VIEW/MATERIALIZED_VIEW against `pg_class`; emits
     * `CREATE_VIEW` or `CREATE_MATERIALIZED_VIEW` if missing. No-ops for
     * non-Postgres targets.
     * @param client Open Postgres client/pool used for catalog introspection.
     * @param schemaName Physical (tenant-qualified) schema name.
     * @param shortSchemaName Logical (manifest) schema name included in the diff entry.
     * @param res The view/materialized-view definition to check for.
     * @param diffs Shared accumulator array that the create-view diff is pushed onto when needed.
     * @param targetSource Data source this view is provisioned against.
     */
    private static async diffView(client: any, schemaName: string, shortSchemaName: string, res: ViewDefinition, diffs: any[], targetSource: string) {
        if (targetSource !== 'Fabric_Hub_Postgres') return;
        const exists = await client.query(`SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = $1 AND c.relname = $2 AND c.relkind IN ('v', 'm')`, [schemaName, res.name]);
        if (exists.rows.length === 0) {
            const action = res.type === 'MATERIALIZED_VIEW' ? 'CREATE_MATERIALIZED_VIEW' : 'CREATE_VIEW';
            diffs.push({ action, schema: shortSchemaName, targetSource, ...res, risk: 'LOW' });
        }
    }

    /**
     * Diffs a declared FUNCTION/PROCEDURE against `pg_proc`; emits
     * `CREATE_FUNCTION` or `CREATE_PROCEDURE` if missing. No-ops for
     * non-Postgres targets.
     * @param client Open Postgres client/pool used for catalog introspection.
     * @param schemaName Physical (tenant-qualified) schema name.
     * @param shortSchemaName Logical (manifest) schema name included in the diff entry.
     * @param res The function/procedure definition to check for.
     * @param diffs Shared accumulator array that the create diff is pushed onto when needed.
     * @param targetSource Data source this function/procedure is provisioned against.
     */
    private static async diffFunction(client: any, schemaName: string, shortSchemaName: string, res: FunctionDefinition, diffs: any[], targetSource: string) {
        if (targetSource !== 'Fabric_Hub_Postgres') return;
        const exists = await client.query(`SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace WHERE n.nspname = $1 AND p.proname = $2`, [schemaName, res.name]);
        if (exists.rows.length === 0) {
            const action = res.type === 'PROCEDURE' ? 'CREATE_PROCEDURE' : 'CREATE_FUNCTION';
            diffs.push({ action, schema: shortSchemaName, targetSource, ...res, risk: 'LOW' });
        }
    }

    /**
     * Detects tables that physically exist in the schema but are no longer
     * declared in the manifest, and flags each for quarantine rather than
     * silent/destructive drop. Skips tables already renamed to the
     * `__deleted...` quarantine convention. No-ops for non-Postgres targets.
     * @param client Open Postgres client/pool used for catalog introspection.
     * @param schemaName Physical (tenant-qualified) schema name to scan.
     * @param schema The manifest schema definition whose declared table names form the "still wanted" set.
     * @param diffs Shared accumulator array that `QUARANTINE_TABLE` (risk: HIGH) diffs are pushed onto.
     * @param targetSource Data source this schema is provisioned against.
     */
    private static async detectRetiredResources(client: any, schemaName: string, schema: SchemaDefinition, diffs: any[], targetSource: string) {
        if (!schema.resources || targetSource !== 'Fabric_Hub_Postgres') return;
        
        const { rows: liveTables } = await client.query(`SELECT table_name FROM information_schema.tables WHERE table_schema = $1 AND table_type = 'BASE TABLE'`, [schemaName]);
        const astTableNames = schema.resources.filter(r => r.type === 'TABLE').map(r => r.name);
        
        for (const live of liveTables) {
            if (!astTableNames.includes(live.table_name) && !live.table_name.startsWith('__deleted')) {
                diffs.push({ action: 'QUARANTINE_TABLE', schema: schema.name, targetSource, table: live.table_name, risk: 'HIGH' });
            }
        }
    }
}
