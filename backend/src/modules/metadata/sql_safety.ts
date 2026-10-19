/**
 * SQL-fragment safety checks used by the manifest validator and the DDL
 * transpilers. Identifiers go through `utils/identifiers.ts`; this module covers
 * the other places a manifest carries text that ends up inside a statement:
 * column types, defaults, CHECK / GENERATED / policy expressions and literals.
 *
 * Philosophy: a manifest is a declarative document, not SQL. Expressions are
 * tokenised (not regex-scanned) and only a small, closed grammar is accepted:
 * literals, column references, operators, casts to allow-listed types and calls
 * to non-dangerous functions. Anything that could start a second statement,
 * open a comment, switch quoting rules or read outside the row is refused.
 */
import { assertIdent } from '../../utils/identifiers';

export class ManifestSqlError extends Error {
    status = 400;
    constructor(public code: string, message: string) {
        super(message);
    }
}

/* ------------------------------------------------------------------------- */
/* Types                                                                     */
/* ------------------------------------------------------------------------- */

const BASE_TYPES = new Set([
    // portable / logical names used by manifests
    'STRING', 'TEXT', 'INTEGER', 'INT', 'BIGINT', 'SMALLINT', 'BOOLEAN', 'BOOL', 'TIMESTAMP', 'TIMESTAMPTZ', 'DATE', 'TIME', 'TIMETZ',
    'UUID', 'JSON', 'JSONB', 'NUMERIC', 'DECIMAL', 'REAL', 'DOUBLE', 'FLOAT', 'SERIAL', 'BIGSERIAL', 'SMALLSERIAL', 'BYTEA', 'INTERVAL',
    // postgres-native
    'VARCHAR', 'CHAR', 'CHARACTER', 'BPCHAR', 'INT2', 'INT4', 'INT8', 'FLOAT4', 'FLOAT8', 'MONEY', 'INET', 'CIDR', 'MACADDR', 'CITEXT',
    'TSVECTOR', 'TSQUERY', 'LTREE', 'HSTORE', 'XML', 'OID',
    'TSRANGE', 'TSTZRANGE', 'DATERANGE', 'INT4RANGE', 'INT8RANGE', 'NUMRANGE',
    // function return types
    'VOID', 'TRIGGER', 'RECORD',
]);

const MULTI_WORD_TYPES = new Set([
    'DOUBLE PRECISION', 'CHARACTER VARYING', 'TIMESTAMP WITHOUT TIME ZONE', 'TIMESTAMP WITH TIME ZONE',
    'TIME WITHOUT TIME ZONE', 'TIME WITH TIME ZONE', 'BIT VARYING',
]);

const TYPE_SHAPE = /^([A-Za-z][A-Za-z ]*?)\s*(\(\s*\d{1,5}\s*(,\s*\d{1,5}\s*)?\))?\s*((\[\s*\d{0,5}\s*\]\s*)*)$/;

/**
 * Validates a column / argument / return type against an allow-list of base
 * types (plus optional precision and array suffixes). Custom types are only
 * accepted when they are enum names declared by the same manifest schema.
 * @returns the type text unchanged when valid.
 */
export function assertColumnType(type: unknown, what: string, customTypes: Set<string> = new Set()): string {
    if (typeof type !== 'string' || !type.trim() || type.length > 64) throw new ManifestSqlError('INVALID_COLUMN_TYPE', `${what}: type must be a non-empty string up to 64 chars`);
    if (customTypes.has(type)) return type;
    const m = TYPE_SHAPE.exec(type.trim());
    if (!m) throw new ManifestSqlError('INVALID_COLUMN_TYPE', `${what}: unsupported type "${printable(type)}"`);
    const base = (m[1] || '').trim().replace(/\s+/g, ' ').toUpperCase();
    if (!BASE_TYPES.has(base) && !MULTI_WORD_TYPES.has(base)) {
        throw new ManifestSqlError('INVALID_COLUMN_TYPE', `${what}: unsupported type "${printable(type)}"`);
    }
    return type;
}

/** `ENUM` columns reference an enum resource by name rather than carrying a base type. */
export function isEnumPlaceholderType(type: unknown): boolean {
    return typeof type === 'string' && type.toUpperCase() === 'ENUM';
}

/* ------------------------------------------------------------------------- */
/* Literals                                                                  */
/* ------------------------------------------------------------------------- */

/** Escape a value for a single-quoted SQL literal (rejects NUL bytes). */
export function sqlLiteral(value: unknown): string {
    const s = String(value ?? '');
    if (s.includes('\0')) throw new ManifestSqlError('INVALID_LITERAL', 'NUL bytes are not allowed in literals');
    return `'${s.replace(/'/g, "''")}'`;
}

export function sqlNumber(value: unknown, what: string): number {
    const n = typeof value === 'string' && value.trim() !== '' ? Number(value) : value;
    if (typeof n !== 'number' || !Number.isFinite(n)) throw new ManifestSqlError('INVALID_NUMBER', `${what}: must be a finite number`);
    return n;
}

export function printable(s: string, max = 60): string {
    const t = String(s).replace(/[^\x20-\x7E]/g, '?');
    return t.length > max ? `${t.slice(0, max)}...` : t;
}

/* ------------------------------------------------------------------------- */
/* Expressions (defaults, CHECK, GENERATED, policy USING, masking)           */
/* ------------------------------------------------------------------------- */

/** Words that can never appear in a manifest expression (statements, DDL, session control, subqueries). */
const FORBIDDEN_WORDS = new Set([
    'SELECT', 'INSERT', 'UPDATE', 'DELETE', 'DROP', 'ALTER', 'CREATE', 'TRUNCATE', 'GRANT', 'REVOKE', 'COPY', 'EXECUTE', 'CALL', 'DO',
    'WITH', 'UNION', 'INTERSECT', 'EXCEPT', 'VALUES', 'RETURNING', 'EXISTS', 'LATERAL', 'JOIN', 'INTO', 'RECURSIVE',
]);

/** Keywords that are fine inside an expression and are not column references. */
const EXPR_KEYWORDS = new Set([
    'AND', 'OR', 'NOT', 'IS', 'NULL', 'TRUE', 'FALSE', 'IN', 'LIKE', 'ILIKE', 'BETWEEN', 'SIMILAR', 'TO', 'ESCAPE', 'CASE', 'WHEN', 'THEN', 'ELSE', 'END',
    'DISTINCT', 'FROM', 'ANY', 'ALL', 'ARRAY', 'AT', 'TIME', 'ZONE', 'INTERVAL', 'CURRENT_TIMESTAMP', 'CURRENT_DATE', 'CURRENT_TIME', 'LOCALTIMESTAMP',
    'LOCALTIME', 'CURRENT_USER', 'AS', 'ASC', 'DESC', 'COLLATE', 'UNKNOWN', 'NEW', 'OLD', 'ISNULL', 'NOTNULL', 'ONLY', 'NULLS', 'FIRST', 'LAST',
]);

/** Function-name prefixes / names that read files, reach other servers, change session state or are otherwise unsafe. */
const FORBIDDEN_FUNCTION_PREFIX = ['pg_', 'lo_', 'dblink', 'query_to_', 'xpath', 'ts_debug', 'to_regclass'];
const FORBIDDEN_FUNCTIONS = new Set([
    'setval', 'set_config', 'lastval', 'dblink', 'pg_sleep', 'version', 'current_database', 'current_schema', 'current_schemas', 'current_catalog',
    'inet_server_addr', 'inet_server_port', 'inet_client_addr', 'inet_client_port', 'txid_current', 'xmlparse', 'table_to_xml', 'database_to_xml', 'schema_to_xml',
]);
const SEQUENCE_FUNCTIONS = new Set(['nextval', 'currval']);

export interface ExprOptions {
    /** Column names of the table the expression belongs to (informational; unknown bare words are still accepted as column references). */
    columns?: string[];
    /** Allow `current_setting(...)` (policies / defaults rely on `app.*` GUCs). Defaults to true. */
    allowCurrentSetting?: boolean;
    maxLength?: number;
}

type Tok = { kind: 'ws' | 'word' | 'qident' | 'str' | 'num' | 'sym'; text: string };

const SYMBOLS = new Set(['(', ')', ',', '+', '-', '*', '/', '%', '^', '=', '<', '>', '!', '~', '|', '&', ':', '[', ']', '.', '#', '@']);

function tokenize(src: string, code: string, what: string): Tok[] {
    const out: Tok[] = [];
    let i = 0;
    const bad = (msg: string): never => { throw new ManifestSqlError(code, `${what}: ${msg}`); };
    while (i < src.length) {
        const c = src[i] as string;
        if (c === '\0' || c === ';' || c === '$' || c === '\\' || c === '`' || c === '{' || c === '}' || c === '?') bad(`character "${printable(c)}" is not allowed`);
        if (c === ' ' || c === '\t') { out.push({ kind: 'ws', text: c }); i++; continue; }
        if (c === '\n' || c === '\r') bad('line breaks are not allowed in expressions');
        if (/[\x00-\x1f\x7f]/.test(c)) bad('control characters are not allowed');
        if (c === '-' && src[i + 1] === '-') bad('comment tokens are not allowed');
        if (c === '/' && src[i + 1] === '*') bad('comment tokens are not allowed');
        if (c === '*' && src[i + 1] === '/') bad('comment tokens are not allowed');
        if (c === "'") {
            // string literal; '' is an escaped quote; no backslash escapes exist (E'..' is rejected below)
            let j = i + 1; let ok = false;
            while (j < src.length) {
                if (src[j] === "'") { if (src[j + 1] === "'") { j += 2; continue; } ok = true; break; }
                if (src[j] === '\0') bad('NUL bytes are not allowed');
                j++;
            }
            if (!ok) bad('unterminated string literal');
            const prev = out[out.length - 1];
            if (prev && prev.kind === 'word' && /^(E|U&|B|X|N)$/i.test(prev.text)) bad('prefixed string literals (E\'\', B\'\', X\'\', U&\'\') are not allowed');
            out.push({ kind: 'str', text: src.slice(i, j + 1) });
            i = j + 1; continue;
        }
        if (c === '"') {
            const j = src.indexOf('"', i + 1);
            if (j < 0) bad('unterminated quoted identifier');
            const inner = src.slice(i + 1, j);
            if (!/^[A-Za-z_][A-Za-z0-9_]{0,62}$/.test(inner)) bad('quoted identifiers must be plain names');
            out.push({ kind: 'qident', text: src.slice(i, j + 1) });
            i = j + 1; continue;
        }
        if (/[0-9]/.test(c)) {
            const m = /^(\d+(\.\d+)?([eE][+-]?\d+)?)/.exec(src.slice(i)) as RegExpExecArray;
            out.push({ kind: 'num', text: m[1] as string });
            i += (m[1] as string).length; continue;
        }
        if (/[A-Za-z_]/.test(c)) {
            const m = /^[A-Za-z_][A-Za-z0-9_]*/.exec(src.slice(i)) as RegExpExecArray;
            out.push({ kind: 'word', text: m[0] });
            i += m[0].length; continue;
        }
        if (SYMBOLS.has(c)) { out.push({ kind: 'sym', text: c }); i++; continue; }
        bad(`character "${printable(c)}" is not allowed`);
    }
    return out;
}

/**
 * Validates a scalar SQL expression (column default, CHECK, generated column,
 * policy USING, masking). Throws ManifestSqlError(code) on anything outside the
 * accepted grammar; returns the trimmed expression on success.
 */
export function assertSafeExpression(expr: unknown, what: string, opts: ExprOptions = {}, code = 'UNSAFE_EXPRESSION'): string {
    if (typeof expr !== 'string') throw new ManifestSqlError(code, `${what}: must be a string`);
    const text = expr.trim();
    const max = opts.maxLength ?? 1000;
    if (!text) throw new ManifestSqlError(code, `${what}: must not be empty`);
    if (text.length > max) throw new ManifestSqlError(code, `${what}: longer than ${max} characters`);
    const allowSetting = opts.allowCurrentSetting !== false;
    // `$$` / `$tag$` anywhere (even inside a string literal) could terminate a dollar-quoted function body the text is embedded in.
    if (/\$[A-Za-z0-9_]*\$/.test(text)) throw new ManifestSqlError(code, `${what}: dollar-quote delimiters are not allowed`);
    const toks = tokenize(text, code, what).filter((t) => t.kind !== 'ws');
    const fail = (msg: string): never => { throw new ManifestSqlError(code, `${what}: ${msg}`); };

    let depth = 0;
    for (let i = 0; i < toks.length; i++) {
        const t = toks[i] as Tok; const next = toks[i + 1]; const prev = toks[i - 1];
        if (t.kind === 'sym') {
            if (t.text === '(') depth++;
            if (t.text === ')') { depth--; if (depth < 0) fail('unbalanced parentheses'); }
            if (t.text === '.') {
                // only NEW./OLD. and numeric dots are meaningful; qualified names could reach other schemas
                if (!(prev && prev.kind === 'word' && /^(NEW|OLD)$/i.test(prev.text))) fail('qualified names (a.b) are not allowed');
            }
            if (t.text === ':') {
                // only the cast operator `::`
                if (next && next.text === ':') {
                    i++;
                    // the cast target is validated as a type below (longest multi-word type first)
                    const words: string[] = [];
                    for (let j = i + 1; j < toks.length && words.length < 5; j++) {
                        const tj = toks[j] as Tok;
                        if (tj.kind !== 'word') break;
                        words.push(tj.text);
                    }
                    if (!words.length) fail('cast without a type');
                    let take = 1;
                    for (let n = Math.min(words.length, 5); n >= 2; n--) {
                        if (MULTI_WORD_TYPES.has(words.slice(0, n).join(' ').toUpperCase())) { take = n; break; }
                    }
                    const typeName = words.slice(0, take).join(' ');
                    try { assertColumnType(typeName, `${what} cast`); } catch { fail(`cast to "${printable(typeName)}" is not allowed`); }
                    i += take;
                    continue;
                }
                fail('stray ":"');
            }
            continue;
        }
        if (t.kind === 'word') {
            const up = t.text.toUpperCase();
            if (FORBIDDEN_WORDS.has(up)) fail(`keyword ${up} is not allowed`);
            const isCall = !!(next && next.kind === 'sym' && next.text === '(');
            if (isCall) {
                const lower = t.text.toLowerCase();
                if (FORBIDDEN_FUNCTIONS.has(lower) || FORBIDDEN_FUNCTION_PREFIX.some((p) => lower.startsWith(p))) fail(`function ${lower}() is not allowed`);
                if (lower === 'current_setting' && !allowSetting) fail('current_setting() is not allowed here');
                if (SEQUENCE_FUNCTIONS.has(lower)) {
                    const arg = toks[i + 2];
                    if (!arg || arg.kind !== 'str' || arg.text.includes('.')) fail(`${lower}() takes an unqualified sequence name literal`);
                }
                continue;
            }
            if (prev && prev.kind === 'sym' && prev.text === '.') continue; // NEW.col / OLD.col
            if (EXPR_KEYWORDS.has(up)) continue;
            // anything else is a bare column reference; keep it a legal identifier
            try { assertIdent(t.text, 'column reference'); } catch { fail(`bad identifier ${printable(t.text)}`); }
        }
    }
    if (depth !== 0) fail('unbalanced parentheses');
    return text;
}

/**
 * Column `default` values: a number/boolean literal, a plain word (taken as a
 * string literal by the transpiler), a single-quoted literal or a safe
 * expression. Returns `{ kind, sql }` where `sql` is ready to follow `DEFAULT`.
 */
export function renderDefault(raw: unknown, what: string, opts: ExprOptions = {}): string {
    if (typeof raw === 'number' || typeof raw === 'boolean') {
        return typeof raw === 'number' ? String(sqlNumber(raw, what)) : (raw ? 'TRUE' : 'FALSE');
    }
    if (typeof raw !== 'string') throw new ManifestSqlError('UNSAFE_DEFAULT', `${what}: default must be a string, number or boolean`);
    const d = raw.trim();
    if (!d) throw new ManifestSqlError('UNSAFE_DEFAULT', `${what}: default must not be empty`);
    if (d.length > 500) throw new ManifestSqlError('UNSAFE_DEFAULT', `${what}: default is longer than 500 characters`);
    if (d.includes('\0')) throw new ManifestSqlError('UNSAFE_DEFAULT', `${what}: NUL bytes are not allowed`);
    if (!Number.isNaN(Number(d)) && /^-?\d+(\.\d+)?$/.test(d)) return d;
    if (/^(true|false|null)$/i.test(d)) return d.toUpperCase();
    if (/^(now\(\)|current_timestamp|current_date)$/i.test(d)) return d.toUpperCase();
    // Legacy behaviour: a bare word/phrase without parentheses or quotes is a string literal (`PENDING`).
    if (!d.includes('(') && !d.startsWith("'")) return sqlLiteral(d);
    if (/^'([^']|'')*'$/.test(d)) { return assertSafeExpression(d, what, opts, 'UNSAFE_DEFAULT'); }
    return assertSafeExpression(d, what, opts, 'UNSAFE_DEFAULT');
}

/** Free-form SQL body (function/procedure bodies, raw expressions): only the dollar-quote terminator is checked here, gating is done by the validator. */
export function assertDollarSafe(body: string, tag: string, what: string): string {
    if (typeof body !== 'string' || body.includes('\0')) throw new ManifestSqlError('INVALID_BODY', `${what}: invalid body`);
    if (body.includes(tag) || body.includes('$$')) throw new ManifestSqlError('INVALID_BODY', `${what}: body must not contain dollar-quote delimiters`);
    return body;
}
