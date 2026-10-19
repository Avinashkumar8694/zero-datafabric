import request from 'supertest';
import express from 'express';
import { app } from '../../index';
import { pool } from '../../config/database';
import { MetadataOrchestrator } from '../../modules/metadata/orchestrator';
import { ManifestValidationError } from '../../modules/metadata/manifest_validator';
import { manifestUploadSingle } from '../../modules/metadata/manifest_upload';
import { ManifestParser, MANIFEST_MAX_BYTES } from '../../modules/metadata/manifest_parser';
import { createWorkspace, cleanupWorkspace, relationExists, schemaExists, listTenantSchemas, Workspace } from './_helpers';

jest.setTimeout(60000);

const orchestrator = new MetadataOrchestrator();
const col = (name: string, type = 'TEXT', extra: any = {}) => ({ name, type, ...extra });
const tbl = (name: string, columns: any[] = [col('id', 'UUID', { primaryKey: true })]) => ({ type: 'TABLE', name, columns });
const manifest = (resources: any[], schema = 'sales', extra: any = {}) => ({ version: '4.0', schemas: [{ name: schema, resources }], ...extra });

describe('manifest apply hardening (DB-backed)', () => {
  let A: Workspace; let B: Workspace; const canary = `hd_canary_${Date.now()}`;

  beforeAll(async () => {
    A = await createWorkspace('mfa');
    B = await createWorkspace('mfb');
    await pool.query(`CREATE TABLE public.${canary} (id int)`);
    await pool.query(`INSERT INTO public.${canary} VALUES (1)`);
    await pool.query(`CREATE TABLE "tenant_${B.tenantId}"."b_secret" (id int)`);
  });
  afterAll(async () => {
    await pool.query(`DROP TABLE IF EXISTS public.${canary}`);
    await cleanupWorkspace(A.tenantId); await cleanupWorkspace(B.tenantId);
  });

  const apply = (token: string, body: any) => request(app).post('/api/metadata/apply?force=true').set('Authorization', `Bearer ${token}`).send(body);
  const canaryAlive = async () => (await pool.query(`SELECT count(*)::int AS n FROM public.${canary}`)).rows[0].n === 1;

  it('applies a valid manifest as the workspace owner (baseline)', async () => {
    const res = await apply(A.ownerToken, manifest([
      { type: 'ENUM', name: 'st', values: ['A', 'B'] },
      { type: 'TABLE', name: 'orders', columns: [col('id', 'UUID', { primaryKey: true, default: 'gen_random_uuid()' }), col('status', 'st', { default: "'A'" }), col('total', 'NUMERIC(10,2)', { default: 0 }), col('created_at', 'TIMESTAMP', { default: 'NOW()', index: { type: 'BTREE' } })], constraints: [{ name: 'chk_total', type: 'CHECK', expression: 'total >= 0' }] },
    ]));
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('APPLIED');
    expect(await relationExists(`tenant_${A.tenantId}_sales`, 'orders')).toBe(true);
  });

  it('is atomic: a failing resource in the middle rolls back the earlier ones (and the schema)', async () => {
    const before = await listTenantSchemas(A.tenantId);
    const m = manifest([
      tbl('atom_first'),
      // passes validation (a function call is allowed) but fails inside Postgres
      { type: 'TABLE', name: 'atom_bad', columns: [col('id', 'UUID'), col('x', 'TEXT', { default: 'no_such_function_here()' })] },
      tbl('atom_last'),
    ], 'atomic');
    const res = await apply(A.ownerToken, m);
    expect(res.status).toBeGreaterThanOrEqual(400);
    for (const t of ['atom_first', 'atom_bad', 'atom_last']) expect(await relationExists(`tenant_${A.tenantId}_atomic`, t)).toBe(false);
    expect(await schemaExists(`tenant_${A.tenantId}_atomic`)).toBe(false);
    expect(await listTenantSchemas(A.tenantId)).toEqual(before);
    const hist = await pool.query(`SELECT count(*)::int AS n FROM fabric_system.metadata_history WHERE tenant_id = $1 AND ast_content::text LIKE '%atom_first%'`, [A.tenantId]);
    expect(hist.rows[0].n).toBe(0);
    const cat = await pool.query(`SELECT count(*)::int AS n FROM public.catalog_tables t JOIN public.catalog_schemas s ON s.id = t.schema_id JOIN public.data_sources d ON d.id = s.source_id WHERE d.tenant_id = $1 AND t.name LIKE 'atom_%'`, [A.tenantId]);
    expect(cat.rows[0].n).toBe(0);
  });

  describe('cross-tenant / reserved namespace refusal: nothing is applied', () => {
    const cases: Array<[string, string]> = [
      ['public', 'RESERVED_SCHEMA'],
      ['fabric_admin', 'RESERVED_SCHEMA'],
      ['fabric_system', 'RESERVED_SCHEMA'],
      ['information_schema', 'RESERVED_SCHEMA'],
      ['public.users', 'INVALID_IDENTIFIER'],
      ['fabric_admin.audit_logs', 'INVALID_IDENTIFIER'],
      ['tenant_other_x', 'CROSS_TENANT_SCHEMA'],
      [`tenant_${'__B__'}_x`, 'CROSS_TENANT_SCHEMA'],
      [`tenant_${'__B__'}`, 'CROSS_TENANT_SCHEMA'],
    ];
    it.each(cases)('refuses schema %s', async (name, code) => {
      const schemaName = name.replace('__B__', B.tenantId);
      const schemasBefore = await listTenantSchemas(A.tenantId);
      const bBefore = await listTenantSchemas(B.tenantId);
      const res = await apply(A.ownerToken, manifest([tbl('xt_table')], schemaName));
      expect(res.status).toBe(400);
      expect(JSON.stringify(res.body)).toContain(code);
      expect(JSON.stringify(res.body)).toContain('Validation');
      expect(await listTenantSchemas(A.tenantId)).toEqual(schemasBefore);
      expect(await listTenantSchemas(B.tenantId)).toEqual(bBefore);
      expect(await relationExists('public', 'xt_table')).toBe(false);
      expect(await canaryAlive()).toBe(true);
    });
    it('the victim tenant keeps its data and the attacker cannot reach it through resource names either', async () => {
      const res = await apply(A.ownerToken, manifest([tbl(`tenant_${B.tenantId}.b_secret`)], 'sales'));
      expect(res.status).toBe(400);
      expect((await pool.query(`SELECT count(*)::int AS n FROM "tenant_${B.tenantId}"."b_secret"`)).rows[0].n).toBe(0);
      expect(await relationExists(`tenant_${B.tenantId}`, 'b_secret')).toBe(true);
    });
  });

  describe('injection corpus: refused with 400, nothing executed', () => {
    const bad = [`x"; DROP TABLE public.${'CANARY'};--`, `x"; DROP SCHEMA public CASCADE;--`, 'a b', 'a'.repeat(64), 'ａdmin', 'public.users', `a'b`];
    it.each(bad)('table name %j', async (name) => {
      const res = await apply(A.ownerToken, manifest([tbl(name.replace('CANARY', canary))]));
      expect(res.status).toBe(400);
      expect(await canaryAlive()).toBe(true);
    });
    it.each([
      ['column type', col('c', `text); DROP TABLE public.${'CANARY'};--`)],
      ['default', col('c', 'TEXT', { default: `now(); DROP TABLE public.${'CANARY'}` })],
      ['column name', col(`c"; DROP TABLE public.${'CANARY'};--`)],
      ['generated', col('c', 'TEXT', { generated: `1); DROP TABLE public.${'CANARY'};--` })],
    ])('column %s', async (_l, c: any) => {
      const s = JSON.stringify(c).replace(/CANARY/g, canary);
      const res = await apply(A.ownerToken, manifest([tbl('inj_cols', [col('id', 'UUID'), JSON.parse(s)])]));
      expect(res.status).toBe(400);
      expect(await canaryAlive()).toBe(true);
      expect(await relationExists(`tenant_${A.tenantId}_sales`, 'inj_cols')).toBe(false);
    });
    it('check constraint / policy using / extension', async () => {
      const r1 = await apply(A.ownerToken, manifest([{ ...tbl('inj_chk'), constraints: [{ name: 'c1', type: 'CHECK', expression: `true); DROP TABLE public.${canary}; --` }] }]));
      expect(r1.status).toBe(400);
      const r2 = await apply(A.ownerToken, manifest([{ ...tbl('inj_pol'), security: { enable_rls: true, policies: [{ name: 'p', using: `true); DROP TABLE public.${canary}; --` }] } }]));
      expect(r2.status).toBe(400);
      const r3 = await apply(A.ownerToken, manifest([tbl('inj_ext')], 'sales', { extensions: ['dblink'] }));
      expect(r3.status).toBe(400);
      expect(await canaryAlive()).toBe(true);
    });
    it('unknown top-level key lists the key; proto pollution keys are refused', async () => {
      const res = await apply(A.ownerToken, { ...manifest([tbl('x')]), evilKey: 1, another: 2 });
      expect(res.status).toBe(400);
      expect(JSON.stringify(res.body)).toMatch(/evilKey/);
      const proto = await request(app).post('/api/metadata/apply').set('Authorization', `Bearer ${A.ownerToken}`).set('Content-Type', 'application/json')
        .send('{"version":"4.0","schemas":[{"name":"s","resources":[]}],"__proto__":{"polluted":true}}');
      expect(proto.status).toBeGreaterThanOrEqual(400);
      expect(({} as any).polluted).toBeUndefined();
    });
  });

  describe('free-form SQL gate (AST only)', () => {
    const fn = { type: 'FUNCTION', name: 'hd_fn', returnType: 'INTEGER', arguments: [], body: 'RETURN 1;' };
    it('an owner without permission gets FREE_SQL_NOT_ALLOWED and nothing is created', async () => {
      const res = await apply(A.ownerToken, manifest([tbl('fs_t'), fn], 'freesql'));
      expect(res.status).toBe(400);
      expect(JSON.stringify(res.body)).toContain('FREE_SQL_NOT_ALLOWED');
      expect(await schemaExists(`tenant_${A.tenantId}_freesql`)).toBe(false);
    });
    it('raw expressions inside a view AST are refused the same way', async () => {
      const res = await apply(A.ownerToken, manifest([tbl('fs_t2'), { type: 'VIEW', name: 'v1', query: { from: { resource: 'fs_t2' }, select: [{ expression: 'count(*)', alias: 'n' }] } }], 'freesql2'));
      expect(res.status).toBe(400);
      expect(JSON.stringify(res.body)).toContain('FREE_SQL_NOT_ALLOWED');
    });
    it('an AST-only view works for the owner', async () => {
      const res = await apply(A.ownerToken, manifest([tbl('fs_t3', [col('id', 'UUID'), col('region')]), { type: 'VIEW', name: 'v_cnt', query: { from: { resource: 'fs_t3' }, select: ['region', { aggregate: 'COUNT', alias: 'n' }], groupBy: ['region'] } }], 'astview'));
      expect(res.status).toBe(200);
      expect(await relationExists(`tenant_${A.tenantId}_astview`, 'v_cnt')).toBe(true);
    });
    it('platform admin (or an explicitly allowed owner) can apply function bodies; the body still cannot break out', async () => {
      const ok = await orchestrator.apply(A.tenantId, manifest([tbl('fs_t4'), fn], 'freesql_admin') as any, { force: true, isPlatformAdmin: true });
      expect(ok.status).toBe('APPLIED');
      const p = await pool.query(`SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace WHERE n.nspname = $1 AND p.proname = 'hd_fn'`, [`tenant_${A.tenantId}_freesql_admin`]);
      expect(p.rows.length).toBe(1);
      await expect(orchestrator.apply(A.tenantId, manifest([{ ...fn, name: 'hd_fn2', body: `x $$; DROP TABLE public.${canary}; $$` }], 'freesql_admin2') as any, { force: true, isPlatformAdmin: true })).rejects.toBeInstanceOf(ManifestValidationError);
      expect(await canaryAlive()).toBe(true);
      const owner = await orchestrator.apply(A.tenantId, manifest([{ ...fn, name: 'hd_fn3' }], 'freesql_owner') as any, { force: true, allowFreeSql: true });
      expect(owner.status).toBe('APPLIED');
    });
  });

  describe('diff / dry-run / rollback / import go through the same validation', () => {
    const evil = () => manifest([tbl('d1')], 'public');
    it('plan() and apply() reject with ManifestValidationError before touching the DB', async () => {
      await expect(orchestrator.plan(A.tenantId, evil() as any)).rejects.toBeInstanceOf(ManifestValidationError);
      await expect(orchestrator.apply(A.tenantId, evil() as any, { force: true })).rejects.toBeInstanceOf(ManifestValidationError);
      await expect(orchestrator.plan('a"b', manifest([tbl('d1')]) as any)).rejects.toThrow();
    });
    it('HTTP diff refuses an evil manifest', async () => {
      const res = await request(app).post('/api/metadata/diff').set('Authorization', `Bearer ${A.ownerToken}`).send(evil());
      expect(res.status).toBeGreaterThanOrEqual(400);
      expect(JSON.stringify(res.body)).toContain('RESERVED_SCHEMA');
    });
    it('rollback re-validates the stored snapshot (tampered / pre-hardening history)', async () => {
      const bad = manifest([tbl('rb')], 'fabric_admin');
      const ins = await pool.query(`INSERT INTO fabric_system.metadata_history (tenant_id, version_tag, ast_content, summary) VALUES ($1, 'x', $2, '{}') RETURNING id`, [A.tenantId, JSON.stringify(bad)]);
      await expect(orchestrator.rollback(A.tenantId, ins.rows[0].id)).rejects.toBeInstanceOf(ManifestValidationError);
      await expect(orchestrator.rollback(A.tenantId, `${ins.rows[0].id}'; DROP TABLE x;--`)).rejects.toThrow('Version not found');
      // another tenant's history id is invisible
      const other = await pool.query(`INSERT INTO fabric_system.metadata_history (tenant_id, version_tag, ast_content, summary) VALUES ($1, 'x', $2, '{}') RETURNING id`, [B.tenantId, JSON.stringify(manifest([tbl('rb2')]))]);
      await expect(orchestrator.rollback(A.tenantId, other.rows[0].id)).rejects.toThrow('Version not found');
    });
    it('a legitimate manifest still round-trips: apply -> history -> rollback', async () => {
      const m = manifest([tbl('rt_one')], 'roundtrip');
      await orchestrator.apply(A.tenantId, m as any, { force: true });
      const hist = await orchestrator.getHistory(A.tenantId);
      const mine = hist.find((h: any) => true);
      const res = await orchestrator.rollback(A.tenantId, mine.id, {});
      expect(res.status).toBe('APPLIED');
    });
  });

  describe('upload: size cap, JSON/YAML only, safe parsing', () => {
    const mini = express();
    mini.post('/up', manifestUploadSingle, (req, res) => {
      try { res.json({ ok: true, version: ManifestParser.parse((req as any).file.buffer).version }); } catch (e: any) { res.status(e.status || 400).json({ error: e.message, code: e.code }); }
    });
    it('accepts JSON and YAML files', async () => {
      const j = await request(mini).post('/up').attach('file', Buffer.from('{"version":"4.0","schemas":[]}'), 'm.json');
      expect(j.status).toBe(200);
      const y = await request(mini).post('/up').attach('file', Buffer.from('version: "4.0"\nschemas: []\n'), { filename: 'm.yaml', contentType: 'application/x-yaml' });
      expect(y.status).toBe(200);
    });
    it('refuses other types (415), oversize files (413), YAML aliases and prototype pollution', async () => {
      const exe = await request(mini).post('/up').attach('file', Buffer.from('MZ'), { filename: 'm.exe', contentType: 'application/octet-stream' });
      expect(exe.status).toBe(415);
      const sql = await request(mini).post('/up').attach('file', Buffer.from('DROP TABLE x;'), { filename: 'm.sql', contentType: 'text/plain' });
      expect(sql.status).toBe(415);
      const big = await request(mini).post('/up').attach('file', Buffer.alloc(MANIFEST_MAX_BYTES + 1024, 'a'), 'm.json');
      expect(big.status).toBe(413);
      const alias = await request(mini).post('/up').attach('file', Buffer.from('version: "4.0"\nschemas:\n  - &a {name: s, resources: []}\n  - *a\n'), 'm.yaml');
      expect(alias.status).toBe(400);
      expect(alias.body.code).toBe('YAML_ALIASES_NOT_ALLOWED');
      const proto = await request(mini).post('/up').attach('file', Buffer.from('{"version":"4.0","schemas":[],"__proto__":{"x":1}}'), 'm.json');
      expect(proto.status).toBe(400);
    });
  });
});
