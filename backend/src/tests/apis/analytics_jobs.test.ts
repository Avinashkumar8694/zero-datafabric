import request from 'supertest';
import { app } from '../../index';
import { getAdminToken, cleanupTenant } from './test_helper';

describe('GET /api/analytics/jobs/:jobId', () => {
    let adminToken: string;
    let jobId: string;
    const testTenantId = 'analytics_jobs_tenant';

    beforeAll(async () => {
        adminToken = await getAdminToken();
        await request(app).post('/api/admin/tenants').set('Authorization', `Bearer ${adminToken}`).send({ id: testTenantId, name: 'Analytics Jobs' });

        const tokenRes = await request(app).post('/api/auth/token').set('Authorization', `Bearer ${adminToken}`).send({ tenantId: testTenantId });
        const scopedToken = tokenRes.body.token;

        await request(app).post('/api/queries/exec').set('Authorization', `Bearer ${scopedToken}`).send({
            sql: `CREATE TABLE IF NOT EXISTS "tenant_${testTenantId}"."jobs_test" (id SERIAL)`
        });

        const res = await request(app)
            .post('/api/analytics/query-async')
            .set('Authorization', `Bearer ${scopedToken}`)
            .send({ queryConfig: { type: 'SELECT', table: 'jobs_test', limit: 1 } });
        jobId = res.body.jobId;
    });

    afterAll(async () => {
        await cleanupTenant(testTenantId);
    });

    it('Success: Retrieve background job status', async () => {
        const tokenRes = await request(app).post('/api/auth/token').set('Authorization', `Bearer ${adminToken}`).send({ tenantId: testTenantId });
        const scopedToken = tokenRes.body.token;

        const res = await request(app)
            .get(`/api/analytics/jobs/${jobId}`)
            .set('Authorization', `Bearer ${scopedToken}`);
        expect(res.status).toBe(200);
        expect(res.body).toHaveProperty('status');
    });

    it('Failure: Return 404 for invalid jobId', async () => {
        const tokenRes = await request(app).post('/api/auth/token').set('Authorization', `Bearer ${adminToken}`).send({ tenantId: testTenantId });
        const scopedToken = tokenRes.body.token;

        await request(app)
            .get('/api/analytics/jobs/ghost_job_123')
            .set('Authorization', `Bearer ${scopedToken}`)
            .expect(404);
    });
});
