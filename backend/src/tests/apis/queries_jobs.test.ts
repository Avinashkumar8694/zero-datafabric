import request from 'supertest';
import { app } from '../../index';
import { getAdminToken, cleanupTenant } from './test_helper';

describe('Queries: Industrial Raw SQL Async Processing', () => {
    let adminToken: string;
    const ts = Date.now();
    const testTenantId = `raw_job_test_${ts}`;
    let tenantToken: string;

    beforeAll(async () => {
        adminToken = await getAdminToken();
        await request(app).post('/api/admin/tenants').set('Authorization', `Bearer ${adminToken}`).send({ id: testTenantId, name: 'Raw Job' });
        
        const tokenRes = await request(app).post('/api/auth/token').set('Authorization', `Bearer ${adminToken}`).send({ tenantId: testTenantId });
        tenantToken = tokenRes.body.token;
    });

    afterAll(async () => {
        await cleanupTenant(testTenantId);
    });

    it('Success: Execute raw SQL in background and poll for results', async () => {
        // 1. Dispatch
        const dispatchRes = await request(app)
            .post('/api/queries/exec')
            .set('Authorization', `Bearer ${tenantToken}`)
            .send({ sql: 'SELECT 42 as answer', async: true });

        expect(dispatchRes.status).toBe(202);
        const queryId = dispatchRes.body.queryId;

        // 2. Poll
        let status = 'PENDING';
        let result = null;
        for (let i = 0; i < 5; i++) {
            const res = await request(app)
                .get(`/api/queries/jobs/${queryId}`)
                .set('Authorization', `Bearer ${tenantToken}`);
            
            status = res.body.status;
            if (status === 'COMPLETED') {
                result = res.body.result;
                break;
            }
            await new Promise(r => setTimeout(r, 100));
        }

        expect(status).toBe('COMPLETED');
        expect(result.results[0].answer).toBe(42);
    });
});
