import request from 'supertest';
import { app } from '../../index';
import { getAdminToken, cleanupTenant, createTenantViaApi, uniqueTenantId } from './test_helper';

describe('Analytics: Industrial View Refresh & Multi-Schema Consistency', () => {
    let tenantToken: string;
    const testTenantId = uniqueTenantId('rfr');

    beforeAll(async () => {
        tenantToken = await createTenantViaApi(await getAdminToken(), testTenantId, 'Industrial Refresh');

        // 1. Create Base Table and Materialized View (view defined as an AST, not SQL text)
        const applied = await request(app).post('/api/metadata/apply').set('Authorization', `Bearer ${tenantToken}`).send({
            version: "1.0",
            schemas: [{
                name: "reporting",
                resources: [
                    {
                        type: 'TABLE',
                        name: "sales_raw",
                        columns: [{ name: "id", type: "SERIAL", primaryKey: true }, { name: "amount", type: "NUMERIC" }]
                    },
                    {
                        type: 'MATERIALIZED_VIEW',
                        name: "sales_summary",
                        query: {
                            from: { resource: 'sales_raw' },
                            select: [{ aggregate: 'SUM', column: 'amount', alias: 'total' }]
                        }
                    }
                ]
            }]
        });
        if (applied.status !== 200) console.error('Manifest apply failed:', JSON.stringify(applied.body));
        expect(applied.status).toBe(200);

        // 2. Seed initial data
        const seedRes = await request(app).post('/api/analytics/query').set('Authorization', `Bearer ${tenantToken}`).send({
            queryConfig: { type: 'INSERT', schema: 'reporting', table: 'sales_raw', data: { amount: 100 } }
        });
        
        // Verify insert worked
        const countRes = await request(app).post('/api/analytics/query').set('Authorization', `Bearer ${tenantToken}`).send({
            queryConfig: { type: 'SELECT', schema: 'reporting', table: 'sales_raw', limit: 10 }
        });
        expect(countRes.status).toBe(200);
        console.log('Raw Data Count:', countRes.body.data.length);

        // Initial refresh (not concurrent first time)
        const { pool } = require('../../config/database');
        await pool.query(`REFRESH MATERIALIZED VIEW "tenant_${testTenantId}_reporting"."sales_summary"`);
    });

    afterAll(async () => {
        await cleanupTenant(testTenantId);
    });

    it('Success: Refresh materialized view and verify data consistency', async () => {
        // 1. Add more data
        await request(app).post('/api/analytics/query').set('Authorization', `Bearer ${tenantToken}`).send({
            queryConfig: { type: 'INSERT', schema: 'reporting', table: 'sales_raw', data: { amount: 200 } }
        });

        // 2. Verify view STILL has old data (100)
        const viewResBefore = await request(app).post('/api/analytics/query').set('Authorization', `Bearer ${tenantToken}`).send({
            queryConfig: { type: 'SELECT', schema: 'reporting', table: 'sales_summary', limit: 10 }
        });
        if (viewResBefore.body.data.length === 0) console.error('View is EMPTY!');
        else console.log('View Data:', viewResBefore.body.data[0]);
        expect(Number(viewResBefore.body.data[0].total)).toBe(100);

        // 3. Trigger Refresh
        const refreshRes = await request(app)
            .post('/api/analytics/refresh-view')
            .set('Authorization', `Bearer ${tenantToken}`)
            .send({ viewName: 'sales_summary', schema: 'reporting', concurrent: false });
        
        expect(refreshRes.status).toBe(202);

        // 4. Wait a bit and verify new data (300)
        await new Promise(r => setTimeout(r, 1000));

        const viewResAfter = await request(app).post('/api/analytics/query').set('Authorization', `Bearer ${tenantToken}`).send({
            queryConfig: { type: 'SELECT', schema: 'reporting', table: 'sales_summary', limit: 10 }
        });
        expect(Number(viewResAfter.body.data[0].total)).toBe(300);
    });
});
