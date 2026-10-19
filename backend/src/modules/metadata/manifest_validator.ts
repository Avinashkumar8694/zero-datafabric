/**
 * Manifest validator: the single gate every manifest passes before it is diffed,
 * planned, applied, rolled back or imported.
 *
 * A manifest is applied as the database owner, so everything that can reach a
 * statement is checked here (names, types, defaults, expressions, view ASTs,
 * function bodies) and every schema is confined to the caller's tenant
 * namespace (`tenant_<id>_<logical>`). Free-form SQL (function/procedure bodies,
 * raw `expression` entries inside view ASTs) is only accepted for platform admins
 * or when the workspace owner has been explicitly allowed; everyone else gets
 * `FREE_SQL_NOT_ALLOWED` ("AST only, no SQL execution").
 */
import { assertIdent, assertTenantId, belongsToTenant, IdentifierError } from '../../utils/identifiers';
import { validateAst, SqlGuardError } from '../../utils/sqlGuard';
import { validateManifestTrigger } from '../triggers/trigger_validator';
import { assertColumnType, assertSafeExpression, isEnumPlaceholderType, ManifestSqlError, printable, renderDefault } from './sql_safety';

export interface ManifestIssue { code: string; path: string; message: string }

export class ManifestValidationError extends Error {
    status = 400;
    code: string;
    constructor(public issues: ManifestIssue[]) {
        const head = issues.slice(0, 8).map((i) => `${i.path || '$'}: ${i.message} [${i.code}]`).join('; ');
        super(`Manifest Validation failed (${issues.length} issue${issues.length === 1 ? '' : 's'}): ${head}${issues.length > 8 ? '; ...' : ''}`);
        this.code = issues[0]?.code || 'INVALID_MANIFEST';
    }
}

export interface ValidateOptions {
    /** Tenant the manifest is applied for; every schema is confined to `tenant_<id>_*`. */
    tenantId: string;
    /** Platform admin, or workspace owner explicitly allowed: function bodies / raw view expressions are accepted. */
    allowFreeSql?: boolean;
}

/** Physical Postgres identifier limit (longer names are silently truncated, which could alias another object). */
const MAX_IDENT = 63;
/** Logical schema / resource names are validated more strictly than raw identifiers and are never physical-looking. */
const RESERVED_SCHEMAS = /^(public|information_schema|pg_.*|fabric_.*|citus.*|metadata_catalog|admin_functions|auth|cron|pgbouncer|postgres|template\d*)$/i;
const SOURCE_NAME = /^[A-Za-z]([A-Za-z0-9 _-]{0,46}[A-Za-z0-9_-])?$/;
const EXTENSION_ALLOW = new Set(['uuid-ossp', 'pg_stat_statements', 'pgcrypto', 'btree_gist', 'btree_gin', 'pg_trgm', 'citext', 'hstore', 'ltree', 'unaccent', 'fuzzystrmatch', 'tablefunc', 'intarray']);
const RESERVED_ROLES = /^(postgres|fabric_admin|authenticator|web_anon|pg_.*|citus.*|public)$/i;

const TOP_KEYS = new Set(['version', 'namespace', 'targetSource', 'consistencyMode', 'downstream', 'extensions', 'schemas', 'relationships', 'exportedAt', 'warnings', 'description', 'name']);
const SCHEMA_KEYS = new Set(['name', 'targetSource', 'resources', 'enums', 'sequences', 'functions', 'procedures', 'tables', 'views', 'description', 'comment']);
const RESOURCE_KEYS: Record<string, Set<string>> = {
    ENUM: new Set(['type', 'name', 'values', 'comment', 'description']),
    SEQUENCE: new Set(['type', 'name', 'start', 'increment', 'minValue', 'maxValue', 'cache', 'ownedBy', 'strategy', 'generator', 'comment', 'description']),
    TABLE: new Set(['type', 'name', 'comment', 'description', 'version', 'partitionBy', 'identity', 'maintenance', 'columns', 'constraints', 'triggers', 'security', 'definitionSql']),
    VIEW: new Set(['type', 'name', 'query', 'recursive', 'materialized', 'refreshStrategy', 'refreshInterval', 'indexes', 'federationStrategy', 'definitionSql', 'comment', 'description']),
    FUNCTION: new Set(['type', 'name', 'arguments', 'parameters', 'returnType', 'body', 'language', 'volatility', 'definitionSql', 'comment', 'description']),
};
RESOURCE_KEYS.MATERIALIZED_VIEW = RESOURCE_KEYS.VIEW as Set<string>;
RESOURCE_KEYS.PROCEDURE = RESOURCE_KEYS.FUNCTION as Set<string>;
const COLUMN_KEYS = new Set(['name', 'type', 'length', 'primaryKey', 'unique', 'default', 'strategy', 'generated', 'stored', 'nullable', 'index', 'comment', 'ref', 'collation', 'readonly', 'description']);
const FORBIDDEN_KEYS = new Set(['__proto__', 'constructor', 'prototype']);
const COLUMN_STRATEGIES = new Set(['UUID_V7', 'IDENTITY_ALWAYS', 'LEGACY_SERIAL', 'FUNCTIONAL', 'SOFT_DELETE']);
const INDEX_TYPES = new Set(['BTREE', 'GIN', 'BRIN', 'GIST', 'HASH']);
const PRIVILEGES = new Set(['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER', 'ALL', 'ALL PRIVILEGES', 'USAGE']);
const REL_CARD = new Set(['1:1', '1:M', 'M:N']);
const LIMITS = { schemas: 50, resources: 500, columns: 500, triggers: 50, constraints: 100, rels: 500, depth: 25 };

type Ctx = { opts: ValidateOptions; issues: ManifestIssue[] };

function add(ctx: Ctx, code: string, path: string, message: string) {
    if (ctx.issues.length < 100) ctx.issues.push({ code, path, message });
}

function isObj(x: any): x is Record<string, any> { return !!x && typeof x === 'object' && !Array.isArray(x); }

/** Fail on `__proto__` / `constructor` / `prototype` keys anywhere (prototype-pollution corpus). */
function scanForbiddenKeys(node: any, path: string, ctx: Ctx, depth = 0) {
    if (depth > LIMITS.depth) { add(ctx, 'TOO_DEEP', path, 'nested too deeply'); return; }
    if (Array.isArray(node)) { node.forEach((v, i) => scanForbiddenKeys(v, `${path}[${i}]`, ctx, depth + 1)); return; }
    if (isObj(node)) {
        for (const k of Object.getOwnPropertyNames(node)) {
            if (FORBIDDEN_KEYS.has(k)) add(ctx, 'FORBIDDEN_KEY', path, `key "${k}" is not allowed`);
            scanForbiddenKeys(node[k], `${path}.${k}`, ctx, depth + 1);
        }
    }
}

function checkKeys(obj: Record<string, any>, allowed: Set<string>, path: string, ctx: Ctx) {
    const unknown = Object.keys(obj).filter((k) => !allowed.has(k));
    if (unknown.length) add(ctx, 'UNKNOWN_KEYS', path, `unknown key(s): ${unknown.map((k) => printable(k, 40)).join(', ')}`);
}

function ident(v: any, what: string, path: string, ctx: Ctx, max = MAX_IDENT): string | null {
    try {
        const s = assertIdent(v, what);
        if (s.length > max) throw new IdentifierError(`${what} is longer than ${max} characters`);
        return s;
    } catch (e: any) {
        add(ctx, 'INVALID_IDENTIFIER', path, `${what}: ${e.message}${typeof v === 'string' ? ` (got "${printable(v, 40)}")` : ''}`);
        return null;
    }
}

function freeSql(ctx: Ctx, path: string, what: string): boolean {
    if (ctx.opts.allowFreeSql) return true;
    add(ctx, 'FREE_SQL_NOT_ALLOWED', path, `${what} is free-form SQL, which is not allowed for this account (use the AST form, or ask a platform admin)`);
    return false;
}

function expr(v: any, what: string, path: string, ctx: Ctx, opts = {}, code = 'UNSAFE_EXPRESSION') {
    try { assertSafeExpression(v, what, opts, code); } catch (e: any) { add(ctx, e.code || code, path, e.message); }
}

function role(v: any, path: string, ctx: Ctx) {
    if (typeof v === 'string' && v.toUpperCase() === 'PUBLIC') return;
    const r = ident(v, 'role', path, ctx);
    if (r && RESERVED_ROLES.test(r)) add(ctx, 'RESERVED_ROLE', path, `role "${r}" cannot be used in a manifest`);
}

/* ------------------------------ view / query ----------------------------- */

function scanFreeSqlInQuery(q: any, path: string, ctx: Ctx, depth = 0) {
    if (!isObj(q) || depth > 12) return;
    for (const k of ['select', 'where']) {
        if (Array.isArray(q[k])) q[k].forEach((e: any, i: number) => { if (isObj(e) && e.expression != null) freeSql(ctx, `${path}.${k}[${i}].expression`, 'query expression'); });
    }
    if (Array.isArray(q.joins)) q.joins.forEach((j: any, i: number) => { if (typeof j?.on === 'string') freeSql(ctx, `${path}.joins[${i}].on`, 'join condition'); });
    for (const k of ['union', 'intersect', 'except']) if (Array.isArray(q[k])) q[k].forEach((leg: any, i: number) => scanFreeSqlInQuery(leg, `${path}.${k}[${i}]`, ctx, depth + 1));
    if (Array.isArray(q.with)) q.with.forEach((c: any, i: number) => { scanFreeSqlInQuery(c?.base, `${path}.with[${i}].base`, ctx, depth + 1); scanFreeSqlInQuery(c?.unionAll, `${path}.with[${i}].unionAll`, ctx, depth + 1); });
}

/** Strict (plain identifier) names for everything in a view AST that becomes a table/alias/CTE/column reference. */
function checkQueryNames(q: any, path: string, ctx: Ctx, depth = 0) {
    if (!isObj(q) || depth > 12) return;
    const colPath = (v: any, p: string) => {
        if (v === '*') return;
        if (typeof v !== 'string') { add(ctx, 'INVALID_IDENTIFIER', p, 'column reference must be a string'); return; }
        const parts = v.split('.');
        if (parts.length > 3) { add(ctx, 'INVALID_IDENTIFIER', p, 'column path has too many segments'); return; }
        parts.forEach((part, i) => { if (!(part === '*' && i === parts.length - 1 && parts.length > 1)) ident(part, 'column reference', p, ctx); });
    };
    if (q.from !== undefined) {
        if (!isObj(q.from)) add(ctx, 'INVALID_QUERY', `${path}.from`, 'from must be an object');
        else { ident(q.from.resource, 'from.resource', `${path}.from.resource`, ctx); if (q.from.alias != null) ident(q.from.alias, 'from.alias', `${path}.from.alias`, ctx); }
    }
    (Array.isArray(q.joins) ? q.joins : []).forEach((j: any, i: number) => {
        const jp = `${path}.joins[${i}]`;
        if (!isObj(j)) return;
        ident(j.resource, 'join.resource', `${jp}.resource`, ctx);
        if (j.alias != null) ident(j.alias, 'join.alias', `${jp}.alias`, ctx);
        if (isObj(j.on)) { colPath(j.on.left, `${jp}.on.left`); colPath(j.on.right, `${jp}.on.right`); }
    });
    (Array.isArray(q.select) ? q.select : []).forEach((c: any, i: number) => {
        const cp = `${path}.select[${i}]`;
        if (typeof c === 'string') { colPath(c, cp); return; }
        if (!isObj(c)) return;
        if (c.column != null) colPath(c.column, `${cp}.column`);
        if (c.alias != null) ident(c.alias, 'select.alias', `${cp}.alias`, ctx);
        (Array.isArray(c.partitionBy) ? c.partitionBy : []).forEach((x: any, j: number) => colPath(x, `${cp}.partitionBy[${j}]`));
        (Array.isArray(c.orderBy) ? c.orderBy : []).forEach((o: any, j: number) => colPath(o?.column, `${cp}.orderBy[${j}].column`));
    });
    (Array.isArray(q.where) ? q.where : []).forEach((w: any, i: number) => {
        if (!isObj(w) || w.expression != null) return;
        if (w.search) colPath(w.search.column, `${path}.where[${i}].search.column`); else colPath(w.column, `${path}.where[${i}].column`);
    });
    (Array.isArray(q.groupBy) ? q.groupBy : []).forEach((g: any, i: number) => colPath(g, `${path}.groupBy[${i}]`));
    (Array.isArray(q.orderBy) ? q.orderBy : []).forEach((o: any, i: number) => colPath(o?.column, `${path}.orderBy[${i}].column`));
    (Array.isArray(q.with) ? q.with : []).forEach((c: any, i: number) => {
        const cp = `${path}.with[${i}]`;
        if (!isObj(c)) return;
        ident(c.name, 'with.name', `${cp}.name`, ctx);
        (Array.isArray(c.columns) ? c.columns : []).forEach((x: any, j: number) => ident(x, 'with.columns', `${cp}.columns[${j}]`, ctx));
        checkQueryNames(c.base, `${cp}.base`, ctx, depth + 1);
        checkQueryNames(c.unionAll, `${cp}.unionAll`, ctx, depth + 1);
    });
    for (const k of ['union', 'intersect', 'except']) if (Array.isArray(q[k])) q[k].forEach((leg: any, i: number) => checkQueryNames(leg, `${path}.${k}[${i}]`, ctx, depth + 1));
}

function validateQuery(q: any, path: string, ctx: Ctx) {
    if (!isObj(q)) { add(ctx, 'INVALID_QUERY', path, 'view query must be an object (AST)'); return; }
    scanFreeSqlInQuery(q, path, ctx);
    const checkSources = (node: any, p: string, depth = 0) => {
        if (!isObj(node) || depth > 12) return;
        if (node.from?.source != null && (typeof node.from.source !== 'string' || !SOURCE_NAME.test(node.from.source))) add(ctx, 'INVALID_SOURCE_NAME', `${p}.from.source`, 'invalid data source name');
        if (Array.isArray(node.joins)) node.joins.forEach((j: any, i: number) => { if (j?.source != null && (typeof j.source !== 'string' || !SOURCE_NAME.test(j.source))) add(ctx, 'INVALID_SOURCE_NAME', `${p}.joins[${i}].source`, 'invalid data source name'); });
        for (const k of ['union', 'intersect', 'except']) if (Array.isArray(node[k])) node[k].forEach((leg: any, i: number) => checkSources(leg, `${p}.${k}[${i}]`, depth + 1));
        if (Array.isArray(node.with)) node.with.forEach((c: any, i: number) => { checkSources(c?.base, `${p}.with[${i}].base`, depth + 1); checkSources(c?.unionAll, `${p}.with[${i}].unionAll`, depth + 1); });
    };
    checkSources(q, path);
    checkQueryNames(q, path, ctx);
    try {
        validateAst(q, ctx.opts.tenantId);
    } catch (e: any) {
        // Only the structural complaints that are not already reported as FREE_SQL_NOT_ALLOWED
        add(ctx, e instanceof SqlGuardError ? 'INVALID_QUERY' : (e.code || 'INVALID_QUERY'), path, e.message);
    }
}

/* -------------------------------- resources ------------------------------ */

function validateColumn(c: any, p: string, ctx: Ctx, enumNames: Set<string>) {
    if (!isObj(c)) { add(ctx, 'INVALID_COLUMN', p, 'column must be an object'); return; }
    checkKeys(c, COLUMN_KEYS, p, ctx);
    ident(c.name, 'column name', `${p}.name`, ctx);
    if (isEnumPlaceholderType(c.type)) {
        if (typeof c.ref !== 'string' || !enumNames.has(c.ref)) add(ctx, 'UNKNOWN_ENUM', `${p}.ref`, 'ENUM column must reference an enum declared in the same schema');
    } else {
        try { assertColumnType(c.type, `${p}.type`, enumNames); } catch (e: any) { add(ctx, e.code || 'INVALID_COLUMN_TYPE', `${p}.type`, e.message); }
    }
    if (c.ref != null && !ident(c.ref, 'enum reference', `${p}.ref`, ctx)) { /* reported */ }
    if (c.length != null && !(Number.isInteger(c.length) && c.length > 0 && c.length <= 1_000_000)) add(ctx, 'INVALID_LENGTH', `${p}.length`, 'length must be a positive integer');
    if (c.strategy != null && !COLUMN_STRATEGIES.has(c.strategy)) add(ctx, 'INVALID_STRATEGY', `${p}.strategy`, `strategy must be one of ${[...COLUMN_STRATEGIES].join(', ')}`);
    if (c.default != null) {
        try { renderDefault(c.default, `${p}.default`); } catch (e: any) { add(ctx, e.code || 'UNSAFE_DEFAULT', `${p}.default`, e.message); }
    }
    if (c.generated != null) expr(c.generated, `${p}.generated`, `${p}.generated`, ctx, {}, 'UNSAFE_EXPRESSION');
    if (c.collation != null && (typeof c.collation !== 'string' || !/^[A-Za-z0-9_.@-]{1,63}$/.test(c.collation))) add(ctx, 'INVALID_COLLATION', `${p}.collation`, 'collation must match [A-Za-z0-9_.@-]{1,63}');
    if (c.comment != null && (typeof c.comment !== 'string' || c.comment.length > 2000 || c.comment.includes('\0'))) add(ctx, 'INVALID_COMMENT', `${p}.comment`, 'comment must be a string up to 2000 chars without NUL bytes');
    if (c.index != null && c.index !== true && c.index !== false) {
        if (!isObj(c.index) || (c.index.type != null && !INDEX_TYPES.has(String(c.index.type).toUpperCase()))) add(ctx, 'INVALID_INDEX', `${p}.index`, `index.type must be one of ${[...INDEX_TYPES].join(', ')}`);
    }
}

function validateTrigger(t: any, p: string, ctx: Ctx) {
    try { validateManifestTrigger(t, { allowFreeSql: !!ctx.opts.allowFreeSql }); } catch (e: any) { add(ctx, e.code || 'INVALID_TRIGGER', p, e.message); }
}

function validateTable(r: any, p: string, ctx: Ctx, enumNames: Set<string>) {
    if (!Array.isArray(r.columns) || r.columns.length === 0) add(ctx, 'INVALID_TABLE', `${p}.columns`, 'a table needs at least one column');
    else if (r.columns.length > LIMITS.columns) add(ctx, 'TOO_MANY', `${p}.columns`, `at most ${LIMITS.columns} columns`);
    const colNames = new Set<string>();
    (Array.isArray(r.columns) ? r.columns : []).forEach((c: any, i: number) => {
        validateColumn(c, `${p}.columns[${i}]`, ctx, enumNames);
        if (isObj(c) && typeof c.name === 'string') {
            if (colNames.has(c.name)) add(ctx, 'DUPLICATE_NAME', `${p}.columns[${i}].name`, `duplicate column "${c.name}"`);
            colNames.add(c.name);
        }
    });
    if (r.comment != null && (typeof r.comment !== 'string' || r.comment.length > 2000 || r.comment.includes('\0'))) add(ctx, 'INVALID_COMMENT', `${p}.comment`, 'comment must be a string up to 2000 chars without NUL bytes');
    if (r.partitionBy != null) {
        if (!isObj(r.partitionBy) || !['RANGE', 'LIST'].includes(String(r.partitionBy.type)) ) add(ctx, 'INVALID_PARTITION', `${p}.partitionBy`, 'partitionBy.type must be RANGE or LIST');
        else ident(r.partitionBy.column, 'partition column', `${p}.partitionBy.column`, ctx);
    }
    if (r.identity != null) {
        if (!isObj(r.identity) || r.identity.type !== 'PRIMARY_KEY' || !Array.isArray(r.identity.columns) || !r.identity.columns.length) add(ctx, 'INVALID_IDENTITY', `${p}.identity`, 'identity must be { type: PRIMARY_KEY, columns: [...] }');
        else r.identity.columns.forEach((c: any, i: number) => ident(c, 'identity column', `${p}.identity.columns[${i}]`, ctx));
    }
    if (r.maintenance != null) {
        const m = r.maintenance;
        if (!isObj(m)) add(ctx, 'INVALID_MAINTENANCE', `${p}.maintenance`, 'must be an object');
        else {
            checkKeys(m, new Set(['autovacuum_enabled', 'fillfactor']), `${p}.maintenance`, ctx);
            if (m.autovacuum_enabled != null && typeof m.autovacuum_enabled !== 'boolean') add(ctx, 'INVALID_MAINTENANCE', `${p}.maintenance.autovacuum_enabled`, 'must be boolean');
            if (m.fillfactor != null && !(Number.isInteger(m.fillfactor) && m.fillfactor >= 10 && m.fillfactor <= 100)) add(ctx, 'INVALID_MAINTENANCE', `${p}.maintenance.fillfactor`, 'must be an integer between 10 and 100');
        }
    }
    if (r.constraints != null) {
        if (!Array.isArray(r.constraints) || r.constraints.length > LIMITS.constraints) add(ctx, 'INVALID_CONSTRAINTS', `${p}.constraints`, `must be an array of up to ${LIMITS.constraints}`);
        else r.constraints.forEach((con: any, i: number) => {
            const cp = `${p}.constraints[${i}]`;
            if (!isObj(con)) { add(ctx, 'INVALID_CONSTRAINT', cp, 'must be an object'); return; }
            checkKeys(con, new Set(['name', 'type', 'expression', 'using', 'columns']), cp, ctx);
            ident(con.name, 'constraint name', `${cp}.name`, ctx);
            if (!['CHECK', 'EXCLUDE', 'FOREIGN_KEY'].includes(con.type)) add(ctx, 'INVALID_CONSTRAINT', `${cp}.type`, 'type must be CHECK, EXCLUDE or FOREIGN_KEY');
            if (con.type === 'CHECK') expr(con.expression, `${cp}.expression`, `${cp}.expression`, ctx, {}, 'UNSAFE_EXPRESSION');
            if (con.type === 'EXCLUDE') {
                if (!['GIST', 'GIN', 'BTREE', 'HASH', 'SPGIST', 'BRIN'].includes(String(con.using).toUpperCase())) add(ctx, 'INVALID_CONSTRAINT', `${cp}.using`, 'using must be an index method (GIST, ...)');
                if (!Array.isArray(con.columns) || !con.columns.length) add(ctx, 'INVALID_CONSTRAINT', `${cp}.columns`, 'EXCLUDE needs columns');
                else con.columns.forEach((cc: any, j: number) => {
                    ident(cc?.name, 'constraint column', `${cp}.columns[${j}].name`, ctx);
                    if (!['=', '&&', '<>', '<', '>', '<=', '>=', '@>', '<@', '-|-'].includes(String(cc?.operator))) add(ctx, 'INVALID_OPERATOR', `${cp}.columns[${j}].operator`, 'operator not allowed');
                });
            }
        });
    }
    if (r.triggers != null) {
        if (!Array.isArray(r.triggers) || r.triggers.length > LIMITS.triggers) add(ctx, 'INVALID_TRIGGERS', `${p}.triggers`, `must be an array of up to ${LIMITS.triggers}`);
        else r.triggers.forEach((t: any, i: number) => validateTrigger(t, `${p}.triggers[${i}]`, ctx));
    }
    if (r.security != null) validateSecurity(r.security, `${p}.security`, ctx);
    if (r.definitionSql != null && (typeof r.definitionSql !== 'string' || r.definitionSql.length > 100000)) add(ctx, 'INVALID_DEFINITION', `${p}.definitionSql`, 'definitionSql must be a string (informational only, never executed)');
}

function validateSecurity(s: any, p: string, ctx: Ctx) {
    if (!isObj(s)) { add(ctx, 'INVALID_SECURITY', p, 'must be an object'); return; }
    checkKeys(s, new Set(['enable_rls', 'masking', 'policies', 'grants', 'accessPolicies']), p, ctx);
    if (s.enable_rls != null && typeof s.enable_rls !== 'boolean') add(ctx, 'INVALID_SECURITY', `${p}.enable_rls`, 'must be boolean');
    (Array.isArray(s.policies) ? s.policies : []).forEach((pol: any, i: number) => {
        const pp = `${p}.policies[${i}]`;
        if (!isObj(pol)) { add(ctx, 'INVALID_POLICY', pp, 'must be an object'); return; }
        checkKeys(pol, new Set(['name', 'roles', 'using']), pp, ctx);
        ident(pol.name, 'policy name', `${pp}.name`, ctx);
        expr(pol.using, `${pp}.using`, `${pp}.using`, ctx, {}, 'UNSAFE_EXPRESSION');
        if (pol.roles != null) (Array.isArray(pol.roles) ? pol.roles : [pol.roles]).forEach((r: any, j: number) => role(r, `${pp}.roles[${j}]`, ctx));
    });
    (Array.isArray(s.masking) ? s.masking : []).forEach((m: any, i: number) => {
        const mp = `${p}.masking[${i}]`;
        if (!isObj(m)) { add(ctx, 'INVALID_MASKING', mp, 'must be an object'); return; }
        checkKeys(m, new Set(['column', 'roles', 'expression']), mp, ctx);
        ident(m.column, 'masking column', `${mp}.column`, ctx);
        expr(m.expression, `${mp}.expression`, `${mp}.expression`, ctx, {}, 'UNSAFE_EXPRESSION');
        (Array.isArray(m.roles) ? m.roles : []).forEach((r: any, j: number) => role(r, `${mp}.roles[${j}]`, ctx));
    });
    (Array.isArray(s.grants) ? s.grants : []).forEach((g: any, i: number) => {
        const gp = `${p}.grants[${i}]`;
        if (!isObj(g)) { add(ctx, 'INVALID_GRANT', gp, 'must be an object'); return; }
        checkKeys(g, new Set(['role', 'roles', 'privileges']), gp, ctx);
        if (g.role != null) role(g.role, `${gp}.role`, ctx);
        (Array.isArray(g.roles) ? g.roles : []).forEach((r: any, j: number) => role(r, `${gp}.roles[${j}]`, ctx));
        if (!Array.isArray(g.privileges) || !g.privileges.length) add(ctx, 'INVALID_GRANT', `${gp}.privileges`, 'privileges must be a non-empty array');
        else g.privileges.forEach((pr: any, j: number) => { if (!PRIVILEGES.has(String(pr).toUpperCase())) add(ctx, 'INVALID_GRANT', `${gp}.privileges[${j}]`, `privilege "${printable(String(pr), 20)}" not allowed`); });
    });
    (Array.isArray(s.accessPolicies) ? s.accessPolicies : []).forEach((ap: any, i: number) => {
        const ap_p = `${p}.accessPolicies[${i}]`;
        if (!isObj(ap)) { add(ctx, 'INVALID_POLICY', ap_p, 'must be an object'); return; }
        checkKeys(ap, new Set(['name', 'roles', 'rowFilter', 'masking']), ap_p, ctx);
        if (typeof ap.name !== 'string' || ap.name.length > 100) add(ctx, 'INVALID_POLICY', `${ap_p}.name`, 'name must be a string up to 100 chars');
        (Array.isArray(ap.rowFilter) ? ap.rowFilter : []).forEach((f: any, j: number) => ident(f?.column, 'rowFilter column', `${ap_p}.rowFilter[${j}].column`, ctx));
        (Array.isArray(ap.masking) ? ap.masking : []).forEach((f: any, j: number) => ident(f?.column, 'masking column', `${ap_p}.masking[${j}].column`, ctx));
    });
}

function validateFunction(r: any, p: string, ctx: Ctx, enumNames: Set<string>) {
    const args = r.arguments ?? r.parameters ?? [];
    if (!Array.isArray(args) || args.length > 50) add(ctx, 'INVALID_ARGUMENTS', `${p}.arguments`, 'arguments must be an array of up to 50');
    else args.forEach((a: any, i: number) => {
        const ap = `${p}.arguments[${i}]`;
        if (!isObj(a)) { add(ctx, 'INVALID_ARGUMENT', ap, 'must be an object'); return; }
        checkKeys(a, new Set(['name', 'type', 'mode']), ap, ctx);
        ident(a.name, 'argument name', `${ap}.name`, ctx);
        try { assertColumnType(a.type, `${ap}.type`, enumNames); } catch (e: any) { add(ctx, 'INVALID_COLUMN_TYPE', `${ap}.type`, e.message); }
        if (a.mode != null && !['IN', 'OUT', 'INOUT'].includes(String(a.mode).toUpperCase())) add(ctx, 'INVALID_ARGUMENT', `${ap}.mode`, 'mode must be IN, OUT or INOUT');
    });
    if (r.returnType != null) { try { assertColumnType(r.returnType, `${p}.returnType`, enumNames); } catch (e: any) { add(ctx, 'INVALID_COLUMN_TYPE', `${p}.returnType`, e.message); } }
    if (r.language != null && !['plpgsql', 'sql'].includes(String(r.language).toLowerCase())) add(ctx, 'INVALID_LANGUAGE', `${p}.language`, 'only plpgsql and sql are supported');
    if (r.volatility != null && !['IMMUTABLE', 'STABLE', 'VOLATILE'].includes(String(r.volatility).toUpperCase())) add(ctx, 'INVALID_VOLATILITY', `${p}.volatility`, 'IMMUTABLE, STABLE or VOLATILE');
    if (typeof r.body !== 'string' || !r.body.trim()) add(ctx, 'INVALID_BODY', `${p}.body`, 'function body is required');
    else {
        if (r.body.length > 100_000 || r.body.includes('\0') || r.body.includes('$$') || /\$[A-Za-z_]*\$/.test(r.body)) add(ctx, 'INVALID_BODY', `${p}.body`, 'body is too large or contains dollar-quote delimiters / NUL bytes');
        freeSql(ctx, `${p}.body`, `${r.type === 'PROCEDURE' ? 'procedure' : 'function'} body`);
    }
}

function validateResource(r: any, p: string, ctx: Ctx, enumNames: Set<string>, seen: Set<string>) {
    if (!isObj(r)) { add(ctx, 'INVALID_RESOURCE', p, 'resource must be an object'); return; }
    const type = typeof r.type === 'string' ? r.type.toUpperCase() : '';
    const keys = RESOURCE_KEYS[type];
    if (!keys) { add(ctx, 'UNKNOWN_RESOURCE_TYPE', `${p}.type`, `resource type must be one of ENUM, SEQUENCE, TABLE, VIEW, MATERIALIZED_VIEW, FUNCTION, PROCEDURE (got "${printable(String(r.type), 30)}")`); return; }
    if (r.type !== type) add(ctx, 'UNKNOWN_RESOURCE_TYPE', `${p}.type`, 'resource type must be upper case');
    checkKeys(r, keys, p, ctx);
    const name = ident(r.name, `${type.toLowerCase()} name`, `${p}.name`, ctx);
    if (name) {
        const key = `${type === 'VIEW' || type === 'MATERIALIZED_VIEW' ? 'REL' : type === 'TABLE' ? 'REL' : type === 'FUNCTION' || type === 'PROCEDURE' ? 'FN' : type}:${name}`;
        if (seen.has(key)) add(ctx, 'DUPLICATE_NAME', `${p}.name`, `duplicate ${type.toLowerCase()} "${name}" in schema`);
        seen.add(key);
    }
    switch (type) {
        case 'ENUM':
            if (!Array.isArray(r.values) || r.values.length === 0 || r.values.length > 1000) add(ctx, 'INVALID_ENUM', `${p}.values`, 'values must be a non-empty array (max 1000)');
            else r.values.forEach((v: any, i: number) => { if (typeof v !== 'string' || !v.length || v.length > 63 || v.includes('\0')) add(ctx, 'INVALID_ENUM', `${p}.values[${i}]`, 'enum labels are strings up to 63 chars'); });
            break;
        case 'SEQUENCE':
            for (const k of ['start', 'increment', 'minValue', 'maxValue', 'cache']) {
                if (r[k] != null && !(typeof r[k] === 'number' && Number.isInteger(r[k]) && Math.abs(r[k]) < 2 ** 53)) add(ctx, 'INVALID_SEQUENCE', `${p}.${k}`, `${k} must be an integer`);
            }
            if (r.strategy != null && !['NATIVE', 'PROCEDURAL'].includes(r.strategy)) add(ctx, 'INVALID_SEQUENCE', `${p}.strategy`, 'strategy must be NATIVE or PROCEDURAL');
            if (r.generator != null) expr(r.generator, `${p}.generator`, `${p}.generator`, ctx, {}, 'UNSAFE_EXPRESSION');
            if (r.ownedBy != null) {
                if (!isObj(r.ownedBy)) add(ctx, 'INVALID_SEQUENCE', `${p}.ownedBy`, 'ownedBy must be { table, column }');
                else { ident(r.ownedBy.table, 'ownedBy table', `${p}.ownedBy.table`, ctx); ident(r.ownedBy.column, 'ownedBy column', `${p}.ownedBy.column`, ctx); }
            }
            break;
        case 'TABLE': validateTable(r, p, ctx, enumNames); break;
        case 'VIEW': case 'MATERIALIZED_VIEW': {
            validateQuery(r.query, `${p}.query`, ctx);
            if (r.refreshStrategy != null && !['STANDARD', 'CONCURRENTLY', 'INCREMENTAL'].includes(r.refreshStrategy)) add(ctx, 'INVALID_VIEW', `${p}.refreshStrategy`, 'STANDARD, CONCURRENTLY or INCREMENTAL');
            if (r.federationStrategy != null && !['VIRTUAL', 'NATIVE'].includes(r.federationStrategy)) add(ctx, 'INVALID_VIEW', `${p}.federationStrategy`, 'VIRTUAL or NATIVE');
            if (r.refreshInterval != null && (typeof r.refreshInterval !== 'string' || r.refreshInterval.length > 50)) add(ctx, 'INVALID_VIEW', `${p}.refreshInterval`, 'string up to 50 chars');
            if (r.indexes != null) {
                if (!Array.isArray(r.indexes)) add(ctx, 'INVALID_VIEW', `${p}.indexes`, 'must be an array');
                else r.indexes.forEach((ix: any, i: number) => {
                    if (!isObj(ix) || !Array.isArray(ix.columns) || !ix.columns.length) add(ctx, 'INVALID_VIEW', `${p}.indexes[${i}]`, 'index needs columns');
                    else ix.columns.forEach((c: any, j: number) => ident(c, 'index column', `${p}.indexes[${i}].columns[${j}]`, ctx));
                });
            }
            break;
        }
        case 'FUNCTION': case 'PROCEDURE': validateFunction(r, p, ctx, enumNames); break;
    }
}

function validateSchema(s: any, i: number, ctx: Ctx, seenSchemas: Set<string>) {
    const p = `schemas[${i}]`;
    if (!isObj(s)) { add(ctx, 'INVALID_SCHEMA', p, 'schema must be an object'); return; }
    checkKeys(s, SCHEMA_KEYS, p, ctx);
    const name = ident(s.name, 'schema name', `${p}.name`, ctx);
    if (name) {
        if (RESERVED_SCHEMAS.test(name)) add(ctx, 'RESERVED_SCHEMA', `${p}.name`, `schema name "${name}" is reserved and cannot be used in a manifest`);
        else if (/^tenant_/i.test(name)) add(ctx, 'CROSS_TENANT_SCHEMA', `${p}.name`, `schema name "${name}" looks like a physical tenant schema; use the logical name (it is mapped to tenant_${ctx.opts.tenantId}_<name> automatically)`);
        else {
            const physical = `tenant_${ctx.opts.tenantId}_${name}`;
            if (physical.length > MAX_IDENT) add(ctx, 'NAME_TOO_LONG', `${p}.name`, `physical schema name "${printable(physical, 70)}" would exceed ${MAX_IDENT} characters`);
            else if (!belongsToTenant(physical, ctx.opts.tenantId)) add(ctx, 'CROSS_TENANT_SCHEMA', `${p}.name`, 'schema is outside the caller tenant namespace');
        }
        if (seenSchemas.has(name.toLowerCase())) add(ctx, 'DUPLICATE_NAME', `${p}.name`, `duplicate schema "${name}"`);
        seenSchemas.add(name.toLowerCase());
    }
    if (s.targetSource != null && (typeof s.targetSource !== 'string' || !SOURCE_NAME.test(s.targetSource))) add(ctx, 'INVALID_SOURCE_NAME', `${p}.targetSource`, 'invalid data source name');
    if (!Array.isArray(s.resources)) { add(ctx, 'INVALID_SCHEMA', `${p}.resources`, 'resources must be an array'); return; }
    if (s.resources.length > LIMITS.resources) add(ctx, 'TOO_MANY', `${p}.resources`, `at most ${LIMITS.resources} resources per schema`);
    const enumNames = new Set<string>(s.resources.filter((r: any) => isObj(r) && r.type === 'ENUM' && typeof r.name === 'string').map((r: any) => r.name));
    const seen = new Set<string>();
    s.resources.forEach((r: any, j: number) => validateResource(r, `${p}.resources[${j}]`, ctx, enumNames, seen));
}

function validateRelationships(rels: any, ctx: Ctx) {
    if (!Array.isArray(rels) || rels.length > LIMITS.rels) { add(ctx, 'INVALID_RELATIONSHIPS', 'relationships', `relationships must be an array of up to ${LIMITS.rels}`); return; }
    rels.forEach((r: any, i: number) => {
        const p = `relationships[${i}]`;
        if (!isObj(r)) { add(ctx, 'INVALID_RELATIONSHIP', p, 'must be an object'); return; }
        checkKeys(r, new Set(['name', 'cardinality', 'bridge', 'from', 'to', 'description']), p, ctx);
        ident(r.name, 'relationship name', `${p}.name`, ctx, 50);
        if (!REL_CARD.has(r.cardinality)) add(ctx, 'INVALID_RELATIONSHIP', `${p}.cardinality`, '1:1, 1:M or M:N');
        if (r.bridge != null) ident(r.bridge, 'bridge table', `${p}.bridge`, ctx);
        if (r.cardinality === 'M:N' && r.bridge == null) add(ctx, 'INVALID_RELATIONSHIP', `${p}.bridge`, 'M:N relationships need a bridge table');
        for (const side of ['from', 'to'] as const) {
            const e = r[side];
            if (!isObj(e)) { add(ctx, 'INVALID_RELATIONSHIP', `${p}.${side}`, 'must be an object'); continue; }
            checkKeys(e, new Set(['source', 'resource', 'field']), `${p}.${side}`, ctx);
            ident(e.resource, 'relationship resource', `${p}.${side}.resource`, ctx);
            ident(e.field, 'relationship field', `${p}.${side}.field`, ctx);
            if (e.source != null && (typeof e.source !== 'string' || !SOURCE_NAME.test(e.source))) add(ctx, 'INVALID_SOURCE_NAME', `${p}.${side}.source`, 'invalid data source name');
        }
    });
}

/**
 * Validates a parsed manifest. Never mutates it. Throws ManifestValidationError
 * (HTTP 400, message contains "Validation" so the controller reports it as a
 * guardrail violation) listing every problem found, or returns when valid.
 */
export function validateManifestDocument(manifest: any, opts: ValidateOptions): void {
    const ctx: Ctx = { opts, issues: [] };
    try { assertTenantId(opts.tenantId); } catch (e: any) { add(ctx, 'INVALID_TENANT', 'tenantId', e.message); throw new ManifestValidationError(ctx.issues); }
    if (!isObj(manifest)) { add(ctx, 'INVALID_MANIFEST', '$', 'manifest must be an object'); throw new ManifestValidationError(ctx.issues); }
    scanForbiddenKeys(manifest, '$', ctx);
    checkKeys(manifest, TOP_KEYS, '$', ctx);
    if (typeof manifest.version !== 'string' && typeof manifest.version !== 'number') add(ctx, 'INVALID_VERSION', 'version', 'Manifest version required');
    else if (String(manifest.version).length > 20) add(ctx, 'INVALID_VERSION', 'version', 'version is too long');
    if (manifest.consistencyMode != null && !['SAGA', 'STRONG'].includes(manifest.consistencyMode)) add(ctx, 'INVALID_CONSISTENCY', 'consistencyMode', 'SAGA or STRONG');
    if (manifest.namespace != null && typeof manifest.namespace !== 'string') add(ctx, 'INVALID_NAMESPACE', 'namespace', 'must be a string');
    if (manifest.targetSource != null && (typeof manifest.targetSource !== 'string' || !SOURCE_NAME.test(manifest.targetSource))) add(ctx, 'INVALID_SOURCE_NAME', 'targetSource', 'invalid data source name');
    if (manifest.extensions != null) {
        if (!Array.isArray(manifest.extensions) || manifest.extensions.length > 20) add(ctx, 'INVALID_EXTENSIONS', 'extensions', 'extensions must be an array of up to 20');
        else {
            const extra = new Set((process.env.MANIFEST_EXTRA_EXTENSIONS || '').split(',').map((s) => s.trim()).filter(Boolean));
            manifest.extensions.forEach((e: any, i: number) => { if (typeof e !== 'string' || !(EXTENSION_ALLOW.has(e) || extra.has(e))) add(ctx, 'EXTENSION_NOT_ALLOWED', `extensions[${i}]`, `extension "${printable(String(e), 40)}" is not allowed`); });
        }
    }
    if (manifest.downstream != null) {
        if (!Array.isArray(manifest.downstream) || manifest.downstream.length > 10) add(ctx, 'INVALID_DOWNSTREAM', 'downstream', 'must be an array of up to 10');
        else manifest.downstream.forEach((d: any, i: number) => {
            if (!isObj(d)) { add(ctx, 'INVALID_DOWNSTREAM', `downstream[${i}]`, 'must be an object'); return; }
            checkKeys(d, new Set(['type', 'enabled', 'strategy', 'fallback']), `downstream[${i}]`, ctx);
            if (typeof d.type !== 'string' || !/^[A-Za-z_]{1,30}$/.test(d.type)) add(ctx, 'INVALID_DOWNSTREAM', `downstream[${i}].type`, 'type must be a short word');
        });
    }
    if (!Array.isArray(manifest.schemas) || manifest.schemas.length === 0) add(ctx, 'INVALID_SCHEMAS', 'schemas', 'At least one schema required');
    else if (manifest.schemas.length > LIMITS.schemas) add(ctx, 'TOO_MANY', 'schemas', `at most ${LIMITS.schemas} schemas`);
    else {
        const seen = new Set<string>();
        manifest.schemas.forEach((s: any, i: number) => validateSchema(s, i, ctx, seen));
    }
    if (manifest.relationships != null) validateRelationships(manifest.relationships, ctx);
    if (ctx.issues.length) throw new ManifestValidationError(ctx.issues);
}

export { ManifestSqlError };
