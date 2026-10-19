/**
 * @module routes/workspaceRoutes
 * @description Workspace-level (tenant) settings, limits and plan, mounted at `/api/workspace`.
 * Operates on the caller's ACTIVE workspace (JWT tenant; platform admins use x-tenant-id).
 * Reads are open to members; every change needs the workspace owner or a platform admin.
 * API tokens are rejected (user sessions only).
 */

import { Router, Request, Response, NextFunction } from 'express';
import { pool } from '../config/database';
import { isPlatformAdmin, isWorkspaceOwner, requireWorkspaceAdmin } from '../middleware/tenantAccess.middleware';
import { WorkspaceSettingsService, WORKSPACE_SECTIONS } from '../modules/tenancy/workspace-settings.service';
import { SystemSettingsService } from '../modules/tenancy/system-settings.service';
import { LimitsResolver, LimitError } from '../modules/tenancy/limits.resolver';
import { SettingsError } from '../modules/tenancy/validate';
import { workspaceUsage } from '../modules/tenancy/usage';
import { clearWorkspaceStatusCache } from '../modules/tenancy/workspace.guard';

const router = Router();

const sessionOnly = (req: Request, res: Response, next: NextFunction) => {
  const user = (req as any).user;
  if (!user) return res.status(401).json({ error: 'Authentication required', code: 'UNAUTHENTICATED' });
  if (user.auth_type === 'api_token') return res.status(403).json({ error: 'A user session is required', code: 'TOKEN_NOT_ALLOWED' });
  if (!user.tenant_id) return res.status(400).json({ error: 'No active workspace: exchange your session for a workspace token first', code: 'NO_WORKSPACE' });
  next();
};
router.use(sessionOnly);

const fail = (status: number, code: string, message: string): never => { throw Object.assign(new Error(message), { status, code }); };
const wrap = (fn: (req: Request, res: Response, tenantId: string) => Promise<any>) => async (req: Request, res: Response) => {
  try { await fn(req, res, (req as any).user.tenant_id); }
  catch (e: any) {
    if (e instanceof SettingsError || e instanceof LimitError || (e.status && e.code)) return res.status(e.status || 400).json({ error: e.message, code: e.code });
    console.error('[Workspace]', e.message);
    res.status(500).json({ error: 'Internal error', code: 'INTERNAL' });
  }
};

async function roleOf(user: any, tenantId: string) {
  if (isPlatformAdmin(user)) return 'platform_admin';
  return (await isWorkspaceOwner(user, tenantId)) ? 'owner' : 'member';
}

router.get('/', wrap(async (req, res, tenantId) => {
  const t = (await pool.query('SELECT id, name, status, user_id, created_at FROM public.tenants WHERE id = $1', [tenantId])).rows[0];
  if (!t) fail(404, 'WORKSPACE_NOT_FOUND', 'workspace not found');
  const eff = await LimitsResolver.forTenant(tenantId);
  res.json({
    workspace: { id: t.id, name: t.name, status: t.status, ownerUserId: t.user_id, createdAt: t.created_at },
    role: await roleOf((req as any).user, tenantId),
    settings: await WorkspaceSettingsService.get(tenantId),
    plan: eff.plan, trial: eff.trial, licence: eff.licence, features: eff.features,
  });
})); // GET /api/workspace — workspace, caller's role, settings, plan, licence summary

router.put('/', requireWorkspaceAdmin, wrap(async (req, res, tenantId) => {
  const name = req.body?.name;
  const unknown = Object.keys(req.body || {}).filter(k => k !== 'name'); if (unknown.length) fail(400, 'INVALID_WORKSPACE', `unknown field(s): ${unknown.join(', ')}`);
  if (typeof name !== 'string' || !name.trim() || name.length > 100) fail(400, 'INVALID_WORKSPACE', 'name must be 1-100 characters');
  const r = await pool.query('UPDATE public.tenants SET name = $2 WHERE id = $1 RETURNING id, name', [tenantId, name.trim()]);
  await pool.query('INSERT INTO public.system_events (actor, action, tenant_id, detail) VALUES ($1,$2,$3,$4)', [(req as any).user.username, 'WORKSPACE_RENAMED', tenantId, JSON.stringify({ name: name.trim() })]).catch(() => {});
  res.json(r.rows[0]);
})); // PUT /api/workspace — rename

router.get('/settings', wrap(async (_req, res, tenantId) => { res.json(await WorkspaceSettingsService.get(tenantId)); })); // GET /api/workspace/settings — all sections with defaults
router.put('/settings/:section', requireWorkspaceAdmin, wrap(async (req, res, tenantId) => {
  await LimitsResolver.assertFeature(tenantId, 'workspace_settings_enabled');
  const sys = await SystemSettingsService.get();
  const eff = await LimitsResolver.forTenant(tenantId);
  res.json(await WorkspaceSettingsService.updateSection(tenantId, String(req.params.section), req.body, (req as any).user.username, { maxTokenDays: sys.maxTokenDays, maxQueryRows: eff.limits.max_query_rows ?? -1 }));
})); // PUT /api/workspace/settings/:section — partial update of general|query|security|api|notifications

router.get('/limits', wrap(async (_req, res, tenantId) => {
  const eff = await LimitsResolver.forTenant(tenantId);
  res.json({ ...eff, usage: await workspaceUsage(tenantId) });
})); // GET /api/workspace/limits — effective limits, features, trial and current usage

router.get('/plans', wrap(async (_req, res) => {
  res.json((await pool.query("SELECT name, description, price_monthly, limits, features, is_default, is_custom, status, contact_config FROM public.plans WHERE COALESCE(status,'active') IN ('active','upcoming') AND name <> 'selfhost' ORDER BY price_monthly ASC, name ASC")).rows);
})); // GET /api/workspace/plans — plans a workspace may pick

router.put('/plan', requireWorkspaceAdmin, wrap(async (req, res, tenantId) => {
  const name = req.body?.plan;
  if (typeof name !== 'string') fail(400, 'INVALID_PLAN_SELECTION', 'plan (name) is required');
  const plan = (await pool.query("SELECT name, limits, features, is_custom, COALESCE(status,'active') AS status FROM public.plans WHERE name = $1", [name])).rows[0];
  if (!plan) fail(404, 'PLAN_NOT_FOUND', 'plan not found');
  const admin = isPlatformAdmin((req as any).user);
  if (!admin && (plan.status !== 'active' || plan.is_custom || plan.name === 'selfhost')) fail(403, 'PLAN_NOT_SELECTABLE', plan.is_custom ? 'This plan is by arrangement: send a plan request instead' : 'This plan cannot be selected');
  const t = (await pool.query('SELECT trial_used_at, plan_name FROM public.tenants WHERE id = $1', [tenantId])).rows[0];
  const trialDays = Number(plan.features?.trial_period_days ?? -1);
  if (!admin && trialDays > 0 && t?.trial_used_at && t.plan_name !== plan.name) fail(409, 'TRIAL_ALREADY_USED', 'This workspace already used its trial');
  if (!admin) {
    const usage = await workspaceUsage(tenantId); const problems: string[] = [];
    for (const [k, used] of Object.entries(usage)) { const lim = plan.limits?.[k]; if (used !== null && typeof lim === 'number' && lim !== -1 && used > lim) problems.push(`${k}: using ${used}, plan allows ${lim}`); }
    if (problems.length) return res.status(409).json({ error: 'The workspace uses more than this plan allows', code: 'PLAN_DOES_NOT_FIT', problems });
  }
  await pool.query('UPDATE public.tenants SET plan_name = $2, plan_started_at = NOW(), plan_expires_at = NULL, plan_overrides = $3, trial_used_at = CASE WHEN $4 THEN COALESCE(trial_used_at, NOW()) ELSE trial_used_at END WHERE id = $1',
    [tenantId, plan.name, '{}', trialDays > 0]);
  LimitsResolver.invalidate(tenantId);
  await pool.query('INSERT INTO public.system_events (actor, action, tenant_id, detail) VALUES ($1,$2,$3,$4)', [(req as any).user.username, 'WORKSPACE_PLAN_SELECTED', tenantId, JSON.stringify({ plan: plan.name })]).catch(() => {});
  res.json(await LimitsResolver.forTenant(tenantId));
})); // PUT /api/workspace/plan — switch to an active plan the usage fits in

router.post('/plan/requests', requireWorkspaceAdmin, wrap(async (req, res, tenantId) => {
  const { plan, message } = req.body || {};
  if (typeof plan !== 'string' || !/^[A-Za-z0-9_-]{2,50}$/.test(plan)) fail(400, 'INVALID_REQUEST', 'plan (name) is required');
  if (message !== undefined && (typeof message !== 'string' || message.length > 1000)) fail(400, 'INVALID_REQUEST', 'message must be a string up to 1000 characters');
  const open = (await pool.query("SELECT COUNT(*)::int AS n FROM public.plan_requests WHERE tenant_id = $1 AND status = 'open'", [tenantId])).rows[0].n;
  if (open >= 3) fail(429, 'TOO_MANY_REQUESTS', 'At most 3 open plan requests per workspace');
  const r = await pool.query('INSERT INTO public.plan_requests (tenant_id, requested_by, plan_name, message) VALUES ($1,$2,$3,$4) RETURNING id, plan_name, status, created_at', [tenantId, (req as any).user.username, plan, message ?? null]);
  res.status(201).json(r.rows[0]);
})); // POST /api/workspace/plan/requests — "contact us" request (max 3 open)

export { WORKSPACE_SECTIONS };
export default router;
