import { Request, Response, NextFunction } from 'express';
import { pool } from '../../config/database';
import { isPlatformAdmin } from '../../middleware/tenantAccess.middleware';
import { SystemSettingsService } from './system-settings.service';
import { WorkspaceSettingsService, ipAllowed } from './workspace-settings.service';
import { requestPolicy } from './request-context';

const statusCache = new Map<string, { at: number; status: string | null }>();
const TTL_MS = 5_000;

export function clearWorkspaceStatusCache(tenantId?: string) { if (tenantId) statusCache.delete(tenantId); else statusCache.clear(); }

async function tenantStatus(tenantId: string): Promise<string | null> {
  const hit = statusCache.get(tenantId);
  if (hit && Date.now() - hit.at < TTL_MS) return hit.status;
  const { rows } = await pool.query('SELECT status FROM public.tenants WHERE id = $1', [tenantId]);
  const status = rows[0] ? String(rows[0].status || 'ACTIVE').toUpperCase() : null;
  statusCache.set(tenantId, { at: Date.now(), status });
  return status;
}

/**
 * Runs for every authenticated /api request except auth/health/docs: maintenance mode, suspended or deleted
 * workspaces (sessions AND API tokens), and the workspace IP allow-list. Platform admins always pass.
 * Fails closed: if the checks cannot run, the request is refused with 503.
 */
export const workspaceGuard = async (req: Request, res: Response, next: NextFunction) => {
  const user = (req as any).user;
  if (!user || isPlatformAdmin(user)) return next();
  const p = req.path;
  if (p.startsWith('/auth') || p === '/health' || p.startsWith('/developer-docs') || p.startsWith('/settings/login')) return next();
  try {
    const sys = await SystemSettingsService.get();
    if (sys.maintenanceMode) return res.status(503).json({ error: sys.maintenanceMessage || 'The platform is in maintenance mode', code: 'MAINTENANCE' });
    const tenantId: string | null = user.tenant_id || null;
    if (!tenantId) return next();
    const status = await tenantStatus(tenantId);
    if (status === 'SUSPENDED') return res.status(403).json({ error: 'Workspace is suspended', code: 'TENANT_SUSPENDED' });
    if (status === null || status === 'DELETED') return res.status(403).json({ error: 'Workspace is not available', code: 'TENANT_NOT_AVAILABLE' });
    const settings = await WorkspaceSettingsService.get(tenantId);
    const sec = settings.security;
    if (Array.isArray(sec.allowedIps) && sec.allowedIps.length && !ipAllowed(req.ip, sec.allowedIps)) {
      return res.status(403).json({ error: 'Requests from this IP address are not allowed for this workspace', code: 'IP_NOT_ALLOWED' });
    }
    const timeoutMs = typeof settings.query.timeoutMs === 'number' ? settings.query.timeoutMs : undefined;
    requestPolicy.run({ timeoutMs, allowStreaming: settings.query.allowStreaming !== false }, () => next());
  } catch (e: any) {
    console.error('[WorkspaceGuard]', e.message);
    res.status(503).json({ error: 'Could not verify workspace access', code: 'GUARD_UNAVAILABLE' });
  }
};
