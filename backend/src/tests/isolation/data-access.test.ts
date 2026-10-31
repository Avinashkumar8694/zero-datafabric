/**
 * T1 / T2 / T3 / T4 — a member or owner of tenant B can never read, write, count or poll tenant A's objects.
 * USER-role tokens only. Foreign ids are 404 (never 403, which would confirm existence).
 */
import { app, pool, request, mkTenant, mkTable, mkCatalogTable, mkSource, auth, suffix, cleanupAll, TestTenant } from './harness';

jest.setTimeout(60000);

describe('Isolation: data access, catalog ids, jobs, tenant header, token exchange', () => {
  const s = suffix();
  let A: TestTenant; let B: TestTenant;
  let aCat: { schemaId: string; tableId: string };
  let aSrc: { sourceId: string; schemaId: string; tableId: string };

  beforeAll(async () => {
    A = await mkTenant(`isoda_${s}`);
    B = await mkTenant(`isodb_${s}`);
    await mkTable(A, 'secrets', [{ v: 'A-secret-1' }, { v: 'A-secret-2' }]);
    await mkTable(B, 'mine', [{ v: 'B-row' }]);
    aCat = await mkCatalogTable(A.schema, 'secrets');
    aSrc = await mkSource(A, 'a_remote', { host: 'a.invalid', port: 5432, user: 'u', password: 'A-PASSWORD' });
  });
  afterAll(async () => { await cleanupAll(); });

  describe('T1: CRUD / AST cannot reach another tenant', () => {
    it('A reads its own table (control)', async () => {
      const r = await request(app).post('/api/data/fetch').set(auth(A.owner.token)).send({ resource: 'secrets', limit: 10 });
      expect(r.status).toBe(200);
      expect(JSON.stringify(r.body)).toContain('A-secret-1');
    });

    it('B cannot read A\'s table through fetch, whatever schema spelling it uses', async () => {
      for (const schema of [undefined, A.schema, `tenant_${A.id}_x`, 'public', 'pg_catalog', 'fabric_system', 'information_schema']) {
        const r = await request(app).post('/api/data/fetch').set(auth(B.owner.token)).send({ resource: 'secrets', ...(schema ? { schema } : {}), limit: 10 });
        expect(JSON.stringify(r.body)).not.toContain('A-secret');
        expect(r.status).toBeGreaterThanOrEqual(400);
      }
    });

    it('B cannot write or count A\'s table (create/update/delete)', async () => {
      for (const [path, body] of [
        ['/api/data/create', { resource: 'secrets', data: { v: 'pwned' } }],
        ['/api/data/update', { resource: 'secrets', where: { id: 1 }, data: { v: 'pwned' } }],
        ['/api/data/delete', { resource: 'secrets', where: { id: 1 } }],
        ['/api/data/create', { resource: 'secrets', schema: A.schema, data: { v: 'pwned' } }],
      ] as const) {
        const r = await request(app).post(path).set(auth(B.member.token)).send(body);
        expect(r.status).toBeGreaterThanOrEqual(400);
      }
      const { rows } = await pool.query(`SELECT v FROM "${A.schema}"."secrets" ORDER BY id`);
      expect(rows.map((x) => x.v)).toEqual(['A-secret-1', 'A-secret-2']);
    });

    it('B cannot read A through the AST endpoints (analytics/query and queries/engine), incl. UNION / joins / aliases', async () => {
      const asts: any[] = [
        { type: 'SELECT', schema: A.schema, limit: 5, query: { from: { resource: 'secrets' } } },
        { type: 'SELECT', limit: 5, query: { from: { resource: 'secrets' } } },
        { type: 'SELECT', limit: 5, query: { from: { resource: 'mine' }, union: [{ from: { resource: 'secrets' } }] } },
        { type: 'SELECT', limit: 5, query: { from: { resource: 'mine' }, joins: [{ type: 'INNER', resource: 'secrets', on: { left: 'mine.id', operator: 'EQ', right: 'secrets.id' } }] } },
        { type: 'SELECT', limit: 5, query: { select: [{ expression: `(SELECT v FROM "${A.schema}"."secrets" LIMIT 1)`, alias: 'x' }], from: { resource: 'mine' } } },
        { type: 'SELECT', limit: 5, query: { from: { resource: `${A.schema}"."secrets` } } },
      ];
      for (const cfg of asts) {
        const r1 = await request(app).post('/api/queries/engine').set(auth(B.owner.token)).send({ config: cfg });
        const r2 = await request(app).post('/api/analytics/query').set(auth(B.owner.token)).send({ queryConfig: cfg });
        for (const r of [r1, r2]) expect(JSON.stringify(r.body)).not.toContain('A-secret');
      }
    });

    it('B\'s own data is still reachable (positive control)', async () => {
      const r = await request(app).post('/api/data/fetch').set(auth(B.member.token)).send({ resource: 'mine', limit: 10 });
      expect(r.status).toBe(200);
      expect(JSON.stringify(r.body)).toContain('B-row');
    });

    it('saved analytics and query logs are per tenant', async () => {
      const mk = await request(app).post('/api/saved-analytics').set(auth(A.owner.token))
        .send({ name: `a_${s}`, mode: 'AST', config: { type: 'SELECT', limit: 1, query: { from: { resource: 'secrets' } } } });
      expect(mk.status).toBeLessThan(300);
      const id = mk.body.id;
      const listB = await request(app).get('/api/saved-analytics').set(auth(B.owner.token));
      expect(JSON.stringify(listB.body)).not.toContain(`a_${s}`);
      expect((await request(app).get(`/api/saved-analytics/${id}`).set(auth(B.owner.token))).status).toBe(404);
      expect((await request(app).delete(`/api/saved-analytics/${id}`).set(auth(B.owner.token))).status).toBeGreaterThanOrEqual(400);
      expect((await request(app).get(`/api/saved-analytics/${id}`).set(auth(A.owner.token))).status).toBe(200);

      await request(app).post('/api/data/fetch').set(auth(A.owner.token)).send({ resource: 'secrets', limit: 1 });
      const logsA = await request(app).get('/api/query-logs').set(auth(A.owner.token));
      expect(logsA.status).toBe(200);
      expect(logsA.body.length).toBeGreaterThan(0);
      const logsB = await request(app).get('/api/query-logs').set(auth(B.owner.token));
      // B only ever sees log rows written by B's own users (their error texts may mention A's id, which is just B's own input).
      expect(logsB.body.every((l: any) => [B.owner.username, B.member.username].includes(l.username))).toBe(true);
      expect(logsB.body.some((l: any) => [A.owner.username, A.member.username].includes(l.username))).toBe(false);
      const aLogId = logsA.body[0].id;
      expect((await request(app).get(`/api/query-logs/${aLogId}`).set(auth(B.owner.token))).status).toBe(404);
    });

    it('triggers, replication jobs and policy/grant/constraint lists are per tenant', async () => {
      await pool.query(
        `INSERT INTO public.trigger_registry (tenant_id, schema_name, table_name, trigger_name, definition) VALUES ($1, $2, 'secrets', 'trg_a', '{}'::jsonb)`, [A.id, A.schema]);
      await request(app).get('/api/replication').set(auth(A.owner.token)); // ensures fabric_system.replication_jobs exists
      await pool.query(`INSERT INTO fabric_system.replication_jobs (tenant_id, name, source_name, dest_name) VALUES ($1, 'job_a', 's', 'd')`, [A.id]);
      await pool.query(`INSERT INTO fabric_system.access_policies (tenant_id, name, schema_name, table_name, roles, row_filter, masking) VALUES ($1, 'pol_a', $2, 'secrets', '[]'::jsonb, '[]'::jsonb, '[]'::jsonb)`, [A.id, A.schema]).catch(() => undefined);
      const trigA = await request(app).get('/api/triggers').set(auth(A.owner.token));
      expect(JSON.stringify(trigA.body)).toContain('trg_a');
      for (const path of ['/api/triggers', '/api/replication', '/api/policies', '/api/grants', '/api/constraints', '/api/triggers/logs/list', '/api/triggers/jobs/list']) {
        const r = await request(app).get(path).set(auth(B.owner.token));
        expect(r.status).toBe(200);
        const body = JSON.stringify(r.body);
        expect(body).not.toContain('trg_a');
        expect(body).not.toContain('job_a');
        expect(body).not.toContain('pol_a');
      }
    });
  });

  describe('T2: foreign tableId / schemaId / sourceId / job id are 404', () => {
    it('catalog GETs: control for the owner, 404 for the other tenant', async () => {
      const own = await request(app).get('/api/metadata/resource/' + aCat.tableId).set(auth(A.owner.token));
      expect(own.status).toBe(200);
      const prev = await request(app).get('/api/metadata/preview').query({ tableId: aCat.tableId }).set(auth(A.owner.token));
      expect(prev.status).toBe(200);
      expect(JSON.stringify(prev.body)).toContain('A-secret-1');
      const tables = await request(app).get('/api/metadata/tables').query({ schemaId: aCat.schemaId }).set(auth(A.owner.token));
      expect(tables.status).toBe(200);
      expect(tables.body.length).toBe(1);
      const schemas = await request(app).get('/api/metadata/schemas').query({ sourceId: aSrc.sourceId }).set(auth(A.owner.token));
      expect(schemas.status).toBe(200);

      const probes: [string, string, Record<string, string>?][] = [
        ['get', `/api/metadata/resource/${aCat.tableId}`], ['get', `/api/metadata/resource/${aSrc.tableId}`],
        ['get', '/api/metadata/columns', { tableId: aCat.tableId }], ['get', '/api/metadata/columns', { tableId: aSrc.tableId }],
        ['get', '/api/metadata/preview', { tableId: aCat.tableId }], ['get', '/api/metadata/preview', { tableId: aSrc.tableId }],
        ['get', '/api/metadata/tables', { schemaId: aCat.schemaId }], ['get', '/api/metadata/tables', { schemaId: aSrc.schemaId }],
        ['get', '/api/metadata/schemas', { sourceId: aSrc.sourceId }],
      ];
      for (const [, path, q] of probes) {
        for (const tok of [B.owner.token, B.member.token]) {
          const r = await request(app).get(path).query(q || {}).set(auth(tok));
          expect(r.status).toBe(404);
          expect(JSON.stringify(r.body)).not.toContain('A-secret');
        }
      }
      // unknown id behaves identically (no existence oracle)
      const unknown = await request(app).get('/api/metadata/resource/00000000-0000-4000-8000-000000000000').set(auth(B.owner.token));
      expect(unknown.status).toBe(404);
    });

    it('engine / data endpoints: a foreign tableId or schemaId is 404', async () => {
      for (const cfg of [
        { type: 'SELECT', tableId: aCat.tableId, limit: 5 },
        { type: 'SELECT', tableId: aSrc.tableId, limit: 5 },
        { type: 'SELECT', schemaId: aCat.schemaId, table: 'secrets', limit: 5 },
        { type: 'UPDATE', tableId: aCat.tableId, data: { v: 'x' }, filter: { id: 1 } },
        { type: 'DELETE', tableId: aCat.tableId, filter: { id: 1 } },
      ]) {
        const r = await request(app).post('/api/queries/engine').set(auth(B.owner.token)).send({ config: cfg });
        expect(r.status).toBe(404);
      }
      const own = await request(app).post('/api/queries/engine').set(auth(A.owner.token)).send({ config: { type: 'SELECT', tableId: aCat.tableId, limit: 5 } });
      expect(own.status).toBe(200);
      const { rows } = await pool.query(`SELECT count(*)::int AS n FROM "${A.schema}"."secrets"`);
      expect(rows[0].n).toBe(2);
    });

    it('connection mutation by id: foreign source is 404 and untouched', async () => {
      const patch = await request(app).patch('/api/admin/connections').set(auth(B.owner.token)).send({ sourceId: aSrc.sourceId, status: 'DISCONNECTED' });
      expect(patch.status).toBe(404);
      const del = await request(app).delete(`/api/admin/connections/${aSrc.sourceId}`).set(auth(B.owner.token));
      expect(del.status).toBe(404);
      const { rows } = await pool.query('SELECT status FROM public.data_sources WHERE id = $1', [aSrc.sourceId]);
      expect(rows[0].status).toBe('CONNECTED');
    });

    it('metadata history / rollback: foreign version id is 404', async () => {
      const { rows } = await pool.query(
        `INSERT INTO fabric_system.metadata_history (tenant_id, version_tag, ast_content, summary) VALUES ($1, 'v1', '{}'::jsonb, '{}'::jsonb) RETURNING id`, [A.id]);
      const r = await request(app).post(`/api/metadata/rollback/${rows[0].id}`).set(auth(B.owner.token));
      expect(r.status).toBe(404);
      const hist = await request(app).get('/api/metadata/history').set(auth(B.owner.token));
      expect(JSON.stringify(hist.body)).not.toContain(rows[0].id);
    });

    it('async job ids are bound to tenant + user (404 for everyone else, incl. a colleague)', async () => {
      const start = await request(app).post('/api/analytics/query-async').set(auth(A.owner.token))
        .send({ queryConfig: { type: 'SELECT', table: 'secrets', limit: 5 } });
      expect(start.status).toBe(202);
      const jobId = start.body.jobId;
      let status = 'PENDING';
      for (let i = 0; i < 20 && status !== 'COMPLETED'; i++) {
        const st = await request(app).get(`/api/analytics/jobs/${jobId}`).set(auth(A.owner.token));
        expect(st.status).toBe(200);
        status = st.body.status;
        if (status !== 'COMPLETED') await new Promise((r) => setTimeout(r, 200));
      }
      expect(status).toBe('COMPLETED');
      for (const path of [`/api/analytics/jobs/${jobId}`, `/api/analytics/query/status/${jobId}`, `/api/queries/jobs/${jobId}`, `/api/queries/status/${jobId}`]) {
        for (const tok of [B.owner.token, A.member.token]) {
          const r = await request(app).get(path).set(auth(tok));
          expect(r.status).toBe(404);
          expect(JSON.stringify(r.body)).not.toContain('A-secret');
        }
      }
    });
  });

  describe('T3: x-tenant-id is ignored for non-admins', () => {
    it('a USER cannot switch workspace with the header', async () => {
      const r = await request(app).get('/api/admin/connections').set(auth(B.owner.token)).set('x-tenant-id', A.id);
      expect(r.status).toBe(200);
      expect(JSON.stringify(r.body)).not.toContain('a_remote');
      const f = await request(app).post('/api/data/fetch').set(auth(B.owner.token)).set('x-tenant-id', A.id).send({ resource: 'secrets', limit: 5 });
      expect(JSON.stringify(f.body)).not.toContain('A-secret');
      const src = await request(app).get('/api/metadata/sources').set(auth(B.owner.token)).set('x-tenant-id', A.id);
      expect(JSON.stringify(src.body)).not.toContain('a_remote');
    });

    it('a request-supplied tenantId in the body is ignored for non-admins (analytics/query + refresh)', async () => {
      const r = await request(app).post('/api/analytics/query').set(auth(B.owner.token))
        .send({ tenantId: A.id, queryConfig: { type: 'SELECT', table: 'secrets', limit: 5 } });
      expect(JSON.stringify(r.body)).not.toContain('A-secret');
      const asyncR = await request(app).post('/api/analytics/query-async').set(auth(B.owner.token))
        .send({ tenantId: A.id, queryConfig: { type: 'SELECT', table: 'secrets', limit: 5 } });
      expect(asyncR.status).toBe(202);
      await new Promise((r) => setTimeout(r, 600));
      const st = await request(app).get(`/api/analytics/jobs/${asyncR.body.jobId}`).set(auth(B.owner.token));
      expect(JSON.stringify(st.body)).not.toContain('A-secret');
    });
  });

  describe('T4: token exchange only for owned tenants', () => {
    it('owner can exchange for their own tenant, not for another', async () => {
      const ok = await request(app).post('/api/auth/token').set(auth(A.owner.token)).send({ tenantId: A.id });
      expect(ok.status).toBe(200);
      expect(ok.body.token).toBeTruthy();
      const bad = await request(app).post('/api/auth/token').set(auth(A.owner.token)).send({ tenantId: B.id });
      expect(bad.status).toBe(403);
      const memberBad = await request(app).post('/api/auth/token').set(auth(B.member.token)).send({ tenantId: B.id });
      expect(memberBad.status).toBe(403); // a mere member is not the owner of the tenant
    });
  });
});
