import request from 'supertest';
import { app } from '../../index';
import { getAdminToken, cleanupTenant } from './test_helper';

describe('Admin: Industrial Catalog & Multi-Schema Discovery', () => {
    let adminToken: string;
    const ts = Date.now();
    const testTenantId = `cat_test_${ts}`;
    let tenantToken: string;

    beforeAll(async () => {
        adminToken = await getAdminToken();
        await request(app).post('/api/admin/tenants').set('Authorization', `Bearer ${adminToken}`).send({ id: testTenantId, name: 'Industrial Catalog' });
        
        const tokenRes = await request(app).post('/api/auth/token').set('Authorization', `Bearer ${adminToken}`).send({ tenantId: testTenantId });
        tenantToken = tokenRes.body.token;

        // Apply Multi-Schema Manifest
        const manifest = {
            version: "1.0",
            schemas: [
                {
                    name: "core",
                    tables: [{
                        name: "users",
                        columns: [{ name: "id", type: "SERIAL", primaryKey: true }, { name: "email", type: "TEXT" }]
                    }]
                },
                {
                    name: "inventory",
                    tables: [{
                        name: "products",
                        columns: [{ name: "id", type: "SERIAL", primaryKey: true }, { name: "name", type: "TEXT" }]
                    }]
                }
            ]
        };

        await request(app).post('/api/metadata/apply').set('Authorization', `Bearer ${tenantToken}`).send(manifest);

        // Seed data in both schemas
        await request(app).post('/api/analytics/query').set('Authorization', `Bearer ${tenantToken}`).send({
            queryConfig: { type: 'INSERT', schema: 'core', table: 'users', data: { email: 'user1@example.com' } }
        });
        await request(app).post('/api/analytics/query').set('Authorization', `Bearer ${tenantToken}`).send({
            queryConfig: { type: 'INSERT', schema: 'inventory', table: 'products', data: [{ name: 'item1' }, { name: 'item2' }] }
        });
    });

    afterAll(async () => {
        await cleanupTenant(testTenantId);
    });

    it('Success: Verify catalog metrics across multiple schemas', async () => {
        // 1. Trigger Crawl (should hit all schemas starting with tenant_id)
        await request(app).post('/api/metadata/crawl').set('Authorization', `Bearer ${adminToken}`).send({ tenantId: testTenantId });

        // 2. Check Catalog as Admin
        const res = await request(app)
            .get('/api/admin/catalog')
            .set('Authorization', `Bearer ${adminToken}`)
            .set('x-tenant-id', testTenantId);

        expect(res.status).toBe(200);
        
        const coreEntry = res.body.find((m: any) => m.table_name === 'users' && m.schema_name === `tenant_${testTenantId}_core`);
        const invEntry = res.body.find((m: any) => m.table_name === 'products' && m.schema_name === `tenant_${testTenantId}_inventory`);

        expect(coreEntry).toBeDefined();
        expect(invEntry).toBeDefined();

        expect(parseInt(coreEntry.row_count)).toBe(1);
        expect(parseInt(invEntry.row_count)).toBe(2);
    });
});
