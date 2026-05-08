import request from 'supertest';
import { app } from '../../index';
import { getAdminToken } from './test_helper';
import { pool } from '../../config/database';

describe('Metadata: Hierarchical Discovery (Source -> Schema -> Table)', () => {
    let adminToken: string;
    let sourceId: string;

    beforeAll(async () => {
        adminToken = await getAdminToken();
        
        // 0. Cleanup old sources to avoid stale config interference
        await pool.query("DELETE FROM public.data_sources WHERE tenant_id = 'tenant_A'");
        await pool.query("DELETE FROM public.catalog_schemas WHERE source_id NOT IN (SELECT id FROM public.data_sources)");
        
        const sourceName = `Discovery_Source_${Date.now()}`;
        // 1. Create a data source
        const res = await request(app)
            .post('/api/admin/connections')
            .set('Authorization', `Bearer ${adminToken}`)
            .send({
                name: sourceName,
                config: {
                    type: 'postgres',
                    host: 'localhost',
                    port: 5434,
                    dbName: 'datafabric',
                    user: 'fabric_admin',
                    pass: 'fabric_password',
                    syncType: 'VIRTUAL'
                }
            });
        
        console.log('Registration Response Status:', res.status);
        console.log('Registration Response Body:', JSON.stringify(res.body, null, 2));
        sourceId = res.body.sourceId;
        console.log('Registered Source ID:', sourceId);
        expect(sourceId).toBeDefined();
    });

    it('Success: Crawl Source should populate catalog_schemas and catalog_tables', async () => {
        const crawlRes = await request(app)
            .post('/api/metadata/crawl')
            .set('Authorization', `Bearer ${adminToken}`)
            .send({ tenantId: 'tenant_A' }); // This calls crawlTenant which calls crawlSource
        
        expect(crawlRes.status).toBe(200);
        expect(crawlRes.body.sourceResults.length).toBeGreaterThan(0);
    });

    it('Success: GET /api/metadata/sources should return the source', async () => {
        const res = await request(app)
            .get('/api/metadata/sources')
            .set('Authorization', `Bearer ${adminToken}`);
        
        expect(res.status).toBe(200);
        expect(res.body.some((s: any) => s.id === sourceId)).toBe(true);
    });

    it('Success: GET /api/metadata/schemas should return schemas for the source', async () => {
        const res = await request(app)
            .get(`/api/metadata/schemas?sourceId=${sourceId}`)
            .set('Authorization', `Bearer ${adminToken}`);
        
        expect(res.status).toBe(200);
        expect(res.body.length).toBeGreaterThan(0);
        expect(res.body[0]).toHaveProperty('schemaId');
        expect(res.body[0]).toHaveProperty('name');
    });

    it('Success: GET /api/metadata/tables should return tables for a schema', async () => {
        // First get a schemaId
        const schemaRes = await request(app)
            .get(`/api/metadata/schemas?sourceId=${sourceId}`)
            .set('Authorization', `Bearer ${adminToken}`);
        
        console.log('Schemas Response:', JSON.stringify(schemaRes.body, null, 2));
        expect(schemaRes.status).toBe(200);
        const schemaId = schemaRes.body.find((s: any) => s.name === 'public').schemaId;

        const res = await request(app)
            .get(`/api/metadata/tables?schemaId=${schemaId}`)
            .set('Authorization', `Bearer ${adminToken}`);
        
        expect(res.status).toBe(200);
        expect(res.body.length).toBeGreaterThan(0);
        expect(res.body[0]).toHaveProperty('tableId');
        expect(res.body[0]).toHaveProperty('name');
    });
});
