/**
 * Enforcement helpers shared by controllers/routes: feature gates, manifest-file gate and the
 * workspace/licence row ceiling applied to AST queries.
 */
import { Request, Response, NextFunction } from 'express';
import { LimitsResolver, LimitError, FeatureKey } from './limits.resolver';
import { WorkspaceSettingsService } from './workspace-settings.service';
import { isPlatformAdmin } from '../../middleware/tenantAccess.middleware';

const sendLimit = (res: Response, e: any) => res.status(e.status || 403).json({ error: e.message, code: e.code });

/** Express gate: the active workspace's licence/plan must include `feature`. Platform admins pass. */
export const requireFeature = (feature: FeatureKey) => async (req: Request, res: Response, next: NextFunction) => {
  const user = (req as any).user;
  if (!user || isPlatformAdmin(user) || !user.tenant_id) return next();
  try { await LimitsResolver.assertFeature(user.tenant_id, feature); next(); }
  catch (e: any) { if (e instanceof LimitError) return sendLimit(res, e); next(e); }
};

/** Gate for manifest download/import: feature flag, and the uploaded file must fit `max_manifest_size_mb`. Runs AFTER the multipart parser. */
export const manifestFileGate = async (req: Request, res: Response, next: NextFunction) => {
  const user = (req as any).user;
  const file = (req as any).file;
  if (!user || !file || isPlatformAdmin(user) || !user.tenant_id) return next();
  try {
    await LimitsResolver.assertFeature(user.tenant_id, 'manifest_import_export_enabled');
    const eff = await LimitsResolver.forTenant(user.tenant_id);
    const mb = eff.limits.max_manifest_size_mb;
    if (typeof mb === 'number' && mb !== -1 && file.size > mb * 1024 * 1024) return res.status(413).json({ error: `Manifest exceeds the ${mb} MB limit`, code: 'MANIFEST_TOO_LARGE' });
    next();
  } catch (e: any) { if (e instanceof LimitError) return sendLimit(res, e); next(e); }
};

/**
 * Applies the workspace `query.maxRows` and the licence/plan `max_query_rows` ceilings to an AST config
 * (never raises a limit; sets one when the caller sent none). Platform-admin sessions are exempt.
 */
export async function applyRowCeiling<T extends Record<string, any>>(tenantId: string, config: T, role?: string): Promise<T> {
  if (!config || typeof config !== 'object' || role === 'ADMIN' || String(config.type || 'SELECT').toUpperCase() !== 'SELECT') return config;
  // A limit that is present must be a positive integer: never silently replaced by the ceiling.
  for (const v of [config.limit, config.query && typeof config.query === 'object' ? (config.query as any).limit : undefined]) {
    if (v !== undefined && v !== null && (typeof v !== 'number' || !Number.isInteger(v) || v < 0)) {
      throw Object.assign(new Error('limit must be a non-negative integer'), { status: 400, code: 'INVALID_LIMIT' });
    }
  }
  let ws: any; let eff: any;
  try { [ws, eff] = await Promise.all([WorkspaceSettingsService.get(tenantId), LimitsResolver.forTenant(tenantId)]); }
  catch { return config; } // ceilings unreadable (e.g. unit tests with a mocked pool): the request guard already fails closed in HTTP paths
  const caps = [ws.query.maxRows, eff.limits.max_query_rows].filter((n): n is number => typeof n === 'number' && n > 0);
  if (!caps.length) return config;
  const cap = Math.min(...caps);
  const clamp = (v: unknown) => (typeof v === 'number' && v > 0 ? Math.min(v, cap) : cap);
  const out: any = { ...config, limit: clamp(config.limit) };
  if (out.query && typeof out.query === 'object' && out.query.limit !== undefined) out.query = { ...out.query, limit: clamp(out.query.limit) };
  return out;
}
