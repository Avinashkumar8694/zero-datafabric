/**
 * Workspace settings: sparse JSON in tenants.settings, one object per section. Strictly
 * validated; clamped by system settings and the licence ceiling where relevant.
 */
import net from 'net';
import { pool } from '../../config/database';
import { SectionSpec, SettingsError, validateSection } from './validate';
import { TOKEN_SCOPES } from '../auth/token-scopes';

export const WORKSPACE_SECTIONS = ['general', 'query', 'security', 'api', 'notifications'] as const;
export type WorkspaceSection = typeof WORKSPACE_SECTIONS[number];

const validTz = (tz: string) => { try { new Intl.DateTimeFormat('en', { timeZone: tz }); return true; } catch { return false; } };

export function isValidIpOrCidr(v: string): boolean {
  const [ip, bits, extra] = v.split('/');
  if (extra !== undefined) return false;
  const fam = net.isIP(ip || '');
  if (!fam) return false;
  if (bits === undefined) return true;
  if (!/^\d{1,3}$/.test(bits)) return false;
  return Number(bits) <= (fam === 4 ? 32 : 128);
}

const ip4ToInt = (ip: string) => ip.split('.').reduce((a, o) => (a << 8) + Number(o), 0) >>> 0;

/** True when `ip` is inside any of the allowed IPs / CIDRs (IPv4 CIDR; IPv6 exact match only). */
export function ipAllowed(ip: string | undefined, allowed: string[]): boolean {
  if (!allowed.length) return true;
  if (!ip) return false;
  const clean = ip.startsWith('::ffff:') ? ip.slice(7) : ip;
  return allowed.some(rule => {
    const [base, bits] = rule.split('/');
    if (net.isIPv4(clean) && net.isIPv4(base || '')) {
      const b = bits === undefined ? 32 : Number(bits);
      const mask = b === 0 ? 0 : (~0 << (32 - b)) >>> 0;
      return (ip4ToInt(clean) & mask) === (ip4ToInt(base!) & mask);
    }
    return clean === base;
  });
}

export const WORKSPACE_SPECS: Record<WorkspaceSection, SectionSpec> = {
  general: {
    displayName: { type: 'string', maxLen: 100 },
    timezone: { type: 'string', maxLen: 64, pattern: /^[A-Za-z_]+(\/[A-Za-z0-9_+-]+){0,2}$|^UTC$/ },
    defaultRegion: { type: 'string', maxLen: 8, pattern: /^[A-Za-z]{2,8}$/ },
    contactEmail: { type: 'string', maxLen: 200, pattern: /^[^\s@]+@[^\s@]+\.[^\s@]+$/ },
  },
  query: {
    maxRows: { type: 'int', min: 1, max: 1_000_000 },
    timeoutMs: { type: 'int', min: 100, max: 300_000 },
    allowStreaming: { type: 'boolean' },
  },
  security: {
    allowedIps: { type: 'stringList', maxItems: 50, maxLen: 49, item: isValidIpOrCidr },
  },
  api: {
    allowDeveloperTokens: { type: 'boolean' },
    maxTokenDays: { type: 'int', min: 1, max: 365 },
    allowedScopes: { type: 'stringList', maxItems: TOKEN_SCOPES.length, maxLen: 32, allowed: TOKEN_SCOPES },
  },
  notifications: {
    emailOnLimit: { type: 'boolean' },
    limitWarningPercent: { type: 'int', min: 50, max: 100 },
  },
};

export const WORKSPACE_DEFAULTS: Record<WorkspaceSection, Record<string, unknown>> = {
  general: { timezone: 'UTC' },
  query: { allowStreaming: true },
  security: { allowedIps: [] },
  api: { allowDeveloperTokens: true, allowedScopes: [...TOKEN_SCOPES] },
  notifications: { emailOnLimit: true, limitWarningPercent: 80 },
};

const cache = new Map<string, { at: number; value: any }>();
const TTL_MS = 5_000;

export class WorkspaceSettingsService {
  static clearCache(tenantId?: string) { if (tenantId) cache.delete(tenantId); else cache.clear(); }

  /** Full settings with defaults filled in. Unknown workspace -> defaults (callers verify existence separately). */
  static async get(tenantId: string): Promise<Record<WorkspaceSection, Record<string, any>>> {
    const hit = cache.get(tenantId);
    if (hit && Date.now() - hit.at < TTL_MS) return hit.value;
    const { rows } = await pool.query('SELECT settings FROM public.tenants WHERE id = $1', [tenantId]);
    const stored = rows[0]?.settings || {};
    const out: any = {};
    for (const s of WORKSPACE_SECTIONS) out[s] = { ...WORKSPACE_DEFAULTS[s], ...(stored[s] || {}) };
    cache.set(tenantId, { at: Date.now(), value: out });
    return out;
  }

  static async updateSection(tenantId: string, section: string, patch: unknown, actor: string, ceilings: { maxTokenDays: number; maxQueryRows: number }) {
    if (!(WORKSPACE_SECTIONS as readonly string[]).includes(section)) throw new SettingsError(404, 'UNKNOWN_SECTION', `Unknown settings section "${section.slice(0, 40)}"`);
    const sec = section as WorkspaceSection;
    const clean = validateSection(WORKSPACE_SPECS[sec], patch, sec);
    if (sec === 'api' && typeof clean.maxTokenDays === 'number' && clean.maxTokenDays > ceilings.maxTokenDays) throw new SettingsError(400, 'EXCEEDS_SYSTEM_LIMIT', `api.maxTokenDays cannot exceed the system maximum of ${ceilings.maxTokenDays}`);
    if (sec === 'query' && typeof clean.maxRows === 'number' && ceilings.maxQueryRows !== -1 && clean.maxRows > ceilings.maxQueryRows) throw new SettingsError(400, 'EXCEEDS_LICENCE_LIMIT', `query.maxRows cannot exceed the licensed maximum of ${ceilings.maxQueryRows}`);
    const { rowCount } = await pool.query(
      `UPDATE public.tenants SET settings = jsonb_set(COALESCE(settings,'{}'::jsonb), ARRAY[$2]::text[], COALESCE(settings->$2,'{}'::jsonb) || $3::jsonb, true) WHERE id = $1`,
      [tenantId, sec, JSON.stringify(clean)]);
    if (!rowCount) throw new SettingsError(404, 'WORKSPACE_NOT_FOUND', 'workspace not found');
    await pool.query('INSERT INTO public.system_events (actor, action, tenant_id, detail) VALUES ($1,$2,$3,$4)', [actor, 'WORKSPACE_SETTINGS_UPDATED', tenantId, JSON.stringify({ section: sec, changed: clean })]).catch(() => {});
    this.clearCache(tenantId);
    return (await this.get(tenantId))[sec];
  }
}
