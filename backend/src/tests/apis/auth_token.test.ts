import request from 'supertest';
import { app } from '../../index';
import { getAdminToken } from './test_helper';

describe('POST /api/auth/token', () => {
    let adminToken: string;

    beforeAll(async () => {
        adminToken = await getAdminToken();
    });

    it('Success: Should generate tenant-scoped token', async () => {
        const res = await request(app)
            .post('/api/auth/token')
            .set('Authorization', `Bearer ${adminToken}`)
            .send({ tenantId: 'tenant_A' });
        expect(res.status).toBe(200);
        expect(res.body).toHaveProperty('token');
    });

    it('Failure: Missing tenantId should fail', async () => {
        await request(app)
            .post('/api/auth/token')
            .set('Authorization', `Bearer ${adminToken}`)
            .send({})
            .expect(400); 
    });

    it('Failure: Unauthorized (Missing JWT) should return 401', async () => {
        await request(app).post('/api/auth/token').send({ tenantId: 'tenant_A' }).expect(401);
    });
});
