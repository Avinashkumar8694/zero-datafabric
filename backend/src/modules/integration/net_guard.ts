/**
 * Outbound-target guard (SSRF + hub self-registration).
 *
 * Used for (a) data-source registration / connection tests and (b) trigger webhook URLs.
 *
 * Policy:
 *  - ALWAYS blocked: link-local / cloud-metadata targets (169.254.0.0/16, fe80::/10, `metadata.google.internal`, ...).
 *  - Hub database: a source whose host:port is the platform hub (DB_HOST/DB_PORT/DATABASE_URL, the docker aliases `db`,
 *    `datafabric-hub`, and localhost/127.0.0.1/::1 on the hub port) is refused unless the caller is a platform admin AND
 *    env `ALLOW_HUB_SOURCE=true`.
 *  - Loopback / private ranges: allowed by default (docker networks are private); refused when env
 *    `ALLOW_PRIVATE_SOURCES=false`. Webhooks use `ALLOW_PRIVATE_WEBHOOKS=true` (default: refused).
 *
 * Pure functions (no I/O) except `resolveAndAssert`, which accepts an injectable resolver so it is unit-testable.
 */
import { promises as dns } from 'dns';
import net from 'net';

export class NetGuardError extends Error {
  status: number;
  constructor(public code: string, message: string, status = 400) {
    super(message);
    this.status = status;
  }
}

export type HostClass = 'metadata' | 'loopback' | 'private' | 'public';

const METADATA_HOSTS = new Set(['metadata.google.internal', 'metadata', 'metadata.goog', 'instance-data', 'instance-data.ec2.internal', 'kubernetes.default', 'kubernetes.default.svc']);
const HUB_ALIASES = new Set(['db', 'datafabric-hub', 'datafabric_hub']);
const LOCAL_NAMES = new Set(['localhost', 'localhost.localdomain', 'ip6-localhost', 'ip6-loopback']);

/** Parses decimal / octal / hex / dotted IPv4 forms the way libc `inet_aton` does; returns the 4 octets or null. */
export function parseIPv4Loose(host: string): number[] | null {
  const h = host.trim().toLowerCase();
  if (!h || /[^0-9a-fx.]/.test(h)) return null;
  const parts = h.split('.');
  if (parts.length < 1 || parts.length > 4 || parts.some((p) => p === '')) return null;
  const nums: number[] = [];
  for (const p of parts) {
    let n: number;
    if (/^0x[0-9a-f]+$/.test(p)) n = parseInt(p, 16);
    else if (/^0[0-7]+$/.test(p)) n = parseInt(p, 8);
    else if (/^(0|[1-9][0-9]*)$/.test(p)) n = parseInt(p, 10);
    else return null;
    if (!Number.isFinite(n)) return null;
    nums.push(n);
  }
  const last = nums[nums.length - 1] as number;
  const lead = nums.slice(0, -1);
  if (lead.some((n) => n > 255)) return null;
  if (last >= 2 ** (8 * (5 - nums.length))) return null;
  let value = last;
  lead.forEach((n, i) => { value += n * 2 ** (8 * (3 - i)); });
  return [Math.floor(value / 2 ** 24) & 255, (value >>> 16) & 255, (value >>> 8) & 255, value & 255];
}

function stripBrackets(h: string): string {
  return h.startsWith('[') && h.endsWith(']') ? h.slice(1, -1) : h;
}

/** Expands an IPv6 literal (incl. IPv4-mapped) to 8 hextets, or null. */
function parseIPv6(host: string): number[] | null {
  let h = stripBrackets(host.trim().toLowerCase()).split('%')[0] as string;
  if (!net.isIPv6(h)) return null;
  const v4tail = h.match(/(\d+\.\d+\.\d+\.\d+)$/);
  if (v4tail) {
    const o = (v4tail[1] as string).split('.').map(Number);
    h = h.replace(v4tail[1] as string, `${((o[0] as number) << 8 | (o[1] as number)).toString(16)}:${((o[2] as number) << 8 | (o[3] as number)).toString(16)}`);
  }
  const [head, tail] = h.split('::');
  const a = head ? head.split(':') : [];
  const b = tail !== undefined ? (tail ? tail.split(':') : []) : [];
  const fill = tail !== undefined ? 8 - a.length - b.length : 0;
  const all = [...a, ...Array(Math.max(fill, 0)).fill('0'), ...b].map((x) => parseInt(x || '0', 16));
  return all.length === 8 ? all : null;
}

function classifyV4(o: number[]): HostClass {
  const [a, b] = o as [number, number, number, number];
  if (a === 169 && b === 254) return 'metadata';
  if (a === 100 && b === 100 && o[2] === 100 && o[3] === 200) return 'metadata'; // alibaba
  if (a === 127 || a === 0) return 'loopback';
  if (a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127)) return 'private';
  return 'public';
}

/** Classifies a host name or IP literal. Unknown names are `public` (DNS is checked separately). */
export function classifyHost(rawHost: string): HostClass {
  const host = stripBrackets(String(rawHost || '').trim().toLowerCase()).replace(/\.$/, '');
  if (!host) return 'loopback';
  if (METADATA_HOSTS.has(host)) return 'metadata';
  if (LOCAL_NAMES.has(host) || host.endsWith('.localhost')) return 'loopback';
  const v6 = parseIPv6(host);
  if (v6) {
    const allZero = v6.slice(0, 7).every((x) => x === 0);
    if (allZero && (v6[7] === 0 || v6[7] === 1)) return 'loopback'; // :: and ::1
    if (v6.slice(0, 5).every((x) => x === 0) && v6[5] === 0xffff) return classifyV4([(v6[6] as number) >> 8, (v6[6] as number) & 255, (v6[7] as number) >> 8, (v6[7] as number) & 255]);
    if (((v6[0] as number) & 0xffc0) === 0xfe80) return 'metadata'; // link-local fe80::/10
    if (v6[0] === 0xfd00 && v6[1] === 0x0ec2) return 'metadata'; // aws ipv6 imds
    if (((v6[0] as number) & 0xfe00) === 0xfc00) return 'private'; // fc00::/7
    return 'public';
  }
  const v4 = parseIPv4Loose(host);
  if (v4) return classifyV4(v4);
  return 'public';
}

export interface Target { host: string; port?: number }

/** Extracts every host[:port] a connection config / URL / connection string refers to. Unparseable input throws. */
export function extractTargets(config: any): Target[] {
  const out: Target[] = [];
  const push = (host: any, port?: any) => {
    if (typeof host !== 'string' || !host.trim()) return;
    const p = port === undefined || port === null || port === '' ? undefined : Number(port);
    const t: Target = { host: host.trim() };
    if (p !== undefined && Number.isInteger(p) && p > 0 && p < 65536) t.port = p;
    out.push(t);
  };
  const fromUrl = (u: string) => {
    // postgres/mysql/mongodb/http URLs, including multi-host (host1:27017,host2:27017)
    const m = /^([a-z][a-z0-9+.-]*):\/\/(?:[^@/?#]*@)?([^/?#]*)([^#]*)/i.exec(u.trim());
    if (!m) throw new NetGuardError('INVALID_TARGET', 'Unrecognised connection string');
    for (const hp of (m[2] as string).split(',')) {
      if (!hp) continue;
      const v6 = /^\[([^\]]+)\](?::(\d+))?$/.exec(hp);
      if (v6) { push(v6[1], v6[2]); continue; }
      const i = hp.lastIndexOf(':');
      if (i > 0 && /^\d+$/.test(hp.slice(i + 1))) push(hp.slice(0, i), hp.slice(i + 1)); else push(hp);
    }
    const q = /[?&](host|hostaddr|socketPath)=([^&]+)/gi;
    let qm: RegExpExecArray | null;
    while ((qm = q.exec(m[3] as string))) {
      const v = decodeURIComponent(qm[2] as string);
      if (v.startsWith('/')) throw new NetGuardError('INVALID_TARGET', 'Unix-socket sources are not allowed');
      for (const h of v.split(',')) push(h);
    }
  };
  const fromKeyValue = (s: string) => {
    // libpq style: host=a port=5432 dbname=x hostaddr=1.2.3.4
    let found = false;
    const hosts: string[] = [];
    let port: string | undefined;
    for (const m of s.matchAll(/(?:^|\s)(host|hostaddr|port)\s*=\s*('(?:[^'\\]|\\.)*'|\S+)/gi)) {
      found = true;
      const v = (m[2] as string).replace(/^'|'$/g, '');
      if ((m[1] as string).toLowerCase() === 'port') { port = v.split(',')[0]; continue; }
      if (v.startsWith('/')) throw new NetGuardError('INVALID_TARGET', 'Unix-socket sources are not allowed');
      for (const h of v.split(',')) hosts.push(h);
    }
    hosts.forEach((h) => push(h, port));
    return found;
  };
  const fromString = (s: string) => {
    const v = s.trim();
    if (/^[a-z][a-z0-9+.-]*:\/\//i.test(v)) return fromUrl(v);
    // Oracle descriptor: (ADDRESS=(PROTOCOL=TCP)(HOST=x)(PORT=1521))
    const hosts = [...v.matchAll(/\(\s*HOST\s*=\s*([^)\s]+)\s*\)/gi)];
    if (hosts.length) { hosts.forEach((m) => push(m[1])); return; }
    if (/\b(?:host|hostaddr)\s*=/i.test(v)) {
      if (!fromKeyValue(v)) throw new NetGuardError('INVALID_TARGET', 'Unrecognised connection string');
      return;
    }
    // easy-connect: host[:port][/service]
    const ec = /^(?:\/\/)?([^:/\s]+|\[[^\]]+\])(?::(\d+))?(?:\/.*)?$/.exec(v);
    if (ec) { push(ec[1], ec[2]); return; }
    throw new NetGuardError('INVALID_TARGET', 'Unrecognised connection string');
  };

  if (!config || typeof config !== 'object') throw new NetGuardError('INVALID_TARGET', 'Connection config must be an object');
  const c: any = config;
  push(c.host, c.port);
  push(c.hostname, c.port);
  push(c.hostaddr, c.port);
  for (const k of ['connectionString', 'uri', 'url', 'connectString', 'endpoint', 'baseUrl']) {
    if (typeof c[k] === 'string' && c[k].trim()) fromString(c[k]);
  }
  if (Array.isArray(c.hosts)) c.hosts.forEach((h: any) => (typeof h === 'string' ? push(h) : push(h?.host, h?.port)));
  if (typeof c.account === 'string' && c.account.trim()) push(/\./.test(c.account) ? c.account : `${c.account}.snowflakecomputing.com`);
  if (typeof c.socketPath === 'string' && c.socketPath) throw new NetGuardError('INVALID_TARGET', 'Unix-socket sources are not allowed');
  return out;
}

/** Hub (platform database) host names and ports derived from the environment. */
export function hubTargets(env: NodeJS.ProcessEnv = process.env): { hosts: Set<string>; ports: Set<number> } {
  const hosts = new Set<string>();
  const ports = new Set<number>();
  const add = (h?: string, p?: string | number) => {
    if (h) { const c = stripBrackets(h.trim().toLowerCase()).replace(/\.$/, ''); const v4 = parseIPv4Loose(c); hosts.add(v4 ? v4.join('.') : c); }
    const n = Number(p);
    if (p !== undefined && p !== '' && Number.isInteger(n) && n > 0) ports.add(n);
  };
  add(env.DB_HOST, env.DB_PORT);
  if (env.DATABASE_URL) {
    try { const u = new URL(env.DATABASE_URL); add(u.hostname, u.port || 5432); } catch { /* ignore */ }
  }
  if (!ports.size) ports.add(5432);
  return { hosts, ports };
}

/**
 * Is this host:port the hub database?
 *  - docker aliases (`db`, `datafabric-hub`) on the hub port(s) or 5432;
 *  - localhost / 127.x / ::1 / 0.0.0.0 on a configured hub port;
 *  - the configured hub host (DB_HOST / DATABASE_URL) on a configured hub port.
 */
export function isHubTarget(t: Target, env: NodeJS.ProcessEnv = process.env): boolean {
  const { hosts, ports } = hubTargets(env);
  const host = stripBrackets(t.host.trim().toLowerCase()).replace(/\.$/, '');
  const v4 = parseIPv4Loose(host);
  const canonical = v4 ? v4.join('.') : host;
  const port = t.port ?? 5432;
  if (HUB_ALIASES.has(canonical)) return port === 5432 || ports.has(port);
  if (classifyHost(canonical) === 'loopback') return ports.has(port);
  if (hosts.has(canonical)) return ports.has(port);
  return false;
}

export interface GuardContext {
  isPlatformAdmin?: boolean;
  env?: NodeJS.ProcessEnv;
}

/** Docker-compose developer convenience: rewrite the published host ports to the in-network service names. */
export function applyDockerAlias(t: Target): Target {
  const host = t.host.toLowerCase();
  if ((host === 'localhost' || host === '127.0.0.1') && t.port === 5436) return { host: 'datafabric-remote', port: 5432 };
  if ((host === 'localhost' || host === '127.0.0.1') && t.port === 5434) return { host: 'datafabric-hub', port: 5432 };
  return t;
}

/**
 * Synchronous policy check of every target in a source config (raw targets AND their docker-aliased form).
 * @throws NetGuardError (400/403) when a target is forbidden.
 */
export function assertSourceTargetsAllowed(config: any, ctx: GuardContext = {}): Target[] {
  const env = ctx.env || process.env;
  const targets = extractTargets(config);
  const allowHub = !!ctx.isPlatformAdmin && env.ALLOW_HUB_SOURCE === 'true';
  const allowPrivate = env.ALLOW_PRIVATE_SOURCES !== 'false';
  for (const raw of targets) {
    for (const t of [raw, applyDockerAlias(raw)]) {
      const cls = classifyHost(t.host);
      if (cls === 'metadata') throw new NetGuardError('SSRF_BLOCKED', `Connection target "${t.host}" is a link-local / cloud-metadata address and is never allowed`, 400);
      if (isHubTarget(t, env) && !allowHub) {
        throw new NetGuardError('HUB_SOURCE_NOT_ALLOWED', 'The platform hub database cannot be registered as a data source', 403);
      }
      if (!allowPrivate && (cls === 'loopback' || cls === 'private')) {
        throw new NetGuardError('PRIVATE_TARGET_BLOCKED', `Connection target "${t.host}" is a private/loopback address (ALLOW_PRIVATE_SOURCES=false)`, 400);
      }
    }
  }
  return targets;
}

export type Resolver = (host: string) => Promise<string[]>;
const defaultResolver: Resolver = async (host) => {
  const res = await dns.lookup(host, { all: true });
  return res.map((r) => r.address);
};

/**
 * Policy check plus DNS: every name is resolved and each resulting address is classified again (a public name that
 * resolves to 169.254.169.254 or to the hub is refused). Resolution failures are not errors here (the connection
 * attempt itself will fail); only a successful resolution to a forbidden address is.
 */
export async function assertSourceAllowed(config: any, ctx: GuardContext = {}, resolver: Resolver = defaultResolver): Promise<void> {
  const targets = assertSourceTargetsAllowed(config, ctx);
  const env = ctx.env || process.env;
  const allowHub = !!ctx.isPlatformAdmin && env.ALLOW_HUB_SOURCE === 'true';
  const allowPrivate = env.ALLOW_PRIVATE_SOURCES !== 'false';
  const hubHost = (() => {
    const h = env.DB_HOST || (() => { try { return new URL(env.DATABASE_URL || '').hostname; } catch { return ''; } })();
    return h || '';
  })();
  let hubAddrs: string[] | null = null;
  for (const t of targets) {
    const lit = net.isIP(stripBrackets(t.host)) || parseIPv4Loose(t.host);
    if (lit) continue;
    let addrs: string[] = [];
    try { addrs = await withTimeout(resolver(t.host), 3000); } catch { continue; }
    for (const a of addrs) {
      const cls = classifyHost(a);
      if (cls === 'metadata') throw new NetGuardError('SSRF_BLOCKED', `Connection target "${t.host}" resolves to a link-local / cloud-metadata address`, 400);
      if (!allowPrivate && (cls === 'loopback' || cls === 'private')) throw new NetGuardError('PRIVATE_TARGET_BLOCKED', `Connection target "${t.host}" resolves to a private address (ALLOW_PRIVATE_SOURCES=false)`, 400);
    }
    if (!allowHub && hubHost && t.port !== undefined) {
      if (hubAddrs === null) { try { hubAddrs = await withTimeout(resolver(hubHost), 3000); } catch { hubAddrs = []; } }
      if (addrs.some((a) => (hubAddrs as string[]).includes(a)) && isHubTarget({ host: hubHost, port: t.port }, env)) {
        throw new NetGuardError('HUB_SOURCE_NOT_ALLOWED', 'The platform hub database cannot be registered as a data source', 403);
      }
    }
  }
}

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('timeout')), ms);
    p.then((v) => { clearTimeout(t); resolve(v); }, (e) => { clearTimeout(t); reject(e); });
  });
}

/* ------------------------------ source names ----------------------------- */

const SOURCE_NAME_RE = /^[A-Za-z]([A-Za-z0-9 _-]{0,46}[A-Za-z0-9_-])?$/;

/** Source names become FDW server-name components, manifest `targetSource` values and catalog labels. */
export function assertSourceName(name: unknown): string {
  if (typeof name !== 'string' || !SOURCE_NAME_RE.test(name)) {
    throw new NetGuardError('INVALID_SOURCE_NAME', 'Invalid source name: must start with a letter and contain only letters, digits, spaces, "_" or "-" (max 48 characters, no trailing space)', 400);
  }
  return name;
}

/* --------------------------------- webhooks ------------------------------ */

export interface WebhookOptions { env?: NodeJS.ProcessEnv }

/**
 * Validates a trigger webhook URL: http/https only, no embedded credentials, no link-local/metadata, and no
 * loopback/private unless env `ALLOW_PRIVATE_WEBHOOKS=true`. Returns the normalised URL string.
 */
export function assertSafeWebhookUrl(raw: unknown, opts: WebhookOptions = {}): string {
  const env = opts.env || process.env;
  if (typeof raw !== 'string' || !raw.trim()) throw new NetGuardError('INVALID_WEBHOOK_URL', 'Webhook URL is required');
  if (raw.length > 2048) throw new NetGuardError('INVALID_WEBHOOK_URL', 'Webhook URL is longer than 2048 characters');
  if (/[\u0000- \u007f\\]/.test(raw.trim())) throw new NetGuardError('INVALID_WEBHOOK_URL', 'Webhook URL contains illegal characters');
  let u: URL;
  try { u = new URL(raw.trim()); } catch { throw new NetGuardError('INVALID_WEBHOOK_URL', 'Webhook URL is not a valid URL'); }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') throw new NetGuardError('INVALID_WEBHOOK_URL', 'Webhook URL must use http or https');
  if (u.username || u.password) throw new NetGuardError('INVALID_WEBHOOK_URL', 'Webhook URL must not contain credentials');
  const host = stripBrackets(u.hostname).replace(/\.$/, '');
  const cls = classifyHost(host);
  if (cls === 'metadata') throw new NetGuardError('SSRF_BLOCKED', 'Webhook target is a link-local / cloud-metadata address', 400);
  const allowPrivate = env.ALLOW_PRIVATE_WEBHOOKS === 'true';
  if (!allowPrivate && (cls === 'loopback' || cls === 'private')) throw new NetGuardError('PRIVATE_TARGET_BLOCKED', 'Webhook target is a private/loopback address (set ALLOW_PRIVATE_WEBHOOKS=true to allow)', 400);
  if (!allowPrivate && (HUB_ALIASES.has(host.toLowerCase()) || hubTargets(env).hosts.has(host.toLowerCase()))) {
    throw new NetGuardError('PRIVATE_TARGET_BLOCKED', 'Webhook target is an internal service name', 400);
  }
  return u.toString();
}

/** Execution-time variant: also resolves DNS and re-checks every address (defeats DNS rebinding / public names pointing inside). */
export async function assertWebhookResolvesSafe(url: string, opts: WebhookOptions = {}, resolver: Resolver = defaultResolver): Promise<void> {
  const env = opts.env || process.env;
  const safe = assertSafeWebhookUrl(url, opts);
  const host = stripBrackets(new URL(safe).hostname);
  if (net.isIP(host) || parseIPv4Loose(host)) return;
  let addrs: string[];
  try { addrs = await withTimeout(resolver(host), 3000); } catch { throw new NetGuardError('WEBHOOK_UNRESOLVABLE', 'Webhook host could not be resolved'); }
  const allowPrivate = env.ALLOW_PRIVATE_WEBHOOKS === 'true';
  for (const a of addrs) {
    const cls = classifyHost(a);
    if (cls === 'metadata') throw new NetGuardError('SSRF_BLOCKED', 'Webhook host resolves to a link-local / cloud-metadata address', 400);
    if (!allowPrivate && (cls === 'loopback' || cls === 'private')) throw new NetGuardError('PRIVATE_TARGET_BLOCKED', 'Webhook host resolves to a private address', 400);
  }
}
