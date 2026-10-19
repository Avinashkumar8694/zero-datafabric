/**
 * Shared kit for the T2 DB-backed suites (ast / crud / manifests / connections).
 * Runs ONLY against the throwaway DB on :55450 (never the developer's live hub on :5434).
 *   DATABASE_URL=postgresql://fabric_admin:fabric_password@127.0.0.1:55450/df_t2 DB_HOST=127.0.0.1 DB_PORT=55450 NODE_ENV=test npx jest src/tests/<dir> --runInBand
 * Every test file must `import '../tenancy/env'` FIRST (it blanks LICENSE_KEY before the app loads).
 */
import '../tenancy/env';
import request from 'supertest';
import { app } from '../../index';
import { pool } from '../../config/database';
import { LimitsResolver } from '../../modules/tenancy/limits.resolver';
import { WorkspaceSettingsService } from '../../modules/tenancy/workspace-settings.service';
import { clearWorkspaceStatusCache } from '../../modules/tenancy/workspace.guard';
import { CleanupService } from '../../services/cleanup.service';
import { belongsToTenant } from '../../utils/identifiers';
import { createOwnerWorkspace, createMember, adminFor, adminToken, bearer, uid, signLicense, Actor } from '../tenancy/helpers';

export { app, pool, request, bearer, uid, signLicense, adminFor, adminToken, createOwnerWorkspace, createMember };
export type { Actor };

if (!/(:|%3A)55450\//.test(process.env.DATABASE_URL || '') || process.env.DB_PORT !== '55450') {
  throw new Error('T2 suites only run against the throwaway DB on :55450 (set DATABASE_URL / DB_PORT accordingly).');
}

// Tests here are stateful (they create rows and tenants), so a blind retry would only hide the first failure: retries are opt-in.
if (Number(process.env.T2_RETRIES) > 0) jest.retryTimes(Number(process.env.T2_RETRIES));

export interface WS { owner: Actor; member: Actor; tenantId: string; schema: (logical: string) => string }

const UNLIMITED: Record<string, number> = {
  max_connections: -1, max_records_per_table: -1, max_tables: -1, max_triggers: -1, max_query_rows: -1, max_manifest_size_mb: -1,
  max_saved_analytics: -1, max_api_tokens_per_user: -1, max_users_per_workspace: -1, rate_limit_per_min: -1, rate_limit_per_hour: -1, rate_limit_per_day: -1, rate_limit_per_month: -1,
};

/** A fresh workspace (owner + member) with the trial ceilings lifted so only the limit a test sets applies. */
export async function mkWorkspace(prefix = 't2', overrides: Record<string, number> = {}): Promise<WS> {
  const owner = await createOwnerWorkspace(prefix);
  const member = await createMember(owner.tenantId);
  await setOverrides(owner.tenantId, overrides);
  return { owner, member, tenantId: owner.tenantId, schema: (l: string) => `tenant_${owner.tenantId}_${l}` };
}

export async function setOverrides(tenantId: string, overrides: Record<string, number> = {}) {
  await pool.query('UPDATE public.tenants SET plan_overrides = $2::jsonb WHERE id = $1', [tenantId, JSON.stringify({ ...UNLIMITED, ...overrides })]);
  LimitsResolver.invalidate(tenantId); WorkspaceSettingsService.clearCache(tenantId); clearWorkspaceStatusCache(tenantId);
}

export const col = (name: string, type = 'TEXT', extra: any = {}) => ({ name, type, ...extra });
export const tbl = (name: string, columns: any[], extra: any = {}) => ({ type: 'TABLE', name, columns, ...extra });
export const manifest = (resources: any[], schema = 'main', extra: any = {}) => ({ version: '4.0', schemas: [{ name: schema, resources }], ...extra });

/** POST /api/metadata/apply (force by default) with the given session token. */
export const apply = (token: string, body: any, force = true) =>
  request(app).post(`/api/metadata/apply${force ? '?force=true' : ''}`).set(bearer(token)).send(body);

export async function mustApply(token: string, body: any) {
  const r = await apply(token, body);
  if (r.status !== 200) throw new Error(`apply failed ${r.status}: ${JSON.stringify(r.body).slice(0, 800)}`);
  return r;
}

/** AST over /api/analytics/query. */
export const astQuery = (token: string, queryConfig: any, extraHeaders: Record<string, string> = {}) =>
  request(app).post('/api/analytics/query').set(bearer(token)).set(extraHeaders).send({ queryConfig });
export const engineQuery = (token: string, config: any) => request(app).post('/api/queries/engine').set(bearer(token)).send({ config });
export const transpile = (token: string, config: any) => request(app).post('/api/queries/transpile').set(bearer(token)).send(config);

export const data = (token: string, op: 'fetch' | 'create' | 'update' | 'delete' | 'call' | 'sequence', body: any) =>
  request(app).post(`/api/data/${op}`).set(bearer(token)).send(body);

const safe = async (sql: string, params: any[] = []) => { try { await pool.query(sql, params); } catch { /* best-effort cleanup */ } };

export async function relationExists(schema: string, name: string): Promise<boolean> {
  const { rows } = await pool.query('SELECT to_regclass($1) AS r', [`"${schema}"."${name}"`]);
  return !!rows[0].r;
}
export async function schemaExists(schema: string): Promise<boolean> {
  return (await pool.query('SELECT 1 FROM pg_namespace WHERE nspname = $1', [schema])).rows.length > 0;
}
export async function tenantSchemas(tenantId: string): Promise<string[]> {
  const { rows } = await pool.query(`SELECT nspname FROM pg_namespace WHERE nspname LIKE 'tenant\\_%' ORDER BY 1`);
  return rows.map((r) => r.nspname).filter((n: string) => belongsToTenant(n, tenantId));
}

/** Removes everything a workspace created (best effort, never throws). */
export async function purge(...tenantIds: string[]) {
  for (const t of tenantIds) {
    if (!t) continue;
    try { await CleanupService.purgeTenant(t); } catch { /* ignore */ }
    await safe('SELECT fabric_admin.remove_remote_source($1, name) FROM public.data_sources WHERE tenant_id = $1', [t]);
    for (const sql of [
      'DELETE FROM public.api_tokens WHERE tenant_id = $1',
      'DELETE FROM public.notification_channels WHERE tenant_id = $1',
      'DELETE FROM public.trigger_registry WHERE tenant_id = $1',
      'DELETE FROM public.plan_requests WHERE tenant_id = $1',
      'DELETE FROM fabric_system.access_policies WHERE tenant_id = $1',
      'DELETE FROM fabric_system.access_grants WHERE tenant_id = $1',
      'DELETE FROM fabric_system.fabric_constraints WHERE tenant_id = $1',
      'DELETE FROM fabric_system.metadata_history WHERE tenant_id = $1',
      'DELETE FROM fabric_system.fabric_enums WHERE tenant_id = $1',
      'DELETE FROM fabric_system.virtual_views WHERE tenant_id = $1',
      'DELETE FROM fabric_system.downstream_registry WHERE tenant_id = $1',
      'DELETE FROM fabric_catalog.relationships WHERE tenant_id = $1',
      'DELETE FROM fabric_system.query_logs WHERE tenant_id = $1',
      'DELETE FROM fabric_system.saved_analytics WHERE tenant_id = $1',
      'DELETE FROM fabric_system.fabric_sequences WHERE tenant_id = $1',
      'DELETE FROM fabric_system.replication_jobs WHERE tenant_id = $1',
      'DELETE FROM public.catalog_schemas WHERE source_id IS NULL AND (physical_name = $2 OR physical_name LIKE $3)',
      'DELETE FROM public.data_sources WHERE tenant_id = $1',
    ]) await safe(sql, sql.includes('$2') ? [t, `tenant_${t}`, `tenant\\_${t}\\_%`] : [t]);
    for (const s of await tenantSchemas(t)) await safe(`DROP SCHEMA IF EXISTS "${s}" CASCADE`);
    await safe('DELETE FROM public.users WHERE tenant_id = $1', [t]);
    await safe('DELETE FROM public.system_events WHERE tenant_id = $1', [t]);
    await safe('DELETE FROM public.tenants WHERE id = $1', [t]);
    LimitsResolver.invalidate(t); WorkspaceSettingsService.clearCache(t);
  }
}

/** Mints an API token (dft_...) for `actor` through the real endpoint. */
export async function mintToken(actor: Actor, scopes: string[], name = 't2') {
  const r = await request(app).post('/api/developer/tokens').set(bearer(actor.token)).send({ name, scopes, expiresInDays: 1 });
  if (r.status !== 201) throw new Error(`token mint failed ${r.status}: ${JSON.stringify(r.body)}`);
  return { id: r.body.id as string, token: r.body.token as string };
}

/** Splits an NDJSON body (as returned by `ndjson()`) into rows + the `{__meta__}` trailer. */
export function parseNdjson(text: string): { rows: any[]; meta: any | null } {
  const rows: any[] = []; let meta: any = null;
  for (const line of String(text || '').split('\n')) {
    if (!line.trim()) continue;
    const o = JSON.parse(line);
    if (o && o.__meta__) meta = o.__meta__; else rows.push(o);
  }
  return { rows, meta };
}

/** supertest parser that keeps a non-JSON (NDJSON) response body as text. */
export const textParser = (res: any, cb: (err: Error | null, body: any) => void) => {
  let d = ''; res.setEncoding('utf8'); res.on('data', (c: string) => { d += c; }); res.on('end', () => cb(null, d));
};

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Polls `fn` until it returns a truthy value (max `ms`, 50ms steps). */
export async function until<T>(fn: () => Promise<T | undefined | null | false>, ms = 8000): Promise<T> {
  const end = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v) return v as T;
    if (Date.now() > end) throw new Error('until(): timed out');
    await sleep(50);
  }
}

/**
 * The shared "shop" fixture: hub tables, a view, a materialized view and a canary created through a real manifest
 * apply by the workspace owner, rows inserted through /api/data/create, plus a tenant function applied by a platform
 * admin (function bodies are free-form SQL). Logical schema `shop`, function schema `fns`.
 */
export const SHOP = 'shop';
export async function seedShop(ws: WS) {
  await mustApply(ws.owner.token, manifest([
    tbl('customers', [
      col('id', 'INTEGER', { primaryKey: true }), col('name'), col('region'), col('manager_id', 'INTEGER'), col('active', 'BOOLEAN'),
      col('joined', 'DATE'), col('score', 'NUMERIC(10,2)'), col('tags', 'TEXT[]'), col('meta', 'JSONB'),
    ]),
    tbl('orders', [
      col('id', 'INTEGER', { primaryKey: true }), col('customer_id', 'INTEGER'), col('amount', 'NUMERIC(10,2)'), col('status'), col('placed', 'TIMESTAMP'),
    ]),
    tbl('canary', [col('id', 'INTEGER', { primaryKey: true }), col('note')]),
    { type: 'VIEW', name: 'v_big_orders', query: { from: { resource: 'orders' }, select: ['id', 'amount'], where: [{ column: 'amount', operator: 'GT', value: 20 }] } },
    { type: 'MATERIALIZED_VIEW', name: 'mv_status_totals', query: { from: { resource: 'orders' }, select: ['status', { aggregate: 'SUM', column: 'amount', alias: 'total' }], groupBy: ['status'] } },
  ], SHOP));
  const o = ws.owner.token;
  const c = await data(o, 'create', { schema: SHOP, resource: 'customers', data: [
    { id: 1, name: 'Ann', region: 'EU', manager_id: null, active: true, joined: '2024-01-02', score: 10.5, tags: ['a', 'b'], meta: { k: 1 } },
    { id: 2, name: 'Bob', region: 'US', manager_id: 1, active: false, joined: '2024-02-03', score: 20, tags: [], meta: null },
    { id: 3, name: 'Cy', region: 'EU', manager_id: 1, active: true, joined: '2024-03-04', score: 30, tags: null, meta: { k: 2 } },
    { id: 4, name: 'Dee', region: null, manager_id: 2, active: true, joined: '2024-04-05', score: null, tags: ['z'], meta: {} },
    { id: 5, name: 'Eve', region: 'APAC', manager_id: 2, active: true, joined: '2024-05-06', score: 50, tags: ['a'], meta: { k: 5 } },
  ] });
  if (c.status !== 200) throw new Error(`seed customers failed: ${JSON.stringify(c.body)}`);
  const od = await data(o, 'create', { schema: SHOP, resource: 'orders', data: [
    { id: 1, customer_id: 1, amount: 10, status: 'NEW', placed: '2024-06-01T10:00:00Z' },
    { id: 2, customer_id: 1, amount: 25.5, status: 'PAID', placed: '2024-06-02T10:00:00Z' },
    { id: 3, customer_id: 2, amount: 5, status: 'NEW', placed: '2024-06-03T10:00:00Z' },
    { id: 4, customer_id: 9, amount: 99, status: 'PAID', placed: '2024-06-04T10:00:00Z' },
    { id: 5, customer_id: 3, amount: 60, status: 'PAID', placed: '2024-06-05T10:00:00Z' },
    { id: 6, customer_id: 5, amount: 15, status: 'SHIPPED', placed: '2024-06-06T10:00:00Z' },
  ] });
  if (od.status !== 200) throw new Error(`seed orders failed: ${JSON.stringify(od.body)}`);
  await data(o, 'create', { schema: SHOP, resource: 'canary', data: { id: 1, note: 'alive' } });
  await pool.query(`REFRESH MATERIALIZED VIEW "${ws.schema(SHOP)}"."mv_status_totals"`);
}

/** A tenant function (platform admin applies it: owners may not submit free-form SQL). */
export async function seedFunction(ws: WS) {
  const r = await request(app).post('/api/metadata/apply?force=true').set(bearer(adminFor(ws.tenantId))).send(manifest([
    { type: 'FUNCTION', name: 'add_one', returnType: 'INTEGER', arguments: [{ name: 'x', type: 'INTEGER' }], body: 'RETURN x + 1;' },
    { type: 'FUNCTION', name: 'echo_text', returnType: 'TEXT', arguments: [{ name: 't', type: 'TEXT' }], body: 'RETURN t;' },
  ], 'fns'));
  if (r.status !== 200) throw new Error(`function seed failed: ${JSON.stringify(r.body).slice(0, 500)}`);
}

export const canaryRows = async (ws: WS): Promise<number> =>
  (await pool.query(`SELECT count(*)::int AS n FROM "${ws.schema(SHOP)}"."canary"`)).rows[0].n;

/** The "crm" fixture used by the CRUD suites: typed columns, defaults, serial, unique, check, enum, FK. */
export const CRM = 'crm';
export const crmResources = () => [
  { type: 'ENUM', name: 'tier', values: ['FREE', 'PRO', 'TEAM'] },
  tbl('items', [
    col('id', 'SERIAL', { primaryKey: true, strategy: 'LEGACY_SERIAL' }),
    col('sku', 'STRING', { length: 20, unique: true, nullable: false }),
    col('qty', 'INTEGER', { default: 0 }),
    col('price', 'NUMERIC(10,2)'),
    col('status', 'STRING', { length: 12, default: "'NEW'" }),
    col('created_at', 'TIMESTAMP', { default: 'NOW()' }),
    col('tags', 'TEXT[]'),
    col('meta', 'JSONB'),
    col('active', 'BOOLEAN', { default: true }),
    col('big', 'BIGINT'),
    col('plan', 'ENUM', { ref: 'tier' }),
    col('born', 'DATE'),
  ], { constraints: [{ name: 'chk_qty_nonneg', type: 'CHECK', expression: 'qty >= 0' }] }),
  tbl('parents', [col('id', 'INTEGER', { primaryKey: true }), col('name')]),
  tbl('children', [col('id', 'INTEGER', { primaryKey: true }), col('parent_id', 'INTEGER'), col('label')]),
  tbl('counters', [col('id', 'INTEGER', { primaryKey: true }), col('n', 'INTEGER', { default: 0 })]),
];
export const crmRelationships = () => [
  { name: 'rel_parent_children', cardinality: '1:M', from: { resource: 'parents', field: 'id' }, to: { resource: 'children', field: 'parent_id' } },
];
export async function seedCrm(ws: WS, extra: Record<string, any> = {}) {
  await mustApply(ws.owner.token, { ...manifest(crmResources(), CRM), relationships: crmRelationships(), ...extra });
}
