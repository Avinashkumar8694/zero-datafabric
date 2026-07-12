/**
 * @module controllers/authController
 * @description Authentication endpoints: username/password login (issues the
 * initial bearer token) and tenant-scoped token exchange ("act as this tenant")
 * for users who belong to / administer more than one tenant.
 */

import { Request, Response } from 'express';
import { AuthService } from '../modules/auth/auth.service';

/**
 * Authenticate a user with a username/password pair and issue a bearer token.
 *
 * Delegates credential verification and token minting to `AuthService.login`.
 * Does not require an existing session — this is the public entry point used
 * by the login form.
 *
 * @param req - Express request. `req.body.username` and `req.body.password` are required.
 * @param res - Express response.
 * @returns 200 with the `AuthService.login` result (typically `{ token, user }`) on success;
 *   401 `{ error: 'Invalid credentials' }` when the credentials don't match; 500 `{ error }`
 *   on unexpected failures (e.g. database errors).
 */
export const login = async (req: Request, res: Response) => {
  const { username, password } = req.body;
  try {
    const result = await AuthService.login(username, password);
    if (result) return res.json(result);
    res.status(401).json({ error: 'Invalid credentials' });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
};

/**
 * Exchange the caller's current session for a new bearer token scoped to a
 * specific tenant. Used by multi-tenant users/admins to switch the active
 * tenant without re-entering credentials.
 *
 * Requires an already-authenticated request (populated by the auth
 * middleware onto `req.user`); the new token carries the same internal role
 * and username but is scoped to `tenantId`.
 *
 * @param req - Express request. Requires `(req as any).user` (from auth middleware,
 *   with `username` and `internal_role`). `req.body.tenantId` is required — the tenant
 *   to scope the new token to.
 * @param res - Express response.
 * @returns 200 `{ token }` with the newly minted, tenant-scoped bearer token.
 * @throws Responds 401 `{ error: 'Authentication required' }` when there is no
 *   authenticated user on the request; 400 `{ error: 'tenantId is required' }` when
 *   `tenantId` is missing from the body.
 */
export const refreshToken = (req: Request, res: Response) => {
  const user = (req as any).user;
  if (!user) return res.status(401).json({ error: 'Authentication required' });

  const { tenantId } = req.body;
  if (!tenantId) {
    console.warn(`[Auth] Token exchange failed: missing tenantId for user ${user.username}`);
    return res.status(400).json({ error: 'tenantId is required' });
  }
  const token = AuthService.generateToken(tenantId, user.internal_role, user.username || 'unknown');
  console.log(`[Auth] Issued tenant-scoped token for ${user.username} -> ${tenantId}`);
  res.json({ token });
};
