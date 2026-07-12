/**
 * @module controllers/savedAnalyticsController
 * @description Saved-analytics control plane: define reusable, parameterized analytics
 * (AST or SQL, with `({variable})` bindings) and run/trigger them on demand. Every run
 * is captured to the query log via `QueryLogService.capture` under mode `SAVED_ANALYTIC`.
 */

import { Request, Response } from 'express';
import { SavedAnalyticsService, SavedAnalytic } from '../modules/query-engine/analytics.service';
import { QueryLogService } from '../modules/query-engine/query-log.service';

/**
 * Build the query-engine execution session for the current request: tenant,
 * effective role (honoring ADMIN "view as" via `x-act-as-role`), region, and username.
 *
 * @param req - Express request. Reads `(req as any).user` (tenant_id, internal_role,
 *   role, username) and headers `x-act-as-role` (ADMIN-only role override) and
 *   `x-region` (falls back to `DEFAULT_REGION` env var, then `'AP'`).
 * @returns Session object `(tenantId, role, region, username)` passed through to
 *   `SavedAnalyticsService.run` and the query log.
 */
function sessionOf(req: Request) {
  const u = (req as any).user || {};
  const actAs = u.internal_role === 'ADMIN' ? (req.headers['x-act-as-role'] as string) : undefined;
  return {
    tenantId: u.tenant_id,
    role: actAs || u.internal_role || u.role,
    region: (req.headers['x-region'] as string) || process.env.DEFAULT_REGION || 'AP',
    username: u.username,
  };
}

/**
 * List all saved analytics defined for the caller's tenant.
 *
 * @param req - Express request. Reads tenant from `(req as any).user?.tenant_id`.
 * @param res - Express response.
 * @returns 200 with the array of saved-analytic definitions from `SavedAnalyticsService.list`.
 * @throws Responds 500 `(error)` if the lookup fails.
 */
export const listAnalytics = async (req: Request, res: Response) => {
  try { res.json(await SavedAnalyticsService.list((req as any).user?.tenant_id)); }
  catch (err: any) { res.status(500).json({ error: err.message }); }
};

/**
 * List the most frequently/recently used saved analytics for the caller's tenant
 * (used to populate a "top analytics" shortcut list in the UI).
 *
 * @param req - Express request. Reads tenant from `(req as any).user?.tenant_id`.
 *   Query param `limit` (number, defaults to 8) caps the result count.
 * @param res - Express response.
 * @returns 200 with the array of top saved analytics from `SavedAnalyticsService.top`.
 * @throws Responds 500 `(error)` if the lookup fails.
 */
export const topAnalytics = async (req: Request, res: Response) => {
  try { res.json(await SavedAnalyticsService.top((req as any).user?.tenant_id, Number(req.query.limit) || 8)); }
  catch (err: any) { res.status(500).json({ error: err.message }); }
};

/**
 * Fetch a single saved analytic definition by id, scoped to the caller's tenant.
 *
 * @param req - Express request. Reads tenant from `(req as any).user?.tenant_id`.
 *   `req.params.id` is the analytic id.
 * @param res - Express response.
 * @returns 200 with the analytic definition from `SavedAnalyticsService.get`.
 * @throws Responds 404 `(error: 'analytic not found')` when no matching analytic
 *   exists for the tenant; 500 `(error)` on unexpected failures.
 */
export const getAnalytic = async (req: Request, res: Response) => {
  try {
    const a = await SavedAnalyticsService.get((req as any).user?.tenant_id, String(req.params.id));
    if (!a) return res.status(404).json({ error: 'analytic not found' });
    res.json(a);
  } catch (err: any) { res.status(500).json({ error: err.message }); }
};

/**
 * Create a new saved analytic (a named, reusable AST or SQL query template
 * with optional `({variable})` placeholders) for the caller's tenant.
 *
 * @param req - Express request. Reads tenant and username from `(req as any).user`
 *   (username defaults to `'system'`). Body is a `SavedAnalytic`: `name` (string,
 *   required) plus the query definition (AST or SQL) and variable bindings.
 * @param res - Express response.
 * @returns 201 with the created analytic record from `SavedAnalyticsService.create`.
 * @throws Responds 400 `(error)` when `name` is missing or the service otherwise
 *   throws a "required"-style validation error; 500 `(error)` on unexpected failures.
 */
export const createAnalytic = async (req: Request, res: Response) => {
  try {
    const u = (req as any).user || {};
    const body = req.body as SavedAnalytic;
    if (!body?.name) return res.status(400).json({ error: 'name is required' });
    res.status(201).json(await SavedAnalyticsService.create(u.tenant_id, u.username || 'system', body));
  } catch (err: any) {
    const code = /required/.test(err.message) ? 400 : 500;
    res.status(code).json({ error: err.message });
  }
};

/**
 * Delete a saved analytic by id, scoped to the caller's tenant.
 *
 * @param req - Express request. Reads tenant from `(req as any).user?.tenant_id`.
 *   `req.params.id` is the analytic id to delete.
 * @param res - Express response.
 * @returns 200 `(status: 'DELETED', id)` when the analytic existed and was removed.
 * @throws Responds 404 `(error: 'analytic not found')` when no matching analytic
 *   exists for the tenant; 500 `(error)` on unexpected failures.
 */
export const deleteAnalytic = async (req: Request, res: Response) => {
  try {
    const ok = await SavedAnalyticsService.remove((req as any).user?.tenant_id, String(req.params.id));
    if (!ok) return res.status(404).json({ error: 'analytic not found' });
    res.json({ status: 'DELETED', id: String(req.params.id) });
  } catch (err: any) { res.status(500).json({ error: err.message }); }
};

/**
 * Run a saved analytic, substituting `({variable})` placeholders with the
 * supplied values, and capture the execution to the query log under mode
 * `SAVED_ANALYTIC`. Honors ADMIN "view as" via `x-act-as-role` when building
 * the execution session (see (@link sessionOf)).
 *
 * @param req - Express request. `req.params.id` is the analytic id to run.
 *   Body: `(variables: (...))`, or the variables object directly as the body.
 *   Headers: `x-act-as-role` (ADMIN-only role override), `x-region` (execution region).
 * @param res - Express response.
 * @returns 200 with the query result/plan envelope produced by `SavedAnalyticsService.run`.
 * @throws Responds 404 `(error)` when the analytic id is not found; 400 `(error)`
 *   when a required `({variable})` binding is missing from the request; 500 `(error)`
 *   on unexpected failures.
 */
export const runAnalytic = async (req: Request, res: Response) => {
  try {
    const values = req.body?.variables || req.body || {};
    const s = sessionOf(req);
    const out = await QueryLogService.capture(
      { tenantId: s.tenantId, username: s.username, role: s.role, mode: 'SAVED_ANALYTIC', api: `/api/saved-analytics/${req.params.id}/run`, queryText: JSON.stringify({ analyticId: req.params.id, variables: values }) },
      () => SavedAnalyticsService.run(s.tenantId, String(req.params.id), values, s)
    );
    res.json(out);
  } catch (err: any) {
    const msg = err.message || 'error';
    if (/not found/.test(msg)) return res.status(404).json({ error: msg });
    if (/missing required variable/.test(msg)) return res.status(400).json({ error: msg });
    res.status(500).json({ error: msg });
  }
};
