/**
 * SQL fragment guard (Agent A, multi-tenancy hardening).
 *
 * Several code paths still have to splice caller-supplied text into SQL because the text is an expression, not a
 * value or an identifier (legacy `generateSql` select/join/group/order fields, AST `expression` entries, view
 * bodies). Identifiers go through assertIdent/quoteIdent; everything else must pass the conservative grammar in
 * this file or the request is rejected with a 400 (SqlGuardError, code INVALID_SQL_FRAGMENT):
 *
 *  - no `;`, `--`, block comments, backslashes, dollar quoting, backticks or NUL anywhere;
 *  - tokens are limited to identifiers, dots, commas, parentheses, numbers, single-quoted literals without
 *    embedded quotes/escapes, double-quoted identifiers, and a small operator set;
 *  - a word followed by `(` is a function call and must be on an allow-list (so `pg_sleep`, `set_config`,
 *    `dblink`, `pg_read_file`, ... are rejected);
 *  - statement keywords (SELECT, UNION, INSERT, DROP, CALL, SET, RESET, COPY, ...) are rejected in expression
 *    mode, which also rules out sub-selects;
 *  - schema qualifiers pointing at system or foreign-tenant schemas are rejected.
 */
import { assertIdent, belongsToTenant } from './identifiers';

export class SqlGuardError extends Error {
  status = 400;
  code = 'INVALID_SQL_FRAGMENT';
  constructor(message: string) { super(message); }
}

const FORBIDDEN_RAW = /;|--|\/\*|\*\/|\\|\$|`|\u0000/;

const FUNCTIONS = new Set([
  // aggregates
  'count', 'sum', 'avg', 'min', 'max', 'stddev', 'variance', 'array_agg', 'string_agg', 'bool_and', 'bool_or',
  // window
  'row_number', 'rank', 'dense_rank', 'percent_rank', 'cume_dist', 'ntile', 'lag', 'lead', 'first_value', 'last_value', 'nth_value',
  // scalar
  'coalesce', 'nullif', 'greatest', 'least', 'lower', 'upper', 'length', 'char_length', 'trim', 'ltrim', 'rtrim', 'btrim',
  'substr', 'substring', 'concat', 'concat_ws', 'replace', 'left', 'right', 'abs', 'round', 'ceil', 'ceiling', 'floor',
  'power', 'sqrt', 'mod', 'sign', 'date_trunc', 'date_part', 'to_char', 'to_date', 'to_timestamp', 'now', 'age', 'cast',
  'extract', 'initcap', 'md5',
  // type names usable as CAST(x AS varchar(10))
  'varchar', 'char', 'character', 'numeric', 'decimal',
]);

/** Words that may appear bare in an expression without being columns. */
const KEYWORDS = new Set([
  'and', 'or', 'not', 'is', 'null', 'in', 'like', 'ilike', 'between', 'as', 'asc', 'desc', 'distinct', 'case', 'when', 'then',
  'else', 'end', 'true', 'false', 'over', 'partition', 'by', 'order', 'rows', 'range', 'unbounded', 'preceding', 'following',
  'current', 'row', 'nulls', 'first', 'last', 'filter',
]);

/** Statement-level words: never allowed inside an expression. */
const STATEMENT_WORDS = new Set([
  'select', 'from', 'where', 'union', 'intersect', 'except', 'join', 'inner', 'outer', 'cross', 'lateral', 'using', 'on',
  'group', 'having', 'limit', 'offset', 'fetch', 'with', 'recursive', 'all', 'any', 'some', 'exists', 'values',
]);

/** Words that are never allowed, in any mode (DML/DDL/session/admin). */
const ALWAYS_BLOCKED = new Set([
  'insert', 'update', 'delete', 'drop', 'alter', 'create', 'truncate', 'grant', 'revoke', 'call', 'execute', 'exec', 'copy',
  'set', 'reset', 'into', 'returning', 'do', 'begin', 'commit', 'rollback', 'savepoint', 'vacuum', 'analyze', 'analyse',
  'listen', 'notify', 'unlisten', 'prepare', 'deallocate', 'declare', 'move', 'lock', 'comment', 'security', 'load',
  'refresh', 'reindex', 'cluster', 'discard', 'import', 'abort', 'checkpoint', 'explain', 'show', 'language', 'function',
  'procedure', 'trigger', 'extension', 'owner', 'role', 'user', 'session_user', 'current_user', 'pg_sleep',
]);

/** Words that are only valid in query (view body) mode. */
const QUERY_KEYWORDS = new Set([
  'select', 'from', 'where', 'union', 'intersect', 'except', 'join', 'inner', 'outer', 'left', 'right', 'full', 'cross', 'using',
  'on', 'group', 'having', 'limit', 'offset', 'with', 'recursive', 'all', 'distinct',
]);

const SYSTEM_QUALIFIERS = /^(public|pg_[a-z0-9_]*|information_schema|fabric_[a-z0-9_]*|citus[a-z0-9_]*|metadata_catalog|admin_functions|auth|cron)$/i;

const TOKEN_RE = /\s+|'[^'\\\u0000]*'|"[A-Za-z0-9_ .-]{1,128}"|\d+(?:\.\d+)?|[A-Za-z_][A-Za-z0-9_]*|<=|>=|<>|!=|\|\||[=<>+\-*/%]|[(),.]/y;

interface Token { kind: 'str' | 'qid' | 'num' | 'word' | 'op' | 'punct'; text: string }

function tokenize(src: string, what: string): Token[] {
  const out: Token[] = [];
  TOKEN_RE.lastIndex = 0;
  let pos = 0;
  while (pos < src.length) {
    TOKEN_RE.lastIndex = pos;
    const m = TOKEN_RE.exec(src);
    if (!m || m.index !== pos || m[0].length === 0) throw new SqlGuardError(`Invalid ${what}: unsupported character or token near "${src.slice(pos, pos + 12)}"`);
    pos += m[0].length;
    const t = m[0];
    if (/^\s+$/.test(t)) continue;
    if (t[0] === "'") out.push({ kind: 'str', text: t });
    else if (t[0] === '"') out.push({ kind: 'qid', text: t });
    else if (/^\d/.test(t)) out.push({ kind: 'num', text: t });
    else if (/^[A-Za-z_]/.test(t)) out.push({ kind: 'word', text: t });
    else if ('(),.'.includes(t)) out.push({ kind: 'punct', text: t });
    else out.push({ kind: 'op', text: t });
  }
  return out;
}

export interface GuardOptions {
  /** allow SELECT/FROM/JOIN/... (used for view bodies only) */
  query?: boolean;
  /** tenant whose own schemas may be used as qualifiers (query mode); foreign `tenant_*` qualifiers are always rejected */
  tenantId?: string;
  maxLength?: number;
}

/**
 * Validates a free-form SQL expression (or, with `query: true`, a single SELECT statement) against the grammar above.
 * @returns the trimmed input when it is acceptable.
 * @throws SqlGuardError (HTTP 400) otherwise.
 */
export function assertSafeExpression(expr: unknown, what = 'expression', opts: GuardOptions = {}): string {
  if (typeof expr !== 'string') throw new SqlGuardError(`Invalid ${what}: must be a string`);
  const src = expr.trim();
  const max = opts.maxLength ?? 500;
  if (!src) throw new SqlGuardError(`Invalid ${what}: empty`);
  if (src.length > max) throw new SqlGuardError(`Invalid ${what}: too long`);
  if (FORBIDDEN_RAW.test(src)) throw new SqlGuardError(`Invalid ${what}: contains a forbidden character sequence`);
  const toks = tokenize(src, what);
  if (toks.length > (opts.query ? 2000 : 200)) throw new SqlGuardError(`Invalid ${what}: too complex`);
  if (opts.query && !(toks[0] && toks[0].kind === 'word' && /^(select|with)$/i.test(toks[0].text))) {
    throw new SqlGuardError(`Invalid ${what}: must be a single SELECT statement`);
  }

  let depth = 0;
  for (let i = 0; i < toks.length; i++) {
    const t = toks[i]!;
    const next = toks[i + 1];
    const prev = toks[i - 1];
    if (t.kind === 'punct') {
      if (t.text === '(') { depth++; if (depth > 12) throw new SqlGuardError(`Invalid ${what}: nested too deeply`); }
      else if (t.text === ')') { depth--; if (depth < 0) throw new SqlGuardError(`Invalid ${what}: unbalanced parentheses`); }
      continue;
    }
    if (t.kind === 'qid') {
      if (next && next.kind === 'punct' && next.text === '(') throw new SqlGuardError(`Invalid ${what}: quoted identifiers cannot be called`);
      continue;
    }
    if (t.kind !== 'word') continue;

    const w = t.text.toLowerCase();
    const isCall = !!next && next.kind === 'punct' && next.text === '(';
    const qualifies = !!next && next.kind === 'punct' && next.text === '.';
    const afterDot = !!prev && prev.kind === 'punct' && prev.text === '.';

    if (ALWAYS_BLOCKED.has(w) && !afterDot) throw new SqlGuardError(`Invalid ${what}: keyword "${t.text}" is not allowed`);
    if (qualifies && !afterDot) {
      if (SYSTEM_QUALIFIERS.test(t.text)) throw new SqlGuardError(`Invalid ${what}: schema "${t.text}" is not accessible`);
      if (/^tenant_/i.test(t.text) && !(opts.tenantId && belongsToTenant(t.text, opts.tenantId))) throw new SqlGuardError(`Invalid ${what}: schema "${t.text}" is not accessible`);
    }
    if (afterDot) continue; // a member name; its qualifier was validated above
    if (isCall) {
      if (KEYWORDS.has(w) || (opts.query && QUERY_KEYWORDS.has(w))) continue; // e.g. IN (...), OVER (...), FROM (subselect)
      if (!FUNCTIONS.has(w)) throw new SqlGuardError(`Invalid ${what}: function "${t.text}" is not allowed`);
      continue;
    }
    if (opts.query) {
      if (QUERY_KEYWORDS.has(w)) continue;
    } else if (STATEMENT_WORDS.has(w)) {
      throw new SqlGuardError(`Invalid ${what}: keyword "${t.text}" is not allowed in an expression`);
    }
    // KEYWORDS and plain column/table words are fine.
  }
  if (depth !== 0) throw new SqlGuardError(`Invalid ${what}: unbalanced parentheses`);
  return src;
}

/** Validates a single SELECT statement (view body). Foreign `tenant_*`/system schema qualifiers are rejected. */
export function assertSafeSelectQuery(sql: unknown, tenantId: string, what = 'query'): string {
  return assertSafeExpression(sql, what, { query: true, tenantId, maxLength: 20000 });
}

const STRICT_PART = /^[A-Za-z_][A-Za-z0-9_]*$/;
const RELAXED_NAME = /^[A-Za-z0-9_$][A-Za-z0-9_$ -]{0,127}$/;

/** `a`, `a.b`, `a.b.c`, `a.*` or `*`, each segment a plain identifier. */
export function isDottedIdent(v: string): boolean {
  if (v === '*') return true;
  if (v.length > 200) return false;
  const parts = v.split('.');
  if (parts.length > 3) return false;
  return parts.every((p, i) => (STRICT_PART.test(p) && p.length <= 63) || (p === '*' && i === parts.length - 1 && parts.length > 1));
}

/** Quotes a dotted identifier path part by part (`a.b` -> `"a"."b"`, `a.*` -> `"a".*`). */
export function quoteDotted(v: unknown, what = 'column'): string {
  if (typeof v !== 'string' || !isDottedIdent(v)) throw new SqlGuardError(`Invalid ${what}: "${String(v).slice(0, 40)}"`);
  if (v === '*') return '*';
  return v.split('.').map((p) => (p === '*' ? '*' : `"${assertIdent(p, what)}"`)).join('.');
}

/** Free-text field of an AST/config: a plain (relaxed) name or dotted identifier path; never anything quote-like. */
export function assertSafeName(v: unknown, what = 'name'): string {
  if (typeof v !== 'string') throw new SqlGuardError(`Invalid ${what}: must be a string`);
  if (v === '*' || isDottedIdent(v) || RELAXED_NAME.test(v)) return v;
  throw new SqlGuardError(`Invalid ${what}: "${v.slice(0, 40)}"`);
}

/**
 * A select/group/order field: `*`, a plain column or dotted path, or a safe expression (e.g. `COUNT(*)`, `a AS b`).
 * Returns the SQL text to splice: plain paths are quoted, expressions are returned (validated) as written.
 */
export function fieldToSql(v: unknown, what = 'field', tenantId?: string): string {
  if (typeof v !== 'string') throw new SqlGuardError(`Invalid ${what}: must be a string`);
  if (v === '*' || isDottedIdent(v)) return quoteDotted(v, what);
  return assertSafeExpression(v, what, tenantId ? { tenantId } : {});
}

/** Integer in [min, max] (default 0..1e9) or a SqlGuardError. Accepts numeric strings. */
export function safeInt(v: unknown, what = 'number', min = 0, max = 1_000_000_000): number {
  const n = typeof v === 'string' && /^-?\d{1,12}$/.test(v.trim()) ? Number(v) : v;
  if (typeof n !== 'number' || !Number.isInteger(n) || n < min || n > max) throw new SqlGuardError(`Invalid ${what}: must be an integer between ${min} and ${max}`);
  return n;
}

const AST_OPERATORS = new Set([
  'EQ', 'NE', 'GT', 'LT', 'GTE', 'LTE', 'LIKE', 'ILIKE', 'IN', 'NIN', 'NOT_IN', 'IS_NULL', 'IS_NOT_NULL', 'MATCH', 'CONTAINS',
  '=', '!=', '<>', '>', '<', '>=', '<=',
]);
const AGGREGATES = new Set(['COUNT', 'SUM', 'AVG', 'MIN', 'MAX', 'STDDEV', 'VARIANCE', 'ARRAY_AGG', 'BOOL_AND', 'BOOL_OR', 'COUNT_DISTINCT']);
const WINDOW_FNS = new Set(['ROW_NUMBER', 'RANK', 'DENSE_RANK', 'PERCENT_RANK', 'CUME_DIST', 'NTILE', 'LAG', 'LEAD', 'FIRST_VALUE', 'LAST_VALUE', 'SUM', 'AVG', 'MIN', 'MAX', 'COUNT']);

const isObj = (x: any) => x && typeof x === 'object' && !Array.isArray(x);

/**
 * Structural validation of a query AST (the `query` of an AST request) before it is planned/transpiled/executed.
 * Every name that ends up in SQL text (resource, alias, source, column paths, CTE names/columns), every operator /
 * aggregate / window function / sort direction and every raw `expression` entry is checked. Throws SqlGuardError.
 * The AST is not modified.
 */
export function validateAst(ast: any, tenantId?: string, depth = 0): void {
  if (!isObj(ast)) throw new SqlGuardError('Invalid query: must be an object');
  if (depth > 12) throw new SqlGuardError('Invalid query: nested too deeply');
  const T = tenantId;
  // Every list-valued clause must really be a list (a string/number there used to blow up inside the compilers as a 500).
  for (const k of ['select', 'where', 'joins', 'groupBy', 'orderBy', 'having', 'union', 'intersect', 'except', 'with']) {
    if (ast[k] != null && !Array.isArray(ast[k])) throw new SqlGuardError(`Invalid ${k}: must be an array`);
  }

  const ref = (r: any, what: string) => {
    if (!isObj(r)) throw new SqlGuardError(`Invalid ${what}: must be an object`);
    if (r.query) { validateAst(r.query, T, depth + 1); }
    else assertSafeName(r.resource, `${what}.resource`);
    if (r.source != null) assertSafeName(r.source, `${what}.source`);
    if (r.alias != null) assertSafeName(r.alias, `${what}.alias`);
  };
  const field = (v: any, what: string) => { fieldToSql(v, what, T); };

  if (ast.from) ref(ast.from, 'from');
  if (Array.isArray(ast.joins)) {
    for (const j of ast.joins) {
      ref(j, 'join');
      if (j.type != null && !/^(INNER|LEFT|RIGHT|FULL|CROSS)( OUTER)?$/i.test(String(j.type))) throw new SqlGuardError('Invalid join.type');
      if (isObj(j.on)) {
        field(j.on.left, 'join.on.left'); field(j.on.right, 'join.on.right');
        if (j.on.operator != null && !AST_OPERATORS.has(String(j.on.operator).toUpperCase())) throw new SqlGuardError('Invalid join.on.operator');
      } else if (typeof j.on === 'string') assertSafeExpression(j.on, 'join.on', T ? { tenantId: T } : {});
    }
  }
  if (Array.isArray(ast.select)) {
    for (const c of ast.select) {
      if (typeof c === 'string') { field(c, 'select'); continue; }
      if (!isObj(c)) throw new SqlGuardError('Invalid select entry');
      if (c.alias != null) assertSafeName(c.alias, 'select.alias');
      if (c.expression != null) assertSafeExpression(c.expression, 'select.expression', T ? { tenantId: T } : {});
      if (c.aggregate != null && !AGGREGATES.has(String(c.aggregate).toUpperCase())) throw new SqlGuardError(`Invalid aggregate "${String(c.aggregate).slice(0, 20)}"`);
      if (c.window != null && !WINDOW_FNS.has(String(c.window).toUpperCase())) throw new SqlGuardError(`Invalid window function "${String(c.window).slice(0, 20)}"`);
      if (c.column != null) field(c.column, 'select.column');
      if (Array.isArray(c.partitionBy)) c.partitionBy.forEach((p: any) => field(p, 'select.partitionBy'));
      if (Array.isArray(c.orderBy)) for (const o of c.orderBy) { field(o?.column, 'select.orderBy'); dir(o?.direction); }
    }
  }
  if (Array.isArray(ast.where)) {
    for (const w of ast.where) {
      if (!isObj(w)) throw new SqlGuardError('Invalid where entry');
      if (w.expression != null) { assertSafeExpression(w.expression, 'where.expression', T ? { tenantId: T } : {}); continue; }
      if (w.search != null) {
        if (!isObj(w.search)) throw new SqlGuardError('Invalid where.search');
        field(w.search.column, 'where.search.column');
        if (typeof w.search.query !== 'string' || /\u0000/.test(w.search.query)) throw new SqlGuardError('Invalid where.search.query');
        continue;
      }
      field(w.column, 'where.column');
      if (w.operator != null && !AST_OPERATORS.has(String(w.operator).toUpperCase())) throw new SqlGuardError(`Invalid operator "${String(w.operator).slice(0, 20)}"`);
      if (typeof w.value === 'string' && w.value.includes('\u0000')) throw new SqlGuardError('Invalid where.value');
    }
  }
  if (Array.isArray(ast.groupBy)) ast.groupBy.forEach((g: any) => field(g, 'groupBy'));
  if (Array.isArray(ast.orderBy)) for (const o of ast.orderBy) { field(o?.column, 'orderBy.column'); dir(o?.direction); }
  if (Array.isArray(ast.having)) {
    for (const h of ast.having) {
      if (!isObj(h)) throw new SqlGuardError('Invalid having entry');
      assertSafeName(h.column, 'having.column');
    }
  }
  if (ast.limit != null) safeInt(ast.limit, 'limit');
  if (ast.offset != null) safeInt(ast.offset, 'offset');
  for (const k of ['union', 'intersect', 'except'] as const) {
    if (Array.isArray(ast[k])) ast[k].forEach((leg: any) => validateAst(leg, T, depth + 1));
  }
  if (Array.isArray(ast.with)) {
    for (const cte of ast.with) {
      if (!isObj(cte)) throw new SqlGuardError('Invalid with entry');
      assertIdent(cte.name, 'with.name');
      if (cte.columns != null) {
        if (!Array.isArray(cte.columns)) throw new SqlGuardError('Invalid with.columns');
        cte.columns.forEach((c: any) => assertIdent(c, 'with.columns'));
      }
      validateAst(cte.base, T, depth + 1);
      if (cte.unionAll) validateAst(cte.unionAll, T, depth + 1);
    }
  }
  if (ast.recursive != null) {
    const r = ast.recursive;
    if (!isObj(r)) throw new SqlGuardError('Invalid recursive');
    if (r.resource != null) assertSafeName(r.resource, 'recursive.resource');
    if (r.source != null) assertSafeName(r.source, 'recursive.source');
  }

  function dir(d: any) {
    if (d != null && !/^(ASC|DESC)$/i.test(String(d))) throw new SqlGuardError('Invalid sort direction');
  }
}

/**
 * Doubles single quotes in every string `where.value` / `where.search.query` of an AST copy. Used only for the
 * SINGLE_LOCAL path, where QueryTranspiler splices values into SQL text (and only when the transpiler itself does
 * not escape them: see `transpilerEscapesValues`).
 */
export function escapeAstLiterals(ast: any): any {
  const esc = (x: any) => (typeof x === 'string' ? x.replace(/'/g, "''") : x);
  const walk = (n: any): any => {
    if (Array.isArray(n)) return n.map(walk);
    if (!isObj(n)) return n;
    const out: any = {};
    for (const [k, v] of Object.entries(n)) {
      if (k === 'value') out[k] = Array.isArray(v) ? v.map(esc) : esc(v);
      else if (k === 'query' && typeof v === 'string') out[k] = esc(v);
      else out[k] = walk(v);
    }
    return out;
  };
  return walk(ast);
}
