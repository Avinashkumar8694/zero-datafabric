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

export type SqlDialect = 'postgres' | 'mysql' | 'snowflake';

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
    return dialect === 'mysql' ? `\`${safe}\`` : `"${safe}"`;
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

    // Placeholder generator per dialect (postgres: $n, mysql/snowflake: ?).
    const placeholder = (val: any): string => {
      params.push(val);
      return dialect === 'postgres' ? `$${params.length}` : '?';
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

    if (typeof limit === 'number' && limit >= 0) text += ` LIMIT ${Math.floor(limit)}`;
    if (typeof offset === 'number' && offset > 0) text += ` OFFSET ${Math.floor(offset)}`;

    return { text, params };
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
      return dialect === 'mysql' ? `DATE(${col})` : `date_trunc('${g.dateInterval}', ${col})`;
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
