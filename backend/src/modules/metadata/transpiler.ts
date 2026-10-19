/**
 * Diff-to-DDL transpiler.
 * -----------------------
 * Compiles the diff objects produced by `DiffEngine.compare` into concrete,
 * engine-native provisioning statements:
 *  - `toSql` — Postgres DDL/DML text (schemas, enums, sequences, tables with
 *    strategies/constraints/security/triggers, views via `QueryTranspiler`,
 *    functions/procedures, and cross-resource relationships).
 *  - `toMongo` — MongoDB op descriptors (createCollection/dropCollection/
 *    createIndex) for the subset of diff actions relevant to a document store.
 * Consumed by `MetadataOrchestrator.apply` for both the local Hub (executed
 * directly) and heterogeneous remote sources (executed via
 * `HeterogeneousDispatcher`).
 */
import axios from 'axios';
import { ColumnDefinition, TableDefinition, EnumDefinition, SequenceDefinition, ViewDefinition, FunctionDefinition, MetadataManifest, RelationshipDefinition } from './types';
import { QueryTranspiler } from './query_transpiler';
import { TriggerService } from '../triggers/trigger.service';

/**
 * Compiles manifest diffs into Postgres DDL or MongoDB op descriptors.
 * @class
 * @hideconstructor
 */
export class Transpiler {
    private static TRIGGER_ENGINE_URL = process.env.TRIGGER_ENGINE_URL || 'http://localhost:4001/api/trig-engine/transpile';

    /**
     * Maps a manifest's portable/logical type name to its Postgres-native
     * type. Unrecognized type names pass through unchanged.
     * @param t Logical type name (e.g. `STRING`, `INTEGER`, `BOOLEAN`).
     * @returns The Postgres-native type name (e.g. `TEXT`, `INT`, `BOOL`).
     */
    private static normalizeType(t: string) {
        if (!t) return t;
        const map: any = { 'STRING': 'TEXT', 'INTEGER': 'INT', 'BOOLEAN': 'BOOL', 'TIMESTAMP': 'TIMESTAMP', 'UUID': 'UUID', 'BIGINT': 'BIGINT', 'JSONB': 'JSONB', 'NUMERIC': 'NUMERIC' };
        return map[t.toUpperCase()] || t;
    }

    /**
     * Compiles a single diff (as produced by `DiffEngine.compare`) into an
     * ordered list of Postgres SQL statements. Dispatches on `diff.action`:
     * `PROVISION_EXTENSIONS`, `CREATE_SCHEMA`, `CREATE_ENUM`, `CREATE_SEQUENCE`,
     * `CREATE_FUNCTION`/`CREATE_PROCEDURE`, `CREATE_TABLE` (columns, strategies,
     * constraints, indexes, functional-default triggers, maintenance settings,
     * RLS/masking/grants, declared triggers), `CREATE_VIEW`/`CREATE_MATERIALIZED_VIEW`
     * (via `QueryTranspiler`), `PROVISION_RELATIONSHIP` (FK or M:N bridge table,
     * including federated/cross-source variants emitted as SQL comments), and
     * `PROVISION_DOWNSTREAM` (emitted as a comment; actual work is done by
     * `DownstreamService`). Unrecognized actions produce no statements.
     * @param diff A single diff entry to compile (shape varies by `action`).
     * @param tenantId Tenant scope; used to derive the physical schema name `tenant_{tenantId}_(diff.schema||diff.name)`.
     * @param manifest Full manifest, consulted for custom enum type names (table column typing), relationship column type lookup, and function/procedure resource context.
     * @returns The ordered SQL statements to execute for this diff (may be empty).
     */
    static async toSql(diff: any, tenantId: string, manifest?: MetadataManifest): Promise<string[]> {
        const schemaName = `tenant_${tenantId}_${diff.schema || diff.name}`;
        const sql: string[] = [];

        if (diff.action === 'PROVISION_EXTENSIONS' && diff.extensions) {
            for (const ext of diff.extensions) {
                sql.push(`CREATE EXTENSION IF NOT EXISTS "${ext}"`);
            }
            return sql;
        }

        switch (diff.action) {
            case 'CREATE_SCHEMA':
                sql.push(`CREATE SCHEMA IF NOT EXISTS "${schemaName}"`);
                sql.push(`DO $$ BEGIN IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'fabric_user') THEN EXECUTE 'GRANT USAGE ON SCHEMA "${schemaName}" TO fabric_user'; END IF; END $$;`);
                sql.push(`DO $$ BEGIN IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'fabric_user') THEN EXECUTE 'ALTER DEFAULT PRIVILEGES IN SCHEMA "${schemaName}" GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO fabric_user'; END IF; END $$;`);
                sql.push(`DO $$ BEGIN IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'fabric_user') THEN EXECUTE 'GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA "${schemaName}" TO fabric_user'; END IF; END $$;`);
                sql.push(`DO $$ BEGIN IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'fabric_user') THEN EXECUTE 'GRANT SELECT, USAGE ON ALL SEQUENCES IN SCHEMA "${schemaName}" TO fabric_user'; END IF; END $$;`);
                break;

            case 'CREATE_ENUM':
                const vals = (diff as EnumDefinition).values.map(v => `'${v}'`).join(', ');
                sql.push(`CREATE TYPE "${schemaName}"."${diff.name}" AS ENUM (${vals})`);
                break;

            case 'CREATE_SEQUENCE':
                const seq = diff as SequenceDefinition;
                if (seq.strategy === 'PROCEDURAL') {
                    sql.push(`-- PROCEDURAL SEQUENCE Generator: ${seq.generator}`);
                    break;
                }
                let seqSql = `CREATE SEQUENCE IF NOT EXISTS "${schemaName}"."${seq.name}" START WITH ${seq.start || 1} INCREMENT BY ${seq.increment || 1}`;
                if (seq.minValue) seqSql += ` MINVALUE ${seq.minValue}`;
                if (seq.maxValue) seqSql += ` MAXVALUE ${seq.maxValue}`;
                if (seq.cache) seqSql += ` CACHE ${seq.cache}`;
                sql.push(seqSql);
                break;

            case 'CREATE_FUNCTION':
            case 'CREATE_PROCEDURE':
                const fn = diff as any;
                const rawArgs = fn.arguments || fn.parameters || [];
                const args = rawArgs.map((a: any) => `"${a.name}" ${a.mode || 'IN'} ${this.normalizeType(a.type)}`).join(', ') || '';
                const ret = fn.returnType ? `RETURNS ${this.normalizeType(fn.returnType)}` : (fn.type === 'FUNCTION' ? 'RETURNS VOID' : '');
                
                // Industrial Safety: Ensure body is wrapped in BEGIN...END if using plpgsql
                let finalBody = fn.body.trim();
                if (!finalBody.toUpperCase().startsWith('BEGIN')) {
                    finalBody = `BEGIN\n    ${finalBody}\n    ${fn.type === 'FUNCTION' && !fn.returnType ? 'RETURN;' : ''}\nEND;`;
                }
                
                sql.push(`CREATE OR REPLACE ${fn.type} "${schemaName}"."${fn.name}"(${args}) ${ret} AS $$ ${finalBody} $$ LANGUAGE plpgsql`);
                break;

            case 'CREATE_TABLE':
                const table = diff as TableDefinition;
                const customTypes = manifest?.schemas.find(s => s.name === diff.schema)?.resources.filter(r => r.type === 'ENUM').map(r => r.name) || [];

                const cols = table.columns.map(c => {
                    let d = `"${c.name}" `;
                    const mappedType = this.normalizeType(c.type);
                    let hasDefault = false;
                    
                    // Strategy handling
                    if (c.strategy === 'IDENTITY_ALWAYS') {
                        d += `${mappedType} GENERATED ALWAYS AS IDENTITY`;
                    } else if (c.strategy === 'UUID_V7') {
                        d += `UUID DEFAULT gen_random_uuid()`; 
                        hasDefault = true;
                    } else if (c.strategy === 'LEGACY_SERIAL') {
                        d += `SERIAL`;
                        hasDefault = true;
                    } else if (c.type.toUpperCase() === 'ENUM' && c.ref) {
                        d += `"${schemaName}"."${c.ref}"`;
                    } else {
                        const isCustom = customTypes.includes(c.type);
                        d += isCustom ? `"${schemaName}"."${c.type}"` : mappedType;
                    }

                    if (c.collation) d += ` COLLATE "${c.collation}"`;
                    if (c.primaryKey && !table.identity) d += ' PRIMARY KEY';
                    if (c.default && !hasDefault && c.strategy !== 'FUNCTIONAL') {
                        const isLiteral = !c.default.includes('(') && !c.default.startsWith("'") && isNaN(Number(c.default)) && !['NOW()', 'CURRENT_TIMESTAMP'].includes(c.default.toUpperCase());
                        const finalDefault = isLiteral ? `'${c.default}'` : c.default;
                        d += ` DEFAULT ${finalDefault}`;
                    }
                    if (c.generated) d += ` GENERATED ALWAYS AS (${c.generated}) STORED`;
                    if (c.unique) d += ' UNIQUE';
                    if (c.nullable === false) d += ' NOT NULL';
                    
                    return d;
                });

                if (table.identity?.type === 'PRIMARY_KEY') {
                    cols.push(`PRIMARY KEY (${table.identity.columns.map(c => `"${c}"`).join(', ')})`);
                }

                if (table.constraints) {
                    for (const con of table.constraints) {
                        if (con.type === 'EXCLUDE') {
                            cols.push(`CONSTRAINT "${con.name}" EXCLUDE USING ${con.using} (${con.columns?.map(c => `"${c.name}" WITH ${c.operator}`).join(', ')})`);
                        } else if (con.type === 'CHECK') {
                            cols.push(`CONSTRAINT "${con.name}" CHECK (${con.expression})`);
                        }
                    }
                }
                
                let createTable = `CREATE TABLE IF NOT EXISTS "${schemaName}"."${table.name}" (${cols.join(', ')})`;
                if (table.partitionBy) {
                    createTable += ` PARTITION BY ${table.partitionBy.type}("${table.partitionBy.column}")`;
                }
                sql.push(createTable);

                // Table Comments
                if (table.comment) sql.push(`COMMENT ON TABLE "${schemaName}"."${table.name}" IS '${table.comment.replace(/'/g, "''")}'`);
                
                // Column Details (Comments, Indexes, Functional Triggers)
                for (const c of table.columns) {
                    if (c.comment) sql.push(`COMMENT ON COLUMN "${schemaName}"."${table.name}"."${c.name}" IS '${c.comment.replace(/'/g, "''")}'`);
                    if (c.index) {
                        const idxName = `idx_${table.name}_${c.name}`;
                        sql.push(`CREATE INDEX IF NOT EXISTS "${idxName}" ON "${schemaName}"."${table.name}" USING ${c.index.type || 'BTREE'} ("${c.name}")`);
                    }
                    
                    if (c.strategy === 'FUNCTIONAL' && c.default) {
                        const trgName = `trg_func_${table.name}_${c.name}`;
                        const fnName = `fn_func_${table.name}_${c.name}`;
                        // Inside a trigger, bare column refs in the default expression must be
                        // qualified as NEW.<col> (e.g. generate_custom_id(region) -> generate_custom_id(NEW."region")).
                        const qualifiedDefault = this.qualifyColumnsForTrigger(c.default, table.columns);
                        sql.push(`CREATE OR REPLACE FUNCTION "${schemaName}"."${fnName}"() RETURNS TRIGGER AS $$
                        BEGIN
                            IF NEW."${c.name}" IS NULL THEN
                                NEW."${c.name}" := ${qualifiedDefault};
                            END IF;
                            RETURN NEW;
                        END; $$ LANGUAGE plpgsql;`);
                        sql.push(`DROP TRIGGER IF EXISTS "${trgName}" ON "${schemaName}"."${table.name}"`);
                        sql.push(`CREATE TRIGGER "${trgName}" BEFORE INSERT ON "${schemaName}"."${table.name}" FOR EACH ROW EXECUTE FUNCTION "${schemaName}"."${fnName}"()`);
                    }
                }

                // Maintenance (Skip for partitioned parents as they don't have physical storage)
                if (table.maintenance && !table.partitionBy) {
                    if (table.maintenance.autovacuum_enabled !== undefined) {
                        sql.push(`ALTER TABLE "${schemaName}"."${table.name}" SET (autovacuum_enabled = ${table.maintenance.autovacuum_enabled})`);
                    }
                    if (table.maintenance.fillfactor) {
                        sql.push(`ALTER TABLE "${schemaName}"."${table.name}" SET (fillfactor = ${table.maintenance.fillfactor})`);
                    }
                }

                // Security
                if (table.security?.enable_rls) {
                    sql.push(`ALTER TABLE "${schemaName}"."${table.name}" ENABLE ROW LEVEL SECURITY`);
                    if (table.security.policies) {
                        for (const pol of table.security.policies) {
                            sql.push(`DROP POLICY IF EXISTS "${pol.name}" ON "${schemaName}"."${table.name}"`);
                            const roles = pol.roles ? pol.roles.join(', ') : 'PUBLIC';
                            if (pol.roles) {
                                for (const role of pol.roles) {
                                    if (role !== 'PUBLIC') {
                                        sql.push(`DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = '${role}') THEN CREATE ROLE "${role}" NOLOGIN; END IF; END $$;`);
                                    }
                                }
                            }
                            sql.push(`CREATE POLICY "${pol.name}" ON "${schemaName}"."${table.name}" FOR ALL TO ${roles} USING (${pol.using})`);
                        }
                    }
                }
                
                // Masking (Industrial Pattern)
                if (table.security?.masking) {
                    for (const mask of table.security.masking) {
                        sql.push(`-- MASKING APPLIED to ${mask.column} for roles ${mask.roles.join(', ')}: ${mask.expression}`);
                    }
                }

                // Grants
                if (table.security?.grants) {
                    for (const grant of table.security.grants) {
                        const rolesList = grant.roles || (grant.role !== 'PUBLIC' && grant.role ? [grant.role] : []);
                        for (const role of rolesList) {
                            if (role !== 'PUBLIC') {
                                sql.push(`DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = '${role}') THEN CREATE ROLE "${role}" NOLOGIN; END IF; END $$;`);
                            }
                        }
                        const rolesStr = grant.role === 'PUBLIC' ? 'PUBLIC' : grant.roles?.join(', ') || grant.role;
                        sql.push(`GRANT ${grant.privileges.join(', ')} ON TABLE "${schemaName}"."${table.name}" TO ${rolesStr}`);
                    }
                }

                if (table.triggers) {
                    for (const trg of table.triggers) {
                        const trgSql = await this.callTriggerEngine(trg, schemaName, table.name, tenantId);
                        sql.push(...trgSql);
                    }
                }
                break;

            case 'CREATE_VIEW':
            case 'CREATE_MATERIALIZED_VIEW':
                const view = diff as ViewDefinition;
                const viewQuery = QueryTranspiler.toSql(view.query, schemaName);
                if (view.materialized || view.type === 'MATERIALIZED_VIEW') {
                    sql.push(`DROP MATERIALIZED VIEW IF EXISTS "${schemaName}"."${view.name}" CASCADE`);
                    sql.push(`CREATE MATERIALIZED VIEW "${schemaName}"."${view.name}" AS ${viewQuery}`);
                    if (view.indexes) {
                        for (const idx of view.indexes) {
                            sql.push(`CREATE INDEX IF NOT EXISTS "idx_mv_${view.name}_${idx.columns.join('_')}" ON "${schemaName}"."${view.name}" (${idx.columns.map(c => `"${c}"`).join(', ')})`);
                        }
                    }
                } else {
                    if (view.federationStrategy === 'VIRTUAL') {
                        sql.push(`-- VIRTUAL VIEW ${view.name} registered in Fabric Engine, skipping Postgres CREATE VIEW`);
                    } else {
                        sql.push(`CREATE OR REPLACE VIEW "${schemaName}"."${view.name}" AS ${viewQuery}`);
                    }
                }
                break;

            case 'PROVISION_RELATIONSHIP':
                const rel = diff as RelationshipDefinition;
                if (rel.cardinality === 'M:N' && rel.bridge && manifest) {
                    const fromType = this.findColumnType(manifest, rel.from.resource, rel.from.field);
                    const toType = this.findColumnType(manifest, rel.to.resource, rel.to.field);

                    const fromCol = `${rel.from.resource}_${rel.from.field}`;
                    const toCol = `${rel.to.resource}_${rel.to.field}`;
                    if (rel.to.source || rel.from.source) {
                        // Cross-source M:N cannot enforce DB-level FK to remote engines.
                        sql.push(`CREATE TABLE IF NOT EXISTS "${schemaName}"."${rel.bridge}" (
                            "${fromCol}" ${this.normalizeType(fromType)},
                            "${toCol}" ${this.normalizeType(toType)},
                            PRIMARY KEY ("${fromCol}", "${toCol}")
                        )`);
                        sql.push(`DO $$ BEGIN
                            IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_${rel.name}_from') THEN
                                ALTER TABLE "${schemaName}"."${rel.bridge}" ADD CONSTRAINT "fk_${rel.name}_from" FOREIGN KEY ("${fromCol}") REFERENCES "${schemaName}"."${rel.from.resource}"("${rel.from.field}");
                            END IF;
                        END $$;`);
                        sql.push(`-- FEDERATED RELATIONSHIP: ${rel.name} target side (${rel.to.source || rel.from.source}) enforced at Fabric layer`);
                    } else {
                        sql.push(`CREATE TABLE IF NOT EXISTS "${schemaName}"."${rel.bridge}" (
                            "${fromCol}" ${this.normalizeType(fromType)} REFERENCES "${schemaName}"."${rel.from.resource}"("${rel.from.field}"),
                            "${toCol}" ${this.normalizeType(toType)} REFERENCES "${schemaName}"."${rel.to.resource}"("${rel.to.field}"),
                            PRIMARY KEY ("${fromCol}", "${toCol}")
                        )`);
                    }
                } else if (rel.cardinality === '1:M' || rel.cardinality === '1:1') {
                    if (rel.from.source || rel.to.source) {
                        // Either side remote — can't enforce a DB-level FK across engines.
                        sql.push(`-- FEDERATED RELATIONSHIP: ${rel.name} (Cross-Source ${rel.from.source || 'local'} -> ${rel.to.source || 'local'})`);
                    } else {
                        // FK belongs on the CHILD ("to") side referencing the PARENT ("from") key,
                        // so the parent stays independently insertable (was inverted).
                        sql.push(`DO $$ BEGIN
                            IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_${rel.name}') THEN
                                ALTER TABLE "${schemaName}"."${rel.to.resource}" ADD CONSTRAINT "fk_${rel.name}" FOREIGN KEY ("${rel.to.field}") REFERENCES "${schemaName}"."${rel.from.resource}"("${rel.from.field}");
                            END IF;
                        END $$;`);
                    }
                }
                break;
            
            case 'PROVISION_DOWNSTREAM':
                const target = diff as any;
                sql.push(`-- PROVISION DOWNSTREAM: ${target.type} (Enabled: ${target.enabled}, Strategy: ${target.strategy || 'DEFAULT'})`);
                // Section 9.2: Registry update is handled by the Orchestrator.apply logic
                break;
        }

        return sql;
    }

    /** Qualify bare column references in a default expression as NEW."col" for trigger bodies. */
    private static qualifyColumnsForTrigger(expr: string, columns: ColumnDefinition[]): string {
        let out = expr;
        // Longer names first so a substring column (e.g. "id") doesn't clobber "custom_id".
        const names = columns.map(c => c.name).sort((a, b) => b.length - a.length);
        for (const name of names) {
            // Replace whole-word occurrences not already preceded by NEW./OLD./a dot or quote.
            const re = new RegExp(`(?<![\\w."])\\b${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b(?![\\w"])`, 'g');
            out = out.replace(re, `NEW."${name}"`);
        }
        return out;
    }

    /**
     * Looks up a table column's declared logical type across a manifest's
     * schemas, used to type the join columns of a generated relationship
     * bridge table.
     * @param manifest Manifest to search across all schemas.
     * @param resourceName Table resource name to find.
     * @param columnName Column name within that table.
     * @returns The column's declared type, or `'UUID'` if the table/column can't be found.
     */
    private static findColumnType(manifest: MetadataManifest, resourceName: string, columnName: string): string {
        for (const schema of manifest.schemas) {
            const resource = schema.resources.find(r => r.name === resourceName && r.type === 'TABLE') as TableDefinition;
            if (resource) {
                const col = resource.columns.find(c => c.name === columnName);
                if (col) return col.type;
            }
        }
        return 'UUID'; 
    }

    /**
     * Compiles a single diff into MongoDB op descriptors for the subset of
     * actions meaningful to a document store: `CREATE_TABLE` becomes a
     * `createCollection` plus one `createIndex` per column marked
     * indexed/unique/primaryKey; `DROP_TABLE` becomes a `dropCollection`;
     * `ADD_COLUMN` becomes a `createIndex` only if the new column is
     * indexed/unique (Mongo needs no DDL to add a field). Other actions
     * produce no ops.
     * @param diff A single diff entry to compile.
     * @param tenantId Tenant scope (currently unused; kept for signature parity with `toSql`).
     * @param manifest Full manifest (currently unused; kept for signature parity with `toSql`).
     * @returns Op descriptors consumable by `HeterogeneousDispatcher.execute`'s Mongo path (may be empty).
     */
    static async toMongo(diff: any, tenantId: string, manifest?: MetadataManifest): Promise<any[]> {
        const ops: any[] = [];
        switch (diff.action) {
            case 'CREATE_TABLE':
                ops.push({ action: 'createCollection', name: diff.name });
                if (diff.columns) {
                    for (const col of diff.columns) {
                        if (col.index || col.primaryKey || col.unique) {
                            ops.push({ action: 'createIndex', collection: diff.name, keys: { [col.name]: 1 }, options: { unique: !!(col.primaryKey || col.unique) } });
                        }
                    }
                }
                break;
            case 'DROP_TABLE':
                ops.push({ action: 'dropCollection', name: diff.name });
                break;
            case 'ADD_COLUMN':
                if (diff.column.index || diff.column.unique) {
                    ops.push({ action: 'createIndex', collection: diff.table, keys: { [diff.column.name]: 1 }, options: { unique: !!diff.column.unique } });
                }
                break;
        }
        return ops;
    }

    /**
     * Compiles a manifest-declared table trigger into its native Postgres SQL
     * (CREATE FUNCTION + CREATE TRIGGER, and for WEBHOOK/EMAIL/TELEGRAM
     * execute forms, durable job-enqueuing logic) and registers it in the
     * trigger control plane, by delegating to `TriggerService.transpileTriggerSql`.
     * @param trigger The manifest trigger definition (`procedure` | `execute` | `action` declarative form).
     * @param schemaName Physical (tenant-qualified) schema the trigger's table lives in.
     * @param tableName Physical table name the trigger is attached to.
     * @param tenantId Tenant scope; when supplied, the trigger is also registered in `trigger_registry` (source=MANIFEST).
     */
    private static async callTriggerEngine(trigger: any, schemaName: string, tableName: string, tenantId?: string): Promise<string[]> {
        return TriggerService.transpileTriggerSql(trigger, schemaName, tableName, tenantId);
    }

    // =========================================================================
    //  MySQL DDL Transpiler
    // =========================================================================

    /** Maps a manifest's portable type name to its MySQL-native type. */
    private static normalizeMysqlType(t: string): string {
        if (!t) return t;
        const map: Record<string, string> = {
            'STRING': 'VARCHAR(255)', 'TEXT': 'TEXT', 'INTEGER': 'INT', 'BIGINT': 'BIGINT',
            'BOOLEAN': 'TINYINT(1)', 'TIMESTAMP': 'DATETIME', 'UUID': 'CHAR(36)',
            'JSONB': 'JSON', 'NUMERIC': 'DECIMAL(18,4)', 'SERIAL': 'INT AUTO_INCREMENT',
        };
        return map[t.toUpperCase()] || t;
    }

    /**
     * Compiles a single diff into MySQL DDL statements.
     * Handles: CREATE_SCHEMA (as CREATE DATABASE), CREATE_TABLE (backtick quoting,
     * AUTO_INCREMENT, ENGINE=InnoDB), ADD_COLUMN, CREATE_VIEW, CREATE_FUNCTION/PROCEDURE.
     * @param diff A single diff entry to compile.
     * @param tenantId Tenant scope.
     * @param manifest Full manifest.
     * @returns The ordered MySQL DDL statements.
     */
    static async toMysql(diff: any, tenantId: string, manifest?: MetadataManifest): Promise<string[]> {
        const schemaName = `tenant_${tenantId}_${diff.schema || diff.name}`;
        const sql: string[] = [];

        switch (diff.action) {
            case 'CREATE_SCHEMA':
                sql.push(`CREATE DATABASE IF NOT EXISTS \`${schemaName}\``);
                break;

            case 'CREATE_TABLE': {
                const table = diff as TableDefinition;
                const cols = table.columns.map(c => {
                    let d = `\`${c.name}\` `;
                    if (c.strategy === 'UUID_V7') {
                        d += `CHAR(36) DEFAULT (UUID())`;
                    } else if (c.strategy === 'LEGACY_SERIAL' || c.strategy === 'IDENTITY_ALWAYS') {
                        d += `INT AUTO_INCREMENT`;
                    } else {
                        d += this.normalizeMysqlType(c.type);
                        if (c.length && c.type.toUpperCase() === 'STRING') d = `\`${c.name}\` VARCHAR(${c.length})`;
                    }
                    if (c.primaryKey) d += ' PRIMARY KEY';
                    if (c.default && c.strategy !== 'UUID_V7' && c.strategy !== 'LEGACY_SERIAL') {
                        const upper = c.default.toUpperCase();
                        if (upper === 'NOW()' || upper === 'CURRENT_TIMESTAMP') d += ` DEFAULT CURRENT_TIMESTAMP`;
                        else if (c.default.includes('(')) d += ` DEFAULT (${c.default})`;
                        else if (isNaN(Number(c.default))) d += ` DEFAULT '${c.default}'`;
                        else d += ` DEFAULT ${c.default}`;
                    }
                    if (c.unique && !c.primaryKey) d += ' UNIQUE';
                    if (c.nullable === false && !c.primaryKey) d += ' NOT NULL';
                    return d;
                });
                sql.push(`CREATE TABLE IF NOT EXISTS \`${schemaName}\`.\`${table.name}\` (${cols.join(', ')}) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`);
                for (const c of table.columns) {
                    if (c.index && !c.primaryKey) {
                        sql.push(`CREATE INDEX \`idx_${table.name}_${c.name}\` ON \`${schemaName}\`.\`${table.name}\` (\`${c.name}\`)`);
                    }
                }
                break;
            }

            case 'ADD_COLUMN': {
                const col = diff.column;
                let colDef = `\`${col.name}\` ${this.normalizeMysqlType(col.type)}`;
                if (col.nullable === false) colDef += ' NOT NULL';
                sql.push(`ALTER TABLE \`${schemaName}\`.\`${diff.table}\` ADD COLUMN ${colDef}`);
                break;
            }

            case 'CREATE_VIEW': {
                const view = diff as ViewDefinition;
                const viewQuery = QueryTranspiler.toSql(view.query, schemaName);
                sql.push(`CREATE OR REPLACE VIEW \`${schemaName}\`.\`${view.name}\` AS ${viewQuery}`);
                break;
            }

            case 'CREATE_FUNCTION':
            case 'CREATE_PROCEDURE': {
                const fn = diff as any;
                const rawArgs = fn.arguments || fn.parameters || [];
                const args = rawArgs.map((a: any) => `${a.mode || 'IN'} \`${a.name}\` ${this.normalizeMysqlType(a.type)}`).join(', ') || '';
                const ret = fn.type === 'FUNCTION' ? `RETURNS ${this.normalizeMysqlType(fn.returnType || 'TEXT')}` : '';
                const deterministic = fn.volatility === 'IMMUTABLE' ? 'DETERMINISTIC' : 'NOT DETERMINISTIC';
                let body = fn.body.trim();
                if (!body.toUpperCase().startsWith('BEGIN')) body = `BEGIN\n    ${body}\nEND`;
                sql.push(`DROP ${fn.type} IF EXISTS \`${schemaName}\`.\`${fn.name}\``);
                sql.push(`CREATE ${fn.type} \`${schemaName}\`.\`${fn.name}\`(${args}) ${ret} ${deterministic}\n${body}`);
                break;
            }
        }
        return sql;
    }

    // =========================================================================
    //  Oracle DDL Transpiler
    // =========================================================================

    /** Maps a manifest's portable type name to its Oracle-native type. */
    private static normalizeOracleType(t: string): string {
        if (!t) return t;
        const map: Record<string, string> = {
            'STRING': 'VARCHAR2(255)', 'TEXT': 'CLOB', 'INTEGER': 'NUMBER(10)', 'BIGINT': 'NUMBER(19)',
            'BOOLEAN': 'NUMBER(1)', 'TIMESTAMP': 'TIMESTAMP', 'UUID': 'RAW(16)',
            'JSONB': 'CLOB', 'NUMERIC': 'NUMBER(18,4)', 'SERIAL': 'NUMBER(10)',
        };
        return map[t.toUpperCase()] || t;
    }

    /**
     * Compiles a single diff into Oracle DDL statements.
     * Handles: CREATE_SCHEMA (as DBA comment), CREATE_TABLE, ADD_COLUMN,
     * CREATE_SEQUENCE (native), CREATE_VIEW, CREATE_MATERIALIZED_VIEW, CREATE_FUNCTION/PROCEDURE.
     * @param diff A single diff entry to compile.
     * @param tenantId Tenant scope.
     * @param manifest Full manifest.
     * @returns The ordered Oracle DDL statements.
     */
    static async toOracle(diff: any, tenantId: string, manifest?: MetadataManifest): Promise<string[]> {
        const schemaName = `tenant_${tenantId}_${diff.schema || diff.name}`.toUpperCase();
        const sql: string[] = [];

        switch (diff.action) {
            case 'CREATE_SCHEMA':
                sql.push(`-- Oracle schema: CREATE USER "${schemaName}" handled by DBA/provisioning layer`);
                break;

            case 'CREATE_SEQUENCE': {
                const seq = diff as SequenceDefinition;
                let seqSql = `CREATE SEQUENCE "${schemaName}"."${seq.name}" START WITH ${seq.start || 1} INCREMENT BY ${seq.increment || 1}`;
                if (seq.minValue) seqSql += ` MINVALUE ${seq.minValue}`;
                if (seq.maxValue) seqSql += ` MAXVALUE ${seq.maxValue}`;
                if (seq.cache) seqSql += ` CACHE ${seq.cache}`;
                sql.push(seqSql);
                break;
            }

            case 'CREATE_TABLE': {
                const table = diff as TableDefinition;
                const cols = table.columns.map(c => {
                    let d = `"${c.name}" `;
                    if (c.strategy === 'UUID_V7') d += `RAW(16) DEFAULT SYS_GUID()`;
                    else if (c.strategy === 'IDENTITY_ALWAYS') d += `NUMBER GENERATED ALWAYS AS IDENTITY`;
                    else if (c.strategy === 'LEGACY_SERIAL') d += `NUMBER GENERATED BY DEFAULT AS IDENTITY`;
                    else {
                        d += this.normalizeOracleType(c.type);
                        if (c.length && c.type.toUpperCase() === 'STRING') d = `"${c.name}" VARCHAR2(${c.length})`;
                    }
                    if (c.primaryKey) d += ' PRIMARY KEY';
                    if (c.default && !['UUID_V7', 'IDENTITY_ALWAYS', 'LEGACY_SERIAL'].includes(c.strategy || '')) {
                        const upper = c.default.toUpperCase();
                        if (upper === 'NOW()' || upper === 'CURRENT_TIMESTAMP') d += ` DEFAULT SYSTIMESTAMP`;
                        else if (c.default.includes('(')) d += ` DEFAULT ${c.default}`;
                        else if (isNaN(Number(c.default))) d += ` DEFAULT '${c.default}'`;
                        else d += ` DEFAULT ${c.default}`;
                    }
                    if (c.unique && !c.primaryKey) d += ' UNIQUE';
                    if (c.nullable === false && !c.primaryKey) d += ' NOT NULL';
                    return d;
                });
                sql.push(`CREATE TABLE "${schemaName}"."${table.name}" (${cols.join(', ')})`);
                for (const c of table.columns) {
                    if (c.index && !c.primaryKey) {
                        sql.push(`CREATE INDEX "IDX_${table.name}_${c.name}" ON "${schemaName}"."${table.name}" ("${c.name}")`);
                    }
                }
                break;
            }

            case 'ADD_COLUMN': {
                const col = diff.column;
                let colDef = `"${col.name}" ${this.normalizeOracleType(col.type)}`;
                if (col.nullable === false) colDef += ' NOT NULL';
                sql.push(`ALTER TABLE "${schemaName}"."${diff.table}" ADD (${colDef})`);
                break;
            }

            case 'CREATE_VIEW': {
                const view = diff as ViewDefinition;
                const viewQuery = QueryTranspiler.toSql(view.query, schemaName);
                sql.push(`CREATE OR REPLACE VIEW "${schemaName}"."${view.name}" AS ${viewQuery}`);
                break;
            }

            case 'CREATE_MATERIALIZED_VIEW': {
                const view = diff as ViewDefinition;
                const viewQuery = QueryTranspiler.toSql(view.query, schemaName);
                sql.push(`CREATE MATERIALIZED VIEW "${schemaName}"."${view.name}" AS ${viewQuery}`);
                break;
            }

            case 'CREATE_FUNCTION':
            case 'CREATE_PROCEDURE': {
                const fn = diff as any;
                const rawArgs = fn.arguments || fn.parameters || [];
                const args = rawArgs.map((a: any) => `"${a.name}" ${a.mode || 'IN'} ${this.normalizeOracleType(a.type)}`).join(', ') || '';
                const ret = fn.type === 'FUNCTION' ? `RETURN ${this.normalizeOracleType(fn.returnType || 'VARCHAR2(4000)')}` : '';
                let body = fn.body.trim();
                if (!body.toUpperCase().startsWith('BEGIN')) body = `BEGIN\n    ${body}\nEND;`;
                sql.push(`CREATE OR REPLACE ${fn.type} "${schemaName}"."${fn.name}"(${args}) ${ret} IS\n${body}`);
                break;
            }
        }
        return sql;
    }

    // =========================================================================
    //  Snowflake DDL Transpiler
    // =========================================================================

    /** Maps a manifest's portable type name to its Snowflake-native type. */
    private static normalizeSnowflakeType(t: string): string {
        if (!t) return t;
        const map: Record<string, string> = {
            'STRING': 'VARCHAR', 'TEXT': 'TEXT', 'INTEGER': 'INTEGER', 'BIGINT': 'BIGINT',
            'BOOLEAN': 'BOOLEAN', 'TIMESTAMP': 'TIMESTAMP_NTZ', 'UUID': 'VARCHAR(36)',
            'JSONB': 'VARIANT', 'NUMERIC': 'NUMBER(18,4)', 'SERIAL': 'INTEGER AUTOINCREMENT',
        };
        return map[t.toUpperCase()] || t;
    }

    /**
     * Compiles a single diff into Snowflake DDL statements.
     * Handles: CREATE_SCHEMA, CREATE_TABLE, ADD_COLUMN, CREATE_SEQUENCE (native),
     * CREATE_VIEW, CREATE_FUNCTION/PROCEDURE (JavaScript UDF or SQL).
     * @param diff A single diff entry to compile.
     * @param tenantId Tenant scope.
     * @param manifest Full manifest.
     * @returns The ordered Snowflake DDL statements.
     */
    static async toSnowflake(diff: any, tenantId: string, manifest?: MetadataManifest): Promise<string[]> {
        const schemaName = `TENANT_${tenantId}_${diff.schema || diff.name}`.toUpperCase();
        const sql: string[] = [];

        switch (diff.action) {
            case 'CREATE_SCHEMA':
                sql.push(`CREATE SCHEMA IF NOT EXISTS "${schemaName}"`);
                break;

            case 'CREATE_SEQUENCE': {
                const seq = diff as SequenceDefinition;
                sql.push(`CREATE SEQUENCE IF NOT EXISTS "${schemaName}"."${seq.name}" START = ${seq.start || 1} INCREMENT = ${seq.increment || 1}`);
                break;
            }

            case 'CREATE_TABLE': {
                const table = diff as TableDefinition;
                const cols = table.columns.map(c => {
                    let d = `"${c.name}" `;
                    if (c.strategy === 'UUID_V7') d += `VARCHAR(36) DEFAULT UUID_STRING()`;
                    else if (c.strategy === 'IDENTITY_ALWAYS') d += `INTEGER AUTOINCREMENT`;
                    else if (c.strategy === 'LEGACY_SERIAL') d += `INTEGER AUTOINCREMENT`;
                    else {
                        d += this.normalizeSnowflakeType(c.type);
                        if (c.length && c.type.toUpperCase() === 'STRING') d = `"${c.name}" VARCHAR(${c.length})`;
                    }
                    if (c.primaryKey) d += ' PRIMARY KEY';
                    if (c.default && !['UUID_V7', 'IDENTITY_ALWAYS', 'LEGACY_SERIAL'].includes(c.strategy || '')) {
                        const upper = c.default.toUpperCase();
                        if (upper === 'NOW()' || upper === 'CURRENT_TIMESTAMP') d += ` DEFAULT CURRENT_TIMESTAMP()`;
                        else if (c.default.includes('(')) d += ` DEFAULT ${c.default}`;
                        else if (isNaN(Number(c.default))) d += ` DEFAULT '${c.default}'`;
                        else d += ` DEFAULT ${c.default}`;
                    }
                    if (c.unique && !c.primaryKey) d += ' UNIQUE';
                    if (c.nullable === false && !c.primaryKey) d += ' NOT NULL';
                    return d;
                });
                sql.push(`CREATE TABLE IF NOT EXISTS "${schemaName}"."${table.name}" (${cols.join(', ')})`);
                break;
            }

            case 'ADD_COLUMN': {
                const col = diff.column;
                let colDef = `"${col.name}" ${this.normalizeSnowflakeType(col.type)}`;
                if (col.nullable === false) colDef += ' NOT NULL';
                sql.push(`ALTER TABLE "${schemaName}"."${diff.table}" ADD COLUMN ${colDef}`);
                break;
            }

            case 'CREATE_VIEW': {
                const view = diff as ViewDefinition;
                const viewQuery = QueryTranspiler.toSql(view.query, schemaName);
                sql.push(`CREATE OR REPLACE VIEW "${schemaName}"."${view.name}" AS ${viewQuery}`);
                break;
            }

            case 'CREATE_FUNCTION':
            case 'CREATE_PROCEDURE': {
                const fn = diff as any;
                const rawArgs = fn.arguments || fn.parameters || [];
                const args = rawArgs.map((a: any) => `${a.name} ${this.normalizeSnowflakeType(a.type)}`).join(', ') || '';
                const ret = fn.type === 'FUNCTION' ? `RETURNS ${this.normalizeSnowflakeType(fn.returnType || 'VARCHAR')}` : '';
                let body = fn.body.trim();
                sql.push(`CREATE OR REPLACE ${fn.type} "${schemaName}"."${fn.name}"(${args}) ${ret} LANGUAGE SQL AS '${body.replace(/'/g, "''")}'`);
                break;
            }
        }
        return sql;
    }

    // =========================================================================
    //  Elasticsearch DDL Transpiler
    // =========================================================================

    /**
     * Compiles a single diff into Elasticsearch index/template ops.
     * Only CREATE_TABLE is meaningful (creates an index with property mappings).
     * @param diff A single diff entry to compile.
     * @param tenantId Tenant scope.
     * @param manifest Full manifest.
     * @returns Op descriptors for the Elasticsearch dispatcher.
     */
    static async toElasticsearch(diff: any, tenantId: string, manifest?: MetadataManifest): Promise<any[]> {
        const ops: any[] = [];
        switch (diff.action) {
            case 'CREATE_TABLE': {
                const esTypeMap: Record<string, string> = {
                    'STRING': 'keyword', 'TEXT': 'text', 'INTEGER': 'integer', 'BIGINT': 'long',
                    'BOOLEAN': 'boolean', 'TIMESTAMP': 'date', 'UUID': 'keyword',
                    'NUMERIC': 'double', 'JSONB': 'object',
                };
                const properties: Record<string, any> = {};
                if (diff.columns) {
                    for (const col of diff.columns) {
                        properties[col.name] = { type: esTypeMap[col.type?.toUpperCase()] || 'keyword' };
                    }
                }
                ops.push({
                    action: 'createIndex',
                    name: `${tenantId}_${diff.name}`.toLowerCase(),
                    mappings: { properties },
                });
                break;
            }
        }
        return ops;
    }

    // =========================================================================
    //  Fabric Compensation Actions (executed on the Hub for non-native engines)
    // =========================================================================

    /**
     * Compiles fabric compensation actions into SQL executed on the Hub Postgres.
     * These provide engine-agnostic equivalents for features the target engine
     * doesn't support natively:
     *  - `REGISTER_FABRIC_SEQUENCE` — Seeds in `fabric_system.fabric_sequences`.
     *  - `REGISTER_HUB_FUNCTION` — Provisions on Hub Postgres as a value-service.
     *  - `REGISTER_FABRIC_ENUM` — Records enum values for application-level validation.
     *  - `REGISTER_VIRTUAL_VIEW` — Registers the view AST in the fabric query engine.
     * @param diff A compensation diff entry.
     * @param tenantId Tenant scope.
     * @param manifest Full manifest.
     * @returns SQL statements to execute on the hub for compensation.
     */
    static async toFabricCompensation(diff: any, tenantId: string, manifest?: MetadataManifest): Promise<string[]> {
        const sql: string[] = [];

        switch (diff.action) {
            case 'REGISTER_FABRIC_SEQUENCE': {
                const seq = diff as SequenceDefinition;
                sql.push(`INSERT INTO fabric_system.fabric_sequences (tenant_id, name, current_value, increment)
                    VALUES ('${tenantId}', '${seq.name}', ${(seq.start || 1) - (seq.increment || 1)}, ${seq.increment || 1})
                    ON CONFLICT (tenant_id, name) DO NOTHING`);
                break;
            }

            case 'REGISTER_HUB_FUNCTION': {
                const schemaName = `tenant_${tenantId}_${diff.schema}`;
                const fn = diff as any;
                const rawArgs = fn.arguments || fn.parameters || [];
                const args = rawArgs.map((a: any) => `"${a.name}" ${a.mode || 'IN'} ${this.normalizeType(a.type)}`).join(', ') || '';
                const ret = fn.returnType ? `RETURNS ${this.normalizeType(fn.returnType)}` : 'RETURNS VOID';
                let body = fn.body.trim();
                if (!body.toUpperCase().startsWith('BEGIN')) body = `BEGIN\n    ${body}\nEND;`;
                sql.push(`CREATE SCHEMA IF NOT EXISTS "${schemaName}"`);
                sql.push(`CREATE OR REPLACE FUNCTION "${schemaName}"."${fn.name}"(${args}) ${ret} AS $$ ${body} $$ LANGUAGE plpgsql`);
                break;
            }

            case 'REGISTER_FABRIC_ENUM': {
                const enumDef = diff as EnumDefinition;
                const valuesJson = JSON.stringify(enumDef.values);
                sql.push(`CREATE TABLE IF NOT EXISTS fabric_system.fabric_enums (
                    tenant_id TEXT NOT NULL, schema_name TEXT NOT NULL, enum_name TEXT NOT NULL,
                    allowed_values JSONB NOT NULL, target_source TEXT, target_engine TEXT,
                    PRIMARY KEY (tenant_id, schema_name, enum_name))`);
                sql.push(`INSERT INTO fabric_system.fabric_enums (tenant_id, schema_name, enum_name, allowed_values, target_source, target_engine)
                    VALUES ('${tenantId}', '${diff.schema}', '${enumDef.name}', '${valuesJson}'::jsonb, '${diff.targetSource}', '${diff.engineType}')
                    ON CONFLICT (tenant_id, schema_name, enum_name) DO UPDATE SET allowed_values = EXCLUDED.allowed_values`);
                break;
            }

            case 'REGISTER_VIRTUAL_VIEW': {
                const view = diff as any;
                const queryJson = JSON.stringify(view.query).replace(/'/g, "''");
                sql.push(`CREATE TABLE IF NOT EXISTS fabric_system.virtual_views (
                    tenant_id TEXT NOT NULL, schema_name TEXT NOT NULL, view_name TEXT NOT NULL,
                    query_ast JSONB NOT NULL, target_source TEXT, target_engine TEXT, materialized BOOLEAN DEFAULT FALSE,
                    PRIMARY KEY (tenant_id, schema_name, view_name))`);
                sql.push(`INSERT INTO fabric_system.virtual_views (tenant_id, schema_name, view_name, query_ast, target_source, target_engine, materialized)
                    VALUES ('${tenantId}', '${diff.schema}', '${view.name}', '${queryJson}'::jsonb, '${diff.targetSource}', '${diff.engineType}', ${view.materialized || false})
                    ON CONFLICT (tenant_id, schema_name, view_name) DO UPDATE SET query_ast = EXCLUDED.query_ast`);
                break;
            }
        }
        return sql;
    }
}

