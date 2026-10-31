import request from 'supertest';
import { app } from '../../index';
import { getAdminToken, cleanupTenant, uniqueTenantId } from './test_helper';

describe('Metadata: Industrial Table Discovery & Multi-Schema Isolation', () => {
    let adminToken: string;
    const tenantA = uniqueTenantId('tbla');
    const tenantB = uniqueTenantId('tblb');
    let tokenA: string;
    let tokenB: string;

    beforeAll(async () => {
        adminToken = await getAdminToken();
        
        // Setup Tenant A
        await request(app).post('/api/admin/tenants').set('Authorization', `Bearer ${adminToken}`).send({ id: tenantA, name: 'Tenant A' });
        const resA = await request(app).post('/api/auth/token').set('Authorization', `Bearer ${adminToken}`).send({ tenantId: tenantA });
        tokenA = resA.body.token;

        // Setup Tenant B
        await request(app).post('/api/admin/tenants').set('Authorization', `Bearer ${adminToken}`).send({ id: tenantB, name: 'Tenant B' });
        const resB = await request(app).post('/api/auth/token').set('Authorization', `Bearer ${adminToken}`).send({ tenantId: tenantB });
        tokenB = resB.body.token;

        // The legacy by-name lookup (`GET /api/metadata/tables/:name`) reads fabric_catalog.metadata, which is filled by the
        // legacy migrate path (the manifest orchestrator registers catalog_tables instead). Both tenants get the same table name.
        const plan = (secret: string) => [{
            action: 'CREATE_TABLE', schema: 'core', table: 'private_data',
            details: { columns: [{ name: 'id', type: 'SERIAL', primaryKey: true }, { name: secret, type: 'TEXT' }] },
        }];
        const a = await request(app).post('/api/metadata/migrate').set('Authorization', `Bearer ${tokenA}`).send({ migrationPlan: plan('secret_a') });
        const b = await request(app).post('/api/metadata/migrate').set('Authorization', `Bearer ${tokenB}`).send({ migrationPlan: plan('secret_b') });
        expect([a.status, b.status]).toEqual([200, 200]);
    });

    afterAll(async () => {
        await cleanupTenant(tenantA);
        await cleanupTenant(tenantB);
    });

    it('Success: Tenant A discovers its own table across schemas', async () => {
        const res = await request(app)
            .get('/api/metadata/tables/private_data')
            .set('Authorization', `Bearer ${tokenA}`);
        
        expect(res.status).toBe(200);
        expect(res.body.table).toBe('private_data');
        // Should find columns in tenant_A_core schema
        expect(res.body.columns.some((c: any) => c.column_name === 'secret_a')).toBe(true);
        expect(res.body.columns.every((c: any) => c.schema_name.includes(tenantA))).toBe(true);
    });

    it('Security: Tenant A CANNOT see Tenant B columns even for same table name', async () => {
        const res = await request(app)
            .get('/api/metadata/tables/private_data')
            .set('Authorization', `Bearer ${tokenA}`);
        
        expect(res.status).toBe(200);
        expect(res.body.columns.some((c: any) => c.column_name === 'secret_b')).toBe(false);
    });
});
