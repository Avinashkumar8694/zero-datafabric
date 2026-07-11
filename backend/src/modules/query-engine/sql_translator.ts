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

/** Parse a SQL literal into a JS value (number, quoted string, boolean, null). */
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

/** Split on a top-level delimiter (comma / AND), ignoring anything inside parentheses. */
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

/** Parse the SELECT list into columns + aggregate specs. */
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

/** Parse a WHERE clause (AND-combined simple predicates). */
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
 * @throws on unsupported constructs (JOIN / UNION / subquery) — use AST mode instead.
 */
export function sqlToAst(sqlRaw: string): TranslatedQuery {
  const sql = String(sqlRaw).replace(/\s+/g, ' ').replace(/;\s*$/, '').trim();
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
