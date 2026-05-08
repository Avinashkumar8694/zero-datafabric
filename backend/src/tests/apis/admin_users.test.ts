import request from 'supertest';
import { app } from '../../index';
import { getAdminToken } from './test_helper';

describe('GET /api/admin/users', () => {
    let adminToken: string;

    beforeAll(async () => {
        adminToken = await getAdminToken();
    });

    it('Success: List all management identities in the platform', async () => {
        const res = await request(app)
            .get('/api/admin/users')
            .set('Authorization', `Bearer ${adminToken}`);
        expect(res.status).toBe(200);
        expect(Array.isArray(res.body)).toBe(true);
        expect(res.body.some((u: any) => u.username === 'admin')).toBe(true);
    });

    it('Failure: Requires ADMIN authorization', async () => {
        await request(app).get('/api/admin/users').expect(401);
    });

    it('Success: Full User Identity Lifecycle (Create, Update, Delete)', async () => {
        const testUser = {
            username: `testuser_${Date.now()}`,
            password: 'password123',
            tenantId: 'tenant_A',
            role: 'USER'
        };

        // 1. Create
        const createRes = await request(app)
            .post('/api/admin/users')
            .set('Authorization', `Bearer ${adminToken}`)
            .send(testUser);
        
        expect(createRes.status).toBe(201);
        const userId = createRes.body.id;
        expect(createRes.body.username).toBe(testUser.username);

        // 2. Update
        const updateRes = await request(app)
            .put(`/api/admin/users/${userId}`)
            .set('Authorization', `Bearer ${adminToken}`)
            .send({ ...testUser, role: 'ADMIN' });
        
        expect(updateRes.status).toBe(200);
        expect(updateRes.body.role).toBe('ADMIN');

        // 3. Delete
        const deleteRes = await request(app)
            .delete(`/api/admin/users/${userId}`)
            .set('Authorization', `Bearer ${adminToken}`);
        
        expect(deleteRes.status).toBe(200);
        expect(deleteRes.body.status).toBe('DELETED');
    });
});
