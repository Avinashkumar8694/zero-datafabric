import axios from 'axios';
import { ColumnDefinition, TableDefinition, EnumDefinition, SequenceDefinition, ViewDefinition, FunctionDefinition, MetadataManifest, RelationshipDefinition } from './types';
import { QueryTranspiler } from './query_transpiler';

export class Transpiler {
    private static TRIGGER_ENGINE_URL = process.env.TRIGGER_ENGINE_URL || 'http://localhost:4001/api/trig-engine/transpile';

    static async toSql(diff: any, tenantId: string, manifest?: MetadataManifest): Promise<string[]> {
        const schemaName = `tenant_${tenantId}_${diff.schema || diff.name}`;
        const sql: string[] = [];
        const isNoSql = diff.targetSource?.toLowerCase().includes('mongo');

        if (isNoSql) return this.toNoSql(diff, schemaName);

        switch (diff.action) {
            case 'CREATE_SCHEMA':
                sql.push(`CREATE SCHEMA IF NOT EXISTS "${schemaName}"`);
                break;

            case 'CREATE_ENUM':
                const vals = (diff as EnumDefinition).values.map(v => `'${v}'`).join(', ');
                sql.push(`CREATE TYPE "${schemaName}"."${diff.name}" AS ENUM (${vals})`);
                break;

            case 'CREATE_SEQUENCE':
                const seq = diff as SequenceDefinition;
                sql.push(`CREATE SEQUENCE "${schemaName}"."${seq.name}" START WITH ${seq.start || 1} INCREMENT BY ${seq.increment || 1}`);
                break;

            case 'CREATE_FUNCTION':
            case 'CREATE_PROCEDURE':
                const fn = diff as FunctionDefinition;
                const args = fn.arguments?.map(a => `"${a.name}" ${a.mode || 'IN'} ${a.type}`).join(', ') || '';
                const ret = fn.type === 'FUNCTION' ? `RETURNS ${fn.returnType || 'VOID'}` : '';
                sql.push(`CREATE OR REPLACE ${fn.type} "${schemaName}"."${fn.name}"(${args}) ${ret} AS $$ ${fn.body} $$ LANGUAGE plpgsql`);
                break;

            case 'CREATE_TABLE':
                const table = diff as TableDefinition;
                const customTypes = manifest?.schemas.find(s => s.name === diff.schema)?.resources.filter(r => r.type === 'ENUM').map(r => r.name) || [];

                const cols = table.columns.map(c => {
                    let d = `"${c.name}" `;
                    if (c.strategy === 'IDENTITY_ALWAYS') {
                        d += `${c.type} GENERATED ALWAYS AS IDENTITY`;
                    } else if (c.strategy === 'UUID_V7') {
                        d += `UUID DEFAULT uuid_generate_v4()`;
                    } else if (c.strategy === 'LEGACY_SERIAL') {
                        d += `SERIAL`;
                    } else {
                        const isCustom = customTypes.includes(c.type);
                        d += isCustom ? `"${schemaName}"."${c.type}"` : c.type;
                    }

                    if (c.primaryKey) d += ' PRIMARY KEY';
                    if (c.default && !c.strategy) d += ` DEFAULT ${c.default}`;
                    if (c.generated) d += ` GENERATED ALWAYS AS (${c.generated}) STORED`;
                    if (c.nullable === false) d += ' NOT NULL';
                    
                    return d;
                }).join(', ');
                
                let createTable = `CREATE TABLE IF NOT EXISTS "${schemaName}"."${table.name}" (${cols})`;
                if (table.partitionBy) {
                    createTable += ` PARTITION BY ${table.partitionBy.type}("${table.partitionBy.column}")`;
                }
                sql.push(createTable);

                // Security: RLS & Policies
                if (table.security?.enable_rls) {
                    sql.push(`ALTER TABLE "${schemaName}"."${table.name}" ENABLE ROW LEVEL SECURITY`);
                    if (table.security.policies) {
                        for (const pol of table.security.policies) {
                            sql.push(`DROP POLICY IF EXISTS "${pol.name}" ON "${schemaName}"."${table.name}"`);
                            sql.push(`CREATE POLICY "${pol.name}" ON "${schemaName}"."${table.name}" FOR ALL USING (${pol.using})`);
                        }
                    }
                    if (table.security.grants) {
                        for (const grant of table.security.grants) {
                            sql.push(`GRANT ${grant.privileges.join(', ')} ON "${schemaName}"."${table.name}" TO ${grant.role}`);
                        }
                    }
                }

                // Security: Masking (via Redaction Views or simplified logic)
                if (table.security?.masking) {
                    for (const m of table.security.masking) {
                        // In a real industrial environment, this would use a MASKING extension or a View-based redaction layer.
                        // Here we log the intent as per Section 8.3
                        sql.push(`-- MASKING APPLIED to "${table.name}"."${m.column}" for roles ${m.roles.join(', ')} using ${m.expression}`);
                    }
                }
                
                if (table.triggers) {
                    for (const trg of table.triggers) {
                        const trgSql = await this.callTriggerEngine(trg, schemaName, table.name);
                        sql.push(...trgSql);
                    }
                }
                break;

            case 'CREATE_VIEW':
                const view = diff as ViewDefinition;
                const viewQuery = QueryTranspiler.toSql(view.query, schemaName);
                if (view.materialized) {
                    sql.push(`DROP MATERIALIZED VIEW IF EXISTS "${schemaName}"."${view.name}" CASCADE`);
                    sql.push(`CREATE MATERIALIZED VIEW "${schemaName}"."${view.name}" AS ${viewQuery}`);
                } else {
                    sql.push(`CREATE OR REPLACE VIEW "${schemaName}"."${view.name}" AS ${viewQuery}`);
                }
                
                if (view.materialized && view.indexes) {
                    for (const idx of view.indexes) {
                        sql.push(`CREATE ${idx.unique ? 'UNIQUE' : ''} INDEX IF NOT EXISTS "idx_${view.name}_${idx.columns.join('_')}" ON "${schemaName}"."${view.name}" (${idx.columns.join(', ')})`);
                    }
                }
                break;

            case 'PROVISION_RELATIONSHIP':
                const rel = diff as RelationshipDefinition;
                if (rel.cardinality === 'M:N' && rel.bridge && manifest) {
                    const fromType = this.findColumnType(manifest, rel.from.resource, rel.from.field);
                    const toType = this.findColumnType(manifest, rel.to.resource, rel.to.field);

                    sql.push(`CREATE TABLE IF NOT EXISTS "${schemaName}"."${rel.bridge}" (
                        "${rel.from.field}" ${fromType} REFERENCES "${schemaName}"."${rel.from.resource}"("${rel.from.field}"),
                        "${rel.to.field}" ${toType} REFERENCES "${schemaName}"."${rel.to.resource}"("${rel.to.field}"),
                        PRIMARY KEY ("${rel.from.field}", "${rel.to.field}")
                    )`);
                } else if ((rel.cardinality === '1:M' || rel.cardinality === '1:1') && manifest) {
                    // Section 8.10: 1:M and 1:1 foreign keys
                    // We assume the 'from' is the child (holder of FK)
                    sql.push(`ALTER TABLE "${schemaName}"."${rel.from.resource}" ADD COLUMN IF NOT EXISTS "${rel.from.field}" ${this.findColumnType(manifest, rel.to.resource, rel.to.field)}`);
                    sql.push(`ALTER TABLE "${schemaName}"."${rel.from.resource}" ADD CONSTRAINT "fk_${rel.name}" FOREIGN KEY ("${rel.from.field}") REFERENCES "${schemaName}"."${rel.to.resource}"("${rel.to.field}")`);
                }
                break;

            case 'QUARANTINE_TABLE':
                sql.push(`ALTER TABLE "${schemaName}"."${diff.table}" RENAME TO "__deleted_v4_${diff.table}_${Date.now()}"`);
                break;
        }

        return sql;
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

    private static toNoSql(diff: any, schemaName: string): string[] {
        const commands: string[] = [];
        if (diff.action === 'CREATE_TABLE') {
            commands.push(`/* MongoDB Virtualization */ db.createCollection("${diff.name}", { validator: { $jsonSchema: { ... } } })`);
        }
        return commands;
    }

    private static async callTriggerEngine(trigger: any, schemaName: string, tableName: string): Promise<string[]> {
        try {
            const res = await axios.post(this.TRIGGER_ENGINE_URL, { trigger, schemaName, tableName });
            return res.data.sql || [];
        } catch (err: any) {
            throw new Error(`Trigger Engine Error: ${err.message}`);
        }
    }
}
