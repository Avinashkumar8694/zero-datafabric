import './env';
import request from 'supertest';
import { app } from '../../index';
import { pool } from '../../config/database';
import { adminToken, adminFor, bearer, createMember, createOwnerWorkspace, dropWorkspace, resetPlatformState, signLicense, iso, Actor, uid } from './helpers';

jest.setTimeout(60_000);

describe('system + workspace settings and licence (USER-role tokens, real DB)', () => {
  let a: Actor; let b: Actor; let memberA: Actor;
  const admin = adminToken();
  const api = (m: 'get' | 'post' | 'put' | 'delete', path: string, token: string, body?: any) => {
    const r = (request(app) as any)[m](path).set(bearer(token)); return body !== undefined ? r.send(body) : r;
  };

  beforeAll(async () => {
    await resetPlatformState(app);
    a = await createOwnerWorkspace('twa'); b = await createOwnerWorkspace('twb'); memberA = await createMember(a.tenantId);
  });
  afterAll(async () => { await resetPlatformState(app); await dropWorkspace(a); await dropWorkspace(b); await pool.query("DELETE FROM public.plans WHERE name LIKE 'tp_%'"); });

  describe('authorization matrix', () => {
    const systemPaths: Array<['get' | 'put' | 'post' | 'delete', string]> = [
      ['get', '/api/system/settings'], ['put', '/api/system/settings'], ['get', '/api/system/license'], ['post', '/api/system/license'],
      ['delete', '/api/system/license'], ['get', '/api/system/plans'], ['post', '/api/system/plans'], ['get', '/api/system/workspaces'],
      ['get', '/api/system/stats'], ['get', '/api/system/events'], ['get', '/api/system/plan-requests'],
    ];
    it.each(systemPaths)('%s %s: anonymous 401, owner 403, member 403', async (m, path) => {
      const anon = await (request(app) as any)[m](path).send({});
      expect(anon.status).toBe(401);
      expect((await api(m, path, a.token, {})).status).toBe(403);
      expect((await api(m, path, memberA.token, {})).status).toBe(403);
    });

    it('owner of A cannot read B through x-tenant-id (header ignored for non-admins)', async () => {
      const r = await request(app).get('/api/workspace').set(bearer(a.token)).set('x-tenant-id', b.tenantId);
      expect(r.status).toBe(200);
      expect(r.body.workspace.id).toBe(a.tenantId);
    });

    it('platform admin with a workspace header can read that workspace and is role platform_admin', async () => {
      const r = await request(app).get('/api/workspace').set(bearer(admin)).set('x-tenant-id', b.tenantId);
      expect(r.status).toBe(200); expect(r.body.workspace.id).toBe(b.tenantId); expect(r.body.role).toBe('platform_admin');
    });

    it('platform admin without a workspace gets NO_WORKSPACE', async () => {
      const r = await api('get', '/api/workspace', admin);
      expect(r.status).toBe(400); expect(r.body.code).toBe('NO_WORKSPACE');
    });

    it('member can read workspace + settings but not change them', async () => {
      expect((await api('get', '/api/workspace/settings', memberA.token)).status).toBe(200);
      expect((await api('put', '/api/workspace/settings/query', memberA.token, { maxRows: 10 })).status).toBe(403);
      expect((await api('put', '/api/workspace', memberA.token, { name: 'x' })).status).toBe(403);
      expect((await api('put', '/api/workspace/plan', memberA.token, { plan: 'trial' })).status).toBe(403);
    });

    it('owner of A cannot touch B (settings land in A only)', async () => {
      await api('put', '/api/workspace/settings/general', a.token, { displayName: 'Alpha' });
      const bs = await api('get', '/api/workspace/settings', b.token);
      expect(bs.body.general.displayName).toBeUndefined();
    });
  });

  describe('system settings', () => {
    it('round-trips and validates', async () => {
      const put = await api('put', '/api/system/settings', admin, { allowSelfSignup: false, maxWorkspacesPerUser: 5, defaultRegion: 'EU' });
      expect(put.status).toBe(200); expect(put.body).toMatchObject({ allowSelfSignup: false, maxWorkspacesPerUser: 5, defaultRegion: 'EU' });
      expect((await api('get', '/api/system/settings', admin)).body.maxWorkspacesPerUser).toBe(5);
    });
    it.each([
      [{ maxWorkspacesPerUser: -2 }], [{ maxWorkspacesPerUser: 1.5 }], [{ maxTokenDays: 0 }], [{ maxTokenDays: 366 }], [{ defaultRegion: 'x' }],
      [{ planLimitsEnabled: 'yes' }], [{ bogus: true }], [{ __proto__: { x: 1 }, nope: 1 }], [{ defaultPlan: 'no_such_plan' }],
    ])('rejects %j', async (body) => {
      const r = await api('put', '/api/system/settings', admin, body);
      expect(r.status).toBe(400);
    });
    it('rejects non-object bodies', async () => {
      for (const body of [[], 'x', null]) expect((await request(app).put('/api/system/settings').set(bearer(admin)).send(body as any)).status).toBe(400);
    });
  });

  describe('workspace settings', () => {
    it('validates every section and rejects unknown keys / sections', async () => {
      const bad: Array<[string, any]> = [
        ['query', { maxRows: 0 }], ['query', { maxRows: 1_000_001 }], ['query', { timeoutMs: 50 }], ['query', { x: 1 }],
        ['security', { allowedIps: ['999.1.1.1'] }], ['security', { allowedIps: ['10.0.0.0/33'] }], ['security', { allowedIps: 'nope' }],
        ['security', { allowedIps: new Array(51).fill('10.0.0.1') }], ['api', { allowedScopes: ['admin:*'] }], ['api', { maxTokenDays: 400 }],
        ['general', { timezone: 'Mars/Phobos;drop' }], ['general', { contactEmail: 'nope' }], ['general', { displayName: 'x'.repeat(101) }],
        ['notifications', { limitWarningPercent: 10 }],
      ];
      for (const [section, body] of bad) expect((await api('put', `/api/workspace/settings/${section}`, a.token, body)).status).toBe(400);
      expect((await api('put', '/api/workspace/settings/nonsense', a.token, { a: 1 })).status).toBe(404);
    });
    it('accepts valid values and returns merged defaults', async () => {
      const r = await api('put', '/api/workspace/settings/security', a.token, { allowedIps: ['10.0.0.0/8', '203.0.113.7', '2001:db8::1'] });
      expect(r.status).toBe(200); expect(r.body.allowedIps).toHaveLength(3);
      // An owner who locks their own IP out is blocked too (by design); a platform admin can recover, here via the DB.
      expect((await request(app).get('/api/workspace/limits').set(bearer(a.token))).status).toBe(403);
      await pool.query("UPDATE public.tenants SET settings = '{}'::jsonb WHERE id = $1", [a.tenantId]);
      (await import('../../modules/tenancy/workspace-settings.service')).WorkspaceSettingsService.clearCache();
    });
    it('system max token lifetime is a ceiling', async () => {
      await api('put', '/api/system/settings', admin, { maxTokenDays: 30 });
      expect((await api('put', '/api/workspace/settings/api', a.token, { maxTokenDays: 60 })).status).toBe(400);
      expect((await api('put', '/api/workspace/settings/api', a.token, { maxTokenDays: 30 })).status).toBe(200);
      await api('put', '/api/system/settings', admin, { maxTokenDays: 365 });
    });
  });

  describe('plans', () => {
    const planBody = (name: string, extra: any = {}) => ({ name, limits: { max_connections: 3 }, features: { trial_period_days: 14 }, ...extra });
    it('CRUD + validation + protected default/in-use', async () => {
      const name = uid('tp_');
      const created = await api('post', '/api/system/plans', admin, planBody(name));
      expect(created.status).toBe(201);
      expect((await api('post', '/api/system/plans', admin, planBody(name))).status).toBe(409);
      for (const bad of [planBody('x'), planBody('has space'), planBody(uid('tp_'), { limits: { nope: 1 } }), planBody(uid('tp_'), { limits: { max_tables: -5 } }),
        planBody(uid('tp_'), { features: { nope: true } }), planBody(uid('tp_'), { status: 'weird' }), planBody(uid('tp_'), { is_default: true, status: 'hidden' }),
        { ...planBody(uid('tp_')), extra: 1 }]) {
        expect((await api('post', '/api/system/plans', admin, bad)).status).toBe(400);
      }
      const id = created.body.id;
      expect((await api('put', `/api/system/plans/${id}`, admin, { limits: { max_connections: 9 } })).body.limits.max_connections).toBe(9);
      await api('put', `/api/workspace/plan`, a.token, { plan: name });
      expect((await api('delete', `/api/system/plans/${id}`, admin)).status).toBe(409); // in use
      await pool.query('UPDATE public.tenants SET plan_name = NULL WHERE id = $1', [a.tenantId]);
      expect((await api('delete', `/api/system/plans/${id}`, admin)).status).toBe(204);
      const def = await pool.query('SELECT id FROM public.plans WHERE is_default = true LIMIT 1');
      if (def.rows[0]) expect((await api('delete', `/api/system/plans/${def.rows[0].id}`, admin)).status).toBe(409);
    });
    it('public list shows only active plans; mutations need a platform admin', async () => {
      const anon = await request(app).get('/api/plans'); expect(anon.status).toBe(200);
      expect(anon.body.every((p: any) => (p.status || 'active') === 'active')).toBe(true);
      expect((await request(app).post('/api/plans').send({ name: 'hack', limits: {}, features: {} })).status).toBe(401);
      expect((await api('post', '/api/plans', a.token, { name: 'hack', limits: {}, features: {} })).status).toBe(403);
      expect((await api('delete', '/api/plans/00000000-0000-0000-0000-000000000000', a.token)).status).toBe(403);
    });
    it('self-service subscription cannot pick custom/hidden plans or inject limits', async () => {
      const p = await api('post', '/api/system/plans', admin, planBody(uid('tp_'), { is_custom: true }));
      const r = await api('post', '/api/subscriptions/me', a.token, { plan_id: p.body.id });
      expect(r.status).toBe(403);
      const act = await pool.query("SELECT id FROM public.plans WHERE COALESCE(status,'active')='active' AND is_custom=false AND name <> 'selfhost' LIMIT 1");
      const r2 = await api('post', '/api/subscriptions/me', a.token, { plan_id: act.rows[0].id, snapshot: { limits: { max_connections: 9999 } } });
      expect(r2.status).toBe(400);
      const r3 = await api('post', '/api/subscriptions/me', a.token, { plan_id: 'not-a-uuid' }); expect(r3.status).toBe(400);
    });
  });

  describe('workspace plan assignment, overrides, trial', () => {
    it('assign with overrides, extend, select with fit-check, requests cap', async () => {
      const name = uid('tp_');
      await api('post', '/api/system/plans', admin, { name, limits: { max_connections: 4, max_tables: 10, rate_limit_per_min: 100 }, features: { trial_period_days: -1 } });
      const assigned = await api('put', `/api/system/workspaces/${a.tenantId}/plan`, admin, { plan: name, overrides: { max_connections: 1 } });
      expect(assigned.status).toBe(200);
      expect(assigned.body.limits.max_connections).toBe(1); expect(assigned.body.limits.max_tables).toBe(10); expect(assigned.body.plan.name).toBe(name);
      // re-assign resets overrides
      const again = await api('put', `/api/system/workspaces/${a.tenantId}/plan`, admin, { plan: name });
      expect(again.body.limits.max_connections).toBe(4);
      // validation
      for (const bad of [{ plan: 'ghost_plan' }, { plan: name, overrides: { max_nothing: 1 } }, { plan: name, overrides: { max_tables: -9 } }, { plan: name, expiresAt: 'not a date' }, { plan: name, expiresAt: iso(-30) }, {}, { plan: name, x: 1 }]) {
        expect([400, 404]).toContain((await api('put', `/api/system/workspaces/${a.tenantId}/plan`, admin, bad)).status);
      }
      // extend
      expect((await api('post', `/api/system/workspaces/${a.tenantId}/plan/extend`, admin, { days: 0 })).status).toBe(400);
      expect((await api('post', `/api/system/workspaces/${a.tenantId}/plan/extend`, admin, { until: iso(-1) })).status).toBe(400);
      const ext = await api('post', `/api/system/workspaces/${a.tenantId}/plan/extend`, admin, { days: 10 });
      expect(ext.status).toBe(200); expect(ext.body.trial.expired).toBe(false);
      // unknown workspace
      expect((await api('put', '/api/system/workspaces/nope_nope_1/plan', admin, { plan: name })).status).toBe(404);
      expect((await api('put', "/api/system/workspaces/x'; drop table tenants--/plan", admin, { plan: name })).status).toBe(404);
      // requests cap
      for (let i = 0; i < 3; i++) expect((await api('post', '/api/workspace/plan/requests', a.token, { plan: 'enterprise_x', message: 'hi' })).status).toBe(201);
      expect((await api('post', '/api/workspace/plan/requests', a.token, { plan: 'enterprise_x' })).status).toBe(429);
      expect((await api('post', '/api/workspace/plan/requests', a.token, { plan: 'bad name!' })).status).toBe(400);
    });
    it('expired plan end date marks the trial expired and the API answers 402 for a member', async () => {
      await pool.query("UPDATE public.tenants SET plan_expires_at = NOW() - interval '1 day' WHERE id = $1", [a.tenantId]);
      const { LimitsResolver } = await import('../../modules/tenancy/limits.resolver'); LimitsResolver.invalidate(a.tenantId);
      const lim = await api('get', '/api/workspace/limits', a.token);
      expect(lim.status).toBe(200); expect(lim.body.trial.expired).toBe(true);
      await pool.query('UPDATE public.tenants SET plan_expires_at = NULL, plan_name = NULL WHERE id = $1', [a.tenantId]); LimitsResolver.invalidate(a.tenantId);
    });
  });

  describe('licence key', () => {
    afterEach(async () => { await api('delete', '/api/system/license', admin); });

    it('installs a valid key, exposes status without the secret, removes it', async () => {
      const key = signLicense({ limits: { max_connections: 7 } });
      const r = await api('post', '/api/system/license', admin, { licenseKey: key });
      expect(r.status).toBe(201); expect(r.body.status).toBe('valid'); expect(r.body.licensee).toBe('Test Corp');
      expect(JSON.stringify(r.body)).not.toContain(key.slice(0, 30));
      const g = await api('get', '/api/system/license', admin); expect(g.body.status).toBe('valid'); expect(g.body.instanceId).toBeDefined();
      expect((await api('delete', '/api/system/license', admin)).body.status).toBe('none');
    });
    it.each([
      ['garbage', () => 'not.a.jwt'], ['empty', () => ''], ['forged signature', () => signLicense({}, { forged: true })],
      ['expired', () => signLicense({ expiresAt: iso(-1) })], ['wrong instance', () => signLicense({ bound_instance_id: 'someone-else' })],
    ])('rejects %s', async (_n, mk) => {
      const r = await api('post', '/api/system/license', admin, { licenseKey: mk() });
      expect(r.status).toBe(400);
      expect((await api('get', '/api/system/license', admin)).body.status).toBe('none');
    });
    it('rejects non-string / oversized keys', async () => {
      for (const k of [123, null, {}, 'x'.repeat(20_000)]) expect((await api('post', '/api/system/license', admin, { licenseKey: k })).status).toBe(400);
    });
    it('licence is a ceiling: min(plan, licence), -1 plan becomes the licence cap', async () => {
      await api('put', `/api/system/workspaces/${a.tenantId}/plan`, admin, { plan: 'trial' });
      await api('post', '/api/system/license', admin, { licenseKey: signLicense({ limits: { max_connections: 1, max_tables: -1 } }) });
      const lim = await api('get', '/api/workspace/limits', a.token);
      expect(lim.body.limits.max_connections).toBe(1);               // trial says 2, licence caps at 1
      expect(lim.body.limits.max_tables).toBe(5);                    // licence -1 = no cap, trial value stays
      expect(lim.body.licence.status).toBe('valid');
    });
    it('self-hosted licence = unlimited unless it sets numbers; overrides cannot exceed the licence', async () => {
      await api('post', '/api/system/license', admin, { licenseKey: signLicense({ selfHosted: true, limits: { max_tables: 50 } }) });
      const lim = await api('get', '/api/workspace/limits', a.token);
      expect(lim.body.limits.max_connections).toBe(-1); expect(lim.body.limits.max_tables).toBe(50); expect(lim.body.trial.expired).toBe(false);
      await api('put', `/api/system/workspaces/${a.tenantId}/plan`, admin, { plan: 'trial', overrides: { max_tables: 1000 } });
      expect((await api('get', '/api/workspace/limits', a.token)).body.limits.max_tables).toBe(50);
    });
    it('feature flags: developer tokens disabled by licence -> 403 FEATURE_DISABLED', async () => {
      await api('post', '/api/system/license', admin, { licenseKey: signLicense({ features: { developer_tokens_enabled: false, callback_validation_enabled: false } }) });
      const r = await api('post', '/api/developer/tokens', a.token, { name: 't', scopes: ['query:read'] });
      expect(r.status).toBe(403); expect(r.body.code).toBe('FEATURE_DISABLED');
    });
    it('feature flags: distributed execution disabled -> workers add refused before touching Citus', async () => {
      await api('post', '/api/system/license', admin, { licenseKey: signLicense({ features: { distributed_execution_enabled: false, callback_validation_enabled: false } }) });
      const r = await api('post', '/api/admin/workers', admin, { name: 'w-lic-test', host: 'worker.example.com', port: 5432 });
      expect([403, 409]).toContain(r.status); // 409 CITUS_UNAVAILABLE on a non-Citus DB is acceptable, 403 when Citus is present
      if (r.status === 403) expect(r.body.code).toBe('FEATURE_DISABLED');
    });
    it('removing the licence restores plan limits immediately', async () => {
      await api('post', '/api/system/license', admin, { licenseKey: signLicense({ selfHosted: true }) });
      expect((await api('get', '/api/workspace/limits', a.token)).body.limits.max_connections).toBe(-1);
      await api('delete', '/api/system/license', admin);
      expect((await api('get', '/api/workspace/limits', a.token)).body.limits.max_connections).not.toBe(-1);
    });
    it('PLAN_LIMITS_ENABLED=false (system setting path) lifts plan limits but not the licence ceiling', async () => {
      await api('put', '/api/system/settings', admin, { planLimitsEnabled: false });
      await api('post', '/api/system/license', admin, { licenseKey: signLicense({ limits: { max_connections: 3 } }) });
      const lim = await api('get', '/api/workspace/limits', a.token);
      expect(lim.body.limits.max_tables).toBe(-1); expect(lim.body.limits.max_connections).toBe(3);
      await api('put', '/api/system/settings', admin, { planLimitsEnabled: true });
    });
  });

  describe('workspace guard (suspension, IP allow-list, maintenance)', () => {
    it('suspended workspace blocks session and API token, other workspace unaffected', async () => {
      const tok = await api('post', '/api/developer/tokens', a.token, { name: 'g', scopes: ['query:read', 'data:read'] });
      expect(tok.status).toBe(201);
      expect((await api('put', `/api/system/workspaces/${a.tenantId}`, admin, { status: 'SUSPENDED' })).status).toBe(200);
      const s1 = await request(app).get('/api/workspace').set(bearer(a.token)); expect(s1.status).toBe(403); expect(s1.body.code).toBe('TENANT_SUSPENDED');
      const s2 = await request(app).get('/api/metadata/sources').set('x-api-key', tok.body.token); expect(s2.status).toBe(403);
      expect((await api('get', '/api/workspace', b.token)).status).toBe(200);
      // owner cannot self-reactivate
      expect([401, 403]).toContain((await api('put', `/api/tenants/${a.tenantId}`, a.token, { status: 'ACTIVE' })).status);
      await api('put', `/api/system/workspaces/${a.tenantId}`, admin, { status: 'ACTIVE' });
      const { clearWorkspaceStatusCache } = await import('../../modules/tenancy/workspace.guard'); clearWorkspaceStatusCache();
      expect((await api('get', '/api/workspace', a.token)).status).toBe(200);
    });
    it('IP allow-list blocks others, platform admin bypasses', async () => {
      await api('put', '/api/workspace/settings/security', a.token, { allowedIps: ['203.0.113.0/24'] });
      const { WorkspaceSettingsService } = await import('../../modules/tenancy/workspace-settings.service'); WorkspaceSettingsService.clearCache();
      const blocked = await api('get', '/api/workspace/limits', a.token); expect(blocked.status).toBe(403); expect(blocked.body.code).toBe('IP_NOT_ALLOWED');
      expect((await request(app).get('/api/workspace/limits').set(bearer(adminFor(a.tenantId)))).status).toBe(200);
      await pool.query("UPDATE public.tenants SET settings = '{}'::jsonb WHERE id = $1", [a.tenantId]); WorkspaceSettingsService.clearCache();
    });
    it('maintenance mode blocks members (503), not platform admins', async () => {
      await api('put', '/api/system/settings', admin, { maintenanceMode: true, maintenanceMessage: 'Back soon' });
      const r = await api('get', '/api/workspace', b.token); expect(r.status).toBe(503); expect(r.body.code).toBe('MAINTENANCE');
      expect((await api('get', '/api/system/settings', admin)).status).toBe(200);
      await api('put', '/api/system/settings', admin, { maintenanceMode: false });
      expect((await api('get', '/api/workspace', b.token)).status).toBe(200);
    });
    it('developer tokens: workspace can disable them and existing tokens stop working', async () => {
      const tok = await api('post', '/api/developer/tokens', b.token, { name: 'x', scopes: ['query:read'] });
      expect(tok.status).toBe(201);
      await api('put', '/api/workspace/settings/api', b.token, { allowDeveloperTokens: false });
      const { WorkspaceSettingsService } = await import('../../modules/tenancy/workspace-settings.service'); WorkspaceSettingsService.clearCache();
      expect((await request(app).post('/api/queries/transpile').set('x-api-key', tok.body.token).send({ type: 'SELECT', query: { select: ['*'], from: { resource: 'x' } } })).status).toBe(403);
      expect((await api('post', '/api/developer/tokens', b.token, { name: 'y', scopes: ['query:read'] })).body.code).toBe('TOKENS_DISABLED');
      await api('put', '/api/workspace/settings/api', b.token, { allowDeveloperTokens: true }); WorkspaceSettingsService.clearCache();
    });
    it('token scopes limited by workspace allowedScopes', async () => {
      await api('put', '/api/workspace/settings/api', b.token, { allowedScopes: ['query:read'] });
      const { WorkspaceSettingsService } = await import('../../modules/tenancy/workspace-settings.service'); WorkspaceSettingsService.clearCache();
      expect((await api('post', '/api/developer/tokens', b.token, { name: 'w', scopes: ['data:write'] })).body.code).toBe('SCOPE_NOT_ALLOWED');
      expect((await api('post', '/api/developer/tokens', b.token, { name: 'r', scopes: ['query:read'] })).status).toBe(201);
    });
  });


  describe('licence feature wiring', () => {
    afterEach(async () => { await api('delete', '/api/system/license', admin); await api('put', `/api/system/workspaces/${a.tenantId}/plan`, admin, { plan: 'trial' }); });
    it('manifest import/export disabled by licence -> export 403 FEATURE_DISABLED', async () => {
      await api('post', '/api/system/license', admin, { licenseKey: signLicense({ features: { manifest_import_export_enabled: false, callback_validation_enabled: false } }) });
      const r = await api('get', '/api/metadata/export', a.token);
      expect(r.status).toBe(403); expect(r.body.code).toBe('FEATURE_DISABLED');
    });
    it('saved analytics cap from plan override: 0 allowed -> PLAN_LIMIT_REACHED', async () => {
      await api('put', `/api/system/workspaces/${a.tenantId}/plan`, admin, { plan: 'trial', overrides: { max_saved_analytics: 0 } });
      const r = await api('post', '/api/saved-analytics', a.token, { name: uid('sa'), config: { type: 'SELECT', query: { select: ['*'], from: { resource: 'x' } } } });
      expect(r.status).toBe(403); expect(r.body.code).toBe('PLAN_LIMIT_REACHED');
    });
    it('users per workspace cap is enforced when creating users', async () => {
      await api('put', `/api/system/workspaces/${a.tenantId}/plan`, admin, { plan: 'trial', overrides: { max_users_per_workspace: 1 } });
      const r = await request(app).post('/api/admin/users').set(bearer(admin)).send({ username: uid('capuser'), password: 'Passw0rd!x', tenantId: a.tenantId, role: 'USER' });
      expect([403, 400]).toContain(r.status);
      const n = (await pool.query('SELECT COUNT(*)::int AS n FROM public.users WHERE tenant_id = $1', [a.tenantId])).rows[0].n;
      expect(n).toBe(2); // owner + member created in beforeAll; nothing added
    });
    it('branding/SSO flags: licence custom_branding=false blocks saving login branding', async () => {
      await api('post', '/api/system/license', admin, { licenseKey: signLicense({ selfHosted: true, features: { custom_branding: false, callback_validation_enabled: false } }) });
      const r = await request(app).post('/api/settings/login').set(bearer(admin)).send({ title: 'X', logo_url: '', bg_color: '#000000' });
      expect([403]).toContain(r.status);
    });
  });

  describe('workspace creation policy', () => {
    it('allowWorkspaceCreation=false and maxWorkspacesPerUser are enforced', async () => {
      await api('put', '/api/system/settings', admin, { allowWorkspaceCreation: false });
      const r = await api('post', '/api/tenants', a.token, { name: 'Another' });
      expect(r.status).toBe(403);
      await api('put', '/api/system/settings', admin, { allowWorkspaceCreation: true, maxWorkspacesPerUser: 1 });
      expect((await api('post', '/api/tenants', a.token, { name: 'Another' })).status).toBe(403);
    });
  });
});
