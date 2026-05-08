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
        const manifest = templateRes.body;

        // 2. Modify Manifest (Add a new table to enterprise_core schema)
        const coreSchema = (manifest.schemas || []).find((s: any) => s.name === 'enterprise_core');
        if (!coreSchema) {
            console.error('--- DEBUG: MANIFEST INVALID ---', JSON.stringify(manifest, null, 2));
            throw new Error('enterprise_core schema not found in template');
        }
        coreSchema.tables.push({
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
