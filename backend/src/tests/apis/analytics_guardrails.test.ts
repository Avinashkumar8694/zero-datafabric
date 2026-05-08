import request from 'supertest';
import { app } from '../../index';
import { getAdminToken, cleanupTenant } from './test_helper';

describe('Analytics: Industrial Safety Shield (Guardrails)', () => {
    let adminToken: string;
    const ts = Date.now();
    const testTenantId = `guardrail_test_${ts}`;

    beforeAll(async () => {
        adminToken = await getAdminToken();
        await request(app).post('/api/admin/tenants').set('Authorization', `Bearer ${adminToken}`).send({ id: testTenantId, name: 'Guardrail Test' });
        
        const tokenRes = await request(app).post('/api/auth/token').set('Authorization', `Bearer ${adminToken}`).send({ tenantId: testTenantId });
        const scopedToken = tokenRes.body.token;

        const migrateRes = await request(app).post('/api/metadata/migrate').set('Authorization', `Bearer ${scopedToken}`).send({
            migrationPlan: [
                { action: 'CREATE_SCHEMA' },
                { action: 'CREATE_TABLE', table: 'users', details: { columns: [{ name: 'id', type: 'SERIAL', primaryKey: true }, { name: 'email', type: 'TEXT' }] } }
            ]
        });
        expect(migrateRes.status).toBe(200);
    });

    afterAll(async () => {
        await cleanupTenant(testTenantId);
    });

    it('Failure: Block unrestricted SELECT * (No limit, no filter)', async () => {
        const tokenRes = await request(app).post('/api/auth/token').set('Authorization', `Bearer ${adminToken}`).send({ tenantId: testTenantId });
        const scopedToken = tokenRes.body.token;

        const res = await request(app).post('/api/analytics/query').set('Authorization', `Bearer ${scopedToken}`).send({
            queryConfig: { type: 'SELECT', table: 'users', select: ['*'] }
        });

        // The QueryEngineService should block this if it doesn't have a limit or filter
        expect(res.status).toBe(500);
        expect(res.body.error).toContain('INDUSTRIAL SAFETY');
    });

    it('Success: Allow aggregate count(*) even without limit', async () => {
        const tokenRes = await request(app).post('/api/auth/token').set('Authorization', `Bearer ${adminToken}`).send({ tenantId: testTenantId });
        const scopedToken = tokenRes.body.token;

        const res = await request(app).post('/api/analytics/query').set('Authorization', `Bearer ${scopedToken}`).send({
            queryConfig: { type: 'SELECT', table: 'users', select: ['count(*)'] }
        });

        expect(res.status).toBe(200);
    });

    it('Failure: Block unrestricted DELETE (No filter)', async () => {
        const tokenRes = await request(app).post('/api/auth/token').set('Authorization', `Bearer ${adminToken}`).send({ tenantId: testTenantId });
        const scopedToken = tokenRes.body.token;

        const res = await request(app).post('/api/analytics/query').set('Authorization', `Bearer ${scopedToken}`).send({
            queryConfig: { type: 'DELETE', table: 'users' }
        });

        expect(res.status).toBe(500);
        expect(res.body.error).toContain('INDUSTRIAL SAFETY');
    });

    it('Failure: Block unrestricted UPDATE (No filter)', async () => {
        const tokenRes = await request(app).post('/api/auth/token').set('Authorization', `Bearer ${adminToken}`).send({ tenantId: testTenantId });
        const scopedToken = tokenRes.body.token;

        const res = await request(app).post('/api/analytics/query').set('Authorization', `Bearer ${scopedToken}`).send({
            queryConfig: { type: 'UPDATE', table: 'users', data: { email: 'hacked@evil.com' } }
        });

        expect(res.status).toBe(500);
        expect(res.body.error).toContain('INDUSTRIAL SAFETY');
    });

    it('Success: Allow count by group even without limit', async () => {
        const tokenRes = await request(app).post('/api/auth/token').set('Authorization', `Bearer ${adminToken}`).send({ tenantId: testTenantId });
        const scopedToken = tokenRes.body.token;

        const res = await request(app).post('/api/analytics/query').set('Authorization', `Bearer ${scopedToken}`).send({
            queryConfig: { 
                type: 'SELECT', 
                table: 'users', 
                select: ['email', 'count(*)'], 
                groupBy: ['email'] 
            }
        });

        expect(res.status).toBe(200);
    });
});
