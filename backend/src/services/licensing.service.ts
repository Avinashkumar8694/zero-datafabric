import { pool } from '../config/database';
import { cacheEnabled } from '../config/cache';
import { verifyLicense } from '../utils/licensing';
import { LimitsResolver } from '../modules/tenancy/limits.resolver';
import { LicenseManager } from '../modules/tenancy/license.manager';
import { SystemSettingsService } from '../modules/tenancy/system-settings.service';

export interface SubscriptionSnapshot {
  limits: {
    max_connections: number;
    max_records_per_table: number;
    max_tables: number;
    max_triggers: number;
    max_replication_tables: number;
    max_replication_rows: number;
    rate_limit_per_min: number;
    rate_limit_per_hour: number;
    rate_limit_per_day: number;
  };
  features: {
    trial_period_days: number;
  };
}

export class LicensingService {
  // In-memory rate limiting store for when Redis is disabled/unavailable
  private static inMemoryStore = new Map<string, { count: number, expiresAt: number }>();

  /**
   * Fetch active subscription for a user.
   * If user has no subscription, return a default trial subscription.
   */
  static async getUserSubscription(userId: string): Promise<{ start_date: Date; limits: any; features: any }> {
    const { rows } = await pool.query(
      `SELECT s.start_date, s.snapshot, p.limits as plan_limits, p.features as plan_features
       FROM public.subscriptions s
       JOIN public.plans p ON s.plan_id = p.id
       WHERE s.user_id = $1 AND s.status = 'active'`,
      [userId]
    );

    if (rows.length > 0) {
      const row = rows[0];
      const limits = row.snapshot?.limits || row.plan_limits;
      const features = row.snapshot?.features || row.plan_features;
      return {
        start_date: new Date(row.start_date),
        limits,
        features
      };
    }

    // Default Fallback to Trial Plan if no subscription exists
    const trialPlan = await pool.query("SELECT * FROM public.plans WHERE name = 'trial'");
    const limits = trialPlan.rows[0]?.limits || {
      max_connections: 2,
      max_records_per_table: 1000,
      max_tables: 5,
      max_triggers: 3,
      max_replication_tables: 2,
      max_replication_rows: 500,
      max_replication_rows_per_table: 250,
      max_replications: 2,
      rate_limit_per_min: 10,
      rate_limit_per_hour: 100,
      rate_limit_per_day: 1000,
      rate_limit_per_month: 10000,
      max_tenants: 3
    };
    const features = trialPlan.rows[0]?.features || { trial_period_days: 7 };

    return {
      start_date: new Date(),
      limits,
      features
    };
  }

  /**
   * Effective subscription snapshot of a workspace (plan or licence base + per-workspace overrides,
   * capped by the licence). Kept for existing callers; new code should use LimitsResolver directly.
   */
  static async getTenantSubscription(tenantId: string): Promise<{ start_date: Date; limits: any; features: any }> {
    const eff = await LimitsResolver.forTenant(tenantId);
    return { start_date: new Date(eff.trial.startedAt), limits: eff.limits, features: { ...eff.features, trial_period_days: eff.trial.days } };
  }

  /** Can this user create another workspace? Checks system settings, the licence's instance-wide ceiling and the user's own plan. */
  static async canCreateTenant(userId: string): Promise<{ allowed: boolean; reason?: string }> {
    const sys = await SystemSettingsService.get();
    if (!sys.allowWorkspaceCreation) return { allowed: false, reason: 'Workspace creation is disabled by the platform administrator.' };
    const owned = parseInt((await pool.query('SELECT COUNT(*) FROM public.tenants WHERE user_id = $1', [userId])).rows[0]?.count || '0');
    if (sys.maxWorkspacesPerUser !== -1 && owned >= sys.maxWorkspacesPerUser) return { allowed: false, reason: `You can own at most ${sys.maxWorkspacesPerUser} workspace(s).` };
    const lic = await LicenseManager.current();
    const licMax = lic.status === 'valid' ? (lic.payload?.limits as any)?.max_tenants : undefined;
    if (typeof licMax === 'number' && licMax !== -1) {
      const total = parseInt((await pool.query('SELECT COUNT(*) FROM public.tenants').then(r => r)).rows[0]?.count || '0');
      if (total >= licMax) return { allowed: false, reason: `The licence allows at most ${licMax} workspace(s) on this installation.` };
    }
    if (lic.status === 'valid' && lic.payload?.selfHosted) return { allowed: true };
    const sub = await this.getUserSubscription(userId);
    const maxTenants = sub.limits?.max_tenants;
    if (maxTenants === undefined || maxTenants === null || maxTenants === -1) return { allowed: true };
    if (owned >= maxTenants) return { allowed: false, reason: `Tenant limit reached. Your plan allows maximum ${maxTenants} tenant(s). Please upgrade your plan.` };
    return { allowed: true };
  }

  /** Trial/plan expiry of the workspace (never true for self-hosted licences or when plan limits are off). */
  static async isTrialExpired(tenantId: string): Promise<boolean> {
    return (await LimitsResolver.forTenant(tenantId)).trial.expired;
  }

  /**
   * Enforce rate limits (per min, hourly, and daily) for the tenant.
   * Increments the count for the current periods.
   * Returns { allowed: boolean, limitType?: string }
   */
  static async checkRateLimit(tenantId: string): Promise<{ allowed: boolean; limitType?: string }> {
    const sub = await this.getTenantSubscription(tenantId);
    const limits = sub.limits;

    const rateLimits = [
      { key: 'min', limit: limits.rate_limit_per_min, windowMs: 60 * 1000 },
      { key: 'hour', limit: limits.rate_limit_per_hour, windowMs: 60 * 60 * 1000 },
      { key: 'day', limit: limits.rate_limit_per_day, windowMs: 24 * 60 * 60 * 1000 },
      { key: 'month', limit: limits.rate_limit_per_month || limits.request_per_month, windowMs: 30 * 24 * 60 * 60 * 1000 }
    ];

    for (const r of rateLimits) {
      if (r.limit === undefined || r.limit === null || r.limit === -1) {
        continue;
      }

      const timestamp = Math.floor(Date.now() / r.windowMs);
      const cacheKey = `rate:${r.key}:${tenantId}:${timestamp}`;

      let currentCount = 0;

      if (cacheEnabled()) {
        try {
          const { client } = require('../config/cache');
          if (client) {
            const count = await client.incr(cacheKey);
            if (count === 1) {
              await client.pexpire(cacheKey, r.windowMs);
            }
            currentCount = count;
          } else {
            currentCount = this.incrementInMemory(cacheKey, r.windowMs);
          }
        } catch {
          currentCount = this.incrementInMemory(cacheKey, r.windowMs);
        }
      } else {
        currentCount = this.incrementInMemory(cacheKey, r.windowMs);
      }

      if (currentCount > r.limit) {
        return { allowed: false, limitType: r.key };
      }
    }

    return { allowed: true };
  }

  private static incrementInMemory(key: string, windowMs: number): number {
    const now = Date.now();
    
    // Clean up expired entries in memory store first (basic gc)
    for (const [k, v] of this.inMemoryStore.entries()) {
      if (now > v.expiresAt) {
        this.inMemoryStore.delete(k);
      }
    }

    const existing = this.inMemoryStore.get(key);
    if (existing && now <= existing.expiresAt) {
      existing.count += 1;
      return existing.count;
    } else {
      this.inMemoryStore.set(key, { count: 1, expiresAt: now + windowMs });
      return 1;
    }
  }

  /** True when `currentValue` is still under the workspace's effective limit (-1 = unlimited). Pass the TENANT id. */
  static async checkLimit(tenantId: string, limitKey: string, currentValue: number): Promise<boolean> {
    const limit = (await LimitsResolver.forTenant(tenantId)).limits[limitKey];
    if (limit === undefined || limit === null || limit === -1) return true;
    return currentValue < limit;
  }

  /**
   * Determine if the user has an active self-host plan.
   */
  static async isSelfHost(userId: string): Promise<boolean> {
    try {
      // 1+2. A usable licence (env or settings; signature, expiry, instance binding, portal status all honoured)
      const lic = await LicenseManager.current();
      if (lic.status === 'valid' && lic.payload?.selfHosted === true) return true;

      // 3. Fallback to subscription plan check
      const { rows } = await pool.query(
        `SELECT p.name
         FROM public.subscriptions s
         JOIN public.plans p ON s.plan_id = p.id
         WHERE s.user_id = $1 AND s.status = 'active'`,
        [userId]
      );
      if (rows.length > 0) {
        return rows[0].name === 'selfhost';
      }
      return false;
    } catch {
      return false;
    }
  }
}
