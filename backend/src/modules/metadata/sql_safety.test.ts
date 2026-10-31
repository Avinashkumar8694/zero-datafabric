import { assertColumnType, assertSafeExpression, renderDefault, sqlLiteral, assertDollarSafe } from './sql_safety';

const INJECTIONS = [
  `x"; DROP TABLE users;--`,
  `1); DROP TABLE users; --`,
  `1 /* c */`,
  `a -- comment`,
  `a; b`,
  `$$ x $$`,
  `$tag$ x $tag$`,
  `pg_sleep(10)`,
  `pg_read_file('/etc/passwd')`,
  `lo_import('/etc/passwd')`,
  `dblink('host=evil', 'select 1')`,
  `set_config('role','postgres',false)`,
  `(SELECT secret FROM tenant_other_x.t)`,
  `x IN (SELECT 1)`,
  `EXISTS (SELECT 1)`,
  `a UNION SELECT 1`,
  `public.users`,
  `tenant_other_x.t.col`,
  `x = E'\\x27'`,
  `a\nb`,
  `a\u0000b`,
  `ａ = 1`,           // fullwidth lookalike
  `a = 'unterminated`,
  `a = 1)`,
  `(a = 1`,
  `current_database()`,
  `nextval('tenant_other.seq')`,
  `x::pg_authid`,
  `COPY t TO '/tmp/x'`,
  `1; SELECT 1`,
];

describe('assertSafeExpression', () => {
  it.each(INJECTIONS)('rejects %j', (bad) => {
    expect(() => assertSafeExpression(bad, 'expr')).toThrow();
  });

  it.each([
    `region ~ '^[A-Z]{2,3}$'`,
    `id || ' [' || region || ']'`,
    `region = current_setting('app.current_region')`,
    `deleted_at IS NULL`,
    `generate_custom_id(region)`,
    `uuid_generate_v7()`,
    `now()`,
    `qty > 0 AND price <= 100.50`,
    `lower(name) LIKE 'a%'`,
    `status IN ('A', 'B')`,
    `x::timestamp with time zone > now()`,
    `x::int AND y`,
    `CASE WHEN a > 1 THEN 'x' ELSE 'y' END`,
    `NEW.total > OLD.total`,
    `nextval('tracking_seq')`,
    `'it''s fine'`,
  ])('accepts %j', (good) => {
    expect(assertSafeExpression(good, 'expr')).toBe(good.trim());
  });

  it('carries the error code', () => {
    try { assertSafeExpression('a; b', 'expr', {}, 'UNSAFE_DEFAULT'); } catch (e: any) { expect(e.code).toBe('UNSAFE_DEFAULT'); return; }
    throw new Error('expected a throw');
  });

  it('rejects non-strings and overlong input', () => {
    expect(() => assertSafeExpression(5 as any, 'x')).toThrow();
    expect(() => assertSafeExpression('a'.repeat(1001), 'x')).toThrow();
    expect(() => assertSafeExpression('   ', 'x')).toThrow();
  });
});

describe('renderDefault', () => {
  it('maps plain words to quoted literals, numbers and keywords as-is', () => {
    expect(renderDefault('PENDING', 'd')).toBe(`'PENDING'`);
    expect(renderDefault('10', 'd')).toBe('10');
    expect(renderDefault(3.5 as any, 'd')).toBe('3.5');
    expect(renderDefault(true as any, 'd')).toBe('TRUE');
    expect(renderDefault('NOW()', 'd')).toBe('NOW()');
    expect(renderDefault('uuid_generate_v7()', 'd')).toBe('uuid_generate_v7()');
    expect(renderDefault(`'PENDING'`, 'd')).toBe(`'PENDING'`);
  });
  it.each([`x'; DROP TABLE t;--`, `x' || (select 1) || '`, `a\u0000b`, `f(); DROP TABLE t`, `$$`, `'`, ''])('rejects or neutralises %j', (bad) => {
    let out: string | undefined;
    try { out = renderDefault(bad, 'd'); } catch { return; }
    // if accepted it must be a fully quoted literal with doubled quotes (nothing can break out)
    expect(out).toMatch(/^'([^']|'')*'$/);
  });
});

describe('assertColumnType', () => {
  it.each(['TEXT', 'STRING', 'varchar(255)', 'NUMERIC(10,2)', 'timestamp with time zone', 'TIMESTAMPTZ', 'integer[]', 'uuid', 'JSONB', 'double precision', 'tstzrange'])('accepts %s', (t) => {
    expect(assertColumnType(t, 'type')).toBe(t);
  });
  it.each([`text); DROP TABLE x;--`, 'pg_authid', 'public.users', 'int primary key', 'text default 1', 'a'.repeat(65), '', 'int4range; x', 'varchar(99999999999)', 'text\u0000'])('rejects %j', (t) => {
    expect(() => assertColumnType(t, 'type')).toThrow();
  });
  it('accepts declared enum names only', () => {
    expect(() => assertColumnType('shipment_status', 'type')).toThrow();
    expect(assertColumnType('shipment_status', 'type', new Set(['shipment_status']))).toBe('shipment_status');
  });
});

describe('literals / dollar quoting', () => {
  it('escapes quotes and rejects NUL', () => {
    expect(sqlLiteral(`a'b`)).toBe(`'a''b'`);
    expect(() => sqlLiteral('a\u0000b')).toThrow();
  });
  it('rejects bodies containing dollar delimiters', () => {
    expect(() => assertDollarSafe('select $$ x $$', '$dfbody$', 'body')).toThrow();
    expect(() => assertDollarSafe('select $dfbody$', '$dfbody$', 'body')).toThrow();
    expect(assertDollarSafe('select 1', '$dfbody$', 'body')).toBe('select 1');
  });
});
