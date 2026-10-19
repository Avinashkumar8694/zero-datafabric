/**
 * @module routes/systemRoutes
 * @description Platform (system-level) administration, mounted at `/api/system`. Platform admin
 * session only (API tokens and ordinary users get 403). Covers system settings, the licence key,
 * the plan catalogue, workspaces (status, plan assignment with per-workspace overrides, trial
 * extension, owner change), plan requests, stats and the system event log. Every mutation is
 * written to public.system_events.
 */

import { Router, Request, Response } from 'express';
import { pool } from '../config/database';
import { requirePlatformAdmin } from '../middleware/tenantAccess.middleware';
import { SystemSettingsService } from '../modules/tenancy/system-settings.service';
import { LicenseManager, LicenseError } from '../modules/tenancy/license.manager';
import { LimitsResolver, LimitError, LIMIT_KEYS, FEATURE_KEYS } from '../modules/tenancy/limits.resolver';
import { SettingsError } from '../modules/tenancy/validate';
import { workspaceUsage } from '../modules/tenancy/usage';
import { clearWorkspaceStatusCache } from '../modules/tenancy/workspace.guard';
import { WorkspaceSettingsService } from '../modules/tenancy/workspace-settings.service';

const router = Router();
router.use(requirePlatformAdmin);

type Handled = Error & { status?: number; code?: string };
const wrap = (fn: (req: Request, res: Response) => Promise<any>) => async (req: Request, res: Response) => {
  try { await fn(req, res); }
  catch (e: any) {
    const err = e as Handled;
    if (err instanceof SettingsError || err instanceof LicenseError || err instanceof LimitError || (err.status && err.code)) return res.status(err.status || 400).json({ error: err.message, code: err.code });
    console.error('[System]', err.message);
    res.status(500).json({ error: 'Internal error', code: 'INTERNAL' });
  }
};
const fail = (status: number, code: string, message: string): never => { throw Object.assign(new Error(message), { status, code }); };
const actor = (req: Request) => (req as any).user?.username || 'unknown';
const event = (a: string, action: string, tenantId: string | null, detail: object) =>
  pool.query('INSERT INTO public.system_events (actor, action, tenant_id, detail) VALUES ($1,$2,$3,$4)', [a, action, tenantId, JSON.stringify(detail)]).catch(() => {});
const UUID_RE = /^[0-9a-f-]{36}$/i;
const TENANT_PARAM = /^[A-Za-z][A-Za-z0-9_]{1,40}$/;
const tenantParam = (req: Request) => { const id = String(req.params.id); if (!TENANT_PARAM.test(id)) fail(404, 'WORKSPACE_NOT_FOUND', 'workspace not found'); return id; };

// ── System settings ───────────────────────────────────────────────────────────
router.get('/settings', wrap(async (_req, res) => { res.json(await SystemSettingsService.get()); })); // GET /api/system/settings — platform-wide settings
router.put('/settings', wrap(async (req, res) => { res.json(await SystemSettingsService.update(req.body, actor(req))); })); // PUT /api/system/settings — partial update (strict validation)

// ── Licence ───────────────────────────────────────────────────────────────────
router.get('/license', wrap(async (_req, res) => { res.json({ ...LicenseManager.view(await LicenseManager.current()), instanceId: await LicenseManager.instanceId() }); })); // GET /api/system/license — status, limits, features (never the key)
router.post('/license', wrap(async (req, res) => { const st = await LicenseManager.install(req.body?.licenseKey, actor(req)); LimitsResolver.invalidate(); res.status(201).json(LicenseManager.view(st)); })); // POST /api/system/license — verify + install a key
router.delete('/license', wrap(async (req, res) => { const st = await LicenseManager.remove(actor(req)); LimitsResolver.invalidate(); res.json(LicenseManager.view(st)); })); // DELETE /api/system/license — remove the installed key
router.post('/license/validate', wrap(async (_req, res) => { LicenseManager.clearCache(); LimitsResolver.invalidate(); res.json(LicenseManager.view(await LicenseManager.current())); })); // POST /api/system/license/validate — re-evaluate now

// ── Plans ─────────────────────────────────────────────────────────────────────
const PLAN_STATUS = ['active', 'disabled', 'hidden', 'upcoming'];
function cleanPlan(b: any, partial: boolean) {
  if (!b || typeof b !== 'object' || Array.isArray(b)) fail(400, 'INVALID_PLAN', 'body must be an object');
  const allowed = ['name', 'description', 'price_monthly', 'limits', 'features', 'is_default', 'is_custom', 'status', 'contact_config', 'max_tenants'];
  const unknown = Object.keys(b).filter(k => !allowed.includes(k));
  if (unknown.length) fail(400, 'INVALID_PLAN', `unknown field(s): ${unknown.join(', ')}`);
  const out: any = {};
  if (!partial || b.name !== undefined) { if (typeof b.name !== 'string' || !/^[A-Za-z0-9_-]{2,50}$/.test(b.name)) fail(400, 'INVALID_PLAN', 'name must be 2-50 chars: letters, digits, _ and -'); out.name = b.name; }
  if (b.description !== undefined) { if (typeof b.description !== 'string' || b.description.length > 500) fail(400, 'INVALID_PLAN', 'description must be a string up to 500 chars'); out.description = b.description; }
  if (b.price_monthly !== undefined) { if (typeof b.price_monthly !== 'number' || !(b.price_monthly >= 0 && b.price_monthly <= 1_000_000)) fail(400, 'INVALID_PLAN', 'price_monthly must be a number between 0 and 1000000'); out.price_monthly = b.price_monthly; }
  if (b.limits !== undefined) {
    if (!b.limits || typeof b.limits !== 'object' || Array.isArray(b.limits)) fail(400, 'INVALID_PLAN', 'limits must be an object');
    for (const [k, v] of Object.entries(b.limits)) { if (!(LIMIT_KEYS as readonly string[]).includes(k)) fail(400, 'INVALID_PLAN', `unknown limit "${k}"`); if (!Number.isInteger(v) || (v as number) < -1) fail(400, 'INVALID_PLAN', `limit "${k}" must be an integer >= -1`); }
    out.limits = b.limits;
  } else if (!partial) fail(400, 'INVALID_PLAN', 'limits is required');
  if (b.features !== undefined) {
    if (!b.features || typeof b.features !== 'object' || Array.isArray(b.features)) fail(400, 'INVALID_PLAN', 'features must be an object');
    for (const [k, v] of Object.entries(b.features)) {
      if (k === 'trial_period_days') { if (!Number.isInteger(v) || (v as number) < -1 || (v as number) > 3650) fail(400, 'INVALID_PLAN', 'trial_period_days must be -1..3650'); }
      else if (!(FEATURE_KEYS as readonly string[]).includes(k)) fail(400, 'INVALID_PLAN', `unknown feature "${k}"`);
      else if (typeof v !== 'boolean') fail(400, 'INVALID_PLAN', `feature "${k}" must be a boolean`);
    }
    out.features = b.features;
  } else if (!partial) fail(400, 'INVALID_PLAN', 'features is required');
  for (const k of ['is_default', 'is_custom']) if (b[k] !== undefined) { if (typeof b[k] !== 'boolean') fail(400, 'INVALID_PLAN', `${k} must be a boolean`); out[k] = b[k]; }
  if (b.status !== undefined) { if (!PLAN_STATUS.includes(b.status)) fail(400, 'INVALID_PLAN', `status must be one of ${PLAN_STATUS.join(', ')}`); out.status = b.status; }
  if (b.contact_config !== undefined) { if (b.contact_config !== null && (typeof b.contact_config !== 'object' || JSON.stringify(b.contact_config).length > 2000)) fail(400, 'INVALID_PLAN', 'contact_config must be an object up to 2KB'); out.contact_config = b.contact_config; }
  if (b.max_tenants !== undefined) { if (!Number.isInteger(b.max_tenants) || b.max_tenants < -1) fail(400, 'INVALID_PLAN', 'max_tenants must be an integer >= -1'); out.max_tenants = b.max_tenants; }
  return out;
}

router.get('/plans', wrap(async (_req, res) => { res.json((await pool.query('SELECT * FROM public.plans ORDER BY price_monthly ASC, name ASC')).rows); })); // GET /api/system/plans — full catalogue
router.post('/plans', wrap(async (req, res) => {
  const p = cleanPlan(req.body, false);
  if (p.is_default && (p.is_custom || (p.status && p.status !== 'active'))) fail(400, 'INVALID_PLAN', 'the default plan must be active and not custom');
  try {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      if (p.is_default) await client.query('UPDATE public.plans SET is_default = false');
      const r = await client.query(
        `INSERT INTO public.plans (name, description, price_monthly, limits, features, is_default, is_custom, status, contact_config, max_tenants)
         VALUES ($1,$2,COALESCE($3,0),$4,$5,COALESCE($6,false),COALESCE($7,false),COALESCE($8,'active'),$9,COALESCE($10,-1)) RETURNING *`,
        [p.name, p.description ?? null, p.price_monthly ?? null, JSON.stringify(p.limits), JSON.stringify(p.features), p.is_default ?? null, p.is_custom ?? null, p.status ?? null, p.contact_config ? JSON.stringify(p.contact_config) : null, p.max_tenants ?? null]);
      await client.query('COMMIT');
      LimitsResolver.invalidate(); SystemSettingsService.clearCache();
      await event(actor(req), 'PLAN_CREATED', null, { name: p.name });
      res.status(201).json(r.rows[0]);
    } catch (e) { await client.query('ROLLBACK'); throw e; } finally { client.release(); }
  } catch (e: any) { if (e.code === '23505') fail(409, 'PLAN_EXISTS', 'a plan with this name already exists'); throw e; }
})); // POST /api/system/plans — create a plan
router.put('/plans/:id', wrap(async (req, res) => {
  const id = String(req.params.id); if (!UUID_RE.test(id)) fail(404, 'PLAN_NOT_FOUND', 'plan not found');
  const p = cleanPlan(req.body, true);
  const cur = (await pool.query('SELECT * FROM public.plans WHERE id = $1', [id])).rows[0];
  if (!cur) fail(404, 'PLAN_NOT_FOUND', 'plan not found');
  const next = { ...cur, ...p };
  if (next.is_default && (next.is_custom || (next.status || 'active') !== 'active')) fail(400, 'INVALID_PLAN', 'the default plan must be active and not custom');
  if (cur.is_default && (p.is_default === false)) fail(400, 'INVALID_PLAN', 'make another plan the default instead of unsetting this one');
  const sets: string[] = []; const vals: any[] = [id];
  for (const [k, v] of Object.entries(p)) { vals.push(k === 'limits' || k === 'features' || k === 'contact_config' ? JSON.stringify(v) : v); sets.push(`${k} = $${vals.length}`); }
  if (!sets.length) fail(400, 'INVALID_PLAN', 'nothing to update');
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    if (p.is_default) await client.query('UPDATE public.plans SET is_default = false WHERE id <> $1', [id]);
    const r = await client.query(`UPDATE public.plans SET ${sets.join(', ')} WHERE id = $1 RETURNING *`, vals);
    await client.query('COMMIT');
    LimitsResolver.invalidate(); SystemSettingsService.clearCache();
    await event(actor(req), 'PLAN_UPDATED', null, { id, changed: Object.keys(p) });
    res.json(r.rows[0]);
  } catch (e: any) { await client.query('ROLLBACK'); if (e.code === '23505') fail(409, 'PLAN_EXISTS', 'a plan with this name already exists'); throw e; } finally { client.release(); }
})); // PUT /api/system/plans/:id — edit a plan
router.delete('/plans/:id', wrap(async (req, res) => {
  const id = String(req.params.id); if (!UUID_RE.test(id)) fail(404, 'PLAN_NOT_FOUND', 'plan not found');
  const cur = (await pool.query('SELECT * FROM public.plans WHERE id = $1', [id])).rows[0];
  if (!cur) fail(404, 'PLAN_NOT_FOUND', 'plan not found');
  if (cur.is_default) fail(409, 'PLAN_IN_USE', 'the default plan cannot be deleted');
  if (['trial', 'selfhost'].includes(cur.name)) fail(409, 'PLAN_IN_USE', 'built-in plans cannot be deleted; disable or hide them instead');
  const used = (await pool.query('SELECT (SELECT COUNT(*) FROM public.tenants WHERE plan_name = $1) + (SELECT COUNT(*) FROM public.subscriptions WHERE plan_id = $2) AS n', [cur.name, id])).rows[0].n;
  if (Number(used) > 0) fail(409, 'PLAN_IN_USE', `${used} workspace(s)/subscription(s) use this plan; move them first`);
  await pool.query('DELETE FROM public.plans WHERE id = $1', [id]);
  LimitsResolver.invalidate();
  await event(actor(req), 'PLAN_DELETED', null, { id, name: cur.name });
  res.status(204).end();
})); // DELETE /api/system/plans/:id — delete an unused, non-default plan

// ── Workspaces ────────────────────────────────────────────────────────────────
router.get('/workspaces', wrap(async (req, res) => {
  const limit = Math.min(Math.max(parseInt(String(req.query.limit || '50'), 10) || 50, 1), 200);
  const offset = Math.max(parseInt(String(req.query.offset || '0'), 10) || 0, 0);
  const conds: string[] = []; const vals: any[] = [];
  if (req.query.status) { vals.push(String(req.query.status).toUpperCase()); conds.push(`UPPER(t.status) = $${vals.length}`); }
  if (req.query.plan) { vals.push(String(req.query.plan)); conds.push(`t.plan_name = $${vals.length}`); }
  if (req.query.search) { vals.push(`%${String(req.query.search).replace(/[\\%_]/g, c => '\\' + c)}%`); conds.push(`(t.id ILIKE $${vals.length} OR t.name ILIKE $${vals.length})`); }
  const where = conds.length ? `WHERE ${conds.join(' AND ')}` : '';
  const total = (await pool.query(`SELECT COUNT(*) FROM public.tenants t ${where}`, vals)).rows[0].count;
  vals.push(limit, offset);
  const { rows } = await pool.query(
    `SELECT t.id, t.name, t.status, t.plan_name AS "plan", t.plan_expires_at AS "planExpiresAt", t.user_id AS "ownerUserId", u.username AS "ownerUsername", t.created_at AS "createdAt"
     FROM public.tenants t LEFT JOIN public.users u ON u.id = t.user_id ${where} ORDER BY t.created_at DESC LIMIT $${vals.length - 1} OFFSET $${vals.length}`, vals);
  res.json({ total: Number(total), limit, offset, workspaces: rows });
})); // GET /api/system/workspaces — list/filter workspaces

router.get('/workspaces/:id', wrap(async (req, res) => {
  const id = tenantParam(req);
  const t = (await pool.query('SELECT id, name, status, plan_name, plan_started_at, plan_expires_at, plan_overrides, user_id, created_at, settings FROM public.tenants WHERE id = $1', [id])).rows[0];
  if (!t) fail(404, 'WORKSPACE_NOT_FOUND', 'workspace not found');
  res.json({ workspace: t, effective: await LimitsResolver.forTenant(id), usage: await workspaceUsage(id) });
})); // GET /api/system/workspaces/:id — detail with effective limits and usage

router.put('/workspaces/:id', wrap(async (req, res) => {
  const id = tenantParam(req); const b = req.body || {};
  const unknown = Object.keys(b).filter(k => !['name', 'status'].includes(k)); if (unknown.length) fail(400, 'INVALID_WORKSPACE', `unknown field(s): ${unknown.join(', ')}`);
  const sets: string[] = []; const vals: any[] = [id];
  if (b.name !== undefined) { if (typeof b.name !== 'string' || !b.name.trim() || b.name.length > 100) fail(400, 'INVALID_WORKSPACE', 'name must be 1-100 characters'); vals.push(b.name.trim()); sets.push(`name = $${vals.length}`); }
  if (b.status !== undefined) { if (!['ACTIVE', 'SUSPENDED'].includes(String(b.status).toUpperCase())) fail(400, 'INVALID_WORKSPACE', 'status must be ACTIVE or SUSPENDED'); vals.push(String(b.status).toUpperCase()); sets.push(`status = $${vals.length}`); }
  if (!sets.length) fail(400, 'INVALID_WORKSPACE', 'nothing to update');
  const r = await pool.query(`UPDATE public.tenants SET ${sets.join(', ')} WHERE id = $1 RETURNING id, name, status`, vals);
  if (!r.rows[0]) fail(404, 'WORKSPACE_NOT_FOUND', 'workspace not found');
  clearWorkspaceStatusCache(id); LimitsResolver.invalidate(id);
  await event(actor(req), 'WORKSPACE_UPDATED', id, b);
  res.json(r.rows[0]);
})); // PUT /api/system/workspaces/:id — rename / suspend / activate

router.put('/workspaces/:id/plan', wrap(async (req, res) => {
  const id = tenantParam(req); const b = req.body || {};
  const unknown = Object.keys(b).filter(k => !['plan', 'expiresAt', 'overrides'].includes(k)); if (unknown.length) fail(400, 'INVALID_PLAN_ASSIGNMENT', `unknown field(s): ${unknown.join(', ')}`);
  if (typeof b.plan !== 'string') fail(400, 'INVALID_PLAN_ASSIGNMENT', 'plan (name) is required');
  const plan = (await pool.query('SELECT name FROM public.plans WHERE name = $1', [b.plan])).rows[0];
  if (!plan) fail(404, 'PLAN_NOT_FOUND', 'plan not found');
  let expires: Date | null = null;
  if (b.expiresAt !== undefined && b.expiresAt !== null) { expires = new Date(b.expiresAt); if (isNaN(expires.getTime()) || expires.getTime() < Date.now() - 86_400_000) fail(400, 'INVALID_PLAN_ASSIGNMENT', 'expiresAt must be a valid future date'); }
  const overrides: Record<string, number> = {};
  if (b.overrides !== undefined) {
    if (!b.overrides || typeof b.overrides !== 'object' || Array.isArray(b.overrides)) fail(400, 'INVALID_PLAN_ASSIGNMENT', 'overrides must be an object');
    for (const [k, v] of Object.entries(b.overrides)) { if (!(LIMIT_KEYS as readonly string[]).includes(k) || !Number.isInteger(v) || (v as number) < -1) fail(400, 'INVALID_PLAN_ASSIGNMENT', `invalid override "${k}"`); overrides[k] = v as number; }
  }
  const r = await pool.query(
    `UPDATE public.tenants SET plan_name = $2, plan_started_at = NOW(), plan_expires_at = $3, plan_overrides = $4 WHERE id = $1 RETURNING id`,
    [id, plan.name, expires, JSON.stringify(overrides)]);
  if (!r.rows[0]) fail(404, 'WORKSPACE_NOT_FOUND', 'workspace not found');
  LimitsResolver.invalidate(id);
  await event(actor(req), 'WORKSPACE_PLAN_ASSIGNED', id, { plan: plan.name, expiresAt: expires, overrides });
  res.json(await LimitsResolver.forTenant(id));
})); // PUT /api/system/workspaces/:id/plan — assign plan (+ end date, per-workspace overrides; resets previous overrides)

router.post('/workspaces/:id/plan/extend', wrap(async (req, res) => {
  const id = tenantParam(req); const b = req.body || {};
  const cur = (await pool.query('SELECT plan_expires_at, plan_started_at, created_at FROM public.tenants WHERE id = $1', [id])).rows[0];
  if (!cur) fail(404, 'WORKSPACE_NOT_FOUND', 'workspace not found');
  let until: Date | undefined;
  if (b.until !== undefined) { until = new Date(b.until); if (isNaN(until.getTime())) fail(400, 'INVALID_EXTENSION', 'until must be a valid date'); }
  else if (Number.isInteger(b.days) && b.days >= 1 && b.days <= 3650) {
    const eff = await LimitsResolver.forTenant(id);
    const baseMs = Math.max(Date.now(), cur.plan_expires_at ? new Date(cur.plan_expires_at).getTime() : (eff.trial.endsAt ? new Date(eff.trial.endsAt).getTime() : Date.now()));
    until = new Date(baseMs + b.days * 86_400_000);
  }
  if (!until) fail(400, 'INVALID_EXTENSION', 'send days (1-3650) or until (date)');
  const end = until as Date;
  if (end.getTime() <= Date.now()) fail(400, 'INVALID_EXTENSION', 'the new end date must be in the future');
  await pool.query('UPDATE public.tenants SET plan_expires_at = $2 WHERE id = $1', [id, end]);
  LimitsResolver.invalidate(id);
  await event(actor(req), 'WORKSPACE_PLAN_EXTENDED', id, { until: end });
  res.json(await LimitsResolver.forTenant(id));
})); // POST /api/system/workspaces/:id/plan/extend — extend the trial/plan end

router.post('/workspaces/:id/owner', wrap(async (req, res) => {
  const id = tenantParam(req); const b = req.body || {};
  const u = typeof b.userId === 'string' && UUID_RE.test(b.userId)
    ? (await pool.query('SELECT id, username, tenant_id FROM public.users WHERE id = $1', [b.userId])).rows[0]
    : typeof b.username === 'string' ? (await pool.query('SELECT id, username, tenant_id FROM public.users WHERE username = $1', [b.username])).rows[0] : null;
  if (!u) fail(404, 'USER_NOT_FOUND', 'user not found');
  const r = await pool.query('UPDATE public.tenants SET user_id = $2 WHERE id = $1 RETURNING id', [id, u.id]);
  if (!r.rows[0]) fail(404, 'WORKSPACE_NOT_FOUND', 'workspace not found');
  LimitsResolver.invalidate(id);
  await event(actor(req), 'WORKSPACE_OWNER_CHANGED', id, { newOwner: u.username });
  res.json({ id, ownerUserId: u.id, ownerUsername: u.username });
})); // POST /api/system/workspaces/:id/owner — change the workspace owner

// ── Plan requests, stats, events ──────────────────────────────────────────────
router.get('/plan-requests', wrap(async (req, res) => {
  const status = req.query.status ? String(req.query.status) : 'open';
  if (!['open', 'approved', 'rejected', 'closed', 'all'].includes(status)) fail(400, 'INVALID_QUERY', 'invalid status');
  const { rows } = await pool.query(`SELECT r.*, t.name AS tenant_name FROM public.plan_requests r JOIN public.tenants t ON t.id = r.tenant_id ${status === 'all' ? '' : 'WHERE r.status = $1'} ORDER BY r.created_at DESC LIMIT 200`, status === 'all' ? [] : [status]);
  res.json(rows);
})); // GET /api/system/plan-requests — "contact us" requests
router.put('/plan-requests/:id', wrap(async (req, res) => {
  const id = String(req.params.id); if (!UUID_RE.test(id)) fail(404, 'REQUEST_NOT_FOUND', 'request not found');
  const status = req.body?.status; if (!['approved', 'rejected', 'closed'].includes(status)) fail(400, 'INVALID_REQUEST', 'status must be approved, rejected or closed');
  const r = await pool.query("UPDATE public.plan_requests SET status = $2, resolved_by = $3, resolved_at = NOW() WHERE id = $1 AND status = 'open' RETURNING *", [id, status, actor(req)]);
  if (!r.rows[0]) fail(404, 'REQUEST_NOT_FOUND', 'open request not found');
  await event(actor(req), 'PLAN_REQUEST_RESOLVED', r.rows[0].tenant_id, { id, status });
  res.json(r.rows[0]);
})); // PUT /api/system/plan-requests/:id — resolve a request
router.get('/stats', wrap(async (_req, res) => {
  const [t, p, u] = await Promise.all([
    pool.query('SELECT UPPER(status) AS status, COUNT(*)::int AS n FROM public.tenants GROUP BY 1'),
    pool.query("SELECT COALESCE(plan_name,'(default)') AS plan, COUNT(*)::int AS n FROM public.tenants GROUP BY 1"),
    pool.query('SELECT COUNT(*)::int AS n FROM public.users'),
  ]);
  res.json({ workspacesByStatus: t.rows, workspacesByPlan: p.rows, users: u.rows[0].n, license: LicenseManager.view(await LicenseManager.current()).status });
})); // GET /api/system/stats — counters
router.get('/events', wrap(async (req, res) => {
  const limit = Math.min(Math.max(parseInt(String(req.query.limit || '50'), 10) || 50, 1), 200);
  const tenant = req.query.tenantId ? String(req.query.tenantId) : null;
  const { rows } = await pool.query(`SELECT id, actor, action, tenant_id AS "tenantId", detail, created_at AS "createdAt" FROM public.system_events ${tenant ? 'WHERE tenant_id = $2' : ''} ORDER BY id DESC LIMIT $1`, tenant ? [limit, tenant] : [limit]);
  res.json(rows);
})); // GET /api/system/events — audit trail of system changes

export default router;
