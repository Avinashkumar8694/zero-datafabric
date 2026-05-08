import request from 'supertest';
import { app } from '../../index';
import { getAdminToken, cleanupTenant } from './test_helper';

describe('POST /api/queries/exec (Industrial Isolation)', () => {
    let adminToken: string;
    const ts = Date.now();
    const tenantA = `q_test_a_${ts}`;
    const tenantB = `q_test_b_${ts}`;
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

        // Apply manifest for Tenant A to create a table
        await request(app).post('/api/metadata/apply').set('Authorization', `Bearer ${tokenA}`).send({
            version: "1.0",
            schemas: [{
                tables: [{
                    name: "data_a",
                    columns: [
                        { name: "id", type: "SERIAL", primaryKey: true },
                        { name: "val", type: "TEXT" }
                    ]
                }]
            }]
        });

        // Insert data as Tenant A
        await request(app).post('/api/queries/exec').set('Authorization', `Bearer ${tokenA}`).send({
            sql: "INSERT INTO data_a (val) VALUES ('A_SECRET')"
        });
    });

    afterAll(async () => {
        await cleanupTenant(tenantA);
        await cleanupTenant(tenantB);
    });

    it('Success: Tenant A can query its own data', async () => {
        const res = await request(app)
            .post('/api/queries/exec')
            .set('Authorization', `Bearer ${tokenA}`)
            .send({ sql: 'SELECT * FROM data_a' });
        
        expect(res.status).toBe(200);
        // Correct nested structure: res.body.results.results
        expect(res.body.results.results[0].val).toBe('A_SECRET');
    });

    it('Security: Tenant B CANNOT query Tenant A tables directly', async () => {
        const res = await request(app)
            .post('/api/queries/exec')
            .set('Authorization', `Bearer ${tokenB}`)
            .send({ sql: 'SELECT * FROM data_a' });
        
        // Fails due to search_path
        expect(res.status).toBe(500);
        expect(res.body.error).toContain('relation "data_a" does not exist');
    });

    it('Security: Tenant B CANNOT query Tenant A via fully qualified name', async () => {
        const res = await request(app)
            .post('/api/queries/exec')
            .set('Authorization', `Bearer ${tokenB}`)
            .send({ sql: `SELECT * FROM "tenant_${tenantA}"."data_a"` });
        
        // With RLS restored, this should return 200 but 0 rows
        expect(res.status).toBe(200);
        expect(res.body.results.results.length).toBe(0);
    });
});
