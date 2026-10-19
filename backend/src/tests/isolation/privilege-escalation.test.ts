/**
 * T12 — a USER cannot self-promote through public.users, cannot read password hashes, and cannot read other tenants'
 * audit logs. Also pins the privilege clean-up of 19-security-hardening.sql (catalog / control-plane tables).
 */
import { app, pool, request, mkTenant, auth, suffix, cleanupAll, TestTenant } from './harness';
import { queryWithContext } from '../../config/database';

jest.setTimeout(60000);

describe('Isolation: privilege escalation and audit logs', () => {
  const s = suffix();
  let A: TestTenant; let B: TestTenant;
  beforeAll(async () => {
    A = await mkTenant(`isopa_${s}`);
    B = await mkTenant(`isopb_${s}`);
    for (const t of [A, B]) {
      await pool.query(`INSERT INTO fabric_admin.audit_logs (tenant_id, user_name, action, table_name, row_id, new_data) VALUES ($1, 'u', 'INSERT', 'marker', $2, '{}'::jsonb)`, [t.id, `marker_${t.id}`]);
    }
  });
  afterAll(async () => {
    await pool.query(`DELETE FROM fabric_admin.audit_logs WHERE tenant_id = ANY($1)`, [[A.id, B.id]]).catch(() => undefined);
    await cleanupAll();
  });

  describe('self-promotion', () => {
    it('data API / engine cannot address public.users (any verb, any schema spelling)', async () => {
      const calls: [string, any][] = [
        ['/api/data/update', { resource: 'users', schema: 'public', where: { username: A.owner.username }, data: { role: 'ADMIN' } }],
        ['/api/data/fetch', { resource: 'users', schema: 'public', limit: 5 }],
        ['/api/data/delete', { resource: 'users', schema: 'public', where: { username: A.member.username } }],
        ['/api/data/create', { resource: 'users', schema: 'public', data: { username: 'evil', password_hash: 'x', role: 'ADMIN' } }],
        ['/api/queries/engine', { config: { type: 'UPDATE', schema: 'public', table: 'users', data: { role: 'ADMIN' }, filter: { username: A.owner.username } } }],
        ['/api/queries/engine', { config: { type: 'SELECT', schema: 'public', limit: 5, query: { from: { resource: 'users' } } } }],
        ['/api/analytics/query', { queryConfig: { type: 'SELECT', schema: 'PUBLIC', limit: 5, query: { from: { resource: 'users' } } } }],
      ];
      for (const [path, body] of calls) {
        const r = await request(app).post(path).set(auth(A.owner.token)).send(body);
        expect(r.status).toBeGreaterThanOrEqual(400);
        expect(JSON.stringify(r.body)).not.toMatch(/password_hash|\$2[aby]\$/);
      }
      const { rows } = await pool.query('SELECT role FROM public.users WHERE id = ANY($1::uuid[])', [[A.owner.id, A.member.id]]);
      expect(rows.map((r) => r.role)).toEqual(['USER', 'USER']);
      const evil = await pool.query(`SELECT 1 FROM public.users WHERE username = 'evil'`);
      expect(evil.rows.length).toBe(0);
    });

    it('database layer: fabric_user cannot read, update, insert or delete public.users', async () => {
      const ctx = { tenantId: A.id, username: A.owner.username };
      for (const sql of [
        `UPDATE public.users SET role = 'ADMIN' WHERE username = '${A.owner.username}'`,
        `SELECT password_hash FROM public.users`,
        `SELECT * FROM public.users`,
        `INSERT INTO public.users (username, password_hash, role) VALUES ('evil2', 'x', 'ADMIN')`,
        `DELETE FROM public.users WHERE username = '${A.member.username}'`,
      ]) {
        await expect(queryWithContext(sql, [], ctx)).rejects.toThrow(/permission denied/i);
      }
    });

    it('a USER cannot reach platform-admin endpoints', async () => {
      for (const [method, path] of [['get', '/api/admin/users'], ['get', '/api/admin/tenants'], ['get', '/api/admin/audit-logs'], ['post', '/api/admin/tenants'], ['post', '/api/admin/users']] as const) {
        const r = await (request(app) as any)[method](path).set(auth(A.owner.token)).send({});
        expect(r.status).toBe(403);
      }
    });
  });

  describe('audit logs', () => {
    it('public.audit_logs is a security_invoker view and the caller only sees their own tenant', async () => {
      const opts = await pool.query(`SELECT reloptions FROM pg_class WHERE oid = 'public.audit_logs'::regclass`);
      expect(opts.rows[0].reloptions).toContain('security_invoker=true');
      for (const [self, other] of [[A, B], [B, A]] as const) {
        const r = await queryWithContext(`SELECT tenant_id, row_id FROM public.audit_logs WHERE row_id LIKE 'marker_%'`, [], { tenantId: self.id, username: 'x' });
        expect(r.rows.map((x) => x.row_id)).toEqual([`marker_${self.id}`]);
        const direct = await queryWithContext(`SELECT tenant_id FROM fabric_admin.audit_logs WHERE row_id LIKE 'marker_%'`, [], { tenantId: self.id, username: 'x' });
        expect(direct.rows.map((x) => x.tenant_id)).toEqual([self.id]);
        expect(JSON.stringify(r.rows)).not.toContain(other.id);
      }
    });

    it('HTTP: stats and events expose only the caller\'s tenant', async () => {
      const ev = await request(app).get('/api/events').set(auth(A.owner.token));
      expect(ev.status).toBe(200);
      expect(JSON.stringify(ev.body)).not.toContain(B.id);
      const stats = await request(app).get('/api/admin/stats').set(auth(B.owner.token));
      expect(stats.status).toBe(200);
      const own = await queryWithContext('SELECT COUNT(*)::int AS n FROM public.audit_logs', [], { tenantId: B.id, username: 'x' });
      expect(stats.body.audits).toBeLessThanOrEqual(own.rows[0].n);
    });
  });

  describe('control-plane privileges of fabric_user (19-security-hardening.sql)', () => {
    const ctx = () => ({ tenantId: A.id, username: 'x' });
    it('catalog tables are read-only for fabric_user and invisible to PUBLIC', async () => {
      await expect(queryWithContext(`INSERT INTO public.catalog_schemas (name, physical_name) VALUES ('x','x')`, [], ctx())).rejects.toThrow(/permission denied/i);
      await expect(queryWithContext(`DELETE FROM public.catalog_tables`, [], ctx())).rejects.toThrow(/permission denied/i);
      await expect(queryWithContext(`UPDATE fabric_catalog.relationships SET name = 'x'`, [], ctx())).rejects.toThrow(/permission denied/i);
      await expect(queryWithContext(`TRUNCATE public.catalog_schemas CASCADE`, [], ctx())).rejects.toThrow(/permission denied/i);
      await expect(queryWithContext(`SELECT count(*) FROM public.catalog_tables`, [], ctx())).resolves.toBeDefined();
      const pub = await pool.query(`SELECT has_table_privilege('public', 'public.catalog_schemas', 'SELECT') AS s, has_table_privilege('public', 'public.catalog_tables', 'INSERT') AS i, has_table_privilege('public', 'fabric_catalog.relationships', 'UPDATE') AS u`);
      expect(pub.rows[0]).toEqual({ s: false, i: false, u: false });
    });
    it('fabric_system (policies, grants, query logs, metadata history) is not reachable as fabric_user', async () => {
      for (const t of ['fabric_system.metadata_history', 'fabric_system.downstream_registry', 'fabric_system.access_policies', 'fabric_system.query_logs']) {
        await expect(queryWithContext(`SELECT * FROM ${t} LIMIT 1`, [], ctx())).rejects.toThrow(/permission denied/i);
      }
    });
    it('statistics views that expose other tenants\' SQL text are closed', async () => {
      await expect(queryWithContext(`SELECT query FROM public.pg_stat_statements LIMIT 1`, [], ctx())).rejects.toThrow(/permission denied/i);
    });
    it('the application owner pool is unaffected (control)', async () => {
      await expect(pool.query('SELECT count(*) FROM public.users')).resolves.toBeDefined();
      await expect(pool.query('SELECT count(*) FROM fabric_system.metadata_history')).resolves.toBeDefined();
    });
  });
});
