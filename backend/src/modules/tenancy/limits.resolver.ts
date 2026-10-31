/**
 * Effective limits for a workspace:
 *   base      = plan limits (workspace plan -> owner's subscription -> system default plan -> built-in trial)
 *               or, with a usable self-hosted licence, the licence limits
 *   + overrides set by a platform admin for this workspace only
 *   ceiling   = a usable licence caps every numeric limit it sets (-1 = no cap)
 *   PLAN_LIMITS_ENABLED=false / system setting turns plan limits off (licence ceiling still applies).
 * -1 always means unlimited. Cached 15s; invalidate() after any change.
 */
import { pool } from '../../config/database';
import { LicenseManager, LicenseState } from './license.manager';
import { SystemSettingsService } from './system-settings.service';

export const LIMIT_KEYS = [
  'max_connections', 'max_records_per_table', 'max_tables', 'max_triggers', 'max_replication_tables', 'max_replication_rows',
  'max_replication_rows_per_table', 'max_replications', 'max_tenants', 'rate_limit_per_min', 'rate_limit_per_hour', 'rate_limit_per_day',
  'rate_limit_per_month', 'max_workers', 'max_api_tokens_per_user', 'max_users_per_workspace', 'max_saved_analytics', 'max_query_rows', 'max_manifest_size_mb',
] as const;
export type LimitKey = typeof LIMIT_KEYS[number];

export const FEATURE_KEYS = [
  'custom_branding', 'enterprise_sso_enabled', 'elasticsearch_enabled', 'snowflake_enabled', 'cdc_kafka_enabled', 'federated_query_enabled',
  'remove_branding', 'distributed_execution_enabled', 'developer_tokens_enabled', 'manifest_import_export_enabled', 'workspace_settings_enabled',
] as const;
export type FeatureKey = typeof FEATURE_KEYS[number];

/** Built-in trial used when no plan row can be found. */
export const BUILTIN_TRIAL_LIMITS: Record<string, number> = {
  max_connections: 2, max_records_per_table: 1000, max_tables: 5, max_triggers: 3, max_replication_tables: 2, max_replication_rows: 500,
  max_replication_rows_per_table: 250, max_replications: 2, max_tenants: 3, rate_limit_per_min: 10, rate_limit_per_hour: 100,
  rate_limit_per_day: 1000, rate_limit_per_month: 10000, max_workers: 2, max_api_tokens_per_user: 5, max_users_per_workspace: 5,
  max_saved_analytics: 20, max_query_rows: 10000, max_manifest_size_mb: 5,
};

export interface EffectiveLimits {
  tenantId: string;
  plan: { name: string; source: 'workspace' | 'subscription' | 'default' | 'licence' | 'builtin' };
  limits: Record<string, number>;
  features: Record<string, boolean | number>;
  trial: { startedAt: string; endsAt: string | null; expired: boolean; days: number };
  licence: { status: string; licensee: string | null; selfHosted: boolean; expiresAt: string | null };
  planLimitsEnabled: boolean;
}

const cache = new Map<string, { at: number; value: EffectiveLimits }>();
const TTL_MS = 15_000;

const num = (v: unknown): number | undefined => (typeof v === 'number' && Number.isFinite(v) ? v : undefined);

/** min() where -1 is infinity. */
export function capLimit(value: number, ceiling: number | undefined): number {
  if (ceiling === undefined || ceiling === -1) return value;
  if (value === -1) return ceiling;
  return Math.min(value, ceiling);
}

export class LimitsResolver {
  static invalidate(tenantId?: string) { if (tenantId) cache.delete(tenantId); else cache.clear(); }

  static async forTenant(tenantId: string): Promise<EffectiveLimits> {
    const hit = cache.get(tenantId);
    if (hit && Date.now() - hit.at < TTL_MS) return hit.value;
    const value = await this.compute(tenantId);
    cache.set(tenantId, { at: Date.now(), value });
    return value;
  }

  private static async planRow(tenantRow: any, sys: { defaultPlan: string | null }) {
    if (tenantRow?.plan_name) {
      const r = await pool.query('SELECT name, limits, features FROM public.plans WHERE name = $1', [tenantRow.plan_name]);
      if (r.rows[0]) return { row: r.rows[0], source: 'workspace' as const, start: tenantRow.plan_started_at };
    }
    if (tenantRow?.user_id) {
      const r = await pool.query(
        `SELECT p.name, s.snapshot, p.limits, p.features, s.start_date FROM public.subscriptions s JOIN public.plans p ON p.id = s.plan_id
         WHERE s.user_id = $1 AND s.status = 'active'`, [tenantRow.user_id]);
      if (r.rows[0]) { const x = r.rows[0]; return { row: { name: x.name, limits: x.snapshot?.limits || x.limits, features: x.snapshot?.features || x.features }, source: 'subscription' as const, start: x.start_date }; }
    }
    const q = sys.defaultPlan
      ? await pool.query('SELECT name, limits, features FROM public.plans WHERE name = $1', [sys.defaultPlan])
      : await pool.query("SELECT name, limits, features FROM public.plans WHERE is_default = true OR name = 'trial' ORDER BY is_default DESC LIMIT 1");
    if (q.rows[0]) return { row: q.rows[0], source: 'default' as const, start: null };
    return { row: { name: 'trial', limits: BUILTIN_TRIAL_LIMITS, features: { trial_period_days: 7 } }, source: 'builtin' as const, start: null };
  }

  private static async compute(tenantId: string): Promise<EffectiveLimits> {
    const [sys, lic, t] = await Promise.all([
      SystemSettingsService.get(), LicenseManager.current(),
      pool.query('SELECT id, user_id, plan_name, plan_started_at, plan_expires_at, plan_overrides, created_at FROM public.tenants WHERE id = $1', [tenantId]),
    ]);
    const tenantRow = t.rows[0];
    const plan = await this.planRow(tenantRow, sys);
    const licPayload = lic.status === 'valid' ? lic.payload : null;
    const selfHosted = !!licPayload?.selfHosted;

    let name = plan.row.name; let source: EffectiveLimits['plan']['source'] = plan.source;
    let base: Record<string, number> = { ...BUILTIN_TRIAL_LIMITS };
    for (const [k, v] of Object.entries(plan.row.limits || {})) { const n = num(v); if (n !== undefined) base[k] = n; }
    if (selfHosted) {
      base = Object.fromEntries(LIMIT_KEYS.map(k => [k, -1]));
      for (const [k, v] of Object.entries(licPayload!.limits || {})) { const n = num(v); if (n !== undefined) base[k] = n; }
      name = licPayload!.name || 'selfhost'; source = 'licence';
    } else if (!sys.planLimitsEnabled) {
      base = Object.fromEntries(LIMIT_KEYS.map(k => [k, -1]));
    }
    // Overrides are part of plan limits: they are ignored when plan limits are switched off (self-hosted licence limits still honour them).
    if (sys.planLimitsEnabled || selfHosted) for (const [k, v] of Object.entries(tenantRow?.plan_overrides || {})) { const n = num(v); if (n !== undefined) base[k] = n; }
    // Licence ceiling.
    if (licPayload) for (const k of LIMIT_KEYS) { const c = num((licPayload.limits as any)?.[k]); if (c !== undefined) base[k] = capLimit(base[k] ?? -1, c); }

    const features: Record<string, boolean | number> = { ...(plan.row.features || {}) };
    if (licPayload) for (const [k, v] of Object.entries(licPayload.features || {})) { if (typeof v === 'boolean') features[k] = features[k] === false ? false : v; else if (typeof v === 'number') features[k] = v; }

    const days = num(features.trial_period_days) ?? 7;
    const start = new Date(tenantRow?.plan_started_at || plan.start || tenantRow?.created_at || Date.now());
    let endsAt: Date | null = tenantRow?.plan_expires_at ? new Date(tenantRow.plan_expires_at) : (days === -1 ? null : new Date(start.getTime() + days * 86_400_000));
    const noExpiry = selfHosted || !sys.planLimitsEnabled || (source !== 'default' && source !== 'builtin' && !tenantRow?.plan_expires_at && days === -1);
    const expired = !noExpiry && endsAt !== null && Date.now() > endsAt.getTime();
    if (noExpiry) endsAt = null;

    return {
      tenantId, plan: { name, source }, limits: base, features,
      trial: { startedAt: start.toISOString(), endsAt: endsAt ? endsAt.toISOString() : null, expired, days },
      licence: { status: lic.status, licensee: licPayload?.licensee ?? null, selfHosted, expiresAt: licPayload?.expiresAt ?? null },
      planLimitsEnabled: sys.planLimitsEnabled,
    };
  }

  /** Throws LimitError(403 LICENSE_FEATURE_DISABLED) when the licence/plan disables a feature. Absent = enabled. */
  static async assertFeature(tenantId: string, feature: FeatureKey): Promise<void> {
    const eff = await this.forTenant(tenantId);
    if (eff.features[feature] === false) throw new LimitError(403, 'FEATURE_DISABLED', `The "${feature}" feature is not included in your licence or plan`);
  }

  /** Platform-level checks (no workspace involved): only a usable licence can restrict these. */
  static async assertLicenceFeature(feature: FeatureKey): Promise<void> {
    const lic = await LicenseManager.current();
    if (lic.status === 'valid' && (lic.payload?.features as any)?.[feature] === false) throw new LimitError(403, 'FEATURE_DISABLED', `The "${feature}" feature is not included in your licence`);
  }

  static async assertLicenceWithin(key: LimitKey, current: number, what: string): Promise<void> {
    const lic = await LicenseManager.current();
    const lim = lic.status === 'valid' ? (lic.payload?.limits as any)?.[key] : undefined;
    if (typeof lim === 'number' && lim !== -1 && current >= lim) throw new LimitError(403, 'LICENSE_LIMIT_REACHED', `${what} limit reached (${lim}) under the installed licence`);
  }

  /** Throws LimitError(403 PLAN_LIMIT_REACHED) when current >= limit (limit -1 = unlimited, 0 = none allowed). */
  static async assertWithin(tenantId: string, key: LimitKey, current: number, what: string): Promise<void> {
    const eff = await this.forTenant(tenantId);
    const lim = eff.limits[key];
    if (lim === undefined || lim === -1) return;
    if (current >= lim) throw new LimitError(403, 'PLAN_LIMIT_REACHED', `${what} limit reached (${lim}). Your plan or licence does not allow more.`);
  }
}

export class LimitError extends Error {
  constructor(public status: number, public code: string, message: string) { super(message); }
}

export type { LicenseState };
