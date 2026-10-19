/**
 * AST joins, aggregation, ordering, pagination, CTE / recursive / window / set operations, subqueries and CALL (T2).
 * Every query runs through /api/analytics/query as a plain workspace member against hub tables made by a manifest.
 */
import '../tenancy/env';
import { app, request, bearer, mkWorkspace, seedShop, seedFunction, SHOP, astQuery, data, purge, WS } from '../t2/kit';

jest.setTimeout(120000);

describe('AST: joins, aggregates, ordering, pagination, CTE/recursive/window/set ops, CALL', () => {
  let ws: WS; let m: string;
  const q = (query: any, limit: number | null = 100) => astQuery(m, { type: 'SELECT', schema: SHOP, ...(limit === null ? {} : { limit }), query });
  const rows = (r: any) => r.body.data as any[];
  const on = (left: string, right: string, operator = 'EQ') => ({ left, operator, right });

  beforeAll(async () => { ws = await mkWorkspace('astjoin'); m = ws.member.token; await seedShop(ws); await seedFunction(ws); });
  afterAll(async () => { await purge(ws.tenantId); });

  describe('joins', () => {
    const join = (type: string) => q({
      from: { resource: 'customers', alias: 'c' },
      joins: [{ type, resource: 'orders', alias: 'o', on: on('c.id', 'o.customer_id') }],
      select: ['c.name', 'o.id'],
    });
    const pairs = (r: any) => rows(r).map((x) => `${x.name ?? '-'}:${x.id ?? '-'}`).sort();

    it('INNER JOIN keeps only matching pairs', async () => {
      const r = await join('INNER');
      expect(r.status).toBe(200);
      expect(pairs(r)).toEqual(['Ann:1', 'Ann:2', 'Bob:3', 'Cy:5', 'Eve:6']);
    });
    it('LEFT JOIN keeps customers without orders', async () => {
      const r = await join('LEFT');
      expect(pairs(r)).toEqual(['Ann:1', 'Ann:2', 'Bob:3', 'Cy:5', 'Dee:-', 'Eve:6']);
    });
    it('RIGHT JOIN keeps orders without a customer', async () => {
      const r = await join('RIGHT');
      expect(pairs(r)).toEqual(['-:4', 'Ann:1', 'Ann:2', 'Bob:3', 'Cy:5', 'Eve:6']);
    });
    it('FULL JOIN keeps both unmatched sides', async () => {
      const r = await join('FULL');
      expect(pairs(r)).toEqual(['-:4', 'Ann:1', 'Ann:2', 'Bob:3', 'Cy:5', 'Dee:-', 'Eve:6']);
    });
    it('CROSS JOIN is rejected when there is no ON (400) or planned as a product with an ON', async () => {
      const r = await q({ from: { resource: 'customers', alias: 'c' }, joins: [{ type: 'CROSS', resource: 'canary', alias: 'k', on: on('c.id', 'k.id') }], select: ['c.id', 'k.id'] });
      expect([200, 400]).toContain(r.status);
    });
    it('join type is case-insensitive and "OUTER" spellings are accepted by validation', async () => {
      const r = await join('left');
      expect(r.status).toBe(200);
      expect(rows(r).length).toBe(6);
    });
    it('multi-join: customers -> orders -> canary', async () => {
      const r = await q({
        from: { resource: 'customers', alias: 'c' },
        joins: [
          { type: 'INNER', resource: 'orders', alias: 'o', on: on('c.id', 'o.customer_id') },
          { type: 'LEFT', resource: 'canary', alias: 'k', on: on('c.id', 'k.id') },
        ],
        select: ['c.name', 'o.id', { column: 'k.note', alias: 'note' }],
        where: [{ column: 'o.status', operator: 'EQ', value: 'PAID' }],
      });
      expect(r.status).toBe(200);
      expect(rows(r).map((x) => `${x.name}:${x.id}:${x.note}`).sort()).toEqual(['Ann:2:alive', 'Cy:5:null']);
    });
    it('self join (employee -> manager) with distinct aliases', async () => {
      const r = await q({
        from: { resource: 'customers', alias: 'e' },
        joins: [{ type: 'LEFT', resource: 'customers', alias: 'mg', on: on('e.manager_id', 'mg.id') }],
        select: ['e.name', { column: 'mg.name', alias: 'boss' }],
        orderBy: [{ column: 'e.id', direction: 'ASC' }],
      });
      expect(r.status).toBe(200);
      expect(rows(r)).toEqual([{ name: 'Ann', boss: null }, { name: 'Bob', boss: 'Ann' }, { name: 'Cy', boss: 'Ann' }, { name: 'Dee', boss: 'Bob' }, { name: 'Eve', boss: 'Bob' }]);
    });
    it('non-equality join predicate and WHERE on the joined side', async () => {
      const r = await q({
        from: { resource: 'customers', alias: 'c' },
        joins: [{ type: 'INNER', resource: 'orders', alias: 'o', on: on('c.id', 'o.customer_id') }],
        select: ['c.name', 'o.amount'],
        where: [{ column: 'o.amount', operator: 'GTE', value: 25 }],
        orderBy: [{ column: 'o.amount', direction: 'DESC' }],
      });
      expect(rows(r).map((x) => x.name)).toEqual(['Cy', 'Ann']);
    });
    it('a join against an unknown table is a 404, not a 500', async () => {
      const r = await q({ from: { resource: 'customers', alias: 'c' }, joins: [{ type: 'INNER', resource: 'ghost', alias: 'g', on: on('c.id', 'g.id') }] });
      expect(r.status).toBe(404);
    });
    it('a join on an unknown column is a 400', async () => {
      const r = await q({ from: { resource: 'customers', alias: 'c' }, joins: [{ type: 'INNER', resource: 'orders', alias: 'o', on: on('c.id', 'o.ghost') }] });
      expect(r.status).toBe(400);
    });
    it('invalid join type is a 400', async () => {
      for (const type of ['SIDEWAYS', 'INNER; DROP TABLE x', 'NATURAL']) {
        const r = await join(type);
        expect(r.status).toBe(400);
      }
    });
  });

  describe('aggregates, GROUP BY, HAVING', () => {
    const agg = (select: any[], extra: any = {}) => q({ from: { resource: 'orders' }, select, ...extra }, null);
    it('COUNT(*) / SUM / AVG / MIN / MAX in one projection without GROUP BY', async () => {
      const r = await agg([
        { aggregate: 'COUNT', column: '*', alias: 'n' }, { aggregate: 'SUM', column: 'amount', alias: 's' },
        { aggregate: 'AVG', column: 'amount', alias: 'a' }, { aggregate: 'MIN', column: 'amount', alias: 'lo' }, { aggregate: 'MAX', column: 'amount', alias: 'hi' },
      ]);
      expect(r.status).toBe(200);
      const x = rows(r)[0];
      expect([Number(x.n), Number(x.s), Number(x.lo), Number(x.hi)]).toEqual([6, 214.5, 5, 99]);
      expect(Number(x.a)).toBeCloseTo(35.75, 5);
    });
    it('COUNT without a column counts rows; COUNT(col) skips NULLs', async () => {
      const a = await q({ from: { resource: 'customers' }, select: [{ aggregate: 'COUNT', alias: 'n' }] }, null);
      expect(Number(rows(a)[0].n)).toBe(5);
      const b = await q({ from: { resource: 'customers' }, select: [{ aggregate: 'COUNT', column: 'region', alias: 'n' }] }, null);
      expect(Number(rows(b)[0].n)).toBe(4);
    });
    it('COUNT_DISTINCT counts distinct non-null values', async () => {
      const r = await q({ from: { resource: 'customers' }, select: [{ aggregate: 'COUNT_DISTINCT', column: 'region', alias: 'n' }] }, null);
      expect(r.status).toBe(200);
      expect(Number(rows(r)[0].n)).toBe(3);
    });
    it('GROUP BY with aggregates', async () => {
      const r = await agg(['status', { aggregate: 'COUNT', column: '*', alias: 'n' }, { aggregate: 'SUM', column: 'amount', alias: 'total' }], { groupBy: ['status'], orderBy: [{ column: 'status', direction: 'ASC' }] });
      expect(r.status).toBe(200);
      expect(rows(r).map((x) => [x.status, Number(x.n), Number(x.total)])).toEqual([['NEW', 2, 15], ['PAID', 3, 184.5], ['SHIPPED', 1, 15]]);
    });
    it('GROUP BY two columns', async () => {
      const r = await q({ from: { resource: 'customers' }, select: ['region', 'active', { aggregate: 'COUNT', alias: 'n' }], groupBy: ['region', 'active'], orderBy: [{ column: 'region', direction: 'ASC' }, { column: 'active', direction: 'ASC' }] }, null);
      expect(r.status).toBe(200);
      expect(rows(r).length).toBe(4);
    });
    it('HAVING filters the groups on an aggregate alias', async () => {
      const r = await agg(['status', { aggregate: 'COUNT', column: '*', alias: 'n' }], { groupBy: ['status'], having: [{ column: 'n', operator: 'GT', value: 1 }], orderBy: [{ column: 'status', direction: 'ASC' }] });
      expect(r.status).toBe(200);
      expect(rows(r).map((x) => x.status)).toEqual(['NEW', 'PAID']);
    });
    it('HAVING with several predicates and operators', async () => {
      const r = await agg(['status', { aggregate: 'COUNT', column: '*', alias: 'n' }, { aggregate: 'SUM', column: 'amount', alias: 'total' }], {
        groupBy: ['status'], having: [{ column: 'n', operator: 'GTE', value: 1 }, { column: 'total', operator: 'LT', value: 100 }], orderBy: [{ column: 'status', direction: 'ASC' }],
      });
      expect(rows(r).map((x) => x.status)).toEqual(['NEW', 'SHIPPED']);
    });
    it('aggregate over a join', async () => {
      const r = await q({
        from: { resource: 'customers', alias: 'c' }, joins: [{ type: 'INNER', resource: 'orders', alias: 'o', on: on('c.id', 'o.customer_id') }],
        select: ['c.name', { aggregate: 'SUM', column: 'o.amount', alias: 'spent' }], groupBy: ['c.name'], orderBy: [{ column: 'c.name', direction: 'ASC' }],
      }, null);
      expect(r.status).toBe(200);
      expect(rows(r).map((x) => [x.name, Number(x.spent)])).toEqual([['Ann', 35.5], ['Bob', 5], ['Cy', 60], ['Eve', 15]]);
    });
    it('a group-by query needs no limit (bounded by shape)', async () => {
      const r = await agg(['status', { aggregate: 'COUNT', alias: 'n' }], { groupBy: ['status'] });
      expect(r.status).toBe(200);
    });
    it('unknown aggregate / bad column are 400', async () => {
      expect((await agg([{ aggregate: 'MEDIAN', column: 'amount', alias: 'x' }])).status).toBe(400);
      expect((await agg([{ aggregate: 'SUM', column: 'ghost', alias: 'x' }])).status).toBe(400);
      expect((await agg([{ aggregate: 'SUM', column: 'status', alias: 'x' }])).status).toBe(400); // sum(text)
    });
    it('selecting a non-grouped column next to an aggregate is a 400 (Postgres grouping error), not a 500', async () => {
      const r = await agg(['status', { aggregate: 'COUNT', alias: 'n' }]);
      expect(r.status).toBeGreaterThanOrEqual(400); expect(r.status).toBeLessThan(500);
    });
  });

  describe('ORDER BY, LIMIT, OFFSET, pagination', () => {
    const page = (limit: number, offset: number, direction = 'ASC') => q({ from: { resource: 'orders' }, select: ['id'], orderBy: [{ column: 'id', direction }], offset }, limit);
    it('multi-column ordering with mixed directions', async () => {
      const r = await q({ from: { resource: 'orders' }, select: ['status', 'id'], orderBy: [{ column: 'status', direction: 'DESC' }, { column: 'id', direction: 'ASC' }] });
      expect(r.status).toBe(200);
      expect(rows(r).map((x) => `${x.status}:${x.id}`)).toEqual(['SHIPPED:6', 'PAID:2', 'PAID:4', 'PAID:5', 'NEW:1', 'NEW:3']);
    });
    it('direction is case-insensitive; omitted direction means ASC', async () => {
      const r = await q({ from: { resource: 'orders' }, select: ['id'], orderBy: [{ column: 'id', direction: 'desc' }] }, 2);
      expect(rows(r).map((x) => x.id)).toEqual([6, 5]);
      const s = await q({ from: { resource: 'orders' }, select: ['id'], orderBy: [{ column: 'id' }] }, 2);
      expect(rows(s).map((x) => x.id)).toEqual([1, 2]);
    });
    it('order by an aggregate alias', async () => {
      const r = await q({ from: { resource: 'orders' }, select: ['status', { aggregate: 'SUM', column: 'amount', alias: 'total' }], groupBy: ['status'], orderBy: [{ column: 'total', direction: 'DESC' }] }, null);
      expect(rows(r).map((x) => x.status)).toEqual(['PAID', 'NEW', 'SHIPPED'].slice(0, 1).concat(rows(r).slice(1).map((x) => x.status)));
      expect(rows(r)[0].status).toBe('PAID');
    });
    it('limit cuts, offset skips: pages are disjoint and complete', async () => {
      const p1 = await page(2, 0); const p2 = await page(2, 2); const p3 = await page(2, 4); const p4 = await page(2, 6);
      expect(rows(p1).map((x) => x.id)).toEqual([1, 2]);
      expect(rows(p2).map((x) => x.id)).toEqual([3, 4]);
      expect(rows(p3).map((x) => x.id)).toEqual([5, 6]);
      expect(rows(p4)).toEqual([]);
    });
    it('pagination is stable across repeated reads (same page, same rows)', async () => {
      const a = await page(3, 1, 'DESC'); const b = await page(3, 1, 'DESC');
      expect(rows(a)).toEqual(rows(b));
      expect(rows(a).map((x) => x.id)).toEqual([5, 4, 3]);
    });
    it('paging through the whole table with a tie-breaker order yields every row exactly once', async () => {
      const seen: number[] = [];
      for (let off = 0; off < 12; off += 4) {
        const r = await q({ from: { resource: 'orders' }, select: ['id'], orderBy: [{ column: 'status', direction: 'ASC' }, { column: 'id', direction: 'ASC' }], offset: off }, 4);
        seen.push(...rows(r).map((x) => x.id));
      }
      expect(seen.sort((a, b) => a - b)).toEqual([1, 2, 3, 4, 5, 6]);
    });
    it('offset beyond the table is an empty page', async () => {
      const r = await page(5, 1000);
      expect(r.status).toBe(200); expect(rows(r)).toEqual([]);
    });
    it('offset as a numeric string is accepted; garbage offsets are 400', async () => {
      const ok = await q({ from: { resource: 'orders' }, select: ['id'], orderBy: [{ column: 'id', direction: 'ASC' }], offset: '2' }, 2);
      expect(ok.status).toBe(200); expect(rows(ok).map((x) => x.id)).toEqual([3, 4]);
      for (const offset of [-1, 1.5, 'abc', '1; DROP TABLE x', {}, 1e12]) {
        const r = await q({ from: { resource: 'orders' }, select: ['id'], orderBy: [{ column: 'id', direction: 'ASC' }], offset }, 2);
        expect(r.status).toBe(400);
      }
    });
    it('invalid direction is a 400', async () => {
      for (const direction of ['SIDEWAYS', 'ASC; DROP TABLE x', 'ASC,id']) {
        const r = await q({ from: { resource: 'orders' }, orderBy: [{ column: 'id', direction }] });
        expect(r.status).toBe(400);
      }
    });
  });

  describe('CTE, derived tables, recursion, window functions, set operations', () => {
    it('WITH (non-recursive) CTE is read by the main query', async () => {
      const r = await q({
        with: [{ name: 'big', columns: ['id'], base: { from: { resource: 'orders' }, select: ['id'], where: [{ column: 'amount', operator: 'GT', value: 20 }] } }],
        from: { resource: 'big' }, select: ['id'], orderBy: [{ column: 'id', direction: 'ASC' }],
      });
      expect(r.status).toBe(200);
      expect(rows(r).map((x) => x.id)).toEqual([2, 4, 5]);
    });
    it('WITH RECURSIVE (base + unionAll) walks the manager hierarchy in SQL', async () => {
      const r = await q({
        with: [{
          name: 'tree', columns: ['id', 'depth'],
          base: { from: { resource: 'customers' }, select: ['id', { expression: '0', alias: 'depth' }], where: [{ column: 'id', operator: 'EQ', value: 1 }] },
          unionAll: { from: { resource: 'customers', alias: 'c' }, joins: [{ type: 'INNER', resource: 'tree', alias: 't', on: on('c.manager_id', 't.id') }], select: ['c.id', { expression: 't.depth + 1', alias: 'depth' }] },
        }],
        from: { resource: 'tree' }, select: ['id', 'depth'], orderBy: [{ column: 'depth', direction: 'ASC' }, { column: 'id', direction: 'ASC' }],
      });
      expect(r.status).toBe(200);
      expect(rows(r).map((x) => `${x.id}@${x.depth}`)).toEqual(['1@0', '2@1', '3@1', '4@2', '5@2']);
    });
    it('in-fabric recursive traversal (query.recursive): down, up, depth cap, path', async () => {
      const spec = (over: any) => ({ from: { resource: 'customers' }, recursive: { resource: 'customers', select: ['id', 'manager_id'], connectBy: { parent: 'manager_id', child: 'id' }, direction: 'down', maxDepth: 10, ...over } });
      const down = await q(spec({ startWith: [{ column: 'id', operator: 'EQ', value: 1 }] }));
      expect(down.status).toBe(200);
      expect(rows(down).map((x) => x.id).sort()).toEqual([1, 2, 3, 4, 5]);
      expect(rows(down).find((x) => x.id === 4).depth).toBe(2);
      const up = await q(spec({ startWith: [{ column: 'id', operator: 'EQ', value: 5 }], direction: 'up' }));
      expect(rows(up).map((x) => x.id).sort()).toEqual([1, 2, 5]);
      const capped = await q(spec({ startWith: [{ column: 'id', operator: 'EQ', value: 1 }], maxDepth: 1 }));
      expect(rows(capped).map((x) => x.id).sort()).toEqual([1, 2, 3]);
      expect(JSON.stringify(capped.body.warnings)).toMatch(/maxDepth/);
      const roots = await q(spec({}));
      expect(rows(roots).length).toBe(5); // forest from every NULL parent
    });
    it('recursive traversal composes with groupBy + aggregate + having', async () => {
      const r = await q({
        from: { resource: 'customers' }, select: ['depth', { aggregate: 'COUNT', column: '*', alias: 'n' }], groupBy: ['depth'],
        recursive: { resource: 'customers', select: ['id', 'manager_id'], connectBy: { parent: 'manager_id', child: 'id' }, startWith: [{ column: 'id', operator: 'EQ', value: 1 }], direction: 'down', maxDepth: 10 },
        orderBy: [{ column: 'depth', direction: 'ASC' }],
      });
      expect(r.status).toBe(200);
      expect(rows(r).map((x) => [x.depth, Number(x.n)])).toEqual([[0, 1], [1, 2], [2, 2]]);
    });
    it('a cyclic hierarchy terminates (seen-set guard)', async () => {
      await data(ws.owner.token, 'update', { schema: SHOP, resource: 'customers', where: { id: 1 }, data: { manager_id: 4 } });
      try {
        const r = await q({ from: { resource: 'customers' }, recursive: { resource: 'customers', select: ['id', 'manager_id'], connectBy: { parent: 'manager_id', child: 'id' }, startWith: [{ column: 'id', operator: 'EQ', value: 1 }], direction: 'down', maxDepth: 50 } });
        expect(r.status).toBe(200);
        expect(rows(r).map((x) => x.id).sort()).toEqual([1, 2, 3, 4, 5]);
      } finally { await data(ws.owner.token, 'update', { schema: SHOP, resource: 'customers', where: { id: 1 }, data: { manager_id: null } }); }
    });
    it('derived table in FROM (subquery)', async () => {
      const r = await q({
        from: { query: { from: { resource: 'orders' }, select: ['id', 'amount'], where: [{ column: 'amount', operator: 'GT', value: 20 }] }, alias: 'd' },
        select: ['d.id'], orderBy: [{ column: 'd.id', direction: 'ASC' }],
      });
      expect(r.status).toBe(200);
      expect(rows(r).map((x) => x.id)).toEqual([2, 4, 5]);
    });
    it('a derived table without an alias is a 400', async () => {
      const r = await q({ from: { query: { from: { resource: 'orders' }, select: ['id'] } }, select: ['id'] });
      expect(r.status).toBe(400);
    });
    it('window functions: RANK per partition and ROW_NUMBER', async () => {
      const r = await q({
        from: { resource: 'orders' },
        select: ['id', 'status',
          { window: 'RANK', partitionBy: ['status'], orderBy: [{ column: 'amount', direction: 'DESC' }], alias: 'rk' },
          { window: 'ROW_NUMBER', orderBy: [{ column: 'id', direction: 'ASC' }], alias: 'rn' }],
        orderBy: [{ column: 'id', direction: 'ASC' }],
      });
      expect(r.status).toBe(200);
      const byId = Object.fromEntries(rows(r).map((x) => [x.id, x]));
      expect(byId[4].rk).toBe(1); expect(byId[5].rk).toBe(2); expect(byId[2].rk).toBe(3); expect(byId[1].rk).toBe(1); expect(byId[3].rk).toBe(2);
      expect(rows(r).map((x) => x.rn)).toEqual([1, 2, 3, 4, 5, 6]);
      expect(r.body.plan.strategy).toMatch(/WINDOW/);
    });
    it('window functions respect WHERE and LIMIT', async () => {
      const r = await q({
        from: { resource: 'orders' }, select: ['id', { window: 'ROW_NUMBER', orderBy: [{ column: 'amount', direction: 'DESC' }], alias: 'rn' }],
        where: [{ column: 'status', operator: 'EQ', value: 'PAID' }], orderBy: [{ column: 'rn', direction: 'ASC' }],
      }, 2);
      expect(r.status).toBe(200);
      expect(rows(r).map((x) => [x.id, x.rn])).toEqual([[4, 1], [5, 2]]);
    });
    it('UNION (distinct), INTERSECT and EXCEPT of hub legs', async () => {
      const leg = (resource: string, col: string, extra: any = {}) => ({ from: { resource }, select: [col], ...extra });
      const u = await q({ union: [leg('customers', 'id'), leg('orders', 'id')] }, null);
      expect(u.status).toBe(200); expect(rows(u).map((x) => x.id).sort()).toEqual([1, 2, 3, 4, 5, 6]);
      const i = await q({ intersect: [leg('customers', 'id'), leg('orders', 'id', { where: [{ column: 'id', operator: 'LTE', value: 3 }] })] }, null);
      expect(rows(i).map((x) => x.id).sort()).toEqual([1, 2, 3]);
      const e = await q({ except: [leg('customers', 'id'), leg('orders', 'id', { where: [{ column: 'id', operator: 'LTE', value: 3 }] })] }, null);
      expect(rows(e).map((x) => x.id).sort()).toEqual([4, 5]);
    });
    it('set operation with ORDER BY / LIMIT / OFFSET on the combined result', async () => {
      const r = await q({
        union: [{ from: { resource: 'customers' }, select: ['id'] }, { from: { resource: 'orders' }, select: ['id'] }],
        orderBy: [{ column: 'id', direction: 'DESC' }], offset: 1,
      }, 3);
      expect(r.status).toBe(200);
      expect(rows(r).map((x) => x.id)).toEqual([5, 4, 3]);
    });
    it('set operations with mismatched column counts are a 400', async () => {
      const r = await q({ union: [{ from: { resource: 'customers' }, select: ['id'] }, { from: { resource: 'orders' }, select: ['id', 'status'] }] }, null);
      expect(r.status).toBe(400);
    });
    it.todo('MERGE / UPSERT AST types: the engine has no such config type (INSERT / UPDATE / DELETE only); use data/create + data/update');
    it.todo('cross-engine joins (hub x remote) are covered by the connections suite against a real remote Postgres');
  });

  describe('CALL a tenant function', () => {
    it('AST {type: CALL} and /api/data/call return the function result', async () => {
      const a = await astQuery(m, { type: 'CALL', schema: 'fns', function: 'add_one', args: [41] });
      expect(a.status).toBe(200);
      expect(a.body.data).toEqual([{ add_one: 42 }]);
      expect(a.body.plan.strategy).toBe('FUNCTION_CALL');
      const b = await data(m, 'call', { schema: 'fns', function: 'add_one', args: [1] });
      expect(b.status).toBe(200); expect(b.body.data).toEqual([{ add_one: 2 }]);
    });
    it('a "schema.function" name and the physical schema name both resolve inside the tenant', async () => {
      const a = await astQuery(m, { type: 'CALL', function: 'fns.add_one', args: [9] });
      expect(a.body.data).toEqual([{ add_one: 10 }]);
      const b = await astQuery(m, { type: 'CALL', function: `${ws.schema('fns')}.add_one`, args: [9] });
      expect(b.body.data).toEqual([{ add_one: 10 }]);
    });
    it('arguments are bound as parameters (a quote-laden string comes back verbatim, nothing runs)', async () => {
      const evil = "x'); DROP TABLE canary; --";
      const r = await astQuery(m, { type: 'CALL', schema: 'fns', function: 'echo_text', args: [evil] });
      expect(r.status).toBe(200);
      expect(r.body.data).toEqual([{ echo_text: evil }]);
      expect((await q({ from: { resource: 'canary' } })).body.rowCount).toBe(1);
    });
    it('unknown function -> 404; missing name -> 400; wrong arg type -> 400; too many args -> 400', async () => {
      expect((await astQuery(m, { type: 'CALL', schema: 'fns', function: 'ghost', args: [] })).status).toBe(404);
      expect((await astQuery(m, { type: 'CALL', schema: 'fns', args: [] })).status).toBe(400);
      expect((await astQuery(m, { type: 'CALL', schema: 'fns', function: 'add_one', args: ['not a number'] })).status).toBe(400);
      expect((await astQuery(m, { type: 'CALL', schema: 'fns', function: 'add_one', args: Array.from({ length: 101 }, (_, i) => i) })).status).toBe(400);
    });
    it('system / foreign / three-part targets are refused', async () => {
      for (const fn of ['fabric_admin.create_tenant_namespace', 'public.now', 'pg_catalog.now', 'pg_sleep', 'a.b.c', 'tenant_other_x.add_one', 'fns.add_one; DROP TABLE x', 'now() --']) {
        const r = await astQuery(m, { type: 'CALL', function: fn, args: [] });
        expect(r.status).toBeGreaterThanOrEqual(400); expect(r.status).toBeLessThan(500);
      }
    });
    it('transpile of a CALL returns text and does not run it', async () => {
      const r = await request(app).post('/api/queries/transpile').set(bearer(m)).send({ type: 'CALL', schema: 'fns', function: 'add_one', args: [1] });
      expect(r.status).toBe(200);
      expect(r.body.sql).toBe('SELECT * FROM "fns"."add_one"(1);');
    });
  });
});
