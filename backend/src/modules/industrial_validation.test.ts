import request from 'supertest';
import { app } from '../index';
import { pool } from '../config/database';
import jwt from 'jsonwebtoken';
import bcrypt from 'bcrypt';

describe('Module 5: Industrial Edge-Case Validation', () => {
  const secret = process.env.JWT_SECRET || 'reallyreallyreallyreallyverysecret';
  let adminToken: string;
  let userToken: string;
  const testTenant = 'edge_tenant';
  const testUser = 'edge_user';

  beforeAll(async () => {
    // 1. Setup Tenant and Admin
    await pool.query("INSERT INTO public.tenants (id, name) VALUES ($1, 'Edge Test Tenant') ON CONFLICT DO NOTHING", [testTenant]);
    await pool.query("SELECT fabric_admin.create_tenant_namespace($1)", [testTenant]);
    
    const hash = await bcrypt.hash('password', 10);
    const adminRes = await pool.query(
      "INSERT INTO public.users (username, password_hash, tenant_id, role) VALUES ('edge_admin', $1, $2, 'ADMIN') RETURNING *",
      [hash, testTenant]
    );
    adminToken = jwt.sign({ tenant_id: testTenant, username: 'edge_admin', internal_role: 'ADMIN', role: 'fabric_user' }, secret);

    const userRes = await pool.query(
      "INSERT INTO public.users (username, password_hash, tenant_id, role) VALUES ($1, $2, $3, 'USER') RETURNING id",
      [testUser, hash, testTenant]
    );
    userToken = jwt.sign({ tenant_id: testTenant, username: testUser, internal_role: 'USER', role: 'fabric_user' }, secret);
  });

  afterAll(async () => {
    await pool.query("DELETE FROM public.users WHERE tenant_id = $1", [testTenant]);
    await pool.query("DELETE FROM public.tenants WHERE id = $1", [testTenant]);
  });

  describe('5.1 Advanced IAM Scenarios', () => {
    it('should prevent a standard USER from creating other users', async () => {
      const res = await request(app)
        .post('/api/admin/users')
        .set('Authorization', `Bearer ${userToken}`)
        .send({ username: 'hacker', password: '123', tenantId: testTenant });

      // Note: We currently don't have strict Role checks in the Node.js route yet, 
      // but RLS should technically handle the INSERT if configured.
      // However, we should ideally have a 403 at the app level.
      // Let's see if our RLS policy handles it (it has OR internal_role = 'ADMIN')
      // Wait! fabric_user has INSERT on public.users. 
      // But the policy: tenant_id = current_setting(...) OR internal_role = 'ADMIN'
      // If a USER inserts a row for their own tenant, it might SUCCEED.
      // INDUSTRIAL REQUIREMENT: Only ADMIN should manage users.
      
      // For now, let's just assert what happens and then fix the code if needed.
      // I expect 403 if we implement it, but 201 if we don't.
      // I will implement the 403 check in index.ts next.
      expect(res.status).toBe(403); 
    });

    it('should allow an ADMIN to delete a user', async () => {
        const { rows } = await pool.query("SELECT id FROM public.users WHERE username = $1", [testUser]);
        const userId = rows[0].id;

        const res = await request(app)
            .delete(`/api/admin/users/${userId}`)
            .set('Authorization', `Bearer ${adminToken}`);

        expect(res.status).toBe(200);
        
        const check = await pool.query("SELECT * FROM public.users WHERE id = $1", [userId]);
        expect(check.rows.length).toBe(0);
    });
  });

  describe('5.2 Tenant Lifecycle Enforcement', () => {
    it('should prevent queries when a tenant is SUSPENDED', async () => {
        // Suspend tenant
        await pool.query("UPDATE public.tenants SET status = 'SUSPENDED' WHERE id = $1", [testTenant]);

        const res = await request(app)
            .post('/api/queries/exec')
            .set('Authorization', `Bearer ${adminToken}`)
            .send({ sql: 'SELECT 1' });

        // Currently, we don't check tenant status in the query engine.
        // Let's implement this "Industrial" check.
        expect(res.status).toBe(403);
        expect(res.body.error).toContain('suspended');
        
        // Resume for cleanup
        await pool.query("UPDATE public.tenants SET status = 'ACTIVE' WHERE id = $1", [testTenant]);
    });
  });

  describe('5.3 Async Query State', () => {
    it('should poll status of an async query', async () => {
        const res = await request(app)
            .post('/api/queries/exec')
            .set('Authorization', `Bearer ${adminToken}`)
            .send({ sql: 'SELECT pg_sleep(0.1)', async: true });

        expect(res.status).toBe(202);
        const queryId = res.body.queryId;

        const statusRes = await request(app)
            .get(`/api/queries/status/${queryId}`)
            .set('Authorization', `Bearer ${adminToken}`);

        expect(statusRes.status).toBe(200);
        expect(statusRes.body.status).toBeDefined();
    });
  });
});
