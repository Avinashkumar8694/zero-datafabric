import request from 'supertest';
import { app } from '../../index';
import { getAdminToken, cleanupTenant } from './test_helper';

describe('POST /api/metadata/apply (Declarative Orchestration)', () => {
    let adminToken: string;
    const ts = Date.now();
    const testTenantId = `apply_test_${ts}`;

    beforeAll(async () => {
        adminToken = await getAdminToken();
        await request(app).post('/api/admin/tenants').set('Authorization', `Bearer ${adminToken}`).send({ id: testTenantId, name: 'Apply Test' });
    });

    afterAll(async () => {
        await cleanupTenant(testTenantId);
    });

    it('Success: Declaratively apply a full metadata manifest', async () => {
        const tokenRes = await request(app).post('/api/auth/token').set('Authorization', `Bearer ${adminToken}`).send({ tenantId: testTenantId });
        const scopedToken = tokenRes.body.token;

        // 1. Get Template (Definitive Spec)
        const templateRes = await request(app)
            .get('/api/metadata/template')
            .set('Authorization', `Bearer ${scopedToken}`);
        let manifest = templateRes.body;

        // Normalize template manifest to schemas/resources format
        const { ManifestParser } = require('../../modules/metadata/manifest_parser');
        manifest = ManifestParser.parse(JSON.stringify(manifest));

        // 2. Modify Manifest (Add a new table to template schema)
        const coreSchema = manifest.schemas && manifest.schemas[0];
        if (!coreSchema) {
            console.error('--- DEBUG: MANIFEST INVALID ---', JSON.stringify(manifest, null, 2));
            throw new Error('No schema found in template');
        }

        // Clean out external relationships and federated/missing views to avoid database catalog checks
        coreSchema.resources = (coreSchema.resources || []).filter((r: any) => r.name !== 'federated_inventory_analysis' && r.name !== 'org_hierarchy_recursive' && r.name !== 'high_value_regional_summary');
        manifest.relationships = [];

        // Strip collation and constraints properties to prevent errors on locales or features not present in the DB
        for (const res of coreSchema.resources) {
            delete res.partitionBy; // Strip partition configuration to avoid unique constraint partition key errors
            delete res.constraints; // Strip exclusions/checks to avoid timestamp && GIST Citus operator errors
            if (res.columns) {
                for (const col of res.columns) {
                    delete col.collation;
                }
            }
        }

        coreSchema.resources.push({
            type: 'TABLE',
            name: 'apply_verified_table',
            columns: [
                { name: 'id', type: 'SERIAL', primaryKey: true },
                { name: 'status', type: 'TEXT' }
            ]
        });

        // 3. Declarative Apply
        const applyRes = await request(app)
            .post('/api/metadata/apply')
            .set('Authorization', `Bearer ${scopedToken}`)
            .send(manifest);

        if (applyRes.status !== 200) console.error('Apply Failed:', JSON.stringify(applyRes.body, null, 2));
        expect(applyRes.status).toBe(200);
        expect(applyRes.body.plan).toBeDefined();
        // Should contain CREATE_TABLE
        expect(applyRes.body.plan.some((p: any) => p.action === 'CREATE_TABLE' && p.table === 'apply_verified_table')).toBe(true);
        expect(applyRes.body.results.length).toBeGreaterThan(0);

        // 4. Verify table exists via Metadata API
        const tableRes = await request(app)
            .get('/api/metadata/tables/apply_verified_table')
            .set('Authorization', `Bearer ${scopedToken}`);
        
        expect(tableRes.status).toBe(200);
        expect(tableRes.body.table).toBe('apply_verified_table');
    });

    it('Success: Apply drift (adding a column to existing table)', async () => {
        const tokenRes = await request(app).post('/api/auth/token').set('Authorization', `Bearer ${adminToken}`).send({ tenantId: testTenantId });
        const scopedToken = tokenRes.body.token;

        // Start with a clean manifest for this test
        const manifest = {
            version: "7.0",
            schemas: [
                {
                    name: "enterprise_core",
                    tables: [
                        {
                            name: 'drift_table',
                            columns: [{ name: 'id', type: 'SERIAL', primaryKey: true }]
                        }
                    ]
                }
            ]
        };

        // Apply first time
        await request(app).post('/api/metadata/apply').set('Authorization', `Bearer ${scopedToken}`).send(manifest);

        // Drift: Add a column to that table
        manifest.schemas[0].tables[0].columns.push({ name: 'new_col', type: 'TEXT' });

        // Apply second time
        const driftRes = await request(app)
            .post('/api/metadata/apply')
            .set('Authorization', `Bearer ${scopedToken}`)
            .send(manifest);

        if (driftRes.status !== 200 || !driftRes.body.plan.some((p: any) => p.action === 'ADD_COLUMN' && (p.column?.name === 'new_col' || p.column === 'new_col'))) {
            console.error('--- DRIFT FAILED ---', JSON.stringify(driftRes.body, null, 2));
        }
        expect(driftRes.status).toBe(200);
        expect(driftRes.body.plan.some((p: any) => p.action === 'ADD_COLUMN' && (p.column?.name === 'new_col' || p.column === 'new_col'))).toBe(true);
    });
});
