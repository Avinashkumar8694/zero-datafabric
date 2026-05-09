import request from 'supertest';
import { app } from '../../index';
import { getAdminToken, cleanupTenant } from './test_helper';

describe('Metadata Orchestrator: Industrial End-to-End', () => {
    let adminToken: string;
    const ts = Date.now();
    const testTenantId = `orch_test_${ts}`;
    let tenantToken: string;

    beforeAll(async () => {
        adminToken = await getAdminToken();
        await request(app).post('/api/admin/tenants').set('Authorization', `Bearer ${adminToken}`).send({ id: testTenantId, name: 'Orchestrator Test' });
        const tokenRes = await request(app).post('/api/auth/token').set('Authorization', `Bearer ${adminToken}`).send({ tenantId: testTenantId });
        tenantToken = tokenRes.body.token;
    });

    afterAll(async () => {
        await cleanupTenant(testTenantId);
    });

    it('Stage 1: Apply Initial Manifest (v1.0)', async () => {
        const manifest = {
            version: "4.0",
            schemas: [{
                name: "core",
                resources: [{
                    type: "TABLE",
                    name: "users",
                    columns: [{ name: "id", type: "SERIAL", primaryKey: true }, { name: "email", type: "TEXT" }]
                }]
            }]
        };

        const res = await request(app).post('/api/metadata/apply').set('Authorization', `Bearer ${tenantToken}`).send(manifest);
        expect(res.status).toBe(200);
        expect(res.body.status).toBe('APPLIED');
    });

    it('Stage 2: Detect Logical Deletion (Quarantine)', async () => {
        const manifestV11 = {
            version: "4.1",
            schemas: [{
                name: "core",
                resources: [] 
            }]
        };

        const diffRes = await request(app).post('/api/metadata/diff').set('Authorization', `Bearer ${tenantToken}`).send(manifestV11);
        expect(diffRes.body.changes).toContainEqual(expect.objectContaining({ action: 'QUARANTINE_TABLE', table: 'users' }));

        const applyRes = await request(app).post('/api/metadata/apply').set('Authorization', `Bearer ${tenantToken}`).send(manifestV11);
        expect(applyRes.status).toBe(200);
        expect(applyRes.body.status).toBe('APPLIED');
    });

    it('Stage 4: Rollback to v1.0', async () => {
        const historyRes = await request(app).get('/api/metadata/history').set('Authorization', `Bearer ${tenantToken}`);
        console.log('History Response:', historyRes.status, historyRes.body);
        const v10 = historyRes.body.find((h: any) => h.version_tag === '4.0');
        
        expect(v10).toBeDefined();
        const rollbackRes = await request(app).post(`/api/metadata/rollback/${v10.id}`).set('Authorization', `Bearer ${tenantToken}`);
        expect(rollbackRes.status).toBe(200);
        expect(rollbackRes.body.status).toBe('APPLIED');
    });
});
