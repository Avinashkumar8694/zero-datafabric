import request from 'supertest';
import { app } from '../../index';
import { pool } from '../../config/database';
import { IntegrationService } from '../../modules/integration/integration.service';
import { createWorkspace, cleanupWorkspace, Workspace } from './_helpers';

jest.setTimeout(60000);

describe('hub self-registration / SSRF / source-name hardening (DB-backed)', () => {
  let A: Workspace;
  const dbHost = process.env.DB_HOST as string; const dbPort = Number(process.env.DB_PORT);
  const hubCfg = (over: any = {}) => ({ type: 'postgres', host: dbHost, port: dbPort, dbName: 'datafabric', user: 'fabric_admin', pass: 'fabric_password', syncType: 'VIRTUAL', ...over });
  const sources = async () => (await pool.query('SELECT name FROM public.data_sources WHERE tenant_id = $1', [A.tenantId])).rows.map((r) => r.name);
  const servers = async () => (await pool.query(`SELECT server_name FROM fabric_admin.fdw_servers WHERE tenant_id = $1`, [A.tenantId])).rows;
  const post = (name: any, config: any) => request(app).post('/api/admin/connections').set('Authorization', `Bearer ${A.ownerToken}`).send({ name, config });

  beforeAll(async () => { A = await createWorkspace('hub'); });
  afterAll(async () => { await cleanupWorkspace(A.tenantId); });

  describe('the hub cannot be registered as a source (T8)', () => {
    it.each([
      ['hub host:port', () => hubCfg()],
      ['hub with docker alias for localhost', () => hubCfg({ host: 'localhost' })],
      ['hub via 127.0.0.1', () => hubCfg({ host: '127.0.0.1' })],
      ['hub via decimal IP', () => hubCfg({ host: '2130706433' })],
      ['hub via IPv6 loopback', () => hubCfg({ host: '[::1]' })],
      ['hub via connection string', () => ({ type: 'postgres', connectionString: `postgresql://fabric_admin:fabric_password@${dbHost}:${dbPort}/datafabric`, syncType: 'VIRTUAL' })],
      ['hub via libpq string', () => ({ type: 'postgres', connectionString: `host=${dbHost} port=${dbPort} dbname=datafabric user=fabric_admin password=fabric_password`, syncType: 'VIRTUAL' })],
      ['hub with NO password (server-side credentials must never be filled in)', () => hubCfg({ pass: undefined })],
      ['hub as SYNC source', () => hubCfg({ syncType: 'SYNC' })],
    ])('%s -> refused, nothing stored, no FDW server', async (_l, make) => {
      const cfg: any = make();
      await expect(IntegrationService.registerRemoteSource(A.tenantId, 'Local_Hub', cfg, { username: 'owner' })).rejects.toMatchObject({ code: 'HUB_SOURCE_NOT_ALLOWED', status: 403 });
      expect(await sources()).toEqual([]);
      expect(await servers()).toEqual([]);
      const res = await post('Local_Hub', make());
      expect(res.status).toBeGreaterThanOrEqual(400);
      expect(JSON.stringify(res.body)).toMatch(/hub/i);
      expect(await sources()).toEqual([]);
    });
    it('a platform admin is still refused unless ALLOW_HUB_SOURCE=true (and members never are)', async () => {
      await expect(IntegrationService.testConnection(hubCfg() as any, { isPlatformAdmin: true })).rejects.toMatchObject({ code: 'HUB_SOURCE_NOT_ALLOWED' });
      process.env.ALLOW_HUB_SOURCE = 'true';
      try {
        await expect(IntegrationService.testConnection(hubCfg() as any, { isPlatformAdmin: false })).rejects.toMatchObject({ code: 'HUB_SOURCE_NOT_ALLOWED' });
        await expect(IntegrationService.testConnection(hubCfg() as any, { isPlatformAdmin: true })).resolves.toBe(true);
      } finally { delete process.env.ALLOW_HUB_SOURCE; }
    });
    it('no server-side password is injected into a user-supplied config (fabric_admin without a password just fails to authenticate)', async () => {
      // 127.0.0.2 is not the hub (host differs) but is loopback: the connection reaches the same server on Linux/macOS loopback aliases only if routed; either way no password may be added.
      const spy = jest.spyOn(require('pg'), 'Client');
      await IntegrationService.testConnection({ type: 'postgres', host: '127.0.0.2', port: 5999, dbName: 'x', user: 'fabric_admin', syncType: 'VIRTUAL' } as any).catch(() => undefined);
      const cfgs = spy.mock.calls.map((c: any) => c[0]);
      expect(cfgs.length).toBeGreaterThan(0);
      for (const c of cfgs) expect(c.password).toBeUndefined();
      spy.mockRestore();
    });
  });

  describe('SSRF', () => {
    it.each([
      ['link-local metadata IP', { type: 'postgres', host: '169.254.169.254', port: 5432, dbName: 'x', syncType: 'VIRTUAL' }],
      ['metadata hostname', { type: 'postgres', host: 'metadata.google.internal', port: 5432, dbName: 'x', syncType: 'VIRTUAL' }],
      ['metadata via decimal', { type: 'postgres', host: '2852039166', port: 5432, dbName: 'x', syncType: 'VIRTUAL' }],
      ['metadata via elasticsearch endpoint', { type: 'elasticsearch', connectionString: 'http://169.254.169.254/latest/meta-data/', syncType: 'VIRTUAL' }],
      ['metadata via mongodb uri', { type: 'mongodb', uri: 'mongodb://169.254.169.254:27017/x', syncType: 'VIRTUAL' }],
      ['metadata via mysql connection string', { type: 'mysql', connectionString: 'mysql://u:p@169.254.169.254:3306/x', syncType: 'VIRTUAL' }],
      ['metadata via postgres URI ?host=', { type: 'postgres', connectionString: 'postgresql://u:p@db.example.com/x?host=169.254.169.254', syncType: 'VIRTUAL' }],
      ['oracle descriptor', { type: 'oracle', connectString: '(DESCRIPTION=(ADDRESS=(PROTOCOL=TCP)(HOST=169.254.169.254)(PORT=1521))(CONNECT_DATA=(SERVICE_NAME=x)))', syncType: 'VIRTUAL' }],
    ])('refuses %s with a 4xx and stores nothing', async (_l, cfg: any) => {
      await expect(IntegrationService.testConnection(cfg)).rejects.toMatchObject({ code: 'SSRF_BLOCKED' });
      const res = await post('ssrf_probe', cfg);
      expect(res.status).toBeGreaterThanOrEqual(400);
      expect(await sources()).toEqual([]);
    });
    it('private targets stay allowed by default (docker networks) and can be switched off', async () => {
      const cfg: any = { type: 'postgres', host: 'dummy', port: 5432, syncType: 'VIRTUAL' };
      await expect(IntegrationService.testConnection(cfg)).resolves.toBe(true); // dummy hosts skip the probe
      process.env.ALLOW_PRIVATE_SOURCES = 'false';
      try {
        await expect(IntegrationService.testConnection({ type: 'postgres', host: '10.1.2.3', port: 5432, dbName: 'x', syncType: 'VIRTUAL' } as any)).rejects.toMatchObject({ code: 'PRIVATE_TARGET_BLOCKED' });
        await expect(IntegrationService.testConnection({ type: 'postgres', host: 'localhost', port: 5436, dbName: 'x', syncType: 'VIRTUAL' } as any)).rejects.toMatchObject({ code: 'PRIVATE_TARGET_BLOCKED' });
      } finally { delete process.env.ALLOW_PRIVATE_SOURCES; }
    });
  });

  describe('source names (they become FDW server names)', () => {
    it.each([`a"b`, "a'b", 'a;b', 'trailing ', 'x'.repeat(49), '', '1abc', '../x', 'ünï', 'a.b', 'public.users'])('rejects %j', async (name) => {
      await expect(IntegrationService.registerRemoteSource(A.tenantId, name, { type: 'postgres', host: 'dummy', syncType: 'VIRTUAL' } as any, {})).rejects.toMatchObject({ code: 'INVALID_SOURCE_NAME' });
      expect(await sources()).toEqual([]);
    });
    it('accepts a normal name (dummy host: stored, no FDW needed)', async () => {
      const r = await IntegrationService.registerRemoteSource(A.tenantId, 'Remote_Warehouse', { type: 'postgres', host: 'dummy', syncType: 'VIRTUAL' } as any, { username: 'owner' });
      expect(r.status).toBe('INTEGRATED');
      expect(await sources()).toEqual(['Remote_Warehouse']);
    });
  });

  it('removeSource is scoped to the caller tenant', async () => {
    const other = await createWorkspace('hub2');
    try {
      const { rows } = await pool.query(`INSERT INTO public.data_sources (tenant_id, name, type, config, sync_type, status) VALUES ($1, 'Other_Src', 'postgres', '{}', 'VIRTUAL', 'CONNECTED') RETURNING id`, [other.tenantId]);
      await expect(IntegrationService.removeSource(rows[0].id, A.tenantId)).rejects.toThrow(/not found or unauthorized/);
      expect((await pool.query('SELECT 1 FROM public.data_sources WHERE id = $1', [rows[0].id])).rows.length).toBe(1);
    } finally { await cleanupWorkspace(other.tenantId); }
  });
});
