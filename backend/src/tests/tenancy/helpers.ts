import crypto from 'crypto';
import jwt from 'jsonwebtoken';
import request from 'supertest';
import { pool } from '../../config/database';
import { AuthService } from '../../modules/auth/auth.service';

/** RSA key pair used to sign test licences. The app trusts it only because NODE_ENV=test + LICENSE_PUBLIC_KEY_PEM. */
const { publicKey, privateKey } = crypto.generateKeyPairSync('rsa', {
  modulusLength: 2048, publicKeyEncoding: { type: 'spki', format: 'pem' }, privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
});
process.env.LICENSE_PUBLIC_KEY_PEM = publicKey;
const other = crypto.generateKeyPairSync('rsa', { modulusLength: 2048, publicKeyEncoding: { type: 'spki', format: 'pem' }, privateKeyEncoding: { type: 'pkcs8', format: 'pem' } });

export const iso = (offsetDays: number) => new Date(Date.now() + offsetDays * 86_400_000).toISOString();

export function signLicense(over: Record<string, any> = {}, opts: { forged?: boolean } = {}): string {
  const payload = {
    licensee: 'Test Corp', product: 'data-fabric', name: 'Test', issuedAt: iso(-1), expiresAt: iso(30), selfHosted: false, schema_version: 2,
    limits: {}, features: { callback_validation_enabled: false }, ...over,
  };
  return jwt.sign(payload, opts.forged ? other.privateKey : privateKey, { algorithm: 'RS256' });
}

export const uid = (p: string) => `${p}${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;

export interface Actor { id: string; username: string; tenantId: string; token: string }

/** Create a workspace + its owner (USER role) directly in the DB and return a session token for the owner. */
export async function createOwnerWorkspace(prefix = 'qa'): Promise<Actor> {
  const tenantId = uid(prefix);
  const username = `${tenantId}_owner`;
  await pool.query('INSERT INTO public.tenants (id, name, status) VALUES ($1, $2, $3)', [tenantId, `WS ${tenantId}`, 'ACTIVE']);
  const u = await pool.query('INSERT INTO public.users (username, password_hash, tenant_id, role) VALUES ($1, $2, $3, $4) RETURNING id', [username, 'x', tenantId, 'USER']);
  await pool.query('UPDATE public.tenants SET user_id = $2 WHERE id = $1', [tenantId, u.rows[0].id]);
  return { id: u.rows[0].id, username, tenantId, token: AuthService.generateToken(tenantId, 'USER', username, u.rows[0].id) };
}

/** A second user in the SAME workspace who is not the owner. */
export async function createMember(tenantId: string): Promise<Actor> {
  const username = `${uid('m')}_member`;
  const u = await pool.query('INSERT INTO public.users (username, password_hash, tenant_id, role) VALUES ($1, $2, $3, $4) RETURNING id', [username, 'x', tenantId, 'USER']);
  return { id: u.rows[0].id, username, tenantId, token: AuthService.generateToken(tenantId, 'USER', username, u.rows[0].id) };
}

export const adminToken = () => AuthService.generateToken(null, 'ADMIN', 'qa-platform-admin', '00000000-0000-0000-0000-000000000001');
export const adminFor = (tenantId: string) => AuthService.generateToken(tenantId, 'ADMIN', 'qa-platform-admin', '00000000-0000-0000-0000-000000000001');

export async function dropWorkspace(a: Actor) {
  await pool.query('DELETE FROM public.api_tokens WHERE tenant_id = $1', [a.tenantId]).catch(() => {});
  await pool.query('DELETE FROM public.plan_requests WHERE tenant_id = $1', [a.tenantId]).catch(() => {});
  await pool.query('DELETE FROM public.users WHERE tenant_id = $1', [a.tenantId]).catch(() => {});
  await pool.query('DELETE FROM public.tenants WHERE id = $1', [a.tenantId]).catch(() => {});
  await pool.query('DELETE FROM public.system_events WHERE tenant_id = $1', [a.tenantId]).catch(() => {});
}

export const bearer = (t: string) => ({ Authorization: `Bearer ${t}` });

export async function resetPlatformState(app: any) {
  const t = adminToken();
  await request(app).delete('/api/system/license').set(bearer(t));
  await pool.query("DELETE FROM public.settings WHERE key = 'system'");
  const { SystemSettingsService } = await import('../../modules/tenancy/system-settings.service');
  const { LimitsResolver } = await import('../../modules/tenancy/limits.resolver');
  const { LicenseManager } = await import('../../modules/tenancy/license.manager');
  SystemSettingsService.clearCache(); LimitsResolver.invalidate(); LicenseManager.clearCache();
}
