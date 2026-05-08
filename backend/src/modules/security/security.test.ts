import request from 'supertest';
import { app } from '../../index';
import { pool, queryWithContext } from '../../config/database';
import jwt from 'jsonwebtoken';

describe('Module 3: Security & Governance', () => {
  const secret = process.env.JWT_SECRET || 'reallyreallyreallyreallyverysecret';
  
  const tokenA = jwt.sign({ tenant_id: 'sec_tenant_A', username: 'user_A', internal_role: 'ADMIN' }, secret);
  const tokenB = jwt.sign({ tenant_id: 'sec_tenant_B', username: 'user_B', internal_role: 'ADMIN' }, secret);

  beforeAll(async () => {
    // 2. Setup tenants and data
    await pool.query("INSERT INTO public.tenants (id, name) VALUES ('sec_tenant_A', 'Sec Tenant A'), ('sec_tenant_B', 'Sec Tenant B') ON CONFLICT DO NOTHING");
    await pool.query("INSERT INTO public.data_sources (tenant_id, name, type, config) VALUES ('sec_tenant_A', 'Sec Source A', 'postgres', '{}') ON CONFLICT DO NOTHING");
    await pool.query("INSERT INTO public.data_sources (tenant_id, name, type, config) VALUES ('sec_tenant_B', 'Sec Source B', 'postgres', '{}') ON CONFLICT DO NOTHING");
  });

  afterAll(async () => {
    await pool.query("DELETE FROM public.data_sources WHERE tenant_id IN ('sec_tenant_A', 'sec_tenant_B')");
    await pool.query("DELETE FROM public.users WHERE tenant_id IN ('sec_tenant_A', 'sec_tenant_B')");
    await pool.query("DELETE FROM public.tenants WHERE id IN ('sec_tenant_A', 'sec_tenant_B')");
  });

  describe('3.1 Row-Level Security (RLS)', () => {
    it('should only return data belonging to the authenticated tenant', async () => {
      // Test with Tenant A
      const resA = await request(app)
        .get('/api/admin/connections')
        .set('Authorization', `Bearer ${tokenA}`);

      expect(resA.status).toBe(200);
      const dataA = resA.body;
      expect(dataA.every((item: any) => item.tenant_id === 'sec_tenant_A')).toBe(true);
      expect(dataA.some((item: any) => item.name === 'Sec Source A')).toBe(true);
      expect(dataA.some((item: any) => item.name === 'Sec Source B')).toBe(false);

      // Test with Tenant B
      const resB = await request(app)
        .get('/api/admin/connections')
        .set('Authorization', `Bearer ${tokenB}`);

      expect(resB.status).toBe(200);
      const dataB = resB.body;
      expect(dataB.every((item: any) => item.tenant_id === 'sec_tenant_B')).toBe(true);
      expect(dataB.some((item: any) => item.name === 'Sec Source B')).toBe(true);
      expect(dataB.some((item: any) => item.name === 'Sec Source A')).toBe(false);
    });

    it('should prevent cross-tenant insertion', async () => {
      const res = await request(app)
        .post('/api/admin/connections')
        .set('Authorization', `Bearer ${tokenA}`)
        .send({
          tenantId: 'sec_tenant_B', // Attempting to insert for B while logged in as A
          name: 'Hacker Source',
          config: { host: 'localhost', port: 5432, dbName: 'db', user: 'u', pass: 'p' }
        });

      // If RLS works, it should either fail or be corrected to A.
      // But since this is a security test, we expect the platform to block it.
      expect(res.status).not.toBe(201); 
    });
  });

  describe('3.2 Audit Logging', () => {
    it('should create an audit log entry on data modification', async () => {
      // Clear previous logs for cleanliness
      await pool.query("DELETE FROM fabric_admin.audit_logs WHERE tenant_id = 'sec_tenant_A'");

      // Trigger an update
      const res = await request(app)
        .post('/api/admin/connections')
        .set('Authorization', `Bearer ${tokenA}`)
        .send({
          tenantId: 'sec_tenant_A',
          name: 'Audit Test Source',
          config: { host: 'dummy', type: 'postgres', syncType: 'VIRTUAL' }
        });
      
      if (res.status !== 201) console.error('POST /api/admin/connections FAILED:', res.body);
      expect(res.status).toBe(201);

      // Check audit logs (with slight delay for trigger propagation)
      await new Promise(r => setTimeout(r, 500));
      const { rows } = await pool.query("SELECT * FROM fabric_admin.audit_logs WHERE tenant_id = 'sec_tenant_A' ORDER BY changed_at DESC LIMIT 1");
      expect(rows.length).toBeGreaterThan(0);
      expect(rows[0].action).toBe('INSERT');
      expect(rows[0].user_name).toBe('user_A');
      expect(rows[0].tenant_id).toBe('sec_tenant_A');
    });
  });

  describe('3.3 Catalog Isolation', () => {
    it('should prevent Tenant B from seeing metadata of Tenant A', async () => {
      const schemaA = 'tenant_sec_tenant_A';
      
      await pool.query(`
        INSERT INTO fabric_catalog.metadata (schema_name, table_name, column_name, data_type) 
        VALUES ($1, 'orders', 'id', 'integer')
        ON CONFLICT DO NOTHING;
      `, [schemaA]);

      // 2. Tenant B queries catalog (fully qualified)
      const userB = { tenantId: 'sec_tenant_B', username: 'user_B' };
      const { rows } = await queryWithContext('SELECT * FROM "fabric_catalog"."metadata"', [], userB);

      // 3. Should not see Tenant A's metadata
      const hasTenantA = rows.some((r: any) => r.schema_name === schemaA);
      expect(hasTenantA).toBe(false);
    });
  });
});
