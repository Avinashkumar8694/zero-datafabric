import request from 'supertest';
import { app } from '../../index';
import { getAdminToken, cleanupTenant } from './test_helper';

describe('Metadata: Industrial Table Discovery & Multi-Schema Isolation', () => {
    let adminToken: string;
    const ts = Date.now();
    const tenantA = `tbl_test_a_${ts}`;
    const tenantB = `tbl_test_b_${ts}`;
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

        // Apply multi-schema manifest for Tenant A
        const manifestA = {
            version: "1.0",
            schemas: [
                {
                    name: "core",
                    tables: [{
                        name: "private_data",
                        columns: [{ name: "id", type: "SERIAL", primaryKey: true }, { name: "secret_a", type: "TEXT" }]
                    }]
                }
            ]
        };
        await request(app).post('/api/metadata/apply').set('Authorization', `Bearer ${tokenA}`).send(manifestA);

        // Apply manifest for Tenant B with same table name
        const manifestB = {
            version: "1.0",
            schemas: [
                {
                    name: "core",
                    tables: [{
                        name: "private_data",
                        columns: [{ name: "id", type: "SERIAL", primaryKey: true }, { name: "secret_b", type: "TEXT" }]
                    }]
                }
            ]
        };
        await request(app).post('/api/metadata/apply').set('Authorization', `Bearer ${tokenB}`).send(manifestB);
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
