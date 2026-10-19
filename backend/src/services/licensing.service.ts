import { pool } from '../config/database';
import { cacheEnabled } from '../config/cache';
import { verifyLicense } from '../utils/licensing';

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
   * Fetch active subscription for a tenant by looking up the tenant owner.
   * Maintains backward compatibility with tenant-based lookups.
   */
  static async getTenantSubscription(tenantId: string): Promise<{ start_date: Date; limits: any; features: any }> {
    // Look up the tenant's owner user
    const tenantRow = await pool.query('SELECT user_id FROM public.tenants WHERE id = $1', [tenantId]);
    if (tenantRow.rows.length > 0 && tenantRow.rows[0].user_id) {
      return this.getUserSubscription(tenantRow.rows[0].user_id);
    }

    // Fallback to trial if tenant has no owner
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
   * Check if a user can create another tenant based on their plan limits.
   */
  static async canCreateTenant(userId: string): Promise<{ allowed: boolean; reason?: string }> {
    const sub = await this.getUserSubscription(userId);
    const maxTenants = sub.limits?.max_tenants;

    if (maxTenants === undefined || maxTenants === null || maxTenants === -1) {
      return { allowed: true };
    }

    const { rows } = await pool.query(
      'SELECT COUNT(*) FROM public.tenants WHERE user_id = $1',
      [userId]
    );

    const currentCount = parseInt(rows[0]?.count || '0');
    if (currentCount >= maxTenants) {
      return {
        allowed: false,
        reason: `Tenant limit reached. Your plan allows maximum ${maxTenants} tenant(s). Please upgrade your plan.`
      };
    }

    return { allowed: true };
  }

  /**
   * Check if the trial period of a tenant has expired.
   */
  static async isTrialExpired(tenantId: string): Promise<boolean> {
    const sub = await this.getTenantSubscription(tenantId);
    const trialDays = sub.features?.trial_period_days;
    if (trialDays === undefined || trialDays === null || trialDays === -1) {
      return false; // Unlimited plan
    }

    const start = sub.start_date.getTime();
    const now = Date.now();
    const diffDays = (now - start) / (1000 * 60 * 60 * 24);

    return diffDays > trialDays;
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

  /**
   * Helper to verify if tenant is within limits for a resource creation or check.
   */
  static async checkLimit(tenantId: string, limitKey: string, currentValue: number): Promise<boolean> {
    const sub = await this.getTenantSubscription(tenantId);
    const limit = sub.limits[limitKey];
    if (limit === undefined || limit === null || limit === -1) {
      return true; // Unlimited
    }
    return currentValue < limit;
  }

  /**
   * Determine if the user has an active self-host plan.
   */
  static async isSelfHost(userId: string): Promise<boolean> {
    try {
      // 1. Try Cryptographic License Validation via Environment Variable
      const envLicense = process.env.LICENSE_KEY;
      if (envLicense) {
        const payload = verifyLicense(envLicense);
        if (payload && payload.selfHosted === true) {
          return true; // Cryptographically valid self-host license key is installed via env!
        }
      }

      // 2. Try Cryptographic License Validation via Settings Table
      const { rows: settingsRows } = await pool.query(
        "SELECT value FROM public.settings WHERE key = 'license_key'"
      );
      if (settingsRows.length > 0) {
        const val = settingsRows[0].value || {};
        if (val.license_key) {
          const payload = verifyLicense(val.license_key);
          if (payload && payload.selfHosted === true) {
            return true; // Cryptographically valid self-host license key is installed via settings!
          }
        }
      }

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
