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
import { PolicyService, MaskRule } from '../security/policy.service';
import { GrantService } from '../security/grant.service';

function maxRowsPerLeg(): number {
  const raw = Number(process.env.FABRIC_FED_MAX_ROWS_PER_LEG);
  return Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : 50000;
}
function bindMaxKeys(): number {
  const raw = Number(process.env.FABRIC_FED_BIND_MAX_KEYS);
  return Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : 1000;
}
// Cost-based driving-side selection (live cardinality probe). On by default;
// set FABRIC_FED_COST_PROBE=0 to always drive from the FROM side.
function costProbeEnabled(): boolean {
  return !/^(0|false|no|off)$/i.test(process.env.FABRIC_FED_COST_PROBE || '1');
}
// When BOTH sides of a 2-leg INNER equijoin are at/below this post-filter row
// count, fetch them in parallel and hash-join (broadcast) — one round-trip of
// latency instead of the two sequential ones a bind-join needs. Default 5000.
function broadcastMaxRows(): number {
  const raw = Number(process.env.FABRIC_FED_BROADCAST_MAX);
  return Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : 5000;
}
// Cap on how many bind-key batches we'll issue before giving up on the semi-join
// and doing a single bounded scan instead (bounds the round-trip fan-out).
function maxBindBatches(): number {
  const raw = Number(process.env.FABRIC_FED_MAX_BIND_BATCHES);
  return Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : 20;
}
/** Split an array into chunks of at most `size`. */
function chunk<T>(arr: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
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
  IS_NULL: '$eq', IS_NOT_NULL: '$ne', // value forced to null in astLegToCanonical
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

/** Per-leg join metadata: which source/resource it targets, and (for every leg but the first) how it joins back to the driving leg. */
interface LegMeta {
  alias: string;
  source: string;
  resource: string;
  joinType: string | null; // null for the driving leg
  on: { left: string; operator: string; right: string } | null;
}

/**
 * Executes CROSS_ENGINE / SINGLE_CONNECTOR queries produced by
 * (@link QueryPlanner.classify): joins, set operations, and aggregates that
 * span more than one source (or a single connector-only source). See the
 * file-level overview for the pushdown/bind-join/transitive-propagation
 * strategy this class implements. All methods are static; the class is never instantiated.
 */
export class FederationExecutor {
  /**
   * Convert an AST leg (from/select/where/orderBy) into the canonical pushdown shape.
   * A projection/filter is only carried over when every entry is "simple"
   * (plain column, or a WHERE predicate with a known operator and no
   * expression/search) — anything else is left off the canonical query so it
   * falls through to in-fabric post-processing instead of being silently
   * mistranslated. Multiple predicates on the same column are merged into one
   * `($op: value, ...)` sub-document (e.g. a range) rather than overwriting.
   * @param legAst one leg of the AST: `(select?, where?, orderBy?, limit?, offset?, distinct?)`.
   * @returns the canonical `(select?, filter?, orderBy?, limit?, offset?, groupBy?)` pushdown shape.
   */
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
        const rawOp = String(w.operator || 'EQ').toUpperCase();
        const op = AST_OP_TO_CANONICAL[rawOp] || '$eq';
        // IS_NULL / IS_NOT_NULL carry no value — force null so it compiles to
        // `IS [NOT] NULL` (SQL) / `{col: null}` (Mongo).
        const val = (rawOp === 'IS_NULL' || rawOp === 'IS_NOT_NULL') ? null : w.value;
        // Merge — a column may carry multiple predicates (e.g. a range col>=x AND col<=y);
        // keying by column and overwriting would silently drop one bound.
        filter[w.column] = { ...(filter[w.column] || {}), [op]: val };
      }
      if (pushable) canonical.filter = filter;
    }

    if (Array.isArray(legAst.orderBy) && legAst.orderBy.length > 0) {
      canonical.orderBy = legAst.orderBy.map((o: any) => ({ field: o.column, dir: o.direction === 'DESC' ? 'DESC' : 'ASC' }));
    }
    if (typeof legAst.limit === 'number') canonical.limit = legAst.limit;
    if (typeof legAst.offset === 'number') canonical.offset = legAst.offset;
    // DISTINCT over plain columns == GROUP BY those columns (no aggregates). Route
    // through the group path so the source dedupes ($group / GROUP BY), matching SQL.
    if (legAst.distinct && Array.isArray(canonical.select) && canonical.select.length && !canonical.groupBy) {
      canonical.groupBy = [...canonical.select];
    }
    return canonical;
  }

  /**
   * Compute the minimal set of columns to fetch from each JOIN leg (projection
   * pushdown). Walks the whole query — `select`, every join `on`, `where`,
   * `orderBy`, `groupBy`, `having` — and attributes each `alias.column`
   * reference to its leg. A leg's fetched columns are the ones it contributes to
   * the final result PLUS its join keys (needed for the in-fabric hash/bind
   * join). Correctness rule: the moment a reference can't be unambiguously tied
   * to one known alias — an unqualified column in a multi-table join, a `*`, a
   * raw expression / window / full-text predicate — this bails and returns
   * `null`, meaning "fetch `*` from every leg". Better to over-fetch than to
   * drop a column the join or projection needs.
   * @param ast the SELECT AST (with `from` + `joins`).
   * @param legMetas the resolved legs (alias/source/resource + `on`).
   * @returns a map `alias -> column names` (a `null` entry = fetch `*` for that
   *   leg), or `null` to disable projection pushdown entirely.
   */
  private static joinLegProjections(ast: any, legMetas: LegMeta[]): Record<string, string[] | null> | null {
    const aliases = new Set(legMetas.map((l) => l.alias));
    const need: Record<string, Set<string> | null> = {};
    for (const l of legMetas) need[l.alias] = new Set<string>();

    let bail = false;
    const addRef = (path: any): void => {
      if (bail) return;
      if (!path || typeof path !== 'string' || path === '*') { bail = true; return; }
      const dot = path.indexOf('.');
      if (dot < 0) { bail = true; return; }                 // unqualified in a multi-table join → ambiguous
      const alias = path.slice(0, dot);
      const col = path.slice(dot + 1);
      if (!aliases.has(alias)) { bail = true; return; }      // unknown alias → be safe
      if (col === '*') { need[alias] = null; return; }        // alias.* → all columns of that leg
      if (need[alias] !== null) need[alias]!.add(baseColumn(col));
    };

    // Final projection.
    if (!Array.isArray(ast.select) || ast.select.length === 0) return null;  // implicit * → fetch all
    for (const c of ast.select) {
      if (bail) break;
      if (typeof c === 'string') addRef(c);
      else if (c && typeof c === 'object') {
        if (c.aggregate) { if (c.column && c.column !== '*') addRef(c.column); }   // COUNT(*) needs no column
        else if (c.column && !c.window && !c.expression) addRef(c.column);
        else { bail = true; }                                                     // expression / window → unknown cols
      } else bail = true;
    }
    // Join keys — always needed to perform the in-fabric join and extract bind keys.
    for (const j of ast.joins || []) { if (j.on) { addRef(j.on.left); addRef(j.on.right); } }
    // Predicates / ordering / grouping that reference specific columns.
    for (const w of ast.where || []) { if (w && w.column) addRef(w.column); else if (w && (w.expression || w.search)) { bail = true; } }
    for (const o of ast.orderBy || []) addRef(o.column);
    for (const g of ast.groupBy || []) addRef(typeof g === 'string' ? g : g?.field);
    for (const h of ast.having || []) { if (h && h.column) addRef(h.column); else if (h && (h.expression || h.search)) { bail = true; } }

    if (bail) return null;
    const out: Record<string, string[] | null> = {};
    for (const alias of aliases) {
      const s = need[alias];
      out[alias] = s == null ? null : Array.from(s);
    }
    return out;
  }

  /**
   * Estimate a leg's POST-FILTER row count by pushing a `COUNT(*)` (with the
   * leg's already-resolved predicate) to its source — the fabric's live
   * cardinality signal for cost-based driving-side selection. The count runs
   * through the same (@link fetchLegDirect) path so it respects GRANTs and the
   * Policy Engine's row predicate (we estimate only rows the caller may see).
   * Probe warnings/traces are discarded (throwaway arrays) so the estimate
   * doesn't pollute the query's audit trail. Returns `null` on any failure
   * (grant denial, unreachable source, non-numeric result), which makes the
   * caller fall back to FROM-side driving.
   * @param tenantId tenant identifier.
   * @param lm the leg to size (`alias`/`source`/`resource`).
   * @param filter the leg's pushed predicate (may be empty/undefined).
   * @param plan the query plan (leg resolution cache + session/policy).
   * @param tenantSchema physical tenant schema for local/synced legs.
   * @returns the estimated visible row count, or `null` if it couldn't be probed.
   */
  private static async estimateLegRows(
    tenantId: string, lm: LegMeta, filter: Record<string, any> | undefined, plan: QueryPlan, tenantSchema: string
  ): Promise<number | null> {
    try {
      const rows = await this.fetchLegDirect(
        tenantId,
        { source: lm.source, resource: lm.resource, canonical: { filter: filter || {}, aggregates: [{ func: 'COUNT', column: null, alias: '__cnt' }] } },
        plan, tenantSchema, [], [], 'card-probe'
      );
      if (!rows || !rows[0]) return null;
      const v = Object.values(rows[0])[0];   // COUNT-only row → single value, casing-proof (Oracle uppercases aliases)
      const n = Number(v);
      return Number.isFinite(n) ? n : null;
    } catch {
      return null;
    }
  }

  /**
   * In-memory join of two already-alias-qualified row sets on `on`. Equijoins
   * build a hash index on the RIGHT side and probe with the LEFT (O(L+R));
   * non-equi joins fall back to a bounded nested loop. `keepUnmatchedLeft`
   * preserves unmatched left rows (LEFT JOIN semantics). Shared by both the
   * broadcast-hash and bind-join paths so the merge logic lives in one place.
   * @param left the driving/probe row set (qualified).
   * @param right the build row set (qualified).
   * @param on the `(left, operator, right)` join clause (columns alias-qualified).
   * @param keepUnmatchedLeft keep left rows with no match (LEFT JOIN).
   * @param isEquiJoin whether `on.operator` is equality (hash) vs other (nested loop).
   * @returns the merged rows (`{...l, ...r}` per match).
   */
  private static mergeJoin(left: any[], right: any[], on: any, keepUnmatchedLeft: boolean, isEquiJoin: boolean): any[] {
    const merged: any[] = [];
    if (isEquiJoin) {
      const index = new Map<any, any[]>();
      for (const r of right) { const k = r[on.right]; const b = index.get(k); if (b) b.push(r); else index.set(k, [r]); }
      for (const l of left) {
        const matches = index.get(l[on.left]) || [];
        if (matches.length === 0) { if (keepUnmatchedLeft) merged.push({ ...l }); }
        else for (const r of matches) merged.push({ ...l, ...r });
      }
    } else {
      for (const l of left) {
        let matched = false;
        for (const r of right) {
          if (this.evalOn(l[on.left], on.operator, r[on.right])) { merged.push({ ...l, ...r }); matched = true; }
        }
        if (!matched && keepUnmatchedLeft) merged.push({ ...l });
      }
    }
    return merged;
  }

  /**
   * Fetch one leg from its OWN source with the supplied pushdown, bounded by the cap.
   * Named sources are queried through their connector (pushing predicates to the real
   * remote); only the hub / locally-synced data is read from the tenant Postgres schema.
   * For connector legs this also resolves and injects the Policy Engine's row
   * predicate and enforces GRANTs (non-RLS engines can't do either themselves),
   * and applies any column-masking rules to the returned rows. Every fetch is
   * recorded into `trace` (source/engine/mode/operation/target/query/params/
   * rowsReturned/ms) — the audit evidence of what actually ran where.
   * @param tenantId tenant identifier.
   * @param ref the leg to fetch: `(source, resource, canonical)` (pushdown already computed).
   * @param plan the query plan (supplies `resolveMap`/`session`; legs not
   *   already resolved are resolved on demand via (@link QueryPlanner.resolveLeg)).
   * @param tenantSchema physical tenant schema used for local/synced legs.
   * @param warnings output array; a truncation or policy-resolution warning is pushed here (mutated).
   * @param trace output array; one (@link LegTrace) entry is pushed per call (mutated).
   * @param operation label recorded in the trace describing this leg's role
   *   (e.g. `'scan'`, `'join-driving'`, `'bind-join'`, `'partial-aggregate'`).
   * @returns the rows returned by the source, bounded by `maxRowsPerLeg()`.
   * @throws if the GRANT check denies the read on a governed connector table.
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

      // POLICY ENGINE: non-RLS engines (Mongo/ES/remote) can't enforce row-level
      // security themselves, so the fabric resolves the applicable row predicate
      // and INJECTS it into the pushdown — the filter runs at the source, and the
      // tenant never receives rows they aren't entitled to. Column masking rules
      // are collected here and applied to the returned rows below.
      const session = plan.session || { tenantId };
      // GRANTS: deny the read if the table is governed and the role lacks SELECT.
      await GrantService.enforce(tenantId, schema, table, session.role, 'SELECT');
      let policyMasks: MaskRule[] = [];
      try {
        const pol = await PolicyService.resolve(tenantId, schema, table, session);
        if (Object.keys(pol.filter).length) {
          bounded.filter = PolicyService.mergeIntoFilter(bounded.filter, pol.filter);
          plan.pushed?.push(`policy on ${schema}.${table}: injected ${Object.keys(pol.filter).length} predicate(s) [${pol.applied.join(', ')}]`);
        }
        policyMasks = pol.masks;
      } catch (e: any) {
        warnings.push(`policy resolution failed for ${schema}.${table}: ${e.message}`);
      }

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
      if (policyMasks.length) {
        rows = PolicyService.applyMasks(rows, policyMasks, session);
        plan.pushed?.push(`policy masking on ${schema}.${table}: ${policyMasks.map((m) => `${m.column}:${m.strategy}`).join(', ')}`);
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

  /**
   * Faithful string preview of the request a connector pushes to its remote engine.
   * Used purely for the trace/audit text (never executed) so the returned
   * `LegTrace.query` shows the real Mongo `find`/`aggregate` call, the
   * Elasticsearch request body, or the SQL text — whichever the connector
   * would actually issue for this canonical query. Falls back to a compact
   * `schema.table [filter]` string if compiling the preview throws.
   * @param engine uppercase engine name (`MONGODB`, `ELASTICSEARCH`/`ELASTIC`/`ES`, or a SQL dialect name).
   * @param input the canonical query plus its physical `schema`/`table`.
   * @returns `(text, params?)`, matching (@link CompiledSql)'s shape for SQL engines.
   */
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
      const dialect = eng === 'MYSQL' ? 'mysql' : eng === 'SNOWFLAKE' ? 'snowflake' : eng === 'ORACLE' ? 'oracle' : 'postgres';
      const compiled = PushdownCompiler.toSql({ ...input, dialect });
      return { text: compiled.text, params: compiled.params };
    } catch {
      return { text: `${input.schema}.${input.table} [${JSON.stringify(input.filter || {})}]` };
    }
  }

  // ---------- set operations ----------

  /**
   * Canonical row identity used to dedupe/compare rows for UNION/INTERSECT/EXCEPT.
   * Keys are sorted before serializing so two rows with the same key/value
   * pairs in different orders compare equal.
   * @param row the row to serialize.
   * @returns a stable string uniquely identifying the row's contents.
   */
  private static serialize(row: any): string {
    const keys = Object.keys(row).sort();
    return JSON.stringify(keys.map((k) => [k, row[k]]));
  }

  /**
   * Apply an AST's top-level ORDER BY + LIMIT to an in-memory row array. Used
   * as the final step after any in-fabric combine (join, set-op, fan-aggregate)
   * since no single source's pushdown already reflects the combined ordering.
   * @param rows rows to sort/trim.
   * @param ast the AST node carrying `orderBy`/`limit` (top-level or a set-op wrapper).
   * @returns a new, sorted array trimmed to `limit` (or the original order if no orderBy is given).
   */
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

  /**
   * Execute a UNION / INTERSECT / EXCEPT across its legs (each leg its own
   * source, fetched independently with its own pushdown via
   * (@link fetchLegDirect)), then combine in-memory using (@link serialize) for
   * row identity: UNION dedupes across all legs; INTERSECT keeps rows from the
   * first leg present in every other leg; EXCEPT keeps rows from the first leg
   * absent from every other leg. Nested joins inside a set-op leg are rejected
   * (not supported by this executor).
   * @param tenantId tenant identifier.
   * @param ast the AST node with `union`/`intersect`/`except` (exactly one populated) plus `orderBy`/`limit`.
   * @param plan the query plan (leg resolution cache + session).
   * @param tenantSchema physical tenant schema for local/synced legs.
   * @param warnings output array (mutated) for truncation/policy warnings from each leg fetch.
   * @param pushed output array (mutated) with human-readable pushdown notes per leg.
   * @param trace output array (mutated) with one (@link LegTrace) entry per leg.
   * @returns the combined, ordered/limited result rows.
   * @throws if a set-op leg itself declares JOINs.
   */
  private static async executeSetOp(
    tenantId: string, ast: any, plan: QueryPlan, tenantSchema: string, warnings: string[], pushed: string[], trace: LegTrace[]
  ): Promise<any[]> {
    const op = ast.union ? 'UNION' : ast.intersect ? 'INTERSECT' : 'EXCEPT';
    const legs: any[] = ast.union || ast.intersect || ast.except;

    // LIMIT PUSHDOWN for set-ops: for a UNION with an outer LIMIT n, each leg needs
    // at most n rows — the union of the per-leg top-n always contains the global
    // top-n (with ORDER BY we push the sort too, for a correct top-n per leg;
    // without it any n rows per leg suffice). This turns a "fetch up to the cap
    // then trim in memory" plan into a bounded per-source pushdown. INTERSECT/EXCEPT
    // are NOT bounded this way — they need the full leg sets to be correct.
    const outerLimit = typeof ast.limit === 'number' && ast.limit > 0 ? ast.limit : undefined;
    const pushLegLimit = op === 'UNION' ? outerLimit : undefined;

    const legResults: any[][] = [];
    for (const leg of legs) {
      if (Array.isArray(leg.joins) && leg.joins.length) throw new Error('FederationExecutor: nested JOIN inside a set-op leg is not supported');
      const canonical = this.astLegToCanonical(leg);
      if (pushLegLimit != null) {
        canonical.limit = Math.min(canonical.limit ?? Infinity, pushLegLimit);
        if (Array.isArray(ast.orderBy) && ast.orderBy.length && !canonical.orderBy) canonical.orderBy = ast.orderBy;
      }
      pushed.push(`${op} leg ${leg.from?.source || LOCAL_SOURCE}.${leg.from?.resource}: pushed ${Object.keys(canonical.filter || {}).length} predicate(s)${pushLegLimit != null ? `, LIMIT ${canonical.limit} pushed to source` : ''}`);
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
   *
   * Steps: (1) attribute each qualified, simple WHERE conjunct to its leg by
   * alias; (2) union-find over columns connected by an equijoin ON clause, so
   * `c1.id` and `c2.id` land in the same equivalence class when joined by
   * `c1.id = c2.id`; (3) seed each class's constant from any `$eq` filter found
   * in step 1; (4) propagate that constant to every column in the class that
   * doesn't already have its own filter — so e.g. `WHERE c1.id = 5` also
   * produces `c2.id = 5` for the joined leg, letting BOTH sides be filtered
   * before any rows are fetched.
   * @param legMetas the join's legs (driving leg first, then each joined leg with its `on` clause).
   * @param where the query's top-level WHERE conjuncts.
   * @returns a map from leg alias to its pushdown filter (`(column: ( $op: value, ... ))`).
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

  /**
   * Qualify every column of a leg's rows with its alias so joins never collide.
   * @param rows the leg's raw fetched rows.
   * @param alias the leg's alias (its `from`/join alias, or resource name if unaliased).
   * @returns new row objects with every key rewritten to `alias.key`.
   */
  private static qualify(rows: any[], alias: string): any[] {
    return rows.map((r) => {
      const out: any = {};
      for (const k of Object.keys(r)) out[`${alias}.${k}`] = r[k];
      return out;
    });
  }

  /**
   * Execute a cross-source JOIN via bind join (semi-join), the core of the
   * federation strategy: fetch the driving (first) leg with its own predicate
   * (plus any transitively-propagated constants from (@link buildLegFilters)),
   * then for each subsequent leg, collect the driving side's join-key values
   * and push them down as `key IN (...)` so the other source returns only rows
   * that CAN match — never a full scan.
   *
   * Per joined leg: an equijoin (`=`) with INNER/LEFT (or RIGHT/FULL, though
   * those degrade — see below) is eligible for bind join; if the number of
   * distinct driving-side keys exceeds `bindMaxKeys()`, it falls back to a
   * bounded full fetch with a warning; if there are zero keys, the fetch is
   * skipped entirely (nothing could match). A non-equi join can't be bound, so
   * it always does a bounded fetch and is evaluated with an in-memory
   * nested-loop against `evalOn`. RIGHT/FULL joins are not reproducible by this
   * left-driven hash join and are executed as INNER with a warning (right-only
   * rows are dropped). Each leg's rows are qualified by alias
   * ((@link qualify)) before the in-memory hash join merges them into the
   * running accumulator, so same-named columns across legs never collide.
   *
   * Returns rows AFTER the top-level WHERE is re-applied in-memory
   * ((@link applyWhere)) — this catches predicates that reference columns from
   * legs joined after the one they were pushed to, or expressions that
   * couldn't be pushed down at all. Projection/aggregation/order+limit are
   * intentionally NOT applied here; they're applied centrally by
   * (@link execute) so an outer aggregate sees the full raw joined rows.
   * @param tenantId tenant identifier.
   * @param ast the AST node with `from`, `joins[]`, `where`, `select`.
   * @param plan the query plan (leg resolution cache + session).
   * @param tenantSchema physical tenant schema for local/synced legs.
   * @param warnings output array (mutated) for bind-join fallback / unsupported-join-type warnings.
   * @param pushed output array (mutated) with human-readable pushdown notes (predicates, bind-join key counts).
   * @param trace output array (mutated) with one (@link LegTrace) entry per leg fetch.
   * @returns the joined rows (qualified by alias), filtered by the WHERE clause.
   */
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

    // COST-BASED DRIVING-SIDE SELECTION (Trino/Denodo/Spark all pick the smaller,
    // more-selective side as the build/broadcast side; we were always driving from
    // the FROM leg). For a single INNER equijoin, probe each side's POST-FILTER
    // cardinality with a pushed COUNT(*) and drive from the smaller side — fewer
    // bind keys shipped and a smaller in-fabric build. Only INNER is reordered
    // (swapping a LEFT/RIGHT/FULL side would change results). Probe failures fall
    // back to FROM-side driving. (A persisted stats cache would remove the probe
    // round-trip — that's the CBO roadmap item.)
    const cards: Record<string, number | null> = {};
    const twoLegInnerEqui = legMetas.length === 2 && legMetas[1]!.joinType === 'INNER'
      && ['EQ', '='].includes(String(legMetas[1]!.on?.operator || 'EQ').toUpperCase());
    if (costProbeEnabled() && twoLegInnerEqui) {
      const L = legMetas[0]!, R = legMetas[1]!;
      const [cl, cr] = await Promise.all([
        this.estimateLegRows(tenantId, L, legFilters[L.alias], plan, tenantSchema),
        this.estimateLegRows(tenantId, R, legFilters[R.alias], plan, tenantSchema),
      ]);
      cards[L.alias] = cl; cards[R.alias] = cr;
      if (cl != null && cr != null) {
        pushed.push(`cost probe: ${L.alias}~${cl} rows, ${R.alias}~${cr} rows`);
        if (cr < cl) {
          const on = R.on!;
          legMetas[0] = { ...R, joinType: null, on: null };
          legMetas[1] = { ...L, joinType: 'INNER', on: { left: on.right, operator: on.operator, right: on.left } };
          pushed.push(`cost-based driving side: "${R.alias}" (~${cr}) drives; "${L.alias}" (~${cl}) is the bind/probe side`);
        } else {
          pushed.push(`cost-based driving side: "${L.alias}" (~${cl}) drives (FROM side already the smaller)`);
        }
      }
    }

    // PROJECTION PUSHDOWN: fetch only the columns each leg actually contributes
    // (final projection + its join keys + referenced predicates/order/group), so
    // a wide table isn't dragged across the network as SELECT *. Falls back to
    // SELECT * for any leg whose columns can't be unambiguously attributed —
    // correctness before cleverness.
    const proj = this.joinLegProjections(ast, legMetas);
    const selectFor = (alias: string): string[] | undefined => {
      if (!proj) return undefined;                 // ambiguous somewhere → * everywhere
      const s = proj[alias];
      return s && s.length ? s : undefined;        // null / empty → * for this leg
    };
    if (proj) {
      const shown = legMetas.map((l) => `${l.alias}:{${(proj[l.alias] || ['*']).join(',')}}`).join(' ');
      pushed.push(`projection pushdown → ${shown}`);
    }

    // BROADCAST HASH JOIN (both sides small): fetch both legs in PARALLEL and
    // hash-join in-fabric — ONE round-trip of latency instead of the two sequential
    // ones a bind-join needs (driving fetch → then probe fetch). Only for a 2-leg
    // INNER equijoin where both post-filter counts are known and ≤ the broadcast
    // ceiling, so neither side is ever dragged in full unless it's already small.
    // Everything else uses the driving + bind-join loop below.
    if (twoLegInnerEqui) {
      const bMax = broadcastMaxRows();
      const a0 = legMetas[0]!, a1 = legMetas[1]!;
      const c0 = cards[a0.alias], c1 = cards[a1.alias];
      if (c0 != null && c1 != null && c0 <= bMax && c1 <= bMax) {
        pushed.push(`broadcast hash join: both sides small (${a0.alias}~${c0}, ${a1.alias}~${c1}) → fetched in parallel, joined in-fabric`);
        const [r0, r1] = await Promise.all([
          this.fetchLegDirect(tenantId, { source: a0.source, resource: a0.resource, canonical: { filter: legFilters[a0.alias] || {}, select: selectFor(a0.alias) } }, plan, tenantSchema, warnings, trace, 'broadcast-build'),
          this.fetchLegDirect(tenantId, { source: a1.source, resource: a1.resource, canonical: { filter: legFilters[a1.alias] || {}, select: selectFor(a1.alias) } }, plan, tenantSchema, warnings, trace, 'broadcast-build'),
        ]);
        const joined = this.mergeJoin(this.qualify(r0, a0.alias), this.qualify(r1, a1.alias), a1.on, false, true);
        return this.applyWhere(joined, ast.where);
      }
    }

    // Driving leg: fetch with its (possibly propagated) predicate, then qualify columns.
    const driving = legMetas[0]!;
    const drivingFilter = legFilters[driving.alias];
    if (drivingFilter && Object.keys(drivingFilter).length) pushed.push(`pushed ${Object.keys(drivingFilter).length} predicate(s) to ${driving.source}.${driving.resource}`);
    let acc = this.qualify(
      await this.fetchLegDirect(tenantId, { source: driving.source, resource: driving.resource, canonical: { filter: drivingFilter, select: selectFor(driving.alias) } }, plan, tenantSchema, warnings, trace, 'join-driving'),
      driving.alias
    );

    // Each subsequent leg: push its own predicate + a bind-join IN(...) on the join key.
    for (const lm of legMetas.slice(1)) {
      const on = lm.on!;
      const rightBaseCol = baseColumn(on.right);
      const isEquiJoin = ['EQ', '='].includes(String(on.operator || 'EQ').toUpperCase());
      const legFilter: Record<string, any> = { ...(legFilters[lm.alias] || {}) };

      // Cross-engine RIGHT/FULL cannot be reproduced by this left-driven hash join.
      if (lm.joinType === 'RIGHT' || lm.joinType === 'FULL') {
        warnings.push(`Cross-engine ${lm.joinType} JOIN on "${lm.source}.${lm.resource}" is not supported; executed as INNER (right-only rows are dropped).`);
      }

      // Bind join: only valid for an equijoin that keeps left rows driven (INNER/LEFT).
      const canBind = isEquiJoin && (lm.joinType === 'INNER' || lm.joinType === 'LEFT' || lm.joinType === 'RIGHT' || lm.joinType === 'FULL');
      let skipFetch = false;
      let bindBatches: any[][] | null = null;   // null → single fetch with legFilter only
      if (canBind) {
        const leftVals = Array.from(new Set(acc.map((r) => readColumn(r, on.left)).filter((v) => v !== undefined && v !== null)));
        if (leftVals.length === 0) {
          // No left key can match — don't touch the other source at all.
          skipFetch = true;
          pushed.push(`bind-join: driving side has no keys, skipped fetch of ${lm.source}.${lm.resource}`);
        } else if (leftVals.length <= bindMax) {
          bindBatches = [leftVals];
          pushed.push(`bind-join: pushed ${leftVals.length} key(s) as ${rightBaseCol} IN (...) to ${lm.source}.${lm.resource}`);
        } else {
          // Large key set: CHUNK the IN-list into bindMax-sized batches (a bounded
          // fan-out) instead of abandoning the filter and scanning the whole probe
          // table. Only give up (single bounded scan) if it would take too many batches.
          const batches = chunk(leftVals, bindMax);
          if (batches.length <= maxBindBatches()) {
            bindBatches = batches;
            pushed.push(`batched bind-join: ${leftVals.length} keys → ${batches.length} chunk(s) of ≤${bindMax} to ${lm.source}.${lm.resource}`);
          } else {
            warnings.push(`Bind-join to "${lm.source}.${lm.resource}" skipped: ${leftVals.length} keys need ${batches.length} batches (> ${maxBindBatches()}); leg fetched with a bounded scan.`);
          }
        }
      } else if (!isEquiJoin) {
        pushed.push(`non-equi join to ${lm.source}.${lm.resource}: bind-join not applicable, bounded fetch`);
      }

      let right: any[];
      if (skipFetch) {
        right = [];
      } else if (bindBatches) {
        // One fetch per key-batch (parallel), each pushing its own IN(...) filter.
        const label = bindBatches.length > 1 ? 'bind-join-batch' : 'bind-join';
        const parts = await Promise.all(bindBatches.map((keys) =>
          this.fetchLegDirect(
            tenantId,
            { source: lm.source, resource: lm.resource, canonical: { filter: { ...legFilter, [rightBaseCol]: { $in: keys } }, select: selectFor(lm.alias) } },
            plan, tenantSchema, warnings, trace, label
          )
        ));
        right = this.qualify(parts.flat(), lm.alias);
      } else {
        // No bind (non-equi, or key set too large): single bounded fetch with the leg's own predicate.
        right = this.qualify(
          await this.fetchLegDirect(tenantId, { source: lm.source, resource: lm.resource, canonical: { filter: legFilter, select: selectFor(lm.alias) } }, plan, tenantSchema, warnings, trace, 'join-probe'),
          lm.alias
        );
      }

      acc = this.mergeJoin(acc, right, on, lm.joinType === 'LEFT', isEquiJoin);
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

  /**
   * Evaluate a non-equi join ON predicate for the in-memory nested-loop path in (@link executeJoin).
   * @param left the driving row's join-key value.
   * @param operator the ON clause operator (`NE`/`!=`/`<>`/`GT`/`>`/`GTE`/`>=`/`LT`/`<`/`LTE`/`<=`; default `EQ`).
   * @param right the other leg's row join-key value.
   * @returns whether the predicate holds.
   */
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

  /**
   * Apply the top-level WHERE conjuncts in-memory over already-joined rows.
   * This is a correctness backstop for (@link executeJoin): predicates that
   * couldn't be (or weren't) pushed to a leg — e.g. they reference a column
   * from a leg joined after the one they targeted — are still enforced here.
   * @param rows joined/qualified rows to filter.
   * @param where WHERE conjuncts (ANDed); a no-op if empty/not an array.
   * @returns the rows satisfying every predicate.
   */
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

  /**
   * Project qualified rows to the requested SELECT columns (pass through on `*`).
   * Applied by (@link execute) after a non-aggregated join so the caller only
   * sees the requested columns, not every alias-qualified column from every leg.
   * @param rows joined (alias-qualified) rows.
   * @param select the query's select list; `*` or empty means pass rows through unchanged.
   * @returns projected rows keyed by the requested column names.
   */
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

  /**
   * Top-level entry point: execute a CROSS_ENGINE / SINGLE_CONNECTOR AST and
   * return its data plus a full pushdown/trace record. Dispatches on AST shape:
   *
   *   - **set operation** (`union`/`intersect`/`except`): if it's a UNION where
   *     every leg is a full aggregate query, uses (@link fanAggregate) (push a
   *     PARTIAL aggregate to each source, merge in-fabric — the
   *     resource-efficient "fan aggregate" path); otherwise
   *     (@link executeSetOp) (fetch each leg, combine as UNION/INTERSECT/EXCEPT).
   *   - **join** (`joins` present): (@link executeJoin) (bind-join across legs),
   *     then if the query also has an outer GROUP BY/aggregate, aggregates the
   *     raw joined rows via `aggregateRaw` (join+aggregate can't use the
   *     partial/merge path since the aggregate is over the JOINED result, not
   *     any single source); otherwise just projects + orders/limits.
   *   - **single leg**: pushes the full aggregate (if any) directly to the one
   *     source via (@link fetchLegDirect), else pushes filter/projection/sort/limit.
   *
   * @param tenantId tenant identifier.
   * @param ast the classified query AST (from/joins/union/intersect/except, where, select, groupBy, having, orderBy, limit).
   * @param plan the (@link QueryPlan) from (@link QueryPlanner.classify) (leg resolution cache); `session` is attached onto it here if not already present.
   * @param tenantSchema physical tenant schema for local/synced legs.
   * @param session caller session for the Policy Engine (row predicates + column masking); defaults to `(tenantId)` if omitted and not already on `plan`.
   * @returns `(data, warnings, pushed, trace)` — the result rows plus the full audit trail of what ran where.
   */
  static async execute(tenantId: string, ast: any, plan: QueryPlan, tenantSchema: string, session?: QueryPlan['session']): Promise<FederationResult> {
    // Carry the session onto the plan so fetchLegDirect can resolve access policies.
    if (session) plan.session = session;
    else if (!plan.session) plan.session = { tenantId };
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
