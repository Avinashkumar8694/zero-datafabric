import request from 'supertest';
import { app } from '../../index';
import { pool } from '../../config/database';
import { TriggerService } from '../../modules/triggers/trigger.service';
import { TriggerTranspiler } from '../../../../trigger-engine/src/modules/triggers/trigger.transpiler';
import { MetadataOrchestrator } from '../../modules/metadata/orchestrator';
import { createWorkspace, cleanupWorkspace, relationExists, Workspace } from './_helpers';

jest.setTimeout(60000);

describe('trigger isolation hardening (DB-backed)', () => {
  let A: Workspace; let B: Workspace;
  const def = { event: 'AFTER_INSERT', execute: { type: 'AUDIT' } };
  const body = (over: any = {}) => ({ triggerName: 'trg_hd', schemaName: `tenant_${A.tenantId}_sales`, tableName: 'orders', definition: def, ...over });
  const post = (token: string, payload: any) => request(app).post('/api/triggers').set('Authorization', `Bearer ${token}`).send(payload);
  const registryCount = async (tenantId: string) => (await pool.query('SELECT count(*)::int AS n FROM public.trigger_registry WHERE tenant_id = $1', [tenantId])).rows[0].n;

  beforeAll(async () => {
    A = await createWorkspace('tra');
    B = await createWorkspace('trb');
    await new MetadataOrchestrator().apply(A.tenantId, { version: '4.0', schemas: [{ name: 'sales', resources: [{ type: 'TABLE', name: 'orders', columns: [{ name: 'id', type: 'UUID', primaryKey: true, default: 'gen_random_uuid()' }, { name: 'total', type: 'NUMERIC', default: 0 }] }] }] } as any, { force: true });
    await new MetadataOrchestrator().apply(B.tenantId, { version: '4.0', schemas: [{ name: 'sales', resources: [{ type: 'TABLE', name: 'orders', columns: [{ name: 'id', type: 'UUID', primaryKey: true, default: 'gen_random_uuid()' }] }] }] } as any, { force: true });
  });
  afterAll(async () => { await cleanupWorkspace(A.tenantId); await cleanupWorkspace(B.tenantId); });

  describe('create/update refuse foreign or malformed targets', () => {
    it.each([
      ['another tenant schema', () => ({ schemaName: 'tenant_{B}_sales' })],
      ['another tenant base schema', () => ({ schemaName: 'tenant_{B}' })],
      ['public', () => ({ schemaName: 'public', tableName: 'users' })],
      ['fabric_admin', () => ({ schemaName: 'fabric_admin', tableName: 'audit_logs' })],
      ['injected schema', () => ({ schemaName: 'tenant_{A}_sales"; DROP SCHEMA public CASCADE;--' })],
      ['injected table', () => ({ tableName: 'orders"; DROP TABLE public.users;--' })],
      ['injected trigger name', () => ({ triggerName: 'x"; DROP TABLE public.users;--' })],
      ['dotted table', () => ({ tableName: 'public.users' })],
    ])('refuses %s (HTTP and service) and stores nothing', async (_l, make) => {
      const over = make();
      for (const k of Object.keys(over)) (over as any)[k] = String((over as any)[k]).replace('{B}', B.tenantId).replace('{A}', A.tenantId);
      const payload = body(over);
      const res = await post(A.ownerToken, payload);
      expect(res.status).toBeGreaterThanOrEqual(400);
      await expect(TriggerService.createTrigger(A.tenantId, 'u', payload)).rejects.toMatchObject({ status: 400 });
      expect(await registryCount(A.tenantId)).toBe(0);
      expect(await registryCount(B.tenantId)).toBe(0);
    });

    it('an own-tenant trigger is accepted and registered', async () => {
      const res = await post(A.ownerToken, body());
      expect(res.status).toBe(201);
      expect(res.body.schemaName).toBe(`tenant_${A.tenantId}_sales`);
      expect(await registryCount(A.tenantId)).toBe(1);
    });

    it('update cannot repoint a trigger at another workspace, nor touch another tenant\'s row', async () => {
      const { rows } = await pool.query('SELECT id FROM public.trigger_registry WHERE tenant_id = $1', [A.tenantId]);
      const id = rows[0].id;
      await expect(TriggerService.updateTrigger(A.tenantId, 'u', id, body({ schemaName: `tenant_${B.tenantId}_sales` }))).rejects.toMatchObject({ status: 400 });
      // B cannot update A's row (id guessed): tenant scoped
      await expect(TriggerService.updateTrigger(B.tenantId, 'u', id, { triggerName: 'trg_hd', schemaName: `tenant_${B.tenantId}_sales`, tableName: 'orders', definition: def })).rejects.toThrow('Trigger not found');
      const after = await pool.query('SELECT schema_name FROM public.trigger_registry WHERE id = $1', [id]);
      expect(after.rows[0].schema_name).toBe(`tenant_${A.tenantId}_sales`);
    });
  });

  describe('definition validation', () => {
    it.each([
      ['webhook to the metadata service', { event: 'AFTER_INSERT', execute: { type: 'WEBHOOK', url: 'http://169.254.169.254/latest/meta-data/' } }],
      ['webhook to loopback', { event: 'AFTER_INSERT', execute: { type: 'WEBHOOK', url: 'http://127.0.0.1:4000/api/admin/tenants' } }],
      ['webhook with credentials in the URL', { event: 'AFTER_INSERT', execute: { type: 'WEBHOOK', url: 'https://user:secret@hooks.example.com/x' } }],
      ['webhook with file:// scheme', { event: 'AFTER_INSERT', execute: { type: 'WEBHOOK', url: 'file:///etc/passwd' } }],
      ['raw SQL action', { event: 'AFTER_INSERT', action: { sql: 'DROP TABLE public.users' }, execute: { type: 'AUDIT' } }],
      ['cross-tenant INSERT target', { event: 'AFTER_INSERT', execute: { type: 'AUDIT' }, action: { type: 'INSERT', into: 'tenant_victim.secrets', values: { a: 1 } } }],
      ['huge payload', { event: 'AFTER_INSERT', execute: { type: 'WEBHOOK', url: 'https://hooks.example.com/x', payload: { x: 'a'.repeat(70000) } } }],
      ['unknown key', { event: 'AFTER_INSERT', execute: { type: 'AUDIT' }, sneaky: true }],
      ['schedule interval injection', { schedule: { type: 'FIXED', every: 1, unit: "MINUTE'; DROP TABLE public.users;--" }, execute: { type: 'AUDIT' } }],
    ])('refuses %s', async (_l, definition: any) => {
      const payload = definition.schedule ? { triggerName: 'trg_s', definition } : body({ definition });
      await expect(TriggerService.createTrigger(A.tenantId, 'u', payload)).rejects.toMatchObject({ status: 400 });
      const res = await post(A.ownerToken, payload);
      expect(res.status).toBeGreaterThanOrEqual(400);
    });
    it('raw SQL actions are only compiled for allowed callers', async () => {
      const def2 = { event: 'AFTER_INSERT', execute: { type: 'AUDIT' }, action: { sql: 'SELECT 1' } };
      await expect(TriggerService.createTrigger(A.tenantId, 'u', body({ triggerName: 'trg_sql', definition: def2 }))).rejects.toMatchObject({ code: 'FREE_SQL_NOT_ALLOWED' });
      const ok = await TriggerService.createTrigger(A.tenantId, 'u', body({ triggerName: 'trg_sql', definition: def2 }), { allowFreeSql: true });
      expect(ok.triggerName).toBe('trg_sql');
    });
    it('webhook to a private address is accepted only with ALLOW_PRIVATE_WEBHOOKS=true', async () => {
      const payload = body({ triggerName: 'trg_priv', definition: { event: 'AFTER_INSERT', execute: { type: 'WEBHOOK', url: 'http://10.0.0.5:9000/hook' } } });
      await expect(TriggerService.createTrigger(A.tenantId, 'u', payload)).rejects.toMatchObject({ status: 400 });
      process.env.ALLOW_PRIVATE_WEBHOOKS = 'true';
      try { expect((await TriggerService.createTrigger(A.tenantId, 'u', payload)).triggerName).toBe('trg_priv'); }
      finally { delete process.env.ALLOW_PRIVATE_WEBHOOKS; }
    });
    it('scheduled jobs bind the delay as a number (no interval text from the definition)', async () => {
      const created = await TriggerService.createTrigger(A.tenantId, 'u', { triggerName: 'trg_cron', definition: { schedule: { type: 'FIXED', every: 2, unit: 'MINUTE' }, execute: { type: 'AUDIT' } } });
      const dep = await TriggerService.deployTrigger(A.tenantId, 'u', created.id);
      const job = await pool.query(`SELECT run_at > NOW() + interval '90 seconds' AS later FROM public.trigger_jobs WHERE id = $1`, [dep.jobId]);
      expect(job.rows[0].later).toBe(true);
    });
  });

  describe('the generated DDL really works (backend compiler and trigger-engine transpiler)', () => {
    const fire = async (tenantId: string, statements: string[], table: string) => {
      const c = await pool.connect();
      try {
        await c.query('BEGIN');
        await c.query(`SELECT set_config('app.tenant_id', $1, true)`, [tenantId]);
        await c.query(`SELECT set_config('app.user_name', 'hd-test', true)`);
        for (const s of statements) await c.query(s);
        await c.query(`INSERT INTO ${table} (total) VALUES (5)`);
        const jobs = await c.query(`SELECT payload FROM public.trigger_jobs WHERE tenant_id = $1 AND payload->>'triggerName' = 'trg_engine'`, [tenantId]);
        await c.query('COMMIT');
        return jobs.rows;
      } catch (e) { await c.query('ROLLBACK'); throw e; } finally { c.release(); }
    };
    it('trigger-engine transpiler output deploys and enqueues a job', async () => {
      const stmts = TriggerTranspiler.toSql({ name: 'trg_engine', event: 'AFTER_INSERT', condition: { left: 'NEW.total', operator: 'GT', right: 1 }, execute: { type: 'WEBHOOK', url: 'https://hooks.example.com/hd', payload: { note: "it's ok" } } } as any, `tenant_${A.tenantId}_sales`, 'orders', { tenantId: A.tenantId });
      const jobs = await fire(A.tenantId, stmts, `"tenant_${A.tenantId}_sales"."orders"`);
      expect(jobs.length).toBe(1);
      expect(jobs[0].payload.execute.payload.note).toBe("it's ok");
      // the registry-driven deploy path refuses a row that points at another workspace
      expect(() => TriggerTranspiler.toSql({ name: 'trg_engine', event: 'AFTER_INSERT', execute: { type: 'AUDIT' } } as any, `tenant_${B.tenantId}_sales`, 'orders', { tenantId: A.tenantId })).toThrow(/outside the workspace/);
    });
    it('manifest triggers (backend compiler) deploy as part of apply and fire', async () => {
      const m: any = { version: '4.0', schemas: [{ name: 'hooks', resources: [{ type: 'TABLE', name: 'evt', columns: [{ name: 'id', type: 'UUID', default: 'gen_random_uuid()' }, { name: 'total', type: 'NUMERIC' }],
        triggers: [{ name: 'trg_manifest', timing: 'AFTER', events: ['INSERT'], execute: { type: 'WEBHOOK', url: 'https://hooks.example.com/m', payload: { a: "x'y" } } }] }] }] };
      const res = await new MetadataOrchestrator().apply(A.tenantId, m, { force: true });
      expect(res.status).toBe('APPLIED');
      expect(await relationExists(`tenant_${A.tenantId}_hooks`, 'evt')).toBe(true);
      const c = await pool.connect();
      try {
        await c.query('BEGIN');
        await c.query(`SELECT set_config('app.tenant_id', $1, true)`, [A.tenantId]);
        await c.query(`INSERT INTO "tenant_${A.tenantId}_hooks"."evt" (total) VALUES (1)`);
        const jobs = await c.query(`SELECT 1 FROM public.trigger_jobs WHERE tenant_id = $1 AND payload->>'triggerName' = 'trg_manifest'`, [A.tenantId]);
        await c.query('ROLLBACK');
        expect(jobs.rows.length).toBe(1);
      } finally { c.release(); }
    });
    it('a manifest trigger that targets another workspace or smuggles SQL is refused and nothing is applied', async () => {
      const m = (trg: any): any => ({ version: '4.0', schemas: [{ name: 'hooks2', resources: [{ type: 'TABLE', name: 'evt2', columns: [{ name: 'id', type: 'UUID' }], triggers: [trg] }] }] });
      const orch = new MetadataOrchestrator();
      await expect(orch.apply(A.tenantId, m({ name: 't', timing: 'AFTER', events: ['INSERT'], action: { type: 'INSERT', into: `tenant_${B.tenantId}_sales.orders`, values: { id: 1 } } }), { force: true })).rejects.toThrow();
      await expect(orch.apply(A.tenantId, m({ name: 't', timing: 'AFTER', events: ['INSERT'], action: { sql: 'DROP TABLE public.users' } }), { force: true })).rejects.toThrow(/FREE_SQL/);
      await expect(orch.apply(A.tenantId, m({ name: 't"; DROP TABLE public.users;--', timing: 'AFTER', events: ['INSERT'], procedure: 'audit_log_fn' }), { force: true })).rejects.toThrow();
      expect(await relationExists(`tenant_${A.tenantId}_hooks2`, 'evt2')).toBe(false);
    });
  });
});
