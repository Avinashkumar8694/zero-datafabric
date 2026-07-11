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

export class QueryEngineService {
  private static toTenantSchemaName(tenantId: string, schema?: string) {
    const cleanTenant = tenantId.replace(/[^a-zA-Z0-9_]/g, '');
    if (!schema) return `tenant_${cleanTenant}`;
    const safeSchema = String(schema).replace(/[^a-zA-Z0-9_]/g, '');
    const fullPrefix = `tenant_${cleanTenant}_`;
    if (safeSchema === `tenant_${cleanTenant}` || safeSchema.startsWith(fullPrefix)) {
      return safeSchema;
    }
    return `${fullPrefix}${safeSchema}`;
  }

  /**
   * Remove logical `source` labels from an AST so the transpiler resolves every
   * resource against the tenant Postgres schema. Only valid when the planner has
   * classified the query as SINGLE_LOCAL (all legs reachable in Postgres).
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
   * Orchestrates the execution of complex query configurations
   */
  static async executeQuery(tenantId: string, config: QueryConfig): Promise<any> {
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
        const fed = await FederationExecutor.execute(tenantId, ast, plan, schemaName);
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
                const connector = ConnectorFactory.getConnector(rows[0].s_type, rows[0].s_config);
                try {
                    const data = await connector.query(physicalSchema!, physicalTable!, config);
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
   * Specialized method for DDL execution during migration (bypass event emitting)
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

  /** Post-aggregation HAVING filter (compensation) on the grouped result rows. */
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

  /** Safe identifier: quote a column/table name, stripping anything non-identifier. */
  private static qIdent(name: string): string {
    return '"' + String(name).replace(/[^a-zA-Z0-9_]/g, '') + '"';
  }

  /**
   * Reject unsafe keys in a where/data map: column names must be plain identifiers
   * (optionally dotted). Blocks SQL identifier break-out and MongoDB operator
   * injection (e.g. a "$where" key enabling server-side JS).
   */
  private static assertSafeKeys(obj: Record<string, any> | undefined, what: string): void {
    for (const k of Object.keys(obj || {})) {
      if (!/^[A-Za-z0-9_]+(\.[A-Za-z0-9_]+)*$/.test(k)) {
        throw new Error(`SAFETY: invalid ${what} field name "${k}".`);
      }
    }
  }

  /** Build a parameterized WHERE clause from a {col: val | {$op: val}} map. */
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

  /** Simple fetch: builds an AST SELECT and runs it through the full engine. */
  static async fetch(tenantId: string, body: any): Promise<any> {
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
    return this.executeQuery(tenantId, config);
  }

  /** Simple create/update/delete against the hub or an external source. */
  static async mutate(tenantId: string, op: 'create' | 'update' | 'delete', body: any): Promise<any> {
    const { source, schema, resource, where, generate } = body;
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

  /** Generate parameterized INSERT / UPDATE / DELETE ... RETURNING * for a remote SQL source. */
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
   * Asynchronous Query Execution Wrapper
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

  static getJobStatus(jobId: string) {
    const job = this.jobs.get(jobId);
    if (!job) return { status: 'NOT_FOUND', jobId };
    return { jobId, ...job };
  }

  /**
   * Generates a SQL string and parameters from a QueryConfig without executing it.
   * Useful for CREATE VIEW or complex migration planning.
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

  private static formatInline(val: any): string {
    if (val === null) return 'NULL';
    if (typeof val === 'string') return `'${val.replace(/'/g, "''")}'`;
    if (typeof val === 'boolean') return val ? 'TRUE' : 'FALSE';
    return val.toString();
  }

  private static detectUnsafeOperations(sql: string): boolean {
    const unsafeKeywords = ['DROP', 'TRUNCATE', 'ALTER', 'GRANT', 'REVOKE'];
    const upperSql = sql.toUpperCase();
    return unsafeKeywords.some(keyword => upperSql.includes(keyword));
  }

  /**
   * Refreshes a materialized view in the background
   */
  static async refreshMaterializedView(tenantId: string, viewName: string, concurrent: boolean = true, schema: string = 'default') {
    const cleanTenant = tenantId.replace(/[^a-zA-Z0-9_]/g, '');
    const schemaName = schema === 'default' ? `tenant_${cleanTenant}` : `tenant_${cleanTenant}_${schema.replace(/[^a-zA-Z0-9_]/g, '')}`;
    const sql = `REFRESH MATERIALIZED VIEW ${concurrent ? 'CONCURRENTLY ' : ''}"${schemaName}"."${viewName}"`;
    await queryWithContext(sql, [], { tenantId, username: 'system' });
  }

  /**
   * Async high-level query execution (QueryConfig based)
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
   * Citus-specific: Distributes a table across the cluster
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
