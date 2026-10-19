// The standalone trigger-engine/ package is deployed separately; its pure modules are exercised here with the same corpus.
import { TriggerTranspiler } from '../../../../trigger-engine/src/modules/triggers/trigger.transpiler';
import { assertSafeWebhookUrl } from '../../../../trigger-engine/src/utils/net_guard';
import { assertIdent } from '../../../../trigger-engine/src/utils/identifiers';

const base: any = { name: 'trg_a', event: 'AFTER_INSERT', execute: { type: 'AUDIT' } };
const sql = (trg: any = base, schema = 'tenant_acme_sales', table = 'orders', opts: any = { tenantId: 'acme' }) => TriggerTranspiler.toSql(trg, schema, table, opts);

describe('trigger-engine TriggerTranspiler', () => {
  it('quotes names and compiles a valid trigger', () => {
    const out = sql().join('\n');
    expect(out).toContain('CREATE OR REPLACE FUNCTION "tenant_acme_sales"."trg_a_func"()');
    expect(out).toContain('CREATE TRIGGER "trg_a"');
    expect(out).toContain('AFTER INSERT ON "tenant_acme_sales"."orders"');
    expect(sql({ ...base, event: 'INSTEAD_OF_UPDATE' }).join('\n')).toContain('INSTEAD OF UPDATE ON');
  });
  it.each([`x"; DROP TABLE users;--`, 'public.users', 'a b', 'a'.repeat(64), '', 'ａdmin', "a'b"])('rejects injected table/schema/trigger name %j', (v) => {
    expect(() => sql(base, 'tenant_acme_sales', v)).toThrow();
    expect(() => sql(base, v)).toThrow();
    expect(() => sql({ ...base, name: v })).toThrow();
  });
  it('confines the schema to the job tenant (trigger cross-tenant refusal)', () => {
    for (const schema of ['public', 'fabric_admin', 'tenant_other_sales', 'tenant_acmeX', 'information_schema']) {
      expect(() => sql(base, schema)).toThrow(/outside the workspace|Invalid/);
    }
    expect(() => sql(base, 'tenant_acme')).not.toThrow();
  });
  it('rejects bad events', () => {
    for (const ev of ['AFTER_INSERT; DROP', 'AFTER_SELECT', '', 'INSERT']) expect(() => sql({ ...base, event: ev })).toThrow();
  });
  it('conditions are compiled structurally; free-form strings are refused', () => {
    const out = sql({ ...base, condition: { left: 'NEW.total', operator: 'GT', right: 100 } }).join('\n');
    expect(out).toContain('WHEN (NEW."total" > 100)');
    expect(() => sql({ ...base, condition: 'true); DROP TABLE x; --' })).toThrow(/Free-form/);
    expect(() => sql({ ...base, condition: { left: 'a', operator: 'EVIL', right: 1 } })).toThrow(/operator/);
    const lit = sql({ ...base, condition: { left: 'NEW.name', operator: 'EQ', right: "x') OR 1=1 --" } }).join('\n');
    expect(lit).toContain(`NEW."name" = 'x'') OR 1=1 --'`);
  });
  it('embedded JSON is escaped and delimiters are refused', () => {
    const out = sql({ ...base, execute: { type: 'WEBHOOK', url: 'https://hooks.example.com/x', payload: { m: "it's" } } }).join('\n');
    expect(out).toContain(`it''s`);
    expect(() => sql({ ...base, execute: { type: 'WEBHOOK', url: 'https://hooks.example.com/x', payload: { m: '$$ ; DROP TABLE x; $$' } } })).toThrow(/dollar/);
  });
  it('webhook url is validated at compile time', () => {
    expect(() => sql({ ...base, execute: { type: 'WEBHOOK', url: 'http://169.254.169.254/' } })).toThrow();
    expect(() => sql({ ...base, execute: { type: 'WEBHOOK', url: 'file:///etc/passwd' } })).toThrow();
  });
  it('EXCEPTION messages are escaped and FUNCTION names quoted / confined', () => {
    expect(sql({ ...base, execute: { type: 'EXCEPTION', message: "it's 5%" } }).join('\n')).toContain(`RAISE EXCEPTION 'it''s 5%%'`);
    expect(sql({ ...base, execute: { type: 'FUNCTION', name: 'fn1' } }).join('\n')).toContain('PERFORM "tenant_acme_sales"."fn1"();');
    expect(() => sql({ ...base, execute: { type: 'FUNCTION', name: 'public.pg_sleep' } })).toThrow();
    expect(() => sql({ ...base, execute: { type: 'FUNCTION', name: 'tenant_other_x.f' } })).toThrow();
    expect(() => sql({ ...base, execute: { type: 'FUNCTION', name: 'f"(); DROP' } })).toThrow();
    expect(() => sql({ ...base, execute: { type: 'SHELL' } })).toThrow(/Unsupported/);
  });
  it('schedule column must be an identifier', () => {
    expect(() => sql({ ...base, execute: { type: 'WEBHOOK', url: 'https://hooks.example.com/x' }, schedule: { type: 'RELATIVE', after: 1, unit: 'HOUR', column: "a')::x;--" } })).toThrow();
  });
  it('shared guards behave like the backend copies', () => {
    expect(() => assertSafeWebhookUrl('http://169.254.169.254/', { env: {} as any })).toThrow();
    expect(() => assertIdent('a.b')).toThrow();
  });
});
