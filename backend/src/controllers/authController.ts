/**
 * @module controllers/authController
 * @description Authentication endpoints: username/password login (issues the
 * initial bearer token) and tenant-scoped token exchange ("act as this tenant")
 * for users who belong to / administer more than one tenant.
 */

import { Request, Response } from 'express';
import { AuthService } from '../modules/auth/auth.service';
import axios from 'axios';
import jwt from 'jsonwebtoken';
import { TenantService } from '../modules/tenant/tenant.service';
import { pool } from '../config/database';
import crypto from 'crypto';

/**
 * Authenticate a user with a username/password pair and issue a bearer token.
 *
 * Delegates credential verification and token minting to `AuthService.login`.
 * Does not require an existing session — this is the public entry point used
 * by the login form.
 *
 * @param req - Express request. `req.body.username` and `req.body.password` are required.
 * @param res - Express response.
 * @returns 200 with the `AuthService.login` result (typically `(token, user)`) on success;
 *   401 `(error: 'Invalid credentials')` when the credentials don't match; 500 `(error)`
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
 * @returns 200 `(token)` with the newly minted, tenant-scoped bearer token.
 * @throws Responds 401 `(error: 'Authentication required')` when there is no
 *   authenticated user on the request; 400 `(error: 'tenantId is required')` when
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

/**
 * Redirect user to OIDC provider login interface.
 */
export const sso = (req: Request, res: Response) => {
  const oidcUrl = `http://localhost:3000/oidc/auth?client_id=zero-datafabric&redirect_uri=http://localhost:4000/api/auth/sso/callback&response_type=code&scope=openid email profile&state=state_datafabric`;
  res.redirect(oidcUrl);
};

/**
 * Handle OIDC authentication callback, exchange authorization code,
 * auto-provision tenant/user, issue JWT and redirect back to UI.
 */
export const ssoCallback = async (req: Request, res: Response) => {
  const { code } = req.query;
  if (!code) {
    return res.status(400).json({ error: 'Authorization code is missing' });
  }

  try {
    const params = new URLSearchParams();
    params.append('grant_type', 'authorization_code');
    params.append('code', String(code));
    params.append('redirect_uri', 'http://localhost:4000/api/auth/sso/callback');
    params.append('client_id', 'zero-datafabric');
    params.append('client_secret', 'super-secret-key-fabric');

    const tokenRes = await axios.post('http://localhost:3000/oidc/token', params, {
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' }
    });

    const { id_token } = tokenRes.data;
    if (!id_token) {
      throw new Error('Identity provider did not return an ID token');
    }

    const decoded = jwt.decode(id_token) as any;
    if (!decoded || !decoded.email) {
      throw new Error('Could not decode user information from ID token');
    }

    const email = decoded.email.toLowerCase();
    
    // Check if user exists in public.users
    const userRes = await pool.query('SELECT * FROM public.users WHERE username = $1', [email]);
    
    let user;
    if (userRes.rows.length > 0) {
      user = userRes.rows[0];
      // Special case: make sure admin@fabrixly.com is ADMIN
      if (email === 'admin@fabrixly.com' && user.role !== 'ADMIN') {
        await pool.query("UPDATE public.users SET role = 'ADMIN', tenant_id = 'tenant_A' WHERE id = $1", [user.id]);
        user.role = 'ADMIN';
        user.tenant_id = 'tenant_A';
      }
    } else {
      // Auto-provision tenant & user
      let tenantId = 'tenant_A';
      let role = 'ADMIN';

      if (email !== 'admin@fabrixly.com') {
        const usernamePart = email.split('@')[0].replace(/[^a-zA-Z0-9]/g, '_').toLowerCase();
        const domainPart = email.split('@')[1]?.replace(/[^a-zA-Z0-9]/g, '_').toLowerCase() || '';
        tenantId = `t_${usernamePart}_${domainPart}`;
        role = 'USER';

        // 1. Create Tenant (if not exists)
        const tenantRes = await pool.query('SELECT * FROM public.tenants WHERE id = $1', [tenantId]);
        if (tenantRes.rows.length === 0) {
          try {
            await TenantService.createTenant(tenantId, `${email} Workspace`, 'trial');
            console.log(`Auto-provisioned tenant namespace: ${tenantId}`);
          } catch (tErr: any) {
            console.error(`Failed to create tenant ${tenantId}:`, tErr.message);
            // Fallback: insert directly into public.tenants if function fails
            await pool.query(
              "INSERT INTO public.tenants (id, name, tier) VALUES ($1, $2, 'trial') ON CONFLICT DO NOTHING",
              [tenantId, `${email} Workspace`]
            );
          }

          // 2. Subscribe the tenant to the default trial plan
          try {
            const trialPlan = await pool.query("SELECT id FROM public.plans WHERE name = 'trial'");
            if (trialPlan.rows.length > 0) {
              const planId = trialPlan.rows[0].id;
              await pool.query(
                "INSERT INTO public.subscriptions (tenant_id, plan_id, status) VALUES ($1, $2, 'active') ON CONFLICT (tenant_id) DO NOTHING",
                [tenantId, planId]
              );
              console.log(`Subscribed tenant ${tenantId} to trial plan.`);
            }
          } catch (subErr: any) {
            console.error(`Failed to subscribe tenant ${tenantId} to trial:`, subErr.message);
          }
        }
      }

      // 3. Create User in public.users
      const randomPassword = crypto.randomBytes(16).toString('hex');
      user = await AuthService.createUser(email, randomPassword, tenantId, role);
      console.log(`Auto-created user profile: ${email} under tenant ${tenantId} as ${role}`);
    }

    // Generate JWT
    const token = AuthService.generateToken(user.tenant_id, user.role, user.username);
    console.log(`SSO Login successful for ${email}, Tenant: ${user.tenant_id}, Role: ${user.role}`);
    
    // Redirect back to UI login page with the token
    res.redirect(`http://localhost:3001/login?token=${token}`);
  } catch (err: any) {
    console.error('[SSO Callback] Error:', err.message);
    res.status(500).json({ error: 'SSO Login failed', details: err.message });
  }
};
