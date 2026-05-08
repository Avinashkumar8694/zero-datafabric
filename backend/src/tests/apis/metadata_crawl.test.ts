import request from 'supertest';
import { app } from '../../index';
import { getAdminToken } from './test_helper';

describe('POST /api/metadata/crawl', () => {
    let adminToken: string;

    beforeAll(async () => {
        adminToken = await getAdminToken();
    });

    it('Success: Trigger automated metadata discovery crawl', async () => {
        const res = await request(app)
            .post('/api/metadata/crawl')
            .set('Authorization', `Bearer ${adminToken}`)
            .send({ tenantId: 'tenant_A' });
        expect(res.status).toBe(200); 
        expect(res.body).toHaveProperty('tableCount');

        // Verify the catalog has the row_count and last_crawled_at
        const catalogRes = await request(app)
            .get('/api/admin/catalog')
            .set('Authorization', `Bearer ${adminToken}`);
        
        expect(catalogRes.status).toBe(200);
        expect(catalogRes.body.length).toBeGreaterThan(0);
        expect(catalogRes.body[0]).toHaveProperty('row_count');
        expect(catalogRes.body[0]).toHaveProperty('last_crawled_at');
    });

    it('Failure: Requires ADMIN authorization', async () => {
        await request(app).post('/api/metadata/crawl').send({ tenantId: 'tenant_A' }).expect(401);
    });
});
