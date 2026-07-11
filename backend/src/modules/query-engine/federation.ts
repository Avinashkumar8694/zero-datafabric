/**
 * FederationExecutor
 * ------------------
 * Executes CROSS_ENGINE queries: those whose legs span more than one source
 * (e.g. a JOIN of ds1.customer and ds2.customer, or a UNION of a Postgres table
 * and a MongoDB collection).
 *
 * The whole point is to NOT fetch each table wholesale and filter in memory.
 * For joins it uses the same techniques a real federated engine does:
 *
 *   1. Predicate pushdown        - each WHERE conjunct is attributed to its leg
 *                                  (by alias) and pushed to that source.
 *   2. Transitive propagation    - `c1.id = 5` + join `c1.id = c2.id` also pushes
 *                                  `c2.id = 5` to the other source, so BOTH sides
 *                                  are filtered before any rows are fetched.
 *   3. Bind join (semi-join)     - fetch the filtered driving side first, collect
 *                                  its join-key values, then push `key IN (...)`
 *                                  to the other side so it only returns rows that
 *                                  can match.
 *   4. Collision-safe output     - join columns are qualified by alias so two
 *                                  same-named tables don't overwrite each other.
 *
 * Safety: every leg fetch is bounded by `maxRowsPerLeg`
 * (env FABRIC_FED_MAX_ROWS_PER_LEG, default 50000). A leg that hits the cap is
 * truncated with an explicit warning — never silently. Bind-join IN lists are
 * bounded by FABRIC_FED_BIND_MAX_KEYS (default 1000); above that a leg falls back
 * to a bounded full fetch (also warned).
 */

import { queryWithContext } from '../../config/database';
import { ConnectorFactory, ElasticsearchConnector } from '../metadata/connectors/factory';
import { PushdownCompiler, CanonicalQuery } from './pushdown';
import { QueryPlan, QueryPlanner, LOCAL_SOURCE, ResolvedLeg } from './planner';
import { parseAggregates, partialSpec, mergePartials, aggregateRaw, AggregatePlan } from './aggregate';

function maxRowsPerLeg(): number {
  const raw = Number(process.env.FABRIC_FED_MAX_ROWS_PER_LEG);
  return Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : 50000;
}
function bindMaxKeys(): number {
  const raw = Number(process.env.FABRIC_FED_BIND_MAX_KEYS);
  return Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : 1000;
}

// AST where-operator codes -> canonical $ops understood by PushdownCompiler.
const AST_OP_TO_CANONICAL: Record<string, string> = {
  EQ: '$eq', '=': '$eq',
  NE: '$ne', '!=': '$ne', '<>': '$ne',
  GT: '$gt', '>': '$gt',
  GTE: '$gte', '>=': '$gte',
  LT: '$lt', '<': '$lt',
  LTE: '$lte', '<=': '$lte',
  LIKE: '$like', ILIKE: '$ilike', IN: '$in',
  MATCH: '$match', SEARCH: '$match', CONTAINS: '$match',
  FUZZY: '$fuzzy',
};

function baseColumn(path: string): string {
  const s = String(path || '');
  return s.includes('.') ? s.split('.').pop()! : s;
}
function aliasOf(path: string): string | null {
  const s = String(path || '');
  return s.includes('.') ? s.slice(0, s.lastIndexOf('.')) : null;
}
function readColumn(row: any, path: string): any {
  if (row == null) return undefined;
  if (path in row) return row[path];
  return row[baseColumn(path)];
}

/**
 * Structured, per-leg record of what actually executed at each source. This is
 * the evidence that the fabric pushed work to the right engine (with the real
 * pushed-down query + how many rows came back + how long it took) rather than
 * fetching whole tables and filtering in memory.
 */
export interface LegTrace {
  source: string;
  engine: string;
  /** 'local' = executed inside the tenant Postgres hub; 'connector' = pushed to the remote engine */
  mode: 'local' | 'connector';
  /** what role this leg played: scan / set-op-leg / join-driving / bind-join / partial-aggregate / aggregate */
  operation: string;
  /** physical location the query hit (schema.table or db.collection) */
  target: string;
  /** the ACTUAL request pushed to the source (SQL text or Mongo find/aggregate spec) */
  query: string;
  /** bound parameters for the pushed SQL, when applicable */
  params?: any[];
  /** number of rows the source returned for this leg */
  rowsReturned: number;
  /** wall-clock milliseconds spent fetching this leg */
  ms: number;
}

export interface FederationResult {
  data: any[];
  warnings: string[];
  pushed: string[];
  /** per-leg execution trace (proof of where each query ran and what it pushed) */
  trace: LegTrace[];
}

interface LegMeta {
  alias: string;
  source: string;
  resource: string;
  joinType: string | null; // null for the driving leg
  on: { left: string; operator: string; right: string } | null;
}

export class FederationExecutor {
  /** Convert an AST leg (from/select/where/orderBy) into the canonical pushdown shape. */
  private static astLegToCanonical(legAst: any): CanonicalQuery {
    const canonical: CanonicalQuery = {};

    if (Array.isArray(legAst.select) && !legAst.select.includes('*')) {
      const cols: string[] = [];
      let pushable = true;
      for (const c of legAst.select) {
        if (typeof c === 'string') cols.push(c);
        else if (c && c.column && !c.aggregate && !c.window && !c.expression) cols.push(c.column);
        else { pushable = false; break; }
      }
      if (pushable && cols.length > 0) canonical.select = cols;
    }

    if (Array.isArray(legAst.where) && legAst.where.length > 0) {
      const filter: Record<string, any> = {};
      let pushable = true;
      for (const w of legAst.where) {
        if (!w || !w.column || w.expression || w.search) { pushable = false; break; }
        const op = AST_OP_TO_CANONICAL[String(w.operator || 'EQ').toUpperCase()] || '$eq';
        // Merge — a column may carry multiple predicates (e.g. a range col>=x AND col<=y);
        // keying by column and overwriting would silently drop one bound.
        filter[w.column] = { ...(filter[w.column] || {}), [op]: w.value };
      }
      if (pushable) canonical.filter = filter;
    }

    if (Array.isArray(legAst.orderBy) && legAst.orderBy.length > 0) {
      canonical.orderBy = legAst.orderBy.map((o: any) => ({ field: o.column, dir: o.direction === 'DESC' ? 'DESC' : 'ASC' }));
    }
    if (typeof legAst.limit === 'number') canonical.limit = legAst.limit;
    if (typeof legAst.offset === 'number') canonical.offset = legAst.offset;
    return canonical;
  }

  /**
   * Fetch one leg from its OWN source with the supplied pushdown, bounded by the cap.
   * Named sources are queried through their connector (pushing predicates to the real
   * remote); only the hub / locally-synced data is read from the tenant Postgres schema.
   */
  private static async fetchLegDirect(
    tenantId: string,
    ref: { source: string; resource: string; canonical: CanonicalQuery },
    plan: QueryPlan,
    tenantSchema: string,
    warnings: string[],
    trace: LegTrace[],
    operation = 'scan'
  ): Promise<any[]> {
    const key = `${ref.source}::${ref.resource}`;
    const leg: ResolvedLeg = plan.resolveMap[key] || (await QueryPlanner.resolveLeg(tenantId, ref.source, ref.resource));

    const cap = maxRowsPerLeg();
    const explicitLimit = ref.canonical.limit;
    const effectiveLimit = Math.min(cap, explicitLimit ?? cap);
    const bounded = { ...ref.canonical, limit: effectiveLimit };
    const hadExplicitSmallerLimit = typeof explicitLimit === 'number' && explicitLimit < cap;

    const useLocal = leg.source === LOCAL_SOURCE || leg.syncType === 'SYNC' || leg.syncType === 'CDC';

    const started = Date.now();
    let rows: any[];
    let queryText: string;
    let queryParams: any[] | undefined;
    let target: string;

    if (useLocal) {
      const schema = leg.source === LOCAL_SOURCE ? tenantSchema : (leg.physicalSchema || tenantSchema);
      const table = leg.physicalTable || ref.resource;
      target = `${schema}.${table}`;
      const compiled = PushdownCompiler.toSql({ ...bounded, schema, table, dialect: 'postgres' });
      queryText = compiled.text;
      queryParams = compiled.params;
      console.log(`[Federation] local leg ${ref.source}.${ref.resource}: ${compiled.text} :: ${JSON.stringify(compiled.params)}`);
      const res = await queryWithContext(compiled.text, compiled.params, { tenantId, username: 'system' });
      rows = res.rows;
    } else {
      const schema = leg.physicalSchema || tenantSchema;
      const table = leg.physicalTable || ref.resource;
      target = `${schema}.${table}`;
      // Compile a faithful preview of what the connector pushes to the remote engine.
      const preview = this.previewConnectorQuery(leg.engine, { ...bounded, schema, table });
      queryText = preview.text;
      queryParams = preview.params;
      console.log(`[Federation] connector leg ${ref.source}.${ref.resource} (${leg.engine}): ${queryText}`);
      const connector = ConnectorFactory.getConnector(leg.engine, leg.config);
      try {
        rows = await connector.query(schema, table, bounded);
      } finally {
        await connector.close();
      }
    }

    const ms = Date.now() - started;
    const entry: LegTrace = {
      source: ref.source, engine: leg.engine, mode: useLocal ? 'local' : 'connector',
      operation, target, query: queryText, rowsReturned: rows.length, ms,
    };
    if (queryParams && queryParams.length) entry.params = queryParams;
    trace.push(entry);

    if (rows.length >= cap && !hadExplicitSmallerLimit) {
      warnings.push(`Leg "${ref.source}.${ref.resource}" reached the ${cap}-row federation cap and was truncated; add filters or a smaller limit for complete results.`);
    }
    return rows;
  }

  /** Faithful string preview of the request a connector pushes to its remote engine. */
  private static previewConnectorQuery(
    engine: string, input: CanonicalQuery & { schema: string; table: string }
  ): { text: string; params?: any[] } {
    const eng = String(engine || '').toUpperCase();
    const hasAgg = Array.isArray(input.aggregates) && input.aggregates.length > 0;
    try {
      if (eng === 'MONGODB') {
        if (hasAgg) return { text: `db.${input.table}.aggregate(${JSON.stringify(PushdownCompiler.toMongoAggregate(input))})` };
        const m = PushdownCompiler.toMongo(input);
        const parts = [`filter: ${JSON.stringify(m.filter)}`];
        if (m.projection) parts.push(`project: ${JSON.stringify(m.projection)}`);
        if (m.sort) parts.push(`sort: ${JSON.stringify(m.sort)}`);
        if (typeof m.limit === 'number') parts.push(`limit: ${m.limit}`);
        return { text: `db.${input.table}.find({ ${parts.join(', ')} })` };
      }
      if (eng === 'ELASTICSEARCH' || eng === 'ELASTIC' || eng === 'ES') {
        return { text: ElasticsearchConnector.previewBody(input, input.table) };
      }
      const dialect = eng === 'MYSQL' ? 'mysql' : eng === 'SNOWFLAKE' ? 'snowflake' : 'postgres';
      const compiled = PushdownCompiler.toSql({ ...input, dialect });
      return { text: compiled.text, params: compiled.params };
    } catch {
      return { text: `${input.schema}.${input.table} [${JSON.stringify(input.filter || {})}]` };
    }
  }

  // ---------- set operations ----------

  private static serialize(row: any): string {
    const keys = Object.keys(row).sort();
    return JSON.stringify(keys.map((k) => [k, row[k]]));
  }

  private static applyOrderLimit(rows: any[], ast: any): any[] {
    let out = rows;
    if (Array.isArray(ast.orderBy) && ast.orderBy.length > 0) {
      out = [...out].sort((a, b) => {
        for (const o of ast.orderBy) {
          const av = readColumn(a, o.column), bv = readColumn(b, o.column);
          if (av < bv) return o.direction === 'DESC' ? 1 : -1;
          if (av > bv) return o.direction === 'DESC' ? -1 : 1;
        }
        return 0;
      });
    }
    if (typeof ast.limit === 'number' && ast.limit >= 0) out = out.slice(0, ast.limit);
    return out;
  }

  private static async executeSetOp(
    tenantId: string, ast: any, plan: QueryPlan, tenantSchema: string, warnings: string[], pushed: string[], trace: LegTrace[]
  ): Promise<any[]> {
    const op = ast.union ? 'UNION' : ast.intersect ? 'INTERSECT' : 'EXCEPT';
    const legs: any[] = ast.union || ast.intersect || ast.except;

    const legResults: any[][] = [];
    for (const leg of legs) {
      if (Array.isArray(leg.joins) && leg.joins.length) throw new Error('FederationExecutor: nested JOIN inside a set-op leg is not supported');
      const canonical = this.astLegToCanonical(leg);
      pushed.push(`${op} leg ${leg.from?.source || LOCAL_SOURCE}.${leg.from?.resource}: pushed ${Object.keys(canonical.filter || {}).length} predicate(s)`);
      legResults.push(await this.fetchLegDirect(tenantId, { source: leg.from?.source || LOCAL_SOURCE, resource: leg.from?.resource, canonical }, plan, tenantSchema, warnings, trace, `${op.toLowerCase()}-leg`));
    }

    const first: any[] = legResults[0] || [];
    const rest: any[][] = legResults.slice(1);
    if (op === 'UNION') {
      const seen = new Set<string>(); const out: any[] = [];
      for (const set of legResults) for (const row of set) { const k = this.serialize(row); if (!seen.has(k)) { seen.add(k); out.push(row); } }
      return this.applyOrderLimit(out, ast);
    }
    if (op === 'INTERSECT') {
      const restSets = rest.map((s) => new Set(s.map((r) => this.serialize(r))));
      const seen = new Set<string>(); const out: any[] = [];
      for (const row of first) { const k = this.serialize(row); if (seen.has(k)) continue; if (restSets.every((s) => s.has(k))) { seen.add(k); out.push(row); } }
      return this.applyOrderLimit(out, ast);
    }
    const excludeSets = rest.map((s) => new Set(s.map((r) => this.serialize(r))));
    const seen = new Set<string>(); const out: any[] = [];
    for (const row of first) { const k = this.serialize(row); if (seen.has(k)) continue; if (!excludeSets.some((s) => s.has(k))) { seen.add(k); out.push(row); } }
    return this.applyOrderLimit(out, ast);
  }

  // ---------- joins ----------

  /**
   * Build a per-alias pushdown filter map from the top-level WHERE, then apply
   * transitive propagation across equijoin keys so a constant on one side of a
   * join reaches the other side.
   */
  private static buildLegFilters(legMetas: LegMeta[], where: any[]): Record<string, Record<string, any>> {
    const aliasSet = new Set(legMetas.map((l) => l.alias));
    const perAlias: Record<string, Record<string, any>> = {};
    const addFilter = (alias: string, col: string, op: string, value: any) => {
      const f = (perAlias[alias] ||= {});
      // Merge multiple predicates on the same column (e.g. a range) instead of overwriting.
      f[col] = { ...(f[col] && typeof f[col] === 'object' ? f[col] : {}), [op]: value };
    };

    // 1. Attribute qualified WHERE conjuncts to their leg.
    for (const w of where || []) {
      if (!w || !w.column || w.expression || w.search) continue;
      const alias = aliasOf(w.column);
      if (alias && aliasSet.has(alias)) {
        const op = AST_OP_TO_CANONICAL[String(w.operator || 'EQ').toUpperCase()] || '$eq';
        addFilter(alias, baseColumn(w.column), op, w.value);
      }
    }

    // 2. Union-find over qualified columns connected by equijoins (operator EQ / =).
    const parent: Record<string, string> = {};
    const find = (x: string): string => { parent[x] ??= x; return parent[x] === x ? x : (parent[x] = find(parent[x])); };
    const union = (a: string, b: string) => { parent[find(a)] = find(b); };
    for (const lm of legMetas) {
      if (lm.on && ['EQ', '='].includes(String(lm.on.operator || 'EQ').toUpperCase())) {
        if (aliasOf(lm.on.left) && aliasOf(lm.on.right)) union(lm.on.left, lm.on.right);
      }
    }

    // 3. Seed equality constants (col = value) from the attributed filters, keyed by qualified column.
    const constByNode: Record<string, any> = {};
    for (const lm of legMetas) {
      const f = perAlias[lm.alias];
      if (!f) continue;
      for (const col of Object.keys(f)) {
        const spec = f[col];
        if (spec && typeof spec === 'object' && '$eq' in spec) constByNode[`${lm.alias}.${col}`] = spec.$eq;
      }
    }

    // 4. Propagate each class's constant to every member column (both sides of the join).
    const classConst: Record<string, any> = {};
    for (const node of Object.keys(constByNode)) classConst[find(node)] = constByNode[node];
    for (const node of Object.keys(parent)) {
      const root = find(node);
      if (!(root in classConst)) continue;
      const alias = aliasOf(node); const col = baseColumn(node);
      if (alias && aliasSet.has(alias)) {
        (perAlias[alias] ||= {});
        if (!perAlias[alias][col]) perAlias[alias][col] = { $eq: classConst[root] };
      }
    }

    return perAlias;
  }

  /** Qualify every column of a leg's rows with its alias so joins never collide. */
  private static qualify(rows: any[], alias: string): any[] {
    return rows.map((r) => {
      const out: any = {};
      for (const k of Object.keys(r)) out[`${alias}.${k}`] = r[k];
      return out;
    });
  }

  private static async executeJoin(
    tenantId: string, ast: any, plan: QueryPlan, tenantSchema: string, warnings: string[], pushed: string[], trace: LegTrace[]
  ): Promise<any[]> {
    const fromAlias = ast.from.alias || ast.from.resource;
    const legMetas: LegMeta[] = [
      { alias: fromAlias, source: ast.from.source || LOCAL_SOURCE, resource: ast.from.resource, joinType: null, on: null },
      ...ast.joins.map((j: any) => ({ alias: j.alias || j.resource, source: j.source || LOCAL_SOURCE, resource: j.resource, joinType: (j.type || 'INNER').toUpperCase(), on: j.on })),
    ];

    const legFilters = this.buildLegFilters(legMetas, ast.where || []);
    const bindMax = bindMaxKeys();

    // Driving leg: fetch with its (possibly propagated) predicate, then qualify columns.
    const driving = legMetas[0]!;
    const drivingFilter = legFilters[driving.alias];
    if (drivingFilter && Object.keys(drivingFilter).length) pushed.push(`pushed ${Object.keys(drivingFilter).length} predicate(s) to ${driving.source}.${driving.resource}`);
    let acc = this.qualify(
      await this.fetchLegDirect(tenantId, { source: driving.source, resource: driving.resource, canonical: { filter: drivingFilter } }, plan, tenantSchema, warnings, trace, 'join-driving'),
      driving.alias
    );

    // Each subsequent leg: push its own predicate + a bind-join IN(...) on the join key.
    for (const lm of legMetas.slice(1)) {
      const on = lm.on!;
      const rightBaseCol = baseColumn(on.right);
      const isEquiJoin = ['EQ', '='].includes(String(on.operator || 'EQ').toUpperCase());
      const filter: Record<string, any> = { ...(legFilters[lm.alias] || {}) };

      // Cross-engine RIGHT/FULL cannot be reproduced by this left-driven hash join.
      if (lm.joinType === 'RIGHT' || lm.joinType === 'FULL') {
        warnings.push(`Cross-engine ${lm.joinType} JOIN on "${lm.source}.${lm.resource}" is not supported; executed as INNER (right-only rows are dropped).`);
      }

      // Bind join: only valid for an equijoin that keeps left rows driven (INNER/LEFT).
      const canBind = isEquiJoin && (lm.joinType === 'INNER' || lm.joinType === 'LEFT' || lm.joinType === 'RIGHT' || lm.joinType === 'FULL');
      let skipFetch = false;
      if (canBind) {
        const leftVals = Array.from(new Set(acc.map((r) => readColumn(r, on.left)).filter((v) => v !== undefined && v !== null)));
        if (leftVals.length === 0) {
          // No left key can match — don't touch the other source at all.
          skipFetch = true;
          pushed.push(`bind-join: driving side has no keys, skipped fetch of ${lm.source}.${lm.resource}`);
        } else if (leftVals.length <= bindMax) {
          filter[rightBaseCol] = { $in: leftVals };
          pushed.push(`bind-join: pushed ${leftVals.length} key(s) as ${rightBaseCol} IN (...) to ${lm.source}.${lm.resource}`);
        } else {
          warnings.push(`Bind-join to "${lm.source}.${lm.resource}" skipped: ${leftVals.length} join keys exceed the ${bindMax} limit; leg fetched with a bounded full scan.`);
        }
      } else if (!isEquiJoin) {
        pushed.push(`non-equi join to ${lm.source}.${lm.resource}: bind-join not applicable, bounded fetch`);
      }

      const didBind = !!(filter[rightBaseCol] && typeof filter[rightBaseCol] === 'object' && '$in' in filter[rightBaseCol]);
      const right = skipFetch ? [] : this.qualify(
        await this.fetchLegDirect(tenantId, { source: lm.source, resource: lm.resource, canonical: { filter } }, plan, tenantSchema, warnings, trace, didBind ? 'bind-join' : 'join-probe'),
        lm.alias
      );

      // In-memory hash join on the (qualified) ON keys.
      const keepUnmatchedLeft = lm.joinType === 'LEFT';
      if (isEquiJoin) {
        const index = new Map<any, any[]>();
        for (const r of right) { const k = r[on.right]; const b = index.get(k); if (b) b.push(r); else index.set(k, [r]); }
        const merged: any[] = [];
        for (const l of acc) {
          const matches = index.get(l[on.left]) || [];
          if (matches.length === 0) { if (keepUnmatchedLeft) merged.push({ ...l }); }
          else for (const r of matches) merged.push({ ...l, ...r });
        }
        acc = merged;
      } else {
        // Non-equi join: nested-loop evaluate the ON predicate in memory (bounded inputs).
        const merged: any[] = [];
        for (const l of acc) {
          let matched = false;
          for (const r of right) {
            if (this.evalOn(l[on.left], on.operator, r[on.right])) { merged.push({ ...l, ...r }); matched = true; }
          }
          if (!matched && keepUnmatchedLeft) merged.push({ ...l });
        }
        acc = merged;
      }
    }

    // Return post-WHERE joined rows; projection / aggregation / order+limit are
    // applied centrally in execute() so the aggregate path sees raw joined rows.
    return this.applyWhere(acc, ast.where);
  }

  /**
   * Fan aggregate: push a PARTIAL aggregate to each source, then merge partials.
   * Each source returns #groups rows (not #rows) — the resource-efficient path.
   */
  private static async fanAggregate(
    tenantId: string, ast: any, legs: any[], plan: AggregatePlan, qplan: QueryPlan, tenantSchema: string,
    warnings: string[], pushed: string[], trace: LegTrace[]
  ): Promise<any[]> {
    const partial = partialSpec(plan);
    const allPartials: any[] = [];
    for (const leg of legs) {
      const legCanon = this.astLegToCanonical(leg);
      const canonical: CanonicalQuery = { filter: legCanon.filter, groupBy: partial.groupBy, aggregates: partial.aggregates };
      pushed.push(`partial aggregate [${partial.aggregates.map((a) => a.func).join(',')}] GROUP BY [${partial.groupBy.join(',')}] pushed to ${leg.from?.source || LOCAL_SOURCE}.${leg.from?.resource}`);
      const rows = await this.fetchLegDirect(tenantId, { source: leg.from?.source || LOCAL_SOURCE, resource: leg.from?.resource, canonical }, qplan, tenantSchema, warnings, trace, 'partial-aggregate');
      allPartials.push(...rows);
    }
    pushed.push(`merged ${allPartials.length} partial-group rows across ${legs.length} sources`);
    return this.applyOrderLimit(mergePartials(allPartials, plan), ast);
  }

  private static evalOn(left: any, operator: string, right: any): boolean {
    switch (String(operator || 'EQ').toUpperCase()) {
      case 'NE': case '!=': case '<>': return left != right;
      case 'GT': case '>': return left > right;
      case 'GTE': case '>=': return left >= right;
      case 'LT': case '<': return left < right;
      case 'LTE': case '<=': return left <= right;
      default: return left == right;
    }
  }

  private static applyWhere(rows: any[], where: any[]): any[] {
    if (!Array.isArray(where) || where.length === 0) return rows;
    return rows.filter((row) =>
      where.every((w) => {
        if (!w || !w.column) return true;
        const actual = readColumn(row, w.column); const expected = w.value;
        switch (String(w.operator || 'EQ').toUpperCase()) {
          case 'NE': case '!=': case '<>': return actual != expected;
          case 'GT': case '>': return actual > expected;
          case 'GTE': case '>=': return actual >= expected;
          case 'LT': case '<': return actual < expected;
          case 'LTE': case '<=': return actual <= expected;
          case 'IN': return Array.isArray(expected) && expected.includes(actual);
          case 'LIKE': case 'ILIKE': {
            const re = new RegExp('^' + String(expected).replace(/%/g, '.*').replace(/_/g, '.') + '$', String(w.operator).toUpperCase() === 'ILIKE' ? 'i' : '');
            return re.test(String(actual));
          }
          default: return actual == expected;
        }
      })
    );
  }

  /** Project qualified rows to the requested SELECT columns (pass through on `*`). */
  private static applyProjection(rows: any[], select: any[]): any[] {
    if (!Array.isArray(select) || select.length === 0 || select.includes('*')) return rows;
    const specs = select
      .map((c) => (typeof c === 'string' ? c : c && c.column ? c.column : null))
      .filter(Boolean) as string[];
    if (specs.length === 0) return rows;
    return rows.map((row) => {
      const out: any = {};
      for (const s of specs) {
        if (s in row) out[s] = row[s];
        else { const b = baseColumn(s); const hit = Object.keys(row).find((k) => k === b || baseColumn(k) === b); if (hit) out[s] = row[hit]; }
      }
      return out;
    });
  }

  static async execute(tenantId: string, ast: any, plan: QueryPlan, tenantSchema: string): Promise<FederationResult> {
    const warnings: string[] = [];
    const pushed: string[] = [];
    const trace: LegTrace[] = [];
    let data: any[];

    const outerPlan = parseAggregates(ast.select, ast.groupBy);

    if (ast.union || ast.intersect || ast.except) {
      const legs: any[] = ast.union || ast.intersect || ast.except;
      const isUnion = !!ast.union;
      const legPlans = legs.map((l) => parseAggregates(l.select, l.groupBy));
      if (isUnion && legs.length > 0 && legPlans.every((p) => p && p.aggregates.length > 0)) {
        // Multi-source aggregate: push partial aggregates per source, merge in-fabric.
        data = await this.fanAggregate(tenantId, ast, legs, legPlans[0]!, plan, tenantSchema, warnings, pushed, trace);
      } else {
        data = await this.executeSetOp(tenantId, ast, plan, tenantSchema, warnings, pushed, trace);
      }
    } else if (Array.isArray(ast.joins) && ast.joins.length > 0) {
      const joined = await this.executeJoin(tenantId, ast, plan, tenantSchema, warnings, pushed, trace);
      if (outerPlan) {
        pushed.push(`post-join aggregate: grouped ${joined.length} joined rows by [${outerPlan.groupCols.join(',')}]`);
        data = this.applyOrderLimit(aggregateRaw(joined, outerPlan), ast);
      } else {
        data = this.applyOrderLimit(this.applyProjection(joined, ast.select), ast);
      }
    } else {
      // Single connector leg. Push the FULL aggregate to the one source when present.
      const canonical = this.astLegToCanonical(ast);
      let op = 'scan';
      if (outerPlan && (outerPlan.aggregates.length > 0 || outerPlan.groupCols.length > 0)) {
        canonical.groupBy = outerPlan.groupCols;
        canonical.aggregates = outerPlan.aggregates;
        delete canonical.select;
        op = 'aggregate';
        pushed.push(`pushed aggregate [${outerPlan.aggregates.map((a) => a.func).join(',')}] GROUP BY [${outerPlan.groupCols.join(',')}] to ${ast.from?.source || LOCAL_SOURCE}.${ast.from?.resource}`);
      } else {
        pushed.push(`pushed ${Object.keys(canonical.filter || {}).length} predicate(s) to ${ast.from?.source || LOCAL_SOURCE}.${ast.from?.resource}`);
      }
      data = await this.fetchLegDirect(tenantId, { source: ast.from?.source || LOCAL_SOURCE, resource: ast.from?.resource, canonical }, plan, tenantSchema, warnings, trace, op);
      data = this.applyOrderLimit(data, ast);
    }

    return { data, warnings, pushed, trace };
  }
}
