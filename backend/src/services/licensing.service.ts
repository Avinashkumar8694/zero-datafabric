import { pool } from '../config/database';
import { cacheEnabled } from '../config/cache';

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
   * Fetch active subscription for a tenant.
   * If tenant has no subscription, check if they are the admin tenant (tenant_A),
   * which gets selfhost unlimited plan.
   * For other tenants, return a default trial subscription.
   */
  static async getTenantSubscription(tenantId: string): Promise<{ start_date: Date; limits: any; features: any }> {
    if (tenantId === 'tenant_A') {
      return {
        start_date: new Date(2000, 0, 1),
        limits: {
          max_connections: -1,
          max_records_per_table: -1,
          max_tables: -1,
          max_triggers: -1,
          max_replication_tables: -1,
          max_replication_rows: -1,
          rate_limit_per_min: -1,
          rate_limit_per_hour: -1,
          rate_limit_per_day: -1
        },
        features: {
          trial_period_days: -1
        }
      };
    }

    const { rows } = await pool.query(
      `SELECT s.start_date, s.snapshot, p.limits as plan_limits, p.features as plan_features
       FROM public.subscriptions s
       JOIN public.plans p ON s.plan_id = p.id
       WHERE s.tenant_id = $1 AND s.status = 'active'`,
      [tenantId]
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
      rate_limit_per_min: 10,
      rate_limit_per_hour: 100,
      rate_limit_per_day: 1000
    };
    const features = trialPlan.rows[0]?.features || { trial_period_days: 7 };

    // Find tenant creation date as the start date
    const tenantRow = await pool.query('SELECT created_at FROM public.tenants WHERE id = $1', [tenantId]);
    const startDate = tenantRow.rows[0] ? new Date(tenantRow.rows[0].created_at) : new Date();

    return {
      start_date: startDate,
      limits,
      features
    };
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
      { key: 'day', limit: limits.rate_limit_per_day, windowMs: 24 * 60 * 60 * 1000 }
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
}
