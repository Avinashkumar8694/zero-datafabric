/**
 * CRUD constraint violations (T2): PK / unique / FK / not-null / check / enum / type / length / range errors come back
 * as 4xx with a symbolic code and the Postgres message (constraint name + detail), never as a 500, and failed batches
 * leave nothing behind.
 */
import '../tenancy/env';
import { mkWorkspace, seedCrm, CRM, data, purge, pool, WS } from '../t2/kit';

jest.setTimeout(120000);

describe('CRUD: constraint violations', () => {
  let ws: WS; let m: string;
  const rowsIn = async (table: string, where = '') => (await pool.query(`SELECT count(*)::int AS n FROM "${ws.schema(CRM)}"."${table}" ${where}`)).rows[0].n as number;
  const create = (resource: string, d: any) => data(m, 'create', { schema: CRM, resource, data: d });
  const update = (resource: string, where: any, d: any) => data(m, 'update', { schema: CRM, resource, where, data: d });
  const del = (resource: string, where: any) => data(m, 'delete', { schema: CRM, resource, where });

  beforeAll(async () => { ws = await mkWorkspace('crudcon'); m = ws.member.token; await seedCrm(ws); });
  afterAll(async () => { await purge(ws.tenantId); });

  it('primary key duplicate -> 409 UNIQUE_VIOLATION naming the constraint and the key', async () => {
    expect((await create('parents', { id: 1, name: 'a' })).status).toBe(200);
    const r = await create('parents', { id: 1, name: 'b' });
    expect(r.status).toBe(409);
    expect(r.body).toMatchObject({ code: 'UNIQUE_VIOLATION', constraint: 'parents_pkey' });
    expect(r.body.error).toMatch(/duplicate key/);
    expect(r.body.detail).toMatch(/\(id\)=\(1\)/);
    expect(await rowsIn('parents')).toBe(1);
  });
  it('unique column duplicate -> 409 (also within one batch)', async () => {
    await create('items', { sku: 'UQ-1' });
    const a = await create('items', { sku: 'UQ-1' });
    expect(a.status).toBe(409); expect(a.body.constraint).toBe('items_sku_key');
    const b = await create('items', [{ sku: 'UQ-2' }, { sku: 'UQ-2' }]);
    expect(b.status).toBe(409);
    expect(await rowsIn('items', `WHERE sku = 'UQ-2'`)).toBe(0);
  });
  it('update that collides with a unique value -> 409 and the row is unchanged', async () => {
    await create('items', [{ sku: 'UQ-3', qty: 3 }, { sku: 'UQ-4', qty: 4 }]);
    const r = await update('items', { sku: 'UQ-4' }, { sku: 'UQ-3' });
    expect(r.status).toBe(409);
    expect(await rowsIn('items', `WHERE sku = 'UQ-4' AND qty = 4`)).toBe(1);
  });
  it('not-null: explicit null and omitted -> 400 NOT_NULL_VIOLATION', async () => {
    for (const d of [{ sku: null }, { qty: 5 }, [{ sku: 'NN-1' }, { sku: null }]]) {
      const r = await create('items', d);
      expect([JSON.stringify(d), r.status, r.body.code]).toEqual([JSON.stringify(d), 400, 'NOT_NULL_VIOLATION']);
    }
    expect(await rowsIn('items', `WHERE sku = 'NN-1'`)).toBe(0);
    const u = await update('items', { sku: 'UQ-3' }, { sku: null });
    expect(u.status).toBe(400); expect(u.body.code).toBe('NOT_NULL_VIOLATION');
  });
  it('check constraint -> 400 CHECK_VIOLATION naming the constraint (insert and update)', async () => {
    const a = await create('items', { sku: 'CK-1', qty: -1 });
    expect(a.status).toBe(400); expect(a.body).toMatchObject({ code: 'CHECK_VIOLATION', constraint: 'chk_qty_nonneg' });
    const b = await update('items', { sku: 'UQ-3' }, { qty: -5 });
    expect(b.status).toBe(400); expect(b.body.code).toBe('CHECK_VIOLATION');
    expect(await rowsIn('items', `WHERE sku = 'UQ-3' AND qty = 3`)).toBe(1);
  });
  it('foreign key: child -> missing parent (insert and update) and parent delete while referenced -> 409', async () => {
    await create('parents', { id: 10, name: 'p10' });
    expect((await create('children', { id: 1, parent_id: 10, label: 'c' })).status).toBe(200);
    const a = await create('children', { id: 2, parent_id: 999, label: 'orphan' });
    expect(a.status).toBe(409); expect(a.body).toMatchObject({ code: 'FOREIGN_KEY_VIOLATION', constraint: 'fk_rel_parent_children' });
    expect(a.body.detail).toMatch(/999/);
    const b = await update('children', { id: 1 }, { parent_id: 998 });
    expect(b.status).toBe(409);
    const c = await del('parents', { id: 10 });
    expect(c.status).toBe(409); expect(c.body.code).toBe('FOREIGN_KEY_VIOLATION');
    expect(await rowsIn('parents', 'WHERE id = 10')).toBe(1);
    expect((await del('children', { id: 1 })).status).toBe(200);
    expect((await del('parents', { id: 10 })).status).toBe(200);
  });
  it('a NULL foreign key is allowed (no parent)', async () => {
    const r = await create('children', { id: 3, parent_id: null, label: 'free' });
    expect(r.status).toBe(200);
  });
  it('enum / type / length / range errors -> 400 INVALID_VALUE with the offending value in the message', async () => {
    const cases: Array<[any, RegExp]> = [
      [{ sku: 'V-1', plan: 'GOLD' }, /enum/],
      [{ sku: 'V-2', qty: 'abc' }, /integer/],
      [{ sku: 'V-3', qty: 99999999999 }, /out of range/],
      [{ sku: 'V-4', status: 'x'.repeat(13) }, /too long|character varying/],
      [{ sku: 'V-5', price: 1e12 }, /numeric field overflow|out of range/],
      [{ sku: 'V-6', born: '2024-02-30' }, /date/],
      [{ sku: 'V-7', active: 'maybe' }, /boolean/],
      [{ sku: 'V-8', meta: '{not json' }, /json/],
      [{ sku: 'V-9', big: 'NaN' }, /bigint|integer/],
    ];
    for (const [d, re] of cases) {
      const r = await create('items', d);
      expect([JSON.stringify(d), r.status, r.body.code]).toEqual([JSON.stringify(d), 400, 'INVALID_VALUE']);
      expect(r.body.error).toMatch(re);
    }
    expect(await rowsIn('items', `WHERE sku LIKE 'V-%'`)).toBe(0);
  });
  it('VARCHAR(n) lengths declared in the manifest are enforced (STRING + length)', async () => {
    const col = await pool.query(`SELECT character_maximum_length FROM information_schema.columns WHERE table_schema = $1 AND table_name = 'items' AND column_name = 'sku'`, [ws.schema(CRM)]);
    expect(col.rows[0].character_maximum_length).toBe(20);
    const r = await create('items', { sku: 'L'.repeat(21) });
    expect(r.status).toBe(400);
    expect((await create('items', { sku: 'L'.repeat(20) })).status).toBe(200);
  });
  it('a failing row anywhere in a batch rolls the whole batch back', async () => {
    const before = await rowsIn('items');
    const r = await create('items', [{ sku: 'AT-1' }, { sku: 'AT-2' }, { sku: 'AT-3', qty: -1 }, { sku: 'AT-4' }]);
    expect(r.status).toBe(400);
    expect(await rowsIn('items')).toBe(before);
    const dup = await create('items', [{ sku: 'AT-5' }, { sku: 'UQ-1' }]);
    expect(dup.status).toBe(409);
    expect(await rowsIn('items', `WHERE sku = 'AT-5'`)).toBe(0);
  });
  it('a multi-row update that violates a constraint on one row changes none', async () => {
    await create('items', [{ sku: 'MU-1', qty: 1 }, { sku: 'MU-2', qty: 1 }]);
    const r = await update('items', { sku: { $in: ['MU-1', 'MU-2'] } }, { sku: 'MU-same' });
    expect(r.status).toBe(409);
    expect(await rowsIn('items', `WHERE sku IN ('MU-1','MU-2')`)).toBe(2);
  });
  it('error responses are clean: no stack traces, only error / code / detail / constraint', async () => {
    for (const r of [await create('items', { sku: 'UQ-1' }), await create('items', { sku: null }), await create('items', { sku: 'z', qty: -1 }), await create('children', { id: 77, parent_id: 5000 })]) {
      expect(Object.keys(r.body).sort().every((k) => ['error', 'code', 'detail', 'constraint'].includes(k))).toBe(true);
      expect(JSON.stringify(r.body)).not.toMatch(/at \w+ \(|node_modules|\.ts:\d+/);
    }
  });
  it('a failed write is still audited in the query log with status ERROR', async () => {
    await create('items', { sku: 'UQ-1' });
    const { rows } = await pool.query(`SELECT status, error, mode FROM fabric_system.query_logs WHERE tenant_id = $1 AND mode = 'CRUD_CREATE' AND status <> 'SUCCESS' ORDER BY created_at DESC LIMIT 1`, [ws.tenantId]);
    expect(rows[0]).toMatchObject({ mode: 'CRUD_CREATE' });
    expect(rows[0].status).toMatch(/ERROR|FAIL/i);
  });
});
