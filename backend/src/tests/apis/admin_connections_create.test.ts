import request from 'supertest';
import { app } from '../../index';
import { pool } from '../../config/database';
import { getAdminToken, cleanupTenant, createTenantViaApi, uniqueTenantId, describeIfRemotePg, remotePgConfig } from './test_helper';

// Registers the remote warehouse Postgres (docker-compose :5436, override with REMOTE_PG_HOST / REMOTE_PG_PORT); skipped when it is unreachable.
describeIfRemotePg()('Admin: Industrial Connection Virtualization', () => {
    let adminToken: string;
    const testTenantId = uniqueTenantId('conn');
    let tenantToken: string;

    beforeAll(async () => {
        adminToken = await getAdminToken();
        tenantToken = await createTenantViaApi(adminToken, testTenantId, 'Industrial Conn');

        // Verify Schema exists in DB
        const schemaRes = await pool.query('SELECT schema_name FROM information_schema.schemata WHERE schema_name = $1', [`tenant_${testTenantId}`]);
        if (schemaRes.rows.length === 0) throw new Error(`Schema tenant_${testTenantId} missing`);
    });

    afterAll(async () => {
        await cleanupTenant(testTenantId);
    });

    it('Success: Register a remote source and verify virtualization', async () => {
        const res = await request(app)
            .post('/api/admin/connections')
            .set('Authorization', `Bearer ${tenantToken}`)
            .send({ name: 'remote_warehouse', config: remotePgConfig() });

        expect([200, 201]).toContain(res.status);
        expect(res.body.status).toBeDefined();

        // Crawl the tenant's sources, then check the catalog call succeeds for this tenant
        const crawl = await request(app).post('/api/metadata/crawl').set('Authorization', `Bearer ${adminToken}`).send({ tenantId: testTenantId });
        expect(crawl.status).toBe(200);

        const catalogRes = await request(app)
            .get('/api/admin/catalog')
            .set('Authorization', `Bearer ${adminToken}`)
            .set('x-tenant-id', testTenantId);

        expect(catalogRes.status).toBe(200);
        expect(Array.isArray(catalogRes.body)).toBe(true);
    });

    it('Idempotent: registering the same connection name again re-integrates it (200), it never duplicates', async () => {
        const again = await request(app)
            .post('/api/admin/connections')
            .set('Authorization', `Bearer ${tenantToken}`)
            .send({ name: 'remote_warehouse', config: remotePgConfig() });
        expect(again.status).toBe(200); // RE-INTEGRATED

        const { rows } = await pool.query('SELECT count(*)::int AS n FROM public.data_sources WHERE tenant_id = $1 AND name = $2', [testTenantId, 'remote_warehouse']);
        expect(rows[0].n).toBe(1);
    });

    it('Security: a hub-pointing connection is refused', async () => {
        const res = await request(app)
            .post('/api/admin/connections')
            .set('Authorization', `Bearer ${tenantToken}`)
            .send({ name: 'hub_self', config: { ...remotePgConfig(), host: '127.0.0.1', port: 5434 } });
        expect([400, 403]).toContain(res.status);
    });
});
