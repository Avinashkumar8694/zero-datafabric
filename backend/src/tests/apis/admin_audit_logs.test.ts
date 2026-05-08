import request from 'supertest';
import { app } from '../../index';
import { getAdminToken } from './test_helper';

describe('GET /api/admin/audit-logs', () => {
    let adminToken: string;

    beforeAll(async () => {
        adminToken = await getAdminToken();
    });

    it('Success: Retrieve industrial forensic audit trails', async () => {
        const res = await request(app)
            .get('/api/admin/audit-logs')
            .set('Authorization', `Bearer ${adminToken}`);
        expect(res.status).toBe(200);
        expect(Array.isArray(res.body)).toBe(true);
    });

    it('Failure: Access denied to non-administrative identities', async () => {
        await request(app).get('/api/admin/audit-logs').expect(401);
    });
});
