import request from 'supertest';
import { app } from '../../index';
import { getAdminToken, cleanupTenant, createTenantViaApi, uniqueTenantId } from './test_helper';

describe('Analytics: Industrial Async Processing & Job Lifecycle', () => {
    let tenantToken: string;
    const testTenantId = uniqueTenantId('asy');

    beforeAll(async () => {
        tenantToken = await createTenantViaApi(await getAdminToken(), testTenantId, 'Industrial Async');

        // Provision multi-schema environment
        const applied = await request(app).post('/api/metadata/apply').set('Authorization', `Bearer ${tenantToken}`).send({
            version: "1.0",
            schemas: [
                {
                    name: "reporting",
                    resources: [{
                        type: 'TABLE',
                        name: "aggregated_stats",
                        columns: [{ name: "id", type: "SERIAL", primaryKey: true }, { name: "metric", type: "INTEGER" }]
                    }]
                }
            ]
        });
        expect(applied.status).toBe(200);

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
            if (jobStatus === 'COMPLETED') results = pollRes.body.result?.data;
            
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
