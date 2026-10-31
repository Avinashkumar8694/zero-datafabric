import { pool } from '../config/database';
import { belongsToTenant, escapeLike, quoteAnyIdent } from '../utils/identifiers';
import { assertTenantIdSafe } from '../utils/tenantScope';

export class CleanupService {
  /**
   * Run the data cleanup process for users whose plan requires daily cleanups.
   * Runs the checks every hour, determining if it is 2:00 AM in the user's timezone.
   */
  static async startCleanupScheduler() {
    console.log('[Cleanup] Starting hourly data cleanup scheduler...');
    // Run checks every hour
    setInterval(async () => {
      try {
        await this.runCleanupChecks();
      } catch (err: any) {
        console.error('[Cleanup] Error running cleanup checks:', err.message);
      }
    }, 60 * 60 * 1000); // 1 hour interval
    
    // Also run once immediately at startup
    this.runCleanupChecks().catch((err: any) => {
      console.error('[Cleanup] Startup error running cleanup checks:', err.message);
    });
  }

  static async runCleanupChecks() {
    console.log('[Cleanup] Running timezone-aware cleanup checks...');
    const now = new Date();
    
    // Find all active subscriptions
    const { rows: subs } = await pool.query(
      `SELECT s.id as sub_id, s.user_id, s.last_cleanup_at, u.timezone, p.limits as plan_limits, s.snapshot
       FROM public.subscriptions s
       JOIN public.plans p ON s.plan_id = p.id
       JOIN public.users u ON s.user_id = u.id
       WHERE s.status = 'active'`
    );

    console.log(`[Cleanup] Found ${subs.length} active subscription(s) to check.`);

    for (const sub of subs) {
      const limits = sub.snapshot?.limits || sub.plan_limits || {};
      const frequency = limits.data_cleanup_frequency || 'none';
      const hour = limits.data_cleanup_hour !== undefined ? parseInt(limits.data_cleanup_hour) : 2;

      if (frequency === 'none') {
        continue;
      }

      const userTz = sub.timezone || 'Asia/Kolkata'; // Default to IST (Asia/Kolkata)
      
      // Get local date strings
      const todayStr = this.getLocalDateString(now, userTz);
      const lastStr = sub.last_cleanup_at ? this.getLocalDateString(new Date(sub.last_cleanup_at), userTz) : '';
      
      // Get local hour in user's timezone
      const currentHour = this.getLocalHour(now, userTz);
      
      // Determine if today is the correct day to cleanup in user's timezone
      let isDayToCleanup = true;
      if (frequency === 'weekly') {
        const localDate = new Date(now.toLocaleString('en-US', { timeZone: userTz }));
        isDayToCleanup = localDate.getDay() === 0; // 0 is Sunday (Clean up weekly every Sunday)
      }
      
      console.log(`   User: ${sub.user_id} | Timezone: ${userTz} | Frequency: ${frequency} | Target Hour: ${hour} | Local Hour: ${currentHour} | Today Local: ${todayStr} | Last Cleanup Local: ${lastStr} | Day Matches: ${isDayToCleanup}`);

      // Perform cleanup if hour and day match, and hasn't been done yet today
      if (currentHour === hour && isDayToCleanup && todayStr !== lastStr) {
        await this.cleanupUserData(sub.user_id);
        
        // Record the last cleanup time
        await pool.query(
          'UPDATE public.subscriptions SET last_cleanup_at = NOW() WHERE id = $1',
          [sub.sub_id]
        );
        console.log(`   ✔ Cleanup recorded for sub ${sub.sub_id}`);
      }
    }
  }

  static async cleanupUserData(userId: string) {
    console.log(`[Cleanup] Initiating data purge for user ${userId}...`);
    try {
      // Find all tenants owned by this user
      const { rows: tenants } = await pool.query('SELECT id FROM public.tenants WHERE user_id = $1', [userId]);
      
      for (const t of tenants) {
        const tenantId = t.id;
        console.log(`   [Cleanup] Purging tenant namespace: ${tenantId}...`);
        await this.purgeTenant(String(tenantId));
      }
      
      console.log(`[Cleanup] Successfully purged data for user ${userId}.`);
    } catch (err: any) {
      console.error(`[Cleanup] Error purging data for user ${userId}:`, err.message);
    }
  }

  /**
   * Purges one tenant's data. Every step is independent and tolerant: a missing table/schema or a failing statement is
   * logged and the remaining steps still run (the old version aborted at the first non-existent table and never reached
   * the schema drop). Registry tables that may not exist yet on a given install are simply skipped.
   * @returns the list of steps that failed (empty when everything succeeded).
   */
  static async purgeTenant(tenantId: string): Promise<{ step: string; error: string }[]> {
    const failures: { step: string; error: string }[] = [];
    const step = async (name: string, fn: () => Promise<any>) => {
      try { await fn(); } catch (err: any) {
        failures.push({ step: name, error: err.message });
        console.warn(`   [Cleanup] step "${name}" skipped/failed for ${tenantId}: ${err.message}`);
      }
    };

    // Remove metadata, catalog schemas, and data sources
    await step('catalog metadata', () => pool.query('DELETE FROM fabric_catalog.metadata WHERE source_id IN (SELECT id FROM public.data_sources WHERE tenant_id = $1)', [tenantId]));
    await step('catalog schemas', () => pool.query('DELETE FROM public.catalog_schemas WHERE source_id IN (SELECT id FROM public.data_sources WHERE tenant_id = $1)', [tenantId]));
    await step('relationships', () => pool.query('DELETE FROM fabric_catalog.relationships WHERE tenant_id = $1', [tenantId]));
    await step('data sources', () => pool.query('DELETE FROM public.data_sources WHERE tenant_id = $1', [tenantId]));

    // Jobs, query logs, audit logs, saved analytics (real table names; each one optional)
    await step('replication jobs', () => pool.query('DELETE FROM fabric_system.replication_jobs WHERE tenant_id = $1', [tenantId]));
    await step('copy jobs', () => pool.query('DELETE FROM fabric_system.copy_jobs WHERE tenant_id = $1', [tenantId]));
    await step('query logs', () => pool.query('DELETE FROM fabric_system.query_logs WHERE tenant_id = $1', [tenantId]));
    await step('saved analytics', () => pool.query('DELETE FROM fabric_system.saved_analytics WHERE tenant_id = $1', [tenantId]));
    await step('audit logs', () => pool.query('DELETE FROM public.audit_logs WHERE tenant_id = $1', [tenantId]));

    // Drop this tenant's dynamic schemas: EXACTLY tenant_<id> and tenant_<id>_<logical> (escaped LIKE + belongsToTenant),
    // never `LIKE 'tenant_<id>%'` (which also matches tenants whose id merely starts with this one, and `_` wildcards).
    let tid: string | null = null;
    try { tid = assertTenantIdSafe(tenantId); } catch (err: any) { failures.push({ step: 'tenant id', error: err.message }); }
    if (tid) {
      let schemaNames: string[] = [];
      await step('list schemas', async () => {
        const { rows } = await pool.query(
          `SELECT schema_name FROM information_schema.schemata WHERE schema_name = $1 OR schema_name LIKE $2 ESCAPE '\\'`,
          [`tenant_${tid}`, `${escapeLike(`tenant_${tid}_`)}%`]
        );
        schemaNames = rows.map((r: any) => String(r.schema_name)).filter((n: string) => belongsToTenant(n, tid!));
      });
      for (const name of schemaNames) {
        await step(`drop schema ${name}`, () => pool.query(`DROP SCHEMA IF EXISTS ${quoteAnyIdent(name)} CASCADE`));
      }

      // Re-create primary tenant schema space so resources remain clean but functional
      await step('recreate namespace', async () => {
        await pool.query('SELECT fabric_admin.create_tenant_namespace($1)', [tid]);
        await pool.query(`GRANT CREATE ON SCHEMA ${quoteAnyIdent(`tenant_${tid}`)} TO fabric_user`);
      });
    }
    return failures;
  }

  private static getLocalDateString(date: Date, timezone: string): string {
    try {
      const formatter = new Intl.DateTimeFormat('en-US', {
        timeZone: timezone,
        year: 'numeric',
        month: '2-digit',
        day: '2-digit'
      });
      return formatter.format(date);
    } catch {
      // Fallback
      return date.toDateString();
    }
  }

  private static getLocalHour(date: Date, timezone: string): number {
    try {
      const formatter = new Intl.DateTimeFormat('en-US', {
        timeZone: timezone,
        hour: 'numeric',
        hour12: false
      });
      return parseInt(formatter.format(date));
    } catch {
      // Fallback to UTC
      return date.getUTCHours();
    }
  }
}
