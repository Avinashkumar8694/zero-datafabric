jest.mock('../../config/database', () => ({ pool: { query: jest.fn(), connect: jest.fn() }, queryWithContext: jest.fn() }));

import { validateTriggerPayload, validateTriggerDefinition, validateManifestTrigger, TriggerValidationError } from './trigger_validator';
import { TriggerActionCompiler } from './action_compiler';
import { TriggerService } from './trigger.service';

const T = 'acme';
const codeOf = (fn: () => any): string => { try { fn(); } catch (e: any) { return e.code || e.message; } return 'OK'; };
const row = (over: any = {}) => ({
  triggerName: 'trg_orders', schemaName: 'tenant_acme_sales', tableName: 'orders',
  definition: { event: 'AFTER_INSERT', execute: { type: 'AUDIT' } },
  ...over,
});

describe('validateTriggerPayload: names and tenant confinement (T1 triggers)', () => {
  it('accepts own-tenant schemas', () => {
    expect(validateTriggerPayload(row(), T)).toEqual({ schemaName: 'tenant_acme_sales', tableName: 'orders', triggerName: 'trg_orders' });
    expect(validateTriggerPayload(row({ schemaName: 'tenant_acme' }), T).schemaName).toBe('tenant_acme');
  });
  it.each(['public', 'fabric_admin', 'information_schema', 'pg_catalog', 'tenant_other_sales', 'tenant_acmeX', 'tenant_acm', 'Tenant_acme', 'tenant_acme.sales', '__SYSTEM__'])('refuses schema %j', (schema) => {
    expect(codeOf(() => validateTriggerPayload(row({ schemaName: schema }), T))).not.toBe('OK');
  });
  it.each([`x"; DROP TABLE users;--`, 'public.users', 'a b', 'a'.repeat(64), '', 'ａdmin', 'a\u0000', "a'b", '1abc'])('refuses table / trigger name %j', (v) => {
    expect(codeOf(() => validateTriggerPayload(row({ tableName: v }), T))).not.toBe('OK');
    expect(codeOf(() => validateTriggerPayload(row({ triggerName: v }), T))).not.toBe('OK');
  });
  it('refuses a schema name with injection even inside the tenant prefix', () => {
    expect(codeOf(() => validateTriggerPayload(row({ schemaName: 'tenant_acme_x"; DROP SCHEMA public CASCADE;--' }), T))).toBe('INVALID_IDENTIFIER');
  });
  it('only schedule-only triggers may use the __SYSTEM__ placeholder', () => {
    const sched = { schedule: { type: 'CRON', cron: '*/5 * * * *' }, execute: { type: 'AUDIT' } };
    expect(validateTriggerPayload({ triggerName: 't', definition: sched }, T).schemaName).toBe('__SYSTEM__');
    expect(codeOf(() => validateTriggerPayload({ triggerName: 't', definition: { event: 'AFTER_INSERT', execute: { type: 'AUDIT' } } }, T))).toBe('INVALID_TRIGGER');
    expect(codeOf(() => validateTriggerPayload({ triggerName: 't', schemaName: 'tenant_acme_s', definition: sched }, T))).toBe('INVALID_TRIGGER');
  });
  it('requires name + definition + execute.type + event', () => {
    expect(codeOf(() => validateTriggerPayload({}, T))).toBe('INVALID_TRIGGER');
    expect(codeOf(() => validateTriggerPayload(row({ definition: { event: 'AFTER_INSERT' } }), T))).toBe('INVALID_TRIGGER');
    expect(codeOf(() => validateTriggerPayload(row({ definition: { execute: { type: 'AUDIT' } } }), T))).toBe('INVALID_TRIGGER');
    expect(codeOf(() => validateTriggerPayload(null as any, T))).toBe('INVALID_TRIGGER');
  });
});

describe('validateTriggerDefinition', () => {
  const ok = (d: any, o: any = {}) => codeOf(() => validateTriggerDefinition(d, o));
  it('rejects unknown keys, proto keys and oversized definitions', () => {
    expect(ok({ event: 'AFTER_INSERT', execute: { type: 'AUDIT' }, evil: 1 })).toBe('UNKNOWN_KEYS');
    expect(ok(JSON.parse('{"event":"AFTER_INSERT","execute":{"type":"AUDIT"},"x":{"__proto__":{"a":1}}}'))).toBe('FORBIDDEN_KEY');
    expect(ok(JSON.parse('{"event":"AFTER_INSERT","execute":{"type":"AUDIT","params":{"constructor":1}}}'))).toBe('FORBIDDEN_KEY');
    expect(ok({ event: 'AFTER_INSERT', execute: { type: 'WEBHOOK', url: 'https://x.example.com', payload: { a: 'x'.repeat(70 * 1024) } } })).toBe('TOO_LARGE');
  });
  it.each(['AFTER_INSERT; DROP', 'drop', 'AFTER', 'BEFORE_SELECT', ''])('rejects event %j', (ev) => { expect(ok({ event: ev, execute: { type: 'AUDIT' } })).toBe('INVALID_EVENT'); });
  it('accepts every documented event', () => {
    for (const ev of ['BEFORE_INSERT', 'AFTER_UPDATE', 'AFTER_DELETE', 'INSTEAD_OF_INSERT']) expect(ok({ event: ev, execute: { type: 'AUDIT' } })).toBe('OK');
  });
  it('rejects bad execute types / methods / headers / auth', () => {
    expect(ok({ event: 'AFTER_INSERT', execute: { type: 'SHELL' } })).toBe('INVALID_EXECUTE');
    expect(ok({ event: 'AFTER_INSERT', execute: { type: 'WEBHOOK', url: 'https://x.example.com', method: 'TRACE' } })).toBe('INVALID_METHOD');
    expect(ok({ event: 'AFTER_INSERT', execute: { type: 'WEBHOOK', url: 'https://x.example.com', headers: { 'X-A': 'a\r\nHost: evil' } } })).toBe('INVALID_HEADERS');
    expect(ok({ event: 'AFTER_INSERT', execute: { type: 'WEBHOOK', url: 'https://x.example.com', headers: { 'Bad Name': 'a' } } })).toBe('INVALID_HEADERS');
    expect(ok({ event: 'AFTER_INSERT', execute: { type: 'WEBHOOK', url: 'https://x.example.com', headers: { Host: 'evil' } } })).toBe('INVALID_HEADERS');
    expect(ok({ event: 'AFTER_INSERT', execute: { type: 'WEBHOOK', url: 'https://x.example.com', auth: { type: 'MAGIC' } } })).toBe('INVALID_AUTH');
    expect(ok({ event: 'AFTER_INSERT', execute: { type: 'WEBHOOK', url: 'https://x.example.com', auth: { type: 'OIDC', tokenEndpoint: 'http://169.254.169.254/token' } } })).toBe('SSRF_BLOCKED');
    expect(ok({ event: 'AFTER_INSERT', execute: { type: 'WEBHOOK', url: 'https://x.example.com', extra: 1 } })).toBe('UNKNOWN_KEYS');
  });
  it.each([
    ['http://169.254.169.254/latest/meta-data/', 'SSRF_BLOCKED'],
    ['http://metadata.google.internal/', 'SSRF_BLOCKED'],
    ['http://localhost:4000/api/admin', 'PRIVATE_TARGET_BLOCKED'],
    ['http://127.0.0.1/', 'PRIVATE_TARGET_BLOCKED'],
    ['http://10.0.0.5/', 'PRIVATE_TARGET_BLOCKED'],
    ['http://user:pw@hooks.example.com/', 'INVALID_WEBHOOK_URL'],
    ['file:///etc/passwd', 'INVALID_WEBHOOK_URL'],
    ['gopher://x', 'INVALID_WEBHOOK_URL'],
    ['javascript:alert(1)', 'INVALID_WEBHOOK_URL'],
    ['https://hooks.example.com/ok', 'OK'],
  ])('webhook url %s -> %s', (url, code) => {
    expect(ok({ event: 'AFTER_INSERT', execute: { type: 'WEBHOOK', url } }, { env: {} })).toBe(code);
  });
  it('private webhooks only with ALLOW_PRIVATE_WEBHOOKS=true (metadata never)', () => {
    const d = (url: string) => ({ event: 'AFTER_INSERT', execute: { type: 'WEBHOOK', url } });
    expect(ok(d('http://127.0.0.1:9000/hook'), { env: { ALLOW_PRIVATE_WEBHOOKS: 'true' } })).toBe('OK');
    expect(ok(d('http://169.254.169.254/'), { env: { ALLOW_PRIVATE_WEBHOOKS: 'true' } })).toBe('SSRF_BLOCKED');
  });
  it('conditions: bounded depth/size, scalar operands, known operators', () => {
    expect(ok({ event: 'BEFORE_UPDATE', execute: { type: 'EXCEPTION', message: 'no', when: { left: 'OLD.status', operator: 'EQ', right: "'X'" } } })).toBe('OK');
    expect(ok({ event: 'BEFORE_UPDATE', execute: { type: 'EXCEPTION', when: { left: 'a', operator: 'EVIL' } } })).toBe('INVALID_CONDITION');
    expect(ok({ event: 'BEFORE_UPDATE', execute: { type: 'EXCEPTION', when: { left: { x: 1 }, operator: 'EQ', right: 1 } } })).toBe('INVALID_CONDITION');
    let deep: any = { left: 'a', operator: 'EQ', right: 1 };
    for (let i = 0; i < 10; i++) deep = { and: [deep] };
    expect(['TOO_COMPLEX', 'TOO_DEEP']).toContain(ok({ event: 'BEFORE_UPDATE', execute: { type: 'EXCEPTION', when: deep } }));
    expect(ok({ event: 'BEFORE_UPDATE', condition: 'a; DROP TABLE t', execute: { type: 'AUDIT' } })).toBe('OK'); // string form is compiled as a quoted literal, never raw
  });
  it('actions: structured only; raw sql is free SQL', () => {
    expect(ok({ event: 'AFTER_INSERT', action: { sql: 'DELETE FROM x' } })).toBe('FREE_SQL_NOT_ALLOWED');
    expect(ok({ event: 'AFTER_INSERT', action: { sql: 'DELETE FROM x' } }, { allowFreeSql: true })).toBe('OK');
    expect(ok({ event: 'AFTER_INSERT', action: { sql: 'x $$ y' } }, { allowFreeSql: true })).toBe('INVALID_ACTION');
    expect(ok({ event: 'AFTER_INSERT', action: { type: 'INSERT', into: 'audit', values: { 'a"b': 1 } } })).toBe('INVALID_IDENTIFIER');
    expect(ok({ event: 'AFTER_INSERT', action: { type: 'DELETE', from: 't' } })).toBe('INVALID_ACTION');
    expect(ok({ event: 'AFTER_INSERT', action: { type: 'DROP' } })).toBe('INVALID_ACTION');
  });
  it('qualified names must stay inside the tenant', () => {
    const d = (into: string) => ({ event: 'AFTER_INSERT', action: { type: 'INSERT', into, values: { a: 1 } } });
    expect(ok(d('public.users'), { tenantId: T })).toBe('CROSS_TENANT');
    expect(ok(d('tenant_other_x.t'), { tenantId: T })).toBe('CROSS_TENANT');
    expect(ok(d('tenant_acme_sales.t'), { tenantId: T })).toBe('OK');
    expect(ok(d('tenant_acme_sales.t'))).toBe('CROSS_TENANT'); // no tenant context: qualified names are not allowed at all
    expect(ok({ event: 'AFTER_INSERT', procedure: 'fabric_admin.drop_everything' }, { tenantId: T })).toBe('CROSS_TENANT');
    expect(ok({ event: 'AFTER_INSERT', procedure: 'audit_log_fn' }, { tenantId: T })).toBe('OK');
    expect(ok({ event: 'AFTER_INSERT', execute: { type: 'FUNCTION', name: 'public.pg_sleep' } }, { tenantId: T })).toBe('CROSS_TENANT');
  });
  it('schedules: numbers and whitelisted units only (no SQL in interval text)', () => {
    const s = (schedule: any) => ok({ schedule, execute: { type: 'AUDIT' } });
    expect(s({ type: 'FIXED', every: 5, unit: 'MINUTE' })).toBe('OK');
    expect(s({ type: 'FIXED', every: "1 minute'; DROP TABLE x;--", unit: 'MINUTE' })).toBe('INVALID_VALUE');
    expect(s({ type: 'FIXED', every: 1, unit: "MINUTE'; DROP" })).toBe('INVALID_SCHEDULE');
    expect(s({ type: 'RELATIVE', after: -1, column: 'created_at' })).toBe('INVALID_VALUE');
    expect(s({ type: 'RELATIVE', after: 5, column: 'a"b' })).toBe('INVALID_IDENTIFIER');
    expect(s({ type: 'CRON', cron: '* * * * *; DROP' })).toBe('INVALID_SCHEDULE');
    expect(s({ type: 'CRON' })).toBe('INVALID_SCHEDULE');
    expect(s({ type: 'EVIL' })).toBe('INVALID_SCHEDULE');
    expect(s({ type: 'FIXED', every: 1, unit: 'MINUTE', maxAttempts: 9999 })).toBe('INVALID_VALUE');
  });
});

describe('manifest triggers', () => {
  it('require a valid name and a body', () => {
    expect(codeOf(() => validateManifestTrigger({ name: 'x"y', events: ['INSERT'], procedure: 'audit_log_fn' }))).toBe('INVALID_IDENTIFIER');
    expect(codeOf(() => validateManifestTrigger({ name: 'ok', events: ['INSERT'] }))).toBe('INVALID_TRIGGER');
    expect(codeOf(() => validateManifestTrigger({ name: 'ok', events: ['INSERT'], procedure: 'audit_log_fn' }))).toBe('OK');
  });
});

describe('TriggerActionCompiler (no stripping, quoting, confinement)', () => {
  const ctx = { schemaName: 'tenant_acme_sales', tableName: 'orders', triggerName: 't1', tenantId: T };
  it('ident throws instead of silently stripping', () => {
    expect(() => TriggerActionCompiler.ident('a.b')).toThrow();
    expect(() => TriggerActionCompiler.ident('a"b')).toThrow();
    expect(TriggerActionCompiler.ident('')).toBe('');
    expect(TriggerActionCompiler.ident('ok_1')).toBe('ok_1');
  });
  it('compiles quoted DDL for a procedure trigger', () => {
    const { statements } = TriggerActionCompiler.toSql({ name: 't1', timing: 'AFTER', events: ['INSERT', 'UPDATE'], procedure: 'audit_log_fn' }, ctx);
    expect(statements).toEqual([
      'DROP TRIGGER IF EXISTS "t1" ON "tenant_acme_sales"."orders"',
      'CREATE TRIGGER "t1" AFTER INSERT OR UPDATE ON "tenant_acme_sales"."orders" FOR EACH ROW EXECUTE FUNCTION public."audit_log_fn"()',
    ]);
  });
  it('refuses cross-tenant INSERT targets, qualified procedures outside the tenant and raw sql without permission', () => {
    expect(() => TriggerActionCompiler.toSql({ name: 't1', event: 'AFTER_INSERT', action: { type: 'INSERT', into: 'tenant_other_x.secrets', values: { a: 1 } } }, ctx)).toThrow(/outside/);
    expect(() => TriggerActionCompiler.toSql({ name: 't1', event: 'AFTER_INSERT', action: { type: 'INSERT', into: 'public.users', values: { a: 1 } } }, ctx)).toThrow(/outside/);
    expect(() => TriggerActionCompiler.toSql({ name: 't1', event: 'AFTER_INSERT', procedure: 'fabric_admin.f' }, ctx)).toThrow(/outside/);
    expect(() => TriggerActionCompiler.toSql({ name: 't1', event: 'AFTER_INSERT', action: { sql: 'DROP TABLE x' } }, ctx)).toThrow(/FREE_SQL_NOT_ALLOWED/);
    expect(() => TriggerActionCompiler.toSql({ name: 't1', event: 'AFTER_INSERT', action: { sql: 'DROP TABLE x; DROP TABLE y' } }, { ...ctx, allowFreeSql: true })).toThrow();
    expect(TriggerActionCompiler.toSql({ name: 't1', event: 'AFTER_INSERT', action: { sql: 'INSERT INTO log VALUES (1);' } }, { ...ctx, allowFreeSql: true }).statements.join('\n')).toContain('INSERT INTO log VALUES (1);');
  });
  it('quote-escapes JSON embedded in the enqueue body and refuses dollar-delimiter smuggling', () => {
    const trg = { name: 't1', event: 'AFTER_INSERT', execute: { type: 'WEBHOOK', url: 'https://hooks.example.com/x', payload: { msg: "it's $x" } } };
    const sql = TriggerActionCompiler.toSql(trg, ctx).statements.join('\n');
    expect(sql).toContain(`it''s $x`);
    const evil = { ...trg, execute: { ...trg.execute, payload: { msg: '$DFTRG$ ; DROP TABLE x; $DFTRG$' } } };
    expect(() => TriggerActionCompiler.toSql(evil, ctx)).toThrow(/DFTRG/);
  });
  it('refuses SSRF webhook URLs at compile time too', () => {
    const trg = { name: 't1', event: 'AFTER_INSERT', execute: { type: 'WEBHOOK', url: 'http://169.254.169.254/' } };
    expect(() => TriggerActionCompiler.toSql(trg, ctx)).toThrow();
  });
  it('RAISE messages are escaped (quotes and %)', () => {
    const sql = TriggerActionCompiler.toSql({ name: 't1', event: 'BEFORE_UPDATE', execute: { type: 'EXCEPTION', message: "bad 'x' 100%" } }, ctx).statements.join('\n');
    expect(sql).toContain(`RAISE EXCEPTION 'bad ''x'' 100%%'`);
  });
});

describe('TriggerService.transpileTriggerSql', () => {
  it('refuses a target schema outside the tenant and invalid names', () => {
    const trg = { name: 't1', timing: 'AFTER', events: ['INSERT'], procedure: 'audit_log_fn' };
    expect(() => TriggerService.transpileTriggerSql(trg, 'tenant_other_sales', 'orders', 'acme')).toThrow(/outside/);
    expect(() => TriggerService.transpileTriggerSql(trg, 'public', 'users', 'acme')).toThrow(/outside/);
    expect(() => TriggerService.transpileTriggerSql(trg, 'tenant_acme_sales', 'o"rders', 'acme')).toThrow();
    const out = TriggerService.transpileTriggerSql(trg, 'tenant_acme_sales', 'orders', 'acme');
    expect(out.join('\n')).toContain('CREATE TRIGGER "t1"');
    expect(out.join('\n')).toContain(`'tenant_acme_sales'`);
  });
  it('TriggerValidationError is a 400', () => {
    try { validateTriggerPayload({}, T); } catch (e: any) { expect(e).toBeInstanceOf(TriggerValidationError); expect(e.status).toBe(400); }
  });
});
