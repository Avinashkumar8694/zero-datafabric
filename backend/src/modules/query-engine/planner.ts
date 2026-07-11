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
}

const legKey = (source: string, resource: string) => `${source}::${resource}`;

export class QueryPlanner {
  /** Collect { source, resource } references from an AST (recurses set-ops / CTEs). */
  private static collectRefs(ast: any, acc: { source: string; resource: string }[]) {
    if (!ast || typeof ast !== 'object') return;

    if (ast.from && ast.from.resource) {
      acc.push({ source: ast.from.source || LOCAL_SOURCE, resource: ast.from.resource });
    }
    if (Array.isArray(ast.joins)) {
      for (const j of ast.joins) {
        if (j && j.resource) acc.push({ source: j.source || LOCAL_SOURCE, resource: j.resource });
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
   * Resolve a single logical reference to its physical engine + location.
   * Local hub references are always reachable in Postgres.
   */
  static async resolveLeg(tenantId: string, source: string, resource: string): Promise<ResolvedLeg> {
    if (!source || source === LOCAL_SOURCE) {
      return {
        source: LOCAL_SOURCE,
        resource,
        engine: 'POSTGRES',
        syncType: 'VIRTUAL',
        reachableInPg: true,
        physicalSchema: null,
        physicalTable: resource,
        config: { local: true },
      };
    }

    // Prefer a catalog row so we know the physical schema/table for connector execution.
    const { rows } = await pool.query(
      `SELECT ds.type AS engine, ds.sync_type AS sync_type, ds.config AS config,
              cs.physical_name AS physical_schema, ct.physical_name AS physical_table
       FROM public.data_sources ds
       JOIN public.catalog_schemas cs ON cs.source_id = ds.id
       JOIN public.catalog_tables ct ON ct.schema_id = cs.id
       WHERE ds.tenant_id = $1 AND ds.name = $2 AND ct.name = $3
       LIMIT 1`,
      [tenantId, source, resource]
    );

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
        [tenantId, source]
      );
      if (alt.rows.length === 0) {
        throw new Error(`QueryPlanner: referenced source "${source}" not found for tenant "${tenantId}"`);
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

    return { source, resource, engine, syncType, reachableInPg, physicalSchema, physicalTable, config };
  }

  static async classify(tenantId: string, ast: any): Promise<QueryPlan> {
    const refs: { source: string; resource: string }[] = [];
    this.collectRefs(ast, refs);

    // Deduplicate references and resolve each once.
    const resolveMap: Record<string, ResolvedLeg> = {};
    for (const ref of refs) {
      const key = legKey(ref.source, ref.resource);
      if (!resolveMap[key]) resolveMap[key] = await this.resolveLeg(tenantId, ref.source, ref.resource);
    }
    const legs = Object.values(resolveMap);

    const connectorLegs = legs.filter((l) => !l.reachableInPg);
    const namedSources = new Set(legs.filter((l) => l.source !== LOCAL_SOURCE).map((l) => l.source));
    const hasSetOps = Array.isArray(ast.union) || Array.isArray(ast.intersect) || Array.isArray(ast.except);
    const hasJoins = Array.isArray(ast.joins) && ast.joins.length > 0;

    const pushed: string[] = [];
    const warnings: string[] = [];

    let strategy: Strategy;
    if (connectorLegs.length === 0 && namedSources.size <= 1) {
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
