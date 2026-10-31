import request from 'supertest';
import { app } from '../../index';
import { getAdminToken, cleanupTenant, createTenantViaApi, uniqueTenantId, describeIfRemotePg, remotePgConfig, withRemotePg } from './test_helper';

// The hub itself can no longer be registered as a data source (hub self-registration is refused), so the hierarchy is built
// from the remote warehouse Postgres (docker-compose :5436, override with REMOTE_PG_HOST / REMOTE_PG_PORT).
describeIfRemotePg()('Metadata: Hierarchical Discovery (Source -> Schema -> Table)', () => {
    let adminToken: string;
    let tenantToken: string;
    let sourceId: string;
    const tenantId = uniqueTenantId('hier');

    beforeAll(async () => {
        await withRemotePg((c) => c.query('CREATE TABLE IF NOT EXISTS public.hier_probe (id serial primary key, label text)'));
        adminToken = await getAdminToken();
        tenantToken = await createTenantViaApi(adminToken, tenantId, 'Hierarchical Discovery');

        const res = await request(app)
            .post('/api/admin/connections')
            .set('Authorization', `Bearer ${tenantToken}`)
            .send({ name: `Discovery_Source_${Date.now()}`, config: remotePgConfig() });
        expect([200, 201]).toContain(res.status);
        sourceId = res.body.sourceId;
        expect(sourceId).toBeDefined();
    });

    afterAll(async () => {
        await cleanupTenant(tenantId);
        await withRemotePg((c) => c.query('DROP TABLE IF EXISTS public.hier_probe')).catch(() => undefined);
    });

    it('Success: Crawl Source should populate catalog_schemas and catalog_tables', async () => {
        const crawlRes = await request(app)
            .post('/api/metadata/crawl')
            .set('Authorization', `Bearer ${tenantToken}`)
            .send({ tenantId });

        expect(crawlRes.status).toBe(200);
        expect(crawlRes.body.sourceResults.length).toBeGreaterThan(0);
        expect(crawlRes.body.sourceResults.every((r: any) => r.status !== 'FAILED')).toBe(true);
    });

    it('Success: GET /api/metadata/sources should return the source', async () => {
        const res = await request(app).get('/api/metadata/sources').set('Authorization', `Bearer ${tenantToken}`);

        expect(res.status).toBe(200);
        expect(res.body.some((s: any) => s.id === sourceId)).toBe(true);
    });

    it('Success: GET /api/metadata/schemas should return schemas for the source', async () => {
        const res = await request(app).get(`/api/metadata/schemas?sourceId=${sourceId}`).set('Authorization', `Bearer ${tenantToken}`);

        expect(res.status).toBe(200);
        expect(res.body.length).toBeGreaterThan(0);
        expect(res.body[0]).toHaveProperty('schemaId');
        expect(res.body[0]).toHaveProperty('name');
    });

    it('Success: GET /api/metadata/tables should return tables for a schema', async () => {
        const schemaRes = await request(app).get(`/api/metadata/schemas?sourceId=${sourceId}`).set('Authorization', `Bearer ${tenantToken}`);
        expect(schemaRes.status).toBe(200);
        const schemaId = schemaRes.body.find((s: any) => s.name === 'public').schemaId;

        const res = await request(app).get(`/api/metadata/tables?schemaId=${schemaId}`).set('Authorization', `Bearer ${tenantToken}`);

        expect(res.status).toBe(200);
        expect(res.body.length).toBeGreaterThan(0);
        expect(res.body[0]).toHaveProperty('tableId');
        expect(res.body[0]).toHaveProperty('name');
        expect(res.body.some((t: any) => t.name === 'hier_probe')).toBe(true);
    });

    it('Security: another workspace cannot see this source or its schemas (404, never data)', async () => {
        const otherId = uniqueTenantId('hotr');
        const otherToken = await createTenantViaApi(adminToken, otherId, 'Other');
        try {
            const sources = await request(app).get('/api/metadata/sources').set('Authorization', `Bearer ${otherToken}`);
            expect(sources.status).toBe(200);
            expect(sources.body.some((s: any) => s.id === sourceId)).toBe(false);
            const schemas = await request(app).get(`/api/metadata/schemas?sourceId=${sourceId}`).set('Authorization', `Bearer ${otherToken}`);
            expect([200, 404]).toContain(schemas.status);
            if (schemas.status === 200) expect(schemas.body).toEqual([]);
        } finally {
            await cleanupTenant(otherId);
        }
    });
});
