import request from 'supertest';
import { app } from '../../index';
import { getAdminToken, cleanupTenant, uniqueTenantId } from './test_helper';

describe('GET /api/analytics/jobs/:jobId', () => {
    let adminToken: string;
    let jobId: string;
    const testTenantId = uniqueTenantId('ajob');

    beforeAll(async () => {
        adminToken = await getAdminToken();
        await request(app).post('/api/admin/tenants').set('Authorization', `Bearer ${adminToken}`).send({ id: testTenantId, name: 'Analytics Jobs' });

        const tokenRes = await request(app).post('/api/auth/token').set('Authorization', `Bearer ${adminToken}`).send({ tenantId: testTenantId });
        const scopedToken = tokenRes.body.token;

        const applied = await request(app).post('/api/metadata/apply').set('Authorization', `Bearer ${scopedToken}`).send({
            version: '1.0',
            schemas: [{ name: 'core', resources: [{ type: 'TABLE', name: 'jobs_test', columns: [{ name: 'id', type: 'SERIAL', primaryKey: true }] }] }]
        });
        expect(applied.status).toBe(200);

        const res = await request(app)
            .post('/api/analytics/query-async')
            .set('Authorization', `Bearer ${scopedToken}`)
            .send({ queryConfig: { type: 'SELECT', schema: 'core', table: 'jobs_test', limit: 1 } });
        expect(res.status).toBe(202);
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
