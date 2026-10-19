/**
 * The remaining AST/config types of the engine: legacy flat SELECT, INSERT / UPDATE / DELETE and the DDL config types
 * (CREATE_SCHEMA / CREATE_TABLE / ALTER_TABLE / CREATE_INDEX / CREATE_VIEW / CREATE_SEQUENCE / DROP_TABLE), all confined to
 * the caller's own `tenant_<id>[_x]` namespaces (T2).
 */
import '../tenancy/env';
import { app, request, bearer, pool, mkWorkspace, astQuery, data, purge, relationExists, WS } from '../t2/kit';

jest.setTimeout(120000);

describe('AST config types: legacy SELECT, DML and DDL', () => {
  let ws: WS; let m: string; let o: string;
  let ddlSchema = '';
  const physical = () => ddlSchema;
  const run = (cfg: any, token = m) => astQuery(token, cfg);

  beforeAll(async () => {
    ws = await mkWorkspace('astddl'); m = ws.member.token; o = ws.owner.token;
    ddlSchema = `tenant_${ws.tenantId}`; // the workspace base namespace (named namespaces are created by manifests only)
    const r = await run({ type: 'CREATE_SCHEMA' });
    if (r.status !== 200) throw new Error(`CREATE_SCHEMA failed ${r.status} ${JSON.stringify(r.body)}`);
  });
  afterAll(async () => { await purge(ws.tenantId); });

  it('CREATE_SCHEMA provisions the base namespace and is idempotent (re-running never wipes data)', async () => {
    await pool.query(`CREATE TABLE "${physical()}"."keep_me" (id int)`);
    await pool.query(`GRANT SELECT ON "${physical()}"."keep_me" TO fabric_user`);
    const again = await run({ type: 'CREATE_SCHEMA' });
    expect(again.status).toBe(200);
    expect(again.body).toMatchObject({ status: 'SUCCESS', type: 'CREATE_SCHEMA', target: `tenant_${ws.tenantId}` });
    expect(await relationExists(physical(), 'keep_me')).toBe(true);
  });

  it('a NAMED schema cannot be created by a member through the query endpoint (403, manifests do that)', async () => {
    const r = await run({ type: 'CREATE_SCHEMA', schema: 'sneaky' });
    expect(r.status).toBe(403);
    expect(await pool.query(`SELECT 1 FROM pg_namespace WHERE nspname = $1`, [ws.schema('sneaky')]).then((x) => x.rows.length)).toBe(0);
  });

  describe('table lifecycle', () => {
    it('CREATE_TABLE -> INSERT -> legacy SELECT -> UPDATE -> DELETE -> DROP_TABLE', async () => {
      const ct = await run({ type: 'CREATE_TABLE', schema: ddlSchema, table: 'people', schemaDef: { columns: [{ name: 'id', type: 'INTEGER', constraints: 'PRIMARY KEY' }, { name: 'name', type: 'TEXT' }, { name: 'age', type: 'INTEGER' }] } });
      expect(ct.status).toBe(200);
      expect(await relationExists(physical(), 'people')).toBe(true);

      const ins = await run({ type: 'INSERT', schema: ddlSchema, table: 'people', data: [{ id: 1, name: 'Ann', age: 30 }, { id: 2, name: 'Bob', age: 40 }, { id: 3, name: 'Cy', age: 50 }] });
      expect(ins.status).toBe(200);
      expect(ins.body.rowCount).toBe(3);

      const sel = await run({ type: 'SELECT', schema: ddlSchema, table: 'people', select: ['id', 'name'], filter: { age: { $gte: 40 } }, orderBy: [{ field: 'id', dir: 'ASC' }], limit: 10 });
      expect(sel.status).toBe(200);
      expect(sel.body.data).toEqual([{ id: 2, name: 'Bob' }, { id: 3, name: 'Cy' }]);

      const upd = await run({ type: 'UPDATE', schema: ddlSchema, table: 'people', data: { age: 41 }, filter: { id: 2 } });
      expect(upd.status).toBe(200); expect(upd.body.rowCount).toBe(1);
      expect(upd.body.returning[0].age).toBe(41);

      const del = await run({ type: 'DELETE', schema: ddlSchema, table: 'people', filter: { id: { $in: [1, 3] } } });
      expect(del.status).toBe(200); expect(del.body.rowCount).toBe(2);
      const left = await run({ type: 'SELECT', schema: ddlSchema, table: 'people', limit: 10 });
      expect(left.body.data.map((r: any) => r.id)).toEqual([2]);

      const drop = await run({ type: 'DROP_TABLE', schema: ddlSchema, table: 'people' });
      expect(drop.status).toBe(200);
      expect(await relationExists(physical(), 'people')).toBe(false);
    });

    it('DML filter operators: $eq $ne $gt $gte $lt $lte $like $ilike $in are all honoured; unknown operators are 400', async () => {
      await run({ type: 'CREATE_TABLE', schema: ddlSchema, table: 'ops', schemaDef: { columns: [{ name: 'id', type: 'INTEGER' }, { name: 'name', type: 'TEXT' }] } });
      await run({ type: 'INSERT', schema: ddlSchema, table: 'ops', data: [1, 2, 3, 4, 5].map((id) => ({ id, name: `n${id}` })) });
      const count = async (filter: any) => (await run({ type: 'SELECT', schema: ddlSchema, table: 'ops', filter, limit: 100 })).body.data.map((r: any) => r.id).sort();
      expect(await count({ id: { $eq: 2 } })).toEqual([2]);
      expect(await count({ id: { $ne: 2 } })).toEqual([1, 3, 4, 5]);
      expect(await count({ id: { $gt: 3 } })).toEqual([4, 5]);
      expect(await count({ id: { $gte: 3 } })).toEqual([3, 4, 5]);
      expect(await count({ id: { $lt: 3 } })).toEqual([1, 2]);
      expect(await count({ id: { $lte: 3 } })).toEqual([1, 2, 3]);
      expect(await count({ id: { $in: [2, 4] } })).toEqual([2, 4]);
      expect(await count({ name: { $ilike: 'N1' } })).toEqual([1]);
      expect(await count({ name: { $like: 'n%' } })).toEqual([1, 2, 3, 4, 5]);
      const bad = await run({ type: 'SELECT', schema: ddlSchema, table: 'ops', filter: { id: { $regex: '.*' } }, limit: 5 });
      expect(bad.status).toBe(400);
      // a $gte DELETE must not degrade into an equality delete
      const del = await run({ type: 'DELETE', schema: ddlSchema, table: 'ops', filter: { id: { $gte: 4 } } });
      expect(del.body.rowCount).toBe(2);
      expect(await count({})).toEqual([1, 2, 3]);
    });

    it('ALTER_TABLE ADD_COLUMN / DROP_COLUMN', async () => {
      await run({ type: 'CREATE_TABLE', schema: ddlSchema, table: 'alt', schemaDef: { columns: [{ name: 'id', type: 'INTEGER' }] } });
      const add = await run({ type: 'ALTER_TABLE', schema: ddlSchema, table: 'alt', alterDef: { action: 'ADD_COLUMN', columnName: 'note', columnType: 'TEXT' } });
      expect(add.status).toBe(200);
      expect((await pool.query(`SELECT column_name FROM information_schema.columns WHERE table_schema = $1 AND table_name = 'alt' ORDER BY ordinal_position`, [physical()])).rows.map((r) => r.column_name)).toEqual(['id', 'note']);
      const drop = await run({ type: 'ALTER_TABLE', schema: ddlSchema, table: 'alt', alterDef: { action: 'DROP_COLUMN', columnName: 'note' } });
      expect(drop.status).toBe(200);
      expect((await pool.query(`SELECT column_name FROM information_schema.columns WHERE table_schema = $1 AND table_name = 'alt'`, [physical()])).rows.map((r) => r.column_name)).toEqual(['id']);
    });

    it('CREATE_INDEX, CREATE_VIEW (plain and materialized) and CREATE_SEQUENCE', async () => {
      await run({ type: 'CREATE_TABLE', schema: ddlSchema, table: 'idx', schemaDef: { columns: [{ name: 'id', type: 'INTEGER' }, { name: 'v', type: 'TEXT' }] } });
      await run({ type: 'INSERT', schema: ddlSchema, table: 'idx', data: [{ id: 1, v: 'a' }, { id: 2, v: 'b' }] });
      const ix = await run({ type: 'CREATE_INDEX', schema: ddlSchema, table: 'idx', indexDef: { name: 'idx_v', columns: ['v'], unique: true } });
      expect(ix.status).toBe(200);
      expect((await pool.query(`SELECT 1 FROM pg_indexes WHERE schemaname = $1 AND indexname = 'idx_v'`, [physical()])).rows.length).toBe(1);
      const dup = await run({ type: 'INSERT', schema: ddlSchema, table: 'idx', data: { id: 3, v: 'a' } });
      expect(dup.status).toBe(409); // unique index enforced
      const vw = await run({ type: 'CREATE_VIEW', schema: ddlSchema, table: 'idx', viewDef: { name: 'v_idx', query: `SELECT id FROM "${physical()}"."idx" WHERE id > 1` } });
      expect(vw.status).toBe(200);
      const readView = await run({ type: 'SELECT', schema: ddlSchema, table: 'v_idx', limit: 5 });
      expect(readView.body.data).toEqual([{ id: 2 }]);
      const sq = await run({ type: 'CREATE_SEQUENCE', schema: ddlSchema, sequenceDef: { name: 'seq_a', start: 10, increment: 5 } });
      expect(sq.status).toBe(200);
      const seq = await pool.query(`SELECT start_value, increment_by FROM pg_sequences WHERE schemaname = $1 AND sequencename = 'seq_a'`, [physical()]);
      expect(seq.rows[0]).toMatchObject({ start_value: '10', increment_by: '5' });
    });

    it('DDL expressions are validated (identifiers, types, view bodies): no injection, no 5xx', async () => {
      const canary = 'ddl_canary';
      const policiesBefore = await relationExists('fabric_system', 'access_policies');
      await run({ type: 'CREATE_TABLE', schema: ddlSchema, table: canary, schemaDef: { columns: [{ name: 'id', type: 'INTEGER' }] } });
      const evil: any[] = [
        { type: 'CREATE_TABLE', schema: ddlSchema, table: 'x"; DROP TABLE ddl_canary; --', schemaDef: { columns: [{ name: 'id', type: 'INTEGER' }] } },
        { type: 'CREATE_TABLE', schema: ddlSchema, table: 'ok1', schemaDef: { columns: [{ name: 'id', type: 'INTEGER); DROP TABLE ddl_canary; --' }] } },
        { type: 'CREATE_TABLE', schema: ddlSchema, table: 'ok2', schemaDef: { columns: [{ name: 'id', type: 'INTEGER', constraints: 'PRIMARY KEY); DROP TABLE ddl_canary; --' }] } },
        { type: 'CREATE_VIEW', schema: ddlSchema, table: 'x', viewDef: { name: 'v1', query: 'SELECT 1; DROP TABLE ddl_canary' } },
        { type: 'CREATE_VIEW', schema: ddlSchema, table: 'x', viewDef: { name: 'v2', query: 'SELECT * FROM public.users' } },
        { type: 'CREATE_VIEW', schema: ddlSchema, table: 'x', viewDef: { name: 'v3', query: 'SELECT pg_sleep(3)' } },
        { type: 'ALTER_TABLE', schema: ddlSchema, table: canary, alterDef: { action: 'ADD_COLUMN', columnName: 'c"; DROP TABLE ddl_canary;--', columnType: 'TEXT' } },
        { type: 'ALTER_TABLE', schema: ddlSchema, table: canary, alterDef: { action: 'ADD_COLUMN', columnName: 'c', columnType: 'TEXT; DROP TABLE ddl_canary' } },
        { type: 'CREATE_INDEX', schema: ddlSchema, table: canary, indexDef: { name: 'i"; DROP TABLE ddl_canary;--', columns: ['id'] } },
        { type: 'CREATE_INDEX', schema: ddlSchema, table: canary, indexDef: { name: 'i2', columns: ['id); DROP TABLE ddl_canary; --'] } },
        { type: 'CREATE_SEQUENCE', schema: ddlSchema, sequenceDef: { name: 's"; DROP TABLE ddl_canary;--' } },
        { type: 'CREATE_SEQUENCE', schema: ddlSchema, sequenceDef: { name: 's3', start: '1; DROP TABLE ddl_canary' } },
        { type: 'DROP_TABLE', schema: ddlSchema, table: 'ddl_canary"; SELECT 1; --' },
        { type: 'CREATE_TABLE', schema: 'public', table: 'pwned', schemaDef: { columns: [{ name: 'id', type: 'INTEGER' }] } },
        { type: 'CREATE_TABLE', schema: 'tenant_other_x', table: 'pwned', schemaDef: { columns: [{ name: 'id', type: 'INTEGER' }] } },
        { type: 'DROP_TABLE', schema: 'fabric_system', table: 'access_policies' },
      ];
      for (const cfg of evil) {
        const t0 = Date.now();
        const r = await run(cfg);
        expect([JSON.stringify(cfg).slice(0, 90), r.status < 500]).toEqual([JSON.stringify(cfg).slice(0, 90), true]);
        expect(Date.now() - t0).toBeLessThan(2500);
      }
      expect(await relationExists(physical(), canary)).toBe(true);
      expect(await relationExists('public', 'pwned')).toBe(false);
      expect(await relationExists('fabric_system', 'access_policies')).toBe(policiesBefore);
    });
  });

  describe('confinement', () => {
    it('DML / DDL against reserved or foreign schemas is 403 and changes nothing', async () => {
      for (const schema of ['public', 'fabric_system', 'pg_catalog', 'information_schema']) {
        for (const cfg of [
          { type: 'INSERT', schema, table: 'users', data: { id: 1 } },
          { type: 'DELETE', schema, table: 'users', filter: { id: 1 } },
          { type: 'CREATE_TABLE', schema, table: 't2_x', schemaDef: { columns: [{ name: 'id', type: 'INTEGER' }] } },
        ]) {
          const r = await run(cfg);
          expect([schema, cfg.type, r.status]).toEqual([schema, cfg.type, 403]);
        }
      }
    });
    it('unbounded legacy DML / SELECT are refused (INDUSTRIAL SAFETY 400)', async () => {
      await run({ type: 'CREATE_TABLE', schema: ddlSchema, table: 'guard', schemaDef: { columns: [{ name: 'id', type: 'INTEGER' }] } });
      await run({ type: 'INSERT', schema: ddlSchema, table: 'guard', data: [{ id: 1 }, { id: 2 }] });
      for (const cfg of [{ type: 'DELETE', schema: ddlSchema, table: 'guard' }, { type: 'UPDATE', schema: ddlSchema, table: 'guard', data: { id: 9 } }, { type: 'SELECT', schema: ddlSchema, table: 'guard' }]) {
        const r = await run(cfg);
        expect(r.status).toBe(400); expect(r.body.code).toBe('UNBOUNDED_QUERY');
      }
      expect((await run({ type: 'SELECT', schema: ddlSchema, table: 'guard', limit: 10 })).body.rowCount).toBe(2);
    });
    it('a legacy config naming a table of another tenant by a dotted / quoted name can only resolve to objects of the callers own workspace', async () => {
      for (const table of [`tenant_other_x.guard`, `"tenant_other_x"."guard"`, '../guard', 'guard;DROP TABLE guard']) {
        const r = await run({ type: 'SELECT', schema: ddlSchema, table, limit: 5 });
        expect(r.status).toBeLessThan(500);
        // legacy names are reduced to [A-Za-z0-9_]: they can only ever resolve to an object of THIS tenant
        if (r.status === 200) expect(r.body.data.map((x: any) => x.id).sort()).toEqual([1, 2]);
      }
    });
    it('legacy flat SELECT with a join and groupBy', async () => {
      await run({ type: 'CREATE_TABLE', schema: ddlSchema, table: 'dept', schemaDef: { columns: [{ name: 'id', type: 'INTEGER' }, { name: 'dname', type: 'TEXT' }] } });
      await run({ type: 'CREATE_TABLE', schema: ddlSchema, table: 'emp', schemaDef: { columns: [{ name: 'id', type: 'INTEGER' }, { name: 'dept_id', type: 'INTEGER' }] } });
      await run({ type: 'INSERT', schema: ddlSchema, table: 'dept', data: [{ id: 1, dname: 'eng' }, { id: 2, dname: 'ops' }] });
      await run({ type: 'INSERT', schema: ddlSchema, table: 'emp', data: [{ id: 1, dept_id: 1 }, { id: 2, dept_id: 1 }, { id: 3, dept_id: 2 }] });
      const r = await run({
        type: 'SELECT', schema: ddlSchema, table: 'dept', select: ['dept.dname', 'count(emp.id) AS n'],
        joins: [{ type: 'INNER', table: 'emp', on: `"${physical()}"."dept".id = "${physical()}"."emp".dept_id` }],
        groupBy: ['dept.dname'], orderBy: [{ field: 'dept.dname', dir: 'ASC' }], limit: 10,
      });
      expect(r.status).toBe(200);
      expect(r.body.data.map((x: any) => [x.dname, Number(x.n)])).toEqual([['eng', 2], ['ops', 1]]);
    });
    it('legacy withRecursive (CTE) config', async () => {
      const r = await run({
        type: 'SELECT', schema: ddlSchema, table: 'nums', limit: 10,
        withRecursive: { name: 'nums', baseQuery: 'SELECT 1 AS n', recursiveQuery: 'SELECT n + 1 FROM nums WHERE n < 5' },
        select: ['n'],
      });
      expect(r.status).toBe(200);
      expect(r.body.data.map((x: any) => x.n)).toEqual([1, 2, 3, 4, 5]);
    });
    it.todo('MERGE / UPSERT config types do not exist (INSERT ... ON CONFLICT is not exposed); use update-then-create');
  });

  describe('DML through /api/data (read-back through the AST)', () => {
    it('create -> AST read -> update -> AST read -> delete -> AST read', async () => {
      await run({ type: 'CREATE_TABLE', schema: ddlSchema, table: 'kv', schemaDef: { columns: [{ name: 'k', type: 'TEXT', constraints: 'PRIMARY KEY' }, { name: 'v', type: 'INTEGER' }] } });
      expect((await data(o, 'create', { schema: ddlSchema, resource: 'kv', data: [{ k: 'a', v: 1 }, { k: 'b', v: 2 }] })).body.rowCount).toBe(2);
      const read = (where?: any[]) => run({ type: 'SELECT', schema: ddlSchema, limit: 10, query: { from: { resource: 'kv' }, orderBy: [{ column: 'k', direction: 'ASC' }], ...(where ? { where } : {}) } });
      expect((await read()).body.data).toEqual([{ k: 'a', v: 1 }, { k: 'b', v: 2 }]);
      expect((await data(o, 'update', { schema: ddlSchema, resource: 'kv', where: { k: 'a' }, data: { v: 10 } })).body.rowCount).toBe(1);
      expect((await read([{ column: 'k', operator: 'EQ', value: 'a' }])).body.data).toEqual([{ k: 'a', v: 10 }]);
      expect((await data(o, 'delete', { schema: ddlSchema, resource: 'kv', where: { k: 'b' } })).body.rowCount).toBe(1);
      expect((await read()).body.data).toEqual([{ k: 'a', v: 10 }]);
    });
  });
});
