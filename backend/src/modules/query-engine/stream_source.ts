/**
 * INTERNAL (cursor-based) streaming source.
 *
 * For a pass-through scan — a single-source SELECT with only filter / projection /
 * sort / limit (NO join, set-op, aggregate, GROUP BY, window, DISTINCT, HAVING,
 * recursion or CALL) — the fabric can pull rows from the source with a CURSOR in
 * bounded batches instead of materializing the whole result in fabric memory.
 * `tryStream` decides whether a query qualifies and returns a lazy row source;
 * blocking shapes return `null` and the caller falls back to buffered/compute-
 * then-stream execution.
 *
 * Sources: hub Postgres (pg-query-stream on a tenant-scoped client), a remote
 * Postgres connector (pg-query-stream on its pool), or a MongoDB connector
 * (native cursor). Other engines return `null` (fallback).
 */
import QueryStream from 'pg-query-stream';
import { pool } from '../../config/database';
import { streamConfig } from '../../config/stream-config';
import { QueryPlanner } from './planner';
import { PushdownCompiler } from './pushdown';
import { ConnectorFactory } from '../metadata/connectors/factory';

export interface RowStream {
  /** plan strategy label recorded in the query log, e.g. RAW_SQL+STREAM */
  strategy: string;
  /** human-readable text of what runs at the source (for the trace/trailer) */
  queryText: string;
  engine: string;
  source: string;
  /** lazily open the cursor and yield rows in bounded batches */
  iterate: () => AsyncIterable<any>;
}

interface Ctx { tenantId: string; username?: string }

const AST_OP: Record<string, string> = {
  EQ: '$eq', NE: '$ne', GT: '$gt', GTE: '$gte', LT: '$lt', LTE: '$lte',
  IN: '$in', NIN: '$nin', LIKE: '$like', ILIKE: '$ilike', IS_NULL: '$eq', IS_NOT_NULL: '$ne',
};

/** Is this query AST a pure pass-through scan (streamable) — no blocking operators? */
function isPassThrough(q: any): boolean {
  if (!q || !q.from || !q.from.resource) return false;
  if (q.joins?.length || q.union || q.intersect || q.except || q.with) return false;
  if (q.groupBy?.length || q.recursive || q.having?.length || q.distinct) return false;
  if (Array.isArray(q.select) && q.select.some((s: any) => s && typeof s === 'object' && (s.aggregate || s.window))) return false;
  return true;
}

/** Build the canonical pushdown shape (select/filter/orderBy/limit) from a scan AST. */
function astToCanonical(q: any, limit?: number): any {
  const c: any = {};
  if (Array.isArray(q.select) && !q.select.includes('*')) {
    const cols: string[] = []; let ok = true;
    for (const s of q.select) {
      if (typeof s === 'string') cols.push(s);
      else if (s && s.column && !s.aggregate && !s.window) cols.push(s.column);
      else { ok = false; break; }
    }
    if (ok && cols.length) c.select = cols;
  }
  if (Array.isArray(q.where) && q.where.length) {
    const f: Record<string, any> = {}; let ok = true;
    for (const w of q.where) {
      if (!w || !w.column) { ok = false; break; }
      const raw = String(w.operator || 'EQ').toUpperCase();
      const op = AST_OP[raw] || '$eq';
      const val = (raw === 'IS_NULL' || raw === 'IS_NOT_NULL') ? null : w.value;
      f[w.column] = { ...(f[w.column] || {}), [op]: val };
    }
    if (ok) c.filter = f;
  }
  if (Array.isArray(q.orderBy) && q.orderBy.length) c.orderBy = q.orderBy.map((o: any) => ({ field: o.column, dir: o.direction === 'DESC' ? 'DESC' : 'ASC' }));
  if (typeof limit === 'number') c.limit = limit;
  return c;
}

/**
 * Stream rows from the hub Postgres with tenant context (mirrors `queryWithContext`)
 * via a server-side cursor (`pg-query-stream`). Yields rows in `batch`-sized
 * chunks; the transaction is closed and the client released on completion or
 * early termination (the generator's `finally`).
 */
export async function* hubRowStream(sql: string, params: any[], ctx: Ctx, batch: number): AsyncGenerator<any> {
  const client = await pool.connect();
  let began = false;
  try {
    await client.query('BEGIN'); began = true;
    await client.query('SET LOCAL ROLE fabric_user');
    await client.query(`SELECT set_config('app.tenant_id', $1, true)`, [ctx.tenantId]);
    await client.query(`SELECT set_config('app.user_name', $1, true)`, [ctx.username || 'system']);
    await client.query(`SELECT set_config('app.current_region', $1, true)`, [process.env.DEFAULT_REGION || 'AP']);
    await client.query('SET LOCAL statement_timeout = 0'); // a cursor may outlive the 10s default
    const base = `tenant_${String(ctx.tenantId).replace(/[^a-zA-Z0-9_]/g, '')}`;
    const { rows: sch } = await client.query(
      `SELECT schema_name FROM information_schema.schemata WHERE schema_name = $1 OR schema_name LIKE $2 ORDER BY (schema_name = $1) DESC, schema_name ASC`,
      [base, `${base}_%`]);
    const searchPath = sch.length ? sch.map((r: any) => `"${r.schema_name}"`).join(', ') : `"${base}"`;
    await client.query(`SET LOCAL search_path TO ${searchPath}, public`);

    const stream = client.query(new QueryStream(sql, params, { batchSize: Math.max(1, batch) }));
    try {
      for await (const row of stream) yield row;
    } finally {
      stream.destroy();
    }
  } finally {
    if (began) { try { await client.query('COMMIT'); } catch { await client.query('ROLLBACK').catch(() => {}); } }
    await client.query('RESET ROLE').catch(() => {});
    client.release();
  }
}

/**
 * Decide whether `config` is a streamable pass-through and, if so, return a lazy
 * `RowStream`. Returns `null` when internal streaming is disabled by config, when
 * the shape is blocking, or when the source engine isn't streamable here (the
 * caller then falls back to compute-then-stream).
 *
 * @param tenantId tenant id.
 * @param config the query config: `{ rawSql, params }` (raw SQL) or an AST `{ type, schema, limit, query }`.
 * @param session per-request session (for username in the hub context).
 */
export async function tryStream(tenantId: string, config: any, session?: any): Promise<RowStream | null> {
  const cfg = streamConfig();
  if (!cfg.internal) return null;
  const ctx: Ctx = { tenantId, username: session?.username };

  // A) Raw SQL on the hub — stream read-only statements via a hub cursor.
  if (config && typeof config.rawSql === 'string') {
    const sql = String(config.rawSql);
    if (!/^\s*(select|with|values|table|show)\b/i.test(sql)) return null; // never stream DML/DDL
    return { strategy: 'RAW_SQL+STREAM', queryText: sql, engine: 'POSTGRES', source: 'Fabric_Hub_Postgres',
      iterate: () => hubRowStream(sql, config.params || [], ctx, cfg.batch) };
  }

  // B) AST pass-through scan.
  const q = config?.query;
  if (config?.type === 'CALL' || !q || !isPassThrough(q)) return null;
  const source = q.from?.source;
  const resource = q.from?.resource;
  if (!resource) return null;

  let leg;
  try { leg = await QueryPlanner.resolveLeg(tenantId, source, resource); } catch { return null; }
  const limit = typeof config.limit === 'number' ? config.limit : (typeof q.limit === 'number' ? q.limit : undefined);
  const canonical = astToCanonical(q, limit);

  if (!leg.reachableInPg) {
    const schema = leg.physicalSchema || config.schema || (leg.engine === 'POSTGRES' ? 'public' : leg.engine === 'MONGODB' ? 'test' : '');
    const table = leg.physicalTable || resource;

    // Remote Postgres → compile to SQL and stream via pg-query-stream on its pool.
    if (leg.engine === 'POSTGRES') {
      const compiled = PushdownCompiler.toSql({ ...canonical, schema, table, dialect: 'postgres' } as any);
      return { strategy: 'SINGLE_CONNECTOR+STREAM', engine: 'POSTGRES', source: leg.source, queryText: compiled.text,
        iterate: async function* () {
          const c: any = ConnectorFactory.getConnector('POSTGRES', leg.config);
          try { yield* c.queryStream(compiled.text, compiled.params, cfg.batch); } finally { await c.close().catch(() => {}); }
        } };
    }

    // Document/search/other SQL engines expose queryStream(schema, table, canonical, batch).
    if (['MONGODB', 'ELASTICSEARCH', 'MYSQL', 'SNOWFLAKE'].includes(leg.engine)) {
      const label: Record<string, string> = {
        MONGODB: `db.${table}.find(${JSON.stringify(canonical.filter || {})}).stream()`,
        ELASTICSEARCH: `POST /${table}/_search?scroll (cursor)`,
        MYSQL: `SELECT … FROM \`${table}\` (streamed)`,
        SNOWFLAKE: `SELECT … FROM ${schema}.${table} (streamResult)`,
      };
      return { strategy: 'SINGLE_CONNECTOR+STREAM', engine: leg.engine, source: leg.source, queryText: label[leg.engine] || `${leg.engine} scan (streamed)`,
        iterate: async function* () {
          const c: any = ConnectorFactory.getConnector(leg.engine, leg.config);
          try { yield* c.queryStream(schema, table, canonical, cfg.batch); } finally { await c.close().catch(() => {}); }
        } };
    }
  }

  // reachable-in-PG (local/synced) → fall back to compute-then-stream (hub SQL transpile is future work).
  return null;
}
