import fs from 'fs';
import path from 'path';
import { validateManifestDocument, ManifestValidationError } from './manifest_validator';
import { ManifestParser } from './manifest_parser';

const TENANT = 'acme';
const clone = <T>(x: T): T => JSON.parse(JSON.stringify(x));

const base = () => ({
  version: '4.0',
  schemas: [{
    name: 'sales',
    resources: [
      { type: 'ENUM', name: 'status_t', values: ['A', 'B'] },
      {
        type: 'TABLE', name: 'orders',
        columns: [
          { name: 'id', type: 'UUID', primaryKey: true, default: 'uuid_generate_v7()' },
          { name: 'status', type: 'status_t', default: "'A'" },
          { name: 'total', type: 'NUMERIC(10,2)', nullable: false },
          { name: 'created_at', type: 'TIMESTAMP', default: 'NOW()', index: { type: 'BRIN' } },
        ],
        constraints: [{ name: 'chk_total', type: 'CHECK', expression: 'total >= 0' }],
        security: { enable_rls: true, policies: [{ name: 'p1', roles: ['fabric_user'], using: "region = current_setting('app.current_region')" }] },
      },
    ],
  }],
});

function codes(manifest: any, opts: { allowFreeSql?: boolean } = {}): string[] {
  try { validateManifestDocument(manifest, { tenantId: TENANT, ...opts }); return []; }
  catch (e: any) { if (e instanceof ManifestValidationError) return e.issues.map((i) => i.code); throw e; }
}

describe('validateManifestDocument', () => {
  it('accepts a normal manifest', () => {
    expect(codes(base())).toEqual([]);
  });

  describe('real-world manifest (test_manifest.json)', () => {
    const raw = fs.readFileSync(path.join(__dirname, '../../../../test_manifest.json'), 'utf8');
    it('non-admin: only free-form SQL is refused (FREE_SQL_NOT_ALLOWED), nothing else', () => {
      const m = ManifestParser.parse(raw);
      const c = codes(m);
      expect(c.length).toBeGreaterThan(0);
      expect([...new Set(c)]).toEqual(['FREE_SQL_NOT_ALLOWED']);
    });
    it('platform admin / allowed owner: accepted', () => {
      const m = ManifestParser.parse(raw);
      expect(codes(m, { allowFreeSql: true })).toEqual([]);
    });
  });

  describe('schema confinement', () => {
    it.each([
      ['public', 'RESERVED_SCHEMA'],
      ['fabric_admin', 'RESERVED_SCHEMA'],
      ['information_schema', 'RESERVED_SCHEMA'],
      ['pg_catalog', 'RESERVED_SCHEMA'],
      ['tenant_other_x', 'CROSS_TENANT_SCHEMA'],
      ['tenant_acme_x', 'CROSS_TENANT_SCHEMA'],
      ['public.users', 'INVALID_IDENTIFIER'],
      ['tenant_other.x', 'INVALID_IDENTIFIER'],
      ['x"; DROP TABLE users;--', 'INVALID_IDENTIFIER'],
      ['ünïcode', 'INVALID_IDENTIFIER'],
      ['ａdmin', 'INVALID_IDENTIFIER'],
      ['a\u0000b', 'INVALID_IDENTIFIER'],
      ['a'.repeat(64), 'INVALID_IDENTIFIER'],
      ['a'.repeat(60), 'NAME_TOO_LONG'],
      ['', 'INVALID_IDENTIFIER'],
    ])('refuses schema name %j', (name, code) => {
      const m = base(); m.schemas[0]!.name = name;
      expect(codes(m)).toContain(code);
    });

    it('rejects duplicate schema names (case-insensitive)', () => {
      const m = base(); m.schemas.push(clone(m.schemas[0]!)); m.schemas[1]!.name = 'SALES';
      expect(codes(m)).toContain('DUPLICATE_NAME');
    });

    it('refuses a bad tenant id', () => {
      expect(() => validateManifestDocument(base(), { tenantId: 'a"b' })).toThrow(ManifestValidationError);
    });
  });

  describe('identifier injection in every position', () => {
    const bad = [`x"; DROP TABLE users;--`, 'public.users', 'ａ', 'a b', 'a'.repeat(64), '1abc', '', 'a\u0000b', `a'b`];
    const targets: Array<[string, (m: any, v: string) => void]> = [
      ['table name', (m, v) => { m.schemas[0].resources[1].name = v; }],
      ['enum name', (m, v) => { m.schemas[0].resources[0].name = v; }],
      ['column name', (m, v) => { m.schemas[0].resources[1].columns[0].name = v; }],
      ['constraint name', (m, v) => { m.schemas[0].resources[1].constraints[0].name = v; }],
      ['policy name', (m, v) => { m.schemas[0].resources[1].security.policies[0].name = v; }],
      ['policy role', (m, v) => { m.schemas[0].resources[1].security.policies[0].roles = [v]; }],
      ['identity column', (m, v) => { m.schemas[0].resources[1].identity = { type: 'PRIMARY_KEY', columns: [v] }; }],
      ['partition column', (m, v) => { m.schemas[0].resources[1].partitionBy = { type: 'RANGE', column: v }; }],
      ['relationship name', (m, v) => { m.relationships = [{ name: v, cardinality: '1:M', from: { resource: 'orders', field: 'id' }, to: { resource: 'orders', field: 'id' } }]; }],
      ['relationship field', (m, v) => { m.relationships = [{ name: 'r', cardinality: '1:M', from: { resource: 'orders', field: v }, to: { resource: 'orders', field: 'id' } }]; }],
      ['view name', (m, v) => { m.schemas[0].resources.push({ type: 'VIEW', name: v, query: { from: { resource: 'orders' } } }); }],
      ['view from.resource', (m, v) => { m.schemas[0].resources.push({ type: 'VIEW', name: 'v', query: { from: { resource: v } } }); }],
      ['sequence name', (m, v) => { m.schemas[0].resources.push({ type: 'SEQUENCE', name: v }); }],
      ['trigger name', (m, v) => { m.schemas[0].resources[1].triggers = [{ name: v, timing: 'AFTER', events: ['INSERT'], procedure: 'audit_log_fn' }]; }],
      ['index column (matview)', (m, v) => { m.schemas[0].resources.push({ type: 'MATERIALIZED_VIEW', name: 'mv', query: { from: { resource: 'orders' } }, indexes: [{ columns: [v] }] }); }],
    ];
    describe.each(targets)('%s', (_label, mutate) => {
      it.each(bad)('refuses %j', (v) => {
        const m = base(); mutate(m, v);
        expect(codes(m).length).toBeGreaterThan(0);
      });
    });
  });

  describe('types, defaults, expressions', () => {
    it.each([`text); DROP TABLE x;--`, 'pg_authid', 'public.users', 'int primary key', 'serial; x'])('refuses column type %j', (t) => {
      const m = base(); m.schemas[0]!.resources[1]!.columns![1]!.type = t;
      expect(codes(m)).toContain('INVALID_COLUMN_TYPE');
    });
    it.each([`now(); DROP TABLE x`, `x' || (select 1) || '`, 'pg_sleep(10)', `(SELECT 1)`, 'a\u0000'])('refuses default %j', (d) => {
      const m = base(); m.schemas[0]!.resources[1]!.columns![3]!.default = d;
      expect(codes(m)).toContain('UNSAFE_DEFAULT');
    });
    it.each([`total >= 0); DROP TABLE x; --`, 'pg_sleep(1) > 0', '(select 1) = 1', 'a /* c */ = 1', `total > 0 OR 1=(SELECT 1)`])('refuses CHECK %j', (e) => {
      const m = base(); m.schemas[0]!.resources[1]!.constraints![0]!.expression = e;
      expect(codes(m)).toContain('UNSAFE_EXPRESSION');
    });
    it.each([`true); DROP TABLE x; --`, `x IN (SELECT 1)`, 'pg_read_file(1)=1'])('refuses policy USING %j', (e) => {
      const m = base(); m.schemas[0]!.resources[1]!.security!.policies![0]!.using = e;
      expect(codes(m)).toContain('UNSAFE_EXPRESSION');
    });
    it('refuses reserved roles in grants/policies', () => {
      const m = base(); m.schemas[0]!.resources[1]!.security!.policies![0]!.roles = ['postgres'];
      expect(codes(m)).toContain('RESERVED_ROLE');
    });
    it('refuses unknown privilege', () => {
      const m: any = base(); m.schemas[0].resources[1].security.grants = [{ role: 'viewer', privileges: ['SELECT; DROP TABLE x'] }];
      expect(codes(m)).toContain('INVALID_GRANT');
    });
    it('refuses extensions outside the allow-list', () => {
      const m: any = base(); m.extensions = ['uuid-ossp', 'dblink'];
      expect(codes(m)).toContain('EXTENSION_NOT_ALLOWED');
      m.extensions = ['uuid-ossp"; DROP SCHEMA public'];
      expect(codes(m)).toContain('EXTENSION_NOT_ALLOWED');
    });
  });

  describe('free-form SQL gate', () => {
    const fn = () => ({ type: 'FUNCTION', name: 'f', arguments: [{ name: 'a', type: 'TEXT' }], returnType: 'TEXT', body: 'RETURN a;' });
    it('function body: FREE_SQL_NOT_ALLOWED for non-admins, accepted for allowed callers', () => {
      const m: any = base(); m.schemas[0].resources.push(fn());
      expect(codes(m)).toEqual(['FREE_SQL_NOT_ALLOWED']);
      expect(codes(m, { allowFreeSql: true })).toEqual([]);
    });
    it('procedure body too', () => {
      const m: any = base(); m.schemas[0].resources.push({ ...fn(), type: 'PROCEDURE', name: 'p' });
      expect(codes(m)).toEqual(['FREE_SQL_NOT_ALLOWED']);
    });
    it('even for admins a body cannot contain dollar delimiters or NUL bytes', () => {
      const m: any = base(); m.schemas[0].resources.push({ ...fn(), body: 'x $$ ; DROP TABLE t; $$' });
      expect(codes(m, { allowFreeSql: true })).toContain('INVALID_BODY');
      m.schemas[0].resources[2].body = 'x\u0000y';
      expect(codes(m, { allowFreeSql: true })).toContain('INVALID_BODY');
    });
    it('raw expression entries inside a view AST are free SQL', () => {
      const m: any = base();
      m.schemas[0].resources.push({ type: 'VIEW', name: 'v', query: { from: { resource: 'orders' }, select: [{ expression: 'count(*)', alias: 'n' }] } });
      expect(codes(m)).toContain('FREE_SQL_NOT_ALLOWED');
      expect(codes(m, { allowFreeSql: true })).toEqual([]);
    });
    it('a pure AST view needs no free SQL', () => {
      const m: any = base();
      m.schemas[0].resources.push({ type: 'VIEW', name: 'v', query: { from: { resource: 'orders' }, select: [{ aggregate: 'COUNT', alias: 'n' }], groupBy: ['status'] } });
      expect(codes(m)).toEqual([]);
    });
    it('trigger action.sql is free SQL', () => {
      const m: any = base();
      m.schemas[0].resources[1].triggers = [{ name: 't1', timing: 'AFTER', events: ['INSERT'], action: { sql: 'INSERT INTO log VALUES (1)' } }];
      expect(codes(m)).toContain('FREE_SQL_NOT_ALLOWED');
      expect(codes(m, { allowFreeSql: true })).toEqual([]);
    });
  });

  describe('unknown keys / structural abuse', () => {
    it('lists unknown top-level keys', () => {
      const m: any = base(); m.evil = 1; m.other = 2;
      try { validateManifestDocument(m, { tenantId: TENANT }); throw new Error('no throw'); }
      catch (e: any) { expect(e.issues[0].code).toBe('UNKNOWN_KEYS'); expect(e.message).toMatch(/evil/); expect(e.message).toMatch(/other/); expect(e.message).toMatch(/Validation/); }
    });
    it('rejects unknown keys on resources / columns (diff spread overrides such as action/schema/targetSource)', () => {
      const m: any = base(); m.schemas[0].resources[1].action = 'DROP_TABLE'; m.schemas[0].resources[1].schema = 'public';
      expect(codes(m)).toContain('UNKNOWN_KEYS');
      const c: any = base(); c.schemas[0].resources[1].columns[0].rawSql = 'x';
      expect(codes(c)).toContain('UNKNOWN_KEYS');
    });
    it.each(['__proto__', 'constructor', 'prototype'])('rejects the %s key anywhere', (k) => {
      const m: any = JSON.parse(`{"version":"4.0","schemas":[{"name":"sales","resources":[]}],"x":{"${k}":{"y":1}}}`);
      expect(codes(m)).toContain('FORBIDDEN_KEY');
      const n: any = base(); n.schemas[0].resources[1].columns[0] = JSON.parse(`{"name":"id","type":"UUID","${k}":{"polluted":true}}`);
      expect(codes(n)).toContain('FORBIDDEN_KEY');
    });
    it('rejects arrays/objects where scalars are expected', () => {
      const m: any = base(); m.schemas[0].resources[1].columns[0].name = ['id'];
      expect(codes(m)).toContain('INVALID_IDENTIFIER');
      const n: any = base(); n.schemas[0].resources[1].columns[0].type = { toString: () => 'text' };
      expect(codes(n)).toContain('INVALID_COLUMN_TYPE');
      const o: any = base(); o.schemas = {};
      expect(codes(o).length).toBeGreaterThan(0);
      const p: any = base(); p.schemas[0].resources = 'x';
      expect(codes(p).length).toBeGreaterThan(0);
    });
    it('rejects non-object manifests, missing version/schemas and unknown resource types', () => {
      expect(() => validateManifestDocument(null, { tenantId: TENANT })).toThrow(ManifestValidationError);
      expect(() => validateManifestDocument([], { tenantId: TENANT })).toThrow(ManifestValidationError);
      const m: any = base(); delete m.version;
      expect(codes(m)).toContain('INVALID_VERSION');
      const n: any = base(); n.schemas[0].resources.push({ type: 'TRIGGER_BOMB', name: 'x' });
      expect(codes(n)).toContain('UNKNOWN_RESOURCE_TYPE');
    });
    it('rejects duplicates and oversized collections', () => {
      const m: any = base(); m.schemas[0].resources.push(clone(m.schemas[0].resources[1]));
      expect(codes(m)).toContain('DUPLICATE_NAME');
      const n: any = base(); n.schemas[0].resources[1].columns = Array.from({ length: 501 }, (_, i) => ({ name: `c${i}`, type: 'TEXT' }));
      expect(codes(n)).toContain('TOO_MANY');
    });
    it('rejects a federated/relationship source name with injection', () => {
      const m: any = base(); m.relationships = [{ name: 'r', cardinality: '1:M', from: { resource: 'orders', field: 'id', source: `x'; DROP` }, to: { resource: 'orders', field: 'id' } }];
      expect(codes(m)).toContain('INVALID_SOURCE_NAME');
    });
  });

  it('reports every problem at once with a "Validation" message the controller maps to HTTP 400', () => {
    const m: any = base(); m.schemas[0].name = 'public'; m.schemas[0].resources[1].name = 'a b'; m.extra = true;
    try { validateManifestDocument(m, { tenantId: TENANT }); throw new Error('no throw'); }
    catch (e: any) { expect(e.status).toBe(400); expect(e.issues.length).toBeGreaterThanOrEqual(3); expect(e.message).toContain('Validation'); }
  });
});
