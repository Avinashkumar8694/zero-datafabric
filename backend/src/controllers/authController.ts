/**
 * @module controllers/authController
 * @description Authentication endpoints: username/password login (issues the
 * initial bearer token), tenant-scoped token exchange, and OIDC/SSO flow.
 */

import { Request, Response } from 'express';
import { AuthService } from '../modules/auth/auth.service';
import axios from 'axios';
import jwt from 'jsonwebtoken';
import { TenantService } from '../modules/tenant/tenant.service';
import { pool } from '../config/database';
import crypto from 'crypto';

const IDS_BASE     = process.env.IDS_BASE_URL      || 'http://localhost:3000';
const API_BASE     = process.env.API_BASE_URL       || 'http://localhost:4000';
const UI_BASE      = process.env.UI_BASE_URL        || 'http://localhost:3001';
const OIDC_CLIENT  = process.env.OIDC_CLIENT_ID     || 'zero-datafabric';
const OIDC_SECRET  = process.env.OIDC_CLIENT_SECRET || 'super-secret-key-fabric';

/**
 * Authenticate a user with a username/password pair and issue a bearer token.
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
 * specific tenant.
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
  const redirectUri = encodeURIComponent(`${API_BASE}/api/auth/sso/callback`);
  const oidcUrl = `${IDS_BASE}/oidc/auth?client_id=${OIDC_CLIENT}&redirect_uri=${redirectUri}&response_type=code&scope=openid%20email%20profile&state=state_datafabric`;
  res.redirect(oidcUrl);
};

/**
 * Handle OIDC authentication callback:
 *  1. Exchange code for tokens
 *  2. Try to get email from ID token
 *  3. If not present, call userinfo (/oidc/me) with the access_token
 *  4. Fall back to sub-based identifier if still no email
 *  5. Auto-provision tenant + user if first login
 *  6. Issue fabric JWT and redirect to UI
 */
export const ssoCallback = async (req: Request, res: Response) => {
  const { code } = req.query;
  if (!code) {
    return res.status(400).json({ error: 'Authorization code is missing' });
  }

  try {
    // ── Step 1: Exchange authorization code for tokens ──────────────────────
    const params = new URLSearchParams();
    params.append('grant_type', 'authorization_code');
    params.append('code', String(code));
    params.append('redirect_uri', `${API_BASE}/api/auth/sso/callback`);
    params.append('client_id', OIDC_CLIENT);
    params.append('client_secret', OIDC_SECRET);

    const tokenRes = await axios.post(`${IDS_BASE}/oidc/token`, params, {
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' }
    });

    const { id_token, access_token } = tokenRes.data;
    if (!id_token) {
      throw new Error('Identity provider did not return an ID token');
    }

    // ── Step 2: Decode ID token — email may or may not be present ───────────
    const decoded = jwt.decode(id_token) as any;
    console.log('[SSO] ID token claims:', JSON.stringify(decoded));

    let email: string | null = decoded?.email?.toLowerCase() || null;
    let sub: string = decoded?.sub || '';

    // ── Step 3: If email missing, call userinfo endpoint ────────────────────
    if (!email && access_token) {
      try {
        const userInfoRes = await axios.get(`${IDS_BASE}/oidc/me`, {
          headers: { Authorization: `Bearer ${access_token}` }
        });
        console.log('[SSO] Userinfo claims:', JSON.stringify(userInfoRes.data));
        email = userInfoRes.data?.email?.toLowerCase() || null;
        sub   = userInfoRes.data?.sub || sub;
      } catch (uiErr: any) {
        console.warn('[SSO] Userinfo endpoint failed:', uiErr.message);
      }
    }

    // ── Step 4: Build stable identifier — email preferred, sub as fallback ──
    if (!email) {
      if (!sub) {
        throw new Error('Could not determine user identity from ID token or userinfo endpoint');
      }
      email = `${sub}@sso.local`;
      console.warn(`[SSO] No email claim — using sub-based identifier: ${email}`);
    }

    const userEmail = email as string;

    // ── Step 5: Lookup or auto-provision user ───────────────────────────────
    const userRes = await pool.query('SELECT * FROM public.users WHERE username = $1', [userEmail]);

    let user: any;

    const isAdminEmail = userEmail === 'admin@fabrixly.com' || userEmail === 'admin@system.com';

    if (userRes.rows.length > 0) {
      user = userRes.rows[0];
      // Always keep system admin as ADMIN under tenant_A
      if (isAdminEmail && (user.role !== 'ADMIN' || user.tenant_id !== 'tenant_A')) {
        await pool.query(
          "UPDATE public.users SET role = 'ADMIN', tenant_id = 'tenant_A' WHERE id = $1",
          [user.id]
        );
        user.role = 'ADMIN';
        user.tenant_id = 'tenant_A';
      }
    } else {
      // First-time SSO login — auto-provision
      let tenantId = 'tenant_A';
      let role     = 'ADMIN';

      if (!isAdminEmail) {
        const parts = userEmail.split('@');
        const usernamePart = (parts[0] || 'user').replace(/[^a-zA-Z0-9]/g, '_').toLowerCase();
        const domainPart   = (parts[1] || '').replace(/[^a-zA-Z0-9]/g, '_').toLowerCase();
        tenantId = `t_${usernamePart}_${domainPart}`;
        role     = 'USER';

        // Create tenant namespace if needed
        const tenantRow = await pool.query('SELECT id FROM public.tenants WHERE id = $1', [tenantId]);
        if (tenantRow.rows.length === 0) {
          try {
            await TenantService.createTenant(tenantId, `${userEmail} Workspace`, 'trial');
            console.log(`[SSO] Auto-provisioned tenant: ${tenantId}`);
          } catch (tErr: any) {
            console.error(`[SSO] Tenant create error:`, tErr.message);
            await pool.query(
              "INSERT INTO public.tenants (id, name, tier) VALUES ($1, $2, 'trial') ON CONFLICT DO NOTHING",
              [tenantId, `${userEmail} Workspace`]
            );
          }

          // Subscribe to trial plan
          try {
            const trialPlan = await pool.query("SELECT id FROM public.plans WHERE name = 'trial'");
            if (trialPlan.rows.length > 0) {
              await pool.query(
                "INSERT INTO public.subscriptions (tenant_id, plan_id, status) VALUES ($1, $2, 'active') ON CONFLICT (tenant_id) DO NOTHING",
                [tenantId, trialPlan.rows[0].id]
              );
              console.log(`[SSO] Subscribed ${tenantId} to trial plan`);
            }
          } catch (subErr: any) {
            console.error(`[SSO] Subscription error:`, subErr.message);
          }
        }
      }

      const randomPassword = crypto.randomBytes(16).toString('hex');
      user = await AuthService.createUser(userEmail, randomPassword, tenantId, role);
      console.log(`[SSO] Auto-created user: ${userEmail} -> tenant=${tenantId} role=${role}`);
    }

    // ── Step 6: Issue fabric JWT and redirect to UI ─────────────────────────
    const token = AuthService.generateToken(user.tenant_id, user.role, user.username);
    console.log(`[SSO] Login successful: ${userEmail} tenant=${user.tenant_id} role=${user.role}`);

    res.redirect(`${UI_BASE}/login?token=${token}`);
  } catch (err: any) {
    console.error('[SSO Callback] Error:', err.message);
    res.status(500).json({ error: 'SSO Login failed', details: err.message });
  }
};
