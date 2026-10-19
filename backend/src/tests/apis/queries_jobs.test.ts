import request from 'supertest';
import { app } from '../../index';
import { getAdminToken, cleanupTenant, createTenantViaApi, uniqueTenantId } from './test_helper';

describe('Queries: AST async job polling via /api/queries/jobs', () => {
    let tenantToken: string;
    const testTenantId = uniqueTenantId('astjob');

    beforeAll(async () => {
        tenantToken = await createTenantViaApi(await getAdminToken(), testTenantId, 'AST Job');

        const applied = await request(app).post('/api/metadata/apply').set('Authorization', `Bearer ${tenantToken}`).send({
            version: '1.0',
            schemas: [{ name: 'core', resources: [{ type: 'TABLE', name: 'job_items', columns: [{ name: 'id', type: 'SERIAL', primaryKey: true }, { name: 'n', type: 'INTEGER' }] }] }]
        });
        expect(applied.status).toBe(200);
        await request(app).post('/api/data/create').set('Authorization', `Bearer ${tenantToken}`).send({ schema: 'core', resource: 'job_items', data: [{ n: 42 }] }).expect(200);
    });

    afterAll(async () => {
        await cleanupTenant(testTenantId);
    });

    it('Success: dispatch an AST query asynchronously and poll for results', async () => {
        const dispatchRes = await request(app)
            .post('/api/analytics/query-async')
            .set('Authorization', `Bearer ${tenantToken}`)
            .send({ queryConfig: { type: 'SELECT', schema: 'core', table: 'job_items', select: ['n'], limit: 10 } });

        expect(dispatchRes.status).toBe(202);
        const jobId = dispatchRes.body.jobId;
        expect(jobId).toBeDefined();

        let status = 'PENDING';
        for (let i = 0; i < 20 && status !== 'COMPLETED'; i++) {
            const res = await request(app).get(`/api/queries/jobs/${jobId}`).set('Authorization', `Bearer ${tenantToken}`);
            status = res.body.status;
            if (status !== 'COMPLETED') await new Promise(r => setTimeout(r, 100));
        }
        expect(status).toBe('COMPLETED');
    });

    it('Not found: unknown job ids return 404 on both polling routes', async () => {
        for (const path of ['/api/queries/jobs/does-not-exist', '/api/queries/status/does-not-exist']) {
            const res = await request(app).get(path).set('Authorization', `Bearer ${tenantToken}`);
            expect(res.status).toBe(404);
        }
    });

    it('Rejected: SQL text is not accepted for async execution', async () => {
        const res = await request(app)
            .post('/api/analytics/query-async')
            .set('Authorization', `Bearer ${tenantToken}`)
            .send({ sql: 'SELECT 42 AS answer', async: true });
        expect(res.status).toBe(400);
        expect(res.body.code).toBe('SQL_NOT_SUPPORTED');
    });
});
