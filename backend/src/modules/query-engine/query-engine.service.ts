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
import { randomUUID } from 'crypto';
import { ElasticsearchMutationWorker } from '../metadata/es_mutation_worker';
import { QueryPlanner, LOCAL_SOURCE } from './planner';
import { FederationExecutor } from './federation';
import { sqlToAst } from './sql_translator';
import { hasWindows, extractWindows, windowBaseColumns, applyWindows, projectWithWindows } from './compensate';
import { FabricWriteGenerators } from './write_generators';
import { PolicyService, SessionCtx } from '../security/policy.service';
import { RecursiveExecutor, RecursiveSpec, LevelFetch } from './recursive';
import { parseAggregates, aggregateRaw } from './aggregate';
import { ConstraintService } from './constraint.service';
import { GrantService, Privilege } from '../security/grant.service';

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
   * Sanitizes both identifiers (strip anything non-alphanumeric/underscore) and
   * leaves already-qualified or system schemas (`public`, `pg_catalog`,
   * `information_schema`, or a name already prefixed with `tenant_<id>`) as-is
   * so callers can pass either a bare logical name or a full physical one.
   * @param tenantId tenant identifier used to derive the `tenant_<id>` prefix.
   * @param schema optional logical schema name; omitted → the tenant's default schema.
   * @returns the physical schema name to qualify tables with.
   */
  private static toTenantSchemaName(tenantId: string, schema?: string) {
    const cleanTenant = tenantId.replace(/[^a-zA-Z0-9_]/g, '');
    if (!schema) return `tenant_${cleanTenant}`;
    const safeSchema = String(schema).replace(/[^a-zA-Z0-9_]/g, '');
    const fullPrefix = `tenant_${cleanTenant}_`;
    // Literal physical schemas are used as-is (never tenant-prefixed):
    //  - 'public' / 'pg_catalog' / 'information_schema' (shared/system),
    //  - an already tenant-qualified name (tenant_<id> or tenant_<id>_<x>).
    if (
      safeSchema === 'public' || safeSchema === 'pg_catalog' || safeSchema === 'information_schema' ||
      safeSchema === `tenant_${cleanTenant}` || safeSchema.startsWith(fullPrefix)
    ) {
      return safeSchema;
    }
    return `${fullPrefix}${safeSchema}`;
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

    if (cfg.tableId) {
      const { rows } = await pool.query(`
        SELECT ct.physical_name as table_name, cs.physical_name as schema_name
        FROM public.catalog_tables ct
        JOIN public.catalog_schemas cs ON ct.schema_id = cs.id
        WHERE ct.id = $1
      `, [cfg.tableId]);
      if (rows.length) {
        const resolvedSchema = rows[0].schema_name;
        const rawTable = rows[0].table_name || '';
        // Backward-compatible parsing: some older catalog rows stored physical_name as "<schema>.<table>".
        const resolvedTable = String(rawTable).includes('.')
          ? String(rawTable).split('.').pop()
          : String(rawTable);
        return { schemaName: resolvedSchema, tableName: resolvedTable };
      }
    }

    if (cfg.schemaId) {
      const { rows } = await pool.query('SELECT physical_name FROM public.catalog_schemas WHERE id = $1', [cfg.schemaId]);
      if (rows.length) schemaName = rows[0].physical_name;
    }

    return { schemaName, tableName };
  }
  private static jobs = new Map<string, { status: string; result?: any; error?: string }>();

  /**
   * Orchestrates the execution of a (@link QueryConfig) across the whole
   * federation pipeline. This is the single entry point almost every other
   * method in the fabric funnels through (directly, or via (@link fetch) /
   * (@link mutate) / (@link executeSqlOnSource)).
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
    const sessionCtx: SessionCtx = session || { tenantId, region: process.env.DEFAULT_REGION || 'AP', username: 'system' };
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
      if (!name) throw new Error('CALL requires "function" or "procedure"');
      if (!/^[A-Za-z0-9_.]+$/.test(String(name))) throw new Error('invalid function/procedure name');
      const schemaName = config.schema ? this.toTenantSchemaName(tenantId, config.schema) : null;
      const ref = String(name).includes('.')
        ? String(name).split('.').map((p) => `"${p.replace(/[^A-Za-z0-9_]/g, '')}"`).join('.')
        : (schemaName ? `"${schemaName}"."${name}"` : `public."${name}"`);
      const args = Array.isArray((config as any).args) ? (config as any).args : [];
      const ph = args.map((_: any, i: number) => `$${i + 1}`).join(', ');
      const sql = isProc ? `CALL ${ref}(${ph})` : `SELECT * FROM ${ref}(${ph})`;
      const started = Date.now();
      const result = await queryWithContext(sql, args, { tenantId, username: sessionCtx.username || 'system' });
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

    // INDUSTRIAL SAFETY SHIELD: Guard against unrestricted operations
    if (['SELECT', 'UPDATE', 'DELETE'].includes(config.type)) {
        const hasLimit = config.limit !== undefined;
        const hasFilter = config.filter && Object.keys(config.filter).length > 0;
        const isAggregate = config.select && (config.select.some(s => s.toLowerCase().includes('count(')) || config.select.some(s => s.toLowerCase().includes('sum(')));

        if (!hasLimit && !hasFilter && !isAggregate) {
            throw new Error('INDUSTRIAL SAFETY: Unrestricted operations (No LIMIT or WHERE) are blocked to prevent resource exhaustion.');
        }
    }

    // Manifest-style query AST execution (consistent with metadata query blocks)
    if (
      config.type === 'SELECT' &&
      (
        (config as any).query?.from?.resource ||
        Array.isArray((config as any).query?.union) ||
        Array.isArray((config as any).query?.intersect) ||
        Array.isArray((config as any).query?.except) ||
        Array.isArray((config as any).query?.with)
      )
    ) {
      const schemaName = this.toTenantSchemaName(tenantId, config.schema);
      const ast = JSON.parse(JSON.stringify((config as any).query || {}));

      const hasWhere = Array.isArray(ast.where) && ast.where.length > 0;
      const hasLimit = typeof config.limit === 'number' && config.limit > 0;
      const hasSetOps = Array.isArray(ast.union) || Array.isArray(ast.intersect) || Array.isArray(ast.except);
      if (!hasWhere && !hasLimit && !hasSetOps) {
        throw new Error('INDUSTRIAL SAFETY: Manifest-style SELECT requires either query.where or limit.');
      }

      // Carry the top-level limit into the AST so pushdown / federation can honour it.
      if (hasLimit && typeof ast.limit !== 'number') ast.limit = config.limit;

      // ---- Capability compensation: WINDOW FUNCTIONS ----
      // No engine's connector expresses window functions, so the fabric computes
      // them itself: fetch the base rows (with filter pushdown) via the normal path,
      // then compute the windows in-fabric over that bounded result.
      if (hasWindows(ast.select)) {
        const windowSpecs = extractWindows(ast.select);
        const baseCols = windowBaseColumns(ast.select);
        const baseQuery: any = { ...ast, select: baseCols.length ? baseCols : ['*'] };
        delete baseQuery.groupBy; // windows are computed over rows, not pre-aggregated groups
        delete baseQuery.limit;   // don't cut partitions before the window is computed
        const cap = Number(process.env.FABRIC_FED_MAX_ROWS_PER_LEG) || 50000;
        const started = Date.now();
        const baseRes = await this.executeQuery(tenantId, { type: 'SELECT', schema: config.schema, limit: cap, query: baseQuery } as any);
        let rows = applyWindows(baseRes.data || [], windowSpecs);
        rows = projectWithWindows(rows, ast.select);
        if (Array.isArray(ast.orderBy) && ast.orderBy.length) {
          rows = [...rows].sort((a, b) => { for (const o of ast.orderBy) { const av = a[o.column], bv = b[o.column]; if (av < bv) return o.direction === 'DESC' ? 1 : -1; if (av > bv) return o.direction === 'DESC' ? -1 : 1; } return 0; });
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

      // Plan HOW to execute across sources instead of assuming everything is local Postgres.
      const plan = await QueryPlanner.classify(tenantId, ast);
      console.log(`[QueryEngine] AST strategy=${plan.strategy} :: ${plan.pushed.join('; ')}`);

      if (plan.strategy === 'SINGLE_CONNECTOR' || plan.strategy === 'CROSS_ENGINE') {
        // Each leg is fetched from its own engine WITH pushdown (predicate + bind-join),
        // then combined in-memory.
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
      let sql = QueryTranspiler.toSql(ast, schemaName);
      if (hasLimit && !/\sLIMIT\s+\d+/i.test(sql)) {
        sql = `${sql} LIMIT ${config.limit}`;
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
        const cleanTenant = tenantId.replace(/[^a-zA-Z0-9_]/g, '');
        // If it's a simple tenant schema creation
        if (!config.schema) {
            await queryWithContext('SELECT fabric_admin.create_tenant_namespace($1)', [cleanTenant], { tenantId, username: 'system' });
            return { status: 'SUCCESS', target: `tenant_${cleanTenant}`, type: 'CREATE_SCHEMA' };
        }
    }

    // 1. Resolve Table/Schema to find Source and Sync Type
    let sourceId: string | null = null;
    let physicalSchema: string | null = null;
    let physicalTable: string | null = null;

    if (config.tableId) {
        const { rows } = await pool.query(`
            SELECT ct.physical_name as t_name, cs.physical_name as s_name, cs.source_id, ds.type as s_type, ds.config as s_config, ds.sync_type
            FROM public.catalog_tables ct
            JOIN public.catalog_schemas cs ON ct.schema_id = cs.id
            JOIN public.data_sources ds ON cs.source_id = ds.id
            WHERE ct.id = $1
        `, [config.tableId]);
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

  /**
   * Specialized method for DDL execution during migration (bypass event emitting).
   * Runs a raw parameterized SQL string directly on the hub Postgres connection
   * (tenant-scoped via (@link queryWithContext)), after the same suspended-tenant
   * guard as (@link executeQuery). Unlike the main path, it does NOT emit
   * mutation events or enqueue Elasticsearch sync — intended for schema
   * migrations and other maintenance operations where those side effects are
   * undesirable or handled separately.
   * @param tenantId tenant identifier.
   * @param username acting user, recorded for the DB session context.
   * @param sql raw SQL text to execute.
   * @param params positional parameters for the SQL (default none).
   * @returns `(results, safetyApplied)` where `safetyApplied` flags whether the
   *   SQL contains a destructive keyword (DROP/TRUNCATE/ALTER/GRANT/REVOKE) —
   *   informational only, execution is not blocked.
   * @throws if the tenant is suspended.
   */
  static async executeRawSql(tenantId: string, username: string, sql: string, params: any[] = []): Promise<any> {
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

    const safetyApplied = this.detectUnsafeOperations(sql);
    const result = await queryWithContext(sql, params, { tenantId, username });
    
    return {
      results: result.rows,
      safetyApplied
    };
  }

  /**
   * Execute native SQL directly against a NAMED remote source's connector (not the hub).
   * This lets the fabric run complex single-source analytics — window functions,
   * recursive CTEs, materialized-view reads — AT the engine that physically owns the
   * data (e.g. the external warehouse Postgres), returning the same trace/timing envelope
   * as the federated path so callers can see where and how long the work ran.
   * @param tenantId tenant identifier; resolves `sourceName` from `public.data_sources`.
   * @param sourceName logical name of the named source to run against.
   * @param sql the SQL text to execute (native SQL for SQL-native engines; also
   *   accepted for non-SQL engines, see below).
   * @param params positional parameters for `sql` (default none).
   * @param schema optional schema/search_path to select on the connector/session before running.
   * @returns for SQL-native engines (Postgres/MySQL/Snowflake/Elasticsearch), an
   *   envelope with `results`/`data`/`rowCount` and a `plan` trace of the raw SQL
   *   executed at the source; for non-SQL engines (e.g. MongoDB), the SQL is
   *   translated via (@link sqlToAst) and re-dispatched through
   *   (@link executeQuery) (so the result carries that path's own plan, annotated
   *   with `translatedFrom: 'SQL'`).
   * @throws if the named source does not exist for the tenant, or if a
   *   SQL-native connector has no `rawQuery` support.
   */
  static async executeSqlOnSource(
    tenantId: string, sourceName: string, sql: string, params: any[] = [], schema?: string
  ): Promise<any> {
    const { rows } = await pool.query(
      `SELECT type, config FROM public.data_sources WHERE tenant_id = $1 AND name = $2 LIMIT 1`,
      [tenantId, sourceName]
    );
    if (!rows.length) throw new Error(`Source "${sourceName}" not found for tenant "${tenantId}"`);
    const engine = String(rows[0].type || 'POSTGRES').toUpperCase();
    const config = rows[0].config || {};

    // SQL-native engines run the SQL directly at the source (window functions,
    // recursive CTEs, ES _sql). Non-SQL engines (MongoDB) have no SQL engine, so
    // the fabric TRANSLATES the SQL into its query AST and runs it through the
    // normal planner → the engine's native query language (Mongo find / $group).
    const SQL_NATIVE = new Set(['POSTGRES', 'POSTGRESQL', 'MYSQL', 'SNOWFLAKE', 'ELASTICSEARCH', 'ELASTIC', 'ES']);
    if (!SQL_NATIVE.has(engine)) {
      const query: any = sqlToAst(sql);
      query.from.source = sourceName;
      const result = await this.executeQuery(tenantId, {
        type: 'SELECT', schema: schema || 'public',
        limit: typeof query.limit === 'number' ? query.limit : 1000, query,
      } as any);
      if (result.plan) {
        result.plan.translatedFrom = 'SQL';
        result.plan.pushed = [`SQL translated by the fabric into a native ${engine} query`, ...(result.plan.pushed || [])];
      }
      return result;
    }

    const connector: any = ConnectorFactory.getConnector(engine, config);
    if (typeof connector.rawQuery !== 'function') {
      await connector.close();
      throw new Error(`Source "${sourceName}" (${engine}) does not support native SQL execution`);
    }
    const started = Date.now();
    try {
      if (schema && typeof connector.setSearchPath === 'function') await connector.setSearchPath(schema);
      const data = await connector.rawQuery(sql, params);
      const ms = Date.now() - started;
      return {
        results: data,
        data,
        rowCount: data.length,
        plan: {
          strategy: 'SINGLE_CONNECTOR_RAW',
          executionMs: ms,
          pushed: [`native SQL executed at ${engine} source "${sourceName}"${schema ? ` (search_path=${schema})` : ''}`],
          legs: [{
            source: sourceName, engine, mode: 'connector', operation: 'raw-sql',
            target: schema || engine, query: String(sql).replace(/\s+/g, ' ').trim().slice(0, 600),
            rowsReturned: data.length, ms,
          }],
        },
      };
    } finally {
      await connector.close();
    }
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
  private static buildWhere(where: Record<string, any>, params: any[]): string {
    const clauses = Object.keys(where || {}).map((key) => {
      const col = key.split('.').map((p) => `"${p.replace(/[^a-zA-Z0-9_]/g, '')}"`).join('.');
      const raw = where[key];
      const firstKey = (raw !== null && typeof raw === 'object' && !Array.isArray(raw)) ? Object.keys(raw)[0] : undefined;
      const isOp = !!firstKey && firstKey.startsWith('$');
      const op = isOp ? firstKey! : '$eq';
      const val = isOp ? raw[firstKey!] : raw;
      const sqlOp = this.SQL_OPS[op] || '=';
      if (op === '$in' && Array.isArray(val)) {
        if (!val.length) return '1=0';
        return `${col} IN (${val.map((v) => { params.push(v); return `$${params.length}`; }).join(', ')})`;
      }
      if (op === '$match') { params.push('%' + String(val) + '%'); return `${col} ILIKE $${params.length}`; }
      params.push(val);
      return `${col} ${sqlOp} $${params.length}`;
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
    const config: any = { type: 'SELECT', schema: schema || 'public', query, limit: typeof limit === 'number' ? limit : 100 };
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
    if ((op === 'update' || op === 'delete') && (!where || Object.keys(where).length === 0)) {
      throw new Error('SAFETY: update/delete require a "where" filter to avoid unrestricted mutations.');
    }
    if ((op === 'create' || op === 'update') && (!data || (Array.isArray(data) && !data.length))) {
      throw new Error(`${op} requires "data".`);
    }

    const isHub = !source || source === LOCAL_SOURCE;
    if (isHub) {
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
    if (!phys) {
      const cat = await pool.query(
        `SELECT cs.physical_name FROM public.catalog_tables ct
         JOIN public.catalog_schemas cs ON ct.schema_id = cs.id
         JOIN public.data_sources ds ON cs.source_id = ds.id
         WHERE ds.tenant_id=$1 AND ds.name=$2 AND ct.name=$3 LIMIT 1`, [tenantId, source, resource]);
      phys = cat.rows[0]?.physical_name || 'public';
    }
    // GRANTS: deny the write if the table is governed and the role lacks the privilege.
    const privMap = { create: 'INSERT', update: 'UPDATE', delete: 'DELETE' } as const;
    await GrantService.enforce(tenantId, phys, resource, role, privMap[op] as Privilege);

    const connector: any = ConnectorFactory.getConnector(engine, config);
    const started = Date.now();
    try {
      if (engine === 'POSTGRES') {
        const { sql, params } = this.buildMutationSql(op, phys, resource, data, where);
        const out = await connector.rawQuery(sql, params);
        const ms = Date.now() - started;
        return {
          rowCount: out.length, returning: out, status: 'SUCCESS',
          plan: { strategy: 'SINGLE_CONNECTOR_WRITE', executionMs: ms,
            legs: [{ source, engine, mode: 'connector', operation: op, target: `${phys}.${resource}`, query: sql.replace(/\s+/g, ' ').trim(), rowsReturned: out.length, ms }] },
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
   * @returns `(sql, params)` ready to run via the source's connector `rawQuery`.
   */
  private static buildMutationSql(op: string, schema: string, table: string, data: any, where: any): { sql: string; params: any[] } {
    const t = `${this.qIdent(schema)}.${this.qIdent(table)}`;
    const params: any[] = [];
    if (op === 'create') {
      const rowsArr = Array.isArray(data) ? data : [data];
      const cols = Object.keys(rowsArr[0]);
      const tuples = rowsArr.map((row) => `(${cols.map((c) => { params.push(row[c]); return `$${params.length}`; }).join(', ')})`);
      return { sql: `INSERT INTO ${t} (${cols.map((c) => this.qIdent(c)).join(', ')}) VALUES ${tuples.join(', ')} RETURNING *`, params };
    }
    if (op === 'update') {
      const sets = Object.keys(data).map((c) => { params.push(data[c]); return `${this.qIdent(c)} = $${params.length}`; }).join(', ');
      return { sql: `UPDATE ${t} SET ${sets}${this.buildWhere(where, params)} RETURNING *`, params };
    }
    return { sql: `DELETE FROM ${t}${this.buildWhere(where, params)} RETURNING *`, params };
  }

  /**
   * Asynchronous Query Execution Wrapper.
   * Fire-and-forget variant of (@link executeRawSql): registers a job entry,
   * runs the raw SQL in the background, and returns immediately with the job
   * id so the caller can poll (@link getJobStatus).
   * @param tenantId tenant identifier.
   * @param username acting user.
   * @param sql raw SQL text to execute.
   * @param params positional parameters (default none).
   * @returns a job id to poll via (@link getJobStatus).
   */
  static executeAsyncRawSql(tenantId: string, username: string, sql: string, params: any[] = []): string {
    const jobId = randomUUID();
    this.jobs.set(jobId, { status: 'RUNNING' });

    this.executeRawSql(tenantId, username, sql, params)
      .then(result => {
        this.jobs.set(jobId, { status: 'COMPLETED', result });
      })
      .catch(err => {
        this.jobs.set(jobId, { status: 'FAILED', error: err.message });
      });

    return jobId;
  }

  /**
   * Look up the current status of a job started by (@link executeAsyncRawSql)
   * or (@link executeAsyncQuery).
   * @param jobId job id returned by the async starter.
   * @returns `(jobId, status: 'NOT_FOUND')` if unknown, otherwise
   *   `(jobId, status: 'PENDING'|'RUNNING'|'COMPLETED'|'FAILED', result?, error?)`.
   */
  static getJobStatus(jobId: string) {
    const job = this.jobs.get(jobId);
    if (!job) return { status: 'NOT_FOUND', jobId };
    return { jobId, ...job };
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

    const cleanTenant = tenantId.replace(/[^a-zA-Z0-9_]/g, '');
    const resolved = await this.resolveTarget(tenantId, config as any);
    let schemaName = resolved.schemaName;
    let tableName = resolved.tableName || table?.replace(/[^a-zA-Z0-9_]/g, '');

    const safeTable = `"${schemaName}"."${tableName}"`;
    
    let queryStr = '';
    const params: any[] = [];
    let paramIndex = 1;

    if (withRecursive) {
        queryStr = `WITH RECURSIVE ${withRecursive.name} AS (
            ${withRecursive.baseQuery}
            UNION ALL
            ${withRecursive.recursiveQuery}
        ) `;
    }

    if (type === 'SELECT') {
      const selectFields = select && select.length > 0 
        ? select.map(f => {
            if (f === '*') return '*';
            if (f.includes('(') || f.includes(' ')) return f; 
            return f.split('.').map(part => `"${part.replace(/[^a-zA-Z0-9_]/g, '')}"`).join('.');
          }).join(', ') 
        : '*';
      
      const isCte = withRecursive && config.table === withRecursive.name;
      const selectSchema = config.schema ? `tenant_${cleanTenant}_${config.schema}` : `tenant_${cleanTenant}`;
      const safeSelectTable = isCte 
        ? `"${tableName!.replace(/[^a-zA-Z0-9_]/g, '')}"`
        : `"${schemaName}"."${tableName!.replace(/[^a-zA-Z0-9_]/g, '')}"`;

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
          let joinTable = jResolved.tableName || join.table || (join as any).resource;
          let joinSchema = jResolved.schemaName || (config.schema ? `tenant_${cleanTenant}_${config.schema}` : `tenant_${cleanTenant}`);

          const safeJoinTable = `"${joinSchema}"."${joinTable!.replace(/[^a-zA-Z0-9_]/g, '')}"`;
          queryStr += ` ${join.type} JOIN ${safeJoinTable} ON ${join.on}`;
        }
      }
    } else if (type === 'INSERT') {
      const data = config.data as any;
      const columns = Object.keys(Array.isArray(data) ? data[0] : data);
      const rows = Array.isArray(data) ? data : [data];
      
      const placeholders = rows.map(row => {
        return '(' + columns.map(col => {
          if (inlineValues) return this.formatInline(row[col]);
          params.push(row[col]);
          return `$${paramIndex++}`;
        }).join(', ') + ')';
      }).join(', ');

      queryStr = `INSERT INTO ${safeTable} (${columns.map(c => `"${c}"`).join(', ')}) VALUES ${placeholders} RETURNING *`;
    } else if (type === 'UPDATE') {
      const data = config.data as any;
      const sets = Object.keys(data).map(col => {
        if (inlineValues) return `"${col}" = ${this.formatInline(data[col])}`;
        params.push(data[col]);
        return `"${col}" = $${paramIndex++}`;
      }).join(', ');
      queryStr = `UPDATE ${safeTable} SET ${sets}`;
    } else if (type === 'DELETE') {
      queryStr = `DELETE FROM ${safeTable}`;
    } else if (type === 'CREATE_TABLE') {
      const columns = config.schemaDef?.columns.map(c => `"${c.name}" ${c.type} ${c.constraints || ''}`).join(', ');
      queryStr = `CREATE TABLE ${safeTable} (${columns})`;
    } else if (type === 'DROP_TABLE') {
      queryStr = `DROP TABLE IF EXISTS ${safeTable}`;
    } else if (type === 'CREATE_INDEX') {
      const idx = config.indexDef!;
      queryStr = `CREATE ${idx.unique ? 'UNIQUE ' : '' }INDEX "${idx.name}" ON ${safeTable} (${idx.columns.join(', ')})`;
    } else if (type === 'CREATE_VIEW') {
      const view = config.viewDef!;
      queryStr = `CREATE ${view.materialized ? 'MATERIALIZED ' : ''}VIEW "${schemaName}"."${view.name}" AS ${view.query}`;
    } else if (type === 'CREATE_SCHEMA') {
      queryStr = `CREATE SCHEMA IF NOT EXISTS "${schemaName}"`;
    } else if (type === 'CREATE_SEQUENCE') {
      const seq = config.sequenceDef!;
      queryStr = `CREATE SEQUENCE IF NOT EXISTS "${schemaName}"."${seq.name}" START WITH ${seq.start || 1} INCREMENT BY ${seq.increment || 1}`;
    } else if (type === 'ALTER_TABLE') {
        const alter = config.alterDef!;
        if (alter.action === 'ADD_COLUMN') {
            queryStr = `ALTER TABLE ${safeTable} ADD COLUMN "${alter.columnName}" ${alter.columnType}`;
        } else if (alter.action === 'DROP_COLUMN') {
            queryStr = `ALTER TABLE ${safeTable} DROP COLUMN "${alter.columnName}"`;
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
        if (op === '$gt') sqlOp = '>';
        else if (op === '$lt') sqlOp = '<';
        else if (op === '$ne') sqlOp = '!=';
        else if (op === '$like') sqlOp = 'ILIKE';
        else if (op === '$in') sqlOp = 'IN';

        if (op === '$in' && Array.isArray(val)) {
            const inPlaceholders = val.map(v => {
                if (inlineValues) return this.formatInline(v);
                params.push(v);
                return `$${paramIndex++}`;
            }).join(', ');
            return `${safeKey} IN (${inPlaceholders})`;
        }

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
        if (groupBy) queryStr += ` GROUP BY ${groupBy.join(', ')}`;
        if (orderBy) queryStr += ` ORDER BY ${orderBy.map(o => `${o.field} ${o.dir}`).join(', ')}`;
        if (limit) queryStr += ` LIMIT ${limit}`;
        if (offset) queryStr += ` OFFSET ${offset}`;
    }

    console.log(`[SQL Gen] ${type} -> ${queryStr}`);
    return { sql: queryStr, params };
  }

  /**
   * Render a JS value as a SQL literal for the `inlineValues` mode of (@link generateSql).
   * Strings are single-quote-escaped; used where a parameterized placeholder
   * isn't valid (e.g. inside a CREATE VIEW body).
   * @param val the value to render (`null`, string, boolean, or anything with a `toString`).
   * @returns the SQL literal text.
   */
  private static formatInline(val: any): string {
    if (val === null) return 'NULL';
    if (typeof val === 'string') return `'${val.replace(/'/g, "''")}'`;
    if (typeof val === 'boolean') return val ? 'TRUE' : 'FALSE';
    return val.toString();
  }

  /**
   * Flag (informational only — does not block execution) whether a raw SQL
   * string contains a destructive/DDL keyword. Used by (@link executeRawSql) to
   * annotate its result with `safetyApplied`.
   * @param sql the SQL text to scan.
   * @returns true if the text contains DROP, TRUNCATE, ALTER, GRANT, or REVOKE (case-insensitive).
   */
  private static detectUnsafeOperations(sql: string): boolean {
    const unsafeKeywords = ['DROP', 'TRUNCATE', 'ALTER', 'GRANT', 'REVOKE'];
    const upperSql = sql.toUpperCase();
    return unsafeKeywords.some(keyword => upperSql.includes(keyword));
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
  static async refreshMaterializedView(tenantId: string, viewName: string, concurrent: boolean = true, schema: string = 'default') {
    const cleanTenant = tenantId.replace(/[^a-zA-Z0-9_]/g, '');
    const schemaName = schema === 'default' ? `tenant_${cleanTenant}` : `tenant_${cleanTenant}_${schema.replace(/[^a-zA-Z0-9_]/g, '')}`;
    const sql = `REFRESH MATERIALIZED VIEW ${concurrent ? 'CONCURRENTLY ' : ''}"${schemaName}"."${viewName}"`;
    await queryWithContext(sql, [], { tenantId, username: 'system' });
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
  static executeAsyncQuery(tenantId: string, config: QueryConfig): string {
    const jobId = randomUUID();
    this.jobs.set(jobId, { status: 'PENDING' });

    this.executeQuery(tenantId, config)
        .then(data => this.jobs.set(jobId, { status: 'COMPLETED', result: data }))
        .catch(err => this.jobs.set(jobId, { status: 'FAILED', error: err.message }));

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
