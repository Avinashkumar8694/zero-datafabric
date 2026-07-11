import axios from 'axios';
import { ColumnDefinition, TableDefinition, EnumDefinition, SequenceDefinition, ViewDefinition, FunctionDefinition, MetadataManifest, RelationshipDefinition } from './types';
import { QueryTranspiler } from './query_transpiler';
import { TriggerService } from '../triggers/trigger.service';

export class Transpiler {
    private static TRIGGER_ENGINE_URL = process.env.TRIGGER_ENGINE_URL || 'http://localhost:4001/api/trig-engine/transpile';

    private static normalizeType(t: string) {
        if (!t) return t;
        const map: any = { 'STRING': 'TEXT', 'INTEGER': 'INT', 'BOOLEAN': 'BOOL', 'TIMESTAMP': 'TIMESTAMP', 'UUID': 'UUID', 'BIGINT': 'BIGINT', 'JSONB': 'JSONB', 'NUMERIC': 'NUMERIC' };
        return map[t.toUpperCase()] || t;
    }

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
                        const isLiteral = !c.default.includes('(') && isNaN(Number(c.default)) && !['NOW()', 'CURRENT_TIMESTAMP'].includes(c.default.toUpperCase());
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

    private static async callTriggerEngine(trigger: any, schemaName: string, tableName: string, tenantId?: string): Promise<string[]> {
        // Manifest triggers are compiled natively at apply time by
        // TriggerActionCompiler, which now handles ALL declarative forms:
        //   • procedure — EXECUTE an existing trigger function
        //   • execute   — AUDIT/WEBHOOK/EMAIL/TELEGRAM/FUNCTION/EXCEPTION
        //   • action    — the mini INSERT/UPDATE/DELETE/RAISE/PERFORM/sql DSL
        // For WEBHOOK/EMAIL/TELEGRAM the generated function enqueues a durable
        // job the trigger-engine worker dispatches later; the CREATE itself needs
        // no running microservice. transpileTriggerSql also registers the trigger
        // in the control plane (trigger_registry, source=MANIFEST).
        return TriggerService.transpileTriggerSql(trigger, schemaName, tableName, tenantId);
    }
}
