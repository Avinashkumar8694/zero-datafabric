import request from 'supertest';
import { app } from '../../index';
import { getAdminToken, cleanupTenant } from './test_helper';
import { MetadataService } from '../../modules/metadata/metadata.service';

describe('Metadata: File Upload Orchestration', () => {
    let adminToken: string;
    let tenantToken: string;
    const ts = Date.now();
    const testTenantId = `file_upload_${ts}`;

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
        const manifest = MetadataService.getTemplate();
        // Modify manifest to ensure it's fresh
        manifest.schemas[0].name = "file_upload_schema";
        manifest.schemas[0].tables[0].name = "file_upload_table";

        const res = await request(app)
            .post('/api/metadata/apply')
            .set('Authorization', `Bearer ${tenantToken}`)
            .attach('file', Buffer.from(JSON.stringify(manifest)), 'manifest.json');

        expect(res.status).toBe(200);
        expect(res.body.success).toBe(true);
        expect(res.body.results.length).toBeGreaterThan(0);
        
        // Verify schema creation
        const crawlRes = await request(app)
            .get('/api/metadata/tables/file_upload_table')
            .set('Authorization', `Bearer ${tenantToken}`);
            
        expect(crawlRes.status).toBe(200);
        expect(crawlRes.body.columns.length).toBeGreaterThan(0);
    });

    it('Success: Diff manifest via file upload', async () => {
        const manifest = MetadataService.getTemplate();
        manifest.schemas[0].name = "file_upload_schema";
        manifest.schemas[0].tables[0].name = "file_upload_table";
        // Add a new column for drift
        manifest.schemas[0].tables[0].columns.push({ name: 'drift_col', type: 'TEXT' });

        const res = await request(app)
            .post('/api/metadata/diff')
            .set('Authorization', `Bearer ${tenantToken}`)
            .attach('file', Buffer.from(JSON.stringify(manifest)), 'drift_manifest.json');

        expect(res.status).toBe(200);
        expect(res.body.diffs.some((d: any) => d.action === 'ADD_COLUMN' && (d.column === 'drift_col' || d.column?.name === 'drift_col'))).toBe(true);
    });
});
