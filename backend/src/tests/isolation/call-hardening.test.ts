/**
 * T7 — `CALL fabric_admin.*` (and any schema-qualified call outside the caller's own schemas) is refused, at the
 * application layer AND at the database layer (EXECUTE revoked from fabric_user / PUBLIC by 19-security-hardening.sql).
 */
import { app, pool, request, mkTenant, auth, suffix, cleanupAll, TestTenant } from './harness';
import { queryWithContext } from '../../config/database';

jest.setTimeout(60000);

describe('Isolation: function/procedure calls', () => {
  const s = suffix();
  let A: TestTenant; let B: TestTenant;
  beforeAll(async () => {
    A = await mkTenant(`isoca_${s}`);
    B = await mkTenant(`isocb_${s}`);
    for (const t of [A, B]) {
      await pool.query(`CREATE FUNCTION "${t.schema}".whoami() RETURNS text LANGUAGE sql AS $$ SELECT '${t.id}'::text $$`);
      await pool.query(`GRANT EXECUTE ON FUNCTION "${t.schema}".whoami() TO fabric_user`);
    }
    await pool.query(`CREATE TABLE "${A.schema}".keep (id int)`);
  });
  afterAll(async () => { await cleanupAll(); });

  const call = (tok: string, body: any, path = '/api/data/call') => request(app).post(path).set(auth(tok)).send(body);
  const engine = (tok: string, cfg: any) => request(app).post('/api/queries/engine').set(auth(tok)).send({ config: cfg });

  it('a tenant can call its own function (control), plain and qualified', async () => {
    const r1 = await call(B.owner.token, { function: 'whoami' });
    expect(r1.status).toBe(200);
    expect(JSON.stringify(r1.body.data)).toContain(B.id);
    const r2 = await call(B.owner.token, { function: `${B.schema}.whoami` });
    expect(r2.status).toBe(200);
    const r3 = await engine(B.member.token, { type: 'CALL', function: 'whoami' });
    expect(r3.status).toBe(200);
  });

  it('refuses fabric_admin.*, public.*, pg_catalog.*, other tenants\' schemas and 3-part names (HTTP 4xx, nothing executed)', async () => {
    const targets = [
      { function: 'fabric_admin.create_tenant_namespace', args: [A.id] },
      { function: 'fabric_admin.remove_remote_source', args: [A.id, 'x'] },
      { function: 'fabric_admin.register_remote_source', args: [A.id, 'x', 'h', 1, 'd', 'u', 'p', null] },
      { procedure: 'fabric_admin.create_tenant_namespace', args: [A.id] },
      { function: 'public.uuid_generate_v4' },
      { function: 'pg_catalog.pg_sleep', args: [1] },
      { function: 'pg_sleep', args: [1] },
      { function: `${A.schema}.whoami` },
      { function: 'tenant_x.y.z' },
      { function: 'fabric_catalog.whoami' },
      { function: 'whoami', schema: 'public' },
      { function: 'whoami', schema: 'fabric_admin' },
      { function: 'whoami"; DROP SCHEMA x; --' },
      { function: 'a.b.c.d' },
    ];
    for (const t of targets) {
      for (const r of [await call(B.owner.token, t), await engine(B.owner.token, { type: 'CALL', ...t }), await call(B.member.token, t, '/api/analytics/query')]) {
        expect(r.status).toBeGreaterThanOrEqual(400);
        expect(r.status).toBeLessThan(500);
      }
    }
    // A's namespace and data are intact (create_tenant_namespace would have dropped them)
    const { rows } = await pool.query(`SELECT 1 FROM information_schema.tables WHERE table_schema = $1 AND table_name = 'keep'`, [A.schema]);
    expect(rows.length).toBe(1);
  });

  it('database layer: fabric_user has no EXECUTE on fabric_admin functions, even through raw SQL', async () => {
    for (const sql of [
      `SELECT fabric_admin.create_tenant_namespace('${A.id}')`,
      `SELECT fabric_admin.remove_remote_source('${A.id}', 'x')`,
      `SELECT fabric_admin.register_remote_source('${A.id}', 'x', 'h', 1, 'd', 'u', 'p')`,
    ]) {
      await expect(queryWithContext(sql, [], { tenantId: B.id, username: 'x' })).rejects.toThrow(/permission denied/i);
    }
    const { rows } = await pool.query(`SELECT 1 FROM information_schema.tables WHERE table_schema = $1 AND table_name = 'keep'`, [A.schema]);
    expect(rows.length).toBe(1);
    const priv = await pool.query(`SELECT has_function_privilege('fabric_user','fabric_admin.create_tenant_namespace(text)','EXECUTE') AS fu, has_function_privilege('public','fabric_admin.create_tenant_namespace(text)','EXECUTE') AS pub`);
    expect(priv.rows[0]).toEqual({ fu: false, pub: false });
  });

  it('CREATE_SCHEMA through the query endpoint is idempotent and never wipes an existing namespace', async () => {
    const r = await request(app).post('/api/analytics/query').set(auth(A.owner.token)).send({ queryConfig: { type: 'CREATE_SCHEMA' } });
    expect(r.status).toBe(200);
    expect(r.body.target).toBe(A.schema);
    const { rows } = await pool.query(`SELECT 1 FROM information_schema.tables WHERE table_schema = $1 AND table_name = 'keep'`, [A.schema]);
    expect(rows.length).toBe(1);
  });
});
