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
import { assertTenantId } from '../utils/identifiers';
import { TenantIdOverlapError } from '../utils/tenantScope';

/**
 * Derives the workspace id for a first-time SSO user. It must satisfy assertTenantId (letters/digits/underscore,
 * starting with a letter, max 41 chars): long email-derived ids are shortened and made unique with a hash suffix.
 * `forceHash` yields a purely hash-based id (used when the readable id overlaps another tenant id).
 */
export function ssoTenantId(email: string, forceHash = false): string {
  const parts = email.split('@');
  const usernamePart = (parts[0] || 'user').replace(/[^a-zA-Z0-9]/g, '_').toLowerCase();
  const domainPart   = (parts[1] || '').replace(/[^a-zA-Z0-9]/g, '_').toLowerCase();
  const readable = `t_${usernamePart}_${domainPart}`;
  const hash = crypto.createHash('sha256').update(email.toLowerCase()).digest('hex');
  if (forceHash) return `t_${hash.slice(0, 16)}`;
  if (/^[A-Za-z][A-Za-z0-9_]{1,40}$/.test(readable)) return readable;
  return `t_${readable.slice(2, 22).replace(/_+$/, '')}_${hash.slice(0, 8)}`.slice(0, 41);
}

const IDS_BASE     = process.env.IDS_BASE_URL      || 'https://ids.fabrixly.com';
const API_BASE     = process.env.API_BASE_URL       || 'http://localhost:4000';
const UI_BASE      = process.env.UI_BASE_URL        || 'http://localhost:3006';
const OIDC_CLIENT  = process.env.OIDC_CLIENT_ID     || 'zero-datafabric';
const OIDC_SECRET  = process.env.OIDC_CLIENT_SECRET || 'super-secret-key-fabric';

/**
 * Authenticate a user with a username/password pair and issue a bearer token.
 */
export const login = async (req: Request, res: Response) => {
  const { username, password, timezone } = req.body;
  try {
    const result = await AuthService.login(username, password);
    if (result) {
      if (timezone) {
        await pool.query('UPDATE public.users SET timezone = $1 WHERE id = $2', [timezone, result.user.id]);
      }
      return res.json(result);
    }
    res.status(401).json({ error: 'Invalid credentials' });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
};

/**
 * Exchange the caller's current session for a new bearer token scoped to a
 * specific tenant.
 */
export const refreshToken = async (req: Request, res: Response) => {
  const user = (req as any).user;
  if (!user) return res.status(401).json({ error: 'Authentication required' });

  const { tenantId } = req.body;
  if (!tenantId) {
    console.warn(`[Auth] Token exchange failed: missing tenantId for user ${user.username}`);
    return res.status(400).json({ error: 'tenantId is required' });
  }

  // Security Check: If standard user, verify they own this tenant
  if (user.internal_role !== 'ADMIN') {
    try {
      const { rows } = await pool.query(
        'SELECT id FROM public.tenants WHERE id = $1 AND user_id = $2',
        [tenantId, user.id]
      );
      if (rows.length === 0) {
        console.warn(`[Auth] Tenant exchange access denied: user ${user.username} tried to access tenant ${tenantId}`);
        return res.status(403).json({ error: 'Access denied to this tenant' });
      }
    } catch (dbErr: any) {
      console.error('[Auth] Database error checking tenant ownership:', dbErr.message);
      return res.status(500).json({ error: 'Database check failed' });
    }
  }

  const authMethod = (user as any).auth_method || 'local';
  const token = AuthService.generateToken(tenantId, user.internal_role, user.username || 'unknown', user.id, authMethod);
  console.log(`[Auth] Issued tenant-scoped token for ${user.username} -> ${tenantId} (method: ${authMethod})`);
  res.json({ token });
};

async function getOidcSettings() {
  const envSecret = process.env.OIDC_CLIENT_SECRET;
  const defaults = {
    issuer: process.env.OIDC_ISSUER || process.env.IDS_BASE_URL || 'https://ids.fabrixly.com/oidc',
    client_id: process.env.OIDC_CLIENT_ID || 'zero-datafabric',
    client_secret: envSecret || 'bc79a2ed33935010666d9e4e1e0f29d7c80f0cd01d4a45267b6bc9b51fb9dd1d'
  };

  try {
    const { rows } = await pool.query("SELECT value FROM public.settings WHERE key = 'custom_login'");
    if (rows.length > 0) {
      const custom = rows[0].value || {};
      const customSecret = custom.oidc_client_secret;
      // Do not let placeholder strings override the real secret
      const resolvedSecret = (customSecret && customSecret !== 'super-secret-key-fabric')
        ? customSecret
        : defaults.client_secret;

      return {
        issuer: custom.oidc_issuer || defaults.issuer,
        client_id: custom.oidc_client_id || defaults.client_id,
        client_secret: resolvedSecret
      };
    }
    return defaults;
  } catch {
    return defaults;
  }
}

interface OidcEndpoints {
  issuer: string;
  authorization_endpoint: string;
  token_endpoint: string;
  userinfo_endpoint: string;
  end_session_endpoint: string;
  client_id: string;
  client_secret: string;
}

async function getOidcResolved(): Promise<OidcEndpoints> {
  const settings = await getOidcSettings();
  const rawIssuer = settings.issuer.trim().replace(/\/+$/, '');
  const basePrefix = rawIssuer.endsWith('/oidc') ? rawIssuer : `${rawIssuer}/oidc`;

  let endpoints: OidcEndpoints = {
    issuer: rawIssuer,
    authorization_endpoint: `${basePrefix}/auth`,
    token_endpoint: `${basePrefix}/token`,
    userinfo_endpoint: `${basePrefix}/me`,
    end_session_endpoint: `${basePrefix}/session/end`,
    client_id: settings.client_id,
    client_secret: settings.client_secret
  };

  try {
    const wellKnownUrl = `${rawIssuer}/.well-known/openid-configuration`;
    const res = await axios.get(wellKnownUrl, { timeout: 3000 });
    if (res.data) {
      if (res.data.authorization_endpoint) endpoints.authorization_endpoint = res.data.authorization_endpoint;
      if (res.data.token_endpoint) endpoints.token_endpoint = res.data.token_endpoint;
      if (res.data.userinfo_endpoint) endpoints.userinfo_endpoint = res.data.userinfo_endpoint;
      if (res.data.end_session_endpoint) endpoints.end_session_endpoint = res.data.end_session_endpoint;
    }
  } catch {
    // Standard endpoints will be used
  }

  return endpoints;
}

/**
 * Redirect user to OIDC provider login interface.
 */
export const sso = async (req: Request, res: Response) => {
  const oidc = await getOidcResolved();
  const callbackUrl = process.env.OIDC_CALLBACK_URL || `${API_BASE}/api/auth/sso/callback`;
  const redirectUri = encodeURIComponent(callbackUrl);
  const oidcUrl = `${oidc.authorization_endpoint}?client_id=${oidc.client_id}&redirect_uri=${redirectUri}&response_type=code&scope=openid%20email%20profile&state=state_datafabric`;
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
    const oidc = await getOidcResolved();
    const callbackUrl = process.env.OIDC_CALLBACK_URL || `${API_BASE}/api/auth/sso/callback`;
    // ── Step 1: Exchange authorization code for tokens ──────────────────────
    const params = new URLSearchParams();
    params.append('grant_type', 'authorization_code');
    params.append('code', String(code));
    params.append('redirect_uri', callbackUrl);
    params.append('client_id', oidc.client_id);
    params.append('client_secret', oidc.client_secret);

    const basicAuth = Buffer.from(`${oidc.client_id}:${oidc.client_secret}`).toString('base64');
    const tokenRes = await axios.post(oidc.token_endpoint, params, {
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'Authorization': `Basic ${basicAuth}`
      }
    });

    const { id_token, access_token } = tokenRes.data;
    if (!id_token) {
      throw new Error('Identity provider did not return an ID token');
    }

    // ── Step 2: Decode ID token — extract email/username robustly ───────────
    const decoded = jwt.decode(id_token) as any;
    console.log('[SSO] ID token claims:', JSON.stringify(decoded));

    let email: string | null = decoded?.email?.toLowerCase() || 
                               decoded?.upn?.toLowerCase() || 
                               decoded?.preferred_username?.toLowerCase() || 
                               decoded?.email_address?.toLowerCase() || 
                               null;
    let sub: string = decoded?.sub || '';

    // ── Step 3: If email missing, call userinfo endpoint ────────────────────
    if (!email && access_token) {
      try {
        const userInfoRes = await axios.get(oidc.userinfo_endpoint, {
          headers: { Authorization: `Bearer ${access_token}` }
        });
        console.log('[SSO] Userinfo claims:', JSON.stringify(userInfoRes.data));
        email = userInfoRes.data?.email?.toLowerCase() || 
                userInfoRes.data?.upn?.toLowerCase() || 
                userInfoRes.data?.preferred_username?.toLowerCase() || 
                userInfoRes.data?.email_address?.toLowerCase() || 
                null;
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

    // ── Step 4.5: Extract SSO Role/Groups (resolves role variance sso-to-sso) ─
    const ssoClaimsList = [
      ...(Array.isArray(decoded?.roles) ? decoded.roles : (decoded?.roles ? [decoded.roles] : [])),
      ...(Array.isArray(decoded?.groups) ? decoded.groups : (decoded?.groups ? [decoded.groups] : [])),
      ...(Array.isArray(decoded?.realm_access?.roles) ? decoded.realm_access.roles : []),
      ...(decoded?.role ? [decoded.role] : [])
    ];
    const normalizedSsoRoles = ssoClaimsList.map((r: any) => String(r).toUpperCase());
    const isSsoAdmin = normalizedSsoRoles.includes('ADMIN') || normalizedSsoRoles.includes('SYSTEM_ADMIN');

    // ── Step 5: Lookup or auto-provision user ───────────────────────────────
    const userRes = await pool.query('SELECT * FROM public.users WHERE username = $1', [userEmail]);

    let user: any;

    const isAdminEmail = userEmail === 'admin@fabrixly.com' || 
                         userEmail === 'admin@system.com' || 
                         userEmail === 'arjunkumargupta108@gmail.com' ||
                         isSsoAdmin;

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
        tenantId = ssoTenantId(userEmail);
        role     = 'USER';

        // Create user first (without tenant binding)
        const randomPassword = crypto.randomBytes(16).toString('hex');
        const newUser = await AuthService.createUser(userEmail, randomPassword, null, role);
        user = newUser;

        // Assign default trial plan to user
        try {
          const trialPlan = await pool.query("SELECT id FROM public.plans WHERE name = 'trial'");
          if (trialPlan.rows.length > 0) {
            await pool.query(
              "INSERT INTO public.subscriptions (user_id, plan_id, status) VALUES ($1, $2, 'active') ON CONFLICT (user_id) DO NOTHING",
              [newUser.id, trialPlan.rows[0].id]
            );
            console.log(`[SSO] Subscribed user ${userEmail} to trial plan`);
          }
        } catch (subErr: any) {
          console.error(`[SSO] Subscription error:`, subErr.message);
        }

        // Create tenant namespace if needed, linked to the user (owner). Tenant id rules (syntax + no-overlap) are enforced
        // by TenantService.createTenant; a readable id that overlaps another tenant falls back to a hash-based id.
        const tenantRow = await pool.query('SELECT id FROM public.tenants WHERE id = $1', [tenantId]);
        if (tenantRow.rows.length === 0) {
          try {
            assertTenantId(tenantId);
            try {
              await TenantService.createTenant(tenantId, `${userEmail} Workspace`, 'trial', newUser.id);
            } catch (tErr: any) {
              if (!(tErr instanceof TenantIdOverlapError)) throw tErr;
              tenantId = ssoTenantId(userEmail, true);
              await TenantService.createTenant(tenantId, `${userEmail} Workspace`, 'trial', newUser.id);
            }
            console.log(`[SSO] Auto-provisioned tenant: ${tenantId}`);
          } catch (tErr: any) {
            // No raw-INSERT fallback: it would bypass the tenant-id rules and leave a tenant without a namespace.
            console.error(`[SSO] Tenant create error:`, tErr.message);
            throw new Error(`Could not provision your workspace: ${tErr.message}`);
          }
        }

        // Update user with tenant_id
        await pool.query('UPDATE public.users SET tenant_id = $1 WHERE id = $2', [tenantId, newUser.id]);
      } else {
        // Admin user
        const adminRow = await pool.query('SELECT id FROM public.users WHERE username = $1', [userEmail]);
        if (adminRow.rows.length === 0) {
          const randomPassword = crypto.randomBytes(16).toString('hex');
          user = await AuthService.createUser(userEmail, randomPassword, 'tenant_A', 'ADMIN');
        } else {
          user = adminRow.rows[0];
        }
        user.role = 'ADMIN';
        user.tenant_id = 'tenant_A';
      }
    }

    // ── Step 6: Issue fabric JWT and redirect to UI ─────────────────────────
    const token = AuthService.generateToken(user.tenant_id, user.role, user.username, user.id, 'sso');
    console.log(`[SSO] Login successful: ${userEmail} tenant=${user.tenant_id} role=${user.role} (method: sso)`);

    res.redirect(`${UI_BASE}/login?token=${token}&auth_method=sso`);
  } catch (err: any) {
    const errorDetail = err.response?.data?.error_description || err.response?.data?.error || err.message;
    console.error('[SSO Callback] Error:', err.message, err.response?.data ? JSON.stringify(err.response.data) : '');
    res.status(500).json({ error: 'SSO Login failed', details: errorDetail });
  }
};

/**
 * Save user's local timezone.
 */
export const saveTimezone = async (req: Request, res: Response) => {
  const user = (req as any).user;
  const { timezone } = req.body;
  if (!user) return res.status(401).json({ error: 'Authentication required' });
  if (!timezone) return res.status(400).json({ error: 'timezone is required' });

  try {
    await pool.query('UPDATE public.users SET timezone = $1 WHERE id = $2', [timezone, user.id]);
    res.json({ message: 'Timezone updated successfully' });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
};

/**
 * Redirect user to OIDC Identity Server end session / logout interface.
 * Once logged out from the Identity Server, the user is redirected to the home page.
 */
export const ssoLogout = async (req: Request, res: Response) => {
  try {
    const oidc = await getOidcResolved();
    const returnUrl = String(req.query.redirect_uri || `${UI_BASE}/`);

    const postLogoutUri = encodeURIComponent(returnUrl);
    const clientId = encodeURIComponent(oidc.client_id);
    const separator = oidc.end_session_endpoint.includes('?') ? '&' : '?';
    const finalUrl = `${oidc.end_session_endpoint}${separator}post_logout_redirect_uri=${postLogoutUri}&client_id=${clientId}`;

    console.log(`[SSO Logout] Redirecting to SSO Identity Server logout: ${finalUrl}`);
    res.redirect(finalUrl);
  } catch (err: any) {
    console.error('[SSO Logout] Error redirecting to logout:', err.message);
    res.redirect(`${UI_BASE}/`);
  }
};

