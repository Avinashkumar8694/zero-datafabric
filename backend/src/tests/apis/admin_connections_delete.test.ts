import request from 'supertest';
import { app } from '../../index';
import { pool } from '../../config/database';
import { getAdminToken, cleanupTenant, createTenantViaApi, uniqueTenantId, describeIfRemotePg, remotePgConfig } from './test_helper';

describe('DELETE /api/admin/connections/:id', () => {
    it('Failure: Requires ADMIN authorization', async () => {
        await request(app).delete('/api/admin/connections/123').expect(401);
    });

    // Needs the remote warehouse Postgres (docker-compose :5436, override with REMOTE_PG_HOST / REMOTE_PG_PORT).
    describeIfRemotePg()('with a registered remote source', () => {
        let scopedToken: string;
        let tempSourceId: string;
        const testTenantId = uniqueTenantId('cdel');

        beforeAll(async () => {
            scopedToken = await createTenantViaApi(await getAdminToken(), testTenantId, 'Conn Delete');
            const reg = await request(app)
                .post('/api/admin/connections')
                .set('Authorization', `Bearer ${scopedToken}`)
                .send({ name: 'to_be_removed_' + Date.now(), config: remotePgConfig() });
            expect(reg.status).toBe(201);
            tempSourceId = reg.body.sourceId;
        });

        afterAll(async () => {
            await cleanupTenant(testTenantId);
        });

        it('Success: Safely remove a data source integration', async () => {
            expect(tempSourceId).toBeDefined();
            await request(app).delete(`/api/admin/connections/${tempSourceId}`).set('Authorization', `Bearer ${scopedToken}`).expect(200);
            const { rows } = await pool.query('SELECT 1 FROM public.data_sources WHERE id = $1', [tempSourceId]);
            expect(rows.length).toBe(0);
        });
    });
});
