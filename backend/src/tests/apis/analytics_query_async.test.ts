import request from 'supertest';
import { app } from '../../index';
import { getAdminToken, cleanupTenant } from './test_helper';

describe('Analytics: Industrial Async Processing & Job Lifecycle', () => {
    let adminToken: string;
    const ts = Date.now();
    const testTenantId = `async_test_${ts}`;
    let tenantToken: string;

    beforeAll(async () => {
        adminToken = await getAdminToken();
        await request(app).post('/api/admin/tenants').set('Authorization', `Bearer ${adminToken}`).send({ id: testTenantId, name: 'Industrial Async' });
        
        const tokenRes = await request(app).post('/api/auth/token').set('Authorization', `Bearer ${adminToken}`).send({ tenantId: testTenantId });
        tenantToken = tokenRes.body.token;

        // Provision multi-schema environment
        await request(app).post('/api/metadata/apply').set('Authorization', `Bearer ${tenantToken}`).send({
            version: "1.0",
            schemas: [
                {
                    name: "reporting",
                    tables: [{
                        name: "aggregated_stats",
                        columns: [{ name: "id", type: "SERIAL", primaryKey: true }, { name: "metric", type: "INTEGER" }]
                    }]
                }
            ]
        });

        // Seed data
        await request(app).post('/api/analytics/query').set('Authorization', `Bearer ${tenantToken}`).send({
            queryConfig: { 
                type: 'INSERT', 
                schema: 'reporting',
                table: 'aggregated_stats', 
                data: [{ metric: 100 }, { metric: 200 }] 
            }
        });
    });

    afterAll(async () => {
        await cleanupTenant(testTenantId);
    });

    it('Success: Complete Job Lifecycle (Dispatch -> Poll -> Results)', async () => {
        // 1. Dispatch
        const dispatchRes = await request(app)
            .post('/api/analytics/query-async')
            .set('Authorization', `Bearer ${tenantToken}`)
            .send({
                queryConfig: { 
                    type: 'SELECT', 
                    schema: 'reporting',
                    table: 'aggregated_stats',
                    orderBy: [{ field: 'metric', dir: 'DESC' }],
                    limit: 10
                }
            });

        expect(dispatchRes.status).toBe(202);
        const jobId = dispatchRes.body.jobId;
        expect(jobId).toBeDefined();

        // 2. Poll until COMPLETED (with timeout)
        let jobStatus = 'PENDING';
        let attempts = 0;
        let results = null;

        while (jobStatus !== 'COMPLETED' && attempts < 10) {
            const pollRes = await request(app)
                .get(`/api/analytics/jobs/${jobId}`)
                .set('Authorization', `Bearer ${tenantToken}`);
            
            expect(pollRes.status).toBe(200);
            jobStatus = pollRes.body.status;
            if (jobStatus === 'COMPLETED') results = pollRes.body.result;
            
            if (jobStatus !== 'COMPLETED') {
                await new Promise(r => setTimeout(r, 200));
                attempts++;
            }
        }

        expect(jobStatus).toBe('COMPLETED');
        expect(results).toBeDefined();
        expect(results.length).toBe(2);
        expect(results[0].metric).toBe(200);
    });

    it('Failure: Return 404 for non-existent job', async () => {
        await request(app)
            .get('/api/analytics/jobs/invalid-id')
            .set('Authorization', `Bearer ${tenantToken}`)
            .expect(404);
    });
});
