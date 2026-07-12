/**
 * SQL → AST translator.
 * ----------------------
 * Lets a caller write plain SQL against a NON-SQL engine (e.g. MongoDB) and have
 * the fabric translate it into the engine-agnostic query AST, which the planner
 * then compiles to that engine's native query (Mongo find / $group, etc.).
 *
 * This is how "SQL over MongoDB" works: MongoDB has no SQL engine, so instead of
 * executing SQL *at* the source, the fabric parses the SQL here and drives its
 * normal pushdown path. SQL-native engines (Postgres/MySQL/Snowflake/ES) keep
 * running SQL natively — they don't use this.
 *
 * Supported subset (single-collection analytics — the Mongo-translatable core):
 *   SELECT <cols | * | aggregates>              (COUNT(*), COUNT/SUM/AVG/MIN/MAX(col), AS alias)
 *   FROM <table>
 *   [WHERE <col op value> [AND ...]]            (= != <> < > <= >= LIKE ILIKE IN(...))
 *   [GROUP BY <cols>]
 *   [ORDER BY <col [ASC|DESC]> [, ...]]
 *   [LIMIT n] [OFFSET n]
 * JOINs / subqueries / UNION are NOT supported here — use AST mode for those.
 */

export interface TranslatedQuery {
  from: { resource: string };
  select?: any[];
  where?: { column: string; operator: string; value: any }[];
  groupBy?: string[];
  having?: { column: string; operator: string; value: any }[];
  orderBy?: { column: string; direction: 'ASC' | 'DESC' }[];
  limit?: number;
  offset?: number;
}

const OP_MAP: Record<string, string> = {
  '=': 'EQ', '==': 'EQ', '!=': 'NE', '<>': 'NE',
  '>': 'GT', '>=': 'GTE', '<': 'LT', '<=': 'LTE',
  'LIKE': 'LIKE', 'ILIKE': 'ILIKE', 'IN': 'IN', 'MATCH': 'MATCH',
};

const unquoteIdent = (s: string) => s.trim().replace(/^[`"[]+|[`"\]]+$/g, '');
const lastSegment = (s: string) => { const p = unquoteIdent(s); return p.includes('.') ? p.split('.').pop()! : p; };

/**
 * Parse a SQL literal into a JS value (number, quoted string, boolean, null).
 * @param raw the raw literal text (e.g. `'abc'`, `42`, `3.14`, `true`, `null`).
 * @returns the typed JS value; unrecognized text is returned as a trimmed string.
 */
function parseLiteral(raw: string): any {
  const s = raw.trim();
  if (/^'(.*)'$/.test(s)) return s.slice(1, -1).replace(/''/g, "'");
  if (/^"(.*)"$/.test(s)) return s.slice(1, -1);
  if (/^-?\d+$/.test(s)) return parseInt(s, 10);
  if (/^-?\d*\.\d+$/.test(s)) return parseFloat(s);
  if (/^(true|false)$/i.test(s)) return s.toLowerCase() === 'true';
  if (/^null$/i.test(s)) return null;
  return s;
}

/**
 * Split on a top-level delimiter (comma / AND), ignoring anything inside parentheses.
 * Used to split a SELECT list on commas, or a WHERE/HAVING clause on `AND`,
 * without breaking apart a function call's argument list (e.g.
 * `COUNT(a, b)` or `col IN (1, 2, 3)`) since the delimiter is only matched
 * when the parenthesis nesting depth is 0.
 * @param input the text to split.
 * @param delim a regex matching the delimiter at the START of the remaining text (anchored via `m.index === 0`).
 * @returns the trimmed, non-empty segments between top-level delimiter matches.
 */
function splitTopLevel(input: string, delim: RegExp): string[] {
  const parts: string[] = []; let depth = 0; let buf = '';
  const tokens = input.split(/(\(|\))/);
  // Simpler char scan with a delimiter test on the remaining string.
  parts.length = 0; buf = ''; depth = 0;
  for (let i = 0; i < input.length; i++) {
    const ch = input[i]!;
    if (ch === '(') depth++;
    else if (ch === ')') depth--;
    if (depth === 0) {
      const rest = input.slice(i);
      const m = rest.match(delim);
      if (m && m.index === 0) { parts.push(buf); buf = ''; i += m[0].length - 1; continue; }
    }
    buf += ch;
  }
  parts.push(buf);
  return parts.map((p) => p.trim()).filter((p) => p.length > 0);
  void tokens;
}

/**
 * Parse the SELECT list into columns + aggregate specs.
 * Recognizes `*`, plain (optionally aliased) columns, and
 * `COUNT/SUM/AVG/MIN/MAX(col|*) [AS alias]`. Anything else (scalar/stored
 * function calls, window functions, CASE, arithmetic) has no universal
 * cross-engine mapping and is rejected rather than silently mistranslated.
 * @param list the raw SELECT list text (between `SELECT [DISTINCT]` and `FROM`).
 * @returns `['*']`, or a mixed array of plain column name strings and
 *   `(aggregate, column, alias)` aggregate specs.
 * @throws if an entry isn't a recognized plain column or aggregate expression.
 */
function parseSelect(list: string): any[] {
  if (list.trim() === '*') return ['*'];
  const out: any[] = [];
  for (const item of splitTopLevel(list, /^\s*,\s*/)) {
    const agg = item.match(/^(count|sum|avg|min|max)\s*\(\s*(\*|[\w."`]+)\s*\)(?:\s+as\s+([\w]+))?$/i);
    if (agg) {
      const func = agg[1]!.toUpperCase();
      const col = agg[2] === '*' ? '*' : lastSegment(agg[2]!);
      out.push({ aggregate: func, column: col, alias: agg[3] || `${func.toLowerCase()}_${col === '*' ? 'all' : col}` });
      continue;
    }
    // A plain column, optionally aliased. Anything else — scalar/stored functions
    // (nextval, generate_custom_id, lower...), window functions (RANK() OVER),
    // CASE, or arithmetic — has no universal cross-engine mapping, so we REJECT it
    // rather than silently mistranslate. Run those on a SQL-native source or via AST.
    const plain = item.match(/^([\w."`]+)(?:\s+as\s+([\w]+))?$/i);
    if (plain) { out.push(lastSegment(plain[1]!)); continue; }
    throw new Error(
      `SQL translate: unsupported SELECT expression "${item}". Functions (e.g. nextval, ` +
      `stored functions), window functions, CASE and arithmetic aren't translatable to a ` +
      `non-SQL engine — run on a SQL-native source (Postgres/ES) or use AST mode.`);
  }
  return out;
}

/**
 * Parse a WHERE clause (AND-combined simple predicates).
 * Supports `col IN (v1, v2, ...)` and `col <op> value` where op is one of
 * `= == != <> > >= < <= LIKE ILIKE MATCH`.
 * @param clause the raw WHERE clause text (everything between `WHERE` and the next keyword).
 * @returns one predicate per AND-combined condition.
 * @throws if a condition doesn't match a supported shape.
 */
function parseWhere(clause: string): { column: string; operator: string; value: any }[] {
  const preds: { column: string; operator: string; value: any }[] = [];
  for (const cond of splitTopLevel(clause, /^\s+and\s+/i)) {
    const inM = cond.match(/^([\w."`]+)\s+in\s*\((.+)\)$/i);
    if (inM) {
      const vals = splitTopLevel(inM[2]!, /^\s*,\s*/).map(parseLiteral);
      preds.push({ column: lastSegment(inM[1]!), operator: 'IN', value: vals });
      continue;
    }
    const m = cond.match(/^([\w."`]+)\s*(=|==|!=|<>|>=|<=|>|<|like|ilike|match)\s*(.+)$/i);
    if (!m) throw new Error(`SQL translate: unsupported WHERE predicate "${cond}"`);
    const op = OP_MAP[m[2]!.toUpperCase()] || OP_MAP[m[2]!] || 'EQ';
    preds.push({ column: lastSegment(m[1]!), operator: op, value: parseLiteral(m[3]!) });
  }
  return preds;
}

/**
 * Parse a HAVING clause into predicates on the aggregate RESULT columns. The
 * left-hand side may be a SELECT alias (e.g. `cnt`) or an aggregate expression
 * (e.g. `COUNT(*)`, `SUM(amount)`) — the latter is resolved to its select alias.
 * HAVING is applied by the fabric as a post-aggregation filter (compensation),
 * so it works uniformly across engines.
 * @param clause the raw HAVING clause text.
 * @param selectSpecs the already-parsed SELECT list (see (@link parseSelect)), used to resolve aggregate-expression LHS to their alias.
 * @returns one predicate per AND-combined condition, keyed by the resolved result-column alias.
 * @throws if a condition doesn't match a supported shape, or references an aggregate not present in the SELECT list.
 */
function parseHaving(clause: string, selectSpecs: any[]): { column: string; operator: string; value: any }[] {
  const resolveAlias = (lhs: string): string => {
    const agg = lhs.match(/^(count|sum|avg|min|max)\s*\(\s*(\*|[\w.]+)\s*\)$/i);
    if (agg) {
      const func = agg[1]!.toUpperCase();
      const col = agg[2] === '*' ? null : lastSegment(agg[2]!);
      const hit = selectSpecs.find((s) => s && typeof s === 'object' && s.aggregate === func && (s.column === (col ?? '*') || s.column === col));
      if (hit) return hit.alias;
      throw new Error(`SQL translate: HAVING references ${lhs} which is not in the SELECT list — add it with an alias.`);
    }
    return unquoteIdent(lhs); // a select alias
  };
  return splitTopLevel(clause, /^\s+and\s+/i).map((cond) => {
    const mm = cond.match(/^(.+?)\s*(=|==|!=|<>|>=|<=|>|<)\s*(.+)$/);
    if (!mm) throw new Error(`SQL translate: unsupported HAVING predicate "${cond}"`);
    return { column: resolveAlias(mm[1]!.trim()), operator: OP_MAP[mm[2]!] || 'EQ', value: parseLiteral(mm[3]!) };
  });
}

/**
 * Translate a single-table SELECT into the fabric AST `query` object.
 * Explicitly rejects (with a directive error message) constructs that have no
 * translation to a non-SQL engine: `WITH [RECURSIVE]`/CTEs, `JOIN`, set
 * operations, and subqueries — callers needing those should use AST mode
 * directly instead of SQL. `SELECT DISTINCT` over plain columns is rewritten
 * to a GROUP BY on those columns (DISTINCT with aggregates, or `DISTINCT *`,
 * is rejected).
 * @param sqlRaw the raw SQL string (whitespace-normalized and trailing `;` stripped internally).
 * @returns the parsed (@link TranslatedQuery) AST fragment (`from`/`select`/`where`/`groupBy`/`having`/`orderBy`/`limit`/`offset`).
 * @throws on unsupported constructs (JOIN / UNION / subquery / CTE) or a
 *   statement shape that doesn't match `SELECT [DISTINCT] ... FROM t [WHERE][GROUP BY][HAVING][ORDER BY][LIMIT][OFFSET]`.
 */
export function sqlToAst(sqlRaw: string): TranslatedQuery {
  const sql = String(sqlRaw).replace(/\s+/g, ' ').replace(/;\s*$/, '').trim();
  // WITH / recursive CTEs can't be expressed against a document store; direct the
  // caller to the fabric's engine-agnostic equivalents (which DO run on Mongo/ES).
  if (/^with\s+recursive\b/i.test(sql)) throw new Error('SQL translate: WITH RECURSIVE is not supported on non-SQL engines — use AST mode with query.recursive (in-fabric hierarchy traversal).');
  if (/^with\b/i.test(sql)) throw new Error('SQL translate: WITH/CTE is not supported on non-SQL engines — use AST mode (query.with for Postgres, query.recursive for cross-engine).');
  if (/\bjoin\b/i.test(sql)) throw new Error('SQL translate: JOINs are not supported for non-SQL engines — use AST mode.');
  if (/\bunion\b|\bintersect\b|\bexcept\b/i.test(sql)) throw new Error('SQL translate: set operations are not supported here — use AST mode.');
  if (/\bselect\b[\s\S]*\bfrom\b\s*\(/i.test(sql)) throw new Error('SQL translate: subqueries are not supported — use AST mode.');

  const re = /^select\s+(distinct\s+)?(.+?)\s+from\s+([\w."`]+)\s*(?:\bwhere\s+(.+?))?\s*(?:\bgroup\s+by\s+(.+?))?\s*(?:\bhaving\s+(.+?))?\s*(?:\border\s+by\s+(.+?))?\s*(?:\blimit\s+(\d+))?\s*(?:\boffset\s+(\d+))?\s*$/is;
  const m = sql.match(re);
  if (!m) throw new Error('SQL translate: could not parse statement (supported: SELECT [DISTINCT] ... FROM t [WHERE][GROUP BY][HAVING][ORDER BY][LIMIT][OFFSET]).');

  const [, distinct, selectList, table, whereC, groupByC, havingC, orderByC, limitС, offsetC] = m;
  const q: TranslatedQuery = { from: { resource: lastSegment(table!) }, select: parseSelect(selectList!) };
  if (whereC) q.where = parseWhere(whereC);
  if (groupByC) q.groupBy = splitTopLevel(groupByC, /^\s*,\s*/).map(lastSegment);
  // DISTINCT: group by the selected (plain) columns.
  if (distinct) {
    if (q.select!.some((c) => c && typeof c === 'object')) throw new Error('SQL translate: SELECT DISTINCT with aggregates is not supported — use GROUP BY.');
    q.groupBy = (q.select as string[]).filter((c) => c !== '*');
    if (!q.groupBy.length) throw new Error('SQL translate: SELECT DISTINCT * is not supported — list columns.');
  }
  if (havingC) q.having = parseHaving(havingC, q.select || []);
  if (orderByC) {
    q.orderBy = splitTopLevel(orderByC, /^\s*,\s*/).map((o) => {
      const parts = o.trim().split(/\s+/);
      return { column: lastSegment(parts[0]!), direction: (parts[1] || 'ASC').toUpperCase() === 'DESC' ? 'DESC' : 'ASC' };
    });
  }
  if (limitС) q.limit = parseInt(limitС, 10);
  if (offsetC) q.offset = parseInt(offsetC, 10);
  return q;
}
