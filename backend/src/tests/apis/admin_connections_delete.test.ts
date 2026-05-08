import request from 'supertest';
import { app } from '../../index';
import { getAdminToken, cleanupTenant } from './test_helper';

describe('DELETE /api/admin/connections/:id', () => {
    let adminToken: string;
    let tempSourceId: string;
    const testTenantId = 'conn_delete_tenant';

    beforeAll(async () => {
        adminToken = await getAdminToken();
        await request(app).post('/api/admin/tenants').set('Authorization', `Bearer ${adminToken}`).send({ id: testTenantId, name: 'Conn Delete' });

        // Scoped token
        const tokenRes = await request(app).post('/api/auth/token').set('Authorization', `Bearer ${adminToken}`).send({ tenantId: testTenantId });
        const scopedToken = tokenRes.body.token;

        const reg = await request(app)
            .post('/api/admin/connections')
            .set('Authorization', `Bearer ${scopedToken}`)
            .send({
                name: 'to_be_removed_' + Date.now(),
                config: { type: 'postgres', host: '127.0.0.1', port: 5436, dbName: 'remote_warehouse', user: 'remote_admin', pass: 'remote_password', syncType: 'VIRTUAL' }
            });
        if (reg.status !== 201) console.error('Reg Failed Body:', reg.body);
        tempSourceId = reg.body.sourceId;
    });

    afterAll(async () => {
        await cleanupTenant(testTenantId);
    });

    it('Success: Safely remove a data source integration', async () => {
        const tokenRes = await request(app).post('/api/auth/token').set('Authorization', `Bearer ${adminToken}`).send({ tenantId: testTenantId });
        const scopedToken = tokenRes.body.token;

        expect(tempSourceId).toBeDefined();
        await request(app)
            .delete(`/api/admin/connections/${tempSourceId}`)
            .set('Authorization', `Bearer ${scopedToken}`)
            .expect(200);
    });

    it('Failure: Requires ADMIN authorization', async () => {
        await request(app).delete('/api/admin/connections/123').expect(401);
    });
});
