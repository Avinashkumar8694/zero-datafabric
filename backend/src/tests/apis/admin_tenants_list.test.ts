import request from 'supertest';
import { app } from '../../index';
import { getAdminToken } from './test_helper';

describe('GET /api/admin/tenants', () => {
    let adminToken: string;

    beforeAll(async () => {
        adminToken = await getAdminToken();
    });

    it('Success: List all active tenants in the fabric', async () => {
        const res = await request(app)
            .get('/api/admin/tenants')
            .set('Authorization', `Bearer ${adminToken}`);
        expect(res.status).toBe(200);
        expect(Array.isArray(res.body)).toBe(true);
        expect(res.body.length).toBeGreaterThan(0);
    });

    it('Failure: Access denied without authentication', async () => {
        await request(app).get('/api/admin/tenants').expect(401);
    });
});
