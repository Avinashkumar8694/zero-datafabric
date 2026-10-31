/**
 * AST SELECT shapes and WHERE operators against hub tables created by a manifest (T2).
 * Covers: column lists / `*` / aliases, every filter operator the engine supports, NULL semantics, type coercion,
 * views and materialized views, DISTINCT, and the operator shapes the AST does NOT support (recorded as todo).
 */
import '../tenancy/env';
import { app, request, mkWorkspace, seedShop, SHOP, astQuery, engineQuery, data, purge, sleep, WS } from '../t2/kit';

jest.setTimeout(120000);

describe('AST: SELECT, projection and filters (hub tables from a manifest)', () => {
  let ws: WS; let m: string;
  const q = (query: any, limit: number | null = 100) => astQuery(m, { type: 'SELECT', schema: SHOP, ...(limit === null ? {} : { limit }), query });
  const rows = (r: any) => r.body.data as any[];
  const ids = (r: any) => rows(r).map((x) => x.id).sort((a, b) => a - b);

  beforeAll(async () => { ws = await mkWorkspace('astsel'); m = ws.member.token; await seedShop(ws); });
  afterAll(async () => { await purge(ws.tenantId); });

  describe('projection', () => {
    it('no select -> all columns', async () => {
      const r = await q({ from: { resource: 'customers' }, where: [{ column: 'id', operator: 'EQ', value: 1 }] });
      expect(r.status).toBe(200);
      expect(Object.keys(rows(r)[0])).toEqual(expect.arrayContaining(['id', 'name', 'region', 'manager_id', 'active', 'joined', 'score', 'tags', 'meta']));
    });
    it('select ["*"] and select [] behave like all columns', async () => {
      for (const select of [['*'], []]) {
        const r = await q({ from: { resource: 'customers' }, select, where: [{ column: 'id', operator: 'EQ', value: 1 }] });
        expect(r.status).toBe(200);
        expect(Object.keys(rows(r)[0]).length).toBeGreaterThanOrEqual(9);
      }
    });
    it('explicit column list keeps order and only those columns', async () => {
      const r = await q({ from: { resource: 'customers' }, select: ['name', 'id'], orderBy: [{ column: 'id', direction: 'ASC' }] });
      expect(r.status).toBe(200);
      expect(Object.keys(rows(r)[0])).toEqual(['name', 'id']);
      expect(rows(r).map((x) => x.name)).toEqual(['Ann', 'Bob', 'Cy', 'Dee', 'Eve']);
    });
    it('column alias via {column, alias}', async () => {
      const r = await q({ from: { resource: 'customers' }, select: [{ column: 'name', alias: 'who' }, 'id'], where: [{ column: 'id', operator: 'EQ', value: 2 }] });
      expect(r.status).toBe(200);
      expect(rows(r)).toEqual([{ who: 'Bob', id: 2 }]);
    });
    it('table alias qualifies columns', async () => {
      const r = await q({ from: { resource: 'customers', alias: 'c' }, select: ['c.id', 'c.name'], where: [{ column: 'c.id', operator: 'EQ', value: 3 }] });
      expect(r.status).toBe(200);
      expect(rows(r)).toEqual([{ id: 3, name: 'Cy' }]);
    });
    it('safe scalar expression with alias (allow-listed functions only)', async () => {
      const r = await q({ from: { resource: 'customers' }, select: [{ expression: 'upper(name)', alias: 'shout' }], where: [{ column: 'id', operator: 'EQ', value: 1 }] });
      expect(r.status).toBe(200);
      expect(rows(r)).toEqual([{ shout: 'ANN' }]);
    });
    it('DISTINCT removes duplicate rows', async () => {
      const r = await q({ from: { resource: 'customers' }, distinct: true, select: ['region'], orderBy: [{ column: 'region', direction: 'ASC' }] });
      expect(r.status).toBe(200);
      expect(rows(r).map((x) => x.region)).toEqual(['APAC', 'EU', 'US', null]);
    });
    it('query-level limit is honoured (not just the top-level limit)', async () => {
      const r = await q({ from: { resource: 'orders' }, limit: 2, orderBy: [{ column: 'id', direction: 'ASC' }] }, null);
      expect(r.status).toBe(200);
      expect(ids(r)).toEqual([1, 2]);
    });
  });

  describe('filter operators', () => {
    const where = (column: string, operator: string, value?: any) => ({ from: { resource: 'customers' }, where: [{ column, operator, ...(value === undefined ? {} : { value }) }] });
    it.each([
      ['EQ', 'id', 3, [3]],
      ['NE', 'id', 3, [1, 2, 4, 5]],
      ['GT', 'id', 3, [4, 5]],
      ['GTE', 'id', 3, [3, 4, 5]],
      ['LT', 'id', 3, [1, 2]],
      ['LTE', 'id', 3, [1, 2, 3]],
      ['IN', 'id', [1, 5], [1, 5]],
      ['NIN', 'id', [1, 5], [2, 3, 4]],
      ['NOT_IN', 'id', [1, 5], [2, 3, 4]],
      ['LIKE', 'name', 'A%', [1]],
      ['LIKE', 'name', '%e', [4, 5]],
      ['ILIKE', 'name', 'a%', [1]],
      ['LIKE', 'name', 'a%', []], // LIKE is case sensitive
      ['IS_NULL', 'region', undefined, [4]],
      ['IS_NOT_NULL', 'region', undefined, [1, 2, 3, 5]],
      ['=', 'id', 2, [2]],
      ['!=', 'id', 2, [1, 3, 4, 5]],
      ['<>', 'id', 2, [1, 3, 4, 5]],
      ['>', 'id', 4, [5]],
      ['<=', 'id', 1, [1]],
    ])('%s %s %j', async (op, column, value, expected) => {
      const r = await q(where(column as string, op as string, value));
      expect(r.status).toBe(200);
      expect(ids(r)).toEqual(expected);
    });
    it('operator names are case-insensitive', async () => {
      const r = await q(where('id', 'gte', 4));
      expect(r.status).toBe(200); expect(ids(r)).toEqual([4, 5]);
    });
    it('missing operator defaults to equality at validation time (value required by SQL)', async () => {
      const r = await q({ from: { resource: 'customers' }, where: [{ column: 'id', value: 2 }] });
      expect([200, 400]).toContain(r.status);
      if (r.status === 200) expect(ids(r)).toEqual([2]);
    });
    it('several predicates are AND-ed', async () => {
      const r = await q({ from: { resource: 'customers' }, where: [{ column: 'region', operator: 'EQ', value: 'EU' }, { column: 'active', operator: 'EQ', value: true }, { column: 'id', operator: 'GT', value: 1 }] });
      expect(ids(r)).toEqual([3]);
    });
    it('OR / grouped logic is expressed with a safe `expression` predicate', async () => {
      const r = await q({ from: { resource: 'customers' }, where: [{ expression: "(region = 'EU' AND active = true) OR id = 5" }] });
      expect(r.status).toBe(200);
      expect(ids(r)).toEqual([1, 3, 5]);
    });
    it('full-text `search` predicate', async () => {
      const r = await q({ from: { resource: 'customers' }, where: [{ search: { column: 'name', query: 'Ann' } }] });
      expect(r.status).toBe(200);
      expect(ids(r)).toEqual([1]);
    });
    it('empty IN matches nothing, empty NIN matches everything (never a SQL error)', async () => {
      const a = await q(where('id', 'IN', []));
      expect(a.status).toBe(200); expect(rows(a)).toEqual([]);
      const b = await q(where('id', 'NIN', []));
      expect(b.status).toBe(200); expect(ids(b)).toEqual([1, 2, 3, 4, 5]);
    });
    it('IN with a scalar behaves like a one element list', async () => {
      const r = await q(where('id', 'IN', 2));
      expect(r.status).toBe(200); expect(ids(r)).toEqual([2]);
    });
    it('EQ null / NE null use SQL NULL semantics (IS NULL / IS NOT NULL)', async () => {
      const a = await q(where('region', 'EQ', null));
      expect(a.status).toBe(200); expect(ids(a)).toEqual([4]);
      const b = await q(where('region', 'NE', null));
      expect(b.status).toBe(200); expect(ids(b)).toEqual([1, 2, 3, 5]);
    });
    it('boolean, numeric and date comparisons', async () => {
      expect(ids(await q(where('active', 'EQ', false)))).toEqual([2]);
      expect(ids(await q(where('score', 'GT', 20)))).toEqual([3, 5]);
      expect(ids(await q(where('joined', 'GTE', '2024-03-04')))).toEqual([3, 4, 5]);
      expect(ids(await q(where('joined', 'LT', '2024-02-03')))).toEqual([1]);
    });
    it('array and jsonb columns round-trip as JSON values', async () => {
      const r = await q({ from: { resource: 'customers' }, select: ['id', 'tags', 'meta'], where: [{ column: 'id', operator: 'EQ', value: 1 }] });
      expect(rows(r)).toEqual([{ id: 1, tags: ['a', 'b'], meta: { k: 1 } }]);
    });
    it('array containment operators are outside the safe expression grammar (400)', async () => {
      const r = await q({ from: { resource: 'customers' }, where: [{ expression: "tags @> ARRAY['a']" }] });
      expect(r.status).toBe(400);
    });
    it('LIKE wildcards in the value are matched literally as SQL wildcards, quotes are inert', async () => {
      const r = await q(where('name', 'LIKE', "A'%"));
      expect(r.status).toBe(200); expect(rows(r)).toEqual([]);
    });
    it('IS NULL ignores a supplied value', async () => {
      const r = await q(where('region', 'IS_NULL', 'whatever'));
      expect(r.status).toBe(200); expect(ids(r)).toEqual([4]);
    });
    it.todo('BETWEEN operator: not in the AST operator set (rejected with 400 INVALID_SQL_FRAGMENT); express as GTE + LTE');
    it.todo('nested $and / $or / $not boolean groups in `where`: the AST `where` is a flat AND list; use an `expression` predicate for OR');
    it.todo('NOT_LIKE: mapped by the SQL transpiler but missing from the AST validator operator set (400); use NOT with an expression');
    it.todo('MATCH / CONTAINS operators validate but have no hub SQL mapping (400 Unsupported operator)');

    it('BETWEEN is refused cleanly (400, not 500) and the supported alternative works', async () => {
      const a = await q(where('id', 'BETWEEN', [2, 4]));
      expect(a.status).toBe(400);
      const b = await q({ from: { resource: 'customers' }, where: [{ column: 'id', operator: 'GTE', value: 2 }, { column: 'id', operator: 'LTE', value: 4 }] });
      expect(ids(b)).toEqual([2, 3, 4]);
    });
    it('boolean group shapes ($and/$or/$not, or/and keys) are refused with 400, never executed', async () => {
      for (const w of [{ $or: [{ column: 'id', operator: 'EQ', value: 1 }] }, { or: [] }, { $and: [] }, { $not: { column: 'id', operator: 'EQ', value: 1 } }, 'id = 1', 7, null]) {
        const r = await q({ from: { resource: 'customers' }, where: [w] });
        expect(r.status).toBe(400);
      }
    });
    it('MATCH / CONTAINS and unknown operators are 400', async () => {
      for (const op of ['MATCH', 'CONTAINS', 'REGEX', 'SIMILAR', '~', 'EQ OR 1=1', '', '$eq']) {
        const r = await q(where('id', op, 1));
        expect(r.status).toBe(400);
      }
    });
  });

  describe('type coercion', () => {
    it('numbers sent as strings are coerced by Postgres', async () => {
      expect(ids(await q({ from: { resource: 'customers' }, where: [{ column: 'id', operator: 'EQ', value: '3' }] }))).toEqual([3]);
      expect(ids(await q({ from: { resource: 'customers' }, where: [{ column: 'id', operator: 'IN', value: ['1', '2'] }] }))).toEqual([1, 2]);
      expect(ids(await q({ from: { resource: 'customers' }, where: [{ column: 'score', operator: 'GT', value: '25.5' }] }))).toEqual([3, 5]);
    });
    it('booleans sent as "true"/"false" strings are coerced', async () => {
      expect(ids(await q({ from: { resource: 'customers' }, where: [{ column: 'active', operator: 'EQ', value: 'false' }] }))).toEqual([2]);
    });
    it('a value of the wrong type is a 400, not a 500', async () => {
      for (const [column, value] of [['id', 'abc'], ['id', '1.5.2'], ['active', 'maybe'], ['joined', '2024-13-45'], ['joined', 'not a date'], ['score', 'NaN-ish']] as const) {
        const r = await q({ from: { resource: 'customers' }, where: [{ column, operator: 'EQ', value }] });
        expect(r.status).toBe(400);
        expect(r.body.error).toBeTruthy();
      }
    });
    it('object / array values on scalar columns are 400', async () => {
      for (const value of [{ a: 1 }, [1, [2]]]) {
        const r = await q({ from: { resource: 'customers' }, where: [{ column: 'id', operator: 'EQ', value }] });
        expect(r.status).toBeGreaterThanOrEqual(400); expect(r.status).toBeLessThan(500);
      }
    });
    it('unicode, emoji and very long strings round-trip through CRUD + AST filters', async () => {
      const long = 'x'.repeat(50_000);
      const inserted = await data(ws.owner.token, 'create', { schema: SHOP, resource: 'customers', data: [
        { id: 100, name: 'Zoë 😀 日本語', region: 'ÆØÅ' }, { id: 101, name: long, region: 'LONG' },
      ] });
      expect(inserted.status).toBe(200);
      const a = await q({ from: { resource: 'customers' }, where: [{ column: 'name', operator: 'EQ', value: 'Zoë 😀 日本語' }] });
      expect(ids(a)).toEqual([100]);
      expect(rows(a)[0].region).toBe('ÆØÅ');
      const b = await q({ from: { resource: 'customers' }, select: ['id'], where: [{ column: 'name', operator: 'EQ', value: long }] });
      expect(ids(b)).toEqual([101]);
      const c = await q({ from: { resource: 'customers' }, where: [{ column: 'name', operator: 'LIKE', value: '%😀%' }] });
      expect(ids(c)).toEqual([100]);
      await data(ws.owner.token, 'delete', { schema: SHOP, resource: 'customers', where: { id: { $in: [100, 101] } } });
    });
    it('NUL bytes in values are refused (400), not sent to Postgres', async () => {
      const r = await q({ from: { resource: 'customers' }, where: [{ column: 'name', operator: 'EQ', value: 'a\u0000b' }] });
      expect(r.status).toBe(400);
    });
    it('a request body over the JSON limit is a 413, not a crash', async () => {
      const r = await q({ from: { resource: 'customers' }, where: [{ column: 'name', operator: 'EQ', value: 'y'.repeat(300_000) }] });
      expect(r.status).toBe(413);
    });
  });

  describe('views and materialized views', () => {
    it('reads a plain view (always recomputed)', async () => {
      const r = await q({ from: { resource: 'v_big_orders' }, orderBy: [{ column: 'id', direction: 'ASC' }] });
      expect(r.status).toBe(200);
      expect(ids(r)).toEqual([2, 4, 5]);
    });
    it('a view reflects new base rows immediately', async () => {
      await data(ws.owner.token, 'create', { schema: SHOP, resource: 'orders', data: { id: 50, customer_id: 1, amount: 500, status: 'NEW', placed: '2024-07-01T00:00:00Z' } });
      expect(ids(await q({ from: { resource: 'v_big_orders' } }))).toEqual([2, 4, 5, 50]);
      await data(ws.owner.token, 'delete', { schema: SHOP, resource: 'orders', where: { id: 50 } });
      expect(ids(await q({ from: { resource: 'v_big_orders' } }))).toEqual([2, 4, 5]);
    });
    it('a materialized view serves stored rows until it is refreshed', async () => {
      const before = await q({ from: { resource: 'mv_status_totals' }, orderBy: [{ column: 'status', direction: 'ASC' }] });
      expect(before.status).toBe(200);
      expect(rows(before).map((x) => [x.status, Number(x.total)])).toEqual([['NEW', 15], ['PAID', 184.5], ['SHIPPED', 15]]);
      await data(ws.owner.token, 'create', { schema: SHOP, resource: 'orders', data: { id: 51, customer_id: 1, amount: 1000, status: 'NEW', placed: '2024-07-02T00:00:00Z' } });
      const stale = await q({ from: { resource: 'mv_status_totals' }, where: [{ column: 'status', operator: 'EQ', value: 'NEW' }] });
      expect(Number(rows(stale)[0].total)).toBe(15);
      const rf = await astQuery(m, { type: 'SELECT', schema: SHOP, limit: 1, query: { from: { resource: 'orders' } } }); // control: still reachable
      expect(rf.status).toBe(200);
      const refreshed = await request(app).post('/api/analytics/refresh-view').set({ Authorization: `Bearer ${m}` }).send({ viewName: 'mv_status_totals', schema: SHOP, concurrent: false });
      expect(refreshed.status).toBe(202);
      let total = 15;
      for (let i = 0; i < 40 && total !== 1015; i++) {
        await sleep(100);
        const cur = await q({ from: { resource: 'mv_status_totals' }, where: [{ column: 'status', operator: 'EQ', value: 'NEW' }] });
        total = Number(rows(cur)[0]?.total);
      }
      expect(total).toBe(1015);
      await data(ws.owner.token, 'delete', { schema: SHOP, resource: 'orders', where: { id: 51 } });
    });
    it('refresh-view requires a view name and refuses foreign / reserved schemas', async () => {
      const req = request(app);
      const bad = await req.post('/api/analytics/refresh-view').set({ Authorization: `Bearer ${m}` }).send({ schema: SHOP });
      expect(bad.status).toBe(400);
      for (const schema of ['public', 'fabric_system', 'pg_catalog']) {
        const r = await req.post('/api/analytics/refresh-view').set({ Authorization: `Bearer ${m}` }).send({ viewName: 'mv_status_totals', schema });
        expect(r.status).toBe(403);
      }
      for (const viewName of ['nope_view', 'orders', 'v_big_orders']) { // unknown, a table, a plain view: none is a materialized view
        const r = await req.post('/api/analytics/refresh-view').set({ Authorization: `Bearer ${m}` }).send({ viewName, schema: SHOP });
        expect(r.status).toBe(404);
      }
      for (const viewName of ['x"; DROP TABLE y;--', 'a b', '']) {
        const r = await req.post('/api/analytics/refresh-view').set({ Authorization: `Bearer ${m}` }).send({ viewName, schema: SHOP });
        expect(r.status).toBe(400);
      }
    });
  });

  describe('request shape', () => {
    it('/api/queries/engine accepts {config} and the bare config', async () => {
      const cfg = { type: 'SELECT', schema: SHOP, limit: 5, query: { from: { resource: 'customers' }, select: ['id'], orderBy: [{ column: 'id', direction: 'ASC' }] } };
      const a = await engineQuery(m, cfg);
      expect(a.status).toBe(200); expect(ids(a)).toEqual([1, 2, 3, 4, 5]);
      const b = await request(app).post('/api/queries/engine').set({ Authorization: `Bearer ${m}` }).send(cfg);
      expect(b.status).toBe(200); expect(ids(b)).toEqual([1, 2, 3, 4, 5]);
    });
    it('the response envelope carries rowCount, plan legs and warnings', async () => {
      const r = await q({ from: { resource: 'customers' }, select: ['id'] }, 2);
      expect(r.body.rowCount).toBe(2);
      expect(r.body.plan.strategy).toBe('SINGLE_LOCAL');
      expect(r.body.plan.legs[0].query).toMatch(/LIMIT 2/);
      expect(Array.isArray(r.body.warnings)).toBe(true);
    });
    it('missing queryConfig / non-object config are 400', async () => {
      const req = request(app);
      expect((await req.post('/api/analytics/query').set({ Authorization: `Bearer ${m}` }).send({})).status).toBe(400);
      const r = await astQuery(m, 'SELECT 1' as any);
      expect(r.status).toBe(400);
    });
    it('SQL text is refused everywhere (astOnly)', async () => {
      const req = request(app);
      for (const body of [{ sql: 'select 1' }, { queryConfig: { rawSql: 'select 1' } }, { queryConfig: { type: 'SELECT', query: 'select 1' } }, { config: { nativeSql: 'x' } }]) {
        for (const path of ['/api/analytics/query', '/api/queries/engine', '/api/data/fetch']) {
          const r = await req.post(path).set({ Authorization: `Bearer ${m}` }).send(body);
          expect(r.status).toBe(400); expect(r.body.code).toBe('SQL_NOT_SUPPORTED');
        }
      }
    });
  });
});
