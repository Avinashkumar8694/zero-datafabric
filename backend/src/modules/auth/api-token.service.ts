/**
 * @module modules/auth/api-token.service
 * @description Developer API tokens for integrations: long-lived, scoped,
 * revocable bearer credentials (`dft_<prefix>_<secret>`). Only a SHA-256 hash
 * of the secret is stored; the full token is shown once at creation. A token
 * can never carry platform-admin rights and cannot mint further tokens.
 */

import crypto from 'crypto';
import { pool } from '../../config/database';
import { LimitsResolver, LimitError } from '../tenancy/limits.resolver';
import { SystemSettingsService } from '../tenancy/system-settings.service';
import { WorkspaceSettingsService } from '../tenancy/workspace-settings.service';

import { TOKEN_SCOPES, TokenScope } from './token-scopes';
export { TOKEN_SCOPES };
export type { TokenScope };

export class TokenError extends Error {
  constructor(public status: number, public code: string, message: string) { super(message); }
}

const MAX_ACTIVE_PER_USER = 25;
const TOKEN_RE = /^dft_([a-z0-9]{8})_([A-Za-z0-9_-]{43})$/;
const hash = (secret: string) => crypto.createHash('sha256').update(secret).digest('hex');
const lastTouch = new Map<string, number>();

/** Required scope for an API-token request, or null when API tokens may not call the route at all. */
export function requiredScope(method: string, path: string, body?: any): TokenScope | null {
  const read = method === 'GET' || method === 'HEAD';
  if (/^\/api\/(queries|analytics|saved-analytics|query-logs)(\/|$)/.test(path)) {
    // A non-SELECT AST (CALL, DML) can change data, so it needs the write scope.
    // The AST can sit at the body root, in `config` (/queries/engine) or in `queryConfig` (/analytics/query[-async]).
    const type = body && typeof body === 'object' ? String((body.queryConfig?.type ?? body.config?.type ?? body.type ?? 'SELECT')).toUpperCase() : 'SELECT';
    if (path.endsWith('/refresh-view')) return 'data:write';
    return type === 'SELECT' || path.endsWith('/transpile') ? 'query:read' : 'data:write';
  }
  if (/^\/api\/data(\/|$)/.test(path)) return read || path === '/api/data/fetch' ? 'data:read' : 'data:write';
  if (/^\/api\/metadata(\/|$)/.test(path)) return read || path === '/api/metadata/diff' ? 'metadata:read' : 'metadata:write';
  if (/^\/api\/triggers(\/|$)/.test(path)) return read ? 'triggers:read' : 'triggers:write';
  return null;
}

export class ApiTokenService {
  static async create(user: any, input: any) {
    if (user?.auth_type === 'api_token') throw new TokenError(403, 'TOKEN_FROM_TOKEN', 'API tokens cannot create other tokens; sign in with a user session');
    if (!user?.tenant_id) throw new TokenError(400, 'TENANT_REQUIRED', 'Select a tenant first (exchange your session for a tenant-scoped token)');
    // Policy: licence/plan feature, workspace API settings, system maximum lifetime, per-user cap.
    try { await LimitsResolver.assertFeature(user.tenant_id, 'developer_tokens_enabled'); }
    catch (e) { if (e instanceof LimitError) throw new TokenError(e.status, e.code, e.message); throw e; }
    const wsApi = (await WorkspaceSettingsService.get(user.tenant_id)).api;
    if (wsApi.allowDeveloperTokens === false) throw new TokenError(403, 'TOKENS_DISABLED', 'Developer tokens are disabled for this workspace');
    const sys = await SystemSettingsService.get();
    const name = typeof input?.name === 'string' ? input.name.trim() : '';
    if (!name || name.length > 100) throw new TokenError(400, 'INVALID_TOKEN', 'name is required (max 100 characters)');
    const scopes: string[] = Array.isArray(input?.scopes) ? [...new Set<string>(input.scopes)] : [];
    if (!scopes.length || scopes.some(s => !(TOKEN_SCOPES as readonly string[]).includes(s))) throw new TokenError(400, 'INVALID_SCOPE', `scopes must be a non-empty subset of: ${TOKEN_SCOPES.join(', ')}`);
    const maxDays = Math.min(365, sys.maxTokenDays, typeof wsApi.maxTokenDays === 'number' ? wsApi.maxTokenDays : 365);
    const days = input?.expiresInDays === undefined ? Math.min(90, maxDays) : input.expiresInDays;
    if (!Number.isInteger(days) || days < 1 || days > maxDays) throw new TokenError(400, 'INVALID_TOKEN', `expiresInDays must be an integer from 1 to ${maxDays}`);
    const allowedScopes: string[] = Array.isArray(wsApi.allowedScopes) ? wsApi.allowedScopes : [...TOKEN_SCOPES];
    const denied = scopes.filter(sc => !allowedScopes.includes(sc));
    if (denied.length) throw new TokenError(403, 'SCOPE_NOT_ALLOWED', `This workspace does not allow the scope(s): ${denied.join(', ')}`);
    const owner = String(user.id ?? user.username);
    const active = await pool.query('SELECT count(*)::int AS n FROM public.api_tokens WHERE user_id=$1 AND revoked_at IS NULL AND (expires_at IS NULL OR expires_at > NOW())', [owner]);
    if (active.rows[0].n >= MAX_ACTIVE_PER_USER) throw new TokenError(409, 'TOKEN_LIMIT', `at most ${MAX_ACTIVE_PER_USER} active tokens per user`);
    try { await LimitsResolver.assertWithin(user.tenant_id, 'max_api_tokens_per_user', active.rows[0].n, 'API tokens per user'); }
    catch (e) { if (e instanceof LimitError) throw new TokenError(e.status, e.code, e.message); throw e; }
    const prefix = crypto.randomBytes(6).toString('hex').slice(0, 8);
    const secret = crypto.randomBytes(32).toString('base64url');
    const { rows } = await pool.query(
      `INSERT INTO public.api_tokens (tenant_id, user_id, username, name, prefix, token_hash, scopes, expires_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7, NOW() + ($8 || ' days')::interval) RETURNING id, expires_at, created_at`,
      [user.tenant_id, owner, user.username || 'unknown', name, prefix, hash(secret), scopes, String(days)]);
    return { id: rows[0].id, name, prefix, scopes, expiresAt: rows[0].expires_at, createdAt: rows[0].created_at, token: `dft_${prefix}_${secret}` };
  }

  static async list(user: any) {
    const { rows } = await pool.query(
      `SELECT id, name, prefix, scopes, expires_at AS "expiresAt", last_used_at AS "lastUsedAt", revoked_at AS "revokedAt", created_at AS "createdAt"
       FROM public.api_tokens WHERE user_id=$1 AND tenant_id IS NOT DISTINCT FROM $2 ORDER BY created_at DESC`,
      [String(user.id ?? user.username), user.tenant_id ?? null]);
    return rows;
  }

  static async revoke(user: any, id: string) {
    if (!/^[0-9a-f-]{36}$/i.test(id)) throw new TokenError(404, 'TOKEN_NOT_FOUND', 'token not found');
    const { rowCount } = await pool.query('UPDATE public.api_tokens SET revoked_at = COALESCE(revoked_at, NOW()) WHERE id=$1 AND user_id=$2', [id, String(user.id ?? user.username)]);
    if (!rowCount) throw new TokenError(404, 'TOKEN_NOT_FOUND', 'token not found');
  }

  /** Resolve a presented `dft_` token to a request user, or throw TokenError (401). */
  static async authenticate(presented: string) {
    const m = TOKEN_RE.exec(presented.trim());
    if (!m) throw new TokenError(401, 'INVALID_TOKEN', 'Invalid API token');
    const { rows } = await pool.query(
      `SELECT t.*, tn.status AS tenant_status FROM public.api_tokens t LEFT JOIN public.tenants tn ON tn.id = t.tenant_id WHERE t.prefix = $1`, [m[1]!]);
    const row = rows[0];
    const a = Buffer.from(hash(m[2]!)); const b = Buffer.from(row ? row.token_hash : '0'.repeat(64));
    if (!row || a.length !== b.length || !crypto.timingSafeEqual(a, b)) throw new TokenError(401, 'INVALID_TOKEN', 'Invalid API token');
    if (row.revoked_at) throw new TokenError(401, 'TOKEN_REVOKED', 'API token has been revoked');
    if (row.expires_at && new Date(row.expires_at) <= new Date()) throw new TokenError(401, 'TOKEN_EXPIRED', 'API token has expired');
    if (row.tenant_status && String(row.tenant_status).toUpperCase() === 'SUSPENDED') throw new TokenError(403, 'TENANT_SUSPENDED', 'Tenant account is suspended');
    try { await LimitsResolver.assertFeature(row.tenant_id, 'developer_tokens_enabled'); }
    catch (e) { if (e instanceof LimitError) throw new TokenError(403, e.code, e.message); throw e; }
    if (row.tenant_id && (await WorkspaceSettingsService.get(row.tenant_id)).api.allowDeveloperTokens === false) throw new TokenError(403, 'TOKENS_DISABLED', 'Developer tokens are disabled for this workspace');
    const now = Date.now();
    if (now - (lastTouch.get(row.id) || 0) > 60_000) {
      lastTouch.set(row.id, now);
      pool.query('UPDATE public.api_tokens SET last_used_at = NOW() WHERE id = $1', [row.id]).catch(() => {});
    }
    return {
      id: row.user_id, role: 'fabric_user', internal_role: 'USER', tenant_id: row.tenant_id, username: row.username,
      auth_type: 'api_token', token_id: row.id, scopes: row.scopes as string[],
    };
  }
}
