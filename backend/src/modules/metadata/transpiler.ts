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
import crypto from 'crypto';
import { ColumnDefinition, TableDefinition, EnumDefinition, SequenceDefinition, ViewDefinition, FunctionDefinition, MetadataManifest, RelationshipDefinition } from './types';
import { QueryTranspiler } from './query_transpiler';
import { TriggerService } from '../triggers/trigger.service';
import { assertIdent, assertTenantId, belongsToTenant, quoteAnyIdent, quoteIdent } from '../../utils/identifiers';
import { assertColumnType, assertDollarSafe, assertSafeExpression, ManifestSqlError, printable, renderDefault, sqlLiteral, sqlNumber } from './sql_safety';

/** Set (non-enumerable) on a manifest by the orchestrator once it validated the manifest with free SQL allowed. */
export const FREE_SQL_FLAG = Symbol.for('fabric.manifest.allowFreeSql');
const allowsFreeSql = (m?: any): boolean => !!(m && m[FREE_SQL_FLAG]);

const RESERVED_ROLE = /^(postgres|fabric_admin|authenticator|web_anon|pg_.*|citus.*)$/i;
const PRIVILEGES = new Set(['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER', 'ALL', 'ALL PRIVILEGES', 'USAGE']);
const EXCLUSION_OPERATORS = new Set(['=', '&&', '<>', '<', '>', '<=', '>=', '@>', '<@', '-|-']);
const INDEX_METHODS = new Set(['BTREE', 'GIN', 'BRIN', 'GIST', 'HASH']);

/** `tenant_<id>_<logical>`: validated, confined to the tenant namespace and short enough not to be truncated by Postgres. */
export function physicalSchemaName(tenantId: string, logical: unknown): string {
    const t = assertTenantId(tenantId);
    const l = assertIdent(logical, 'schema name');
    const physical = `tenant_${t}_${l}`;
    if (physical.length > 63 || !belongsToTenant(physical, t)) throw new ManifestSqlError('CROSS_TENANT_SCHEMA', `Schema "${printable(String(logical), 40)}" cannot be mapped into the workspace namespace`);
    return physical;
}

/** Derived object names (indexes, triggers, constraints) are shortened with a hash when they would exceed 63 chars. */
export function derivedName(prefix: string, ...parts: string[]): string {
    const base = [prefix, ...parts].map((p) => assertIdent(String(p), 'name part')).join('_');
    if (base.length <= 63) return base;
    return `${base.slice(0, 50)}_${crypto.createHash('md5').update(base).digest('hex').slice(0, 10)}`;
}

function oneLine(v: unknown): string { return String(v ?? '').replace(/[\r\n\u2028\u2029]+/g, ' '); }
const bt = (v: unknown) => `\`${assertIdent(v, 'identifier')}\``;
function checkedType(t: unknown): string { return assertColumnType(t, 'type'); }
function argMode(m: unknown): string {
    const mode = String(m || 'IN').toUpperCase();
    if (!['IN', 'OUT', 'INOUT'].includes(mode)) throw new ManifestSqlError('INVALID_ARGUMENT', 'argument mode must be IN, OUT or INOUT');
    return mode;
}
function indexMethod(t: unknown): string {
    const m = String(t || 'BTREE').toUpperCase();
    if (!INDEX_METHODS.has(m)) throw new ManifestSqlError('INVALID_INDEX', `Unsupported index type "${printable(String(t), 20)}"`);
    return m;
}
function exclusionOperator(op: unknown): string {
    if (!EXCLUSION_OPERATORS.has(String(op))) throw new ManifestSqlError('INVALID_OPERATOR', 'Unsupported EXCLUDE operator');
    return String(op);
}
function grantPrivilege(p: unknown): string {
    const up = String(p).toUpperCase();
    if (!PRIVILEGES.has(up)) throw new ManifestSqlError('INVALID_GRANT', `Unsupported privilege "${printable(String(p), 20)}"`);
    return up;
}
function roleRef(role: unknown): string {
    if (String(role).toUpperCase() === 'PUBLIC') return 'PUBLIC';
    const r = assertIdent(role, 'role');
    if (RESERVED_ROLE.test(r)) throw new ManifestSqlError('RESERVED_ROLE', `Role "${r}" cannot be used in a manifest`);
    return `"${r}"`;
}
function createRoleSql(role: unknown): string {
    const r = roleRef(role).replace(/"/g, '');
    return `DO $dfdo$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = ${sqlLiteral(r)}) THEN CREATE ROLE "${r}" NOLOGIN; END IF; END $dfdo$;`;
}
function assertSourceLabel(v: unknown): string {
    if (v === undefined || v === null || v === '') return '';
    if (typeof v !== 'string' || !/^[A-Za-z]([A-Za-z0-9 _-]{0,46}[A-Za-z0-9_-])?$/.test(v)) throw new ManifestSqlError('INVALID_SOURCE_NAME', 'Invalid data source name');
    return v;
}
/** The GRANT / default-privilege statements every new tenant schema gets for `fabric_user` (no-op when the role is absent). */
export function fabricUserGrants(physical: string): string[] {
    const S = quoteIdent(physical, 'schema');
    const stmt = (inner: string) => `DO $dfdo$ BEGIN IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'fabric_user') THEN EXECUTE ${sqlLiteral(inner)}; END IF; END $dfdo$;`;
    return [
        stmt(`GRANT USAGE ON SCHEMA ${S} TO fabric_user`),
        stmt(`ALTER DEFAULT PRIVILEGES IN SCHEMA ${S} GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO fabric_user`),
        stmt(`GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA ${S} TO fabric_user`),
        stmt(`GRANT SELECT, USAGE ON ALL SEQUENCES IN SCHEMA ${S} TO fabric_user`),
        stmt(`ALTER DEFAULT PRIVILEGES IN SCHEMA ${S} GRANT USAGE, SELECT ON SEQUENCES TO fabric_user`),
    ];
}
/** Literal default for MySQL / Oracle / Snowflake DDL (backslash-escaping engines are handled). */
function foreignDefault(raw: unknown, dialect: 'mysql' | 'oracle' | 'snowflake'): string {
    const d = String(raw).trim();
    const upper = d.toUpperCase();
    if (upper === 'NOW()' || upper === 'CURRENT_TIMESTAMP') return dialect === 'oracle' ? 'SYSTIMESTAMP' : dialect === 'snowflake' ? 'CURRENT_TIMESTAMP()' : 'CURRENT_TIMESTAMP';
    if (d.includes('(')) { const e = assertSafeExpression(d, 'default'); return dialect === 'mysql' ? `(${e})` : e; }
    if (/^-?\d+(\.\d+)?$/.test(d)) return d;
    const lit = dialect === 'oracle' ? sqlLiteral(d) : sqlLiteral(d.replace(/\\/g, '\\\\'));
    return lit;
}

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
        assertColumnType(t, 'type');
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
        const sql: string[] = [];

        if (diff.action === 'PROVISION_EXTENSIONS' && diff.extensions) {
            for (const ext of diff.extensions) {
                if (typeof ext !== 'string' || !/^[A-Za-z0-9_-]{1,63}$/.test(ext)) throw new ManifestSqlError('INVALID_EXTENSION', `Invalid extension name "${printable(String(ext), 40)}"`);
                sql.push(`CREATE EXTENSION IF NOT EXISTS "${ext}"`);
            }
            return sql;
        }

        // Physical schema (validated: tenant prefix + logical name, <= 63 chars, inside the caller's namespace)
        const needsSchema = !['PROVISION_DOWNSTREAM'].includes(diff.action);
        const physical = needsSchema ? physicalSchemaName(tenantId, diff.schema || diff.name) : '';
        const S = physical ? quoteIdent(physical, 'schema') : '';
        const freeSql = allowsFreeSql(manifest);

        switch (diff.action) {
            case 'CREATE_SCHEMA':
                sql.push(`CREATE SCHEMA IF NOT EXISTS ${S}`);
                for (const stmt of fabricUserGrants(physical)) sql.push(stmt);
                break;

            case 'CREATE_ENUM':
                const vals = (diff as EnumDefinition).values.map(v => sqlLiteral(v)).join(', ');
                sql.push(`CREATE TYPE ${S}.${quoteIdent(diff.name, 'enum name')} AS ENUM (${vals})`);
                break;

            case 'CREATE_SEQUENCE':
                const seq = diff as SequenceDefinition;
                if (seq.strategy === 'PROCEDURAL') {
                    // validated single-line expression; still keep it inside a comment on one line
                    sql.push(`-- PROCEDURAL SEQUENCE Generator: ${oneLine(seq.generator)}`);
                    break;
                }
                let seqSql = `CREATE SEQUENCE IF NOT EXISTS ${S}.${quoteIdent(seq.name, 'sequence name')} START WITH ${sqlNumber(seq.start || 1, 'start')} INCREMENT BY ${sqlNumber(seq.increment || 1, 'increment')}`;
                if (seq.minValue) seqSql += ` MINVALUE ${sqlNumber(seq.minValue, 'minValue')}`;
                if (seq.maxValue) seqSql += ` MAXVALUE ${sqlNumber(seq.maxValue, 'maxValue')}`;
                if (seq.cache) seqSql += ` CACHE ${sqlNumber(seq.cache, 'cache')}`;
                sql.push(seqSql);
                break;

            case 'CREATE_FUNCTION':
            case 'CREATE_PROCEDURE':
                sql.push(this.pgFunctionSql(diff, S, freeSql, manifest, diff.schema));
                break;

            case 'CREATE_TABLE':
                const table = diff as TableDefinition;
                const T = `${S}.${quoteIdent(table.name, 'table name')}`;
                const customTypes = manifest?.schemas.find(s => s.name === diff.schema)?.resources.filter(r => r.type === 'ENUM').map(r => r.name) || [];

                const cols = table.columns.map(c => {
                    let d = `${quoteIdent(c.name, 'column name')} `;
                    const isCustomType = customTypes.includes(c.type);
                    // An `ENUM` column with a `ref` is a placeholder for the schema's enum type (emitted below); only real base types are normalised.
                    const isEnumRef = String(c.type).toUpperCase() === 'ENUM' && !!c.ref;
                    const mappedType = isCustomType || isEnumRef ? c.type : this.normalizeType(String(c.type));
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
                    } else if (String(c.type).toUpperCase() === 'ENUM' && c.ref) {
                        d += `${S}.${quoteIdent(c.ref, 'enum reference')}`;
                    } else {
                        // STRING + length -> VARCHAR(n): the declared length used to be silently ignored on Postgres (TEXT).
                        const sized = !isCustomType && c.length && String(c.type).toUpperCase() === 'STRING';
                        d += isCustomType ? `${S}.${quoteIdent(c.type, 'type')}` : (sized ? `VARCHAR(${Math.trunc(sqlNumber(c.length, 'length'))})` : mappedType);
                    }

                    if (c.collation) d += ` COLLATE ${quoteAnyIdent(c.collation)}`;
                    if (c.primaryKey && !table.identity) d += ' PRIMARY KEY';
                    if (c.default !== undefined && c.default !== null && c.default !== '' && !hasDefault && c.strategy !== 'FUNCTIONAL') {
                        d += ` DEFAULT ${renderDefault(c.default, `column ${c.name} default`)}`;
                    }
                    if (c.generated) d += ` GENERATED ALWAYS AS (${assertSafeExpression(c.generated, `column ${c.name} generated`)}) STORED`;
                    if (c.unique) d += ' UNIQUE';
                    if (c.nullable === false) d += ' NOT NULL';
                    
                    return d;
                });

                if (table.identity?.type === 'PRIMARY_KEY') {
                    cols.push(`PRIMARY KEY (${table.identity.columns.map(c => quoteIdent(c, 'identity column')).join(', ')})`);
                }

                if (table.constraints) {
                    for (const con of table.constraints) {
                        if (con.type === 'EXCLUDE') {
                            const method = String(con.using || '').toUpperCase();
                            if (!['GIST', 'GIN', 'BTREE', 'HASH', 'SPGIST', 'BRIN'].includes(method)) throw new ManifestSqlError('INVALID_CONSTRAINT', 'Invalid EXCLUDE index method');
                            cols.push(`CONSTRAINT ${quoteIdent(con.name, 'constraint name')} EXCLUDE USING ${method} (${con.columns?.map(c => `${quoteIdent(c.name, 'constraint column')} WITH ${exclusionOperator(c.operator)}`).join(', ')})`);
                        } else if (con.type === 'CHECK') {
                            cols.push(`CONSTRAINT ${quoteIdent(con.name, 'constraint name')} CHECK (${assertSafeExpression(con.expression, `constraint ${con.name}`)})`);
                        }
                    }
                }
                
                let createTable = `CREATE TABLE IF NOT EXISTS ${T} (${cols.join(', ')})`;
                if (table.partitionBy) {
                    const ptype = String(table.partitionBy.type).toUpperCase();
                    if (ptype !== 'RANGE' && ptype !== 'LIST') throw new ManifestSqlError('INVALID_PARTITION', 'partitionBy.type must be RANGE or LIST');
                    createTable += ` PARTITION BY ${ptype}(${quoteIdent(table.partitionBy.column, 'partition column')})`;
                }
                sql.push(createTable);

                // Table Comments
                if (table.comment) sql.push(`COMMENT ON TABLE ${T} IS ${sqlLiteral(table.comment)}`);
                
                // Column Details (Comments, Indexes, Functional Triggers)
                for (const c of table.columns) {
                    const C = quoteIdent(c.name, 'column name');
                    if (c.comment) sql.push(`COMMENT ON COLUMN ${T}.${C} IS ${sqlLiteral(c.comment)}`);
                    if (c.index) {
                        const idxName = derivedName('idx', table.name, c.name);
                        sql.push(`CREATE INDEX IF NOT EXISTS ${quoteIdent(idxName, 'index name')} ON ${T} USING ${indexMethod(c.index.type)} (${C})`);
                    }
                    
                    if (c.strategy === 'FUNCTIONAL' && c.default) {
                        const trgName = derivedName('trg_func', table.name, c.name);
                        const fnName = derivedName('fn_func', table.name, c.name);
                        // Inside a trigger, bare column refs in the default expression must be
                        // qualified as NEW.<col> (e.g. generate_custom_id(region) -> generate_custom_id(NEW."region")).
                        const qualifiedDefault = this.qualifyColumnsForTrigger(assertSafeExpression(c.default, `column ${c.name} default`), table.columns);
                        sql.push(`CREATE OR REPLACE FUNCTION ${S}.${quoteIdent(fnName, 'function name')}() RETURNS TRIGGER AS $dffn$
                        BEGIN
                            IF NEW.${C} IS NULL THEN
                                NEW.${C} := ${qualifiedDefault};
                            END IF;
                            RETURN NEW;
                        END; $dffn$ LANGUAGE plpgsql;`);
                        sql.push(`DROP TRIGGER IF EXISTS ${quoteIdent(trgName, 'trigger name')} ON ${T}`);
                        sql.push(`CREATE TRIGGER ${quoteIdent(trgName, 'trigger name')} BEFORE INSERT ON ${T} FOR EACH ROW EXECUTE FUNCTION ${S}.${quoteIdent(fnName, 'function name')}()`);
                    }
                }

                // Maintenance (Skip for partitioned parents as they don't have physical storage)
                if (table.maintenance && !table.partitionBy) {
                    if (table.maintenance.autovacuum_enabled !== undefined) {
                        sql.push(`ALTER TABLE ${T} SET (autovacuum_enabled = ${table.maintenance.autovacuum_enabled ? 'true' : 'false'})`);
                    }
                    if (table.maintenance.fillfactor) {
                        sql.push(`ALTER TABLE ${T} SET (fillfactor = ${Math.trunc(sqlNumber(table.maintenance.fillfactor, 'fillfactor'))})`);
                    }
                }

                // Security
                if (table.security?.enable_rls) {
                    sql.push(`ALTER TABLE ${T} ENABLE ROW LEVEL SECURITY`);
                    if (table.security.policies) {
                        for (const pol of table.security.policies) {
                            const P = quoteIdent(pol.name, 'policy name');
                            sql.push(`DROP POLICY IF EXISTS ${P} ON ${T}`);
                            const roleList = (pol.roles ? (Array.isArray(pol.roles) ? pol.roles : [pol.roles]) : []) as string[];
                            for (const role of roleList) {
                                if (String(role).toUpperCase() !== 'PUBLIC') sql.push(createRoleSql(role));
                            }
                            const roles = roleList.length ? roleList.map(roleRef).join(', ') : 'PUBLIC';
                            sql.push(`CREATE POLICY ${P} ON ${T} FOR ALL TO ${roles} USING (${assertSafeExpression(pol.using, `policy ${pol.name}`)})`);
                        }
                    }
                }
                
                // Masking (Industrial Pattern)
                if (table.security?.masking) {
                    for (const mask of table.security.masking) {
                        sql.push(`-- MASKING APPLIED to ${assertIdent(mask.column, 'masking column')} for roles ${(mask.roles || []).map((r) => assertIdent(r, 'role')).join(', ')}: ${oneLine(assertSafeExpression(mask.expression, `masking ${mask.column}`))}`);
                    }
                }

                // Grants
                if (table.security?.grants) {
                    for (const grant of table.security.grants) {
                        const rolesList = grant.roles || (grant.role !== 'PUBLIC' && grant.role ? [grant.role] : []);
                        for (const role of rolesList) {
                            if (String(role).toUpperCase() !== 'PUBLIC') sql.push(createRoleSql(role));
                        }
                        const rolesStr = grant.role === 'PUBLIC' ? 'PUBLIC' : (grant.roles || (grant.role ? [grant.role] : [])).map(roleRef).join(', ');
                        if (!rolesStr) throw new ManifestSqlError('INVALID_GRANT', 'grant needs a role');
                        sql.push(`GRANT ${grant.privileges.map(grantPrivilege).join(', ')} ON TABLE ${T} TO ${rolesStr}`);
                    }
                }

                if (table.triggers) {
                    for (const trg of table.triggers) {
                        const trgSql = await this.callTriggerEngine(trg, physical, table.name, tenantId, freeSql);
                        sql.push(...trgSql);
                    }
                }
                break;

            case 'CREATE_VIEW':
            case 'CREATE_MATERIALIZED_VIEW':
                const view = diff as ViewDefinition;
                const V = `${S}.${quoteIdent(view.name, 'view name')}`;
                const viewQuery = QueryTranspiler.toSql(view.query, physical);
                if (view.materialized || view.type === 'MATERIALIZED_VIEW') {
                    sql.push(`DROP MATERIALIZED VIEW IF EXISTS ${V} CASCADE`);
                    sql.push(`CREATE MATERIALIZED VIEW ${V} AS ${viewQuery}`);
                    if (view.indexes) {
                        for (const idx of view.indexes) {
                            sql.push(`CREATE INDEX IF NOT EXISTS ${quoteIdent(derivedName('idx_mv', view.name, ...idx.columns), 'index name')} ON ${V} (${idx.columns.map(c => quoteIdent(c, 'index column')).join(', ')})`);
                        }
                    }
                } else {
                    if (view.federationStrategy === 'VIRTUAL') {
                        sql.push(`-- VIRTUAL VIEW ${assertIdent(view.name, 'view name')} registered in Fabric Engine, skipping Postgres CREATE VIEW`);
                    } else {
                        sql.push(`CREATE OR REPLACE VIEW ${V} AS ${viewQuery}`);
                    }
                }
                break;

            case 'PROVISION_RELATIONSHIP':
                const rel = diff as RelationshipDefinition;
                const fromRes = `${S}.${quoteIdent(rel.from.resource, 'relationship resource')}`;
                const toRes = `${S}.${quoteIdent(rel.to.resource, 'relationship resource')}`;
                const fromFld = quoteIdent(rel.from.field, 'relationship field');
                const toFld = quoteIdent(rel.to.field, 'relationship field');
                if (rel.cardinality === 'M:N' && rel.bridge && manifest) {
                    const fromType = this.normalizeType(this.findColumnType(manifest, rel.from.resource, rel.from.field));
                    const toType = this.normalizeType(this.findColumnType(manifest, rel.to.resource, rel.to.field));

                    const fromCol = `${rel.from.resource}_${rel.from.field}`;
                    const toCol = `${rel.to.resource}_${rel.to.field}`;
                    const B = `${S}.${quoteIdent(rel.bridge, 'bridge table')}`;
                    const fcq = quoteIdent(fromCol, 'bridge column');
                    const tcq = quoteIdent(toCol, 'bridge column');
                    if (rel.to.source || rel.from.source) {
                        // Cross-source M:N cannot enforce DB-level FK to remote engines.
                        sql.push(`CREATE TABLE IF NOT EXISTS ${B} (
                            ${fcq} ${fromType},
                            ${tcq} ${toType},
                            PRIMARY KEY (${fcq}, ${tcq})
                        )`);
                        const fkName = derivedName('fk', rel.name, 'from');
                        sql.push(`DO $dfdo$ BEGIN
                            IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = ${sqlLiteral(fkName)}) THEN
                                ALTER TABLE ${B} ADD CONSTRAINT ${quoteIdent(fkName, 'constraint name')} FOREIGN KEY (${fcq}) REFERENCES ${fromRes}(${fromFld});
                            END IF;
                        END $dfdo$;`);
                        sql.push(`-- FEDERATED RELATIONSHIP: ${assertIdent(rel.name, 'relationship name')} target side (${assertSourceLabel(rel.to.source || rel.from.source)}) enforced at Fabric layer`);
                    } else {
                        sql.push(`CREATE TABLE IF NOT EXISTS ${B} (
                            ${fcq} ${fromType} REFERENCES ${fromRes}(${fromFld}),
                            ${tcq} ${toType} REFERENCES ${toRes}(${toFld}),
                            PRIMARY KEY (${fcq}, ${tcq})
                        )`);
                    }
                } else if (rel.cardinality === '1:M' || rel.cardinality === '1:1') {
                    if (rel.from.source || rel.to.source) {
                        // Either side remote — can't enforce a DB-level FK across engines.
                        sql.push(`-- FEDERATED RELATIONSHIP: ${assertIdent(rel.name, 'relationship name')} (Cross-Source ${assertSourceLabel(rel.from.source) || 'local'} -> ${assertSourceLabel(rel.to.source) || 'local'})`);
                    } else {
                        // FK belongs on the CHILD ("to") side referencing the PARENT ("from") key,
                        // so the parent stays independently insertable (was inverted).
                        const fkName = derivedName('fk', rel.name);
                        sql.push(`DO $dfdo$ BEGIN
                            IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = ${sqlLiteral(fkName)}) THEN
                                ALTER TABLE ${toRes} ADD CONSTRAINT ${quoteIdent(fkName, 'constraint name')} FOREIGN KEY (${toFld}) REFERENCES ${fromRes}(${fromFld});
                            END IF;
                        END $dfdo$;`);
                    }
                }
                break;
            
            case 'PROVISION_DOWNSTREAM':
                const target = diff as any;
                sql.push(`-- PROVISION DOWNSTREAM: ${assertIdent(String(target.type || ''), 'downstream type')} (Enabled: ${target.enabled ? 'true' : 'false'}, Strategy: ${target.strategy ? assertIdent(String(target.strategy), 'strategy') : 'DEFAULT'})`);
                // Section 9.2: Registry update is handled by the Orchestrator.apply logic
                break;
        }

        return sql;
    }

    /** CREATE [OR REPLACE] FUNCTION/PROCEDURE for the hub. The body is free-form SQL: only compiled when the caller was allowed free SQL. */
    private static pgFunctionSql(fn: any, S: string, freeSql: boolean, manifest: MetadataManifest | undefined, logicalSchema: string): string {
        if (!freeSql) throw Object.assign(new ManifestSqlError('FREE_SQL_NOT_ALLOWED', `FREE_SQL_NOT_ALLOWED: ${String(fn.type || 'function').toLowerCase()} bodies are free-form SQL, which is not allowed for this account`), {});
        const customTypes = new Set<string>(manifest?.schemas.find(s => s.name === logicalSchema)?.resources.filter(r => r.type === 'ENUM').map(r => r.name) || []);
        const kind = fn.type === 'PROCEDURE' ? 'PROCEDURE' : 'FUNCTION';
        const rawArgs = fn.arguments || fn.parameters || [];
        const args = rawArgs.map((a: any) => `${quoteIdent(a.name, 'argument name')} ${argMode(a.mode)} ${customTypes.has(a.type) ? `${S}.${quoteIdent(a.type, 'type')}` : this.normalizeType(String(a.type))}`).join(', ') || '';
        const ret = fn.returnType ? `RETURNS ${customTypes.has(fn.returnType) ? `${S}.${quoteIdent(fn.returnType, 'type')}` : this.normalizeType(String(fn.returnType))}` : (kind === 'FUNCTION' ? 'RETURNS VOID' : '');

        // Industrial Safety: Ensure body is wrapped in BEGIN...END if using plpgsql
        let finalBody = assertDollarSafe(String(fn.body).trim(), '$dfbody$', `${kind.toLowerCase()} ${fn.name} body`);
        if (!finalBody.toUpperCase().startsWith('BEGIN')) {
            finalBody = `BEGIN\n    ${finalBody}\n    ${kind === 'FUNCTION' && !fn.returnType ? 'RETURN;' : ''}\nEND;`;
        }
        return `CREATE OR REPLACE ${kind} ${S}.${quoteIdent(fn.name, 'function name')}(${args}) ${ret} AS $dfbody$ ${finalBody} $dfbody$ LANGUAGE plpgsql`;
    }

    /** Qualify bare column references in a default expression as NEW."col" for trigger bodies. */
    private static qualifyColumnsForTrigger(expr: string, columns: ColumnDefinition[]): string {
        let out = expr;
        // Longer names first so a substring column (e.g. "id") doesn't clobber "custom_id".
        const names = columns.map(c => c.name).sort((a, b) => b.length - a.length);
        for (const name of names) {
            // Replace whole-word occurrences not already preceded by NEW./OLD./a dot or quote.
            const re = new RegExp(`(?<![\\w."])\\b${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b(?![\\w"])`, 'g');
            out = out.replace(re, `NEW.${quoteIdent(name, 'column name')}`);
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
                ops.push({ action: 'createCollection', name: assertIdent(diff.name, 'collection name') });
                if (diff.columns) {
                    for (const col of diff.columns) {
                        assertIdent(col.name, 'column name');
                        if (col.index || col.primaryKey || col.unique) {
                            ops.push({ action: 'createIndex', collection: diff.name, keys: { [col.name]: 1 }, options: { unique: !!(col.primaryKey || col.unique) } });
                        }
                    }
                }
                break;
            case 'DROP_TABLE':
                ops.push({ action: 'dropCollection', name: assertIdent(diff.name, 'collection name') });
                break;
            case 'ADD_COLUMN':
                if (diff.column.index || diff.column.unique) {
                    assertIdent(diff.table, 'collection name'); assertIdent(diff.column.name, 'column name');
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
    private static async callTriggerEngine(trigger: any, schemaName: string, tableName: string, tenantId?: string, allowFreeSql = false): Promise<string[]> {
        return TriggerService.transpileTriggerSql(trigger, schemaName, tableName, tenantId, { allowFreeSql });
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
        const schemaName = physicalSchemaName(tenantId, diff.schema || diff.name);
        const SB = bt(schemaName);
        const sql: string[] = [];

        switch (diff.action) {
            case 'CREATE_SCHEMA':
                sql.push(`CREATE DATABASE IF NOT EXISTS ${SB}`);
                break;

            case 'CREATE_TABLE': {
                const table = diff as TableDefinition;
                const cols = table.columns.map(c => {
                    let d = `${bt(c.name)} `;
                    if (c.strategy === 'UUID_V7') {
                        d += `CHAR(36) DEFAULT (UUID())`;
                    } else if (c.strategy === 'LEGACY_SERIAL' || c.strategy === 'IDENTITY_ALWAYS') {
                        d += `INT AUTO_INCREMENT`;
                    } else {
                        d += this.normalizeMysqlType(checkedType(c.type));
                        if (c.length && c.type.toUpperCase() === 'STRING') d = `${bt(c.name)} VARCHAR(${Math.trunc(sqlNumber(c.length, 'length'))})`;
                    }
                    if (c.primaryKey) d += ' PRIMARY KEY';
                    if (c.default && c.strategy !== 'UUID_V7' && c.strategy !== 'LEGACY_SERIAL') {
                        d += ` DEFAULT ${foreignDefault(c.default, 'mysql')}`;
                    }
                    if (c.unique && !c.primaryKey) d += ' UNIQUE';
                    if (c.nullable === false && !c.primaryKey) d += ' NOT NULL';
                    return d;
                });
                sql.push(`CREATE TABLE IF NOT EXISTS ${SB}.${bt(table.name)} (${cols.join(', ')}) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`);
                for (const c of table.columns) {
                    if (c.index && !c.primaryKey) {
                        sql.push(`CREATE INDEX ${bt(derivedName('idx', table.name, c.name))} ON ${SB}.${bt(table.name)} (${bt(c.name)})`);
                    }
                }
                break;
            }

            case 'ADD_COLUMN': {
                const col = diff.column;
                let colDef = `${bt(col.name)} ${this.normalizeMysqlType(checkedType(col.type))}`;
                if (col.nullable === false) colDef += ' NOT NULL';
                sql.push(`ALTER TABLE ${SB}.${bt(diff.table)} ADD COLUMN ${colDef}`);
                break;
            }

            case 'CREATE_VIEW': {
                const view = diff as ViewDefinition;
                const viewQuery = QueryTranspiler.toSql(view.query, schemaName);
                sql.push(`CREATE OR REPLACE VIEW ${SB}.${bt(view.name)} AS ${viewQuery}`);
                break;
            }

            case 'CREATE_FUNCTION':
            case 'CREATE_PROCEDURE': {
                const fn = diff as any;
                if (!allowsFreeSql(manifest)) throw new ManifestSqlError('FREE_SQL_NOT_ALLOWED', 'FREE_SQL_NOT_ALLOWED: function bodies are free-form SQL, which is not allowed for this account');
                const fnType = fn.type === 'PROCEDURE' ? 'PROCEDURE' : 'FUNCTION';
                const rawArgs = fn.arguments || fn.parameters || [];
                const args = rawArgs.map((a: any) => `${argMode(a.mode)} ${bt(a.name)} ${this.normalizeMysqlType(checkedType(a.type))}`).join(', ') || '';
                const ret = fnType === 'FUNCTION' ? `RETURNS ${this.normalizeMysqlType(checkedType(fn.returnType || 'TEXT'))}` : '';
                const deterministic = fn.volatility === 'IMMUTABLE' ? 'DETERMINISTIC' : 'NOT DETERMINISTIC';
                let body = String(fn.body).trim();
                if (body.includes('\0')) throw new ManifestSqlError('INVALID_BODY', 'NUL bytes are not allowed');
                if (!body.toUpperCase().startsWith('BEGIN')) body = `BEGIN\n    ${body}\nEND`;
                sql.push(`DROP ${fnType} IF EXISTS ${SB}.${bt(fn.name)}`);
                sql.push(`CREATE ${fnType} ${SB}.${bt(fn.name)}(${args}) ${ret} ${deterministic}\n${body}`);
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
        const schemaName = physicalSchemaName(tenantId, diff.schema || diff.name).toUpperCase();
        const SQ = quoteIdent(schemaName, 'schema');
        const sql: string[] = [];

        switch (diff.action) {
            case 'CREATE_SCHEMA':
                sql.push(`-- Oracle schema: CREATE USER ${SQ} handled by DBA/provisioning layer`);
                break;

            case 'CREATE_SEQUENCE': {
                const seq = diff as SequenceDefinition;
                let seqSql = `CREATE SEQUENCE ${SQ}.${quoteIdent(seq.name, 'sequence name')} START WITH ${sqlNumber(seq.start || 1, 'start')} INCREMENT BY ${sqlNumber(seq.increment || 1, 'increment')}`;
                if (seq.minValue) seqSql += ` MINVALUE ${sqlNumber(seq.minValue, 'minValue')}`;
                if (seq.maxValue) seqSql += ` MAXVALUE ${sqlNumber(seq.maxValue, 'maxValue')}`;
                if (seq.cache) seqSql += ` CACHE ${sqlNumber(seq.cache, 'cache')}`;
                sql.push(seqSql);
                break;
            }

            case 'CREATE_TABLE': {
                const table = diff as TableDefinition;
                const cols = table.columns.map(c => {
                    let d = `${quoteIdent(c.name, 'column name')} `;
                    if (c.strategy === 'UUID_V7') d += `RAW(16) DEFAULT SYS_GUID()`;
                    else if (c.strategy === 'IDENTITY_ALWAYS') d += `NUMBER GENERATED ALWAYS AS IDENTITY`;
                    else if (c.strategy === 'LEGACY_SERIAL') d += `NUMBER GENERATED BY DEFAULT AS IDENTITY`;
                    else {
                        d += this.normalizeOracleType(checkedType(c.type));
                        if (c.length && c.type.toUpperCase() === 'STRING') d = `${quoteIdent(c.name, 'column name')} VARCHAR2(${Math.trunc(sqlNumber(c.length, 'length'))})`;
                    }
                    if (c.primaryKey) d += ' PRIMARY KEY';
                    if (c.default && !['UUID_V7', 'IDENTITY_ALWAYS', 'LEGACY_SERIAL'].includes(c.strategy || '')) {
                        d += ` DEFAULT ${foreignDefault(c.default, 'oracle')}`;
                    }
                    if (c.unique && !c.primaryKey) d += ' UNIQUE';
                    if (c.nullable === false && !c.primaryKey) d += ' NOT NULL';
                    return d;
                });
                sql.push(`CREATE TABLE ${SQ}.${quoteIdent(table.name, 'table name')} (${cols.join(', ')})`);
                for (const c of table.columns) {
                    if (c.index && !c.primaryKey) {
                        sql.push(`CREATE INDEX ${quoteIdent(derivedName('IDX', table.name, c.name), 'index name')} ON ${SQ}.${quoteIdent(table.name, 'table name')} (${quoteIdent(c.name, 'column name')})`);
                    }
                }
                break;
            }

            case 'ADD_COLUMN': {
                const col = diff.column;
                let colDef = `${quoteIdent(col.name, 'column name')} ${this.normalizeOracleType(checkedType(col.type))}`;
                if (col.nullable === false) colDef += ' NOT NULL';
                sql.push(`ALTER TABLE ${SQ}.${quoteIdent(diff.table, 'table name')} ADD (${colDef})`);
                break;
            }

            case 'CREATE_VIEW': {
                const view = diff as ViewDefinition;
                const viewQuery = QueryTranspiler.toSql(view.query, schemaName);
                sql.push(`CREATE OR REPLACE VIEW ${SQ}.${quoteIdent(view.name, 'view name')} AS ${viewQuery}`);
                break;
            }

            case 'CREATE_MATERIALIZED_VIEW': {
                const view = diff as ViewDefinition;
                const viewQuery = QueryTranspiler.toSql(view.query, schemaName);
                sql.push(`CREATE MATERIALIZED VIEW ${SQ}.${quoteIdent(view.name, 'view name')} AS ${viewQuery}`);
                break;
            }

            case 'CREATE_FUNCTION':
            case 'CREATE_PROCEDURE': {
                const fn = diff as any;
                if (!allowsFreeSql(manifest)) throw new ManifestSqlError('FREE_SQL_NOT_ALLOWED', 'FREE_SQL_NOT_ALLOWED: function bodies are free-form SQL, which is not allowed for this account');
                const fnType = fn.type === 'PROCEDURE' ? 'PROCEDURE' : 'FUNCTION';
                const rawArgs = fn.arguments || fn.parameters || [];
                const args = rawArgs.map((a: any) => `${quoteIdent(a.name, 'argument name')} ${argMode(a.mode)} ${this.normalizeOracleType(checkedType(a.type))}`).join(', ') || '';
                const ret = fnType === 'FUNCTION' ? `RETURN ${this.normalizeOracleType(checkedType(fn.returnType || 'VARCHAR2(4000)'))}` : '';
                let body = String(fn.body).trim();
                if (body.includes('\0')) throw new ManifestSqlError('INVALID_BODY', 'NUL bytes are not allowed');
                if (!body.toUpperCase().startsWith('BEGIN')) body = `BEGIN\n    ${body}\nEND;`;
                sql.push(`CREATE OR REPLACE ${fnType} ${SQ}.${quoteIdent(fn.name, 'function name')}(${args}) ${ret} IS\n${body}`);
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
        const schemaName = `TENANT_${assertTenantId(tenantId)}_${assertIdent(diff.schema || diff.name, 'schema')}`.toUpperCase();
        const SQ = quoteIdent(schemaName, 'schema');
        const sql: string[] = [];

        switch (diff.action) {
            case 'CREATE_SCHEMA':
                sql.push(`CREATE SCHEMA IF NOT EXISTS ${SQ}`);
                break;

            case 'CREATE_SEQUENCE': {
                const seq = diff as SequenceDefinition;
                sql.push(`CREATE SEQUENCE IF NOT EXISTS ${SQ}.${quoteIdent(seq.name, 'sequence name')} START = ${sqlNumber(seq.start || 1, 'start')} INCREMENT = ${sqlNumber(seq.increment || 1, 'increment')}`);
                break;
            }

            case 'CREATE_TABLE': {
                const table = diff as TableDefinition;
                const cols = table.columns.map(c => {
                    let d = `${quoteIdent(c.name, 'column name')} `;
                    if (c.strategy === 'UUID_V7') d += `VARCHAR(36) DEFAULT UUID_STRING()`;
                    else if (c.strategy === 'IDENTITY_ALWAYS') d += `INTEGER AUTOINCREMENT`;
                    else if (c.strategy === 'LEGACY_SERIAL') d += `INTEGER AUTOINCREMENT`;
                    else {
                        d += this.normalizeSnowflakeType(checkedType(c.type));
                        if (c.length && c.type.toUpperCase() === 'STRING') d = `${quoteIdent(c.name, 'column name')} VARCHAR(${Math.trunc(sqlNumber(c.length, 'length'))})`;
                    }
                    if (c.primaryKey) d += ' PRIMARY KEY';
                    if (c.default && !['UUID_V7', 'IDENTITY_ALWAYS', 'LEGACY_SERIAL'].includes(c.strategy || '')) {
                        d += ` DEFAULT ${foreignDefault(c.default, 'snowflake')}`;
                    }
                    if (c.unique && !c.primaryKey) d += ' UNIQUE';
                    if (c.nullable === false && !c.primaryKey) d += ' NOT NULL';
                    return d;
                });
                sql.push(`CREATE TABLE IF NOT EXISTS ${SQ}.${quoteIdent(table.name, 'table name')} (${cols.join(', ')})`);
                break;
            }

            case 'ADD_COLUMN': {
                const col = diff.column;
                let colDef = `${quoteIdent(col.name, 'column name')} ${this.normalizeSnowflakeType(checkedType(col.type))}`;
                if (col.nullable === false) colDef += ' NOT NULL';
                sql.push(`ALTER TABLE ${SQ}.${quoteIdent(diff.table, 'table name')} ADD COLUMN ${colDef}`);
                break;
            }

            case 'CREATE_VIEW': {
                const view = diff as ViewDefinition;
                const viewQuery = QueryTranspiler.toSql(view.query, schemaName);
                sql.push(`CREATE OR REPLACE VIEW ${SQ}.${quoteIdent(view.name, 'view name')} AS ${viewQuery}`);
                break;
            }

            case 'CREATE_FUNCTION':
            case 'CREATE_PROCEDURE': {
                const fn = diff as any;
                if (!allowsFreeSql(manifest)) throw new ManifestSqlError('FREE_SQL_NOT_ALLOWED', 'FREE_SQL_NOT_ALLOWED: function bodies are free-form SQL, which is not allowed for this account');
                const fnType = fn.type === 'PROCEDURE' ? 'PROCEDURE' : 'FUNCTION';
                const rawArgs = fn.arguments || fn.parameters || [];
                const args = rawArgs.map((a: any) => `${quoteIdent(a.name, 'argument name')} ${this.normalizeSnowflakeType(checkedType(a.type))}`).join(', ') || '';
                const ret = fnType === 'FUNCTION' ? `RETURNS ${this.normalizeSnowflakeType(checkedType(fn.returnType || 'VARCHAR'))}` : '';
                let body = String(fn.body).trim();
                sql.push(`CREATE OR REPLACE ${fnType} ${SQ}.${quoteIdent(fn.name, 'function name')}(${args}) ${ret} LANGUAGE SQL AS ${sqlLiteral(body)}`);
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
                        properties[assertIdent(col.name, 'column name')] = { type: esTypeMap[col.type?.toUpperCase()] || 'keyword' };
                    }
                }
                ops.push({
                    action: 'createIndex',
                    name: `${assertTenantId(tenantId)}_${assertIdent(diff.name, 'index name')}`.toLowerCase(),
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
        const tid = assertTenantId(tenantId);

        switch (diff.action) {
            case 'REGISTER_FABRIC_SEQUENCE': {
                const seq = diff as SequenceDefinition;
                const inc = sqlNumber(seq.increment || 1, 'increment');
                sql.push(`INSERT INTO fabric_system.fabric_sequences (tenant_id, name, current_value, increment)
                    VALUES (${sqlLiteral(tid)}, ${sqlLiteral(assertIdent(seq.name, 'sequence name'))}, ${sqlNumber(seq.start || 1, 'start') - inc}, ${inc})
                    ON CONFLICT (tenant_id, name) DO NOTHING`);
                break;
            }

            case 'REGISTER_HUB_FUNCTION': {
                const physical = physicalSchemaName(tid, diff.schema);
                sql.push(`CREATE SCHEMA IF NOT EXISTS ${quoteIdent(physical, 'schema')}`);
                sql.push(this.pgFunctionSql({ ...diff, type: diff.type === 'PROCEDURE' ? 'PROCEDURE' : 'FUNCTION' }, quoteIdent(physical, 'schema'), allowsFreeSql(manifest), manifest, diff.schema));
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
                    VALUES (${sqlLiteral(tid)}, ${sqlLiteral(assertIdent(diff.schema, 'schema'))}, ${sqlLiteral(assertIdent(enumDef.name, 'enum name'))}, ${sqlLiteral(valuesJson)}::jsonb, ${sqlLiteral(assertSourceLabel(diff.targetSource))}, ${sqlLiteral(String(diff.engineType || '').replace(/[^A-Z_]/g, ''))})
                    ON CONFLICT (tenant_id, schema_name, enum_name) DO UPDATE SET allowed_values = EXCLUDED.allowed_values`);
                break;
            }

            case 'REGISTER_VIRTUAL_VIEW': {
                const view = diff as any;
                const queryJson = JSON.stringify(view.query);
                sql.push(`CREATE TABLE IF NOT EXISTS fabric_system.virtual_views (
                    tenant_id TEXT NOT NULL, schema_name TEXT NOT NULL, view_name TEXT NOT NULL,
                    query_ast JSONB NOT NULL, target_source TEXT, target_engine TEXT, materialized BOOLEAN DEFAULT FALSE,
                    PRIMARY KEY (tenant_id, schema_name, view_name))`);
                sql.push(`INSERT INTO fabric_system.virtual_views (tenant_id, schema_name, view_name, query_ast, target_source, target_engine, materialized)
                    VALUES (${sqlLiteral(tid)}, ${sqlLiteral(assertIdent(diff.schema, 'schema'))}, ${sqlLiteral(assertIdent(view.name, 'view name'))}, ${sqlLiteral(queryJson)}::jsonb, ${sqlLiteral(assertSourceLabel(diff.targetSource))}, ${sqlLiteral(String(diff.engineType || '').replace(/[^A-Z_]/g, ''))}, ${view.materialized ? 'TRUE' : 'FALSE'})
                    ON CONFLICT (tenant_id, schema_name, view_name) DO UPDATE SET query_ast = EXCLUDED.query_ast`);
                break;
            }
        }
        return sql;
    }
}
