import request from 'supertest';
import { app } from '../../index';
import { getAdminToken, cleanupTenant } from './test_helper';

describe('POST /api/admin/tenants', () => {
    let adminToken: string;
    const testId = 'create_test_tenant';

    beforeAll(async () => {
        adminToken = await getAdminToken();
    });

    afterAll(async () => {
        await cleanupTenant(testId);
    });

    it('Success: Create a new tenant environment', async () => {
        await request(app)
            .post('/api/admin/tenants')
            .set('Authorization', `Bearer ${adminToken}`)
            .send({ id: testId, name: 'Create Test Tenant' })
            .expect(201);
    });

    it('Failure: Prevent duplicate tenant ID', async () => {
        await request(app)
            .post('/api/admin/tenants')
            .set('Authorization', `Bearer ${adminToken}`)
            .send({ id: testId, name: 'Duplicate' })
            .expect(500);
    });

    it('Success: Update an existing tenant', async () => {
        const res = await request(app)
            .put(`/api/admin/tenants/${testId}`)
            .set('Authorization', `Bearer ${adminToken}`)
            .send({ name: 'Updated Tenant Name', status: 'SUSPENDED' });
        
        expect(res.status).toBe(200);
        expect(res.body.name).toBe('Updated Tenant Name');
        expect(res.body.status).toBe('SUSPENDED');
    });

    it('Failure: Require ADMIN role', async () => {
        // We simulate a non-admin by generating a token for a non-existent tenant/user if possible
        // But for now, we just test 401 (no token)
        await request(app).post('/api/admin/tenants').send({ id: 'fail', name: 'Fail' }).expect(401);
    });
});
