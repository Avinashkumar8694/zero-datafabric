/**
 * T10 — a plain member (USER, not the workspace owner) cannot mutate connections / manifests / governance /
 * replication / triggers / notification channels; reads stay open. The owner and platform admins pass the gate.
 */
import { app, pool, request, mkTenant, auth, adminToken, suffix, cleanupAll, TestTenant } from './harness';

jest.setTimeout(60000);

const U = '00000000-0000-4000-8000-000000000001';

type Ep = [method: 'post' | 'put' | 'patch' | 'delete', path: string, body?: any];
const MUTATIONS: Ep[] = [
  ['post', '/api/admin/connections', { name: 'x', config: {} }],
  ['patch', '/api/admin/connections', { sourceId: U, status: 'DISCONNECTED' }],
  ['delete', `/api/admin/connections/${U}`],
  ['post', '/api/admin/notification-channels', { channelType: 'WEBHOOK', name: 'n', config: { url: 'http://x' } }],
  ['delete', `/api/admin/notification-channels/${U}`],
  ['post', '/api/admin/notification-channels/test', { channelType: 'WEBHOOK' }],
  ['post', '/api/metadata/crawl', {}],
  ['post', '/api/metadata/sync', { source: 'x' }],
  ['post', '/api/metadata/apply', { version: '1' }],
  ['post', '/api/metadata/migrate', { migrationPlan: [] }],
  ['post', `/api/metadata/rollback/${U}`],
  ['post', '/api/metadata/downstream/toggle', { targetType: 'ELASTICSEARCH', enabled: true }],
  ['post', '/api/policies', { name: 'p', schema: 's', table: 't', rowFilter: [{ column: 'a', value: 1 }] }],
  ['delete', `/api/policies/${U}`],
  ['post', '/api/grants', { schema: 's', table: 't', grants: [{ role: 'USER', privileges: ['SELECT'] }] }],
  ['post', '/api/constraints', { schema: 's', table: 't', columns: [{ column: 'a', notNull: true }] }],
  ['post', '/api/replication', { name: 'r', sourceName: 'a', destName: 'b' }],
  ['post', `/api/replication/${U}/run`, {}],
  ['post', `/api/replication/${U}/restore`, {}],
  ['delete', `/api/replication/${U}`],
  ['post', `/api/replication/runs/${U}/pause`, {}],
  ['post', `/api/replication/runs/${U}/resume`, {}],
  ['post', '/api/triggers', { triggerName: 't' }],
  ['put', `/api/triggers/${U}`, {}],
  ['delete', `/api/triggers/${U}`],
  ['post', `/api/triggers/${U}/deploy`, {}],
  ['post', `/api/triggers/jobs/${U}/retry`, {}],
];
// it.each passes `done` as an extra argument for 2-element rows, so every row carries an explicit body
const ROWS: Ep[] = MUTATIONS.map(([m, p, b]) => [m, p, b ?? {}]);
const READS = ['/api/admin/connections', '/api/admin/notification-channels', '/api/admin/stats', '/api/admin/catalog', '/api/metadata/sources', '/api/metadata/history',
  '/api/metadata/downstream', '/api/metadata/export', '/api/metadata/template', '/api/policies', '/api/grants', '/api/constraints', '/api/triggers', '/api/replication',
  '/api/triggers/logs/list', '/api/triggers/jobs/list', '/api/saved-analytics', '/api/query-logs'];

describe('Isolation: role gates (workspace owner / platform admin vs member)', () => {
  const s = suffix();
  let T: TestTenant;
  beforeAll(async () => { T = await mkTenant(`isorg_${s}`); });
  afterAll(async () => { await cleanupAll(); });

  it.each(ROWS)('member: %s %s -> 403 WORKSPACE_ADMIN_REQUIRED', async (method, path, body) => {
    const r = await (request(app) as any)[method](path).set(auth(T.member.token)).send(body ?? {});
    expect(r.status).toBe(403);
    expect(r.body.code).toBe('WORKSPACE_ADMIN_REQUIRED');
  });

  it.each(ROWS)('owner passes the gate: %s %s -> anything but 403', async (method, path, body) => {
    // bodies are deliberately incomplete/unknown ids so nothing is really mutated; the point is "not blocked by the role gate"
    const r = await (request(app) as any)[method](path).set(auth(T.owner.token)).send(body ?? {});
    expect(r.status).not.toBe(403);
    expect(r.status).not.toBe(401);
  });

  it('platform admin passes the gate', async () => {
    const r = await request(app).post('/api/policies').set(auth(adminToken())).send({});
    expect(r.status).toBe(400); // validation error from the controller, not the gate
  });

  it('reads remain open to members', async () => {
    for (const path of READS) {
      const r = await request(app).get(path).set(auth(T.member.token));
      expect([200, 304]).toContain(r.status);
    }
  });

  it('an API token is a member and can never pass the owner gate', async () => {
    const { ApiTokenService } = await import('../../modules/auth/api-token.service');
    // tokens inherit "member" semantics: build the same request user the middleware would and run the gate directly
    const { requireWorkspaceAdmin } = await import('../../middleware/tenantAccess.middleware');
    const res: any = { statusCode: 0, status(c: number) { this.statusCode = c; return this; }, json(b: any) { this.body = b; return this; } };
    let called = false;
    await requireWorkspaceAdmin({ user: { id: T.owner.id, tenant_id: T.id, internal_role: 'USER', auth_type: 'api_token' } } as any, res, () => { called = true; });
    expect(called).toBe(false);
    expect(res.statusCode).toBe(403);
    expect(typeof ApiTokenService.authenticate).toBe('function');
  });

  it('rejected mutations changed nothing', async () => {
    const { rows } = await pool.query('SELECT count(*)::int AS n FROM public.data_sources WHERE tenant_id = $1', [T.id]);
    expect(rows[0].n).toBe(0);
  });
});
