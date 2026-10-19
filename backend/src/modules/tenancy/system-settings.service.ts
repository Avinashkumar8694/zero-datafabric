/**
 * System (platform-wide) settings, stored in public.settings under key `system`.
 * Changed only by platform admins (/api/system/settings); read by the limits resolver,
 * the workspace guard and tenant creation. Cached briefly; changes clear the cache.
 */
import { pool } from '../../config/database';
import { SectionSpec, validateSection } from './validate';

export interface SystemSettings {
  defaultPlan: string | null;
  planLimitsEnabled: boolean;
  allowSelfSignup: boolean;
  allowWorkspaceCreation: boolean;
  maxWorkspacesPerUser: number;
  defaultRegion: string;
  maintenanceMode: boolean;
  maintenanceMessage: string;
  maxTokenDays: number;
}

export const SYSTEM_DEFAULTS: SystemSettings = {
  defaultPlan: null,
  planLimitsEnabled: process.env.PLAN_LIMITS_ENABLED !== 'false',
  allowSelfSignup: true,
  allowWorkspaceCreation: true,
  maxWorkspacesPerUser: -1,
  defaultRegion: process.env.DEFAULT_REGION || 'AP',
  maintenanceMode: false,
  maintenanceMessage: '',
  maxTokenDays: 365,
};

export const SYSTEM_SPEC: SectionSpec = {
  defaultPlan: { type: 'string', maxLen: 100, nullable: true, pattern: /^[A-Za-z0-9_-]{1,100}$/ },
  planLimitsEnabled: { type: 'boolean' },
  allowSelfSignup: { type: 'boolean' },
  allowWorkspaceCreation: { type: 'boolean' },
  maxWorkspacesPerUser: { type: 'int', min: -1, max: 10000 },
  defaultRegion: { type: 'string', maxLen: 8, pattern: /^[A-Za-z]{2,8}$/ },
  maintenanceMode: { type: 'boolean' },
  maintenanceMessage: { type: 'string', maxLen: 300 },
  maxTokenDays: { type: 'int', min: 1, max: 365 },
};

let cache: { at: number; value: SystemSettings } | null = null;
const TTL_MS = 10_000;

export class SystemSettingsService {
  static clearCache() { cache = null; }

  static async get(): Promise<SystemSettings> {
    if (cache && Date.now() - cache.at < TTL_MS) return cache.value;
    let stored: any = {};
    try {
      const { rows } = await pool.query("SELECT value FROM public.settings WHERE key = 'system'");
      stored = rows[0]?.value || {};
    } catch { /* table missing on a not-yet-migrated DB: defaults */ }
    const value = { ...SYSTEM_DEFAULTS };
    for (const k of Object.keys(SYSTEM_SPEC)) if (stored[k] !== undefined && stored[k] !== null || (k === 'defaultPlan' && stored[k] === null)) (value as any)[k] = stored[k];
    cache = { at: Date.now(), value };
    return value;
  }

  static async update(patch: unknown, actor: string): Promise<SystemSettings> {
    const clean = validateSection(SYSTEM_SPEC, patch, 'system');
    if (!Object.keys(clean).length) return this.get();
    if (clean.defaultPlan) {
      const { rows } = await pool.query("SELECT 1 FROM public.plans WHERE name = $1 AND COALESCE(status,'active') = 'active' AND COALESCE(is_custom,false) = false", [clean.defaultPlan]);
      if (!rows.length) { const e: any = new Error('defaultPlan must be an active, non-custom plan'); e.status = 400; e.code = 'INVALID_SETTINGS'; throw e; }
    }
    const current = await this.get();
    const next = { ...current, ...clean };
    await pool.query(
      `INSERT INTO public.settings (key, value) VALUES ('system', $1) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`, [JSON.stringify(next)]);
    await pool.query('INSERT INTO public.system_events (actor, action, detail) VALUES ($1,$2,$3)', [actor, 'SYSTEM_SETTINGS_UPDATED', JSON.stringify({ changed: clean })]).catch(() => {});
    this.clearCache();
    return next;
  }
}
