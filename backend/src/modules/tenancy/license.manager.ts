/**
 * Licence key lifecycle: where the key comes from, whether it is currently usable, and
 * the ceilings/features it grants. See LICENCE_KEY.md (repo root) for the payload contract.
 *
 * Precedence: env LICENSE_KEY, then settings.license_key. A key is *usable* when its RS256
 * signature verifies, it has not expired, it is bound to this instance (if bound), and the
 * validation daemon has not marked it invalid. Anything else behaves as "no licence" (plan
 * limits apply) - never as unlimited.
 */
import jwt from 'jsonwebtoken';
import { pool } from '../../config/database';
import { LicensePayload, verifyLicense } from '../../utils/licensing';

export type LicenseStatus = 'none' | 'valid' | 'invalid' | 'expired' | 'wrong_instance' | 'revoked';

export interface LicenseState {
  status: LicenseStatus;
  source: 'env' | 'settings' | null;
  payload: LicensePayload | null;
  error: string | null;
  validation: { status: string; lastSuccessAt: string | null; errorMessage: string | null } | null;
}

export class LicenseError extends Error {
  constructor(public status: number, public code: string, message: string) { super(message); }
}

const TTL_MS = 15_000;
let cache: { at: number; state: LicenseState } | null = null;

async function setting(key: string): Promise<any> {
  try {
    const { rows } = await pool.query('SELECT value FROM public.settings WHERE key = $1', [key]);
    return rows[0]?.value ?? null;
  } catch { return null; }
}

export class LicenseManager {
  static clearCache() { cache = null; }

  static async instanceId(): Promise<string | null> {
    const v = await setting('instance_id');
    return typeof v === 'string' ? v : null;
  }

  private static async raw(): Promise<{ token: string; source: 'env' | 'settings' } | null> {
    if (process.env.LICENSE_KEY && process.env.LICENSE_KEY.trim()) return { token: process.env.LICENSE_KEY.trim(), source: 'env' };
    const v = await setting('license_key');
    const t = typeof v?.license_key === 'string' ? v.license_key.trim() : '';
    return t ? { token: t, source: 'settings' } : null;
  }

  static async current(): Promise<LicenseState> {
    if (cache && Date.now() - cache.at < TTL_MS) return cache.state;
    const state = await this.evaluate();
    cache = { at: Date.now(), state };
    return state;
  }

  private static async evaluate(): Promise<LicenseState> {
    const none: LicenseState = { status: 'none', source: null, payload: null, error: null, validation: null };
    const raw = await this.raw();
    if (!raw) return none;
    const validationRow = await setting('license_validation');
    const validation = validationRow ? { status: String(validationRow.status ?? ''), lastSuccessAt: validationRow.last_successful_validation_at ?? validationRow.lastSuccessAt ?? null, errorMessage: validationRow.error_message ?? validationRow.errorMessage ?? null } : null;
    const payload = verifyLicense(raw.token);
    if (!payload) {
      const decoded: any = jwt.decode(raw.token);
      const expired = decoded?.expiresAt && new Date() > new Date(decoded.expiresAt);
      return { status: expired ? 'expired' : 'invalid', source: raw.source, payload: null, error: expired ? 'The licence key has expired' : 'The licence key is not valid for this product (bad signature or malformed)', validation };
    }
    if (payload.bound_instance_id) {
      const id = await this.instanceId();
      if (!id || id !== payload.bound_instance_id) return { status: 'wrong_instance', source: raw.source, payload: null, error: 'The licence key is bound to a different installation', validation };
    }
    if (validation?.status === 'invalid' && payload.features?.callback_validation_enabled !== false && payload.validation_url) {
      return { status: 'revoked', source: raw.source, payload: null, error: validation.errorMessage || 'The licensing portal rejected this key', validation };
    }
    return { status: 'valid', source: raw.source, payload, error: null, validation };
  }

  /** Verify and store a key in settings (replaces any previous key). Env keys take precedence and are not replaceable from the UI. */
  static async install(token: unknown, actor: string): Promise<LicenseState> {
    if (typeof token !== 'string' || !token.trim() || token.length > 16_000) throw new LicenseError(400, 'INVALID_LICENSE', 'licenseKey must be a non-empty string');
    if (process.env.LICENSE_KEY && process.env.LICENSE_KEY.trim()) throw new LicenseError(409, 'LICENSE_FROM_ENV', 'The licence key is set through the LICENSE_KEY environment variable; change it there');
    const t = token.trim();
    const payload = verifyLicense(t);
    if (!payload) {
      const decoded: any = jwt.decode(t);
      const expired = decoded?.expiresAt && new Date() > new Date(decoded.expiresAt);
      throw new LicenseError(400, expired ? 'LICENSE_EXPIRED' : 'INVALID_LICENSE', expired ? 'This licence key has expired' : 'This licence key is not valid (bad signature or malformed)');
    }
    if (payload.bound_instance_id) {
      const id = await this.instanceId();
      if (!id || id !== payload.bound_instance_id) throw new LicenseError(400, 'WRONG_INSTANCE', 'This licence key is bound to a different installation');
    }
    await pool.query(
      `INSERT INTO public.settings (key, value) VALUES ('license_key', $1) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`,
      [JSON.stringify({ license_key: t, installed_at: new Date().toISOString(), installed_by: actor })]);
    await pool.query("DELETE FROM public.settings WHERE key = 'license_validation'").catch(() => {});
    await pool.query('INSERT INTO public.system_events (actor, action, detail) VALUES ($1,$2,$3)', [actor, 'LICENSE_INSTALLED', JSON.stringify({ licensee: payload.licensee, product: payload.product, expiresAt: payload.expiresAt, selfHosted: payload.selfHosted })]).catch(() => {});
    this.clearCache();
    return this.current();
  }

  static async remove(actor: string): Promise<LicenseState> {
    if (process.env.LICENSE_KEY && process.env.LICENSE_KEY.trim()) throw new LicenseError(409, 'LICENSE_FROM_ENV', 'The licence key is set through the LICENSE_KEY environment variable; remove it there');
    await pool.query("DELETE FROM public.settings WHERE key IN ('license_key','license_validation')");
    await pool.query('INSERT INTO public.system_events (actor, action, detail) VALUES ($1,$2,$3)', [actor, 'LICENSE_REMOVED', '{}']).catch(() => {});
    this.clearCache();
    return this.current();
  }

  /** Public (non-secret) view of the licence for the API/UI. Never includes the raw token. */
  static view(state: LicenseState) {
    const p = state.payload;
    return {
      status: state.status, source: state.source, error: state.error,
      licensee: p?.licensee ?? null, product: p?.product ?? null, name: p?.name ?? null, schemaVersion: p ? (p.schema_version ?? 1) : null,
      issuedAt: p?.issuedAt ?? null, expiresAt: p?.expiresAt ?? null, selfHosted: p?.selfHosted ?? false,
      limits: p?.limits ?? null, features: p?.features ?? null, maxInstallations: p?.max_installations ?? null, boundInstanceId: p?.bound_instance_id ?? null,
      validation: state.validation,
    };
  }
}
