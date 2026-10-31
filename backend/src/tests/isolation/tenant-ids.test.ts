/**
 * T5 (tenant-id prefix collision rejected at creation) and T6 (LIKE wildcard / prefix ids never leak across tenants).
 */
import { app, pool, request, mkTenant, mkTable, auth, adminToken, suffix, cleanupAll, TestTenant } from './harness';
import { queryWithContext } from '../../config/database';
import { TenantService } from '../../modules/tenant/tenant.service';
import { MetadataService } from '../../modules/metadata/metadata.service';
import { CleanupService } from '../../services/cleanup.service';
import { QueryEngineService } from '../../modules/query-engine/query-engine.service';
import { ssoTenantId } from '../../controllers/authController';
import { assertTenantId } from '../../utils/identifiers';

jest.setTimeout(60000);

describe('Isolation: tenant id rules', () => {
  const s = suffix();
  const extra: string[] = [];
  afterAll(async () => { await cleanupAll(extra); });

  describe('T5: syntax + no-overlap rule at creation (HTTP, platform admin)', () => {
    const create = (id: string) => request(app).post('/api/admin/tenants').set(auth(adminToken())).send({ id, name: `ids ${id}` });

    it('rejects ids that are not plain identifiers (400 INVALID_IDENTIFIER) and never provisions anything', async () => {
      for (const id of ['bad-id', 'has space', 'x"; DROP SCHEMA public CASCADE; --', '1starts_digit', 'a', "o'neil", 'dot.ted', 'a'.repeat(60)]) {
        const r = await create(id);
        expect(r.status).toBe(400);
        expect(r.body.code).toBe('INVALID_IDENTIFIER');
      }
      const { rows } = await pool.query(`SELECT count(*)::int AS n FROM public.tenants WHERE id IN ('bad-id','has space','a')`);
      expect(rows[0].n).toBe(0);
    });

    it('rejects X when an existing E satisfies X.startsWith(E_), in both directions, case-insensitively, with 409 TENANT_ID_OVERLAP', async () => {
      const base = `ov_${s}`;
      extra.push(base, `${base}_x`, `ovb_${s}_x`, `ovb_${s}`, `OV_${s}_Y`);
      expect((await create(base)).status).toBe(201);
      const longer = await create(`${base}_x`);
      expect(longer.status).toBe(409);
      expect(longer.body.code).toBe('TENANT_ID_OVERLAP');
      expect((await create(`OV_${s}_Y`)).status).toBe(409);
      // the other direction: longer id first, then its prefix
      expect((await create(`ovb_${s}_x`)).status).toBe(201);
      const shorter = await create(`ovb_${s}`);
      expect(shorter.status).toBe(409);
      expect(shorter.body.code).toBe('TENANT_ID_OVERLAP');
      // nothing was provisioned for the rejected ids
      const sch = await pool.query(`SELECT schema_name FROM information_schema.schemata WHERE schema_name IN ($1, $2)`, [`tenant_${base}_x`, `tenant_ovb_${s}`]);
      expect(sch.rows).toEqual([]);
    });

    it('ids that merely share a prefix without the "_" boundary are fine', async () => {
      const a = `pf_${s}`; const b = `pf_${s}x`;
      extra.push(a, b);
      expect((await create(a)).status).toBe(201);
      expect((await create(b)).status).toBe(201);
    });

    it('concurrent creation of overlapping ids lets exactly one win (advisory lock)', async () => {
      const a = `cc_${s}`; const b = `cc_${s}_a`;
      extra.push(a, b);
      const res = await Promise.allSettled([TenantService.createTenant(a, 'a'), TenantService.createTenant(b, 'b')]);
      expect(res.filter((r) => r.status === 'fulfilled').length).toBe(1);
      const rejected = res.find((r) => r.status === 'rejected') as PromiseRejectedResult;
      expect((rejected.reason as any).code).toBe('TENANT_ID_OVERLAP');
    });

    it('SSO auto-provisioned ids satisfy the same rules (long emails shortened, hash fallback)', () => {
      for (const email of ['john@example.com', 'a.very.long.address.of.someone.important@subdomain.example-corporation.co.uk', 'x@y', 'ünï@çödé.io']) {
        const id = ssoTenantId(email);
        expect(() => assertTenantId(id)).not.toThrow();
        expect(() => assertTenantId(ssoTenantId(email, true))).not.toThrow();
      }
      expect(ssoTenantId('a@b.c', true)).not.toBe(ssoTenantId('a@b.d', true));
    });
  });

  describe('T6: LIKE wildcards and prefixes do not match other tenants', () => {
    let T1: TestTenant; let T2: TestTenant;
    beforeAll(async () => {
      // `_` is a LIKE wildcard: 'tenant_wq_<s>%' also matches 'tenant_wqx<s>' unless it is escaped.
      T1 = await mkTenant(`wq_${s}`);
      T2 = await mkTenant(`wqx${s}`);
      await mkTable(T1, 'one', [{ v: 'T1-row' }]);
      await mkTable(T2, 'two', [{ v: 'T2-row' }]);
      await pool.query(`CREATE SCHEMA "tenant_${T1.id}_sub"`);
      await pool.query(`CREATE SCHEMA "tenant_${T2.id}_sub"`);
      await pool.query(`GRANT USAGE ON SCHEMA "tenant_${T1.id}_sub", "tenant_${T2.id}_sub" TO fabric_user`);
    });

    it('search_path of T1 contains its own schemas only', async () => {
      const r = await queryWithContext('SHOW search_path', [], { tenantId: T1.id, username: 'x' });
      const sp: string = r.rows[0].search_path;
      expect(sp).toContain(`tenant_${T1.id}`);
      expect(sp).toContain(`tenant_${T1.id}_sub`);
      expect(sp).not.toContain(`tenant_${T2.id}`);
    });

    it('MetadataService.crawlTenant registers only the tenant\'s own schemas', async () => {
      await MetadataService.crawlTenant(T1.id);
      const { rows } = await pool.query(`SELECT physical_name FROM public.catalog_schemas WHERE source_id IS NULL AND physical_name LIKE 'tenant\\_wq%' ESCAPE '\\'`);
      const names = rows.map((r) => r.physical_name);
      expect(names).toContain(`tenant_${T1.id}`);
      expect(names.some((n: string) => n.startsWith(`tenant_${T2.id}`))).toBe(false);
    });

    it('catalog summary, legacy table lookup and metadata RLS stay inside the tenant', async () => {
      await pool.query(`INSERT INTO fabric_catalog.metadata (schema_name, table_name, column_name, data_type) VALUES ($1,'t','c1','int'), ($2,'t','c2','int')`, [`tenant_${T1.id}`, `tenant_${T2.id}`]);
      const sum = await request(app).get('/api/admin/catalog').set(auth(T1.owner.token));
      expect(sum.status).toBe(200);
      expect(JSON.stringify(sum.body)).not.toContain(T2.id);
      const legacy = await request(app).get('/api/metadata/tables/t').set(auth(T1.owner.token));
      expect(legacy.body.columns.map((c: any) => c.column_name)).toEqual(['c1']);
      const rls = await queryWithContext('SELECT schema_name FROM fabric_catalog.metadata', [], { tenantId: T1.id, username: 'x' });
      expect(rls.rows.map((r) => r.schema_name).every((n: string) => n === `tenant_${T1.id}` || n.startsWith(`tenant_${T1.id}_`))).toBe(true);
    });

    it('a schema name that looks like another tenant\'s is namespaced under the caller, never resolved to the other tenant', async () => {
      const resolve = (QueryEngineService as any).toTenantSchemaName.bind(QueryEngineService);
      expect(resolve(T1.id, `tenant_${T2.id}`)).toBe(`tenant_${T1.id}_tenant_${T2.id}`);
      expect(resolve(T1.id, undefined)).toBe(`tenant_${T1.id}`);
      expect(resolve(T1.id, 'sub')).toBe(`tenant_${T1.id}_sub`);
      expect(resolve(T1.id, `tenant_${T1.id}_sub`)).toBe(`tenant_${T1.id}_sub`);
      for (const bad of ['public', 'pg_catalog', 'information_schema', 'fabric_admin', 'fabric_system', 'FABRIC_CATALOG']) expect(() => resolve(T1.id, bad)).toThrow(/ACCESS DENIED/);
      for (const bad of ['a-b', 'a b', "a'b", 'a"b', 'x'.repeat(80)]) expect(() => resolve(bad, undefined)).toThrow(/Invalid tenant id/);
    });

    it('cleanup of T1 never touches T2 (exact schema match, tolerant per step)', async () => {
      const failures = await CleanupService.purgeTenant(T1.id);
      // optional registry tables may be missing on this DB: those steps are reported, the rest still ran
      const sch = await pool.query(`SELECT schema_name FROM information_schema.schemata WHERE schema_name LIKE 'tenant\\_wq%' ESCAPE '\\' ORDER BY 1`);
      const names = sch.rows.map((r) => r.schema_name);
      expect(names).toContain(`tenant_${T2.id}`);
      expect(names).toContain(`tenant_${T2.id}_sub`);
      expect(names).not.toContain(`tenant_${T1.id}_sub`); // T1's sub-schema is dropped
      expect(names).toContain(`tenant_${T1.id}`);         // primary namespace is re-created empty
      const t1tables = await pool.query(`SELECT 1 FROM information_schema.tables WHERE table_schema = $1`, [`tenant_${T1.id}`]);
      expect(t1tables.rows.length).toBe(0);
      const t2tables = await pool.query(`SELECT 1 FROM information_schema.tables WHERE table_schema = $1 AND table_name = 'two'`, [`tenant_${T2.id}`]);
      expect(t2tables.rows.length).toBe(1);
      expect(Array.isArray(failures)).toBe(true);
      // a step with a non-existent table does not abort the rest: the schema drop above happened even if failures is non-empty
    });
  });
});
