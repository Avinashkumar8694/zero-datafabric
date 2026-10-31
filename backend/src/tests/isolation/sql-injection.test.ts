/**
 * SQL injection through every AST / legacy-config field, end to end (HTTP, USER token). A sentinel table in the
 * tenant must survive and nothing outside the tenant may be touched. Payloads must be rejected (4xx) — never 5xx
 * (an unhandled SQL error would mean text reached the database).
 */
import { app, pool, request, mkTenant, mkTable, auth, suffix, cleanupAll, TestTenant } from './harness';

jest.setTimeout(120000);

describe('Isolation: SQL injection corpus (end to end)', () => {
  const s = suffix();
  let A: TestTenant; let V: TestTenant;
  beforeAll(async () => {
    A = await mkTenant(`isoia_${s}`);
    V = await mkTenant(`isoiv_${s}`);
    await mkTable(A, 'orders', [{ v: 'o1' }, { v: 'o2' }]);
    await mkTable(A, 'sentinel', [{ v: 's1' }]);
    await mkTable(V, 'victim', [{ v: 'VICTIM-SECRET' }]);
  });
  afterAll(async () => { await cleanupAll(); });

  const run = (cfg: any) => request(app).post('/api/analytics/query').set(auth(A.member.token)).send({ queryConfig: cfg });
  const D = `x"; DROP TABLE "${'${A}'}".sentinel; --`;

  async function intact() {
    const a = await pool.query(`SELECT count(*)::int AS n FROM "${A.schema}"."sentinel"`);
    expect(a.rows[0].n).toBe(1);
    const v = await pool.query(`SELECT v FROM "${V.schema}"."victim"`);
    expect(v.rows[0].v).toBe('VICTIM-SECRET');
    const users = await pool.query('SELECT count(*)::int AS n FROM public.users WHERE id = ANY($1::uuid[])', [[A.owner.id, A.member.id, V.owner.id]]);
    expect(users.rows[0].n).toBe(3);
  }

  const POISON = (t: TestTenant) => [
    `1; DROP TABLE "${A.schema}".sentinel; --`,
    `x') ; DROP TABLE "${A.schema}".sentinel; --`,
    `(SELECT v FROM "${V.schema}".victim LIMIT 1)`,
    `id UNION SELECT v FROM "${V.schema}".victim`,
    `pg_sleep(5)`,
    `set_config('app.tenant_id','${V.id}',false)`,
    `id; RESET ROLE; DROP TABLE "${A.schema}".sentinel`,
  ];

  it('AST: select / where / groupBy / orderBy / joins / aggregate / window / CTE / set-ops / limit all refuse injected text', async () => {
    const asts: any[] = [];
    for (const p of POISON(A)) {
      asts.push(
        { type: 'SELECT', limit: 5, query: { from: { resource: 'orders' }, select: [p] } },
        { type: 'SELECT', limit: 5, query: { from: { resource: 'orders' }, select: [{ expression: p }] } },
        { type: 'SELECT', limit: 5, query: { from: { resource: 'orders' }, select: [{ aggregate: p, column: 'id' }] } },
        { type: 'SELECT', limit: 5, query: { from: { resource: 'orders' }, select: [{ window: p }] } },
        { type: 'SELECT', limit: 5, query: { from: { resource: 'orders' }, select: [{ column: 'id', alias: p }] } },
        { type: 'SELECT', limit: 5, query: { from: { resource: 'orders' }, where: [{ expression: p }] } },
        { type: 'SELECT', limit: 5, query: { from: { resource: 'orders' }, where: [{ column: p, operator: 'EQ', value: 1 }] } },
        { type: 'SELECT', limit: 5, query: { from: { resource: 'orders' }, where: [{ column: 'id', operator: p, value: 1 }] } },
        { type: 'SELECT', limit: 5, query: { from: { resource: 'orders' }, groupBy: [p] } },
        { type: 'SELECT', limit: 5, query: { from: { resource: 'orders' }, orderBy: [{ column: p, direction: 'ASC' }] } },
        { type: 'SELECT', limit: 5, query: { from: { resource: 'orders' }, orderBy: [{ column: 'id', direction: p }] } },
        { type: 'SELECT', limit: 5, query: { from: { resource: p } } },
        { type: 'SELECT', limit: 5, query: { from: { resource: 'orders', alias: p } } },
        { type: 'SELECT', limit: 5, query: { from: { resource: 'orders', source: p } } },
        { type: 'SELECT', limit: 5, query: { from: { resource: 'orders' }, joins: [{ type: p, resource: 'orders', on: { left: 'a.id', operator: 'EQ', right: 'b.id' } }] } },
        { type: 'SELECT', limit: 5, query: { from: { resource: 'orders' }, joins: [{ type: 'INNER', resource: p, on: { left: 'a.id', operator: 'EQ', right: 'b.id' } }] } },
        { type: 'SELECT', limit: 5, query: { from: { resource: 'orders' }, joins: [{ type: 'INNER', resource: 'orders', on: { left: p, operator: 'EQ', right: 'b.id' } }] } },
        { type: 'SELECT', limit: 5, query: { from: { resource: 'orders' }, with: [{ name: p, columns: ['a'], base: { from: { resource: 'orders' } } }] } },
        { type: 'SELECT', limit: 5, query: { from: { resource: 'orders' }, with: [{ name: 'c', columns: [p], base: { from: { resource: 'orders' } } }] } },
        { type: 'SELECT', limit: 5, query: { from: { resource: 'orders' }, union: [{ from: { resource: p } }] } },
        { type: 'SELECT', limit: p, query: { from: { resource: 'orders' } } },
        { type: 'SELECT', schema: p, limit: 5, query: { from: { resource: 'orders' } } },
        { type: 'SELECT', limit: 5, query: { from: { resource: 'orders' }, limit: p } },
        { type: 'SELECT', limit: 5, query: { from: { resource: 'orders' }, offset: p } },
      );
    }
    for (const cfg of asts) {
      const r = await run(cfg);
      expect(r.status).toBeGreaterThanOrEqual(400);
      expect(r.status).toBeLessThan(500);
      expect(JSON.stringify(r.body)).not.toContain('VICTIM-SECRET');
    }
    await intact();
  });

  it('AST: string values are literals - a quote in a value cannot close the literal (SINGLE_LOCAL path)', async () => {
    const payloads = [`x' OR '1'='1`, `x'; DROP TABLE "${A.schema}".sentinel; --`, `' UNION SELECT v FROM "${V.schema}".victim --`, `\\'; DROP TABLE x; --`];
    for (const v of payloads) {
      const r = await run({ type: 'SELECT', limit: 5, query: { from: { resource: 'orders' }, where: [{ column: 'v', operator: 'EQ', value: v }] } });
      expect(r.status).toBe(200);
      expect(r.body.data).toEqual([]);          // matched literally -> no rows (not "all rows")
      const r2 = await run({ type: 'SELECT', limit: 5, query: { from: { resource: 'orders' }, where: [{ search: { column: 'v', query: v } }] } });
      expect(r2.status).toBeLessThan(500);
      expect(JSON.stringify(r2.body)).not.toContain('VICTIM-SECRET');
    }
    await intact();
    // and a value with a legitimate apostrophe still works
    await pool.query(`INSERT INTO "${A.schema}"."orders" (v) VALUES ('O''Brien')`);
    const ok = await run({ type: 'SELECT', limit: 5, query: { from: { resource: 'orders' }, where: [{ column: 'v', operator: 'EQ', value: "O'Brien" }] } });
    expect(ok.status).toBe(200);
    expect(ok.body.data.map((x: any) => x.v)).toEqual(["O'Brien"]);
  });

  it('legacy config: select / groupBy / orderBy / joins / limit / column types / view / index / CTE refuse injected text', async () => {
    const cfgs: any[] = [];
    for (const p of POISON(A)) {
      cfgs.push(
        { type: 'SELECT', table: 'orders', select: [p], limit: 5 },
        { type: 'SELECT', table: 'orders', select: ['id'], groupBy: [p], limit: 5 },
        { type: 'SELECT', table: 'orders', select: ['id'], orderBy: [{ field: p, dir: 'ASC' }], limit: 5 },
        { type: 'SELECT', table: 'orders', select: ['id'], joins: [{ type: 'INNER', table: 'orders', on: p }], limit: 5 },
        { type: 'SELECT', table: 'orders', select: ['id'], limit: p },
        { type: 'SELECT', table: 'orders', select: ['id'], limit: 5, offset: p },
        { type: 'CREATE_TABLE', table: 'nt', schemaDef: { columns: [{ name: 'id', type: p }] } },
        { type: 'CREATE_TABLE', table: 'nt', schemaDef: { columns: [{ name: 'id', type: 'int', constraints: p }] } },
        { type: 'ALTER_TABLE', table: 'orders', alterDef: { action: 'ADD_COLUMN', columnName: 'c', columnType: p } },
        { type: 'CREATE_VIEW', table: 'orders', viewDef: { name: 'vw', query: p } },
        { type: 'CREATE_INDEX', table: 'orders', indexDef: { name: 'ix', columns: [p] } },
        { type: 'CREATE_SEQUENCE', table: 'orders', sequenceDef: { name: 'sq', start: p } },
        { type: 'SELECT', table: 'cte', withRecursive: { name: 'cte', baseQuery: p, recursiveQuery: 'SELECT 1' }, select: ['*'], limit: 5 },
      );
    }
    for (const cfg of cfgs) {
      const r = await run(cfg);
      expect(r.status).toBeGreaterThanOrEqual(400);
      expect(r.status).toBeLessThan(500);
    }
    await intact();
  });

  it('legacy config: column / table / index names with quotes are quoted, not interpreted', async () => {
    const r = await run({ type: 'INSERT', table: 'orders', data: { 'v"; DROP TABLE sentinel; --': 'x' } });
    expect(r.status).toBeGreaterThanOrEqual(400); // no such column "v""; DROP..." -> plain error, not an executed statement
    await intact();
  });

  it('data API: bad resource / schema / where / data names are refused or inert (incl. the record-limit COUNT path)', async () => {
    for (const body of [
      { resource: `orders; DROP TABLE "${A.schema}".sentinel; --`, data: { v: 'x' } },
      { resource: `orders" CASCADE; --`, data: { v: 'x' } },
      { resource: 'orders', schema: `x"; DROP TABLE "${A.schema}".sentinel; --`, data: { v: 'x' } },
      { resource: 'orders', data: { [`v"; DROP TABLE "${A.schema}".sentinel; --`]: 'x' } },
    ]) {
      const r = await request(app).post('/api/data/create').set(auth(A.member.token)).send(body);
      expect({ body, status: r.status, err: r.body.error }).toEqual(expect.objectContaining({ status: expect.any(Number) }));
      expect(r.status).toBeLessThan(500);
    }
    for (const where of [{ [`id"; DROP TABLE "${A.schema}".sentinel; --`]: 1 }, { 'id; DROP': 1 }]) {
      const r = await request(app).post('/api/data/fetch').set(auth(A.member.token)).send({ resource: 'orders', where });
      expect(r.status).toBe(400);
    }
    await intact();
  });
});
