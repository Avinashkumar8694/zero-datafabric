/**
 * AST async jobs (dispatch / poll / foreign poll) and NDJSON streaming, incl. workspace `query.allowStreaming=false` (T2).
 */
import '../tenancy/env';
import {
  app, request, bearer, pool, mkWorkspace, seedShop, SHOP, astQuery, purge, until, parseNdjson, textParser, canaryRows, adminFor, WS,
} from '../t2/kit';

jest.setTimeout(120000);

describe('AST: async jobs and streaming', () => {
  let a: WS; let b: WS;
  const cfg = (query: any, limit: number | null = 50, over: any = {}) => ({ type: 'SELECT', schema: SHOP, ...(limit === null ? {} : { limit }), query, ...over });
  const ordersQ = { from: { resource: 'orders' }, select: ['id', 'status'], orderBy: [{ column: 'id', direction: 'ASC' }] };

  beforeAll(async () => {
    a = await mkWorkspace('astjoba'); b = await mkWorkspace('astjobb');
    await seedShop(a); await seedShop(b);
  });
  afterAll(async () => { await purge(a.tenantId, b.tenantId); });

  const dispatch = (token: string, queryConfig: any, path = '/api/analytics/query-async') => request(app).post(path).set(bearer(token)).send({ queryConfig });
  const POLL_PATHS = (id: string) => [`/api/analytics/jobs/${id}`, `/api/analytics/query/status/${id}`, `/api/queries/jobs/${id}`, `/api/queries/status/${id}`];
  const poll = (token: string, id: string, path = `/api/analytics/jobs/${id}`) => request(app).get(path).set(bearer(token));
  const finished = (token: string, id: string) => until(async () => { const r = await poll(token, id); return ['COMPLETED', 'FAILED'].includes(r.body.status) ? r : null; });

  describe('async jobs', () => {
    it('dispatch returns 202 + jobId; polling reaches COMPLETED with the full result envelope', async () => {
      const d = await dispatch(a.member.token, cfg(ordersQ));
      expect(d.status).toBe(202);
      expect(d.body.status).toBe('PENDING');
      expect(d.body.jobId).toMatch(/^[0-9a-f-]{36}$/);
      const done = await finished(a.member.token, d.body.jobId);
      expect(done.body.status).toBe('COMPLETED');
      expect(done.body.result.data.map((r: any) => r.id)).toEqual([1, 2, 3, 4, 5, 6]);
      expect(done.body.result.rowCount).toBe(6);
      expect(done.body.result.plan.strategy).toBe('SINGLE_LOCAL');
      expect(done.body.tenantId).toBeUndefined(); // internal bookkeeping is never exposed
      expect(done.body.userId).toBeUndefined();
    });
    it('all four status endpoints answer for the owner of the job', async () => {
      const d = await dispatch(a.member.token, cfg(ordersQ, 2));
      await finished(a.member.token, d.body.jobId);
      for (const path of POLL_PATHS(d.body.jobId)) {
        const r = await poll(a.member.token, d.body.jobId, path);
        expect([path, r.status, r.body.status]).toEqual([path, 200, 'COMPLETED']);
      }
    });
    it('a job of tenant A polled by tenant B (member or owner) is 404 on every status endpoint', async () => {
      const d = await dispatch(a.member.token, cfg(ordersQ));
      await finished(a.member.token, d.body.jobId);
      for (const tok of [b.member.token, b.owner.token]) {
        for (const path of POLL_PATHS(d.body.jobId)) {
          const r = await poll(tok, d.body.jobId, path);
          expect([path, r.status]).toEqual([path, 404]);
          expect(JSON.stringify(r.body)).not.toMatch(/orders|COMPLETED|"result"/);
        }
      }
    });
    it('another user of the SAME workspace cannot poll the job either (404)', async () => {
      const d = await dispatch(a.member.token, cfg(ordersQ));
      expect((await poll(a.owner.token, d.body.jobId)).status).toBe(404);
      expect((await poll(a.member.token, d.body.jobId)).status).toBe(200);
    });
    it('a platform admin acting on the workspace is a different caller: 404 too (jobs are per user)', async () => {
      const d = await dispatch(a.member.token, cfg(ordersQ));
      expect((await poll(adminFor(a.tenantId), d.body.jobId)).status).toBe(404);
    });
    it('unknown, malformed and injected job ids are 404, unauthenticated is 401', async () => {
      for (const id of ['00000000-0000-0000-0000-000000000000', 'nope', "x'; DROP TABLE y;--", 'a'.repeat(300), '%00']) {
        expect((await poll(a.member.token, encodeURIComponent(id), `/api/analytics/jobs/${encodeURIComponent(id)}`)).status).toBe(404);
      }
      expect((await request(app).get('/api/analytics/jobs/abc')).status).toBe(401);
      expect((await request(app).post('/api/analytics/query-async').send({ queryConfig: cfg(ordersQ) })).status).toBe(401);
    });
    it('an invalid query becomes a FAILED job with a clear error (no crash, nothing executes)', async () => {
      const d = await dispatch(a.member.token, cfg({ from: { resource: 'ghost_table' } }));
      expect(d.status).toBe(202);
      const done = await finished(a.member.token, d.body.jobId);
      expect(done.body.status).toBe('FAILED');
      expect(done.body.error).toMatch(/ghost_table/);
    });
    it('injection payloads are validated inside the job too: FAILED, canary intact', async () => {
      const d = await dispatch(a.member.token, cfg({ from: { resource: 'orders; DROP TABLE canary' }, select: ['id'] }));
      const done = await finished(a.member.token, d.body.jobId);
      expect(done.body.status).toBe('FAILED');
      const e = await dispatch(a.member.token, cfg({ from: { resource: 'orders' }, where: [{ column: 'status', operator: 'EQ', value: "x'; DROP TABLE canary; --" }] }));
      const ok = await finished(a.member.token, e.body.jobId);
      expect(ok.body.status).toBe('COMPLETED'); expect(ok.body.result.data).toEqual([]);
      expect(await canaryRows(a)).toBe(1);
    });
    it('async dispatch refuses a missing queryConfig (400) and keeps SQL text out (400)', async () => {
      expect((await request(app).post('/api/analytics/query-async').set(bearer(a.member.token)).send({})).status).toBe(400);
      const r = await request(app).post('/api/analytics/query-async').set(bearer(a.member.token)).send({ queryConfig: { type: 'SELECT', rawSql: 'select 1' } });
      expect(r.status).toBe(400); expect(r.body.code).toBe('SQL_NOT_SUPPORTED');
    });
    it('the workspace row ceiling applies to async jobs', async () => {
      await request(app).put('/api/workspace/settings/query').set(bearer(a.owner.token)).send({ maxRows: 2 });
      try {
        const d = await dispatch(a.member.token, cfg(ordersQ, 100));
        const done = await finished(a.member.token, d.body.jobId);
        expect(done.body.result.data.length).toBe(2);
      } finally {
        await pool.query(`UPDATE public.tenants SET settings = settings #- '{query,maxRows}' WHERE id = $1`, [a.tenantId]);
        require('../../modules/tenancy/workspace-settings.service').WorkspaceSettingsService.clearCache(a.tenantId);
      }
    });
    it('many concurrent jobs are all tracked independently', async () => {
      const ids = await Promise.all(Array.from({ length: 8 }, (_, i) => dispatch(a.member.token, cfg(ordersQ, i + 1)).then((r) => r.body.jobId as string)));
      expect(new Set(ids).size).toBe(8);
      const results = await Promise.all(ids.map((id) => finished(a.member.token, id)));
      expect(results.map((r) => r.body.result.data.length)).toEqual([1, 2, 3, 4, 5, 6, 6, 6]);
    });
  });

  describe('streaming (NDJSON)', () => {
    const stream = (token: string, body: any, qs = '') =>
      request(app).post(`/api/analytics/query${qs}`).set(bearer(token)).buffer(true).parse(textParser).send(body);

    it('stream:true -> one JSON object per row, then a {__meta__} trailer', async () => {
      const r = await stream(a.member.token, { stream: true, queryConfig: cfg(ordersQ) });
      expect(r.status).toBe(200);
      expect(r.headers['content-type']).toMatch(/application\/x-ndjson/);
      expect(r.headers['x-fabric-stream']).toBeTruthy();
      const { rows, meta } = parseNdjson(r.body);
      expect(rows.map((x) => x.id)).toEqual([1, 2, 3, 4, 5, 6]);
      expect(meta).toMatchObject({ streamed: true, rowCount: 6 });
      expect(r.body.trim().split('\n').length).toBe(7);
    });
    it('queryConfig.stream and ?stream=true are honoured as well', async () => {
      const a1 = await stream(a.member.token, { queryConfig: { ...cfg(ordersQ), stream: true } });
      expect(a1.headers['content-type']).toMatch(/ndjson/);
      expect(parseNdjson(a1.body).rows.length).toBe(6);
      const a2 = await stream(a.member.token, { queryConfig: cfg(ordersQ) }, '?stream=true');
      expect(a2.headers['content-type']).toMatch(/ndjson/);
      expect(parseNdjson(a2.body).meta.rowCount).toBe(6);
    });
    it('no flag / stream:false -> a normal JSON envelope (Accept: application/x-ndjson alone does not switch modes)', async () => {
      const plain = await request(app).post('/api/analytics/query').set(bearer(a.member.token)).send({ queryConfig: cfg(ordersQ) });
      expect(plain.headers['content-type']).toMatch(/json/); expect(plain.body.rowCount).toBe(6);
      const off = await request(app).post('/api/analytics/query').set(bearer(a.member.token)).send({ stream: false, queryConfig: cfg(ordersQ) });
      expect(off.headers['content-type']).toMatch(/json/); expect(off.body.rowCount).toBe(6);
      const accept = await request(app).post('/api/analytics/query').set(bearer(a.member.token)).set('Accept', 'application/x-ndjson').send({ queryConfig: cfg(ordersQ) });
      expect(accept.headers['content-type']).toMatch(/json/); expect(accept.body.rowCount).toBe(6);
    });
    it('blocking shapes (aggregate, join, window) stream the computed result with the plan in the trailer', async () => {
      const agg = await stream(a.member.token, { stream: true, queryConfig: cfg({ from: { resource: 'orders' }, select: ['status', { aggregate: 'COUNT', alias: 'n' }], groupBy: ['status'], orderBy: [{ column: 'status', direction: 'ASC' }] }, null) });
      const p = parseNdjson(agg.body);
      expect(p.rows.map((x) => [x.status, Number(x.n)])).toEqual([['NEW', 2], ['PAID', 3], ['SHIPPED', 1]]);
      expect(p.meta.strategy).toBe('SINGLE_LOCAL');
      const win = await stream(a.member.token, { stream: true, queryConfig: cfg({ from: { resource: 'orders' }, select: ['id', { window: 'ROW_NUMBER', orderBy: [{ column: 'id', direction: 'ASC' }], alias: 'rn' }] }) });
      expect(parseNdjson(win.body).rows.map((x) => x.rn)).toEqual([1, 2, 3, 4, 5, 6]);
    });
    it('an empty result still ends with the trailer', async () => {
      const r = await stream(a.member.token, { stream: true, queryConfig: cfg({ from: { resource: 'orders' }, where: [{ column: 'id', operator: 'EQ', value: 12345 }] }) });
      const p = parseNdjson(r.body);
      expect(p.rows).toEqual([]); expect(p.meta.rowCount).toBe(0);
    });
    it('errors before the first byte are normal 4xx JSON responses, not a broken stream', async () => {
      const r = await request(app).post('/api/analytics/query').set(bearer(a.member.token)).send({ stream: true, queryConfig: cfg({ from: { resource: 'ghost_table' } }) });
      expect(r.status).toBe(404);
      const bad = await request(app).post('/api/analytics/query').set(bearer(a.member.token)).send({ stream: true, queryConfig: cfg({ from: { resource: 'orders; DROP TABLE canary' } }) });
      expect(bad.status).toBe(400);
      expect(await canaryRows(a)).toBe(1);
    });
    it('streaming respects the workspace row ceiling', async () => {
      await request(app).put('/api/workspace/settings/query').set(bearer(a.owner.token)).send({ maxRows: 3 });
      try {
        const r = await stream(a.member.token, { stream: true, queryConfig: cfg(ordersQ, 100) });
        expect(parseNdjson(r.body).rows.length).toBe(3);
      } finally {
        await pool.query(`UPDATE public.tenants SET settings = settings #- '{query,maxRows}' WHERE id = $1`, [a.tenantId]);
        require('../../modules/tenancy/workspace-settings.service').WorkspaceSettingsService.clearCache(a.tenantId);
      }
    });
    it('workspace query.allowStreaming=false turns stream:true into a regular JSON response', async () => {
      const put = await request(app).put('/api/workspace/settings/query').set(bearer(a.owner.token)).send({ allowStreaming: false });
      expect(put.status).toBe(200);
      try {
        for (const [body, qs] of [[{ stream: true, queryConfig: cfg(ordersQ) }, ''], [{ queryConfig: { ...cfg(ordersQ), stream: true } }, ''], [{ queryConfig: cfg(ordersQ) }, '?stream=true']] as const) {
          const r = await request(app).post(`/api/analytics/query${qs}`).set(bearer(a.member.token)).send(body);
          expect(r.status).toBe(200);
          expect(r.headers['content-type']).toMatch(/json/);
          expect(r.headers['x-fabric-stream']).toBeUndefined();
          expect(r.body.rowCount).toBe(6);
        }
        // another workspace is unaffected
        const other = await stream(b.member.token, { stream: true, queryConfig: cfg(ordersQ) });
        expect(other.headers['content-type']).toMatch(/ndjson/);
      } finally {
        await request(app).put('/api/workspace/settings/query').set(bearer(a.owner.token)).send({ allowStreaming: true });
      }
      const again = await stream(a.member.token, { stream: true, queryConfig: cfg(ordersQ) });
      expect(again.headers['content-type']).toMatch(/ndjson/);
    });
    it('only the workspace owner may change allowStreaming', async () => {
      const r = await request(app).put('/api/workspace/settings/query').set(bearer(a.member.token)).send({ allowStreaming: false });
      expect(r.status).toBe(403);
      const bad = await request(app).put('/api/workspace/settings/query').set(bearer(a.owner.token)).send({ allowStreaming: 'nope' });
      expect(bad.status).toBe(400);
    });
    it('streamed queries are written to the query log like buffered ones', async () => {
      await stream(a.member.token, { stream: true, queryConfig: cfg({ from: { resource: 'orders' }, select: ['id'], where: [{ column: 'id', operator: 'EQ', value: 3 }] }) });
      const hit = await until(async () => {
        const r = await request(app).get('/api/query-logs?mode=SELECT_AST&limit=50').set(bearer(a.member.token));
        return (r.body as any[]).find((l) => l.api === '/api/analytics/query' && l.status === 'SUCCESS' && l.rowCount === 1) || null;
      });
      expect(hit.username).toBe(a.member.username);
      const full = await request(app).get(`/api/query-logs/${hit.id}`).set(bearer(a.member.token));
      expect(full.status).toBe(200);
      expect(full.body.queryText).toContain('"value":3');
      expect((await request(app).get(`/api/query-logs/${hit.id}`).set(bearer(b.member.token))).status).toBe(404);
    });
    it('/api/queries/engine always answers with a JSON envelope, even if a stream flag is sent', async () => {
      const r = await request(app).post('/api/queries/engine').set(bearer(a.member.token)).send({ config: { ...cfg(ordersQ, 3), stream: true } });
      expect(r.status).toBe(200); expect(r.headers['content-type']).toMatch(/json/); expect(r.body.rowCount).toBe(3);
    });
  });
});
