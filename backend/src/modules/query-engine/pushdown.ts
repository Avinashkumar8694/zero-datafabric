/**
 * PushdownCompiler
 * -----------------
 * Single source of truth for translating the canonical query shape
 * (select / filter / orderBy / limit / offset) into engine-native,
 * PARAMETERIZED requests. This is what makes the fabric "smart": instead of
 * fetching a whole table into the app and filtering in JS, we push the
 * predicate, projection, sort and limit down to the source engine.
 *
 * The filter convention matches the rest of the query engine
 * (see QueryEngineService.generateSql): a plain map of
 *   ( column: value )                       -> column = value
 *   ( column: ( $op: value ) )              -> column <op> value
 * where $op is one of $eq $ne $gt $gte $lt $lte $like $ilike $in.
 */

export type SqlDialect = 'postgres' | 'mysql' | 'snowflake' | 'oracle';

export type AggFunc = 'COUNT' | 'SUM' | 'MIN' | 'MAX' | 'AVG' | 'COUNT_DISTINCT' | 'PERCENTILE';

export interface AggregateSpec {
  func: AggFunc;
  /** null means COUNT(*) */
  column: string | null;
  alias: string;
  /** for PERCENTILE: which percentile (e.g. 95 for p95); defaults to 95 */
  percent?: number;
}

/** A grouping column: a plain field, or a date bucket for time-series aggregation. */
export type GroupBy = string | { field: string; dateInterval: 'minute' | 'hour' | 'day' | 'week' | 'month' | 'quarter' | 'year' };

export interface CanonicalQuery {
  select?: string[] | undefined;
  filter?: Record<string, any> | undefined;
  orderBy?: { field: string; dir: 'ASC' | 'DESC' }[] | undefined;
  limit?: number | undefined;
  offset?: number | undefined;
  /** grouping columns for aggregate pushdown (plain fields or date buckets) */
  groupBy?: GroupBy[] | undefined;
  /** aggregate expressions to push down (GROUP BY / $group / aggs) */
  aggregates?: AggregateSpec[] | undefined;
}

export interface CompiledSql {
  text: string;
  params: any[];
}

export interface CompiledMongo {
  filter: Record<string, any>;
  projection?: Record<string, 0 | 1>;
  sort?: Record<string, 1 | -1>;
  limit?: number;
  skip?: number;
}

// Maps the canonical operator vocabulary to SQL operators.
const SQL_OPERATORS: Record<string, string> = {
  $eq: '=',
  $ne: '!=',
  $gt: '>',
  $gte: '>=',
  $lt: '<',
  $lte: '<=',
  $like: 'LIKE',
  $ilike: 'ILIKE',
  $in: 'IN',
  // $match = full-text / contains; $fuzzy = fuzzy/entity-resolution match. Both are
  // native on Elasticsearch (match / match+fuzziness); SQL falls back to a
  // case-insensitive substring (ILIKE/LIKE), Mongo to a case-insensitive regex.
  $match: 'MATCH',
  $fuzzy: 'MATCH',
};

// Mongo comparison operators we understand (canonical == native here).
const MONGO_OPERATORS = new Set(['$eq', '$ne', '$gt', '$gte', '$lt', '$lte', '$in']);

/**
 * Single source of truth for compiling a (@link CanonicalQuery) into each
 * engine's native, parameterized request (SQL for Postgres/MySQL/Snowflake,
 * a find()/aggregate() spec for MongoDB). See the file-level overview for the
 * canonical filter convention. All methods are static; the class is never instantiated.
 */
export class PushdownCompiler {
  /**
   * Strip anything that isn't a safe identifier character.
   * @param name a possibly-unsafe identifier.
   * @returns `name` with every character outside `[A-Za-z0-9_]` removed.
   */
  private static ident(name: string): string {
    return String(name).replace(/[^a-zA-Z0-9_]/g, '');
  }

  /**
   * Sanitize and quote an identifier for the given SQL dialect.
   * @param name the identifier to quote.
   * @param dialect target SQL dialect (backtick-quoted for MySQL, double-quoted otherwise).
   * @returns the quoted, sanitized identifier.
   */
  private static quoteIdent(name: string, dialect: SqlDialect): string {
    const safe = this.ident(name);
    if (dialect === 'mysql') return `\`${safe}\``;
    // Oracle folds unquoted identifiers to UPPERCASE (its canonical stored form).
    // Uppercase before double-quoting so lowercase/mixed-case query identifiers
    // still match the physical columns (which the catalog also stores uppercase).
    if (dialect === 'oracle') return `"${safe.toUpperCase()}"`;
    return `"${safe}"`;
  }

  /**
   * Qualify a possibly dotted column path (a.b) with per-part quoting.
   * @param path a plain or dotted column path, or `*`.
   * @returns `*` unchanged, or each dot-separated part quoted and rejoined with `.`.
   */
  private static quoteColumn(path: string, dialect: SqlDialect): string {
    if (!path || path === '*') return '*';
    return String(path)
      .split('.')
      .map((part) => this.quoteIdent(part, dialect))
      .join('.');
  }

  /**
   * Extract [operator, value] from a filter entry using the canonical convention.
   * @param rawValue a filter entry: either a bare scalar (implies `$eq`) or a `($op: value)` object.
   * @returns the single `(op, value)` pair (only the first operator key if the object carries several — use (@link splitOps) for multi-operator entries).
   */
  private static splitOp(rawValue: any): { op: string; value: any } {
    if (rawValue !== null && typeof rawValue === 'object' && !Array.isArray(rawValue)) {
      const firstKey = Object.keys(rawValue)[0];
      if (firstKey && firstKey.startsWith('$')) {
        return { op: firstKey, value: rawValue[firstKey] };
      }
    }
    return { op: '$eq', value: rawValue };
  }

  /**
   * Extract ALL operators for a filter entry, so a column can carry multiple
   * conditions (e.g. ( $gte: x, $lte: y ) for a range). Falls back to $eq for a
   * bare scalar value.
   * @param rawValue a filter entry: either a bare scalar (implies `$eq`) or an all-`$op`-keyed object.
   * @returns one `(op, value)` pair per operator present.
   */
  private static splitOps(rawValue: any): { op: string; value: any }[] {
    if (rawValue !== null && typeof rawValue === 'object' && !Array.isArray(rawValue)) {
      const keys = Object.keys(rawValue);
      if (keys.length > 0 && keys.every((k) => k.startsWith('$'))) {
        return keys.map((op) => ({ op, value: rawValue[op] }));
      }
    }
    return [{ op: '$eq', value: rawValue }];
  }

  /**
   * Compile a canonical SELECT into a parameterized SQL statement for the given dialect.
   * Postgres uses `$1..$n` placeholders and "ident" quoting; MySQL uses `?` and `ident`.
   * When `aggregates`/`groupBy` are present, builds a `GROUP BY` select list of
   * grouping columns (date buckets rendered via `date_trunc`/`DATE()`) plus
   * aggregate expressions ((@link aggExprSql)); otherwise builds a plain
   * projection. `NULL` equality/inequality compiles to `IS [NOT] NULL` since
   * `= NULL`/`!= NULL` are never true in SQL. `$match`/`$fuzzy` degrade to a
   * case-insensitive substring match (`ILIKE`/`LIKE`) since full-text search is
   * not a SQL-native concept for every dialect.
   * @param input the canonical query plus its physical `schema` (optional), `table`, and target `dialect`.
   * @returns `(text, params)` — the parameterized SQL and its positional parameter values.
   */
  static toSql(
    input: CanonicalQuery & { schema?: string; table: string; dialect: SqlDialect }
  ): CompiledSql {
    const { schema, table, dialect, select, filter, orderBy, limit, offset, groupBy, aggregates } = input;
    const params: any[] = [];

    // Placeholder generator per dialect (postgres: $n, oracle: :n, mysql/snowflake: ?).
    const placeholder = (val: any): string => {
      params.push(val);
      if (dialect === 'postgres') return `$${params.length}`;
      if (dialect === 'oracle') return `:${params.length}`;
      return '?';
    };

    const hasAgg = Array.isArray(aggregates) && aggregates.length > 0;
    const hasGroup = Array.isArray(groupBy) && groupBy.length > 0;
    const cols = (hasAgg || hasGroup)
      ? [
          ...(groupBy || []).map((g) => this.groupSelectSql(g, dialect)),
          ...(aggregates || []).map((a) => `${this.aggExprSql(a, dialect)} AS ${this.quoteIdent(a.alias, dialect)}`),
        ].join(', ')
      : select && select.length > 0
        ? select
            .map((c) =>
              c === '*' || c.includes('(') || c.includes(' ')
                ? c // expressions / aggregates / * pass through untouched
                : this.quoteColumn(c, dialect)
            )
            .join(', ')
        : '*';

    const qualifiedTable = schema
      ? `${this.quoteIdent(schema, dialect)}.${this.quoteIdent(table, dialect)}`
      : this.quoteIdent(table, dialect);

    let text = `SELECT ${cols} FROM ${qualifiedTable}`;

    if (filter && Object.keys(filter).length > 0) {
      const clauses: string[] = [];
      for (const key of Object.keys(filter)) {
        const col = this.quoteColumn(key, dialect);
        // A column may carry several conditions (range); emit one clause per operator.
        for (const { op, value } of this.splitOps(filter[key])) {
          const sqlOp = SQL_OPERATORS[op] || '=';
          if (op === '$in' && Array.isArray(value)) {
            if (value.length === 0) { clauses.push('1 = 0'); continue; } // empty IN () -> match nothing
            clauses.push(`${col} IN (${value.map((v) => placeholder(v)).join(', ')})`);
          } else if (op === '$match' || op === '$fuzzy') {
            const like = dialect === 'postgres' ? 'ILIKE' : 'LIKE';
            clauses.push(`${col} ${like} ${placeholder('%' + String(value) + '%')}`);
          } else if (value === null && (op === '$eq' || op === '$ne')) {
            // NULL is not comparable with = / != — emit IS [NOT] NULL (drives the
            // policy "hide soft-deleted rows" pattern: deleted_at IS NULL).
            clauses.push(`${col} IS ${op === '$ne' ? 'NOT ' : ''}NULL`);
          } else {
            clauses.push(`${col} ${sqlOp} ${placeholder(value)}`);
          }
        }
      }
      text += ` WHERE ${clauses.join(' AND ')}`;
    }

    if (hasGroup) {
      text += ` GROUP BY ${groupBy!.map((g) => this.groupBySql(g, dialect)).join(', ')}`;
    }

    if (orderBy && orderBy.length > 0) {
      const orders = orderBy
        .map((o) => `${this.quoteColumn(o.field, dialect)} ${o.dir === 'DESC' ? 'DESC' : 'ASC'}`)
        .join(', ');
      text += ` ORDER BY ${orders}`;
    }

    if (dialect === 'oracle') {
      // Oracle 12c+ row-limiting clause (requires ORDER BY for OFFSET to be deterministic).
      if (typeof offset === 'number' && offset > 0) text += ` OFFSET ${Math.floor(offset)} ROWS`;
      if (typeof limit === 'number' && limit >= 0) text += ` FETCH ${offset && offset > 0 ? 'NEXT' : 'FIRST'} ${Math.floor(limit)} ROWS ONLY`;
    } else {
      if (typeof limit === 'number' && limit >= 0) text += ` LIMIT ${Math.floor(limit)}`;
      if (typeof offset === 'number' && offset > 0) text += ` OFFSET ${Math.floor(offset)}`;
    }

    return { text, params };
  }

  // Canonical AST comparison tokens → SQL operators. Anything outside this map
  // is rejected (never emitted raw) so a hostile AST can't inject an operator.
  private static readonly AST_OPERATORS: Record<string, string> = {
    EQ: '=', NE: '!=', GT: '>', LT: '<', GTE: '>=', LTE: '<=',
    LIKE: 'LIKE', ILIKE: 'ILIKE', IN: 'IN', NIN: 'NOT IN',
    IS_NULL: 'IS NULL', IS_NOT_NULL: 'IS NOT NULL',
  };

  // Aggregate function names we allow in a pushed-down SELECT list.
  private static readonly AGG_WHITELIST = new Set(['COUNT', 'SUM', 'MIN', 'MAX', 'AVG', 'COUNT_DISTINCT']);

  /** Quote an alias-qualified column path, allowing a trailing `.*` (e.g. `a.*`). */
  private static quoteColumnPath(path: string, dialect: SqlDialect): string {
    if (!path || path === '*') return '*';
    const p = String(path);
    if (/\.\*$/.test(p)) {
      const prefix = p.slice(0, -2);
      return `${this.quoteColumn(prefix, dialect)}.*`;
    }
    return this.quoteColumn(p, dialect);
  }

  /** Reject any path that isn't a bare or alias-qualified identifier (or `*`/`a.*`). */
  private static assertIdentPath(path: string): void {
    if (!/^(\*|[A-Za-z_][A-Za-z0-9_]*(\.[A-Za-z_][A-Za-z0-9_]*)*(\.\*)?)$/.test(String(path))) {
      throw new Error(`co-located pushdown: unsupported column expression "${path}"`);
    }
  }

  /**
   * Compile a WHOLE co-located AST (FROM + JOINs + WHERE + GROUP BY + HAVING +
   * ORDER BY + LIMIT/OFFSET, and UNION/INTERSECT/EXCEPT) into ONE native,
   * parameterized SQL statement for a single physical SQL database, so the
   * source engine's own optimizer executes the join/aggregate instead of the
   * fabric fanning out into per-leg bind-joins. Every value is parameterized;
   * every identifier is whitelist-quoted; every operator is mapped from a fixed
   * table. Any construct we can't prove safe (raw expressions, full-text search,
   * window functions, CTEs, unknown operators) THROWS — the caller catches and
   * falls back to the federation executor, so co-location never changes results,
   * only speed.
   * @param input `ast` (the query node), target `dialect`, and a `resolve(source,
   *   resource)` that returns the physical `{ schema, table }` for each leg.
   * @returns `(text, params)` — one parameterized statement.
   * @throws when the AST contains a construct not safe to push down whole.
   */
  static toJoinSql(input: {
    ast: any;
    dialect: SqlDialect;
    resolve: (source: string | undefined, resource: string) => { schema: string | null; table: string };
  }): CompiledSql {
    const { ast, dialect, resolve } = input;
    const params: any[] = [];

    // Collect every declared CTE name in the tree so a FROM/JOIN reference to a
    // CTE is emitted as a bare (schema-less) name instead of being resolved to a
    // physical table. (Lexical shadowing of a real table by a CTE of the same
    // name is a rare over-approximation we accept.)
    const cteNames = new Set<string>();
    const collectCtes = (n: any): void => {
      if (!n || typeof n !== 'object') return;
      if (Array.isArray(n.with)) for (const c of n.with) { if (c?.name) cteNames.add(c.name); collectCtes(c.base); if (c.unionAll) collectCtes(c.unionAll); }
      for (const k of ['union', 'intersect', 'except'] as const) if (Array.isArray(n[k])) n[k].forEach(collectCtes);
    };
    collectCtes(ast);

    const placeholder = (val: any): string => {
      params.push(val);
      if (dialect === 'postgres') return `$${params.length}`;
      if (dialect === 'oracle') return `:${params.length}`;
      return '?';
    };

    const col = (path: string): string => {
      this.assertIdentPath(path);
      return this.quoteColumnPath(path, dialect);
    };

    // A physical table reference with its (aliased) name. No `AS` keyword — Oracle
    // rejects `FROM t AS a`; `FROM t a` is valid on every dialect here.
    const tableRef = (ref: any): string => {
      if (!ref || !ref.resource) throw new Error('co-located pushdown: missing FROM/JOIN resource');
      // A reference to a CTE name is a logical (schema-less) name, not a physical table.
      if (cteNames.has(ref.resource)) {
        const base = this.quoteIdent(ref.resource, dialect);
        return ref.alias ? `${base} ${this.quoteIdent(ref.alias, dialect)}` : base;
      }
      const { schema, table } = resolve(ref.source, ref.resource);
      const base = schema
        ? `${this.quoteIdent(schema, dialect)}.${this.quoteIdent(table, dialect)}`
        : this.quoteIdent(table, dialect);
      return ref.alias ? `${base} ${this.quoteIdent(ref.alias, dialect)}` : base;
    };

    // Compile a (non-recursive) WITH clause into `WITH a AS (...), b AS (...) `.
    // Recursive CTEs (a `unionAll` leg) are left to the in-fabric recursive
    // executor — throw so the caller falls back.
    const withPrefix = (node: any): string => {
      if (!Array.isArray(node.with) || node.with.length === 0) return '';
      const parts = node.with.map((c: any) => {
        if (c.unionAll) throw new Error('co-located pushdown: recursive CTE not supported');
        const cols = Array.isArray(c.columns) && c.columns.length
          ? `(${c.columns.map((x: string) => this.quoteIdent(x, dialect)).join(', ')})` : '';
        return `${this.quoteIdent(c.name, dialect)}${cols} AS (${compile(c.base)})`;
      });
      return `WITH ${parts.join(', ')} `;
    };

    const selectSql = (c: any): string => {
      if (typeof c === 'string') return col(c);
      if (c && typeof c === 'object') {
        if (c.aggregate) {
          const fn = String(c.aggregate).toUpperCase();
          if (!this.AGG_WHITELIST.has(fn)) throw new Error(`co-located pushdown: unsupported aggregate "${c.aggregate}"`);
          const inner = !c.column || c.column === '*' ? '*' : col(c.column);
          const expr = fn === 'COUNT_DISTINCT' ? `COUNT(DISTINCT ${inner})` : `${fn}(${inner})`;
          return c.alias ? `${expr} AS ${this.quoteIdent(c.alias, dialect)}` : expr;
        }
        if (c.column) return col(c.column) + (c.alias ? ` AS ${this.quoteIdent(c.alias, dialect)}` : '');
      }
      // Raw expressions / window functions / anything else: not safe to push down whole.
      throw new Error('co-located pushdown: unsupported SELECT item');
    };

    const predSql = (w: any): string => {
      if (!w || typeof w !== 'object' || w.expression || w.search) {
        throw new Error('co-located pushdown: unsupported predicate (raw expression / full-text search)');
      }
      const token = String(w.operator || 'EQ').toUpperCase();
      const sqlOp = this.AST_OPERATORS[token];
      if (!sqlOp) throw new Error(`co-located pushdown: unsupported operator "${w.operator}"`);
      const c = col(w.column);
      if (token === 'IS_NULL' || token === 'IS_NOT_NULL') return `${c} ${sqlOp}`;
      if (token === 'IN' || token === 'NIN') {
        const arr = Array.isArray(w.value) ? w.value : [w.value];
        if (arr.length === 0) return token === 'IN' ? '1 = 0' : '1 = 1';
        return `${c} ${sqlOp} (${arr.map((v: any) => placeholder(v)).join(', ')})`;
      }
      if (w.value === null && (token === 'EQ' || token === 'NE')) {
        return `${c} IS ${token === 'NE' ? 'NOT ' : ''}NULL`;
      }
      if (token === 'ILIKE' && dialect !== 'postgres') {
        // ILIKE is Postgres-only; emulate case-insensitive match elsewhere.
        return `LOWER(${c}) LIKE LOWER(${placeholder(w.value)})`;
      }
      return `${c} ${sqlOp} ${placeholder(w.value)}`;
    };

    const limitOffset = (node: any): string => {
      let s = '';
      const lim = node.limit, off = node.offset;
      if (dialect === 'oracle') {
        if (typeof off === 'number' && off > 0) s += ` OFFSET ${Math.floor(off)} ROWS`;
        if (typeof lim === 'number' && lim >= 0) s += ` FETCH ${off && off > 0 ? 'NEXT' : 'FIRST'} ${Math.floor(lim)} ROWS ONLY`;
      } else {
        if (typeof lim === 'number' && lim >= 0) s += ` LIMIT ${Math.floor(lim)}`;
        if (typeof off === 'number' && off > 0) s += ` OFFSET ${Math.floor(off)}`;
      }
      return s;
    };

    const compile = (node: any): string => {
      if (!node || typeof node !== 'object') throw new Error('co-located pushdown: empty query node');
      const pre = withPrefix(node);   // '' when no WITH clause
      // Set operations — every leg is on the same physical DB, so recurse and combine.
      for (const [key, op] of [['union', 'UNION'], ['intersect', 'INTERSECT'], ['except', 'EXCEPT']] as const) {
        if (Array.isArray(node[key])) {
          if (node[key].length < 2) throw new Error(`co-located pushdown: ${op} needs >= 2 legs`);
          const body = node[key].map((leg: any) => `(${compile(leg)})`).join(` ${op} `);
          return pre + body + (node.orderBy?.length ? ` ORDER BY ${node.orderBy.map((o: any) => `${col(o.column || o.field)} ${(o.direction || o.dir) === 'DESC' ? 'DESC' : 'ASC'}`).join(', ')}` : '') + limitOffset(node);
        }
      }
      if (!node.from) throw new Error('co-located pushdown: missing FROM');

      const distinct = node.distinct ? 'DISTINCT ' : '';
      const cols = Array.isArray(node.select) && node.select.length > 0
        ? node.select.map(selectSql).join(', ')
        : '*';
      let text = `${pre}SELECT ${distinct}${cols} FROM ${tableRef(node.from)}`;

      if (Array.isArray(node.joins)) {
        for (const j of node.joins) {
          const jt = String(j.type || 'INNER').toUpperCase();
          if (!['INNER', 'LEFT', 'RIGHT', 'FULL'].includes(jt)) throw new Error(`co-located pushdown: unsupported join type "${j.type}"`);
          if (!j.on || !j.on.left || !j.on.right) throw new Error('co-located pushdown: JOIN missing ON');
          const onOp = this.AST_OPERATORS[String(j.on.operator || 'EQ').toUpperCase()];
          if (!onOp) throw new Error(`co-located pushdown: unsupported join operator "${j.on.operator}"`);
          text += ` ${jt}${jt === 'FULL' ? ' OUTER' : ''} JOIN ${tableRef(j)} ON ${col(j.on.left)} ${onOp} ${col(j.on.right)}`;
        }
      }

      if (Array.isArray(node.where) && node.where.length > 0) {
        text += ` WHERE ${node.where.map(predSql).join(' AND ')}`;
      }
      if (Array.isArray(node.groupBy) && node.groupBy.length > 0) {
        text += ` GROUP BY ${node.groupBy.map((g: any) => col(String(g))).join(', ')}`;
      }
      if (Array.isArray(node.having) && node.having.length > 0) {
        text += ` HAVING ${node.having.map(predSql).join(' AND ')}`;
      }
      if (Array.isArray(node.orderBy) && node.orderBy.length > 0) {
        text += ` ORDER BY ${node.orderBy.map((o: any) => `${col(o.column || o.field)} ${(o.direction || o.dir) === 'DESC' ? 'DESC' : 'ASC'}`).join(', ')}`;
      }
      text += limitOffset(node);
      return text;
    };

    return { text: compile(ast), params };
  }

  /**
   * Compile a canonical SELECT into a MongoDB find() specification.
   * Non-aggregate path only — use (@link toMongoAggregate) when the query has
   * `groupBy`/`aggregates`. Excludes Mongo's implicit `_id` from the projection
   * (unless explicitly requested) so projected rows line up with relational
   * rows for set-ops/joins.
   * @param input the canonical query (select/filter/orderBy/limit/offset).
   * @returns `(filter, projection?, sort?, limit?, skip?)` for `collection.find()`.
   */
  static toMongo(input: CanonicalQuery): CompiledMongo {
    const { select, filter, orderBy, limit, offset } = input;
    const out: CompiledMongo = { filter: this.mongoMatch(filter) };

    if (select && select.length > 0 && !select.includes('*')) {
      out.projection = {};
      for (const c of select) {
        if (!c.includes('(') && !c.includes(' ')) out.projection[this.ident(c)] = 1;
      }
      // SQL-like projection: exclude Mongo's implicit _id unless it was explicitly
      // requested, so projected rows match relational rows (set-ops, UNION dedup, joins).
      if (Object.keys(out.projection).length > 0 && !('_id' in out.projection)) out.projection._id = 0;
    }

    if (orderBy && orderBy.length > 0) {
      out.sort = {};
      for (const o of orderBy) out.sort[o.field] = o.dir === 'DESC' ? -1 : 1;
    }

    if (typeof limit === 'number' && limit >= 0) out.limit = Math.floor(limit);
    if (typeof offset === 'number' && offset > 0) out.skip = Math.floor(offset);

    return out;
  }

  /**
   * Translate a canonical filter map into a MongoDB match document.
   * A single `$eq` collapses to Mongo's shorthand `(key: value)`; multiple
   * operators on one column merge into one sub-document (e.g. a range).
   * `$like`/`$ilike` compile to an anchored `$regex` (SQL wildcards `%`/`_`
   * translated to `.*`/`.`); `$match`/`$fuzzy` compile to an unanchored,
   * case-insensitive `$regex` substring match (Mongo has no native full-text
   * operator in a plain `find()`).
   * @param filter the canonical filter map, if any.
   * @returns the Mongo match document (`()` if `filter` is omitted).
   */
  private static mongoMatch(filter?: Record<string, any>): Record<string, any> {
    const match: Record<string, any> = {};
    if (!filter) return match;
    for (const key of Object.keys(filter)) {
      const ops = this.splitOps(filter[key]);
      // Single equality → shorthand { key: value }.
      if (ops.length === 1 && ops[0]!.op === '$eq') { match[key] = ops[0]!.value; continue; }
      // Otherwise merge every operator into one field sub-document (e.g. range).
      const sub: Record<string, any> = {};
      for (const { op, value } of ops) {
        if (op === '$eq') sub.$eq = value;
        else if (MONGO_OPERATORS.has(op)) sub[op] = value;
        else if (op === '$like' || op === '$ilike') {
          const pattern = String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/%/g, '.*').replace(/_/g, '.');
          sub.$regex = `^${pattern}$`; sub.$options = op === '$ilike' ? 'i' : '';
        } else if (op === '$match' || op === '$fuzzy') {
          sub.$regex = String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); sub.$options = 'i';
        } else sub[op] = value;
      }
      match[key] = sub;
    }
    return match;
  }

  /**
   * SQL for a group entry in the GROUP BY clause (plain col or date bucket).
   * @param g a plain grouping column, or a `(field, dateInterval)` date bucket.
   * @param dialect target SQL dialect (MySQL uses `DATE()`; others use `date_trunc`).
   * @returns the SQL expression to group by.
   */
  private static groupBySql(g: GroupBy, dialect: SqlDialect): string {
    if (g && typeof g === 'object' && g.dateInterval) {
      const col = this.quoteColumn(g.field, dialect);
      if (dialect === 'mysql') return `DATE(${col})`;
      if (dialect === 'oracle') return `TRUNC(${col})`;   // Oracle has no date_trunc
      return `date_trunc('${g.dateInterval}', ${col})`;
    }
    return this.quoteColumn(g as string, dialect);
  }

  /**
   * SQL for a group entry in the SELECT list (date buckets aliased to the field name).
   * @param g a plain grouping column, or a `(field, dateInterval)` date bucket.
   * @param dialect target SQL dialect.
   * @returns the SELECT-list expression (date buckets are aliased back to their field name).
   */
  private static groupSelectSql(g: GroupBy, dialect: SqlDialect): string {
    if (g && typeof g === 'object' && g.dateInterval) {
      return `${this.groupBySql(g, dialect)} AS ${this.quoteIdent(g.field, dialect)}`;
    }
    return this.quoteColumn(g as string, dialect);
  }

  /**
   * SQL expression for a single aggregate spec.
   * PERCENTILE uses `percentile_cont` on Postgres/Snowflake; MySQL has no
   * direct equivalent so it falls back to `AVG` there (an approximation,
   * documented so callers aren't surprised by the degradation).
   * @param a the aggregate spec (`func`, optional `column`, `percent` for PERCENTILE).
   * @param dialect target SQL dialect.
   * @returns the SQL aggregate expression (unaliased — the caller adds `AS alias`).
   */
  private static aggExprSql(a: AggregateSpec, dialect: SqlDialect): string {
    const col = a.column ? this.quoteColumn(a.column, dialect) : '*';
    switch (a.func) {
      case 'COUNT': return `COUNT(${a.column ? col : '*'})`;
      case 'COUNT_DISTINCT': return `COUNT(DISTINCT ${col})`;
      case 'SUM': return `SUM(${col})`;
      case 'MIN': return `MIN(${col})`;
      case 'MAX': return `MAX(${col})`;
      case 'AVG': return `AVG(${col})`;
      case 'PERCENTILE': {
        const p = (a.percent ?? 95) / 100;
        // percentile_cont is supported by Postgres & Snowflake; MySQL has no direct
        // equivalent, so fall back to AVG there.
        return dialect === 'mysql' ? `AVG(${col})` : `percentile_cont(${p}) WITHIN GROUP (ORDER BY ${col})`;
      }
      default: return `COUNT(*)`;
    }
  }

  /**
   * Compile a canonical aggregate query into a MongoDB aggregation pipeline.
   * Produces flat rows keyed by group columns + aggregate aliases.
   * Pipeline shape: `$match` (from (@link mongoMatch)) → `$group` (by
   * `groupBy` fields — a date-bucket entry degrades to grouping on its plain
   * field, since `date_histogram`/`date_trunc` bucketing is a SQL/ES-only
   * feature here) → `$project` (flattens `_id.<field>` back to top-level
   * columns, and turns `COUNT_DISTINCT`'s `$addToSet` array into its `$size`)
   * → optional `$sort`/`$limit`.
   * @param input the canonical query (filter/groupBy/aggregates/orderBy/limit).
   * @returns the MongoDB aggregation pipeline stages, in execution order.
   */
  static toMongoAggregate(input: CanonicalQuery): any[] {
    const { filter, groupBy = [], aggregates = [], orderBy, limit } = input;
    const pipeline: any[] = [];

    const match = this.mongoMatch(filter);
    if (Object.keys(match).length > 0) pipeline.push({ $match: match });

    // Mongo groups by plain fields; a date-bucket group entry degrades to its field
    // (date_histogram is an ES/SQL feature — documented).
    const groupFields = groupBy.map((g) => (g && typeof g === 'object' ? g.field : g));
    const id: Record<string, string> = {};
    for (const g of groupFields) id[this.ident(g)] = `$${g}`;

    const group: Record<string, any> = { _id: groupBy.length ? id : null };
    const distinctAliases: string[] = [];
    for (const a of aggregates) {
      switch (a.func) {
        case 'COUNT': group[a.alias] = { $sum: 1 }; break;
        case 'SUM': group[a.alias] = { $sum: `$${a.column}` }; break;
        case 'MIN': group[a.alias] = { $min: `$${a.column}` }; break;
        case 'MAX': group[a.alias] = { $max: `$${a.column}` }; break;
        case 'AVG': group[a.alias] = { $avg: `$${a.column}` }; break;
        case 'COUNT_DISTINCT': group[a.alias] = { $addToSet: `$${a.column}` }; distinctAliases.push(a.alias); break;
      }
    }
    pipeline.push({ $group: group });

    // Flatten _id.<g> back to top-level columns and turn distinct sets into counts.
    const project: Record<string, any> = { _id: 0 };
    for (const g of groupFields) project[g] = `$_id.${this.ident(g)}`;
    for (const a of aggregates) project[a.alias] = distinctAliases.includes(a.alias) ? { $size: `$${a.alias}` } : `$${a.alias}`;
    pipeline.push({ $project: project });

    if (orderBy && orderBy.length > 0) {
      const sort: Record<string, 1 | -1> = {};
      for (const o of orderBy) sort[o.field] = o.dir === 'DESC' ? -1 : 1;
      pipeline.push({ $sort: sort });
    }
    if (typeof limit === 'number' && limit >= 0) pipeline.push({ $limit: Math.floor(limit) });

    return pipeline;
  }
}
