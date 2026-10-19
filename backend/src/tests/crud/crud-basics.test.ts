/**
 * /api/data create / fetch / update / delete against hub tables from a manifest (T2): single + bulk insert, RETURNING,
 * defaults and serials, filters, pagination, safety rules, and the JSON / array / date / numeric / unicode column types.
 */
import '../tenancy/env';
import { mkWorkspace, seedCrm, CRM, data, purge, pool, WS } from '../t2/kit';

jest.setTimeout(120000);

describe('CRUD: basics', () => {
  let ws: WS; let o: string; let m: string;
  const create = (body: any, t = m, resource = 'items') => data(t, 'create', { schema: CRM, resource, ...body });
  const fetch = (body: any = {}, t = m, resource = 'items') => data(t, 'fetch', { schema: CRM, resource, ...body });
  const update = (body: any, t = m, resource = 'items') => data(t, 'update', { schema: CRM, resource, ...body });
  const del = (body: any, t = m, resource = 'items') => data(t, 'delete', { schema: CRM, resource, ...body });
  const skus = (r: any) => (r.body.data as any[]).map((x) => x.sku);

  beforeAll(async () => { ws = await mkWorkspace('crud'); o = ws.owner.token; m = ws.member.token; await seedCrm(ws); });
  afterAll(async () => { await purge(ws.tenantId); });

  describe('create', () => {
    it('single insert returns the stored row with serial id and column defaults', async () => {
      const r = await create({ data: { sku: 'S-1' } });
      expect(r.status).toBe(200);
      expect(r.body).toMatchObject({ status: 'SUCCESS', rowCount: 1 });
      const row = r.body.returning[0];
      expect(row).toMatchObject({ sku: 'S-1', qty: 0, status: 'NEW', active: true, price: null, tags: null, meta: null });
      expect(typeof row.id).toBe('number');
      // TIMESTAMP (no zone) is parsed in the server's local zone, so allow for the offset when comparing with now
      expect(Math.abs(new Date(row.created_at).getTime() - Date.now())).toBeLessThan(15 * 3600_000);
    });
    it('serial ids are assigned in order and never reused', async () => {
      const a = await create({ data: { sku: 'S-2' } }); const b = await create({ data: { sku: 'S-3' } });
      expect(b.body.returning[0].id).toBeGreaterThan(a.body.returning[0].id);
    });
    it('bulk insert returns every row in input order', async () => {
      const r = await create({ data: [{ sku: 'B-1', qty: 1 }, { sku: 'B-2', qty: 2 }, { sku: 'B-3', qty: 3 }] });
      expect(r.status).toBe(200); expect(r.body.rowCount).toBe(3);
      expect(r.body.returning.map((x: any) => x.sku)).toEqual(['B-1', 'B-2', 'B-3']);
    });
    it('rows with different key sets: a missing key takes the column DEFAULT, extra keys on later rows are kept', async () => {
      const r = await create({ data: [{ sku: 'M-1', qty: 7 }, { sku: 'M-2', price: 9.5, status: 'HOT' }, { sku: 'M-3' }] });
      expect(r.status).toBe(200);
      const [a, b, c] = r.body.returning;
      expect([a.qty, a.status, a.price]).toEqual([7, 'NEW', null]);
      expect([b.qty, b.status, b.price]).toEqual([0, 'HOT', '9.50']);
      expect([c.qty, c.status, c.price]).toEqual([0, 'NEW', null]);
    });
    it('an explicit null overrides a default; an omitted key does not', async () => {
      const r = await create({ data: { sku: 'N-1', status: null, price: null } });
      expect(r.body.returning[0].status).toBeNull();
    });
    it('empty / scalar / malformed data is a 400 with a clear message', async () => {
      for (const d of [[], 5, 'x', [1, 2], [null], {}, [{}]]) {
        const r = await create({ data: d });
        expect([JSON.stringify(d), r.status]).toEqual([JSON.stringify(d), 400]);
        expect(r.body.error).toEqual(expect.any(String));
      }
      expect((await create({})).status).toBe(400);
    });
    it('missing / invalid resource is 400/404, never 500', async () => {
      expect((await data(m, 'create', { schema: CRM, data: { a: 1 } })).status).toBe(400);
      expect((await create({ data: { sku: 'x' } }, m, 'ghost_table')).status).toBe(404);
      for (const resource of ['items; DROP TABLE items', 'it"ems', '', 'a b', '../items', 7 as any]) {
        const r = await create({ data: { sku: 'x' } }, m, resource);
        expect(r.status).toBeGreaterThanOrEqual(400); expect(r.status).toBeLessThan(500);
      }
    });
    it('column names with injection payloads are rejected before any SQL runs', async () => {
      for (const key of ['sku"; DROP TABLE items; --', 'sku) VALUES (1); DROP TABLE items; --', 'a b', 'x.y', '$where', 'sku\u0000']) {
        const r = await create({ data: { [key]: 'v' } });
        expect([key, r.status]).toEqual([key, 400]);
      }
      expect((await fetch({ limit: 1 })).status).toBe(200);
    });
    it('values with quotes / backslashes / NUL: stored verbatim or refused, never interpreted', async () => {
      const weird = `O'Brien \\ "quoted"; DROP TABLE items; --`;
      const r = await create({ data: { sku: 'W-1', status: weird.slice(0, 11) } });
      expect(r.status).toBe(200);
      const long = await create({ data: { sku: 'W-2', meta: { note: weird } } });
      expect(long.body.returning[0].meta).toEqual({ note: weird });
      const nul = await create({ data: { sku: 'W-3', status: 'a\u0000b' } });
      expect(nul.status).toBeGreaterThanOrEqual(400); expect(nul.status).toBeLessThan(500);
    });
  });

  describe('typed columns round-trip', () => {
    it('numeric stays exact (string), bigint beyond 2^53 is exact (string), dates and timestamps ISO', async () => {
      const r = await create({ data: { sku: 'T-1', price: '12345678.99', big: '9007199254740993', born: '2024-02-29', created_at: '2024-02-29T12:34:56.789Z' } });
      expect(r.status).toBe(200);
      const row = r.body.returning[0];
      expect(row.price).toBe('12345678.99');
      expect(String(row.big)).toBe('9007199254740993');
      expect(new Date(row.created_at).getUTCFullYear()).toBe(2024);
      expect(new Date(row.created_at).getUTCMonth()).toBe(1);
      expect(String(row.born)).toMatch(/^2024-02-(28|29)/); // DATE is returned as a JS Date in the server timezone
    });
    it('jsonb: objects, arrays, nested, unicode, null and scalars', async () => {
      const docs = [{ a: 1, b: { c: [1, 2, { d: null }] } }, [1, 'two', { three: 3 }], { 'ключ': '值 🚀' }, {}, []];
      for (const [i, meta] of docs.entries()) {
        const r = await create({ data: { sku: `J-${i}`, meta } });
        expect(r.status).toBe(200);
        expect(r.body.returning[0].meta).toEqual(meta);
      }
      const nul = await create({ data: { sku: 'J-null', meta: null } });
      expect(nul.body.returning[0].meta).toBeNull();
    });
    it('text[] arrays: values, empty, special characters', async () => {
      const r = await create({ data: [{ sku: 'A-1', tags: ['a', 'b'] }, { sku: 'A-2', tags: [] }, { sku: 'A-3', tags: ['with "quote"', "it's", 'a,b', '{x}'] }] });
      expect(r.status).toBe(200);
      expect(r.body.returning.map((x: any) => x.tags)).toEqual([['a', 'b'], [], ['with "quote"', "it's", 'a,b', '{x}']]);
    });
    it('booleans, enums and unicode / emoji text', async () => {
      const r = await create({ data: [{ sku: 'U-1', active: false, plan: 'PRO', status: 'ÆØÅ ✓' }, { sku: 'U-😀', plan: 'TEAM' }] });
      expect(r.status).toBe(200);
      expect(r.body.returning[0]).toMatchObject({ active: false, plan: 'PRO', status: 'ÆØÅ ✓' });
      const f = await fetch({ where: { sku: 'U-😀' } });
      expect(f.body.data.map((x: any) => x.plan)).toEqual(['TEAM']);
    });
    it('values sent as strings are coerced by the column type; wrong types are 400', async () => {
      const ok = await create({ data: { sku: 'C-1', qty: '42', active: 'false', price: '1.5', born: '2020-01-01' } });
      expect(ok.status).toBe(200); expect(ok.body.returning[0]).toMatchObject({ qty: 42, active: false, price: '1.50' });
      for (const [k, v] of [['qty', 'x'], ['active', 'perhaps'], ['born', 'not-a-date'], ['price', 'NaNx'], ['qty', 1.5]] as const) {
        const r = await create({ data: { sku: `C-bad-${k}`, [k]: v } });
        expect([k, v, r.status]).toEqual([k, v, 400]);
      }
    });
    it('a 100 KB text value is stored; larger request bodies are 413', async () => {
      const big = 'z'.repeat(60_000);
      const ok = await create({ data: { sku: 'L-1', meta: { big } } });
      expect(ok.status).toBe(200);
      const r = await create({ data: { sku: 'L-2', meta: { big: 'z'.repeat(150_000) } } });
      expect(r.status).toBe(413);
    });
  });

  describe('fetch: columns, filters, order, pagination', () => {
    beforeAll(async () => {
      await create({ data: Array.from({ length: 12 }, (_, i) => ({ sku: `P-${String(i + 1).padStart(2, '0')}`, qty: i, price: i * 1.5, status: i % 2 ? 'ODD' : 'EVEN', tags: i % 3 === 0 ? ['t'] : null })) });
    });
    const p = (extra: any = {}) => fetch({ where: { sku: { $like: 'P-%' } }, orderBy: [{ column: 'sku', direction: 'ASC' }], ...extra });
    it('where-map operators', async () => {
      expect(skus(await fetch({ where: { sku: 'P-03' } }))).toEqual(['P-03']);
      expect(skus(await fetch({ where: { sku: { $eq: 'P-03' } } }))).toEqual(['P-03']);
      expect((await p({ where: { sku: { $like: 'P-%' }, qty: { $ne: 0 } } })).body.rowCount).toBe(11);
      expect(skus(await p({ where: { sku: { $like: 'P-%' }, qty: { $gt: 9 } } }))).toEqual(['P-11', 'P-12']);
      expect(skus(await p({ where: { sku: { $like: 'P-%' }, qty: { $gte: 10 } } }))).toEqual(['P-11', 'P-12']);
      expect(skus(await p({ where: { sku: { $like: 'P-%' }, qty: { $lt: 2 } } }))).toEqual(['P-01', 'P-02']);
      expect(skus(await p({ where: { sku: { $like: 'P-%' }, qty: { $lte: 1 } } }))).toEqual(['P-01', 'P-02']);
      expect(skus(await p({ where: { sku: { $in: ['P-01', 'P-12', 'nope'] } } }))).toEqual(['P-01', 'P-12']);
      expect(skus(await fetch({ where: { sku: { $ilike: 'p-0_' } }, orderBy: [{ column: 'sku', direction: 'ASC' }] })).length).toBe(9);
      expect((await fetch({ where: { sku: { $like: 'p-0_' } } })).body.rowCount).toBe(0); // $like is case sensitive on reads
    });
    it('IS NULL via { col: null }; empty $in matches nothing', async () => {
      const nulls = await p({ where: { sku: { $like: 'P-%' }, tags: null } });
      expect(nulls.body.rowCount).toBe(8);
      expect((await p({ where: { sku: { $in: [] } } })).body.rowCount).toBe(0);
    });
    it('columns projection and order', async () => {
      const r = await p({ columns: ['sku', 'qty'], limit: 2 });
      expect(r.body.data).toEqual([{ sku: 'P-01', qty: 0 }, { sku: 'P-02', qty: 1 }]);
    });
    it('orderBy asc / desc / multi-column', async () => {
      const d = await p({ orderBy: [{ column: 'status', direction: 'DESC' }, { column: 'sku', direction: 'DESC' }], limit: 3 });
      expect(skus(d)).toEqual(['P-12', 'P-10', 'P-08']); // 'ODD' sorts after 'EVEN'
    });
    it('limit + offset paginate without gaps or overlaps (stable order)', async () => {
      const seen: string[] = [];
      for (let off = 0; off < 14; off += 5) seen.push(...skus(await p({ limit: 5, offset: off })));
      expect(seen).toEqual(Array.from({ length: 12 }, (_, i) => `P-${String(i + 1).padStart(2, '0')}`));
    });
    it('offset past the end is an empty page; the default limit is 100', async () => {
      expect((await p({ limit: 5, offset: 500 })).body.rowCount).toBe(0);
      await create({ data: Array.from({ length: 120 }, (_, i) => ({ sku: `D-${i}` })) });
      expect((await fetch({ where: { sku: { $like: 'D-%' } } })).body.rowCount).toBe(100);
      expect((await fetch({ where: { sku: { $like: 'D-%' } }, limit: 500 })).body.rowCount).toBe(120);
    });
    it('unknown column / operator / table: 400 / 400 / 404', async () => {
      expect((await fetch({ where: { ghost: 1 } })).status).toBe(400);
      expect((await fetch({ where: { sku: { $regex: 'x' } } })).status).toBe(400);
      expect((await fetch({ columns: ['ghost'] })).status).toBe(400);
      expect((await fetch({}, m, 'ghost_table')).status).toBe(404);
    });
    it('where keys that are not plain identifiers are 400', async () => {
      for (const k of ['sku"; DROP TABLE items; --', '$where', 'a b', 'sku OR 1=1']) {
        expect([k, (await fetch({ where: { [k]: 1 } })).status]).toEqual([k, 400]);
      }
    });
    it('the response carries the plan trace', async () => {
      const r = await p({ limit: 1 });
      expect(r.body.plan.strategy).toBe('SINGLE_LOCAL');
      expect(r.body.warnings).toEqual([]);
    });
  });

  describe('update and delete', () => {
    beforeAll(async () => { await create({ data: [{ sku: 'UPD-a', qty: 1 }, { sku: 'UPD-b', qty: 2 }, { sku: 'UPD-c', qty: 3 }] }); });
    it('update returns the changed rows and honours the filter', async () => {
      const r = await update({ where: { sku: 'UPD-a' }, data: { qty: 100, status: 'DONE' } });
      expect(r.status).toBe(200); expect(r.body.rowCount).toBe(1);
      expect(r.body.returning[0]).toMatchObject({ sku: 'UPD-a', qty: 100, status: 'DONE' });
      expect((await fetch({ where: { sku: 'UPD-b' } })).body.data[0].qty).toBe(2);
    });
    it('update with operator filters changes exactly the matching rows ($gte must not degrade to equality)', async () => {
      const r = await update({ where: { sku: { $like: 'UPD-%' }, qty: { $gte: 3 } }, data: { status: 'BIG' } });
      expect(r.body.rowCount).toBe(2);
      expect(skus(await fetch({ where: { status: 'BIG' }, orderBy: [{ column: 'sku', direction: 'ASC' }] }))).toEqual(['UPD-a', 'UPD-c']);
      const lte = await update({ where: { sku: { $like: 'UPD-%' }, qty: { $lte: 2 } }, data: { status: 'SMALL' } });
      expect(lte.body.rowCount).toBe(1);
      const inn = await update({ where: { sku: { $in: ['UPD-a', 'UPD-b'] } }, data: { status: 'IN' } });
      expect(inn.body.rowCount).toBe(2);
      const none = await update({ where: { sku: { $in: [] } }, data: { status: 'NOPE' } });
      expect(none.body.rowCount).toBe(0);
    });
    it('update matching nothing is a 200 with rowCount 0', async () => {
      const r = await update({ where: { sku: 'no-such' }, data: { qty: 1 } });
      expect(r.status).toBe(200); expect(r.body.rowCount).toBe(0); expect(r.body.returning).toEqual([]);
    });
    it('update / delete without a filter are refused (400 SAFETY) and change nothing', async () => {
      const before = (await pool.query(`SELECT count(*)::int AS n FROM "${ws.schema(CRM)}"."items"`)).rows[0].n;
      for (const where of [undefined, null, {}, []]) {
        const u = await update({ ...(where === undefined ? {} : { where }), data: { qty: 0 } });
        expect([JSON.stringify(where), u.status]).toEqual([JSON.stringify(where), 400]);
        expect(u.body.error).toMatch(/^SAFETY/);
        const d = await del({ ...(where === undefined ? {} : { where }) });
        expect(d.status).toBe(400); expect(d.body.error).toMatch(/^SAFETY/);
      }
      expect((await pool.query(`SELECT count(*)::int AS n FROM "${ws.schema(CRM)}"."items"`)).rows[0].n).toBe(before);
    });
    it('update / delete refuse unsafe where keys and unknown operators', async () => {
      expect((await update({ where: { 'sku"; DROP TABLE items;--': 1 }, data: { qty: 1 } })).status).toBe(400);
      expect((await update({ where: { sku: { $regex: '.*' } }, data: { qty: 1 } })).status).toBe(400);
      expect((await del({ where: { sku: { $where: 'true' } } })).status).toBe(400);
      expect((await del({ where: { ghost: 1 } })).status).toBe(400);
    });
    it('update data validation: empty / scalar / unknown column / type error', async () => {
      for (const d of [{}, [], 'x', 5, null]) expect([JSON.stringify(d), (await update({ where: { sku: 'UPD-a' }, data: d })).status]).toEqual([JSON.stringify(d), 400]);
      expect((await update({ where: { sku: 'UPD-a' }, data: { ghost: 1 } })).status).toBe(400);
      expect((await update({ where: { sku: 'UPD-a' }, data: { qty: 'x' } })).status).toBe(400);
      expect((await update({ where: { sku: 'UPD-a' }, data: { 'qty"=1;--': 1 } })).status).toBe(400);
    });
    it('delete removes only the matching rows and returns them', async () => {
      const r = await del({ where: { sku: 'UPD-c' } });
      expect(r.status).toBe(200); expect(r.body.rowCount).toBe(1); expect(r.body.returning[0].sku).toBe('UPD-c');
      expect((await fetch({ where: { sku: 'UPD-c' } })).body.rowCount).toBe(0);
      const multi = await del({ where: { sku: { $in: ['UPD-a', 'UPD-b'] } } });
      expect(multi.body.rowCount).toBe(2);
    });
    it('deleting nothing is a 200 with rowCount 0', async () => {
      const r = await del({ where: { sku: 'already-gone' } });
      expect(r.status).toBe(200); expect(r.body.rowCount).toBe(0);
    });
    it('a hard delete is final: the engine has no soft-delete of its own', async () => {
      await create({ data: { sku: 'H-1' } });
      await del({ where: { sku: 'H-1' } });
      expect((await pool.query(`SELECT count(*)::int AS n FROM "${ws.schema(CRM)}"."items" WHERE sku = 'H-1'`)).rows[0].n).toBe(0);
    });
    it('owner and member are equally allowed to write (members query and CRUD)', async () => {
      const a = await create({ data: { sku: 'OM-1' } }, o); const b = await create({ data: { sku: 'OM-2' } }, m);
      expect([a.status, b.status]).toEqual([200, 200]);
      expect((await update({ where: { sku: 'OM-1' }, data: { qty: 9 } }, m)).body.rowCount).toBe(1);
      expect((await del({ where: { sku: { $in: ['OM-1', 'OM-2'] } } }, o)).body.rowCount).toBe(2);
    });
  });

  describe('sequence endpoint', () => {
    it('allocates a block of contiguous values and validates names', async () => {
      const a = await data(m, 'sequence', { name: 'inv_no', count: 3 });
      expect(a.status).toBe(200); expect(a.body.values).toEqual([1, 2, 3]);
      const b = await data(m, 'sequence', { name: 'inv_no' });
      expect(b.body.value).toBe(4);
      for (const name of ['bad name!', "x'; DROP TABLE y;--", '', 'a'.repeat(100), 5 as any]) {
        const r = await data(m, 'sequence', { name });
        expect(r.status).toBe(400);
      }
    });
    it('sequences are per workspace', async () => {
      const other = await mkWorkspace('crudseq');
      try {
        const r = await data(other.member.token, 'sequence', { name: 'inv_no' });
        expect(r.body.value).toBe(1);
      } finally { await purge(other.tenantId); }
    });
  });
});
