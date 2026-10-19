/**
 * CRUD under concurrency, large batches and plan / licence limits (T2).
 */
import '../tenancy/env';
import {
  app, request, bearer, mkWorkspace, seedCrm, CRM, data, purge, pool, setOverrides, signLicense, adminToken, adminFor, WS,
} from '../t2/kit';

jest.setTimeout(180000);

describe('CRUD: concurrency, large batches, limits', () => {
  let ws: WS; let o: string; let m: string;
  const count = async (table = 'items', where = '') => (await pool.query(`SELECT count(*)::int AS n FROM "${ws.schema(CRM)}"."${table}" ${where}`)).rows[0].n as number;
  const create = (d: any, t = m, resource = 'items') => data(t, 'create', { schema: CRM, resource, data: d });

  beforeAll(async () => { ws = await mkWorkspace('crudcc'); o = ws.owner.token; m = ws.member.token; await seedCrm(ws); });
  afterAll(async () => { await request(app).delete('/api/system/license').set(bearer(adminToken())); await purge(ws.tenantId); });

  describe('concurrency', () => {
    it('10 concurrent sequence allocations return 10 distinct consecutive values (a consistent counter)', async () => {
      const rs = await Promise.all(Array.from({ length: 10 }, () => data(m, 'sequence', { name: 'ctr' })));
      expect(rs.every((r) => r.status === 200)).toBe(true);
      const vals = rs.map((r) => r.body.value as number).sort((a, b) => a - b);
      expect(vals).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
      const next = await data(m, 'sequence', { name: 'ctr' });
      expect(next.body.value).toBe(11);
    });
    it('concurrent block allocations never overlap', async () => {
      const rs = await Promise.all(Array.from({ length: 8 }, () => data(m, 'sequence', { name: 'blk', count: 5 })));
      const all = rs.flatMap((r) => r.body.values as number[]);
      expect(all.length).toBe(40);
      expect(new Set(all).size).toBe(40);
      expect(Math.max(...all) - Math.min(...all)).toBe(39);
    });
    it('20 concurrent inserts all succeed with distinct serial ids', async () => {
      const rs = await Promise.all(Array.from({ length: 20 }, (_, i) => create({ sku: `CC-${i}`, qty: i })));
      expect(rs.map((r) => r.status)).toEqual(Array(20).fill(200));
      const ids = rs.map((r) => r.body.returning[0].id);
      expect(new Set(ids).size).toBe(20);
      expect(await count('items', `WHERE sku LIKE 'CC-%'`)).toBe(20);
    });
    it('concurrent inserts of the SAME primary key: exactly one wins, the rest are 409', async () => {
      const rs = await Promise.all(Array.from({ length: 10 }, (_, i) => create({ id: 500, name: `racer-${i}` }, m, 'parents')));
      const codes = rs.map((r) => r.status).sort();
      expect(codes.filter((c) => c === 200).length).toBe(1);
      expect(codes.filter((c) => c === 409).length).toBe(9);
      expect(await count('parents', 'WHERE id = 500')).toBe(1);
    });
    it('10 concurrent updates of one row all succeed and leave exactly one of the written values', async () => {
      await create({ id: 1, n: 0 }, m, 'counters');
      const rs = await Promise.all(Array.from({ length: 10 }, (_, i) => data(m, 'update', { schema: CRM, resource: 'counters', where: { id: 1 }, data: { n: i + 1 } })));
      expect(rs.map((r) => r.status)).toEqual(Array(10).fill(200));
      expect(rs.every((r) => r.body.rowCount === 1)).toBe(true);
      const final = (await pool.query(`SELECT n FROM "${ws.schema(CRM)}"."counters" WHERE id = 1`)).rows[0].n;
      expect(final).toBeGreaterThanOrEqual(1); expect(final).toBeLessThanOrEqual(10);
    });
    it('concurrent updates of DIFFERENT rows each land (no lost updates)', async () => {
      await create(Array.from({ length: 10 }, (_, i) => ({ id: 100 + i, n: 0 })), m, 'counters');
      const rs = await Promise.all(Array.from({ length: 10 }, (_, i) => data(m, 'update', { schema: CRM, resource: 'counters', where: { id: 100 + i }, data: { n: (i + 1) * 10 } })));
      expect(rs.every((r) => r.status === 200 && r.body.rowCount === 1)).toBe(true);
      const got = (await pool.query(`SELECT id, n FROM "${ws.schema(CRM)}"."counters" WHERE id >= 100 ORDER BY id`)).rows.map((r) => r.n);
      expect(got).toEqual([10, 20, 30, 40, 50, 60, 70, 80, 90, 100]);
    });
    it('concurrent update + delete + fetch of the same rows: no 5xx, no deadlock, consistent end state', async () => {
      await create(Array.from({ length: 10 }, (_, i) => ({ sku: `RW-${i}`, qty: 1 })));
      const ops = Array.from({ length: 30 }, (_, i) => {
        const k = i % 10;
        if (i % 3 === 0) return data(m, 'update', { schema: CRM, resource: 'items', where: { sku: `RW-${k}` }, data: { qty: i } });
        if (i % 3 === 1) return data(m, 'delete', { schema: CRM, resource: 'items', where: { sku: `RW-${k}` } });
        return data(m, 'fetch', { schema: CRM, resource: 'items', where: { sku: `RW-${k}` } });
      });
      const rs = await Promise.all(ops);
      expect(rs.every((r) => r.status === 200)).toBe(true);
      expect(await count('items', `WHERE sku LIKE 'RW-%'`)).toBeLessThanOrEqual(10);
    });
    it('concurrent bulk inserts from owner and member into one table', async () => {
      const batch = (p: string) => Array.from({ length: 100 }, (_, i) => ({ sku: `${p}-${i}` }));
      const rs = await Promise.all([create(batch('BA'), o), create(batch('BB'), m), create(batch('BC'), o), create(batch('BD'), m)]);
      expect(rs.every((r) => r.status === 200 && r.body.rowCount === 100)).toBe(true);
      expect(await count('items', `WHERE sku ~ '^B[A-D]-'`)).toBe(400);
    });
  });

  describe('large batches', () => {
    it('inserts 1000 rows in one request, reads them back with pagination and aggregates', async () => {
      const rows = Array.from({ length: 1000 }, (_, i) => ({ sku: `BIG-${i}`, qty: i % 7 }));
      const t0 = Date.now();
      const r = await create(rows);
      expect(r.status).toBe(200); expect(r.body.rowCount).toBe(1000);
      expect(Date.now() - t0).toBeLessThan(15_000);
      expect(await count('items', `WHERE sku LIKE 'BIG-%'`)).toBe(1000);
      const page = await data(m, 'fetch', { schema: CRM, resource: 'items', where: { sku: { $like: 'BIG-%' } }, orderBy: [{ column: 'id', direction: 'ASC' }], limit: 250, offset: 750 });
      expect(page.body.rowCount).toBe(250);
      const agg = await request(app).post('/api/analytics/query').set(bearer(m)).send({ queryConfig: { type: 'SELECT', schema: CRM, query: { from: { resource: 'items' }, select: [{ aggregate: 'COUNT', alias: 'n' }, { aggregate: 'SUM', column: 'qty', alias: 's' }], where: [{ column: 'sku', operator: 'LIKE', value: 'BIG-%' }] } } });
      expect(Number(agg.body.data[0].n)).toBe(1000);
      expect(Number(agg.body.data[0].s)).toBe(rows.reduce((a, x) => a + x.qty, 0));
    });
    it('updates and deletes 1000 rows with one filter', async () => {
      const u = await data(m, 'update', { schema: CRM, resource: 'items', where: { sku: { $like: 'BIG-%' } }, data: { status: 'BULK' } });
      expect(u.status).toBe(200); expect(u.body.rowCount).toBe(1000);
      const d = await data(m, 'delete', { schema: CRM, resource: 'items', where: { status: 'BULK' } });
      expect(d.body.rowCount).toBe(1000);
      expect(await count('items', `WHERE sku LIKE 'BIG-%'`)).toBe(0);
    });
    it('a batch past the JSON body limit is a 413 and inserts nothing', async () => {
      const rows = Array.from({ length: 4000 }, (_, i) => ({ sku: `HUGE-${i}`, status: 'x'.repeat(10) }));
      const r = await create(rows);
      expect(r.status).toBe(413);
      expect(await count('items', `WHERE sku LIKE 'HUGE-%'`)).toBe(0);
    });
  });

  describe('max_records_per_table (plan override / licence ceiling)', () => {
    beforeAll(async () => { await pool.query(`TRUNCATE "${ws.schema(CRM)}"."counters"`); });
    afterAll(async () => { await setOverrides(ws.tenantId); });

    it('inserts up to the limit pass; one more is 403 PLAN_LIMIT_REACHED and nothing is stored', async () => {
      await setOverrides(ws.tenantId, { max_records_per_table: 5 });
      expect((await create([{ id: 1 }, { id: 2 }, { id: 3 }], m, 'counters')).status).toBe(200);
      expect((await create([{ id: 4 }, { id: 5 }], m, 'counters')).status).toBe(200);
      const over = await create({ id: 6 }, m, 'counters');
      expect(over.status).toBe(403);
      expect(over.body.code).toBe('PLAN_LIMIT_REACHED');
      expect(over.body.error).toMatch(/Plan limit exceeded/);
      expect(await count('counters')).toBe(5);
    });
    it('a batch that would cross the limit is refused as a whole', async () => {
      await pool.query(`DELETE FROM "${ws.schema(CRM)}"."counters" WHERE id > 3`);
      const r = await create([{ id: 10 }, { id: 11 }, { id: 12 }], m, 'counters');
      expect(r.status).toBe(403); expect(r.body.code).toBe('PLAN_LIMIT_REACHED');
      expect(await count('counters')).toBe(3);
      expect((await create([{ id: 10 }, { id: 11 }], m, 'counters')).status).toBe(200);
    });
    it('updates and deletes are still allowed at the limit; deleting frees room', async () => {
      expect((await data(m, 'update', { schema: CRM, resource: 'counters', where: { id: 1 }, data: { n: 9 } })).status).toBe(200);
      expect((await data(m, 'delete', { schema: CRM, resource: 'counters', where: { id: 10 } })).status).toBe(200);
      expect((await create({ id: 20 }, m, 'counters')).status).toBe(200);
      expect((await create({ id: 21 }, m, 'counters')).status).toBe(403);
    });
    it('the limit is per table (another table is unaffected) and per workspace', async () => {
      expect((await create({ id: 900, name: 'x' }, m, 'parents')).status).toBe(200);
      const other = await mkWorkspace('crudccb');
      try {
        await seedCrm(other);
        expect((await create([{ id: 1 }, { id: 2 }, { id: 3 }, { id: 4 }, { id: 5 }, { id: 6 }, { id: 7 }], other.member.token, 'counters')).status).toBe(200);
      } finally { await purge(other.tenantId); }
    });
    it('a platform admin session bypasses the plan limit', async () => {
      const r = await request(app).post('/api/data/create').set(bearer(adminFor(ws.tenantId))).send({ schema: CRM, resource: 'counters', data: { id: 777 } });
      expect(r.status).toBe(200);
    });
    it('-1 means unlimited again', async () => {
      await setOverrides(ws.tenantId, { max_records_per_table: -1 });
      expect((await create(Array.from({ length: 30 }, (_, i) => ({ id: 2000 + i })), m, 'counters')).status).toBe(200);
    });
    it('an installed licence lowers the ceiling for every workspace (min of plan and licence)', async () => {
      const lic = await request(app).post('/api/system/license').set(bearer(adminToken())).send({ licenseKey: signLicense({ limits: { max_records_per_table: 3 } }) });
      expect(lic.status).toBe(201);
      try {
        const r = await create({ id: 3000 }, m, 'counters');
        expect(r.status).toBe(403); expect(r.body.code).toBe('PLAN_LIMIT_REACHED');
      } finally { await request(app).delete('/api/system/license').set(bearer(adminToken())); }
      expect((await create({ id: 3001 }, m, 'counters')).status).toBe(200);
    });
    it('the limit counts rows of the table, not rows created by the caller', async () => {
      await setOverrides(ws.tenantId, { max_records_per_table: await count('counters') });
      expect((await create({ id: 4000 }, o, 'counters')).status).toBe(403);
      expect((await create({ id: 4001 }, m, 'counters')).status).toBe(403);
    });
  });
});
