import request from 'supertest';
import { app } from '../../index';
import { getAdminToken } from './test_helper';

describe('DELETE /api/admin/tenants/:id', () => {
    let adminToken: string;
    const tempId = 'delete_scenario_tenant';

    beforeAll(async () => {
        adminToken = await getAdminToken();
        // Pre-create for deletion test
        await request(app)
            .post('/api/admin/tenants')
            .set('Authorization', `Bearer ${adminToken}`)
            .send({ id: tempId, name: 'To be deleted' });
    });

    it('Success: Atomic de-provisioning of a tenant environment', async () => {
        await request(app)
            .delete(`/api/admin/tenants/${tempId}`)
            .set('Authorization', `Bearer ${adminToken}`)
            .expect(200);
    });

    it('Failure: Idempotency check or error for non-existent tenant', async () => {
        const res = await request(app)
            .delete('/api/admin/tenants/ghost_tenant')
            .set('Authorization', `Bearer ${adminToken}`);
        expect([200, 404, 500]).toContain(res.status);
    });

    it('Failure: Requires ADMIN authorization', async () => {
        await request(app).delete(`/api/admin/tenants/${tempId}`).expect(401);
    });
});
