import { pool } from '../../config/database';

/**
 * QueryLogService — an execution audit trail for EVERY query the fabric runs.
 *
 * Wraps a query execution, measures wall-clock TAT and heap delta, and records
 * the full story from the result envelope: the mode/operation, the query text
 * (SQL or AST), the chosen strategy, the per-leg trace (which engine ran what,
 * where, how many rows, how long), rows scanned across sources, pushdown notes,
 * warnings, and success/error. Persisted to fabric_system.query_logs so it can
 * be browsed in the audit UI (with a per-query detail view).
 *
 * Logging is best-effort: a failure to record NEVER affects the query result.
 */

export interface QueryLogMeta {
  tenantId: string;
  username?: string;
  role?: string;
  /** Coarse category: SELECT_AST | SELECT_SQL | CRUD_CREATE | CALL | RECURSIVE | ... */
  mode: string;
  /** The query as issued: a SQL string or a stringified AST/config. */
  queryText?: string;
  source?: string;
  api?: string;
}

export class QueryLogService {
  private static ready = false;

  /** Lazily create the `fabric_system.query_logs` table + its tenant/time index (idempotent, runs at most once per process). */
  static async ensureTable(): Promise<void> {
    if (this.ready) return;
    await pool.query(`
      CREATE TABLE IF NOT EXISTS fabric_system.query_logs (
        id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        tenant_id     text NOT NULL,
        username      text,
        role          text,
        api           text,
        mode          text,
        source        text,
        strategy      text,
        status        text NOT NULL DEFAULT 'SUCCESS',
        error         text,
        query_text    text,
        row_count     integer,
        rows_scanned  integer,
        execution_ms  integer,
        tat_ms        integer,
        mem_delta_kb  integer,
        legs          jsonb NOT NULL DEFAULT '[]'::jsonb,
        plan          jsonb NOT NULL DEFAULT '{}'::jsonb,
        pushed        jsonb NOT NULL DEFAULT '[]'::jsonb,
        warnings      jsonb NOT NULL DEFAULT '[]'::jsonb,
        created_at    timestamptz NOT NULL DEFAULT NOW()
      )`);
    await pool.query('CREATE INDEX IF NOT EXISTS idx_query_logs_tenant_time ON fabric_system.query_logs (tenant_id, created_at DESC)');
    this.ready = true;
  }

  /**
   * Run `fn`, capture full execution telemetry, persist a log row, and return
   * the result unchanged. Errors are recorded then re-thrown.
   * @param meta static metadata about the call (tenant/user/role/mode/query text/api/source).
   * @param fn the query execution to run and time; its resolved value is treated as the result envelope.
   * @returns whatever `fn` resolves to, unchanged.
   * @throws whatever `fn` throws (re-thrown after best-effort logging).
   */
  static async capture(meta: QueryLogMeta, fn: () => Promise<any>): Promise<any> {
    const t0 = Date.now();
    const m0 = process.memoryUsage().heapUsed;
    try {
      const res = await fn();
      this.record(meta, res, { tatMs: Date.now() - t0, memDeltaKb: this.memDelta(m0), status: 'SUCCESS' }).catch(() => {});
      return res;
    } catch (err: any) {
      this.record(meta, null, { tatMs: Date.now() - t0, memDeltaKb: this.memDelta(m0), status: 'ERROR', error: err?.message }).catch(() => {});
      throw err;
    }
  }

  /**
   * Compute the non-negative heap growth (in KB) since a baseline reading.
   * @param m0 baseline `process.memoryUsage().heapUsed` reading.
   * @returns heap delta in KB, floored at 0 (GC between calls can make the raw delta negative).
   */
  private static memDelta(m0: number): number {
    return Math.max(0, Math.round((process.memoryUsage().heapUsed - m0) / 1024));
  }

  /**
   * Extract telemetry from a query envelope and insert a log row (best-effort).
   * Pulls `plan.legs`/`plan.strategy`/`plan.pushed`/`plan.executionMs` off the
   * result envelope (when present) so the log captures the SAME per-leg trace
   * and pushdown evidence the caller received, alongside the wall-clock/memory
   * telemetry captured by (@link capture). Any failure here (including a
   * missing table) is swallowed — audit logging must never break a query.
   * @param meta static call metadata (tenant/user/role/mode/query text/api/source).
   * @param envelope the query result envelope (`(data, rowCount, plan, warnings)`), or `null` on error.
   * @param extra timing/memory/status captured by the caller: `(tatMs, memDeltaKb, status, error?)`.
   */
  static async record(
    meta: QueryLogMeta,
    envelope: any,
    extra: { tatMs: number; memDeltaKb: number; status: string; error?: string }
  ): Promise<void> {
    try {
      await this.ensureTable();
      const plan = envelope?.plan || {};
      const legs = Array.isArray(plan.legs) ? plan.legs : [];
      const rowCount = envelope?.rowCount ?? (Array.isArray(envelope?.data) ? envelope.data.length : null);
      const rowsScanned = plan.rowsScannedAcrossSources ?? legs.reduce((n: number, l: any) => n + (l.rowsReturned || 0), 0);
      await pool.query(
        `INSERT INTO fabric_system.query_logs
          (tenant_id, username, role, api, mode, source, strategy, status, error, query_text,
           row_count, rows_scanned, execution_ms, tat_ms, mem_delta_kb, legs, plan, pushed, warnings)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16::jsonb,$17::jsonb,$18::jsonb,$19::jsonb)`,
        [
          meta.tenantId, meta.username || null, meta.role || null, meta.api || null, meta.mode, meta.source || null,
          plan.strategy || null, extra.status, extra.error || null, this.truncate(meta.queryText, 20000),
          rowCount, rowsScanned, plan.executionMs ?? null, extra.tatMs, extra.memDeltaKb,
          JSON.stringify(legs), JSON.stringify(plan), JSON.stringify(plan.pushed || []), JSON.stringify(envelope?.warnings || plan.warnings || []),
        ]
      );
    } catch { /* audit logging must never break a query */ }
  }

  /**
   * Stringify and cap a value to a maximum length before persisting it.
   * @param s the value to render (already a string, or JSON-stringified otherwise); `null`/`undefined` pass through.
   * @param max maximum character length before truncation.
   * @returns the (possibly truncated, with a trailing marker) string, or `null` for a nullish input.
   */
  private static truncate(s: any, max: number): string | null {
    if (s === undefined || s === null) return null;
    const str = typeof s === 'string' ? s : JSON.stringify(s);
    return str.length > max ? str.slice(0, max) + '…(truncated)' : str;
  }

  /**
   * List a tenant's query log entries (summary columns only — no legs/plan/warnings), newest first.
   * @param tenantId tenant identifier.
   * @param opts optional `status`/`mode` filters and a `limit` (clamped 1–1000, default 200).
   * @returns matching log summary rows, most recent first.
   */
  static async list(tenantId: string, opts: { limit?: number; status?: string; mode?: string } = {}): Promise<any[]> {
    await this.ensureTable();
    const params: any[] = [tenantId];
    const where: string[] = ['tenant_id = $1'];
    if (opts.status) { params.push(opts.status); where.push(`status = $${params.length}`); }
    if (opts.mode) { params.push(opts.mode); where.push(`mode = $${params.length}`); }
    params.push(Math.min(Math.max(Number(opts.limit) || 200, 1), 1000));
    const { rows } = await pool.query(
      `SELECT id, username, role, api, mode, source, strategy, status, error,
              row_count AS "rowCount", rows_scanned AS "rowsScanned", execution_ms AS "executionMs",
              tat_ms AS "tatMs", mem_delta_kb AS "memDeltaKb", created_at AS "createdAt"
       FROM fabric_system.query_logs
       WHERE ${where.join(' AND ')}
       ORDER BY created_at DESC LIMIT $${params.length}`,
      params
    );
    return rows;
  }

  /**
   * Fetch the full detail of one query log entry, including the per-leg trace,
   * plan, pushdown notes, and warnings — for the audit UI's detail view.
   * @param tenantId tenant identifier.
   * @param id the log row's id.
   * @returns the full log row, or `null` if not found.
   */
  static async get(tenantId: string, id: string): Promise<any> {
    await this.ensureTable();
    const { rows } = await pool.query(
      `SELECT id, username, role, api, mode, source, strategy, status, error, query_text AS "queryText",
              row_count AS "rowCount", rows_scanned AS "rowsScanned", execution_ms AS "executionMs",
              tat_ms AS "tatMs", mem_delta_kb AS "memDeltaKb", legs, plan, pushed, warnings, created_at AS "createdAt"
       FROM fabric_system.query_logs WHERE tenant_id=$1 AND id=$2`, [tenantId, id]);
    return rows[0] || null;
  }

  /**
   * Aggregate professional query usage analytics per user, per role/user-type,
   * and across time windows for a given tenant workspace.
   */
  static async getUsageAnalytics(tenantId: string): Promise<any> {
    await this.ensureTable();
    try {
      // 1. Overall execution statistics
      const overallRes = await pool.query(`
        SELECT
          COUNT(*)::int AS total_queries,
          COUNT(*) FILTER (WHERE created_at >= NOW() - INTERVAL '24 hours')::int AS queries_24h,
          COUNT(*) FILTER (WHERE created_at >= NOW() - INTERVAL '7 days')::int AS queries_7d,
          COUNT(*) FILTER (WHERE status = 'SUCCESS')::int AS success_queries,
          COUNT(*) FILTER (WHERE status = 'ERROR')::int AS error_queries,
          COALESCE(ROUND(AVG(tat_ms)), 0)::int AS avg_tat_ms,
          COALESCE(SUM(row_count), 0)::bigint AS total_rows_processed,
          COALESCE(SUM(rows_scanned), 0)::bigint AS total_rows_scanned
        FROM fabric_system.query_logs
        WHERE tenant_id = $1`, [tenantId]);
      const overall = overallRes.rows[0] || {};
      const totalQ = Number(overall.total_queries || 0);
      const successQ = Number(overall.success_queries || 0);
      overall.success_rate_pct = totalQ > 0 ? Math.round((successQ / totalQ) * 1000) / 10 : 100;

      // 2. Breakdown per user from logs
      const perUserRes = await pool.query(`
        SELECT
          COALESCE(username, 'anonymous') AS username,
          COALESCE(role, 'MEMBER') AS role,
          COUNT(*)::int AS query_count,
          COUNT(*) FILTER (WHERE created_at >= NOW() - INTERVAL '24 hours')::int AS queries_24h,
          COALESCE(ROUND(AVG(tat_ms)), 0)::int AS avg_tat_ms,
          COALESCE(SUM(row_count), 0)::bigint AS rows_processed,
          MAX(created_at) AS last_active_at
        FROM fabric_system.query_logs
        WHERE tenant_id = $1
        GROUP BY username, role
        ORDER BY query_count DESC`, [tenantId]);

      // 3. Registered workspace users (ensure all users appear even with 0 queries)
      const registeredUsers = (await pool.query(`
        SELECT id, username, role, status, created_at
        FROM public.users
        WHERE tenant_id = $1
        ORDER BY created_at ASC`, [tenantId])).rows;

      const userMap = new Map<string, any>();
      for (const u of registeredUsers) {
        userMap.set(u.username, {
          username: u.username,
          email: u.email || `${u.username}@fabric.local`,
          role: u.role || 'MEMBER',
          status: u.status || 'ACTIVE',
          query_count: 0,
          queries_24h: 0,
          avg_tat_ms: 0,
          rows_processed: 0,
          last_active_at: null,
          joined_at: u.created_at,
        });
      }

      for (const logUser of perUserRes.rows) {
        const existing = userMap.get(logUser.username);
        if (existing) {
          existing.query_count = Number(logUser.query_count || 0);
          existing.queries_24h = Number(logUser.queries_24h || 0);
          existing.avg_tat_ms = Number(logUser.avg_tat_ms || 0);
          existing.rows_processed = Number(logUser.rows_processed || 0);
          existing.last_active_at = logUser.last_active_at;
          if (logUser.role) existing.role = logUser.role;
        } else {
          userMap.set(logUser.username, {
            username: logUser.username,
            email: `${logUser.username}@fabric.local`,
            role: logUser.role || 'MEMBER',
            status: 'ACTIVE',
            query_count: Number(logUser.query_count || 0),
            queries_24h: Number(logUser.queries_24h || 0),
            avg_tat_ms: Number(logUser.avg_tat_ms || 0),
            rows_processed: Number(logUser.rows_processed || 0),
            last_active_at: logUser.last_active_at,
            joined_at: null,
          });
        }
      }

      const usersList = Array.from(userMap.values()).sort((a, b) => b.query_count - a.query_count);

      // 4. Breakdown per user type / role
      const roleCounts: Record<string, { queries: number; users: Set<string>; avg_tat: number }> = {
        ADMIN: { queries: 0, users: new Set(), avg_tat: 0 },
        DEVELOPER: { queries: 0, users: new Set(), avg_tat: 0 },
        ANALYST: { queries: 0, users: new Set(), avg_tat: 0 },
        VIEWER: { queries: 0, users: new Set(), avg_tat: 0 },
      };

      for (const u of usersList) {
        const rKey = (u.role || 'VIEWER').toUpperCase();
        if (!roleCounts[rKey]) roleCounts[rKey] = { queries: 0, users: new Set(), avg_tat: 0 };
        roleCounts[rKey].users.add(u.username);
        roleCounts[rKey].queries += u.query_count;
      }

      const perRole = Object.entries(roleCounts).map(([role, val]) => ({
        role,
        query_count: val.queries,
        user_count: val.users.size,
        query_share_pct: totalQ > 0 ? Math.round((val.queries / totalQ) * 100) : 0,
      }));

      // 5. Breakdown per query mode (AST, CRUD, FETCH, etc.)
      const perModeRes = await pool.query(`
        SELECT
          mode,
          COUNT(*)::int AS count,
          COALESCE(ROUND(AVG(tat_ms)), 0)::int AS avg_tat_ms
        FROM fabric_system.query_logs
        WHERE tenant_id = $1
        GROUP BY mode
        ORDER BY count DESC
        LIMIT 10`, [tenantId]);

      // 6. Recent daily timeline (last 7 days)
      const dailyRes = await pool.query(`
        SELECT
          TO_CHAR(created_at, 'YYYY-MM-DD') AS day,
          COUNT(*)::int AS count,
          COUNT(*) FILTER (WHERE status = 'SUCCESS')::int AS success,
          COALESCE(ROUND(AVG(tat_ms)), 0)::int AS avg_tat_ms
        FROM fabric_system.query_logs
        WHERE tenant_id = $1 AND created_at >= NOW() - INTERVAL '7 days'
        GROUP BY TO_CHAR(created_at, 'YYYY-MM-DD')
        ORDER BY day ASC`, [tenantId]);

      return {
        overall,
        usersList,
        perRole,
        perMode: perModeRes.rows,
        dailyTrend: dailyRes.rows,
      };
    } catch (e: any) {
      console.error('[QueryLogService] getUsageAnalytics error:', e.message);
      return {
        overall: { total_queries: 0, queries_24h: 0, queries_7d: 0, success_queries: 0, error_queries: 0, avg_tat_ms: 0, total_rows_processed: 0, total_rows_scanned: 0, success_rate_pct: 100 },
        usersList: [],
        perRole: [],
        perMode: [],
        dailyTrend: [],
      };
    }
  }
}
