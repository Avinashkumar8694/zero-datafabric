/**
 * Injection corpus against EVERY string field of the AST (T2).
 * Each payload is placed in each field in turn. A request may succeed (payload treated as an inert literal) or be
 * refused with a 4xx; it must never be a 5xx, never run for long (pg_sleep), and never execute: a canary table in the
 * tenant schema and one in `public` must keep every row after the whole corpus.
 */
import '../tenancy/env';
import { app, request, pool, mkWorkspace, seedShop, seedFunction, SHOP, astQuery, purge, canaryRows, WS } from '../t2/kit';

jest.setTimeout(300000);

describe('AST: injection corpus in every field', () => {
  let ws: WS; let m: string; const pub = `t2_canary_${Date.now().toString(36)}`;
  const pubRows = async () => (await pool.query(`SELECT count(*)::int AS n FROM public."${pub}"`)).rows[0].n;

  beforeAll(async () => {
    ws = await mkWorkspace('astinj'); m = ws.member.token; await seedShop(ws); await seedFunction(ws);
    await pool.query(`CREATE TABLE public."${pub}" (id int)`); await pool.query(`INSERT INTO public."${pub}" VALUES (1)`);
  });
  afterAll(async () => { await pool.query(`DROP TABLE IF EXISTS public."${pub}"`); await purge(ws.tenantId); });

  const schema = () => ws.schema(SHOP);
  const payloads = () => [
    `x'; DROP TABLE canary; --`,
    `x"; DROP TABLE canary; --`,
    `1; DROP TABLE public."${pub}"`,
    `id); DROP TABLE public."${pub}"; --`,
    `' OR '1'='1`,
    `1 OR 1=1`,
    `x' UNION SELECT password_hash FROM public.users --`,
    `(SELECT pg_sleep(3))`,
    `pg_sleep(3)`,
    `id, pg_sleep(3)`,
    `a b`,
    `a.b.c.d`,
    `a"b`,
    `/* c */ id`,
    `id -- x`,
    `$$x$$`,
    '`x`',
    `x\u0000y`,
    'public.users',
    'information_schema.tables',
    'pg_catalog.pg_shadow',
    'tenant_other_x.orders',
    '*; DROP TABLE x',
    'ａdmin',
    'x'.repeat(300),
    '',
    ' ',
    '\n',
    '\\',
    '%',
    '{{7*7}}',
    "'||(select 1)||'",
  ];

  /** Every AST string slot: a builder receives the payload and returns the whole queryConfig. */
  const base = (query: any, over: any = {}) => ({ type: 'SELECT', schema: SHOP, limit: 20, query, ...over });
  const slots: Array<[string, (p: string) => any]> = [
    ['config.schema', (p) => base({ from: { resource: 'orders' } }, { schema: p })],
    ['from.resource', (p) => base({ from: { resource: p } })],
    ['from.alias', (p) => base({ from: { resource: 'orders', alias: p } })],
    ['from.source', (p) => base({ from: { resource: 'orders', source: p } })],
    ['select string', (p) => base({ from: { resource: 'orders' }, select: [p] })],
    ['select.column', (p) => base({ from: { resource: 'orders' }, select: [{ column: p }] })],
    ['select.alias', (p) => base({ from: { resource: 'orders' }, select: [{ column: 'id', alias: p }] })],
    ['select.expression', (p) => base({ from: { resource: 'orders' }, select: [{ expression: p, alias: 'x' }] })],
    ['select.expression alias', (p) => base({ from: { resource: 'orders' }, select: [{ expression: 'upper(status)', alias: p }] })],
    ['select.aggregate', (p) => base({ from: { resource: 'orders' }, select: [{ aggregate: p, column: 'amount', alias: 'x' }] })],
    ['select.aggregate column', (p) => base({ from: { resource: 'orders' }, select: [{ aggregate: 'SUM', column: p, alias: 'x' }] })],
    ['select.window', (p) => base({ from: { resource: 'orders' }, select: ['id', { window: p, orderBy: [{ column: 'id', direction: 'ASC' }], alias: 'w' }] })],
    ['select.window partitionBy', (p) => base({ from: { resource: 'orders' }, select: ['id', { window: 'RANK', partitionBy: [p], orderBy: [{ column: 'id', direction: 'ASC' }], alias: 'w' }] })],
    ['select.window orderBy.column', (p) => base({ from: { resource: 'orders' }, select: ['id', { window: 'RANK', orderBy: [{ column: p, direction: 'ASC' }], alias: 'w' }] })],
    ['select.window orderBy.direction', (p) => base({ from: { resource: 'orders' }, select: ['id', { window: 'RANK', orderBy: [{ column: 'id', direction: p }], alias: 'w' }] })],
    ['select.window alias', (p) => base({ from: { resource: 'orders' }, select: ['id', { window: 'RANK', orderBy: [{ column: 'id', direction: 'ASC' }], alias: p }] })],
    ['where.column', (p) => base({ from: { resource: 'orders' }, where: [{ column: p, operator: 'EQ', value: 1 }] })],
    ['where.operator', (p) => base({ from: { resource: 'orders' }, where: [{ column: 'id', operator: p, value: 1 }] })],
    ['where.value', (p) => base({ from: { resource: 'orders' }, where: [{ column: 'status', operator: 'EQ', value: p }] })],
    ['where.value LIKE', (p) => base({ from: { resource: 'orders' }, where: [{ column: 'status', operator: 'LIKE', value: p }] })],
    ['where.value IN', (p) => base({ from: { resource: 'orders' }, where: [{ column: 'status', operator: 'IN', value: [p, 'NEW'] }] })],
    ['where.expression', (p) => base({ from: { resource: 'orders' }, where: [{ expression: p }] })],
    ['where.search.column', (p) => base({ from: { resource: 'orders' }, where: [{ search: { column: p, query: 'x' } }] })],
    ['where.search.query', (p) => base({ from: { resource: 'orders' }, where: [{ search: { column: 'status', query: p } }] })],
    ['groupBy', (p) => base({ from: { resource: 'orders' }, select: [{ aggregate: 'COUNT', alias: 'n' }], groupBy: [p] })],
    ['orderBy.column', (p) => base({ from: { resource: 'orders' }, orderBy: [{ column: p, direction: 'ASC' }] })],
    ['orderBy.direction', (p) => base({ from: { resource: 'orders' }, orderBy: [{ column: 'id', direction: p }] })],
    ['having.column', (p) => base({ from: { resource: 'orders' }, select: ['status', { aggregate: 'COUNT', alias: 'n' }], groupBy: ['status'], having: [{ column: p, operator: 'GT', value: 0 }] })],
    ['having.operator', (p) => base({ from: { resource: 'orders' }, select: ['status', { aggregate: 'COUNT', alias: 'n' }], groupBy: ['status'], having: [{ column: 'n', operator: p, value: 0 }] })],
    ['having.value', (p) => base({ from: { resource: 'orders' }, select: ['status', { aggregate: 'COUNT', alias: 'n' }], groupBy: ['status'], having: [{ column: 'n', operator: 'GT', value: p }] })],
    ['limit', (p) => base({ from: { resource: 'orders' } }, { limit: p })],
    ['query.limit', (p) => base({ from: { resource: 'orders' }, limit: p })],
    ['query.offset', (p) => base({ from: { resource: 'orders' }, offset: p })],
    ['joins.resource', (p) => base({ from: { resource: 'orders', alias: 'o' }, joins: [{ type: 'INNER', resource: p, alias: 'c', on: { left: 'o.customer_id', operator: 'EQ', right: 'c.id' } }] })],
    ['joins.alias', (p) => base({ from: { resource: 'orders', alias: 'o' }, joins: [{ type: 'INNER', resource: 'customers', alias: p, on: { left: 'o.customer_id', operator: 'EQ', right: 'o.id' } }] })],
    ['joins.type', (p) => base({ from: { resource: 'orders', alias: 'o' }, joins: [{ type: p, resource: 'customers', alias: 'c', on: { left: 'o.customer_id', operator: 'EQ', right: 'c.id' } }] })],
    ['joins.on.left', (p) => base({ from: { resource: 'orders', alias: 'o' }, joins: [{ type: 'INNER', resource: 'customers', alias: 'c', on: { left: p, operator: 'EQ', right: 'c.id' } }] })],
    ['joins.on.right', (p) => base({ from: { resource: 'orders', alias: 'o' }, joins: [{ type: 'INNER', resource: 'customers', alias: 'c', on: { left: 'o.customer_id', operator: 'EQ', right: p } }] })],
    ['joins.on.operator', (p) => base({ from: { resource: 'orders', alias: 'o' }, joins: [{ type: 'INNER', resource: 'customers', alias: 'c', on: { left: 'o.customer_id', operator: p, right: 'c.id' } }] })],
    ['with.name', (p) => base({ with: [{ name: p, columns: ['id'], base: { from: { resource: 'orders' }, select: ['id'] } }], from: { resource: 'orders' } })],
    ['with.columns', (p) => base({ with: [{ name: 'w', columns: [p], base: { from: { resource: 'orders' }, select: ['id'] } }], from: { resource: 'w' } })],
    ['with.base resource', (p) => base({ with: [{ name: 'w', columns: ['id'], base: { from: { resource: p }, select: ['id'] } }], from: { resource: 'w' } })],
    ['union leg resource', (p) => base({ union: [{ from: { resource: 'orders' }, select: ['id'] }, { from: { resource: p }, select: ['id'] }] })],
    ['union leg column', (p) => base({ union: [{ from: { resource: 'orders' }, select: ['id'] }, { from: { resource: 'customers' }, select: [p] }] })],
    ['derived from alias', (p) => base({ from: { query: { from: { resource: 'orders' }, select: ['id'] }, alias: p }, select: ['id'] })],
    ['recursive.resource', (p) => base({ from: { resource: 'customers' }, recursive: { resource: p, select: ['id'], connectBy: { parent: 'manager_id', child: 'id' }, direction: 'down' } })],
    ['recursive.source', (p) => base({ from: { resource: 'customers' }, recursive: { resource: 'customers', source: p, select: ['id'], connectBy: { parent: 'manager_id', child: 'id' }, direction: 'down' } })],
    ['recursive.connectBy', (p) => base({ from: { resource: 'customers' }, recursive: { resource: 'customers', select: ['id', 'manager_id'], connectBy: { parent: p, child: 'id' }, direction: 'down' } })],
    ['recursive.startWith column', (p) => base({ from: { resource: 'customers' }, recursive: { resource: 'customers', select: ['id', 'manager_id'], connectBy: { parent: 'manager_id', child: 'id' }, startWith: [{ column: p, operator: 'EQ', value: 1 }], direction: 'down' } })],
    ['recursive.select', (p) => base({ from: { resource: 'customers' }, recursive: { resource: 'customers', select: [p], connectBy: { parent: 'manager_id', child: 'id' }, direction: 'down' } })],
    ['CALL function', (p) => ({ type: 'CALL', schema: 'fns', function: p, args: [] })],
    ['CALL procedure', (p) => ({ type: 'CALL', schema: 'fns', procedure: p, args: [] })],
    ['CALL schema', (p) => ({ type: 'CALL', schema: p, function: 'add_one', args: [1] })],
    ['CALL arg', (p) => ({ type: 'CALL', schema: 'fns', function: 'echo_text', args: [p] })],
  ];

  it('the corpus is non-trivial', () => { expect(slots.length * payloads().length).toBeGreaterThan(1500); });

  it.each(slots.map(([name, build]) => [name, build] as const))('payloads in %s never execute and never 5xx', async (_name, build) => {
    const seen: Record<string, number> = {};
    for (const p of payloads()) {
      const t0 = Date.now();
      const r = await astQuery(m, build(p));
      const ms = Date.now() - t0;
      seen[r.status] = (seen[r.status] || 0) + 1;
      if (r.status >= 500) throw new Error(`5xx for payload ${JSON.stringify(p).slice(0, 80)} in ${_name}: ${r.status} ${JSON.stringify(r.body).slice(0, 300)}`);
      expect(ms).toBeLessThan(2500); // pg_sleep(3) must never run
    }
    expect(await canaryRows(ws)).toBe(1);
    expect(await pubRows()).toBe(1);
  });

  describe('values are inert literals (200 with no rows) wherever a value is legal', () => {
    it.each(payloads().filter((p) => !p.includes('\u0000')))('where.value %j', async (p) => {
      const r = await astQuery(m, base({ from: { resource: 'orders' }, where: [{ column: 'status', operator: 'EQ', value: p }] }));
      expect(r.status).toBe(200);
      expect(r.body.data).toEqual([]);
    });
    it('a quote-laden value is stored and read back verbatim through CRUD + AST', async () => {
      const evil = `O'Brien"; DROP TABLE canary; --`;
      const c = await request(app).post('/api/data/create').set({ Authorization: `Bearer ${ws.owner.token}` }).send({ schema: SHOP, resource: 'canary', data: { id: 7, note: evil } });
      expect(c.status).toBe(200);
      const r = await astQuery(m, base({ from: { resource: 'canary' }, where: [{ column: 'note', operator: 'EQ', value: evil }] }));
      expect(r.body.data).toEqual([{ id: 7, note: evil }]);
      await pool.query(`DELETE FROM "${schema()}"."canary" WHERE id = 7`);
    });
  });

  describe('the planner / compiler SQL contains the payload only inside quoted literals', () => {
    it('plan.legs[].query for a value payload escapes the quote', async () => {
      const r = await astQuery(m, base({ from: { resource: 'orders' }, where: [{ column: 'status', operator: 'EQ', value: "a'b" }] }));
      expect(r.body.plan.legs[0].query).toContain("'a''b'");
    });
  });
});
