import { Client } from 'pg';
import { pool } from '../../config/database';
import { assertThrowawayDb, cleanupWorkspace, createWorkspace, uniq, Workspace } from './_helpers';

jest.setTimeout(90000);

const adminUrl = (db: string) => (process.env.DATABASE_URL as string).replace(/\/[^/]+$/, `/${db}`);

describe('FDW server naming and import allow-list (DB-backed)', () => {
  assertThrowawayDb();
  const remoteDb = `df_remote_${Date.now().toString(36)}`;
  const tag = uniq('fdw').replace(/[^a-z0-9_]/gi, '').slice(0, 14);
  let T1: Workspace; let T2: Workspace; let TA: Workspace; let TL: Workspace;
  // postgres_fdw connects FROM the database server, so it must use the in-container address (the cluster listens on 5432 inside df-test-db)
  const host = '127.0.0.1'; const port = 5432;
  // tenant ids that collided under the old naming: (a, b_c) and (a_b, c) both gave server_a_b_c
  const register = (tenant: string, source: string, db = remoteDb) =>
    pool.query('SELECT fabric_admin.register_remote_source($1, $2, $3, $4, $5, $6, $7, NULL)', [tenant, source, host, port, db, 'fabric_admin', 'fabric_password']);
  const serverNames = async (tenant: string) => (await pool.query('SELECT server_name, source_name FROM fabric_admin.fdw_servers WHERE tenant_id = $1 ORDER BY 1', [tenant])).rows;
  const imported = async (schema: string) => (await pool.query(`SELECT foreign_table_name AS t, foreign_server_name AS s FROM information_schema.foreign_tables WHERE foreign_table_schema = $1 ORDER BY 1`, [schema])).rows;

  beforeAll(async () => {
    const root = new Client({ connectionString: adminUrl('postgres') }); await root.connect();
    await root.query(`CREATE DATABASE ${remoteDb}`); await root.end();
    const r = new Client({ connectionString: adminUrl(remoteDb) }); await r.connect();
    await r.query(`
      CREATE TABLE orders (id int primary key, total numeric);
      CREATE TABLE customers (id int, name text);
      CREATE TABLE settings (k text, v text);
      CREATE TABLE saved_analytics (id int, q text);
      CREATE TABLE query_logs (id int, q text);
      CREATE TABLE api_tokens (id int, token_hash text);
      CREATE TABLE fabric_worker_nodes (id int);
      CREATE TABLE fabric_worker_events (id int);
      CREATE TABLE users (id int, secret text);
      CREATE TABLE data_sources (id int);
      CREATE TABLE tenants (id int);
      CREATE TABLE pg_looking (id int);
      CREATE VIEW v_orders AS SELECT * FROM orders;`);
    await r.end();
    T1 = await createWorkspace(`${tag}a`);         // tenant id "a"
    T2 = await createWorkspace(`${tag}a_b`);       // tenant id "a_b"  (prefix overlap on purpose)
    TA = await createWorkspace(`${tag}x`);
    TL = await createWorkspace(`${tag}l`);
  });
  afterAll(async () => {
    for (const w of [T1, T2, TA, TL]) { try { await pool.query(`DELETE FROM public.data_sources WHERE tenant_id = $1`, [w.tenantId]); } catch { /* */ } }
    for (const row of (await pool.query(`SELECT tenant_id, source_name FROM fabric_admin.fdw_servers WHERE tenant_id = ANY($1)`, [[T1.tenantId, T2.tenantId, TA.tenantId, TL.tenantId]])).rows) {
      await pool.query('SELECT fabric_admin.remove_remote_source($1, $2)', [row.tenant_id, row.source_name]);
    }
    for (const w of [T1, T2, TA, TL]) await cleanupWorkspace(w.tenantId);
    await pool.query(`DROP FOREIGN TABLE IF EXISTS pg_temp.nothing`).catch(() => undefined);
    const root = new Client({ connectionString: adminUrl('postgres') }); await root.connect();
    await root.query(`DROP DATABASE IF EXISTS ${remoteDb} WITH (FORCE)`); await root.end();
  });

  it('server names are collision free and injective for the classic collision pair', async () => {
    const q = async (t: string, s: string) => (await pool.query('SELECT fabric_admin.fdw_server_name($1, $2) AS n, fabric_admin.fdw_legacy_server_name($1, $2) AS l', [t, s])).rows[0];
    const [x, y] = [await q('a', 'b_c'), await q('a_b', 'c')];
    expect(x.l).toBe(y.l);              // the legacy scheme really collided ...
    expect(x.n).not.toBe(y.n);          // ... the new one does not
    expect(x.n).toBe('server_a__b_c');
    const seen = new Set<string>();
    for (const [t, s] of [['a', 'b_c'], ['a_b', 'c'], ['a__b', 'c'], ['a', 'b__c'], ['a_', 'b'], ['a', '_b'.replace('_', 'x')], ['ab', 'c'], ['a', 'bc']]) {
      const n = (await q(t!, s!)).n; expect(n.length).toBeLessThanOrEqual(63); expect(seen.has(n)).toBe(false); seen.add(n);
    }
    const long = (await q('t'.repeat(40), 's'.repeat(40))).n;
    expect(long.length).toBeLessThanOrEqual(63);
    expect(long).not.toBe((await q('t'.repeat(40), 's'.repeat(41))).n);
  });

  it('two tenants whose legacy server names collide each keep their own server and tables', async () => {
    // tenants "<T1>" (source b_c) and "<T1>_b" is not constructible here, so use the real overlap pair created above:
    // T1.tenantId = hd_<tag>a_xxxx ; T2.tenantId = hd_<tag>a_b_xxxx -> choose sources that make the legacy names equal if the ids allowed it.
    await register(T1.tenantId, 'b_c');
    await register(T2.tenantId, 'c');
    const s1 = await serverNames(T1.tenantId); const s2 = await serverNames(T2.tenantId);
    expect(s1.length).toBe(1); expect(s2.length).toBe(1);
    expect(s1[0].server_name).not.toBe(s2[0].server_name);
    expect((await imported(`tenant_${T1.tenantId}`)).every((r) => r.s === s1[0].server_name)).toBe(true);
    expect((await imported(`tenant_${T2.tenantId}`)).every((r) => r.s === s2[0].server_name)).toBe(true);

    // removing one tenant's source must not drop the other tenant's tables
    await pool.query('SELECT fabric_admin.remove_remote_source($1, $2)', [T1.tenantId, 'b_c']);
    expect((await imported(`tenant_${T1.tenantId}`)).length).toBe(0);
    expect((await imported(`tenant_${T2.tenantId}`)).length).toBeGreaterThan(0);
    expect((await pool.query('SELECT 1 FROM pg_foreign_server WHERE srvname = $1', [s2[0].server_name])).rows.length).toBe(1);
  });

  it('a name already used by a different (tenant, source) is an error, never a silent overwrite', async () => {
    const taken = (await serverNames(T2.tenantId))[0].server_name;
    // forge a registry-less foreign server with exactly the name TA/source would get
    const forged = (await pool.query('SELECT fabric_admin.fdw_server_name($1, $2) AS n', [TA.tenantId, 'forged'])).rows[0].n;
    await pool.query(`CREATE SERVER "${forged}" FOREIGN DATA WRAPPER postgres_fdw OPTIONS (host 'x', dbname 'y')`);
    try {
      await expect(register(TA.tenantId, 'forged')).rejects.toThrow(/collides|already used/);
      await pool.query(`INSERT INTO fabric_admin.fdw_servers (server_name, tenant_id, source_name) VALUES ($1, 'someone_else', 'src') ON CONFLICT DO NOTHING`, [forged]);
      await expect(register(TA.tenantId, 'forged')).rejects.toThrow(/already used/);
    } finally {
      await pool.query(`DELETE FROM fabric_admin.fdw_servers WHERE tenant_id = 'someone_else'`);
      await pool.query(`DROP SERVER IF EXISTS "${forged}" CASCADE`);
    }
    expect((await pool.query('SELECT 1 FROM pg_foreign_server WHERE srvname = $1', [taken])).rows.length).toBe(1);
  });

  it('imports ONLY the remote\'s user tables: never settings, saved_analytics, query_logs, api_tokens, fabric_worker_*, users, ...', async () => {
    await register(TA.tenantId, 'wh');
    const names = (await imported(`tenant_${TA.tenantId}`)).map((r) => r.t);
    expect(names).toEqual(expect.arrayContaining(['orders', 'customers', 'v_orders']));
    for (const forbidden of ['settings', 'saved_analytics', 'query_logs', 'api_tokens', 'fabric_worker_nodes', 'fabric_worker_events', 'users', 'data_sources', 'tenants', 'pg_looking']) {
      expect(names).not.toContain(forbidden);
    }
  });

  it('the hub itself cannot be imported through the SQL function either (defence in depth)', async () => {
    await expect(pool.query('SELECT fabric_admin.register_remote_source($1, $2, $3, $4, $5, $6, $7, NULL)', [TA.tenantId, 'hubx', '127.0.0.1', 5432, (await pool.query('SELECT current_database() AS d')).rows[0].d, 'fabric_admin', 'x'])).rejects.toThrow(/hub/);
  });

  it('validates inputs inside the function', async () => {
    const call = (t: any, s: any, h: any = host, p: any = port, d: any = remoteDb) => pool.query('SELECT fabric_admin.register_remote_source($1,$2,$3,$4,$5,$6,$7,NULL)', [t, s, h, p, d, 'u', 'p']);
    await expect(call(TA.tenantId, 'a"b')).rejects.toThrow(/invalid source name/);
    await expect(call(`${TA.tenantId}"; DROP`, 'ok')).rejects.toThrow(/invalid tenant id/);
    await expect(call(TA.tenantId, 'ok', "h'; DROP SERVER x;--")).rejects.toThrow(/invalid host/);
    await expect(call(TA.tenantId, 'ok', host, 70000)).rejects.toThrow(/invalid port/);
    await expect(call('no_such_tenant_ns', 'ok')).rejects.toThrow(/does not exist/);
  });

  it('legacy servers keep working and are migrated on re-registration (single owner only)', async () => {
    const t = TL.tenantId;
    const legacy = (await pool.query('SELECT fabric_admin.fdw_legacy_server_name($1, $2) AS n', [t, 'legacy_src'])).rows[0].n;
    await pool.query(`INSERT INTO public.data_sources (tenant_id, name, type, config, sync_type, status) VALUES ($1, 'legacy_src', 'postgres', '{}', 'VIRTUAL', 'CONNECTED')`, [t]);
    await pool.query(`CREATE SERVER "${legacy}" FOREIGN DATA WRAPPER postgres_fdw OPTIONS (host '${host}', port '${port}', dbname '${remoteDb}')`);
    await pool.query(`CREATE USER MAPPING FOR current_user SERVER "${legacy}" OPTIONS (user 'fabric_admin', password 'fabric_password')`);
    await pool.query(`CREATE FOREIGN TABLE "tenant_${t}"."legacy_orders" (id int) SERVER "${legacy}" OPTIONS (schema_name 'public', table_name 'orders')`);
    // still works as before the migration
    expect((await pool.query(`SELECT count(*)::int AS n FROM "tenant_${t}"."legacy_orders"`)).rows[0].n).toBe(0);
    await register(t, 'legacy_src');
    expect((await pool.query('SELECT 1 FROM pg_foreign_server WHERE srvname = $1', [legacy])).rows.length).toBe(0);
    expect((await serverNames(t)).map((r) => r.source_name)).toEqual(expect.arrayContaining(['legacy_src']));
    await pool.query('SELECT fabric_admin.remove_remote_source($1, $2)', [t, 'legacy_src']);
    await pool.query(`DELETE FROM public.data_sources WHERE tenant_id = $1 AND name = 'legacy_src'`, [t]);
  });

  it('an ambiguous legacy server (two sources map to one legacy name) is left untouched', async () => {
    // tenants tf and tf_x with sources "x_s" and "s" would share server_tf_x_s; emulate with data_sources rows + a legacy server
    const t1 = T1.tenantId; // legacy('<t1>', 'zz_q') == legacy('<t1>_zz', 'q')
    const legacy = (await pool.query('SELECT fabric_admin.fdw_legacy_server_name($1, $2) AS n', [t1, 'zz_q'])).rows[0].n;
    const other = `${t1}_zz`;
    await pool.query(`INSERT INTO public.tenants (id, name) VALUES ($1, 'ambiguous') ON CONFLICT DO NOTHING`, [other]);
    await pool.query(`INSERT INTO public.data_sources (tenant_id, name, type, config, sync_type, status) VALUES ($1, 'zz_q', 'postgres', '{}', 'VIRTUAL', 'CONNECTED'), ($2, 'q', 'postgres', '{}', 'VIRTUAL', 'CONNECTED')`, [t1, other]);
    await pool.query(`CREATE SERVER "${legacy}" FOREIGN DATA WRAPPER postgres_fdw OPTIONS (host 'x', dbname 'y')`);
    try {
      await pool.query('SELECT fabric_admin.remove_remote_source($1, $2)', [t1, 'zz_q']);
      expect((await pool.query('SELECT 1 FROM pg_foreign_server WHERE srvname = $1', [legacy])).rows.length).toBe(1);
    } finally {
      await pool.query(`DROP SERVER IF EXISTS "${legacy}" CASCADE`);
      await pool.query(`DELETE FROM public.data_sources WHERE name IN ('zz_q', 'q') AND tenant_id IN ($1, $2)`, [t1, other]);
      await pool.query(`DELETE FROM public.tenants WHERE id = $1`, [other]);
    }
  });

  it('fabric_user cannot call the registration / removal functions or read the registry', async () => {
    const c = await pool.connect();
    try {
      await c.query('BEGIN'); await c.query('SET LOCAL ROLE fabric_user');
      await expect(c.query(`SELECT fabric_admin.register_remote_source('x','y','h',1,'d','u','p',NULL)`)).rejects.toThrow(/permission denied/);
      await c.query('ROLLBACK'); await c.query('BEGIN'); await c.query('SET LOCAL ROLE fabric_user');
      await expect(c.query(`SELECT fabric_admin.remove_remote_source('x','y')`)).rejects.toThrow(/permission denied/);
      await c.query('ROLLBACK'); await c.query('BEGIN'); await c.query('SET LOCAL ROLE fabric_user');
      await expect(c.query('SELECT * FROM fabric_admin.fdw_servers')).rejects.toThrow(/permission denied/);
    } finally { await c.query('ROLLBACK').catch(() => undefined); c.release(); }
  });
});
