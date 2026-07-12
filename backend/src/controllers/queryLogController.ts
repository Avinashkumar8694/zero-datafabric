/**
 * @module controllers/queryLogController
 * @description Query execution audit trail — list recent query runs (captured by
 * `QueryLogService.capture` from `dataController`/`queryController`/`savedAnalyticsController`)
 * and inspect one in full, including its captured SQL/AST, plan, and outcome.
 */

import { Request, Response } from 'express';
import { QueryLogService } from '../modules/query-engine/query-log.service';

/**
 * List recent query-execution log entries for the caller's tenant, optionally
 * filtered by status or execution mode.
 *
 * @param req - Express request. Reads tenant from `(req as any).user?.tenant_id`.
 *   Query params: `limit` (number, defaults to 200), `status` (string, optional
 *   filter e.g. `SUCCESS`/`ERROR`), `mode` (string, optional filter e.g.
 *   `FETCH`/`CRUD_CREATE`/`SELECT_SQL`/`SAVED_ANALYTIC`).
 * @param res - Express response.
 * @returns 200 with the array of log entries from `QueryLogService.list`.
 * @throws Responds 500 `(error)` if the lookup fails.
 */
export const listQueryLogs = async (req: Request, res: Response) => {
  try {
    const tenantId = (req as any).user?.tenant_id;
    const opts: { limit?: number; status?: string; mode?: string } = { limit: Number(req.query.limit) || 200 };
    if (req.query.status) opts.status = String(req.query.status);
    if (req.query.mode) opts.mode = String(req.query.mode);
    res.json(await QueryLogService.list(tenantId, opts));
  } catch (err: any) { res.status(500).json({ error: err.message }); }
};

/**
 * Fetch a single query-execution log entry by id, scoped to the caller's tenant.
 *
 * @param req - Express request. Reads tenant from `(req as any).user?.tenant_id`.
 *   `req.params.id` is the log entry id.
 * @param res - Express response.
 * @returns 200 with the full log record from `QueryLogService.get`.
 * @throws Responds 404 `(error: 'query log not found')` when no matching entry
 *   exists for the tenant; 500 `(error)` on unexpected failures.
 */
export const getQueryLog = async (req: Request, res: Response) => {
  try {
    const log = await QueryLogService.get((req as any).user?.tenant_id, String(req.params.id));
    if (!log) return res.status(404).json({ error: 'query log not found' });
    res.json(log);
  } catch (err: any) { res.status(500).json({ error: err.message }); }
};
