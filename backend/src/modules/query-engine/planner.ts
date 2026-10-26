/**
 * QueryPlanner
 * ------------
 * Decides HOW a query should be executed across one or many data sources,
 * instead of the old behaviour of blindly stripping every `source` label and
 * assuming all resources live in the tenant's Postgres schema.
 *
 * For each resource referenced by the query (from / joins / set-op legs) it
 * resolves the physical engine via the catalog and decides whether that
 * resource is reachable *inside* the tenant Postgres schema (a local table, a
 * postgres_fdw foreign table, or a locally-synced shadow) or only reachable
 * through a live connector (a VIRTUAL Mongo/MySQL source).
 *
 * Strategies:
 *   SINGLE_LOCAL      - every leg is reachable in Postgres -> one SQL statement
 *                       (Postgres / Citus / FDW planner does the optimization).
 *   SINGLE_CONNECTOR  - one simple SELECT against a single connector-only source
 *                       -> pushdown via that connector.
 *   CROSS_ENGINE      - legs span multiple engines (or a join / set-op crosses
 *                       the Postgres <-> connector boundary) -> FederationExecutor.
 */

import { pool } from '../../config/database';
import { NotFoundError } from '../../utils/tenantScope';
import { subscribeClusterEvent, publishClusterEvent } from '../../config/cache';

export type Strategy = 'SINGLE_LOCAL' | 'SINGLE_CONNECTOR' | 'CROSS_ENGINE';

export const LOCAL_SOURCE = 'Fabric_Hub_Postgres';

export interface ResolvedLeg {
  /** logical source name; LOCAL_SOURCE for the tenant hub */
  source: string;
  /** logical resource / table / collection name */
  resource: string;
  /** data_sources.type (POSTGRES / MYSQL / MONGODB / ...) */
  engine: string;
  /** VIRTUAL / SYNC / CDC */
  syncType: string;
  /** true when the resource can be queried inside the tenant Postgres schema */
  reachableInPg: boolean;
  /** physical location for connector execution (null for local hub) */
  physicalSchema: string | null;
  physicalTable: string | null;
  /** connector config for connector-only legs */
  config: any;
}

export interface QueryPlan {
  strategy: Strategy;
  legs: ResolvedLeg[];
  /** key `source::resource` -> resolved leg (used by the federation executor) */
  resolveMap: Record<string, ResolvedLeg>;
  /** human-readable notes about what was/ will be pushed down */
  pushed: string[];
  warnings: string[];
  /** true when every leg resolves to ONE physical SQL database → push the whole
   *  statement (joins/group-by/set-ops incl.) down as a single native query. */
  colocated?: boolean;
  /** the single source name to push the co-located SQL to (set when `colocated`). */
  coLocatedSource?: string;
  /** SQL dialect for the co-located source ('postgres' | 'mysql' | 'oracle' | 'snowflake'). */
  dialect?: string;
  /** per-request session context (tenant/role/region) — used by the Policy Engine
   *  to inject row predicates + column masking on non-RLS connector legs. */
  session?: { tenantId: string; role?: string; region?: string; username?: string };
}

/** Build the `resolveMap` cache key for a `{ source, resource }` reference. */
const legKey = (source: string, resource: string) => `${source}::${resource}`;

/** Fold engine aliases to one canonical token so `POSTGRESQL`/`POSTGRES` and
 *  `ORACLEDB`/`ORACLE` compare equal when fingerprinting co-located legs. */
const normEngine = (engine: string): string => {
  const e = String(engine || '').toUpperCase();
  if (e === 'POSTGRESQL' || e === 'PG') return 'POSTGRES';
  if (e === 'ORACLEDB') return 'ORACLE';
  if (e === 'MARIADB') return 'MYSQL';
  return e;
};

/** Relational SQL engines whose planner+optimizer can execute a full
 *  JOIN/GROUP BY/set-op natively → candidates for co-located pushdown. */
const SQL_RELATIONAL = new Set(['POSTGRES', 'MYSQL', 'ORACLE', 'SNOWFLAKE']);

/** SQL dialect key consumed by `PushdownCompiler` for a given engine. */
const dialectOf = (engine: string): string => {
  switch (normEngine(engine)) {
    case 'MYSQL': return 'mysql';
    case 'ORACLE': return 'oracle';
    case 'SNOWFLAKE': return 'snowflake';
    default: return 'postgres';
  }
};

/**
 * Stable identity of the *physical database* a connector leg points at, so two
 * legs that resolve to the same server+database (regardless of which logical
 * table/alias) collapse to one fingerprint. Prefers an explicit connection
 * string/URI; otherwise `engine|host:port/database`. This is the co-location
 * signal: if every leg shares one fingerprint on a SQL engine, the whole
 * JOIN/GROUP BY/set-op can be pushed down as a single native statement instead
 * of fanning out into per-leg bind-joins.
 */
const connFingerprint = (leg: ResolvedLeg): string => {
  const c = leg.config || {};
  const cs = c.connectionString || c.connectionUri || c.uri || c.url || c.dsn;
  if (cs) return `${normEngine(leg.engine)}|${String(cs).trim().toLowerCase()}`;
  const host = String(c.host || c.server || c.account || '').toLowerCase();
  const port = c.port != null ? String(c.port) : '';
  const db = String(c.database || c.db || c.serviceName || c.sid || c.schema || '').toLowerCase();
  return `${normEngine(leg.engine)}|${host}:${port}/${db}`;
};

/**
 * Decides HOW a query should be executed (see file-level overview for the
 * SINGLE_LOCAL / SINGLE_CONNECTOR / CROSS_ENGINE strategies). All methods are
 * static; the class is never instantiated. `classify` is the entry point
 * consumed by `QueryEngineService.executeQuery`.
 */
interface CachedLeg {
  leg: ResolvedLeg;
  expiresAt: number;
}
const legCache = new Map<string, CachedLeg>();
const LEG_CACHE_TTL_MS = 60000; // 60s TTL

// Subscribe to cluster-wide leg cache invalidation across all pods/workers
subscribeClusterEvent('fabric:cache:invalidate', () => {
  legCache.clear();
});

export class QueryPlanner {
  /** Invalidate the leg resolution cache across the entire cluster. */
  static clearLegCache(broadcast = true): void {
    legCache.clear();
    if (broadcast) {
      publishClusterEvent('fabric:cache:invalidate', { timestamp: Date.now() }).catch(() => {});
    }
  }
  /**
   * Collect ( source, resource ) references from an AST (recurses set-ops / CTEs).
   * Walks `from`, `joins[]`, and recurses into `union`/`intersect`/`except`
   * legs and `with` (CTE) bases/`unionAll` bodies so every resource the query
   * touches — however deeply nested — is captured for resolution.
   * @param ast the query AST node to scan.
   * @param acc output array that discovered `(source, resource)` references are pushed onto (mutated); may contain duplicates.
   */
  private static collectRefs(ast: any, acc: { source: string; resource: string }[]) {
    if (!ast || typeof ast !== 'object') return;

    if (ast.from) {
      // A FROM entry is either a table reference or a derived-table subquery
      // (`from.query`) — recurse into the subquery to find its real table refs.
      if (ast.from.query) this.collectRefs(ast.from.query, acc);
      else if (ast.from.resource) acc.push({ source: ast.from.source || LOCAL_SOURCE, resource: ast.from.resource });
    }
    if (Array.isArray(ast.joins)) {
      for (const j of ast.joins) {
        if (j && j.query) this.collectRefs(j.query, acc);
        else if (j && j.resource) acc.push({ source: j.source || LOCAL_SOURCE, resource: j.resource });
      }
    }
    for (const key of ['union', 'intersect', 'except'] as const) {
      if (Array.isArray(ast[key])) for (const leg of ast[key]) this.collectRefs(leg, acc);
    }
    if (Array.isArray(ast.with)) {
      for (const cte of ast.with) {
        this.collectRefs(cte.base, acc);
        if (cte.unionAll) this.collectRefs(cte.unionAll, acc);
      }
    }
  }

  /**
   * Resolve a single logical reference to its physical engine + location (with TTL caching).
   */
  static async resolveLeg(tenantId: string, source: string, resource: string): Promise<ResolvedLeg> {
    const overrideSource = process.env.FABRIC_TARGET_SOURCE_OVERRIDE;
    const cacheKey = `${tenantId}::${source || ''}::${resource}::${overrideSource || ''}`;
    const cached = legCache.get(cacheKey);
    const now = Date.now();
    if (cached && cached.expiresAt > now) {
      return cached.leg;
    }

    const leg = await this.resolveLegUncached(tenantId, source, resource);
    legCache.set(cacheKey, { leg, expiresAt: now + LEG_CACHE_TTL_MS });
    return leg;
  }

  private static async resolveLegUncached(tenantId: string, source: string, resource: string): Promise<ResolvedLeg> {
    const overrideSource = process.env.FABRIC_TARGET_SOURCE_OVERRIDE;
    const effectiveSource = (!source || source === LOCAL_SOURCE) ? (overrideSource || source) : source;

    if (!effectiveSource || effectiveSource === LOCAL_SOURCE) {
      const cat = await pool.query(
        `SELECT ds.name as source_name, ds.type as engine, ds.sync_type as sync_type, ds.config as config,
                cs.physical_name as physical_schema, ct.physical_name as physical_table, ct.resource_type
         FROM public.catalog_tables ct
         JOIN public.catalog_schemas cs ON ct.schema_id = cs.id
         JOIN public.data_sources ds ON cs.source_id = ds.id
         WHERE ds.tenant_id = $1 AND ct.name = $2
         ORDER BY (ds.type != 'POSTGRES') DESC LIMIT 1`,
        [tenantId, resource]
      );
      if (cat.rows.length === 0 || cat.rows[0].engine === 'POSTGRES' || cat.rows[0].resource_type === 'MATERIALIZED_VIEW') {
        return {
          source: LOCAL_SOURCE,
          resource,
          engine: 'POSTGRES',
          syncType: 'VIRTUAL',
          reachableInPg: true,
          physicalSchema: cat.rows[0]?.physical_schema || null,
          physicalTable: cat.rows[0]?.physical_table || resource,
          config: { local: true },
        };
      }
      const row = cat.rows[0];
      return {
        source: row.source_name,
        resource,
        engine: String(row.engine).toUpperCase(),
        syncType: String(row.sync_type || 'VIRTUAL').toUpperCase(),
        reachableInPg: row.sync_type === 'SYNC' || row.sync_type === 'CDC',
        physicalSchema: row.physical_schema,
        physicalTable: row.physical_table || resource,
        config: row.config || {},
      };
    }

    // Prefer a catalog row so we know the physical schema/table for connector execution.
    const { rows } = await pool.query(
      `SELECT ds.type AS engine, ds.sync_type AS sync_type, ds.config AS config,
              cs.physical_name AS physical_schema, ct.physical_name AS physical_table, ct.resource_type
       FROM public.data_sources ds
       JOIN public.catalog_schemas cs ON cs.source_id = ds.id
       JOIN public.catalog_tables ct ON ct.schema_id = cs.id
       WHERE ds.tenant_id = $1 AND ds.name = $2 AND ct.name = $3
       LIMIT 1`,
      [tenantId, effectiveSource, resource]
    );

    if (rows.length > 0 && rows[0].resource_type === 'MATERIALIZED_VIEW') {
      return {
        source: LOCAL_SOURCE,
        resource,
        engine: 'POSTGRES',
        syncType: 'VIRTUAL',
        reachableInPg: true,
        physicalSchema: rows[0].physical_schema || null,
        physicalTable: rows[0].physical_table || resource,
        config: { local: true },
      };
    }

    let engine = 'POSTGRES';
    let syncType = 'VIRTUAL';
    let config: any = {};
    let physicalSchema: string | null = null;
    let physicalTable: string | null = resource;

    if (rows.length > 0) {
      engine = String(rows[0].engine || 'POSTGRES').toUpperCase();
      syncType = String(rows[0].sync_type || 'VIRTUAL').toUpperCase();
      config = rows[0].config || {};
      physicalSchema = rows[0].physical_schema || null;
      physicalTable = rows[0].physical_table || resource;
    } else {
      // Fall back to the source record alone (table not crawled into the catalog yet).
      const alt = await pool.query(
        `SELECT type AS engine, sync_type AS sync_type, config FROM public.data_sources
         WHERE tenant_id = $1 AND name = $2 LIMIT 1`,
        [tenantId, effectiveSource]
      );
      if (alt.rows.length === 0) {
        throw new NotFoundError(`Source "${String(effectiveSource).slice(0, 60)}" not found`);
      }
      engine = String(alt.rows[0].engine || 'POSTGRES').toUpperCase();
      syncType = String(alt.rows[0].sync_type || 'VIRTUAL').toUpperCase();
      config = alt.rows[0].config || {};
    }

    // Reachable inside the tenant Postgres schema ONLY for the local hub or for
    // sources physically synced/replicated into it. A VIRTUAL *remote* source (even
    // Postgres) is queried through its connector instead: postgres_fdw's
    // IMPORT FOREIGN SCHEMA does not cover materialized views / sequences / functions,
    // and the connector path works uniformly for every object type and every engine.
    const reachableInPg = syncType === 'SYNC' || syncType === 'CDC';

    return { source: effectiveSource, resource, engine, syncType, reachableInPg, physicalSchema, physicalTable, config };
  }

  /**
   * Classify a query AST into an execution (@link Strategy) and resolve every
   * leg it references. This is the planner's entry point:
   *   1. (@link collectRefs) + (@link resolveLeg) every distinct `(source,
   *      resource)` the query touches (deduplicated via `resolveMap`).
   *   2. Partition legs into those reachable in Postgres vs. connector-only,
   *      and count distinct NAMED sources (excluding the hub).
   *   3. Decide the strategy:
   *      - `SINGLE_LOCAL` — no connector-only legs and at most one named
   *        source: everything resolves inside the tenant Postgres schema, so
   *        one SQL statement suffices (Postgres/Citus/FDW push each scan's
   *        predicate to its own remote).
   *      - `SINGLE_CONNECTOR` — exactly one connector-only leg, no joins/set-ops:
   *        a simple pushdown SELECT against that one connector.
   *      - `CROSS_ENGINE` — anything else (multiple distinct sources, even if
   *        all Postgres, or any join/set-op crossing the local/connector
   *        boundary): each source is fetched independently with pushdown, then
   *        combined in-memory by (@link FederationExecutor) — this avoids
   *        cross-source table-name collisions and full scans.
   * @param tenantId tenant identifier.
   * @param ast the query AST to classify.
   * @returns the (@link QueryPlan): `(strategy, legs, resolveMap, pushed, warnings)`.
   * @throws if any referenced source can't be resolved (see (@link resolveLeg)).
   */
  static async classify(tenantId: string, ast: any): Promise<QueryPlan> {
    const refs: { source: string; resource: string }[] = [];
    this.collectRefs(ast, refs);

    // Gather every declared CTE name (recursively) so references to a CTE are not
    // mistaken for physical tables when resolving legs.
    const cteNames = new Set<string>();
    const hasRecursiveCte = (() => {
      let rec = false;
      const walk = (n: any): void => {
        if (!n || typeof n !== 'object') return;
        if (Array.isArray(n.with)) for (const c of n.with) { if (c?.name) cteNames.add(c.name); if (c?.unionAll) rec = true; walk(c.base); walk(c.unionAll); }
        for (const k of ['union', 'intersect', 'except'] as const) if (Array.isArray(n[k])) n[k].forEach(walk);
      };
      walk(ast);
      return rec;
    })();

    // Deduplicate references and resolve each once — skipping references to CTE
    // names (they are logical, not catalog tables).
    const resolveMap: Record<string, ResolvedLeg> = {};
    for (const ref of refs) {
      if (cteNames.has(ref.resource) && (!ref.source || ref.source === LOCAL_SOURCE)) continue;
      const key = legKey(ref.source, ref.resource);
      if (!resolveMap[key]) resolveMap[key] = await this.resolveLeg(tenantId, ref.source, ref.resource);
    }
    const legs = Object.values(resolveMap);

    const connectorLegs = legs.filter((l) => !l.reachableInPg);
    const namedSources = new Set(legs.filter((l) => l.source !== LOCAL_SOURCE).map((l) => l.source));
    const hasSetOps = Array.isArray(ast.union) || Array.isArray(ast.intersect) || Array.isArray(ast.except);
    const hasJoins = Array.isArray(ast.joins) && ast.joins.length > 0;
    // A non-recursive WITH whose base tables all live in one connector can be
    // pushed whole; recursive CTEs stay on the in-fabric recursive executor.
    const hasWith = Array.isArray(ast.with) && ast.with.length > 0 && !hasRecursiveCte;
    // A derived-table subquery in FROM/JOIN (`{ query: {...} }`) is a nested query
    // pushed whole when co-located.
    const hasDerivedFrom = !!(ast.from && ast.from.query)
      || (Array.isArray(ast.joins) && ast.joins.some((j: any) => j && j.query));

    const pushed: string[] = [];
    const warnings: string[] = [];

    // Co-location detection. If EVERY leg is connector-only and they all resolve
    // to the same physical SQL database (one fingerprint, one relational engine),
    // the source's own optimizer can run the entire JOIN/GROUP BY/set-op far more
    // efficiently than the fabric's per-leg bind-join fan-out. Push it down whole.
    const allConnector = legs.length > 0 && connectorLegs.length === legs.length;
    const fingerprints = new Set(connectorLegs.map(connFingerprint));
    const engineTokens = new Set(connectorLegs.map((l) => normEngine(l.engine)));
    const firstEngine = connectorLegs[0]?.engine || '';
    const coLocatable =
      allConnector &&
      fingerprints.size === 1 &&
      engineTokens.size === 1 &&
      (SQL_RELATIONAL.has(normEngine(firstEngine)) || normEngine(firstEngine) === 'MONGODB');

    console.log(`[QueryPlanner] allConnector=${allConnector} fingerprints=${Array.from(fingerprints)} engineTokens=${Array.from(engineTokens)} coLocatable=${coLocatable}`);

    // Nested forms (CTE / derived-table subquery) execute either as ONE native
    // statement pushed to a single co-located source, or — when every leg is the
    // hub / synced — as one local SQL statement. A nested query that spans
    // MULTIPLE distinct engines can't be pushed and isn't materialized in-fabric
    // yet: fail with a clear message instead of a confusing "relation not found".
    if ((hasWith || hasDerivedFrom) && connectorLegs.length > 0 && !coLocatable) {
      throw new Error(
        'QueryPlanner: a nested query (CTE / derived-table subquery) that spans multiple engines is not supported yet — ' +
        'co-locate the referenced tables in one source, or pre-materialize a side via the replication engine.'
      );
    }

    let strategy: Strategy;
    if (coLocatable && (hasJoins || hasSetOps || hasWith || hasDerivedFrom)) {
      // The whole statement (joins, set-ops, group-by, aggregates, order/limit)
      // compiles to ONE native parameterized query run by the remote engine.
      strategy = 'SINGLE_CONNECTOR';
      const src = connectorLegs[0]!;
      pushed.push(
        `co-located: all ${legs.length} leg(s) resolve to one physical ${normEngine(firstEngine)} database "${src.source}"; ` +
          `pushing the full JOIN/GROUP BY/set-op down as a single native query (source optimizer executes it)`
      );
      return {
        strategy,
        legs,
        resolveMap,
        pushed,
        warnings,
        colocated: true,
        coLocatedSource: src.source,
        dialect: dialectOf(firstEngine),
      };
    } else if (connectorLegs.length === 0 && namedSources.size <= 1) {
      // Everything is the hub or a single Postgres/synced source: one SQL statement,
      // and Postgres/Citus/FDW pushes each scan's predicate to its remote.
      strategy = 'SINGLE_LOCAL';
      pushed.push('single source resolvable in Postgres; executed as one SQL statement (predicates pushed by Postgres/FDW)');
    } else if (connectorLegs.length === 1 && legs.length === 1 && !hasSetOps && !hasJoins) {
      strategy = 'SINGLE_CONNECTOR';
      const only = connectorLegs[0]!;
      pushed.push(`pushed filter/projection/sort/limit to ${only.engine} source "${only.source}"`);
    } else {
      // Query spans multiple distinct sources (even if all Postgres): fetch each source
      // independently with predicate + bind-join pushdown, then combine in-memory. This
      // avoids cross-source table-name collisions and full scans.
      strategy = 'CROSS_ENGINE';
      const engines = Array.from(new Set(legs.map((l) => l.engine)));
      pushed.push(`federated across ${namedSources.size} sources [engines: ${engines.join(', ')}]; each leg pushed down at its source`);
    }

    return { strategy, legs, resolveMap, pushed, warnings };
  }
}
