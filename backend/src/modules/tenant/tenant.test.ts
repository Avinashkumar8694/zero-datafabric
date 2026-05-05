import request from 'supertest';
import { app } from '../../index';
import { pool } from '../../config/database';

describe('Module 1: Tenant Management', () => {
  const testTenantId = 'jest_test_tenant';

  afterAll(async () => {
    // Cleanup
    await pool.query('DELETE FROM public.tenants WHERE id = $1', [testTenantId]);
    await pool.query(`DROP SCHEMA IF EXISTS tenant_${testTenantId} CASCADE`);
    await pool.end();
  });

  it('should create a new tenant', async () => {
    const res = await request(app)
      .post('/api/admin/tenants')
      .send({
        id: testTenantId,
        name: 'Jest Test Tenant'
      });

    expect(res.status).toBe(201);
    expect(res.body).toHaveProperty('id', testTenantId);
    expect(res.body).toHaveProperty('name', 'Jest Test Tenant');
  });

  it('should fail to create a duplicate tenant', async () => {
    const res = await request(app)
      .post('/api/admin/tenants')
      .send({
        id: testTenantId,
        name: 'Duplicate Tenant'
      });

    expect(res.status).toBe(500);
    expect(res.body).toHaveProperty('error');
  });

  it('should delete a tenant', async () => {
    const res = await request(app)
      .delete(`/api/admin/tenants/${testTenantId}`);

    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('status', 'DELETED');
  });
});
