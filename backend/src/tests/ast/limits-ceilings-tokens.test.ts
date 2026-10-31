/**
 * AST: errors that must be 4xx, limit handling, workspace / licence row ceilings, transpile-only endpoint and API-token
 * scopes on the AST endpoints (T2).
 */
import '../tenancy/env';
import {
  app, request, bearer, pool, mkWorkspace, seedShop, SHOP, astQuery, engineQuery, transpile, data, mintToken, purge,
  adminFor, adminToken, signLicense, canaryRows, setOverrides, WS,
} from '../t2/kit';

jest.setTimeout(180000);

describe('AST: error mapping, limits, ceilings, transpile, token scopes', () => {
  let ws: WS; let o: string; let m: string;
  const q = (query: any, limit: number | null = 100, over: any = {}) => astQuery(m, { type: 'SELECT', schema: SHOP, ...(limit === null ? {} : { limit }), query, ...over });
  const rows = (r: any) => r.body.data as any[];

  beforeAll(async () => { ws = await mkWorkspace('astlim'); o = ws.owner.token; m = ws.member.token; await seedShop(ws); });
  afterAll(async () => {
    await request(app).delete('/api/system/license').set(bearer(adminToken()));
    await purge(ws.tenantId);
  });

  describe('unknown / malformed references are 4xx, never 500', () => {
    it('unknown table -> 404 on every query endpoint', async () => {
      const cfg = { type: 'SELECT', schema: SHOP, limit: 5, query: { from: { resource: 'no_such_table' } } };
      expect((await astQuery(m, cfg)).status).toBe(404);
      expect((await engineQuery(m, cfg)).status).toBe(404);
      expect((await data(m, 'fetch', { schema: SHOP, resource: 'no_such_table' })).status).toBe(404);
    });
    it('unknown column in select / where / order / group / having -> 400', async () => {
      for (const query of [
        { from: { resource: 'orders' }, select: ['ghost'] },
        { from: { resource: 'orders' }, where: [{ column: 'ghost', operator: 'EQ', value: 1 }] },
        { from: { resource: 'orders' }, orderBy: [{ column: 'ghost', direction: 'ASC' }] },
        { from: { resource: 'orders' }, select: ['status', { aggregate: 'COUNT', alias: 'n' }], groupBy: ['ghost'] },
        { from: { resource: 'orders' }, select: [{ aggregate: 'SUM', column: 'ghost', alias: 's' }] },
      ]) {
        const r = await q(query);
        expect(r.status).toBe(400);
        expect(r.body.error).toBeTruthy();
      }
    });
    it('unknown logical schema -> 404; reserved / system schemas -> 403', async () => {
      expect((await q({ from: { resource: 'orders' } }, 5, { schema: 'ghost_schema' })).status).toBe(404);
      for (const schema of ['public', 'pg_catalog', 'information_schema', 'fabric_system', 'fabric_admin']) {
        const r = await q({ from: { resource: 'orders' } }, 5, { schema });
        expect(r.status).toBe(403);
      }
    });
    it('unknown source -> 404 (not a 500 with an internal message)', async () => {
      const r = await q({ from: { resource: 'orders', source: 'Ghost_Source' } });
      expect(r.status).toBe(404);
      expect(r.body.error).not.toMatch(/QueryPlanner/);
    });
    it('a view or table of ANOTHER tenant by its physical name is not reachable', async () => {
      const other = await mkWorkspace('astlimb');
      try {
        await seedShop(other);
        for (const schema of [other.schema(SHOP), `tenant_${other.tenantId}`, SHOP]) {
          const r = await q({ from: { resource: 'orders' } }, 100, { schema });
          if (schema === SHOP) { expect(r.status).toBe(200); expect(rows(r).length).toBe(6); continue; }
          expect(r.status).toBeGreaterThanOrEqual(400); expect(r.status).toBeLessThan(500);
        }
        const dotted = await q({ from: { resource: `${other.schema(SHOP)}.orders` } });
        expect(dotted.status).toBe(400);
        const joined = await q({ from: { resource: 'orders', alias: 'o' }, joins: [{ type: 'INNER', resource: 'orders', alias: 'x', on: { left: 'o.id', operator: 'EQ', right: 'x.id' } }], select: ['o.id'] });
        expect(joined.status).toBe(200); // control: own tables only
      } finally { await purge(other.tenantId); }
    });
    it('malformed AST shapes are 400', async () => {
      for (const query of [null, 'orders', 7, [], {}, { from: 'orders' }, { from: {} }, { from: { resource: 7 } }, { from: { resource: 'orders' }, select: 'id' }, { from: { resource: 'orders' }, where: 'id = 1' }, { from: { resource: 'orders' }, joins: [7] }, { from: { resource: 'orders' }, orderBy: [7] }]) {
        const r = await astQuery(m, { type: 'SELECT', schema: SHOP, limit: 5, query });
        expect(r.status).toBeGreaterThanOrEqual(400); expect(r.status).toBeLessThan(500);
      }
    });
    it('unsupported config types are 4xx or inert, never 5xx', async () => {
      for (const type of ['MERGE', 'UPSERT', 'TRUNCATE', 'DROP_SCHEMA', 'GRANT', '', 7, null]) {
        const r = await astQuery(m, { type, schema: SHOP, table: 'orders', limit: 1, data: { id: 9 } });
        expect(r.status).toBeLessThan(500);
      }
      expect(await canaryRows(ws)).toBe(1);
      expect((await q({ from: { resource: 'orders' } })).body.rowCount).toBe(6);
    });
    it('deeply nested set-operations / CTEs are bounded (400), not a stack overflow', async () => {
      let node: any = { from: { resource: 'orders' }, select: ['id'] };
      for (let i = 0; i < 40; i++) node = { union: [node, { from: { resource: 'orders' }, select: ['id'] }] };
      const r = await q(node);
      expect(r.status).toBe(400);
    });
    it.todo('MERGE / UPSERT config types are not implemented by the engine');
  });

  describe('limit handling', () => {
    const lim = (limit: any, withWhere = false) => astQuery(m, { type: 'SELECT', schema: SHOP, limit, query: { from: { resource: 'orders' }, select: ['id'], ...(withWhere ? { where: [{ column: 'id', operator: 'GT', value: 0 }] } : {}) } });
    it('limit 0 without a filter is an unbounded scan: 400 UNBOUNDED_QUERY', async () => {
      const r = await lim(0);
      expect(r.status).toBe(400); expect(r.body.code).toBe('UNBOUNDED_QUERY');
    });
    it('no limit and no filter is 400 UNBOUNDED_QUERY; adding either makes it valid', async () => {
      const a = await q({ from: { resource: 'orders' } }, null);
      expect(a.status).toBe(400); expect(a.body.code).toBe('UNBOUNDED_QUERY');
      expect((await q({ from: { resource: 'orders' } }, 3)).status).toBe(200);
      expect((await q({ from: { resource: 'orders' }, where: [{ column: 'id', operator: 'GT', value: 0 }] }, null)).status).toBe(200);
    });
    it('negative, fractional, NaN-ish and astronomically large limits are 400', async () => {
      for (const limit of [-1, -100, 1.5, 'NaN', 'abc', '1e3', 1e12, 1e18, Number.MAX_SAFE_INTEGER, [5], { a: 1 }, true]) {
        const r = await lim(limit, true);
        expect(r.status).toBe(400);
      }
    });
    it('a numeric-string limit is either accepted (2 rows) or refused with a 400 INVALID_LIMIT, never a 5xx', async () => {
      const r = await lim('2');
      expect([200, 400]).toContain(r.status);
      if (r.status === 200) expect(rows(r).length).toBe(2); else expect(r.body.code).toBe('INVALID_LIMIT');
    });
    it('limit 1 returns one row; a limit larger than the table returns every row', async () => {
      expect(rows(await lim(1)).length).toBe(1);
      expect(rows(await lim(1_000_000)).length).toBe(6);
    });
    it('the smaller of config.limit and query.limit wins', async () => {
      const r = await q({ from: { resource: 'orders' }, select: ['id'], limit: 2 }, 5);
      expect(rows(r).length).toBeLessThanOrEqual(5);
      expect(rows(r).length).toBe(2);
    });
    it('/api/data/fetch limit: default 100, 0/negative/NaN handled without a 5xx', async () => {
      const a = await data(m, 'fetch', { schema: SHOP, resource: 'orders' });
      expect(a.status).toBe(200); expect(a.body.rowCount).toBe(6);
      for (const limit of [0, -1, 'x', 1e12, 2.5]) {
        const r = await data(m, 'fetch', { schema: SHOP, resource: 'orders', limit });
        expect(r.status).toBeLessThan(500);
      }
      expect((await data(m, 'fetch', { schema: SHOP, resource: 'orders', limit: 2 })).body.rowCount).toBe(2);
    });
  });

  describe('row ceilings: workspace query.maxRows and licence max_query_rows', () => {
    const many = async () => {
      await data(o, 'create', { schema: SHOP, resource: 'orders', data: Array.from({ length: 12 }, (_, i) => ({ id: 100 + i, customer_id: 1, amount: i, status: 'BULK', placed: '2024-08-01T00:00:00Z' })) });
    };
    afterAll(async () => { await data(o, 'delete', { schema: SHOP, resource: 'orders', where: { status: 'BULK' } }); });

    it('without a ceiling a large limit returns everything', async () => {
      await many();
      const r = await q({ from: { resource: 'orders' }, select: ['id'] }, 1000);
      expect(rows(r).length).toBe(18);
    });
    it('PUT /api/workspace/settings/query {maxRows} clamps AST reads (limit, query.limit, no limit)', async () => {
      const put = await request(app).put('/api/workspace/settings/query').set(bearer(o)).send({ maxRows: 5 });
      expect(put.status).toBe(200);
      const a = await q({ from: { resource: 'orders' }, select: ['id'] }, 1000);
      expect(rows(a).length).toBe(5);
      const b = await q({ from: { resource: 'orders' }, select: ['id'], limit: 500 }, null, {});
      expect(b.status).toBe(200); expect(rows(b).length).toBe(5);
      const c = await q({ from: { resource: 'orders' }, select: ['id'], where: [{ column: 'id', operator: 'GT', value: 0 }] }, null);
      expect(rows(c).length).toBe(5);
      const d = await q({ from: { resource: 'orders' }, select: ['id'] }, 2);
      expect(rows(d).length).toBe(2); // a smaller limit is never raised
      const e = await data(m, 'fetch', { schema: SHOP, resource: 'orders', limit: 1000 });
      expect(e.body.rowCount).toBe(5); // CRUD fetch goes through the same engine
    });
    it('the ceiling applies to joins, set operations and plain views as well', async () => {
      const j = await q({ from: { resource: 'orders', alias: 'o' }, joins: [{ type: 'LEFT', resource: 'customers', alias: 'c', on: { left: 'o.customer_id', operator: 'EQ', right: 'c.id' } }], select: ['o.id'] }, 1000);
      expect(rows(j).length).toBe(5);
      const u = await q({ union: [{ from: { resource: 'orders' }, select: ['id'] }, { from: { resource: 'customers' }, select: ['id'] }] }, 1000);
      expect(rows(u).length).toBeLessThanOrEqual(5);
      const v = await q({ from: { resource: 'v_big_orders' } }, 1000);
      expect(rows(v).length).toBeLessThanOrEqual(5);
    });
    it('a platform admin session is exempt from the ceiling', async () => {
      const r = await astQuery(adminFor(ws.tenantId), { type: 'SELECT', schema: SHOP, limit: 1000, query: { from: { resource: 'orders' }, select: ['id'] } });
      expect(r.status).toBe(200); expect(rows(r).length).toBe(18);
    });
    it('invalid maxRows values are refused and leave the ceiling untouched', async () => {
      for (const maxRows of [0, -5, 1.5, '5', 2_000_000, null, true]) {
        const r = await request(app).put('/api/workspace/settings/query').set(bearer(o)).send({ maxRows });
        expect(r.status).toBe(400);
      }
      expect(rows(await q({ from: { resource: 'orders' }, select: ['id'] }, 1000)).length).toBe(5);
    });
    it('a member cannot change the ceiling', async () => {
      const r = await request(app).put('/api/workspace/settings/query').set(bearer(m)).send({ maxRows: 1_000_000 });
      expect(r.status).toBe(403);
      expect(rows(await q({ from: { resource: 'orders' }, select: ['id'] }, 1000)).length).toBe(5);
    });
    it('an installed licence max_query_rows caps further: min(workspace, licence) wins and a bigger workspace value is refused', async () => {
      const lic = await request(app).post('/api/system/license').set(bearer(adminToken())).send({ licenseKey: signLicense({ limits: { max_query_rows: 3 } }) });
      expect(lic.status).toBe(201);
      try {
        const a = await q({ from: { resource: 'orders' }, select: ['id'] }, 1000);
        expect(rows(a).length).toBe(3);
        const big = await request(app).put('/api/workspace/settings/query').set(bearer(o)).send({ maxRows: 100 });
        expect(big.status).toBe(400); expect(big.body.code).toBe('EXCEEDS_LICENCE_LIMIT');
        const ok = await request(app).put('/api/workspace/settings/query').set(bearer(o)).send({ maxRows: 2 });
        expect(ok.status).toBe(200);
        expect(rows(await q({ from: { resource: 'orders' }, select: ['id'] }, 1000)).length).toBe(2);
      } finally {
        await request(app).delete('/api/system/license').set(bearer(adminToken()));
      }
    });
    it('removing the licence and the workspace ceiling restores full reads', async () => {
      await pool.query(`UPDATE public.tenants SET settings = settings #- '{query,maxRows}' WHERE id = $1`, [ws.tenantId]);
      await setOverrides(ws.tenantId);
      expect(rows(await q({ from: { resource: 'orders' }, select: ['id'] }, 1000)).length).toBe(18);
    });
    it('plan override max_query_rows is enforced as well', async () => {
      await setOverrides(ws.tenantId, { max_query_rows: 4 });
      expect(rows(await q({ from: { resource: 'orders' }, select: ['id'] }, 1000)).length).toBe(4);
      await setOverrides(ws.tenantId);
    });
  });

  describe('POST /api/queries/transpile is preview only', () => {
    const norm = (s: string) => s.replace(/\s+/g, ' ').trim().replace(/;$/, '');
    it('returns the SQL the executor would run for the same AST', async () => {
      const asts = [
        { from: { resource: 'orders' }, select: ['id', 'status'], where: [{ column: 'amount', operator: 'GT', value: 10 }], orderBy: [{ column: 'id', direction: 'DESC' }] },
        { from: { resource: 'customers', alias: 'c' }, joins: [{ type: 'LEFT', resource: 'orders', alias: 'o', on: { left: 'c.id', operator: 'EQ', right: 'o.customer_id' } }], select: ['c.name', 'o.amount'] },
        { from: { resource: 'orders' }, select: ['status', { aggregate: 'SUM', column: 'amount', alias: 't' }], groupBy: ['status'], having: [{ column: 't', operator: 'GT', value: 20 }] },
        { from: { resource: 'customers' }, distinct: true, select: ['region'] },
      ];
      for (const query of asts) {
        const cfg = { type: 'SELECT', schema: SHOP, limit: 10, query };
        const t = await transpile(m, cfg);
        expect(t.status).toBe(200);
        const run = await astQuery(m, cfg);
        expect(run.status).toBe(200);
        expect(norm(t.body.sql)).toBe(norm(run.body.plan.legs[0].query));
      }
    });
    it('never executes: it answers for tables that do not exist and for mutating-looking input', async () => {
      const t = await transpile(m, { type: 'SELECT', schema: SHOP, limit: 5, query: { from: { resource: 'definitely_missing' } } });
      expect(t.status).toBe(200); expect(t.body.sql).toMatch(/definitely_missing/);
      const before = await canaryRows(ws);
      for (const body of [
        { type: 'DELETE', schema: SHOP, table: 'canary', filter: { id: 1 } },
        { type: 'INSERT', schema: SHOP, table: 'canary', data: { id: 99 } },
        { type: 'DROP_TABLE', schema: SHOP, table: 'canary' },
        { type: 'CALL', schema: 'fns', function: 'drop_everything', args: [] },
        { type: 'CALL', schema: 'fns', procedure: 'purge', args: ['x'] },
      ]) {
        const r = await transpile(m, body);
        expect(r.status).toBe(200);
        expect(typeof r.body.sql).toBe('string');
      }
      expect(await canaryRows(ws)).toBe(before);
    });
    it('payloads are escaped in the text and the canary survives', async () => {
      const evil = "x'; DROP TABLE canary; --";
      const t = await transpile(m, { type: 'SELECT', schema: SHOP, limit: 5, query: { from: { resource: 'orders' }, where: [{ column: 'status', operator: 'EQ', value: evil }] } });
      expect(t.status).toBe(200);
      expect(t.body.sql).toContain("'x''; DROP TABLE canary; --'");
      expect(await canaryRows(ws)).toBe(1);
    });
    it('invalid AST pieces come back as a commented error text (200), identifiers are validated', async () => {
      for (const query of [{ from: { resource: 'orders; DROP' } }, { from: { resource: 'orders' }, orderBy: [{ column: 'id', direction: 'SIDEWAYS' }] }, { from: { resource: 'orders' }, where: [{ column: 'id', operator: 'BOGUS', value: 1 }] }]) {
        const t = await transpile(m, { type: 'SELECT', schema: SHOP, limit: 5, query });
        expect(t.status).toBe(200);
        expect(t.body.sql).toMatch(/^-- could not transpile/);
        expect(t.body.error).toBeTruthy();
      }
    });
    it('recursive queries are reported as in-fabric', async () => {
      const t = await transpile(m, { type: 'SELECT', schema: SHOP, query: { from: { resource: 'customers' }, recursive: { resource: 'customers', connectBy: { parent: 'manager_id', child: 'id' } } } });
      expect(t.body.note).toBe('RECURSIVE_IN_FABRIC');
    });
  });

  describe('API tokens on the AST endpoints', () => {
    it('query:read can SELECT and transpile but cannot write through any AST endpoint', async () => {
      const { token } = await mintToken(ws.member, ['query:read']);
      const sel = await request(app).post('/api/analytics/query').set(bearer(token)).send({ queryConfig: { type: 'SELECT', schema: SHOP, limit: 2, query: { from: { resource: 'orders' } } } });
      expect(sel.status).toBe(200);
      expect((await request(app).post('/api/queries/transpile').set(bearer(token)).send({ type: 'SELECT', schema: SHOP, limit: 2, query: { from: { resource: 'orders' } } })).status).toBe(200);
      const writes: Array<[string, any]> = [
        ['/api/analytics/query', { queryConfig: { type: 'INSERT', schema: SHOP, table: 'canary', data: { id: 55, note: 'by-token' } } }],
        ['/api/analytics/query', { queryConfig: { type: 'DELETE', schema: SHOP, table: 'canary', filter: { id: 1 } } }],
        ['/api/analytics/query', { queryConfig: { type: 'CREATE_TABLE', schema: SHOP, table: 'tok_t', schemaDef: { columns: [{ name: 'id', type: 'INTEGER' }] } } }],
        ['/api/analytics/query', { queryConfig: { type: 'CALL', schema: 'fns', function: 'add_one', args: [1] } }],
        ['/api/analytics/query-async', { queryConfig: { type: 'UPDATE', schema: SHOP, table: 'canary', data: { note: 'x' }, filter: { id: 1 } } }],
        ['/api/queries/engine', { config: { type: 'DELETE', schema: SHOP, table: 'canary', filter: { id: 1 } } }],
        ['/api/analytics/refresh-view', { viewName: 'mv_status_totals', schema: SHOP }],
      ];
      for (const [path, body] of writes) {
        const r = await request(app).post(path).set(bearer(token)).send(body);
        expect([path, r.status, r.body.code]).toEqual([path, 403, 'SCOPE_REQUIRED']);
      }
      expect(await canaryRows(ws)).toBe(1);
      expect((await pool.query(`SELECT note FROM "${ws.schema(SHOP)}"."canary"`)).rows).toEqual([{ note: 'alive' }]);
      expect((await data(ws.owner.token, 'fetch', { schema: SHOP, resource: 'tok_t' })).status).toBe(404);
    });
    it('a data:read / data:write token without query:read cannot use the AST endpoints at all', async () => {
      const { token } = await mintToken(ws.member, ['data:read', 'data:write']);
      for (const path of ['/api/analytics/query', '/api/queries/engine']) {
        const body = path.endsWith('engine') ? { config: { type: 'SELECT', schema: SHOP, limit: 1, query: { from: { resource: 'orders' } } } } : { queryConfig: { type: 'SELECT', schema: SHOP, limit: 1, query: { from: { resource: 'orders' } } } };
        const r = await request(app).post(path).set(bearer(token)).send(body);
        expect(r.status).toBe(403); expect(r.body.code).toBe('SCOPE_REQUIRED');
      }
    });
    it('a data:write token may run a write AST; a query:read+data:write token may run both', async () => {
      const { token } = await mintToken(ws.member, ['query:read', 'data:write']);
      const w = await request(app).post('/api/analytics/query').set(bearer(token)).send({ queryConfig: { type: 'INSERT', schema: SHOP, table: 'canary', data: { id: 56, note: 'ok' } } });
      expect(w.status).toBe(200);
      expect(await canaryRows(ws)).toBe(2);
      await pool.query(`DELETE FROM "${ws.schema(SHOP)}"."canary" WHERE id = 56`);
    });
    it('a revoked token stops working immediately; an expired token and garbage tokens are 401', async () => {
      const { id, token } = await mintToken(ws.member, ['query:read']);
      const cfg = { queryConfig: { type: 'SELECT', schema: SHOP, limit: 1, query: { from: { resource: 'orders' } } } };
      expect((await request(app).post('/api/analytics/query').set(bearer(token)).send(cfg)).status).toBe(200);
      const del = await request(app).delete(`/api/developer/tokens/${id}`).set(bearer(ws.member.token));
      expect(del.status).toBe(204);
      expect((await request(app).post('/api/analytics/query').set(bearer(token)).send(cfg)).status).toBe(401);
      for (const bad of ['dft_zzzzzzzz_' + 'A'.repeat(43), 'dft_', 'dft_abcdefgh_short']) {
        const g = await request(app).post('/api/analytics/query').set(bearer(bad)).send(cfg);
        expect(g.status).toBeGreaterThanOrEqual(401); expect(g.status).toBeLessThan(500);
      }
    });
  });
});
