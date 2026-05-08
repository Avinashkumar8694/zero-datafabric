import request from 'supertest';
import { app } from '../../index';
import { getAdminToken } from './test_helper';

describe('GET /api/admin/connections', () => {
    let adminToken: string;

    beforeAll(async () => {
        adminToken = await getAdminToken();
    });

    it('Success: List active data source connections', async () => {
        const res = await request(app)
            .get('/api/admin/connections')
            .set('Authorization', `Bearer ${adminToken}`);
        expect(res.status).toBe(200);
        expect(Array.isArray(res.body)).toBe(true);
    });

    it('Failure: Requires ADMIN authorization', async () => {
        await request(app).get('/api/admin/connections').expect(401);
    });
});
