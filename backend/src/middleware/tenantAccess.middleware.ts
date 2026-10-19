import { Request, Response, NextFunction } from 'express';
import { pool } from '../config/database';

/**
 * Workspace access levels (no membership table exists, so they derive from existing columns):
 *  - platform admin : users.role / JWT internal_role = ADMIN (every workspace; never limited by plans)
 *  - owner          : tenants.user_id = the caller's user id
 *  - member         : anyone else holding a token for the workspace (query, CRUD, AST)
 * API tokens are always members and can never be owners.
 */
export const isPlatformAdmin = (user: any) => !!user && user.internal_role === 'ADMIN' && user.auth_type !== 'api_token';

export async function isWorkspaceOwner(user: any, tenantId: string | null | undefined): Promise<boolean> {
  if (!user || user.auth_type === 'api_token' || !tenantId || !user.id) return false;
  const { rows } = await pool.query('SELECT 1 FROM public.tenants WHERE id = $1 AND user_id::text = $2', [tenantId, String(user.id)]);
  return rows.length > 0;
}

const deny = (res: Response, code: string, msg: string, status = 403) => res.status(status).json({ error: msg, code });

/** Platform administrator session only (no API tokens). */
export const requirePlatformAdmin = (req: Request, res: Response, next: NextFunction) => {
  const user = (req as any).user;
  if (!user) return deny(res, 'UNAUTHENTICATED', 'Authentication required', 401);
  if (!isPlatformAdmin(user)) return deny(res, 'FORBIDDEN', 'Platform admin privileges required');
  next();
};

/** Platform admin or the owner of the active workspace. Guards schema, connection, governance and workspace-settings changes. */
export const requireWorkspaceAdmin = async (req: Request, res: Response, next: NextFunction) => {
  const user = (req as any).user;
  if (!user) return deny(res, 'UNAUTHENTICATED', 'Authentication required', 401);
  if (isPlatformAdmin(user)) return next();
  try {
    if (await isWorkspaceOwner(user, user.tenant_id)) return next();
  } catch (e: any) {
    console.error('[TenantAccess]', e.message);
    return deny(res, 'INTERNAL', 'Internal error', 500);
  }
  return deny(res, 'WORKSPACE_ADMIN_REQUIRED', 'Only the workspace owner or a platform admin can do this');
};
