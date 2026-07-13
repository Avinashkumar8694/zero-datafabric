import { Request, Response } from 'express';
import { QueryEngineService, QueryConfig } from './query-engine.service';
import { QueryLogService } from './query-log.service';
import { wantsStream, streamNdjson, pipeRowStream } from './stream';
import { tryStream } from './stream_source';
const { randomUUID } = require('crypto');

/**
 * QueryEngineController — HTTP entry point into the federation pipeline.
 * -----------------------------------------------------------------------
 * Thin Express layer that turns a request into a `QueryConfig`/session, hands it
 * to (@link QueryEngineService), and shapes the HTTP response. It owns none of
 * the query logic itself (planning, pushdown, federation) — its job is:
 *
 *   - resolve the caller's tenant/session (tenant id, effective role incl.
 *     admin "act as", region, username) from the authenticated request,
 *   - dispatch to `QueryEngineService.executeQuery` (sync), `executeAsyncQuery`
 *     (fire-and-forget job) or `refreshMaterializedView` (background refresh),
 *   - wrap every query in (@link QueryLogService.capture) so it lands in the
 *     audit trail regardless of which strategy the planner picked,
 *   - translate service-layer errors into HTTP status codes (403 for a
 *     suspended tenant, 500 otherwise).
 */
export class QueryEngineController {

  /**
   * POST handler: refresh a materialized view in the background.
   *
   * Kicks off (@link QueryEngineService.refreshMaterializedView) without
   * awaiting it and immediately returns 202 with a job id — refreshing a view
   * (especially non-concurrently) can take a long time, so the HTTP request
   * must not block on it. Failures are only logged server-side since the
   * response has already been sent.
   * @param req Express request; body: `(viewName, schema?, concurrent?)`, tenant from `req.user` or body.
   * @param res Express response.
   * @returns 202 with `(status, message, jobId)`, 400 if tenantId/viewName missing, 403 if tenant suspended, 500 on other errors.
   */
  static async refreshView(req: Request, res: Response) {
    try {
      const { viewName, schema = 'default', concurrent = true } = req.body;
      const tenantId = (req as any).user?.tenant_id || req.body.tenantId;

      if (!tenantId || !viewName) {
        return res.status(400).json({ error: 'tenantId and viewName are required' });
      }

      QueryEngineService.refreshMaterializedView(tenantId, viewName, concurrent, schema).catch(err => {
        console.error(`Background refresh failed for ${viewName} in ${schema}:`, err);
      });

      const jobId = randomUUID();

      return res.status(202).json({
        status: "accepted",
        message: "View refresh initiated in background",
        jobId: jobId
      });
    } catch (err: any) {
      if (err.message.toLowerCase().includes('suspended')) return res.status(403).json({ error: err.message });
      console.error(`[Query] Execution failed: ${err.message}`);
      return res.status(500).json({ error: err.message });
    }
  }

  /**
   * POST handler: execute a query config synchronously and return the result.
   *
   * Builds the session context (tenant, effective role — an ADMIN caller may
   * impersonate another role via the `x-act-as-role` header, region, username)
   * and derives a coarse `mode` label for the audit log (CALL / RECURSIVE /
   * SELECT_AST / the raw config type) purely for logging purposes — it does not
   * affect how the query is executed. The actual execution is wrapped in
   * (@link QueryLogService.capture) so timing/plan/trace are recorded whether
   * the query succeeds or fails.
   * @param req Express request; body: `(queryConfig)`, tenant from `req.user` or body.
   * @param res Express response.
   * @returns 200 with the service's result envelope (`(data, rowCount, plan?, warnings?)`,
   *   bare arrays are wrapped defensively), 400 if tenantId/queryConfig missing,
   *   403 if the tenant is suspended, 500 on other errors.
   */
  static async executeQuery(req: Request, res: Response) {
    const { queryConfig } = req.body;
    const tenantId = (req as any).user?.tenant_id || req.body.tenantId;
    try {
      if (!tenantId || !queryConfig) {
        return res.status(400).json({ error: 'tenantId and queryConfig are required' });
      }

      const u = (req as any).user || {};
      const actAs = (u.internal_role === 'ADMIN') ? (req.headers['x-act-as-role'] as string) : undefined;
      const session = {
        tenantId,
        role: actAs || u.internal_role || u.role,
        region: (req.headers['x-region'] as string) || process.env.DEFAULT_REGION || 'AP',
        username: u.username,
      };
      const qc: any = queryConfig;
      const mode = qc?.type === 'CALL' ? 'CALL'
        : qc?.query?.recursive ? 'RECURSIVE'
        : qc?.type === 'SELECT' ? 'SELECT_AST'
        : (qc?.type || 'QUERY');
      const logMeta = { tenantId, username: u.username, role: session.role, mode, api: '/api/analytics/query', queryText: JSON.stringify(queryConfig), source: qc?.query?.from?.source };

      // INTERNAL streaming: for a pass-through scan, pull rows from the source with a
      // cursor (bounded memory) and pipe them straight to the client — no full
      // materialization. Falls back to buffered/compute-then-stream for blocking shapes.
      if (wantsStream(req)) {
        const rs = await tryStream(tenantId, queryConfig, session);
        if (rs) { await pipeRowStream(req, res, rs, logMeta); return; }
      }

      const result = await QueryLogService.capture(logMeta,
        () => QueryEngineService.executeQuery(tenantId, queryConfig as QueryConfig, session)
      );
      // The service returns an enveloped object ({ data, rowCount, plan?, warnings? }) for
      // SELECT-family queries; pass it through so plan/warnings reach the client. Wrap only
      // bare arrays (defensive — legacy callers) to preserve the { data } contract.
      const payload = Array.isArray(result) ? { data: result } : result;
      // Opt-in response streaming: NDJSON rows + a {__meta__} trailer (plan/legs).
      if (wantsStream(req)) {
        return streamNdjson(res, payload.data || [], { rowCount: payload.rowCount, strategy: payload.plan?.strategy, plan: payload.plan, warnings: payload.warnings });
      }
      return res.status(200).json(payload);
    } catch (err: any) {
      if (err.message.toLowerCase().includes('suspended')) return res.status(403).json({ error: err.message });
      console.error(`[Query] Execution failed for tenant ${tenantId}: ${err.message}`, err.stack);
      return res.status(500).json({ error: err.message });
    }
  }

  /**
   * POST handler: enqueue a query config for asynchronous execution.
   *
   * Unlike (@link executeQuery), this does not await the result or route
   * through the audit log directly — it registers a job with
   * (@link QueryEngineService.executeAsyncQuery) (which runs the same
   * `executeQuery` path in the background) and returns its id immediately so
   * the caller can poll (@link getJobStatus).
   * @param req Express request; body: `(queryConfig)`, tenant from `req.user` or body.
   * @param res Express response.
   * @returns 202 with `(jobId, status: 'PENDING')`, 400 if tenantId/queryConfig missing, 500 on error.
   */
  static async executeAsyncQuery(req: Request, res: Response) {
    const { queryConfig } = req.body;
    const tenantId = (req as any).user?.tenant_id || req.body.tenantId;
    try {
      if (!tenantId || !queryConfig) {
        return res.status(400).json({ error: 'tenantId and queryConfig are required' });
      }

      const jobId = QueryEngineService.executeAsyncQuery(tenantId, queryConfig as QueryConfig);
      return res.status(202).json({ jobId, status: 'PENDING' });
    } catch (err: any) {
      console.error(`[Query-Async] Execution failed for tenant ${tenantId}: ${err.message}`);
      return res.status(500).json({ error: err.message });
    }
  }

  /**
   * GET handler: poll the status of an async job (query or raw-SQL execution).
   * @param req Express request; `req.params.jobId` identifies the job.
   * @param res Express response.
   * @returns 200 with `(jobId, status, result?, error?)`, 404 if the job id is unknown, 500 on error.
   */
  static async getJobStatus(req: Request, res: Response) {
    try {
      const jobId = req.params.jobId as string;
      const job = QueryEngineService.getJobStatus(jobId);
      
      if (job.status === 'NOT_FOUND') {
        return res.status(404).json(job);
      }
      
      return res.status(200).json(job);
    } catch (err: any) {
      if (err.message.toLowerCase().includes('suspended')) return res.status(403).json({ error: err.message });
      console.error(`[Query] Execution failed: ${err.message}`);
      return res.status(500).json({ error: err.message });
    }
  }
}
