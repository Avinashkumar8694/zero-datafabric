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
  try {
    const user = (req as any).user;
    const requestedTenant = isPlatformAdmin(user)
      ? ((req.headers['x-tenant-id'] as string) || (req.query.tenantId as string) || user.tenant_id)
      : user.tenant_id;
    await fn(req, res, requestedTenant);
  } catch (e: any) {
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

/**
 * GET /api/workspace/dashboard
 * Professional multi-tenant & role-aware usage analytics for the active workspace.
 * Automatically dynamically respects account switching when requested by platform admin.
 */
router.get('/dashboard', wrap(async (req, res, tenantId) => {
  const user = (req as any).user;
  const isSysAdmin = isPlatformAdmin(user);

  // 1. Workspace details
  const t = (await pool.query('SELECT id, name, status, user_id, plan_name, created_at FROM public.tenants WHERE id = $1', [tenantId])).rows[0];
  if (!t) fail(404, 'WORKSPACE_NOT_FOUND', 'workspace not found');

  // 2. Caller role & permissions in this workspace
  const workspaceRole = await roleOf(user, tenantId); // platform_admin | owner | member
  const userRow = (await pool.query('SELECT role, status FROM public.users WHERE username = $1 AND tenant_id = $2', [user.username, tenantId])).rows[0];
  const assignedRole = (userRow?.role || user.internal_role || (isSysAdmin ? 'ADMIN' : 'VIEWER')).toUpperCase();

  const permissions = {
    role: assignedRole,
    isOwner: workspaceRole === 'owner' || isSysAdmin,
    isPlatformAdmin: isSysAdmin,
    canExecuteQueries: true,
    canBuildAnalytics: ['ADMIN', 'DEVELOPER', 'ANALYST'].includes(assignedRole) || isSysAdmin,
    canManageConnections: ['ADMIN'].includes(assignedRole) || isSysAdmin,
    canManageUsers: ['ADMIN'].includes(assignedRole) || isSysAdmin,
    canManagePolicies: ['ADMIN'].includes(assignedRole) || isSysAdmin,
    canManageTriggers: ['ADMIN', 'DEVELOPER'].includes(assignedRole) || isSysAdmin,
    canManageReplication: ['ADMIN'].includes(assignedRole) || isSysAdmin,
    canSwitchPlan: workspaceRole === 'owner' || isSysAdmin,
    canViewAuditLogs: ['ADMIN'].includes(assignedRole) || isSysAdmin,
  };

  // 3. Plan & limits
  const eff = await LimitsResolver.forTenant(tenantId);
  const usageCounters = await workspaceUsage(tenantId);

  // 4. Usage analytics from query logs
  const { QueryLogService } = await import('../modules/query-engine/query-log.service');
  const queryAnalytics = await QueryLogService.getUsageAnalytics(tenantId);

  // 5. Personal usage for the calling user
  const personalLog = (await pool.query(`
    SELECT
      COUNT(*)::int AS my_queries_total,
      COUNT(*) FILTER (WHERE created_at >= NOW() - INTERVAL '24 hours')::int AS my_queries_24h,
      COALESCE(ROUND(AVG(tat_ms)), 0)::int AS my_avg_tat_ms,
      MAX(created_at) AS my_last_query_at
    FROM fabric_system.query_logs
    WHERE tenant_id = $1 AND username = $2`, [tenantId, user.username])).rows[0] || {};

  // 6. Security audits count in last 24h
  const auditsCount = (await pool.query(`
    SELECT COUNT(*)::int AS n FROM public.audit_logs
    WHERE changed_at >= NOW() - INTERVAL '24 hours' AND (tenant_id = $1 OR tenant_id IS NULL)`, [tenantId])).rows[0]?.n || 0;

  res.json({
    workspace: {
      id: t.id,
      name: t.name,
      status: t.status,
      ownerUserId: t.user_id,
      createdAt: t.created_at,
      isAccountSwitched: isSysAdmin && (req.headers['x-tenant-id'] !== undefined && req.headers['x-tenant-id'] !== (user.original_tenant_id || user.tenant_id)),
    },
    caller: {
      username: user.username,
      assignedRole,
      workspaceRole,
    },
    permissions,
    plan: {
      name: eff.plan.name,
      source: eff.plan.source,
      limits: eff.limits,
      features: eff.features,
      trial: eff.trial,
      licence: eff.licence,
      planLimitsEnabled: eff.planLimitsEnabled,
    },
    usage: {
      ...usageCounters,
      audits_24h: auditsCount,
      queries: queryAnalytics.overall,
    },
    userTypeBreakdown: queryAnalytics.perRole,
    userActivityTable: queryAnalytics.usersList,
    modeBreakdown: queryAnalytics.perMode,
    dailyTrend: queryAnalytics.dailyTrend,
    personalUsage: {
      queries_today: personalLog.my_queries_24h || 0,
      queries_total: personalLog.my_queries_total || 0,
      avg_tat_ms: personalLog.my_avg_tat_ms || 0,
      last_query_at: personalLog.my_last_query_at || null,
    },
  });
})); // GET /api/workspace/dashboard

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
