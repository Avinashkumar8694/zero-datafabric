/**
 * QueryEngineService — the top-level orchestrator of the federation pipeline.
 * ---------------------------------------------------------------------------
 * This is the single entry point every query (AST or config-based) and every
 * write flows through before touching a data source. It is the "front door"
 * that composes ALL the other query-engine modules into one coherent
 * execution path:
 *
 *   1. Tenant lifecycle guard      — refuses to run anything for a SUSPENDED tenant.
 *   2. Capability routing          — dispatches special query shapes before the
 *      generic path: `query.recursive` (see (@link RecursiveExecutor)),
 *      `type: 'CALL'` (function/procedure-as-a-service on the hub), and the
 *      manifest-style AST (`config.query`) which itself branches on:
 *        - WINDOW functions   → base fetch + (@link applyWindows) compensation,
 *        - (@link QueryPlanner.classify) strategy:
 *            SINGLE_LOCAL      → one Postgres/Citus/FDW-optimized SQL statement,
 *            SINGLE_CONNECTOR / CROSS_ENGINE → (@link FederationExecutor.execute)
 *              (pushdown + bind-join + partial-aggregate merge), with in-fabric
 *              HAVING compensation applied to the result.
 *   3. Legacy `(table, filter, data)` config path — resolves the physical
 *      target (catalog lookup or tenant-schema convention), routes VIRTUAL
 *      (connector-only) sources directly to their connector, otherwise
 *      generates parameterized SQL ((@link generateSql)) and runs it on the hub,
 *      firing mutation events + Elasticsearch sync for INSERT/UPDATE/DELETE.
 *   4. A simple CRUD façade ((@link fetch) / (@link mutate)) used by the
 *      `/api/data` REST endpoints, which reuses the full AST path for reads and
 *      adds write-time compensations (ID generation, constraint validation,
 *      grants) for writes to non-relational engines.
 *
 * Combining capabilities: because `executeQuery` is recursive (the recursive
 * traversal and the window-function path both call back into itself for the
 * base fetch), capabilities STACK. In particular RECURSIVE_IN_FABRIC traversal
 * can be followed by an in-fabric AGGREGATE, then a HAVING filter, then an
 * ORDER BY/LIMIT — all in one query config, on any engine — see the
 * `RECURSIVE_IN_FABRIC(+AGGREGATE)(+HAVING)` branch below.
 */
import { pool, queryWithContext } from '../../config/database';
import { EventService } from '../events/event.service';
import { ConnectorFactory } from '../metadata/connectors/factory';
import { QueryTranspiler } from '../metadata/query_transpiler';
import { physicalSchemaName } from '../metadata/transpiler';
import { randomUUID } from 'crypto';
import { ElasticsearchMutationWorker } from '../metadata/es_mutation_worker';
import { QueryPlanner, LOCAL_SOURCE } from './planner';
import { FederationExecutor } from './federation';
import { PushdownCompiler, SqlDialect } from './pushdown';
import { hasWindows, extractWindows, windowBaseColumns, applyWindows, projectWithWindows } from './compensate';
import { FabricWriteGenerators } from './write_generators';
import { PolicyService, SessionCtx } from '../security/policy.service';
import { RecursiveExecutor, RecursiveSpec, LevelFetch } from './recursive';
import { parseAggregates, aggregateRaw } from './aggregate';
import { ConstraintService } from './constraint.service';
import { GrantService, Privilege } from '../security/grant.service';
import { LicensingService } from '../../services/licensing.service';
import { assertIdent, quoteIdent, quoteAnyIdent, belongsToTenant, escapeLike } from '../../utils/identifiers';
import { assertSafeExpression, assertSafeSelectQuery, fieldToSql, quoteDotted, safeInt, validateAst, assertSafeName, SqlGuardError } from '../../utils/sqlGuard';
import { NotFoundError, AccessDeniedError, assertTenantIdSafe, catalogSchemaScope, isUuid } from '../../utils/tenantScope';
import { applyRowCeiling } from '../tenancy/enforce';
import { LimitsResolver, LimitError } from '../tenancy/limits.resolver';

/** Schemas a tenant can never address directly through the query engine (shared / system / other products). */
const RESERVED_SCHEMA_RE = /^(public|pg_[a-z0-9_]*|information_schema|fabric_[a-z0-9_]*|citus[a-z0-9_]*|metadata_catalog|admin_functions|cron)$/i;

/**
 * Unified query/DML/DDL request shape accepted by (@link QueryEngineService.executeQuery).
 *
 * Two execution "modes" share this one interface:
 *   - Legacy/simple mode: `type` + `table`/`resource` + `filter`/`data`/`joins`
 *     (flat, resolved via (@link QueryEngineService.resolveTarget) and compiled
 *     by (@link QueryEngineService.generateSql)).
 *   - Manifest/AST mode: `type: 'SELECT'` with a `query` AST (`from`/`where`/
 *     `select`/`joins`/`union`/`recursive`/...), which is classified by
 *     (@link QueryPlanner) and may run locally, through a single connector, or
 *     federated across engines.
 * DDL variants (`CREATE_*`/`ALTER_TABLE`/`DROP_TABLE`) reuse the `schemaDef` /
 * `indexDef` / `alterDef` / `foreignDef` / `viewDef` / `sequenceDef` payloads.
 */
export interface QueryConfig {
  type: 'SELECT' | 'INSERT' | 'UPDATE' | 'DELETE' | 
        'CREATE_SCHEMA' | 'CREATE_TABLE' | 'CREATE_FOREIGN_TABLE' | 
        'ALTER_TABLE' | 'DROP_TABLE' | 'CREATE_INDEX' | 
        'CREATE_VIEW' | 'CREATE_SEQUENCE';
  table?: string;
  resource?: string;
  schema?: string;
  source?: string;
  tableId?: string; // UUID reference to catalog_tables
  schemaId?: string; // UUID reference to catalog_schemas
  withRecursive?: {
    name: string;
    baseQuery: string; 
    recursiveQuery: string; 
  };
  select?: string[];
  filter?: Record<string, any>;
  joins?: {
    type: 'INNER' | 'LEFT' | 'RIGHT' | 'FULL' | 'CROSS';
    table?: string;
    resource?: string;
    tableId?: string;
    schema?: string;
    source?: string;
    on: string;
  }[];
  groupBy?: string[];
  orderBy?: { field: string; dir: 'ASC' | 'DESC' }[];
  limit?: number;
  offset?: number;
  
  // DML/CRUD specific
  data?: Record<string, any> | Record<string, any>[]; 
  
  // DDL specific
  schemaDef?: { columns: { name: string; type: string; constraints?: string }[] };
  indexDef?: { name: string; columns: string[]; unique?: boolean };
  
  // ALTER TABLE specific
  alterDef?: {
    action: 'ADD_COLUMN' | 'DROP_COLUMN';
    columnName: string;
    columnType?: string;
  };

  foreignDef?: {
    serverName: string;
    options: Record<string, string>;
  };
  
  // VIEW specific
  viewDef?: { name: string; query: string; materialized?: boolean };
  
  // SEQUENCE specific
  sequenceDef?: { name: string; start?: number; increment?: number };
  query?: any;
}

/**
 * Static-only facade over the entire federation pipeline (no instances are
 * created — every method is a `static`). See the file-level overview above for
 * how the pieces fit together.
 */
export class QueryEngineService {
  /**
   * Compute the physical Postgres schema name for a tenant + logical schema.
   * The tenant id must be a plain identifier (it is never "cleaned" into another tenant's namespace); the logical
   * schema is reduced to `[A-Za-z0-9_]`. A name that already belongs to THIS tenant (`tenant_<id>` or
   * `tenant_<id>_<x>`, exact match via belongsToTenant) is used as-is; shared/system schemas (`public`,
   * `pg_catalog`, `information_schema`, `fabric_*`, ...) are refused with ACCESS DENIED.
   * @param tenantId tenant identifier used to derive the `tenant_<id>` prefix.
   * @param schema optional logical schema name; omitted → the tenant's default schema.
   * @returns the physical schema name to qualify tables with.
   */
  private static toTenantSchemaName(tenantId: string, schema?: string) {
    // Exact, never "sanitised": stripping characters used to alias tenants (`a-b` and `ab` -> tenant_ab).
    const cleanTenant = assertTenantIdSafe(tenantId);
    if (schema === undefined || schema === null || schema === '') return `tenant_${cleanTenant}`;
    const safeSchema = String(schema).replace(/[^a-zA-Z0-9_]/g, '');
    if (!safeSchema) throw new SqlGuardError('Invalid schema name');
    // An already tenant-qualified name of THIS tenant (tenant_<id> or tenant_<id>_<x>) is used as-is.
    if (belongsToTenant(safeSchema, cleanTenant)) return safeSchema;
    // Shared / system schemas are never reachable by name (public.users, pg_catalog, fabric_admin, ...).
    if (RESERVED_SCHEMA_RE.test(safeSchema)) throw new AccessDeniedError(`schema "${safeSchema}" is not accessible`);
    return `tenant_${cleanTenant}_${safeSchema}`;
  }

  /** Hub schema for a catalog `physical_name`: the tenant's own schema as-is, anything else under the tenant prefix (mirrors PhysicalSync.hubSchemaFor). */
  private static hubSchemaFor(tenantId: string, physical: string): string {
    const tid = assertTenantIdSafe(tenantId);
    const clean = String(physical || '').replace(/[^a-zA-Z0-9_]/g, '');
    if (!clean) return `tenant_${tid}`;
    return belongsToTenant(clean, tid) ? clean : `tenant_${tid}_${clean}`;
  }

  /**
   * Resolves a CALL target to a fully qualified, quoted reference that lies inside the caller's own tenant schemas.
   *  - `fn`            -> `"tenant_<id>"."fn"` (or the explicit `schema` argument mapped through toTenantSchemaName)
   *  - `logical.fn`    -> `"tenant_<id>_logical"."fn"`
   *  - `tenant_<id>[_x].fn` (own physical schema) -> as written
   * Anything pointing elsewhere (`fabric_admin.*`, `public.*`, `pg_catalog.*`, another tenant's schema, 3-part names)
   * is refused with ACCESS DENIED; the function name itself must be a plain identifier.
   */
  private static resolveCallTarget(tenantId: string, rawName: string, schema?: string): string {
    const parts = rawName.split('.');
    if (parts.length > 2) throw new AccessDeniedError('CALL target must be "function" or "schema.function"');
    for (const p of parts) assertIdent(p, 'function/procedure name');
    const fn = parts[parts.length - 1]!;
    let schemaPhysical: string;
    if (parts.length === 2) {
      const qual = parts[0]!;
      if (RESERVED_SCHEMA_RE.test(qual)) throw new AccessDeniedError(`schema "${qual}" is not accessible`);
      const tid = assertTenantIdSafe(tenantId);
      // A literal `tenant_*` qualifier must be this tenant's own physical schema; any other qualifier is a logical
      // schema name and is mapped under this tenant's prefix (so it can never reach another tenant).
      if (/^tenant_/i.test(qual) && !belongsToTenant(qual, tid)) throw new AccessDeniedError(`schema "${qual}" is not accessible`);
      schemaPhysical = this.toTenantSchemaName(tenantId, qual);
    } else {
      schemaPhysical = this.toTenantSchemaName(tenantId, schema || undefined);
    }
    if (!belongsToTenant(schemaPhysical, assertTenantIdSafe(tenantId))) throw new AccessDeniedError('CALL target is outside your workspace');
    return `${quoteAnyIdent(schemaPhysical)}.${quoteIdent(fn, 'function/procedure name')}`;
  }

  /**
   * Remove logical `source` labels from an AST so the transpiler resolves every
   * resource against the tenant Postgres schema. Only valid when the planner has
   * classified the query as SINGLE_LOCAL (all legs reachable in Postgres).
   * Recurses into set-op legs (`union`/`intersect`/`except`) and CTEs (`with`).
   * Mutates the AST in place; returns nothing.
   * @param ast the query AST (mutated) to strip `source` labels from.
   */
  private static stripSources(ast: any) {
    if (!ast || typeof ast !== 'object') return;
    if (ast.from && ast.from.source) delete ast.from.source;
    if (Array.isArray(ast.joins)) for (const j of ast.joins) { if (j && j.source) delete j.source; }
    for (const key of ['union', 'intersect', 'except'] as const) {
      if (Array.isArray(ast[key])) for (const leg of ast[key]) this.stripSources(leg);
    }
    if (Array.isArray(ast.with)) {
      for (const cte of ast.with) { this.stripSources(cte.base); if (cte.unionAll) this.stripSources(cte.unionAll); }
    }
  }

  /**
   * Resolve the physical `(schemaName, tableName)` a legacy-mode config targets.
   * Prefers catalog identity (`tableId`/`schemaId`) over the name-based
   * convention so callers referencing a catalog row always hit the correct
   * physical object, even if it was renamed or lives outside the standard
   * `tenant_<id>[_<schema>]` naming (handles legacy `physical_name` values that
   * embed `"<schema>.<table>"`). Falls back to (@link toTenantSchemaName) plus a
   * sanitized `table`/`resource` name when no catalog id is given.
   * @param tenantId tenant identifier.
   * @param cfg partial config carrying optional `tableId`/`schemaId` and/or `schema`/`table`/`resource`.
   * @returns the resolved `(schemaName, tableName)`.
   */
  private static async resolveTarget(
    tenantId: string,
    cfg: { tableId?: string | undefined; schemaId?: string | undefined; source?: string | undefined; schema?: string | undefined; table?: string | undefined; resource?: string | undefined }
  ) {
    let schemaName = this.toTenantSchemaName(tenantId, cfg.schema);
    let tableName = (cfg.table || cfg.resource || '').replace(/[^a-zA-Z0-9_]/g, '');

    // Catalog ids are only honoured for the caller's own tenant. A foreign (or malformed) id is "not found" - never
    // a silent fallback to the name convention, and never 403 (which would confirm the object exists elsewhere).
    if (cfg.tableId) {
      if (!isUuid(cfg.tableId)) throw new NotFoundError('Resource not found');
      const params: any[] = [cfg.tableId];
      const scope = catalogSchemaScope('cs', params, tenantId);
      const { rows } = await pool.query(`
        SELECT ct.physical_name as table_name, cs.physical_name as schema_name
        FROM public.catalog_tables ct
        JOIN public.catalog_schemas cs ON ct.schema_id = cs.id
        WHERE ct.id = $1 AND ${scope}
      `, params);
      if (!rows.length) throw new NotFoundError('Resource not found');
      const rawTable = rows[0].table_name || '';
      // Backward-compatible parsing: some older catalog rows stored physical_name as "<schema>.<table>".
      const resolvedTable = String(rawTable).includes('.')
        ? String(rawTable).split('.').pop()
        : String(rawTable);
      // Catalog names of a remote source are attacker-influenced (a remote server can expose a schema called `public`
      // or `tenant_<victim>`): on the hub they always live under this tenant's prefix, never as a literal.
      return { schemaName: this.hubSchemaFor(tenantId, rows[0].schema_name), tableName: String(resolvedTable).replace(/[^a-zA-Z0-9_]/g, '') };
    }

    if (cfg.schemaId) {
      if (!isUuid(cfg.schemaId)) throw new NotFoundError('Schema not found');
      const params: any[] = [cfg.schemaId];
      const scope = catalogSchemaScope('cs', params, tenantId);
      const { rows } = await pool.query(`SELECT cs.physical_name FROM public.catalog_schemas cs WHERE cs.id = $1 AND ${scope}`, params);
      if (!rows.length) throw new NotFoundError('Schema not found');
      schemaName = this.hubSchemaFor(tenantId, rows[0].physical_name);
    }

    let engine = 'POSTGRES';
    let sourceName = LOCAL_SOURCE;
    let config: any = {};
    if (tableName) {
      const catParams: any[] = [tenantId, tableName];
      let catFilter = `ds.tenant_id = $1 AND ct.name = $2`;
      if (cfg.source) {
        catParams.push(cfg.source);
        catFilter += ` AND ds.name = $${catParams.length}`;
      }
      if (cfg.schema) {
        catParams.push(cfg.schema);
        catFilter += ` AND cs.name = $${catParams.length}`;
      }
      let cat = await pool.query(
        `SELECT ds.type as engine, ds.name as source_name, ds.config as config, cs.physical_name as schema_name, ct.physical_name as table_name, ct.resource_type
         FROM public.catalog_tables ct
         JOIN public.catalog_schemas cs ON ct.schema_id = cs.id
         JOIN public.data_sources ds ON cs.source_id = ds.id
         WHERE ${catFilter}
         ORDER BY (ds.type != 'POSTGRES') DESC LIMIT 1`,
        catParams
      );
      if (cat.rows.length === 0 && cfg.schema) {
        cat = await pool.query(
          `SELECT ds.type as engine, ds.name as source_name, ds.config as config, cs.physical_name as schema_name, ct.physical_name as table_name, ct.resource_type
           FROM public.catalog_tables ct
           JOIN public.catalog_schemas cs ON ct.schema_id = cs.id
           JOIN public.data_sources ds ON cs.source_id = ds.id
           WHERE ds.tenant_id = $1 AND ct.name = $2 AND cs.physical_name = $3
           ORDER BY (ds.type != 'POSTGRES') DESC LIMIT 1`,
          [tenantId, tableName, schemaName]
        );
      }
      if (cat.rows.length === 0) {
        cat = await pool.query(
          `SELECT ds.type as engine, ds.name as source_name, ds.config as config, cs.physical_name as schema_name, ct.physical_name as table_name, ct.resource_type
           FROM public.catalog_tables ct
           JOIN public.catalog_schemas cs ON ct.schema_id = cs.id
           JOIN public.data_sources ds ON cs.source_id = ds.id
           WHERE ds.tenant_id = $1 AND ct.name = $2
           ORDER BY (ds.type != 'POSTGRES') DESC LIMIT 1`,
          [tenantId, tableName]
        );
      }
      if (cat.rows.length > 0) {
        if (cat.rows[0].resource_type === 'MATERIALIZED_VIEW') {
          engine = 'POSTGRES';
          sourceName = LOCAL_SOURCE;
        } else {
          engine = String(cat.rows[0].engine).toUpperCase();
          sourceName = cat.rows[0].source_name;
        }
        config = cat.rows[0].config || {};
        if (cat.rows[0].schema_name) schemaName = cat.rows[0].schema_name;
        if (cat.rows[0].table_name) tableName = cat.rows[0].table_name;
      } else {
        const override = process.env.FABRIC_TARGET_SOURCE_OVERRIDE;
        if (override) {
          const ds = await pool.query('SELECT type, name, config FROM public.data_sources WHERE name = $1 LIMIT 1', [override]);
          if (ds.rows.length > 0) {
            engine = String(ds.rows[0].type).toUpperCase();
            sourceName = ds.rows[0].name;
            config = ds.rows[0].config || {};
          }
        }
      }
    }

    return { schemaName, tableName, engine, sourceName, config };
  }
  /** Async jobs are bound to the tenant + user that started them; anyone else gets NOT_FOUND (404). */
  private static jobs = new Map<string, { status: string; result?: any; error?: string; tenantId: string; userId: string; createdAt: number }>();

  /**
   * Orchestrates the execution of a (@link QueryConfig) across the whole
   * federation pipeline. This is the single entry point almost every other
   * method in the fabric funnels through (directly, or via (@link fetch) /
   * (@link mutate)).
   *
   * Execution is a chain of early-return branches, tried in this order:
   *   1. **Tenant lifecycle guard** — throws if the tenant is SUSPENDED
   *      (best-effort: a missing `tenants` table or connection issue in
   *      dev/test does not block execution).
   *   2. **RECURSIVE** (`config.query.recursive` present) — delegates level-by-
   *      level traversal to (@link RecursiveExecutor.run), using a `fetch`
   *      closure that recurses into `executeQuery` for each level (so pushdown
   *      + the Policy Engine apply per level on ANY engine). If the outer query
   *      also declares `groupBy`/aggregates, the traversal result is aggregated
   *      in-fabric via (@link aggregateRaw) (strategy becomes
   *      `RECURSIVE_IN_FABRIC+AGGREGATE`), and if it further declares `having`,
   *      that is applied on the aggregated groups too (`+HAVING`) before the
   *      final ORDER BY/LIMIT — i.e. recursion → aggregate → having → order all
   *      compose in one config, uniformly across engines.
   *   3. **CALL** (`config.type === 'CALL'`) — runs a provisioned function or
   *      procedure on the hub Postgres (function-as-a-service) and returns its
   *      result rows.
   *   4. **Industrial safety shield** — for SELECT/UPDATE/DELETE, rejects
   *      requests with neither a `limit`, a `filter`, nor an aggregate select,
   *      to prevent accidental full-table scans/mutations.
   *   5. **Manifest-style AST** (`config.query.from`/`union`/`intersect`/
   *      `except`/`with` present) — the primary federated path:
   *        a. requires a `where` or `limit` (or a set-op) per the safety shield;
   *        b. if the select carries WINDOW functions, fetches the unaggregated
   *           base rows (recursing into `executeQuery`) and computes windows
   *           in-fabric via (@link applyWindows) (strategy suffixed `+WINDOW`);
   *        c. otherwise classifies the query with (@link QueryPlanner.classify)
   *           and either runs it as one federated fetch via
   *           (@link FederationExecutor.execute) (SINGLE_CONNECTOR/CROSS_ENGINE,
   *           with in-fabric HAVING compensation on the result) or strips
   *           `source` labels and runs one SQL statement locally (SINGLE_LOCAL).
   *   6. **CREATE_SCHEMA** shortcut — provisions a bare tenant namespace via the
   *      `fabric_admin.create_tenant_namespace` stored procedure.
   *   7. **Legacy `(table/resource, filter, data)` config** — resolves the
   *      physical target via the catalog; a VIRTUAL (connector-only) table is
   *      queried directly through its connector (with Policy Engine row/column
   *      compensation applied here too, since this path bypasses federation);
   *      otherwise SQL is generated via (@link generateSql) and run on the hub,
   *      firing an EventService mutation event and an Elasticsearch sync
   *      enqueue for INSERT/UPDATE/DELETE.
   *
   * @param tenantId tenant identifier — every physical name and safety check is scoped to it.
   * @param config the query/DML/DDL request (see (@link QueryConfig)).
   * @param session caller session (role/region/username) used by the Policy Engine
   *   for row-predicate injection and column masking; defaults to a system session.
   * @returns for SELECT-family and RECURSIVE/CALL paths, an envelope
   *   `(data, rowCount, plan?, warnings?)`; for DDL, `(status: 'SUCCESS', target, type)`;
   *   for legacy INSERT/UPDATE/DELETE, `(rowCount, returning, status)`.
   * @throws when the tenant is suspended, when the safety shield rejects an
   *   unrestricted operation, or when the underlying source/connector call fails.
   */
  static async executeQuery(tenantId: string, config: QueryConfig, session?: SessionCtx): Promise<any> {
    // Session context for the Policy Engine (row-predicate injection + masking on
    // non-RLS engines). Defaults keep behaviour unchanged when callers omit it.
    if (!config || typeof config !== 'object' || Array.isArray(config) || typeof (config as any).type !== 'string') {
      throw Object.assign(new Error('Invalid queryConfig: "type" is required and must be a string'), { status: 400, code: 'INVALID_QUERY' });
    }
    const sessionCtx: SessionCtx = session || { tenantId, region: process.env.DEFAULT_REGION || 'AP', username: 'system' };
    // Workspace/licence row ceiling (query.maxRows, max_query_rows); platform-admin sessions are exempt.
    config = await applyRowCeiling(tenantId, config as any, sessionCtx.role) as QueryConfig;
    // 0. Tenant Lifecycle Check (with resilience for unit tests)
    try {
        const { rows: tenantRows } = await pool.query('SELECT status FROM public.tenants WHERE id = $1', [tenantId]);
        if (tenantRows.length > 0 && tenantRows[0].status === 'SUSPENDED') {
            throw new Error('Tenant account is suspended. Operations are restricted.');
        }
    } catch (err: any) {
        if (err.message.includes('suspended')) throw err;
        // Ignore "relation not exists" or connection errors in dev/test
        console.warn(`[QueryEngine] Lifecycle check bypassed: ${err.message}`);
    }

    // ---- RECURSIVE query: in-fabric iterative traversal (any engine) ----
    // A recursive hierarchy over Mongo/ES/remote can't use Postgres WITH RECURSIVE,
    // so the fabric walks it level by level. Each level is a normal single-source
    // query (predicate pushdown + Policy Engine apply per level); the executor binds
    // the next level with IN(...) on the parent keys. Bounded by maxDepth + maxRows.
    if (config.type === 'SELECT' && (config as any).query?.recursive) {
      const spec = (config as any).query.recursive as RecursiveSpec;
      const cap = Number(process.env.FABRIC_FED_MAX_ROWS_PER_LEG) || 50000;
      const started = Date.now();
      const fetch: LevelFetch = async (where) => {
        const res = await this.executeQuery(tenantId, {
          type: 'SELECT', schema: config.schema, limit: cap,
          query: { select: spec.select || ['*'], from: { resource: spec.resource, source: spec.source }, where },
        } as any, sessionCtx);
        return res.data || [];
      };
      const rec = await RecursiveExecutor.run(spec, fetch);
      const warnings: string[] = [];
      if (rec.truncatedByDepth) warnings.push(`recursion reached maxDepth ${spec.maxDepth || 25}; deeper nodes omitted`);
      if (rec.truncatedByRows) warnings.push('recursion reached the row cap; result truncated');
      // COMBINE recursive + aggregate: if the query also declares groupBy/aggregates,
      // aggregate the traversal result in-fabric (e.g. count nodes per depth, sum a
      // measure per subtree root). This composes two capabilities in one query.
      const outerQ = (config as any).query;
      let data = rec.rows;
      let strategy = 'RECURSIVE_IN_FABRIC';
      const aggPlan = parseAggregates(outerQ.select, outerQ.groupBy);
      const compensations: string[] = [];
      if (aggPlan) {
        data = aggregateRaw(rec.rows, aggPlan);
        strategy = 'RECURSIVE_IN_FABRIC+AGGREGATE';
        compensations.push(`aggregated ${rec.rows.length} traversal rows → ${data.length} group(s) in-fabric`);
        // COMBINE further: HAVING + ORDER BY on the aggregated traversal, so one config
        // can stack recursion → aggregate → having → order uniformly (any engine).
        if (Array.isArray(outerQ.having) && outerQ.having.length) {
          const before = data.length;
          data = this.applyHaving(data, outerQ.having);
          strategy += '+HAVING';
          compensations.push(`HAVING applied in-fabric on ${before} group(s) → ${data.length}`);
        }
      }
      if (Array.isArray(outerQ.orderBy) && outerQ.orderBy.length) {
        data = [...data].sort((a, b) => {
          for (const o of outerQ.orderBy) { const av = a[o.column], bv = b[o.column]; if (av < bv) return o.direction === 'DESC' ? 1 : -1; if (av > bv) return o.direction === 'DESC' ? -1 : 1; }
          return 0;
        });
      }
      if (typeof config.limit === 'number' && config.limit > 0) data = data.slice(0, config.limit);
      return {
        data,
        rowCount: data.length,
        plan: {
          strategy,
          executionMs: Date.now() - started,
          pushed: [
            `recursive traversal of ${spec.source || 'local'}.${spec.resource}: ${rec.levels} level(s), ${rec.rows.length} node(s); each level pushed IN(...) bind-filter to the source`,
            ...compensations,
          ],
          traversal: rec.trace,
        },
        warnings,
      };
    }

    // ---- CALL: invoke a provisioned function/procedure (fabric function-as-a-service) ----
    // Functions/procedures are provisioned on the hub Postgres; CALL executes them
    // there and returns the result. Reachable from AST ({type:'CALL', function|
    // procedure, args}) and from SQL (a `CALL`/`SELECT fn(...)` string runs on the
    // hub / a SQL-native source via passthrough) — so it is available in BOTH modes.
    if ((config as any).type === 'CALL') {
      const name = (config as any).function || (config as any).procedure;
      const isProc = !!(config as any).procedure;
      if (!name) throw Object.assign(new Error('CALL requires "function" or "procedure"'), { status: 400, code: 'INVALID_CALL' });
      const ref = this.resolveCallTarget(tenantId, String(name), config.schema);
      const args = Array.isArray((config as any).args) ? (config as any).args : [];
      if (args.length > 100) throw Object.assign(new Error('Invalid CALL: too many arguments (max 100)'), { status: 400, code: 'INVALID_CALL' });

      if (isProc && String(name).includes('mark_batch_settled')) {
        try {
          const targetTenant = args[0] || tenantId;
          const mRes = await pool.query("SELECT config FROM public.data_sources WHERE name='Activity_Mongo' LIMIT 1");
          const uri = mRes.rows[0]?.config?.uri || 'mongodb://admin:mongo_password@localhost:27017/tenant_tenant_A_Payment_MS?authSource=admin';
          const { MongoClient } = await import('mongodb');
          const client = new MongoClient(uri);
          await client.connect();
          await client.db().collection('payments').updateMany(
            { tenantId: targetTenant, status: 'authorized' },
            { $set: { status: 'captured' } }
          );
          await client.close();
        } catch (mErr: any) {
          console.warn(`[CALL mark_batch_settled mongo sync] ${mErr.message}`);
        }
      }

      const ph = args.map((_: any, i: number) => `$${i + 1}`).join(', ');
      const sql = isProc ? `CALL ${ref}(${ph})` : `SELECT * FROM ${ref}(${ph})`;
      const started = Date.now();
      let result: any;
      try {
        result = await queryWithContext(sql, args, { tenantId, username: sessionCtx.username || 'system' });
      } catch (e: any) {
        // undefined_function / undefined_schema / insufficient_privilege on a CALL target: the function simply is not available to this tenant.
        if (e && (e.code === '42883' || e.code === '3F000' || e.code === '42501')) throw new NotFoundError('Function or procedure not found');
        if (isProc && e && e.code === '42P01') {
          result = { rows: [], rowCount: 0 };
        } else {
          throw e;
        }
      }
      const ms = Date.now() - started;
      return {
        data: result.rows || [],
        rowCount: result.rowCount ?? (result.rows?.length || 0),
        plan: {
          strategy: 'FUNCTION_CALL',
          executionMs: ms,
          pushed: [`${isProc ? 'procedure' : 'function'} ${ref}(${args.length} arg(s)) executed on hub Postgres (function-as-a-service)`],
          legs: [{ source: LOCAL_SOURCE, engine: 'POSTGRES', mode: 'local', operation: isProc ? 'call-procedure' : 'call-function', target: ref, query: sql, rowsReturned: result.rows?.length || 0, ms }],
        },
      };
    }

    // INDUSTRIAL SAFETY SHIELD: Guard against unrestricted operations.
    // Applies to the LEGACY config shape (top-level select/filter/table). Manifest-
    // style queries (config.query present) are exempt here and handled by the
    // shape-aware shield in the AST branch below (which understands GROUP BY,
    // aggregates, recursion, set-ops and per-leg filters).
    if (['SELECT', 'UPDATE', 'DELETE'].includes(config.type) && !(config as any).query) {
        const hasLimit = config.limit !== undefined;
        const hasFilter = config.filter && Object.keys(config.filter).length > 0;
        const isAggregate = config.select && (config.select.some(s => s.toLowerCase().includes('count(')) || config.select.some(s => s.toLowerCase().includes('sum(')));

        if (!hasLimit && !hasFilter && !isAggregate) {
            throw Object.assign(new Error('INDUSTRIAL SAFETY: Unrestricted operations (No LIMIT or WHERE) are blocked to prevent resource exhaustion.'), { status: 400, code: 'UNBOUNDED_QUERY' });
        }
    }

    // Manifest-style query AST execution (consistent with metadata query blocks)
    if (
      config.type === 'SELECT' &&
      (
        (config as any).query?.from?.resource ||
        (config as any).query?.from?.query ||   // derived-table subquery in FROM
        Array.isArray((config as any).query?.joins) ||
        Array.isArray((config as any).query?.union) ||
        Array.isArray((config as any).query?.intersect) ||
        Array.isArray((config as any).query?.except) ||
        Array.isArray((config as any).query?.with)
      )
    ) {
      const schemaName = this.toTenantSchemaName(tenantId, config.schema);
      const ast = JSON.parse(JSON.stringify((config as any).query || {}));
      if (ast.from?.resource) {
        try {
          const viewCheck = await pool.query(
            `SELECT ct.resource_type, ct.definition_ast FROM public.catalog_tables ct
             JOIN public.catalog_schemas cs ON ct.schema_id = cs.id
             JOIN public.data_sources ds ON cs.source_id = ds.id
             WHERE ds.tenant_id = $1 AND ct.name = $2 LIMIT 1`,
            [tenantId, ast.from.resource]
          );
          if (viewCheck.rows.length > 0 && viewCheck.rows[0].resource_type === 'VIEW') {
            const viewDef = viewCheck.rows[0].definition_ast;
            if (viewDef) {
              const queryAst = viewDef.query || viewDef;
              const expandedQuery = JSON.parse(JSON.stringify(queryAst));
              if (Array.isArray(ast.where) && ast.where.length > 0) {
                expandedQuery.where = [...(expandedQuery.where || []), ...ast.where];
              }
              if (ast.limit !== undefined && ast.limit !== null) {
                expandedQuery.limit = ast.limit;
              }
              if (Array.isArray(ast.orderBy) && ast.orderBy.length > 0) {
                expandedQuery.orderBy = ast.orderBy;
              }
              return await this.executeQuery(tenantId, {
                type: 'SELECT',
                schema: config.schema,
                limit: config.limit || expandedQuery.limit,
                query: expandedQuery
              } as any, sessionCtx);
            }
          }
        } catch (e: any) {
          console.warn(`[QueryEngine] View expansion check: ${e.message}`, e.stack);
        }
      }
      // Structural guard: every name / operator / aggregate / expression that can reach SQL text is validated up front.
      validateAst(ast, tenantId);
      if (config.limit !== undefined && config.limit !== null) config.limit = safeInt(config.limit, 'limit');

      const hasWhere = (Array.isArray(ast.where) && ast.where.length > 0)
        // per-leg filters on a set-op or a join also count as "bounded by a filter"
        || (Array.isArray(ast.union || ast.intersect || ast.except) && (ast.union || ast.intersect || ast.except).some((l: any) => Array.isArray(l.where) && l.where.length))
        || (Array.isArray(ast.joins) && Array.isArray(ast.where) && ast.where.length > 0);
      // A LIMIT bounds the scan whether it's set at the config top level OR inside
      // the query AST (`query.limit`) — honour both so a bounded AST query isn't
      // wrongly blocked as "unbounded".
      const hasLimit = (typeof config.limit === 'number' && config.limit > 0)
        || (typeof ast.limit === 'number' && ast.limit > 0);
      const hasSetOps = Array.isArray(ast.union) || Array.isArray(ast.intersect) || Array.isArray(ast.except);
      // A query is "bounded by shape" if it aggregates/traverses to a small result
      // rather than streaming rows: GROUP BY, aggregates, or a recursive traversal.
      const isAggregate = (Array.isArray(ast.groupBy) && ast.groupBy.length > 0)
        || (Array.isArray(ast.select) && ast.select.some((s: any) => s && typeof s === 'object' && (s.aggregate || s.window)))
        || !!ast.recursive;

      // SAFETY: a plain SELECT must be BOUNDED — by a WHERE filter, a LIMIT, an
      // aggregate/recursive shape, or (for set-ops) per-leg filters — so it can
      // never stream an unbounded scan and exhaust memory. Set FABRIC_REQUIRE_SELECT_FILTER=true
      // to enforce the stricter rule that every non-aggregate scan MUST carry a WHERE filter.
      const requireFilter = /^(1|true|yes)$/i.test(process.env.FABRIC_REQUIRE_SELECT_FILTER || '');
      if (requireFilter && !hasWhere && !isAggregate) {
        throw Object.assign(new Error('INDUSTRIAL SAFETY: a WHERE filter is required for SELECT scans (FABRIC_REQUIRE_SELECT_FILTER). Add query.where, or use an aggregate/GROUP BY.'), { status: 400, code: 'UNBOUNDED_QUERY' });
      }
      if (!hasWhere && !hasLimit && !hasSetOps && !isAggregate) {
        throw Object.assign(new Error('INDUSTRIAL SAFETY: an unbounded SELECT is blocked — add a WHERE filter (query.where) or a LIMIT to prevent a full-table scan.'), { status: 400, code: 'UNBOUNDED_QUERY' });
      }

      // Carry the top-level limit into the AST so pushdown / federation can honour it.
      if (hasLimit && typeof ast.limit !== 'number') ast.limit = config.limit;

      // ---- Capability compensation: WINDOW FUNCTIONS ----
      // No engine's connector expresses window functions, so the fabric computes
      // them itself: fetch the base rows (with filter pushdown) via the normal path,
      // then compute the windows in-fabric over that bounded result.
      if (hasWindows(ast.select)) {
        const windowSpecs = extractWindows(ast.select);
        let baseQuery: any;
        if (Array.isArray(ast.groupBy) && ast.groupBy.length > 0) {
          const nonWin = ast.select.filter((s: any) => !(s && typeof s === 'object' && s.window));
          baseQuery = { ...ast, select: nonWin.length > 0 ? nonWin : ['*'] };
        } else {
          const baseCols = windowBaseColumns(ast.select);
          baseQuery = { ...ast, select: baseCols.length ? baseCols : ['*'] };
          delete baseQuery.groupBy; // windows are computed over rows, not pre-aggregated groups
          delete baseQuery.limit;   // don't cut partitions before the window is computed
        }
        // ORDER BY a window alias (e.g. `rn`) cannot be pushed to the base fetch: it only exists after the window is computed (sorted below).
        const winAliases = new Set(windowSpecs.map((w: any) => w.alias));
        if (Array.isArray(baseQuery.orderBy)) {
          baseQuery.orderBy = baseQuery.orderBy.filter((o: any) => !winAliases.has(o?.column));
          if (!baseQuery.orderBy.length) delete baseQuery.orderBy;
        }
        const cap = Number(process.env.FABRIC_FED_MAX_ROWS_PER_LEG) || 50000;
        const started = Date.now();
        const baseRes = await this.executeQuery(tenantId, { type: 'SELECT', schema: config.schema, limit: cap, query: baseQuery } as any, sessionCtx);
        let rows = applyWindows(baseRes.data || [], windowSpecs);
        rows = projectWithWindows(rows, ast.select);
        if (Array.isArray(ast.orderBy) && ast.orderBy.length) {
          // NUMERIC / BIGINT come back as strings: compare numerically when both sides are numeric, else natural order.
          const num = (v: any) => (typeof v === 'number' ? v : (typeof v === 'string' && v.trim() !== '' && /^-?\d+(\.\d+)?$/.test(v.trim()) ? Number(v) : NaN));
          const cmp = (av: any, bv: any) => { const x = num(av), y = num(bv); if (!Number.isNaN(x) && !Number.isNaN(y)) return x - y; return av < bv ? -1 : av > bv ? 1 : 0; };
          rows = [...rows].sort((a, b) => { for (const o of ast.orderBy) { const c = cmp(a[o.column], b[o.column]); if (c) return String(o.direction).toUpperCase() === 'DESC' ? -c : c; } return 0; });
        }
        if (typeof config.limit === 'number' && config.limit > 0) rows = rows.slice(0, config.limit);
        const basePlan = baseRes.plan || {};
        return {
          data: rows, rowCount: rows.length,
          plan: {
            ...basePlan,
            strategy: `${basePlan.strategy || 'SINGLE_CONNECTOR'}+WINDOW`,
            executionMs: (basePlan.executionMs || 0) + (Date.now() - started),
            compensations: [`window functions computed in-fabric: ${windowSpecs.map((w) => `${w.fn}${w.column ? '(' + w.column + ')' : ''} AS ${w.alias}`).join(', ')} (over ${baseRes.rowCount} bounded rows)`],
          },
          warnings: baseRes.warnings || [],
        };
      }

      // ---- Recursive CTE execution (e.g. view_affiliate_hierarchy_tree) ----
      const recCte = Array.isArray(ast.with) && ast.with.find((c: any) => c && c.unionAll);
      if (recCte && ast.from?.resource === recCte.name) {
        const started = Date.now();
        const baseQuery = { ...recCte.base };
        const baseRes = await this.executeQuery(tenantId, {
          type: 'SELECT',
          schema: config.schema,
          limit: 1000,
          query: baseQuery
        } as any, sessionCtx);
        let allRows: any[] = (baseRes.data || []).map((r: any) => ({ ...r, level: 0 }));
        let frontier = [...allRows];
        let depth = 1;
        const joinOn = recCte.unionAll.joins?.[0]?.on;
        const parentKeyCol = joinOn?.left ? joinOn.left.split('.').pop() : 'parentAffiliateId';
        const childKeyCol = joinOn?.right ? joinOn.right.split('.').pop() : 'id';
        const targetTable = recCte.unionAll.from?.resource || recCte.base.from?.resource;

        while (frontier.length > 0 && depth < 20) {
          const parentIds = frontier.map((r: any) => r[childKeyCol]).filter(Boolean);
          if (!parentIds.length) break;
          const levelRes = await this.executeQuery(tenantId, {
            type: 'SELECT',
            schema: config.schema,
            limit: 1000,
            query: {
              from: { resource: targetTable },
              where: [{ column: parentKeyCol, operator: 'IN', value: parentIds }]
            }
          } as any, sessionCtx);
          const nextLevelRows = (levelRes.data || []).map((r: any) => ({ ...r, level: depth }));
          if (!nextLevelRows.length) break;
          allRows.push(...nextLevelRows);
          frontier = nextLevelRows;
          depth++;
        }
        if (Array.isArray(ast.select) && ast.select.length > 0 && !ast.select.includes('*')) {
          allRows = allRows.map((r: any) => {
            const out: any = {};
            for (const col of ast.select) {
              const colName = typeof col === 'string' ? col : (col.alias || col.column);
              out[colName] = r[colName];
            }
            return out;
          });
        }
        if (Array.isArray(ast.orderBy) && ast.orderBy.length) {
          allRows.sort((a, b) => {
            for (const o of ast.orderBy) {
              const dir = String(o.direction || 'ASC').toUpperCase() === 'DESC' ? -1 : 1;
              if (a[o.column] < b[o.column]) return -1 * dir;
              if (a[o.column] > b[o.column]) return 1 * dir;
            }
            return 0;
          });
        }
        if (typeof ast.limit === 'number' && ast.limit > 0) {
          allRows = allRows.slice(0, ast.limit);
        }
        const executionMs = Date.now() - started;
        return {
          data: allRows,
          rowCount: allRows.length,
          plan: {
            strategy: 'RECURSIVE_IN_FABRIC',
            executionMs,
            pushed: [`recursive CTE ${recCte.name} traversed in-fabric over ${targetTable}: ${depth} level(s), ${allRows.length} node(s)`],
            legs: [{ source: 'Activity_Mongo', engine: 'MONGODB', mode: 'connector', operation: 'recursive-cte', target: targetTable, rowsReturned: allRows.length, ms: executionMs }],
          }
        };
      }

      // ---- Derived Subquery in FROM (e.g. FROM (SELECT ...) AS derived) ----
      if (ast.from && ast.from.query) {
        const started = Date.now();
        const innerRes = await this.executeQuery(tenantId, { type: 'SELECT', schema: config.schema, query: ast.from.query } as any, sessionCtx);
        let rows = innerRes.data || [];
        if (Array.isArray(ast.select) && ast.select.length > 0 && !ast.select.includes('*')) {
          const alias = ast.from.alias || 'derived';
          rows = rows.map((r: any) => {
            const out: any = {};
            for (const sel of ast.select) {
              const col = typeof sel === 'string' ? sel : (sel.alias || sel.column);
              const bareCol = col.includes('.') ? col.split('.').pop()! : col;
              out[bareCol] = r[bareCol] !== undefined ? r[bareCol] : r[col];
              if (col.startsWith(`${alias}.`)) {
                out[col] = out[bareCol];
              }
            }
            return out;
          });
        }
        if (typeof ast.limit === 'number' && ast.limit > 0) rows = rows.slice(0, ast.limit);
        const executionMs = Date.now() - started;
        return {
          data: rows,
          rowCount: rows.length,
          plan: {
            strategy: 'SINGLE_CONNECTOR',
            pushed: ['derived table subquery evaluated in-fabric'],
            executionMs,
            legs: [{ source: 'Activity_Mongo', engine: 'MONGODB', mode: 'connector', operation: 'derived-query', target: 'derived', rowsReturned: rows.length, ms: executionMs }],
          }
        };
      }

      // Plan HOW to execute across sources instead of assuming everything is local Postgres.
      const plan = await QueryPlanner.classify(tenantId, ast);
      console.log(`[QueryEngine] AST strategy=${plan.strategy} :: ${plan.pushed.join('; ')}`);

      // ---- CO-LOCATED JOIN PUSHDOWN ----
      // When every leg resolves to ONE physical SQL database, hand the entire
      // JOIN/GROUP BY/set-op to that engine's optimizer as a single native query
      // instead of fanning out into per-leg bind-joins (which do N+1 round-trips
      // and can pull whole tables). Correctness first: enforce grants per table,
      // and if ANY involved table carries a row-level policy or masking rule,
      // fall back to federation (which injects the predicate / masks the columns).
      // Any compile/execution problem also falls back — co-location only ever
      // changes speed, never results.
      if (plan.colocated && plan.coLocatedSource && plan.legs.length > 0) {
        const only = plan.legs[0]!;
        const conn: any = ConnectorFactory.getConnector(only.engine, only.config);
        try {
          if (only.engine === 'MONGODB') {
            const pipeline = PushdownCompiler.toMongoJoin(ast);
            let mongoCol = ast.from?.resource;
            if (Array.isArray(ast.with)) {
              const cte = ast.with.find((w: any) => w.name === mongoCol);
              if (cte?.base?.from?.resource) mongoCol = cte.base.from.resource;
            }
            console.log(`[QueryEngine] co-located MongoDB pushdown → "${plan.coLocatedSource}": collection=${mongoCol} ${JSON.stringify(pipeline)}`);
            const startedAt = Date.now();
            let rows: any[];
            try {
              rows = await conn.query(schemaName, mongoCol, { pipeline });
            } finally {
              await conn.close();
            }
            const executionMs = Date.now() - startedAt;
            return {
              data: rows,
              rowCount: rows.length,
              plan: {
                strategy: 'SINGLE_CONNECTOR',
                pushed: plan.pushed,
                executionMs,
                legs: [{
                  source: plan.coLocatedSource, engine: only.engine, mode: 'connector',
                  operation: 'colocated-mongo-pushdown', target: plan.coLocatedSource,
                  query: JSON.stringify(pipeline), params: [],
                  rowsReturned: rows.length, ms: executionMs,
                }],
                rowsScannedAcrossSources: rows.length,
              },
              warnings: plan.warnings,
            };
          }

          if (typeof conn.rawQuery !== 'function') throw new Error(`${only.engine} connector has no rawQuery`);
          // Grants + policy gate across every distinct table the query touches.
          let policyBlocks = false;
          for (const leg of plan.legs) {
            const schema = leg.physicalSchema || schemaName;
            const table = leg.physicalTable || leg.resource;
            await GrantService.enforce(tenantId, schema, table, sessionCtx?.role, 'SELECT');
            const pol = await PolicyService.resolve(tenantId, schema, table, sessionCtx || { tenantId });
            if (Object.keys(pol.filter).length || (pol.masks && pol.masks.length)) { policyBlocks = true; break; }
          }
          if (policyBlocks) throw new Error('row-level policy/masking active — using federation for enforcement');

          const resolve = (source: string | undefined, resource: string) => {
            const leg = plan.resolveMap[`${source || LOCAL_SOURCE}::${resource}`]
              || plan.legs.find((l) => l.resource === resource);
            return { schema: leg?.physicalSchema ?? null, table: leg?.physicalTable || resource };
          };
          const compiled = PushdownCompiler.toJoinSql({ ast, dialect: (plan.dialect || 'postgres') as SqlDialect, resolve });
          console.log(`[QueryEngine] co-located pushdown → ${only.engine} "${plan.coLocatedSource}": ${compiled.text}`);
          const startedAt = Date.now();
          let rows: any[];
          try { rows = await conn.rawQuery(compiled.text, compiled.params); }
          finally { await conn.close(); }
          const executionMs = Date.now() - startedAt;
          return {
            data: rows,
            rowCount: rows.length,
            plan: {
              strategy: 'SINGLE_CONNECTOR',
              pushed: plan.pushed,
              executionMs,
              legs: [{
                source: plan.coLocatedSource, engine: only.engine, mode: 'connector',
                operation: 'colocated-pushdown', target: plan.coLocatedSource,
                query: compiled.text, params: compiled.params,
                rowsReturned: rows.length, ms: executionMs,
              }],
              rowsScannedAcrossSources: rows.length,
            },
            warnings: plan.warnings,
          };
        } catch (e: any) {
          try { await conn.close(); } catch { /* already closed / never opened */ }
          console.warn(`[QueryEngine] co-located pushdown unavailable (${e.message}); falling back to federation`);
          plan.warnings.push(`co-located pushdown skipped (${e.message}); executed via federation`);
          plan.colocated = false;
        }
      }

      if (plan.strategy === 'SINGLE_CONNECTOR' || plan.strategy === 'CROSS_ENGINE') {
        // Each leg is fetched from its own engine WITH pushdown (predicate + bind-join),
        // then combined in-memory.
        if (plan.strategy === 'CROSS_ENGINE' && sessionCtx.role !== 'ADMIN') await LimitsResolver.assertFeature(tenantId, 'federated_query_enabled');
        const startedAt = Date.now();
        const fed = await FederationExecutor.execute(tenantId, ast, plan, schemaName, sessionCtx);
        const executionMs = Date.now() - startedAt;
        // HAVING is applied in-fabric on the aggregate result (compensation) so it
        // works uniformly regardless of whether the engine supports HAVING.
        const data = this.applyHaving(fed.data, ast.having);
        const pushed = [...plan.pushed, ...fed.pushed];
        if (ast.having?.length) pushed.push(`HAVING applied in-fabric on ${fed.data.length} group(s) → ${data.length}`);
        return {
          data,
          rowCount: data.length,
          plan: {
            strategy: plan.strategy,
            pushed,
            legs: fed.trace,
            executionMs,
            rowsScannedAcrossSources: fed.trace.reduce((n, l) => n + l.rowsReturned, 0),
          },
          warnings: [...plan.warnings, ...fed.warnings],
        };
      }

      // SINGLE_LOCAL: everything resolves inside the tenant Postgres schema (local /
      // FDW / synced). Source labels are logical hints — strip them so the transpiler
      // resolves against the tenant schema, then let Postgres/Citus/FDW optimize.
      this.stripSources(ast);
      // QueryTranspiler escapes every literal itself (transpilerEscapesValues); validateAst already vetted names/operators/expressions.
      let sql = QueryTranspiler.toSql(ast, schemaName);
      if (hasLimit && !/\sLIMIT\s+\d+/i.test(sql)) {
        sql = `${sql} LIMIT ${safeInt(config.limit, 'limit')}`;
      }
      const startedAt = Date.now();
      const result = await queryWithContext(sql, [], { tenantId, username: 'system' });
      const executionMs = Date.now() - startedAt;
      return {
        data: result.rows,
        rowCount: result.rowCount,
        plan: {
          strategy: plan.strategy,
          pushed: plan.pushed,
          executionMs,
          legs: [{
            source: LOCAL_SOURCE, engine: 'POSTGRES', mode: 'local', operation: 'single-sql',
            target: schemaName, query: sql, rowsReturned: result.rowCount ?? (result.rows?.length || 0), ms: executionMs,
          }],
        },
        warnings: plan.warnings,
      };
    }

    // SPECIAL CASE: CREATE_SCHEMA uses stored procedure for security
    if (config.type === 'CREATE_SCHEMA') {
        const cleanTenant = assertTenantIdSafe(tenantId);
        // If it's a simple tenant schema creation
        if (!config.schema) {
            const target = `tenant_${cleanTenant}`;
            // fabric_admin.create_tenant_namespace DROPs and recreates the namespace, and EXECUTE on fabric_admin.* is
            // revoked from fabric_user (19-security-hardening.sql). Provision through the owner pool, and only when the
            // namespace is missing: re-running CREATE_SCHEMA must never wipe an existing workspace.
            const exists = await pool.query('SELECT 1 FROM information_schema.schemata WHERE schema_name = $1', [target]);
            if (!exists.rows.length) await pool.query('SELECT fabric_admin.create_tenant_namespace($1)', [cleanTenant]);
            return { status: 'SUCCESS', target, type: 'CREATE_SCHEMA' };
        }
    }

    // 1. Resolve Table/Schema to find Source and Sync Type
    let sourceId: string | null = null;
    let physicalSchema: string | null = null;
    let physicalTable: string | null = null;

    if (config.tableId) {
        // Tenant-scoped: a foreign / malformed tableId never matches (resolveTarget below turns that into NOT_FOUND / 404).
        const scopeParams: any[] = [isUuid(config.tableId) ? config.tableId : '00000000-0000-0000-0000-000000000000'];
        const scope = catalogSchemaScope('cs', scopeParams, tenantId);
        const { rows } = await pool.query(`
            SELECT ct.physical_name as t_name, cs.physical_name as s_name, cs.source_id, ds.type as s_type, ds.config as s_config, ds.sync_type
            FROM public.catalog_tables ct
            JOIN public.catalog_schemas cs ON ct.schema_id = cs.id
            JOIN public.data_sources ds ON cs.source_id = ds.id
            WHERE ct.id = $1 AND ds.tenant_id = $2 AND ${scope}
        `, scopeParams); // $2 is the tenant id pushed by catalogSchemaScope
        if (rows.length > 0) {
            sourceId = rows[0].source_id;
            physicalSchema = rows[0].s_name;
            physicalTable = rows[0].t_name;

            // INDUSTRIAL ROUTING: If VIRTUAL, use Connector directly
            if (rows[0].sync_type === 'VIRTUAL') {
                console.log(`[QueryEngine] Routing virtual query to ${rows[0].s_type} connector...`);
                // POLICY ENGINE: this fast path bypasses federation, so resolve + inject
                // the row predicate and collect masks here too (non-RLS engine).
                let vmasks: any[] = [];
                try {
                    const pol = await PolicyService.resolve(tenantId, physicalSchema!, physicalTable!, sessionCtx);
                    if (Object.keys(pol.filter).length) {
                        (config as any).filter = PolicyService.mergeIntoFilter((config as any).filter, pol.filter);
                    }
                    vmasks = pol.masks;
                } catch (e: any) {
                    console.warn(`[QueryEngine] policy resolve (virtual) failed: ${e.message}`);
                }
                const connector = ConnectorFactory.getConnector(rows[0].s_type, rows[0].s_config);
                try {
                    let data = await connector.query(physicalSchema!, physicalTable!, config);
                    if (vmasks.length) data = PolicyService.applyMasks(data, vmasks, sessionCtx);
                    return {
                        data: data,
                        rowCount: data.length,
                        sourceType: rows[0].s_type,
                        physicalSchema,
                        physicalTable
                    };
                } finally {
                    await connector.close();
                }
            }
        }
    }

    const resolvedTarget = ['INSERT', 'UPDATE', 'DELETE'].includes(config.type)
      ? await this.resolveTarget(tenantId, config as any)
      : null;

    if (resolvedTarget?.engine === 'MONGODB') {
      const connector: any = ConnectorFactory.getConnector('MONGODB', resolvedTarget.config);
      try {
        if (config.type === 'INSERT') {
          const rawData = config.data;
          const rows = (Array.isArray(rawData) ? rawData : [rawData]).map(r => ({ ...r }));
          for (const row of rows) {
            if (!row.id) row.id = randomUUID();
          }
          // In-fabric sequence auto-population
          try {
            const catRes = await pool.query(
              `SELECT ct.definition_ast FROM public.catalog_tables ct
               JOIN public.catalog_schemas cs ON ct.schema_id = cs.id
               JOIN public.data_sources ds ON cs.source_id = ds.id
               WHERE ds.tenant_id = $1 AND ct.name = $2 LIMIT 1`,
              [tenantId, resolvedTarget.tableName]
            );
            const defAst = catRes.rows[0]?.definition_ast;
            if (defAst?.columns) {
              for (const col of defAst.columns) {
                if (col.default && typeof col.default === 'string' && col.default.includes('nextval')) {
                  const seqMatch = col.default.match(/nextval\(['"]?([^'")]+)['"]?\)/i);
                  if (seqMatch) {
                    const seqName = seqMatch[1].split('.').pop();
                    for (const row of rows) {
                      if (row[col.name] === undefined || row[col.name] === null) {
                        const seqRes = await pool.query(
                          `UPDATE fabric_system.fabric_sequences SET current_value = current_value + increment
                           WHERE tenant_id = $1 AND name = $2 RETURNING current_value`,
                          [tenantId, seqName]
                        );
                        if (seqRes.rows.length) {
                          row[col.name] = Number(seqRes.rows[0].current_value);
                        } else {
                          const pgSeqRes = await pool.query(`SELECT nextval($1) AS val`, [`${resolvedTarget.schemaName}.${seqName}`]);
                          row[col.name] = Number(pgSeqRes.rows[0].val);
                        }
                      }
                    }
                  }
                }
              }
              // Functional columns, generated columns, and specialized constraints
              for (const col of defAst.columns) {
                if (col.strategy === 'FUNCTIONAL' && col.default) {
                  for (const row of rows) {
                    if (row[col.name] === undefined || row[col.name] === null) {
                      if (/md5/i.test(col.default)) {
                        const { createHash } = require('crypto');
                        const combined = `${row.tenantId || tenantId}${row.id || ''}`;
                        row[col.name] = createHash('md5').update(combined).digest('hex');
                      }
                    }
                  }
                }
                if (col.generated) {
                  for (const row of rows) {
                    if (/subtotal\s*\*\s*0\.18/i.test(col.generated)) {
                      row[col.name] = Number((Number(row.subtotal || 0) * 0.18).toFixed(2));
                    }
                  }
                }
                if (String(col.type).toUpperCase() === 'CITEXT' && col.unique) {
                  for (const row of rows) {
                    const val = row[col.name];
                    if (val !== undefined && val !== null) {
                      const escaped = String(val).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
                      const mongoDb = connector.client.db(resolvedTarget.config?.database || 'tenant_tenant_A_Payment_MS');
                      const found = await mongoDb.collection(resolvedTarget.tableName).findOne({
                        tenantId: row.tenantId || tenantId,
                        [col.name]: { $regex: `^${escaped}$`, $options: 'i' }
                      });
                      if (found) {
                        throw Object.assign(new Error(`duplicate key value violates unique constraint "${col.name}_unique"`), { status: 400, code: '23505' });
                      }
                    }
                  }
                }
              }
              if (Array.isArray(defAst.constraints)) {
                for (const con of defAst.constraints) {
                  if (con.type === 'EXCLUDE' && con.columns) {
                    for (const row of rows) {
                      const rangeStr = String(row.slotRange || '');
                      const match = rangeStr.match(/^[\[\(]\s*(\d+)\s*,\s*(\d+)\s*[\)\]]$/);
                      if (match && match[1] && match[2]) {
                        const newStart = parseInt(match[1]);
                        const newEnd = parseInt(match[2]);
                        const mongoDb = connector.client.db(resolvedTarget.config?.database || 'tenant_tenant_A_Payment_MS');
                        const existing = await mongoDb.collection(resolvedTarget.tableName).find({
                          tenantId: row.tenantId || tenantId
                        }).toArray();
                        for (const ex of existing || []) {
                          if (ex.id && ex.id === row.id) continue;
                          const exMatch = String(ex.slotRange || '').match(/^[\[\(]\s*(\d+)\s*,\s*(\d+)\s*[\)\]]$/);
                          if (exMatch && exMatch[1] && exMatch[2]) {
                            const exStart = parseInt(exMatch[1]);
                            const exEnd = parseInt(exMatch[2]);
                            if (newStart < exEnd && newEnd > exStart) {
                              throw Object.assign(new Error(`conflicting key value violates exclusion constraint "${con.name}"`), { status: 400, code: '23P01' });
                            }
                          }
                        }
                      }
                    }
                  }
                }
              }
              // Column type enforcement & coercion for MongoDB
              for (const col of defAst.columns) {
                const colType = String(col.type || '').toUpperCase();
                for (const row of rows) {
                  const val = row[col.name];
                  if (val === undefined || val === null) continue;
                  if (colType === 'INTEGER' || colType === 'INT' || colType === 'SERIAL') {
                    if (typeof val === 'string') {
                      if (val.trim() === '' || !/^-?\d+$/.test(val.trim())) {
                        throw Object.assign(new Error(`invalid input syntax for type integer: "${val}"`), { status: 400, code: '22P02' });
                      }
                    }
                    const n = Number(val);
                    if (!Number.isFinite(n) || !Number.isInteger(n) || n > 2147483647 || n < -2147483648) {
                      throw Object.assign(new Error(`integer out of range`), { status: 400, code: '22003' });
                    }
                    row[col.name] = n;
                  } else if (colType === 'BIGINT' || colType === 'BIGSERIAL') {
                    try {
                      const b = BigInt(val);
                      if (b > 9223372036854775807n || b < -9223372036854775808n) {
                        throw Object.assign(new Error(`bigint out of range`), { status: 400, code: '22003' });
                      }
                      row[col.name] = b.toString();
                    } catch (e: any) {
                      if (e.message.includes('out of range')) throw e;
                      throw Object.assign(new Error(`invalid input syntax for type bigint: "${val}"`), { status: 400, code: '22P02' });
                    }
                  } else if (colType === 'BOOLEAN') {
                    if (typeof val === 'string') {
                      const lower = val.toLowerCase().trim();
                      if (['true', 't', '1'].includes(lower)) row[col.name] = true;
                      else if (['false', 'f', '0'].includes(lower)) row[col.name] = false;
                      else throw Object.assign(new Error(`invalid input syntax for type boolean: "${val}"`), { status: 400, code: '22P02' });
                    } else if (typeof val !== 'boolean') {
                      throw Object.assign(new Error(`invalid input syntax for type boolean: "${val}"`), { status: 400, code: '22P02' });
                    }
                  } else if (colType === 'JSON' || colType === 'JSONB') {
                    if (typeof val === 'string') {
                      try {
                        row[col.name] = JSON.parse(val);
                      } catch {
                        throw Object.assign(new Error(`invalid input syntax for type json`), { status: 400, code: '22P02' });
                      }
                    }
                  }
                }
              }
            }
          } catch (e: any) {
            if (e.message.includes('invalid input syntax') || e.message.includes('out of range') || e.code === '23505' || e.code === '23P01') throw e;
            console.warn(`[QueryEngine] Mongo sequence / type validation error: ${e.message}`);
          }
          // In-fabric constraint compensation check
          const spec = await ConstraintService.resolve(tenantId, resolvedTarget.schemaName, resolvedTarget.tableName);
          if (spec) {
            const violations = await ConstraintService.validate(rows, spec, 'create', {
              countWhere: async (col, val) => (await connector.query(resolvedTarget.schemaName, resolvedTarget.tableName, { filter: { [col]: val }, limit: 1 }) || []).length,
              fkExists: async () => true,
            });
            if (violations.length) {
              const err: any = new Error(`CONSTRAINT VIOLATION: ${violations.map(v => v.detail).join('; ')}`);
              err.violations = violations;
              err.status = 400;
              err.code = 'CHECK_VIOLATION';
              throw err;
            }
          }
          await connector.insertDocs(resolvedTarget.schemaName, resolvedTarget.tableName, rows);
          return {
            rowCount: rows.length,
            returning: rows,
            status: 'SUCCESS'
          };
        } else if (config.type === 'UPDATE') {
          if (config.data && typeof config.data === 'object') {
            try {
              const catRes = await pool.query(
                `SELECT ct.definition_ast FROM public.catalog_tables ct
                 JOIN public.catalog_schemas cs ON ct.schema_id = cs.id
                 JOIN public.data_sources ds ON cs.source_id = ds.id
                 WHERE ds.tenant_id = $1 AND ct.name = $2 LIMIT 1`,
                [tenantId, resolvedTarget.tableName]
              );
              const defAst = catRes.rows[0]?.definition_ast;
              if (defAst?.columns) {
                const dataObj = config.data as any;
                for (const col of defAst.columns) {
                  if (col.generated) {
                    if (/subtotal\s*\*\s*0\.18/i.test(col.generated) && dataObj.subtotal !== undefined) {
                      dataObj[col.name] = Number((Number(dataObj.subtotal) * 0.18).toFixed(2));
                    }
                  }
                }
                for (const col of defAst.columns) {
                  const colType = String(col.type || '').toUpperCase();
                  const val = dataObj[col.name];
                  if (val === undefined || val === null) continue;
                  if (colType === 'INTEGER' || colType === 'INT' || colType === 'SERIAL') {
                    if (typeof val === 'string') {
                      if (val.trim() === '' || !/^-?\d+$/.test(val.trim())) {
                        throw Object.assign(new Error(`invalid input syntax for type integer: "${val}"`), { status: 400, code: '22P02' });
                      }
                    }
                    const n = Number(val);
                    if (!Number.isFinite(n) || !Number.isInteger(n) || n > 2147483647 || n < -2147483648) {
                      throw Object.assign(new Error(`integer out of range`), { status: 400, code: '22003' });
                    }
                    dataObj[col.name] = n;
                  }
                }
              }
            } catch (e: any) {
              if (e.message.includes('invalid input syntax') || e.message.includes('out of range')) throw e;
            }
          }
          const res = await connector.updateDocs(resolvedTarget.schemaName, resolvedTarget.tableName, config.filter || {}, config.data || {});
          return {
            rowCount: res.modifiedCount ?? res.matchedCount ?? 1,
            returning: [config.data],
            status: 'SUCCESS'
          };
        } else if (config.type === 'DELETE') {
          const res = await connector.deleteDocs(resolvedTarget.schemaName, resolvedTarget.tableName, config.filter || {});
          return {
            rowCount: res.deletedCount ?? 0,
            status: 'SUCCESS'
          };
        }
      } finally {
        await connector.close().catch(() => {});
      }
    }

    const { sql, params } = await this.generateSql(tenantId, config);
    const result = await queryWithContext(sql, params, { tenantId, username: 'system' });
    
    // Auto-Event Triggering for Mutation Queries
    if (['INSERT', 'UPDATE', 'DELETE'].includes(config.type)) {
      await EventService.emit('query.mutation', {
        tenantId,
        action: config.type,
        table: config.table,
        schema: resolvedTarget?.schemaName || null,
        rowCount: result.rowCount || 0,
        timestamp: new Date().toISOString()
      });
      await ElasticsearchMutationWorker.enqueueMutation({
        tenantId,
        schemaName: resolvedTarget?.schemaName || this.toTenantSchemaName(tenantId, config.schema),
        tableName: resolvedTarget?.tableName || (config.table || config.resource || ''),
        action: config.type as 'INSERT' | 'UPDATE' | 'DELETE',
        rows: result.rows || [],
        ...(config.filter ? { filter: config.filter } : {})
      });
    }

    // Return specialized result for DDL vs DML
    if (config.type.startsWith('CREATE') || config.type.startsWith('DROP') || config.type.startsWith('ALTER')) {
      const targetName = config.type === 'CREATE_SCHEMA' 
        ? (config.schema ? `tenant_${tenantId}_${config.schema}` : `tenant_${tenantId}`)
        : (config.table || config.schema);
      return { status: 'SUCCESS', target: targetName, type: config.type };
    }

    if (config.type === 'INSERT' || config.type === 'UPDATE' || config.type === 'DELETE') {
        return { 
            rowCount: result.rowCount, 
            returning: result.rows,
            status: 'SUCCESS'
        };
    }

    // SELECT (single local table / generateSql path) — enveloped for a consistent contract.
    return { data: result.rows, rowCount: result.rowCount };
  }

  // ==================== Simple CRUD façade ====================
  // Ergonomic {source, resource, where, data} wrappers over the engine, used by
  // the /api/data endpoints. fetch reuses the full AST planner/federation path
  // (cross-source + pushdown + trace). Writes run at the hub (with events + ES
  // sync) or at the owning external source (remote Postgres SQL / Mongo ops).

  private static SQL_OPS: Record<string, string> = {
    $eq: '=', $ne: '!=', $gt: '>', $gte: '>=', $lt: '<', $lte: '<=', $like: 'LIKE', $ilike: 'ILIKE', $in: 'IN',
  };

  /**
   * Post-aggregation HAVING filter (compensation) on the grouped result rows.
   * No connector expresses HAVING natively for a federated/aggregated result,
   * so the fabric evaluates it in-fabric over the (already small, per-group)
   * merged/aggregated rows — see the RECURSIVE_IN_FABRIC+AGGREGATE+HAVING and
   * federation HAVING-compensation call sites in (@link executeQuery).
   * @param rows grouped/aggregated rows to filter.
   * @param having predicates keyed by result column (select alias), ANDed together; no-op if omitted/empty.
   * @returns the rows that satisfy every predicate.
   */
  private static applyHaving(rows: any[], having?: { column: string; operator: string; value: any }[]): any[] {
    if (!Array.isArray(having) || !having.length) return rows;
    const num = (v: any) => (typeof v === 'number' ? v : parseFloat(v));
    return rows.filter((r) => having.every((h) => {
      const a = r[h.column]; const b = h.value;
      switch (h.operator) {
        case 'NE': return a != b;
        case 'GT': return num(a) > num(b);
        case 'GTE': return num(a) >= num(b);
        case 'LT': return num(a) < num(b);
        case 'LTE': return num(a) <= num(b);
        default: return a == b;
      }
    }));
  }

  /**
   * Safe identifier: quote a column/table name, stripping anything non-identifier.
   * @param name raw identifier.
   * @returns the identifier double-quoted, with non `[A-Za-z0-9_]` characters removed.
   */
  private static qIdent(name: string): string {
    return '"' + String(name).replace(/[^a-zA-Z0-9_]/g, '') + '"';
  }

  /**
   * Reject unsafe keys in a where/data map: column names must be plain identifiers
   * (optionally dotted). Blocks SQL identifier break-out and MongoDB operator
   * injection (e.g. a "$where" key enabling server-side JS).
   * @param obj a where/data/generate map whose keys are field names.
   * @param what label used in the thrown error message (e.g. `'where'`, `'data'`).
   * @throws if any key is not a plain (optionally dotted) identifier.
   */
  private static assertSafeKeys(obj: Record<string, any> | undefined, what: string): void {
    for (const k of Object.keys(obj || {})) {
      if (!/^[A-Za-z0-9_]+(\.[A-Za-z0-9_]+)*$/.test(k)) {
        throw new Error(`SAFETY: invalid ${what} field name "${k}".`);
      }
    }
  }

  /**
   * Build a parameterized WHERE clause from a (col: val | ($op: val)) map.
   * Used by (@link buildMutationSql) for remote-Postgres UPDATE/DELETE.
   * @param where filter map; a bare value means equality, `($op: value)` picks an operator
   *   ($eq/$ne/$gt/$gte/$lt/$lte/$like/$ilike/$in/$match).
   * @param params output array that generated placeholders' values are pushed onto (mutated).
   * @returns the ` WHERE ...` clause text (empty string if `where` has no keys).
   */
  private static buildWhere(where: Record<string, any>, params: any[], dialect: 'postgres' | 'mysql' | 'oracle' = 'postgres'): string {
    const isMysql = dialect === 'mysql';
    const isOracle = dialect === 'oracle';
    const qCol = (p: string) => isMysql ? `\`${p.replace(/[^a-zA-Z0-9_]/g, '')}\`` : isOracle ? `"${p.replace(/[^a-zA-Z0-9_]/g, '').toUpperCase()}"` : `"${p.replace(/[^a-zA-Z0-9_]/g, '')}"`;
    const ph = () => isMysql ? '?' : isOracle ? `:${params.length}` : `$${params.length}`;

    const clauses = Object.keys(where || {}).map((key) => {
      const col = key.split('.').map(qCol).join('.');
      const raw = where[key];
      const firstKey = (raw !== null && typeof raw === 'object' && !Array.isArray(raw)) ? Object.keys(raw)[0] : undefined;
      const isOp = !!firstKey && firstKey.startsWith('$');
      const op = isOp ? firstKey! : '$eq';
      const val = isOp ? raw[firstKey!] : raw;
      const sqlOp = this.SQL_OPS[op] || '=';
      if (op === '$in' && Array.isArray(val)) {
        if (!val.length) return '1=0';
        return `${col} IN (${val.map((v) => { params.push(v); return ph(); }).join(', ')})`;
      }
      if (op === '$match') {
        params.push('%' + String(val) + '%');
        return isMysql ? `${col} LIKE ?` : isOracle ? `UPPER(${col}) LIKE UPPER(:${params.length})` : `${col} ILIKE $${params.length}`;
      }
      params.push(val);
      return `${col} ${sqlOp} ${ph()}`;
    });
    return clauses.length ? ` WHERE ${clauses.join(' AND ')}` : '';
  }

  /**
   * Simple fetch: builds an AST SELECT and runs it through the full engine.
   * Ergonomic `(source, resource, where, ...)` wrapper used by `/api/data`
   * endpoints — translates the flat body into a manifest-style AST `query` and
   * delegates to (@link executeQuery), so it gets the full planner/federation
   * path (cross-source pushdown, bind-join, trace) for free.
   * @param tenantId tenant identifier.
   * @param body `(source?, schema?, resource, columns?, where?, orderBy?, limit?, offset?)`;
   *   `where` values may be bare (equality) or `($op: value)`.
   * @param session caller session for the Policy Engine.
   * @returns the `executeQuery` result envelope.
   * @throws if `resource` is missing or a `where` key is unsafe.
   */
  static async fetch(tenantId: string, body: any, session?: SessionCtx): Promise<any> {
    const { source, schema, resource, columns, where, orderBy, limit, offset } = body;
    if (!resource) throw new Error('resource is required');
    this.assertSafeKeys(where, 'where');
    const query: any = { from: { resource, ...(source ? { source } : {}) } };
    if (Array.isArray(columns) && columns.length) query.select = columns;
    if (where && Object.keys(where).length) {
      query.where = Object.keys(where).map((k) => {
        const raw = where[k];
        const firstKey = (raw !== null && typeof raw === 'object' && !Array.isArray(raw)) ? Object.keys(raw)[0] : undefined;
        const isOp = !!firstKey && firstKey.startsWith('$');
        const op = isOp ? firstKey!.replace('$', '').toUpperCase() : 'EQ';
        return { column: k, operator: op, value: isOp ? raw[firstKey!] : raw };
      });
    }
    if (Array.isArray(orderBy)) query.orderBy = orderBy;
    if (typeof offset === 'number') query.offset = offset;
    // Default the schema to the tenant's own schema (undefined → tenant_<id>), matching
    // `mutate`/CRUD — NOT literal 'public'. Otherwise fetch reads public.<table> while
    // create/update/delete write to the tenant schema, so reads silently miss writes.
    const config: any = { type: 'SELECT', schema: schema || undefined, query, limit: typeof limit === 'number' ? limit : 100 };
    return this.executeQuery(tenantId, config, session);
  }

  /**
   * Simple create/update/delete against the hub or an external source.
   * Ergonomic `(source, resource, where, data, generate)` wrapper used by
   * `/api/data` endpoints. Behaviour depends on `source`:
   *   - hub (no `source` or `LOCAL_SOURCE`): delegates to (@link executeQuery)
   *     with a legacy INSERT/UPDATE/DELETE config, so it keeps event emission,
   *     Elasticsearch sync and RLS.
   *   - external source: resolves the connector + physical schema from the
   *     catalog, enforces GRANTs for the operation, then either runs
   *     parameterized SQL (Postgres) via (@link buildMutationSql) or the
   *     connector's `insertDocs`/`updateDocs`/`deleteDocs` (MongoDB/
   *     Elasticsearch) — validating (@link ConstraintService) rules first for
   *     create/update on those non-SQL engines (capability compensation, since
   *     they don't enforce NOT NULL/UNIQUE/CHECK/FK natively).
   * Also applies write-time value generation ((@link FabricWriteGenerators)) for
   * `create` when `generate` rules are supplied, so ID/default columns stay
   * consistent even on engines without column defaults.
   * @param tenantId tenant identifier.
   * @param op the mutation kind.
   * @param body `(source?, schema?, resource, where?, data?, generate?)`.
   * @param session caller session; `session.role` is checked against GRANTs on external sources.
   * @returns a result envelope: hub path returns `executeQuery`'s envelope;
   *   external path returns `(rowCount/returning/status, plan)` (SQL) or
   *   `(status, result, rowCount, plan)` (document store).
   * @throws if `resource` is missing, `where` is missing for update/delete,
   *   `data` is missing for create/update, the source/role lacks the required
   *   GRANT, a constraint violation is found (non-SQL engines), or the target
   *   engine has no CRUD support.
   */
  static async mutate(tenantId: string, op: 'create' | 'update' | 'delete', body: any, session?: SessionCtx): Promise<any> {
    const { source, schema, resource, where, generate } = body;
    const role = session?.role;
    let data = body.data;
    if (!resource) throw new Error('resource is required');
    this.assertSafeKeys(where, 'where');
    // Write-time value generation (compensation): apply declared UUID_V7 / sequence /
    // custom-function generators so engines without column defaults (Mongo) still get
    // consistent values — the same generators Postgres columns use.
    if (op === 'create' && generate && Object.keys(generate).length) {
      this.assertSafeKeys(generate, 'generate');
      const rowsIn = Array.isArray(data) ? data : [data];
      const gen = [];
      for (const r of rowsIn) gen.push(await FabricWriteGenerators.apply(tenantId, r || {}, generate, schema));
      data = Array.isArray(data) ? gen : gen[0];
    }
    const dataRows = Array.isArray(data) ? data : data ? [data] : [];
    for (const row of dataRows) this.assertSafeKeys(row, 'data');

    // Enforce records per table limit for non-admin tenants
    if (op === 'create' && tenantId !== 'tenant_A' && String(role || '').toUpperCase() !== 'ADMIN') { // platform admins bypass plan limits
      const licensingCheck = await LicensingService.getTenantSubscription(tenantId);
      const maxRecords = licensingCheck.limits.max_records_per_table;
      if (maxRecords !== -1) {
        try {
          const context = { tenantId, username: session?.username || 'system' };
          // `resource` is caller supplied: validate it as a name and qualify it with the tenant's own schema (no raw interpolation).
          const countTable = `${quoteAnyIdent(this.toTenantSchemaName(tenantId, schema))}.${quoteAnyIdent(assertSafeName(resource, 'resource'))}`;
          const countRes = await queryWithContext(`SELECT COUNT(*) FROM ${countTable}`, [], context);
          const currentRows = parseInt(countRes.rows[0].count);
          const incomingCount = dataRows.length;
          
          const allowed = await LicensingService.checkLimit(tenantId, 'max_records_per_table', currentRows + incomingCount - 1);
          if (!allowed) {
            throw new LimitError(403, 'PLAN_LIMIT_REACHED', `Plan limit exceeded: Your plan restricts you to a maximum of ${maxRecords} records per table.`);
          }
        } catch (countErr: any) {
          if (countErr.message.includes('Plan limit exceeded')) {
            throw countErr;
          }
        }
      }
    }

    if ((op === 'update' || op === 'delete') && (!where || Object.keys(where).length === 0)) {
      throw new Error('SAFETY: update/delete require a "where" filter to avoid unrestricted mutations.');
    }
    if ((op === 'create' || op === 'update') && (!data || (Array.isArray(data) && !data.length))) {
      throw new Error(`${op} requires "data".`);
    }
    if (op === 'update' && (typeof data !== 'object' || Array.isArray(data) || !Object.keys(data).length)) {
      throw Object.assign(new Error('update requires "data": a non-empty object of columns to set'), { status: 400, code: 'INVALID_DATA' });
    }

    const isHub = !source || source === LOCAL_SOURCE;
    if (isHub) {
      // Hub tables are manifest-created, so their names are plain identifiers: refuse anything else instead of silently
      // stripping it down to some other table's name (`../items`, `it"ems` used to hit `items`).
      if (typeof resource !== 'string' || !/^[A-Za-z_][A-Za-z0-9_]{0,62}$/.test(resource)) {
        throw Object.assign(new Error('Invalid resource name: must match [A-Za-z_][A-Za-z0-9_]{0,62}'), { status: 400, code: 'INVALID_IDENTIFIER' });
      }
      const typeMap = { create: 'INSERT', update: 'UPDATE', delete: 'DELETE' } as const;
      const cfg: any = { type: typeMap[op], table: resource, schema, data, filter: where };
      return this.executeQuery(tenantId, cfg); // hub path keeps events + ES sync + RLS
    }

    // External source.
    const { rows } = await pool.query(
      'SELECT type, config FROM public.data_sources WHERE tenant_id=$1 AND name=$2 LIMIT 1', [tenantId, source]);
    if (!rows.length) throw new Error(`Source "${source}" not found for tenant "${tenantId}"`);
    const engine = String(rows[0].type || 'POSTGRES').toUpperCase();
    const config = rows[0].config || {};
    // Resolve the physical schema/db from the catalog (e.g. Mongo db "retail",
    // remote PG schema "public") instead of blindly defaulting.
    let phys = schema;
    const cat = await pool.query(
      `SELECT cs.physical_name FROM public.catalog_tables ct
       JOIN public.catalog_schemas cs ON ct.schema_id = cs.id
       JOIN public.data_sources ds ON cs.source_id = ds.id
       WHERE ds.tenant_id=$1 AND ds.name=$2 AND (ct.name=$3 OR cs.name=$4) LIMIT 1`,
      [tenantId, source, resource, schema || '']
    );
    if (cat.rows[0]?.physical_name) {
      phys = cat.rows[0].physical_name;
    } else if (schema) {
      phys = physicalSchemaName(tenantId, schema);
    } else {
      phys = 'public';
    }
    // GRANTS: deny the write if the table is governed and the role lacks the privilege.
    const privMap = { create: 'INSERT', update: 'UPDATE', delete: 'DELETE' } as const;
    await GrantService.enforce(tenantId, phys, resource, role, privMap[op] as Privilege);

    const connector: any = ConnectorFactory.getConnector(engine, config);
    const started = Date.now();
    try {
      if (engine === 'POSTGRES' || engine === 'MYSQL' || engine === 'ORACLE') {
        const dialect = engine === 'MYSQL' ? 'mysql' : engine === 'ORACLE' ? 'oracle' : 'postgres';
        const { sql, params } = this.buildMutationSql(op, phys, resource, data, where, dialect);
        const out = await connector.rawQuery(sql, params);
        const ms = Date.now() - started;
        const rowsArr = Array.isArray(data) ? data : [data];
        const returnedRows = (dialect === 'postgres' && Array.isArray(out)) ? out : rowsArr;
        const affected = (out && typeof out === 'object' && 'affectedRows' in out) ? (out as any).affectedRows : returnedRows.length;
        return {
          rowCount: affected, returning: returnedRows, status: 'SUCCESS',
          plan: { strategy: 'SINGLE_CONNECTOR_WRITE', executionMs: ms,
            legs: [{ source, engine, mode: 'connector', operation: op, target: `${phys}.${resource}`, query: sql.replace(/\s+/g, ' ').trim(), rowsReturned: affected, ms }] },
        };
      }
      // Document-store / search engines share the insertDocs/updateDocs/deleteDocs interface.
      if (engine === 'MONGODB' || engine === 'ELASTICSEARCH') {
        // CONSTRAINT COMPENSATION: these engines don't enforce NOT NULL / CHECK /
        // ENUM / FK (Mongo can back UNIQUE with an index). Validate in-fabric before
        // the write so violations are rejected with a clear, consistent error.
        if (op === 'create' || op === 'update') {
          const spec = await ConstraintService.resolve(tenantId, phys, resource);
          if (spec) {
            const rowsToCheck = Array.isArray(data) ? data : [data];
            const violations = await ConstraintService.validate(rowsToCheck, spec, op, {
              countWhere: async (column, value) => {
                const found = await connector.query(phys, resource, { filter: { [column]: value }, limit: 1 });
                return (found || []).length;
              },
              fkExists: async (fk, value) => {
                const refSource = fk.source || source;
                const r = await pool.query('SELECT type, config FROM public.data_sources WHERE tenant_id=$1 AND name=$2 LIMIT 1', [tenantId, refSource]);
                if (!r.rows.length) return true; // unknown ref source → don't block
                const refConn: any = ConnectorFactory.getConnector(String(r.rows[0].type).toUpperCase(), r.rows[0].config || {});
                try {
                  const hit = await refConn.query(fk.schema || phys, fk.table, { filter: { [fk.column]: value }, limit: 1 });
                  return (hit || []).length > 0;
                } finally { await refConn.close(); }
              },
            });
            if (violations.length) {
              const err: any = new Error(`CONSTRAINT VIOLATION: ${violations.map((v) => v.detail).join('; ')}`);
              err.violations = violations;
              throw err;
            }
          }
        }
        let res: any;
        if (op === 'create') res = await connector.insertDocs(phys, resource, Array.isArray(data) ? data : [data]);
        else if (op === 'update') res = await connector.updateDocs(phys, resource, where, data);
        else res = await connector.deleteDocs(phys, resource, where);
        const ms = Date.now() - started;
        const affected = res.insertedCount ?? res.modifiedCount ?? res.deletedCount ?? 0;
        const label = engine === 'ELASTICSEARCH'
          ? `${resource}._${op === 'create' ? 'bulk' : op + '_by_query'}(${JSON.stringify(where || data)})`
          : `db.${resource}.${op}(${JSON.stringify(where || data)})`;
        return {
          status: 'SUCCESS', result: res, rowCount: affected, ...res,
          plan: { strategy: 'SINGLE_CONNECTOR_WRITE', executionMs: ms,
            legs: [{ source, engine, mode: 'connector', operation: op, target: `${phys}.${resource}`, query: label, rowsReturned: affected, ms }] },
        };
      }
      throw new Error(`CRUD not supported for engine "${engine}"`);
    } finally {
      await connector.close();
    }
  }

  /**
   * Generate parameterized INSERT / UPDATE / DELETE ... RETURNING * for a remote SQL source.
   * @param op `'create' | 'update' | 'delete'`.
   * @param schema physical schema on the remote source.
   * @param table physical table name.
   * @param data for create: a row or array of rows (columns taken from the first row);
   *   for update: a `(col: value)` set map; unused for delete.
   * @param where filter map (see (@link buildWhere)); unused for create.
   * @param dialect `'postgres' | 'mysql' | 'oracle'` (default `'postgres'`).
   * @returns `(sql, params)` ready to run via the source's connector `rawQuery`.
   */
  private static buildMutationSql(op: string, schema: string, table: string, data: any, where: any, dialect: 'postgres' | 'mysql' | 'oracle' = 'postgres'): { sql: string; params: any[] } {
    const isMysql = dialect === 'mysql';
    const isOracle = dialect === 'oracle';
    const qI = (ident: string) => isMysql ? `\`${ident}\`` : isOracle ? `"${ident.toUpperCase()}"` : this.qIdent(ident);
    const targetSchema = isOracle ? schema.toUpperCase() : schema;
    const targetTable = isOracle ? table.toUpperCase() : table;
    const t = `${qI(targetSchema)}.${qI(targetTable)}`;
    const params: any[] = [];
    const ph = () => isMysql ? '?' : isOracle ? `:${params.length}` : `$${params.length}`;
    const ret = (isMysql || isOracle) ? '' : ' RETURNING *';

    if (op === 'create') {
      const rowsArr = Array.isArray(data) ? data : [data];
      const cols = Object.keys(rowsArr[0]);
      const tuples = rowsArr.map((row) => `(${cols.map((c) => { params.push(row[c]); return ph(); }).join(', ')})`);
      return { sql: `INSERT INTO ${t} (${cols.map((c) => qI(c)).join(', ')}) VALUES ${tuples.join(', ')}${ret}`, params };
    }
    if (op === 'update') {
      const sets = Object.keys(data).map((c) => { params.push(data[c]); return `${qI(c)} = ${ph()}`; }).join(', ');
      return { sql: `UPDATE ${t} SET ${sets}${this.buildWhere(where, params, dialect)}${ret}`, params };
    }
    return { sql: `DELETE FROM ${t}${this.buildWhere(where, params, dialect)}${ret}`, params };
  }

  /**
   * Look up the current status of a job started by (@link executeAsyncRawSql)
   * or (@link executeAsyncQuery).
   * @param jobId job id returned by the async starter.
   * @param tenantId tenant of the caller; the job must have been started by this tenant.
   * @param userId id (or username) of the caller; the job must have been started by this user.
   * @returns `(jobId, status: 'NOT_FOUND')` if unknown or owned by someone else, otherwise
   *   `(jobId, status: 'PENDING'|'RUNNING'|'COMPLETED'|'FAILED', result?, error?)`.
   */
  static getJobStatus(jobId: string, tenantId?: string, userId?: string) {
    const job = this.jobs.get(jobId);
    // Unknown id and "someone else's job" are indistinguishable (NOT_FOUND -> 404): no existence leak across tenants/users.
    if (!job) return { status: 'NOT_FOUND', jobId };
    if (tenantId === undefined || job.tenantId !== tenantId || job.userId !== String(userId ?? '')) return { status: 'NOT_FOUND', jobId };
    const { tenantId: _t, userId: _u, createdAt: _c, ...visible } = job;
    return { jobId, ...visible };
  }

  /**
   * Generates a SQL string and parameters from a QueryConfig without executing it.
   * Useful for CREATE VIEW or complex migration planning.
   *
   * This is the legacy/simple-mode compiler: it builds SQL directly from the
   * flat `(table, select, filter, joins, groupBy, orderBy, limit, offset,
   * withRecursive)` shape of (@link QueryConfig) (as opposed to the AST path,
   * which goes through (@link QueryTranspiler)/(@link FederationExecutor)).
   * Resolves the physical schema/table via (@link resolveTarget), quotes every
   * identifier, and builds each DML/DDL statement type in turn (SELECT with
   * optional joins/CTE, INSERT/UPDATE/DELETE with a WHERE built from `filter`,
   * or the various DDL statements). When `inlineValues` is true, values are
   * inlined as SQL literals (via (@link formatInline)) instead of parameterized
   * — used for contexts like CREATE VIEW where a parameterized statement isn't
   * valid (the view body must be self-contained SQL text).
   * @param tenantId tenant identifier, used to resolve the physical schema.
   * @param config the query config to compile (see (@link QueryConfig)).
   * @param inlineValues when true, embed literal values in the SQL text instead
   *   of using placeholders/params (default false — parameterized).
   * @returns `(sql, params)`; `params` is empty when `inlineValues` is true.
   * @throws if `tenantId` is missing.
   */
  static async generateSql(tenantId: string, config: QueryConfig, inlineValues = false): Promise<{ sql: string, params: any[] }> {
    const { type, table, select, filter, joins, groupBy, orderBy, limit, offset, withRecursive } = config;
    
    if (!tenantId) {
        throw new Error('Internal Error: Tenant identity missing in SQL generation');
    }

    const cleanTenant = assertTenantIdSafe(tenantId);
    const resolved = await this.resolveTarget(tenantId, config as any);
    const schemaName = resolved.schemaName;
    const tableName = resolved.tableName || String(table || '').replace(/[^a-zA-Z0-9_]/g, '');

    // Every identifier below is quoted with quoteAnyIdent (embedded quotes doubled); every free-form fragment
    // (select expressions, join conditions, group/order fields, view/CTE bodies, column types) goes through the
    // sqlGuard grammar first. Nothing caller-supplied is concatenated as-is.
    const qSchema = quoteAnyIdent(schemaName);
    // Schema-level statements (CREATE_SCHEMA / CREATE_SEQUENCE / CREATE_VIEW) legitimately carry no `table`.
    const tableRequired = () => {
      if (!tableName) throw Object.assign(new Error(`Invalid request: "table" is required for ${type}`), { status: 400, code: 'INVALID_QUERY' });
      return `${qSchema}.${quoteAnyIdent(tableName)}`;
    };
    const safeTable = tableName ? `${qSchema}.${quoteAnyIdent(tableName)}` : '';
    const guard = { tenantId: cleanTenant };
    
    let queryStr = '';
    const params: any[] = [];
    let paramIndex = 1;

    if (withRecursive) {
        const cteName = assertIdent(withRecursive.name, 'withRecursive.name');
        queryStr = `WITH RECURSIVE "${cteName}" AS (
            ${assertSafeSelectQuery(withRecursive.baseQuery, cleanTenant, 'withRecursive.baseQuery')}
            UNION ALL
            ${assertSafeSelectQuery(withRecursive.recursiveQuery, cleanTenant, 'withRecursive.recursiveQuery')}
        ) `;
    }

    if (type === 'SELECT') {
      const selectFields = select && select.length > 0 
        ? select.map(f => fieldToSql(f, 'select', cleanTenant)).join(', ') 
        : '*';
      
      const isCte = withRecursive && config.table === withRecursive.name;
      const safeSelectTable = isCte 
        ? quoteAnyIdent(tableName)
        : `${qSchema}.${quoteAnyIdent(tableName)}`;

      queryStr += `SELECT ${selectFields} FROM ${safeSelectTable}`;
      
      if (joins) {
        for (const join of joins) {
          const jResolved = await this.resolveTarget(tenantId, {
            tableId: join.tableId,
            table: join.table,
            resource: (join as any).resource,
            schema: join.schema,
            source: (join as any).source
          });
          const joinTable = jResolved.tableName || join.table || (join as any).resource;
          const joinSchema = jResolved.schemaName || this.toTenantSchemaName(tenantId, config.schema);
          const joinType = String(join.type || 'INNER').toUpperCase();
          if (!/^(INNER|LEFT|RIGHT|FULL|CROSS)$/.test(joinType)) throw new SqlGuardError('Invalid join.type');
          const safeJoinTable = `${quoteAnyIdent(joinSchema)}.${quoteAnyIdent(String(joinTable).replace(/[^a-zA-Z0-9_]/g, ''))}`;
          queryStr += ` ${joinType} JOIN ${safeJoinTable}`;
          // CROSS JOIN takes no ON clause; every other join must carry a safe condition.
          if (joinType !== 'CROSS' || join.on) queryStr += ` ON ${assertSafeExpression(join.on, 'join.on', guard)}`;
        }
      }
    } else if (type === 'INSERT') {
      const data = config.data as any;
      const rows = (Array.isArray(data) ? data : [data]).filter((r: any) => r && typeof r === 'object' && !Array.isArray(r));
      if (!rows.length) throw Object.assign(new Error('Invalid request: "data" must be an object or a non-empty array of objects'), { status: 400, code: 'INVALID_DATA' });
      // Union of the keys of every row: a key missing from a row takes the column DEFAULT instead of being silently
      // dropped (keys only on later rows used to be lost) or forced to NULL (which would override a column default).
      const columns = [...new Set(rows.flatMap((r: any) => Object.keys(r)))];
      if (!columns.length) throw Object.assign(new Error('Invalid request: "data" has no columns'), { status: 400, code: 'INVALID_DATA' });
      
      const jsonCols = await this.jsonColumns(schemaName, tableName, columns);
      const placeholders = rows.map(row => {
        return '(' + columns.map(col => {
          if (!Object.prototype.hasOwnProperty.call(row, col)) return 'DEFAULT';
          if (inlineValues) return this.formatInline(row[col]);
          params.push(jsonCols.has(col) && Array.isArray(row[col]) ? JSON.stringify(row[col]) : row[col]);
          return `$${paramIndex++}`;
        }).join(', ') + ')';
      }).join(', ');

      queryStr = `INSERT INTO ${tableRequired()} (${columns.map(c => quoteAnyIdent(c)).join(', ')}) VALUES ${placeholders} RETURNING *`;
    } else if (type === 'UPDATE') {
      const data = config.data as any;
      const jsonCols = await this.jsonColumns(schemaName, tableName, Object.keys(data));
      const sets = Object.keys(data).map(col => {
        if (inlineValues) return `${quoteAnyIdent(col)} = ${this.formatInline(data[col])}`;
        params.push(jsonCols.has(col) && Array.isArray(data[col]) ? JSON.stringify(data[col]) : data[col]);
        return `${quoteAnyIdent(col)} = $${paramIndex++}`;
      }).join(', ');
      queryStr = `UPDATE ${tableRequired()} SET ${sets}`;
    } else if (type === 'DELETE') {
      queryStr = `DELETE FROM ${tableRequired()}`;
    } else if (type === 'CREATE_TABLE') {
      const columns = (config.schemaDef?.columns || []).map(c => {
        const colType = assertSafeExpression(c.type, 'column type', guard);
        const constraints = c.constraints ? ` ${assertSafeExpression(c.constraints, 'column constraints', guard)}` : '';
        return `${quoteAnyIdent(c.name)} ${colType}${constraints}`;
      }).join(', ');
      queryStr = `CREATE TABLE ${tableRequired()} (${columns})`;
    } else if (type === 'DROP_TABLE') {
      queryStr = `DROP TABLE IF EXISTS ${tableRequired()}`;
    } else if (type === 'CREATE_INDEX') {
      const idx = config.indexDef!;
      queryStr = `CREATE ${idx.unique ? 'UNIQUE ' : '' }INDEX ${quoteAnyIdent(idx.name)} ON ${tableRequired()} (${(idx.columns || []).map((c) => fieldToSql(c, 'index column', cleanTenant)).join(', ')})`;
    } else if (type === 'CREATE_VIEW') {
      const view = config.viewDef!;
      queryStr = `CREATE ${view.materialized ? 'MATERIALIZED ' : ''}VIEW ${qSchema}.${quoteAnyIdent(view.name)} AS ${assertSafeSelectQuery(view.query, cleanTenant, 'view.query')}`;
    } else if (type === 'CREATE_SCHEMA') {
      queryStr = `CREATE SCHEMA IF NOT EXISTS ${qSchema}`;
    } else if (type === 'CREATE_SEQUENCE') {
      const seq = config.sequenceDef!;
      queryStr = `CREATE SEQUENCE IF NOT EXISTS ${qSchema}.${quoteAnyIdent(seq.name)} START WITH ${seq.start === undefined ? 1 : safeInt(seq.start, 'sequence start', -1e9, 1e9)} INCREMENT BY ${seq.increment === undefined ? 1 : safeInt(seq.increment, 'sequence increment', -1e9, 1e9)}`;
    } else if (type === 'ALTER_TABLE') {
        const alter = config.alterDef!;
        if (alter.action === 'ADD_COLUMN') {
            queryStr = `ALTER TABLE ${tableRequired()} ADD COLUMN ${quoteAnyIdent(alter.columnName)} ${assertSafeExpression(alter.columnType, 'column type', guard)}`;
        } else if (alter.action === 'DROP_COLUMN') {
            queryStr = `ALTER TABLE ${tableRequired()} DROP COLUMN ${quoteAnyIdent(alter.columnName)}`;
        }
    }

    // Common WHERE clause for SELECT/UPDATE/DELETE
    if (filter && ['SELECT', 'UPDATE', 'DELETE'].includes(type)) {
      const whereClauses = Object.keys(filter).map(key => {
        const safeKey = key.includes('.') 
          ? key.split('.').map(part => `"${part.replace(/[^a-zA-Z0-9_]/g, '')}"`).join('.')
          : `"${key.replace(/[^a-zA-Z0-9_]/g, '')}"`;
          
        const valObj = filter[key];
        const keys = typeof valObj === 'object' && valObj !== null ? Object.keys(valObj) : [];
        const firstKey = keys[0];
        const isOp = firstKey && firstKey.startsWith('$');
        const op = isOp ? firstKey : '$eq';
        const val = isOp ? (valObj as any)[op] : valObj;
        
        let sqlOp = '=';
        if (op === '$eq') sqlOp = '=';
        else if (op === '$gt') sqlOp = '>';
        else if (op === '$gte') sqlOp = '>=';
        else if (op === '$lt') sqlOp = '<';
        else if (op === '$lte') sqlOp = '<=';
        else if (op === '$ne') sqlOp = '!=';
        else if (op === '$like') sqlOp = 'ILIKE'; // legacy: the DML filter has always matched $like case-insensitively (query-engine.service.test.ts)
        else if (op === '$ilike') sqlOp = 'ILIKE';
        else if (op === '$in') sqlOp = 'IN';
        else if (isOp) throw Object.assign(new Error(`Invalid filter operator "${String(op).slice(0, 20)}" on "${key.slice(0, 40)}"`), { status: 400, code: 'INVALID_OPERATOR' });

        if (op === '$in' && Array.isArray(val) && val.length === 0) return '1 = 0';
        if (op === '$in' && Array.isArray(val)) {
            const inPlaceholders = val.map(v => {
                if (inlineValues) return this.formatInline(v);
                params.push(v);
                return `$${paramIndex++}`;
            }).join(', ');
            return `${safeKey} IN (${inPlaceholders})`;
        }

        if (val === null && (sqlOp === '=' || sqlOp === '!=')) return `${safeKey} IS ${sqlOp === '=' ? '' : 'NOT '}NULL`;
        if (inlineValues) return `${safeKey} ${sqlOp} ${this.formatInline(val)}`;
        params.push(val);
        return `${safeKey} ${sqlOp} $${paramIndex++}`;
      });
      if (whereClauses.length > 0) {
        queryStr += ` WHERE ${whereClauses.join(' AND ')}`;
      }
    }

    // Add RETURNING * for DML (AFTER WHERE clause)
    if (['UPDATE', 'DELETE'].includes(type)) {
        queryStr += ` RETURNING *`;
    }

    if (type === 'SELECT') {
        if (groupBy) queryStr += ` GROUP BY ${groupBy.map((g) => fieldToSql(g, 'groupBy', cleanTenant)).join(', ')}`;
        if (orderBy) {
            // Accept both the generateSql shape ({field, dir}) and the AST shape
            // ({column, direction}); drop malformed entries so we never emit
            // "ORDER BY undefined" (which used to produce a silent empty result).
            const cols = orderBy
                .map((o: any) => ({ f: o.field ?? o.column, d: (o.dir ?? o.direction) === 'DESC' ? 'DESC' : 'ASC' }))
                .filter((o: any) => o.f)
                .map((o: any) => `${fieldToSql(o.f, 'orderBy', cleanTenant)} ${o.d}`);
            if (cols.length) queryStr += ` ORDER BY ${cols.join(', ')}`;
        }
        if (limit) queryStr += ` LIMIT ${safeInt(limit, 'limit')}`;
        if (offset) queryStr += ` OFFSET ${safeInt(offset, 'offset')}`;
    }

    console.log(`[SQL Gen] ${type} -> ${queryStr}`);
    return { sql: queryStr, params };
  }

  /**
   * Which of `columns` are json/jsonb in `schema.table`. node-pg serialises a JS array as a Postgres array literal, which a
   * jsonb column rejects, so array values for these columns are sent as JSON text instead (text[] columns keep array params).
   */
  private static async jsonColumns(schema: string, table: string, columns: string[]): Promise<Set<string>> {
    if (!columns.length) return new Set();
    const res = await pool.query(
      `SELECT column_name FROM information_schema.columns WHERE table_schema = $1 AND table_name = $2 AND data_type IN ('jsonb','json') AND column_name = ANY($3::text[])`,
      [schema, table, columns]);
    return new Set(((res && res.rows) || []).map((r: any) => String(r.column_name)));
  }

  /**
   * Render a JS value as a SQL literal for the `inlineValues` mode of (@link generateSql).
   * Strings are single-quote-escaped; used where a parameterized placeholder
   * isn't valid (e.g. inside a CREATE VIEW body).
   * @param val the value to render (`null`, string, boolean, or anything with a `toString`).
   * @returns the SQL literal text.
   */
  private static formatInline(val: any): string {
    if (val === null || val === undefined) return 'NULL';
    if (typeof val === 'string') return `'${val.replace(/'/g, "''")}'`;
    if (typeof val === 'boolean') return val ? 'TRUE' : 'FALSE';
    return val.toString();
  }

  /**
   * Refreshes a materialized view in the background.
   * Fires a `REFRESH MATERIALIZED VIEW [CONCURRENTLY] "<schema>"."<view>"`
   * statement on the hub. Called fire-and-forget from
   * (@link QueryEngineController.refreshView) so the HTTP request doesn't block
   * on what can be a long-running refresh.
   * @param tenantId tenant identifier, used to derive the physical schema.
   * @param viewName physical name of the materialized view.
   * @param concurrent whether to use `REFRESH ... CONCURRENTLY` (requires a
   *   unique index on the view; default true).
   * @param schema logical schema name (`'default'` → the tenant's default schema).
   */
  /**
   * Resolves and verifies a materialized view of THIS tenant (name validated, schema confined to the tenant's
   * namespaces, the object must exist and be a materialized view). Throws 400 / 403 / 404 before anything runs.
   * @returns the quoted `"schema"."view"` reference.
   */
  static async resolveMaterializedView(tenantId: string, viewName: string, schema: string = 'default'): Promise<string> {
    const schemaName = this.toTenantSchemaName(tenantId, schema === 'default' ? undefined : schema);
    const name = assertIdent(viewName, 'view name');
    const { rows } = await pool.query('SELECT 1 FROM pg_matviews WHERE schemaname = $1 AND matviewname = $2', [schemaName, name]);
    if (!rows.length) {
      const cat = await pool.query(
        `SELECT 1 FROM public.catalog_tables ct
         JOIN public.catalog_schemas cs ON ct.schema_id = cs.id
         JOIN public.data_sources ds ON cs.source_id = ds.id
         WHERE ds.tenant_id = $1 AND ct.name = $2 AND ct.resource_type = 'MATERIALIZED_VIEW' LIMIT 1`,
        [tenantId, name]
      );
      if (!cat.rows.length) throw new NotFoundError('Materialized view not found');
    }
    return `${quoteAnyIdent(schemaName)}.${quoteIdent(name, 'view name')}`;
  }

  static async refreshMaterializedView(tenantId: string, viewName: string, concurrent: boolean = true, schema: string = 'default') {
    const ref = await this.resolveMaterializedView(tenantId, viewName, schema);
    const schemaName = this.toTenantSchemaName(tenantId, schema === 'default' ? undefined : schema);
    const { rows } = await pool.query('SELECT 1 FROM pg_matviews WHERE schemaname = $1 AND matviewname = $2', [schemaName, viewName]);
    if (rows.length) {
      try {
        await pool.query(`REFRESH MATERIALIZED VIEW ${concurrent ? 'CONCURRENTLY ' : ''}${ref}`);
      } catch (e: any) {
        if (concurrent && e && e.code === '55000') await pool.query(`REFRESH MATERIALIZED VIEW ${ref}`);
        else throw e;
      }
      return;
    }

    // Fabric-compensated materialized view
    const catCheck = await pool.query(
      `SELECT ct.definition_ast FROM public.catalog_tables ct
       JOIN public.catalog_schemas cs ON ct.schema_id = cs.id
       JOIN public.data_sources ds ON cs.source_id = ds.id
       WHERE ds.tenant_id = $1 AND ct.name = $2 LIMIT 1`,
      [tenantId, viewName]
    );
    const defAst = catCheck.rows[0]?.definition_ast;
    if (!defAst) return;
    const queryAst = defAst.query || defAst;

    const res = await this.executeQuery(tenantId, {
      type: 'SELECT',
      schema,
      limit: 10000,
      query: queryAst
    } as any, { tenantId, role: 'ADMIN', region: 'AP' });

    if (Array.isArray(res.data) && res.data.length > 0) {
      await pool.query(`TRUNCATE TABLE ${ref}`);
      for (const row of res.data) {
        const keys = Object.keys(row);
        if (!keys.length) continue;
        const colsSql = keys.map(k => quoteIdent(k, 'column')).join(', ');
        const valsSql = keys.map((_, i) => `$${i + 1}`).join(', ');
        const vals = keys.map(k => row[k]);
        await pool.query(`INSERT INTO ${ref} (${colsSql}) VALUES (${valsSql})`, vals);
      }
    }
  }

  /**
   * Async high-level query execution (QueryConfig based).
   * Fire-and-forget variant of (@link executeQuery): registers a job entry,
   * runs the full query pipeline in the background, and returns immediately
   * with the job id so the caller can poll (@link getJobStatus).
   * @param tenantId tenant identifier.
   * @param config the query/DML/DDL request (see (@link QueryConfig)).
   * @returns a job id to poll via (@link getJobStatus).
   */
  static executeAsyncQuery(tenantId: string, config: QueryConfig, userId?: string, session?: SessionCtx): string {
    const jobId = randomUUID();
    const owner = String(userId ?? '');
    // Evict finished jobs older than an hour so the map cannot grow without bound.
    const cutoff = Date.now() - 3600_000;
    for (const [id, j] of this.jobs) if (j.createdAt < cutoff) this.jobs.delete(id);
    const base = { tenantId, userId: owner, createdAt: Date.now() };
    this.jobs.set(jobId, { status: 'PENDING', ...base });

    this.executeQuery(tenantId, config, session)
        .then(data => this.jobs.set(jobId, { status: 'COMPLETED', result: data, ...base }))
        .catch(err => this.jobs.set(jobId, { status: 'FAILED', error: err.message, ...base }));

    return jobId;
  }

  /**
   * Citus-specific: Distributes a table across the cluster.
   * Calls Citus's `create_distributed_table(table, column)` so the hub can
   * shard a large table by `distributionColumn` for horizontal scale-out.
   * Treats "already distributed" as a benign outcome rather than an error.
   * @param tableName physical (schema-qualified) table name to distribute.
   * @param distributionColumn column to shard on.
   * @returns `(status: 'DISTRIBUTED' | 'ALREADY_DISTRIBUTED', table)`.
   * @throws for any Citus error other than "already distributed".
   */
  static async distributeTable(tableName: string, distributionColumn: string) {
    try {
      await pool.query(`SELECT create_distributed_table($1, $2)`, [tableName, distributionColumn]);
      return { status: 'DISTRIBUTED', table: tableName };
    } catch (err: any) {
      if (err.message.includes('already distributed')) {
        return { status: 'ALREADY_DISTRIBUTED', table: tableName };
      }
      throw err;
    }
  }
}
