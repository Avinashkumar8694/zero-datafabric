import request from 'supertest';
import { app } from '../../index';
import { pool } from '../../config/database';
import { getAdminToken, cleanupTenant, uniqueTenantId } from './test_helper';

describe('Metadata: File Upload Orchestration', () => {
    let adminToken: string;
    let tenantToken: string;
    const testTenantId = uniqueTenantId('fup');

    /** A manifest in the current shape (`schemas[].resources[]`, see manifest_validator.ts). */
    const buildManifest = (extraColumns: any[] = []) => ({
        version: '1.0',
        schemas: [{
            name: 'file_upload_schema',
            resources: [{
                type: 'TABLE',
                name: 'file_upload_table',
                columns: [{ name: 'id', type: 'SERIAL', primaryKey: true }, { name: 'label', type: 'TEXT' }, ...extraColumns],
            }],
        }],
    });

    beforeAll(async () => {
        adminToken = await getAdminToken();
        await request(app).post('/api/admin/tenants').set('Authorization', `Bearer ${adminToken}`).send({ id: testTenantId, name: 'File Upload Tenant' });
        
        const tokenRes = await request(app).post('/api/auth/token').set('Authorization', `Bearer ${adminToken}`).send({ tenantId: testTenantId });
        tenantToken = tokenRes.body.token;
    });

    afterAll(async () => {
        await cleanupTenant(testTenantId);
    });

    it('Success: Apply full manifest via file upload', async () => {
        const res = await request(app)
            .post('/api/metadata/apply')
            .set('Authorization', `Bearer ${tenantToken}`)
            .attach('file', Buffer.from(JSON.stringify(buildManifest())), 'manifest.json');

        expect(res.status).toBe(200);
        expect(res.body.status).toBe('APPLIED');
        expect(res.body.results.length).toBeGreaterThan(0);

        // The uploaded manifest was really provisioned in the tenant's own namespace.
        const cols = await pool.query(
            'SELECT column_name FROM information_schema.columns WHERE table_schema = $1 AND table_name = $2',
            [`tenant_${testTenantId}_file_upload_schema`, 'file_upload_table']
        );
        expect(cols.rows.map((r: any) => r.column_name).sort()).toEqual(['id', 'label']);
    });

    it('Success: Diff manifest via file upload', async () => {
        const res = await request(app)
            .post('/api/metadata/diff')
            .set('Authorization', `Bearer ${tenantToken}`)
            .attach('file', Buffer.from(JSON.stringify(buildManifest([{ name: 'drift_col', type: 'TEXT' }]))), 'drift_manifest.json');

        expect(res.status).toBe(200);
        expect(res.body.changes.some((d: any) => d.action === 'ADD_COLUMN' && (d.column === 'drift_col' || d.column?.name === 'drift_col'))).toBe(true);
    });

    it('Failure: a malformed upload is rejected without touching the schema', async () => {
        const res = await request(app)
            .post('/api/metadata/apply')
            .set('Authorization', `Bearer ${tenantToken}`)
            .attach('file', Buffer.from('{ not json'), 'broken.json');
        expect(res.status).toBe(400);
    });
});
