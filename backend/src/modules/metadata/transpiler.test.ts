jest.mock('../../config/database', () => ({ pool: { query: jest.fn(), connect: jest.fn() }, queryWithContext: jest.fn() }));

import { Transpiler, FREE_SQL_FLAG, physicalSchemaName, derivedName } from './transpiler';
import { QueryTranspiler, transpilerEscapesValues } from './query_transpiler';

const T = 'acme';
const manifestOf = (resources: any[], free = false): any => {
  const m: any = { version: '4.0', schemas: [{ name: 'sales', resources }] };
  if (free) Object.defineProperty(m, FREE_SQL_FLAG, { value: true, enumerable: false });
  return m;
};
const table = (over: any = {}) => ({ type: 'TABLE', name: 'orders', columns: [{ name: 'id', type: 'UUID', primaryKey: true }, { name: 'note', type: 'STRING', default: 'PENDING' }], ...over });
const sql = (diff: any, m?: any) => Transpiler.toSql({ schema: 'sales', targetSource: 'Fabric_Hub_Postgres', engineType: 'POSTGRES', ...diff }, T, m);

describe('physicalSchemaName', () => {
  it('maps into the tenant namespace and refuses anything else', () => {
    expect(physicalSchemaName('acme', 'sales')).toBe('tenant_acme_sales');
    expect(() => physicalSchemaName('acme', 'a.b')).toThrow();
    expect(() => physicalSchemaName('acme', 'x"; DROP')).toThrow();
    expect(() => physicalSchemaName('acme', 'a'.repeat(60))).toThrow();
    expect(() => physicalSchemaName('a"b', 'sales')).toThrow();
  });
  it('derived names are shortened with a hash', () => {
    expect(derivedName('idx', 'orders', 'id')).toBe('idx_orders_id');
    const long = derivedName('idx', 'a'.repeat(40), 'b'.repeat(40));
    expect(long.length).toBeLessThanOrEqual(63);
  });
});

describe('Transpiler.toSql (postgres)', () => {
  it('quotes every identifier and escapes literal defaults', async () => {
    const out = (await sql({ action: 'CREATE_TABLE', ...table({ columns: [{ name: 'id', type: 'UUID' }, { name: 'note', type: 'STRING', default: "O'Brien" }] }) })).join('\n');
    expect(out).toContain('CREATE TABLE IF NOT EXISTS "tenant_acme_sales"."orders"');
    expect(out).toContain(`DEFAULT 'O''Brien'`);
  });

  it.each([
    ['table name', { name: 'x"; DROP TABLE users;--' }],
    ['column name', { columns: [{ name: 'a"b', type: 'TEXT' }] }],
    ['column type', { columns: [{ name: 'a', type: 'text); DROP TABLE x;--' }] }],
    ['default', { columns: [{ name: 'a', type: 'TEXT', default: 'now(); DROP TABLE x' }] }],
    ['check', { constraints: [{ name: 'c', type: 'CHECK', expression: '1=1); DROP TABLE x;--' }] }],
    ['generated', { columns: [{ name: 'a', type: 'TEXT', generated: "1); DROP TABLE x; --" }] }],
    ['index type', { columns: [{ name: 'a', type: 'TEXT', index: { type: 'GIN; DROP TABLE x' } }] }],
    ['partition', { partitionBy: { type: 'RANGE; DROP', column: 'a' } }],
    ['policy using', { security: { enable_rls: true, policies: [{ name: 'p', using: 'true); DROP TABLE x;--' }] } }],
    ['grant privilege', { security: { grants: [{ role: 'viewer', privileges: ['SELECT; DROP TABLE x'] }] } }],
    ['grant role', { security: { grants: [{ role: 'postgres', privileges: ['SELECT'] }] } }],
  ])('refuses an injected %s', async (_l, over) => {
    await expect(sql({ action: 'CREATE_TABLE', ...table(over) })).rejects.toThrow();
  });

  it('refuses diffs addressed at another namespace', async () => {
    await expect(Transpiler.toSql({ action: 'CREATE_SCHEMA', name: 'public.x' }, T)).rejects.toThrow();
    await expect(Transpiler.toSql({ action: 'CREATE_SCHEMA', name: 'a"; DROP SCHEMA public' }, T)).rejects.toThrow();
    await expect(Transpiler.toSql({ action: 'CREATE_SCHEMA', name: 'x' }, 'a"b')).rejects.toThrow();
  });

  it('creates the schema for the tenant only', async () => {
    const out = await Transpiler.toSql({ action: 'CREATE_SCHEMA', name: 'sales' }, T);
    expect(out[0]).toBe('CREATE SCHEMA IF NOT EXISTS "tenant_acme_sales"');
    expect(out.join('\n')).not.toContain('tenant_other');
  });

  it('enum values are escaped', async () => {
    const out = await sql({ action: 'CREATE_ENUM', name: 'st', values: ["a'b", 'c'] });
    expect(out[0]).toBe(`CREATE TYPE "tenant_acme_sales"."st" AS ENUM ('a''b', 'c')`);
  });

  it('extensions are validated', async () => {
    await expect(Transpiler.toSql({ action: 'PROVISION_EXTENSIONS', extensions: ['uuid-ossp"; DROP'] }, T)).rejects.toThrow();
    expect(await Transpiler.toSql({ action: 'PROVISION_EXTENSIONS', extensions: ['uuid-ossp'] }, T)).toEqual(['CREATE EXTENSION IF NOT EXISTS "uuid-ossp"']);
  });

  it('functions need the free-SQL flag and cannot break out of the dollar quote', async () => {
    const fn = { action: 'CREATE_FUNCTION', type: 'FUNCTION', name: 'f', returnType: 'TEXT', arguments: [], body: 'RETURN 1;' };
    await expect(sql(fn, manifestOf([]))).rejects.toThrow(/FREE_SQL_NOT_ALLOWED/);
    const ok = await sql(fn, manifestOf([], true));
    expect(ok[0]).toContain('CREATE OR REPLACE FUNCTION "tenant_acme_sales"."f"()');
    await expect(sql({ ...fn, body: 'x $dfbody$ ; DROP TABLE t; $dfbody$' }, manifestOf([], true))).rejects.toThrow();
    await expect(sql({ ...fn, body: 'x $$ ; DROP TABLE t; $$' }, manifestOf([], true))).rejects.toThrow();
  });

  it('table triggers go through the trigger validator/compiler (tenant confined, no raw SQL)', async () => {
    const trg = { name: 'trg_a', timing: 'AFTER', events: ['INSERT'], procedure: 'audit_log_fn' };
    const out = (await sql({ action: 'CREATE_TABLE', ...table({ triggers: [trg] }) }, manifestOf([]))).join('\n');
    expect(out).toContain('CREATE TRIGGER "trg_a" AFTER INSERT ON "tenant_acme_sales"."orders"');
    await expect(sql({ action: 'CREATE_TABLE', ...table({ triggers: [{ ...trg, name: 'x"; DROP' }] }) }, manifestOf([]))).rejects.toThrow();
    await expect(sql({ action: 'CREATE_TABLE', ...table({ triggers: [{ name: 't', timing: 'AFTER', events: ['INSERT'], action: { sql: 'DROP TABLE x' } }] }) }, manifestOf([]))).rejects.toThrow(/FREE_SQL/);
    await expect(sql({ action: 'CREATE_TABLE', ...table({ triggers: [{ name: 't', timing: 'AFTER', events: ['INSERT'], execute: { type: 'WEBHOOK', url: 'http://169.254.169.254/latest' } }] }) }, manifestOf([]))).rejects.toThrow();
  });

  it('relationships quote everything', async () => {
    const out = (await sql({ action: 'PROVISION_RELATIONSHIP', name: 'rel1', cardinality: '1:M', from: { resource: 'a', field: 'id' }, to: { resource: 'b', field: 'a_id' } })).join('\n');
    expect(out).toContain('ALTER TABLE "tenant_acme_sales"."b" ADD CONSTRAINT "fk_rel1" FOREIGN KEY ("a_id") REFERENCES "tenant_acme_sales"."a"("id")');
    await expect(sql({ action: 'PROVISION_RELATIONSHIP', name: "x'; DROP", cardinality: '1:M', from: { resource: 'a', field: 'id' }, to: { resource: 'b', field: 'a_id' } })).rejects.toThrow();
  });
});

describe('fabric compensation / other dialects', () => {
  it('compensation SQL escapes literals', async () => {
    const out = (await Transpiler.toFabricCompensation({ action: 'REGISTER_FABRIC_ENUM', schema: 'sales', name: 'e', values: ["a'b"], targetSource: 'Mongo_1', engineType: 'MONGODB' }, T)).join('\n');
    expect(out).toContain(`'["a''b"]'::jsonb`);
    await expect(Transpiler.toFabricCompensation({ action: 'REGISTER_FABRIC_SEQUENCE', name: "s'; DROP", start: 1 }, T)).rejects.toThrow();
    await expect(Transpiler.toFabricCompensation({ action: 'REGISTER_FABRIC_ENUM', schema: 'sales', name: 'e', values: [], targetSource: "x'); DROP", engineType: 'MONGODB' }, T)).rejects.toThrow();
  });
  it('mysql/oracle/snowflake quote identifiers and escape defaults', async () => {
    const t = { action: 'CREATE_TABLE', schema: 'sales', name: 'orders', columns: [{ name: 'note', type: 'STRING', default: "it's \\ ok" }] };
    expect((await Transpiler.toMysql(t, T)).join('')).toContain("DEFAULT 'it''s \\\\ ok'");
    expect((await Transpiler.toOracle(t, T)).join('')).toContain('"TENANT_ACME_SALES"."orders"');
    expect((await Transpiler.toSnowflake(t, T)).join('')).toContain('"TENANT_ACME_SALES"."orders"');
    await expect(Transpiler.toMysql({ ...t, name: 'a`b' }, T)).rejects.toThrow();
    await expect(Transpiler.toOracle({ ...t, columns: [{ name: 'a', type: 'TEXT); DROP' }] }, T)).rejects.toThrow();
    await expect(Transpiler.toSnowflake({ ...t, schema: 'x"; DROP' }, T)).rejects.toThrow();
  });
  it('mongo/elasticsearch names are validated', async () => {
    await expect(Transpiler.toMongo({ action: 'CREATE_TABLE', name: '../admin', columns: [] }, T)).rejects.toThrow();
    await expect(Transpiler.toElasticsearch({ action: 'CREATE_TABLE', name: '../_all', columns: [] }, T)).rejects.toThrow();
  });
});

describe('QueryTranspiler', () => {
  it('escapes values itself (callers must not pre-escape)', () => {
    expect(transpilerEscapesValues).toBe(true);
    const s = QueryTranspiler.toSql({ from: { resource: 'orders' }, select: ['id'], where: [{ column: 'name', operator: 'EQ', value: "x' OR '1'='1" }] } as any, 'tenant_acme_sales');
    expect(s).toContain(`"name" = 'x'' OR ''1''=''1'`);
  });
  it('IN takes arrays', () => {
    const s = QueryTranspiler.toSql({ from: { resource: 'orders' }, where: [{ column: 'id', operator: 'IN', value: [1, "a'b"] }] } as any, 'tenant_acme_sales');
    expect(s).toContain(`"id" IN ('1', 'a''b')`);
  });
  it.each([
    ['resource', { from: { resource: 'x"; DROP TABLE t;--' } }],
    ['alias', { from: { resource: 'o', alias: 'a"b' } }],
    ['column path', { from: { resource: 'o' }, select: ['a;b'] }],
    ['operator', { from: { resource: 'o' }, where: [{ column: 'a', operator: '= 1; DROP TABLE t; --', value: 1 }] }],
    ['aggregate', { from: { resource: 'o' }, select: [{ aggregate: 'COUNT(*); DROP', column: 'a' }] }],
    ['window', { from: { resource: 'o' }, select: [{ window: 'pg_sleep', alias: 'w' }] }],
    ['direction', { from: { resource: 'o' }, orderBy: [{ column: 'a', direction: 'ASC; DROP' }] }],
    ['join type', { from: { resource: 'o' }, joins: [{ type: 'INNER JOIN x ON 1=1; --', resource: 'b', on: { left: 'a.id', operator: 'EQ', right: 'b.id' } }] }],
    ['cte column', { from: { resource: 'o' }, with: [{ name: 'c', columns: ['a) AS (select 1); DROP'], base: { from: { resource: 'o' } } }] }],
    ['expression', { from: { resource: 'o' }, select: [{ expression: '1; DROP TABLE t' }] }],
    ['where expression', { from: { resource: 'o' }, where: [{ expression: "1=1 --" }] }],
    ['source', { from: { resource: 'o', source: 'x; DROP' } }],
  ])('refuses an injected %s', (_l, ast) => {
    expect(() => QueryTranspiler.toSql(ast as any, 'tenant_acme_sales')).toThrow();
  });
  it('full-text search query is escaped', () => {
    const s = QueryTranspiler.toSql({ from: { resource: 'o' }, where: [{ search: { column: 'n', type: 'FULL_TEXT', query: "a'); DROP" } }] } as any, 'tenant_acme_sales');
    expect(s).toContain(`plainto_tsquery('english', 'a''); DROP')`);
  });
});
