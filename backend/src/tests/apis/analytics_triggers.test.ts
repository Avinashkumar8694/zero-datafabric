import request from 'supertest';
import { app } from '../../index';
import { getAdminToken, cleanupTenant } from './test_helper';

describe('Analytics: Industrial Trigger & Isolation', () => {
    let adminToken: string;
    const ts = Date.now();
    const tenantA = `ana_test_a_${ts}`;
    const tenantB = `ana_test_b_${ts}`;
    let tokenA: string;
    let tokenB: string;

    beforeAll(async () => {
        adminToken = await getAdminToken();
        
        // Setup Tenants
        await request(app).post('/api/admin/tenants').set('Authorization', `Bearer ${adminToken}`).send({ id: tenantA, name: 'Analytics Tenant A' });
        const resA = await request(app).post('/api/auth/token').set('Authorization', `Bearer ${adminToken}`).send({ tenantId: tenantA });
        tokenA = resA.body.token;

        await request(app).post('/api/admin/tenants').set('Authorization', `Bearer ${adminToken}`).send({ id: tenantB, name: 'Analytics Tenant B' });
        const resB = await request(app).post('/api/auth/token').set('Authorization', `Bearer ${adminToken}`).send({ tenantId: tenantB });
        tokenB = resB.body.token;

        // Apply Industrial Manifest for Tenant A (Multi-Schema Triggers)
        const manifestA = {
            version: "1.0",
            schemas: [
                {
                    name: "core",
                    tables: [{
                        name: "users",
                        columns: [
                            { name: "id", type: "SERIAL", primaryKey: true },
                            { name: "email", type: "TEXT" }
                        ],
                        triggers: [{
                            name: "trg_audit_user",
                            event: "AFTER INSERT",
                            function: `tenant_${tenantA}_audit.fn_log_user_creation`
                        }]
                    }]
                },
                {
                    name: "audit",
                    tables: [{
                        name: "event_logs",
                        columns: [
                            { name: "id", type: "SERIAL", primaryKey: true },
                            { name: "msg", type: "TEXT" }
                        ]
                    }],
                    functions: [{
                        name: "fn_log_user_creation",
                        body: `BEGIN
                                 INSERT INTO tenant_${tenantA}_audit.event_logs (msg)
                                 VALUES ('New user created: ' || NEW.email);
                                 RETURN NEW;
                               END;`
                    }]
                }
            ]
        };

        await request(app).post('/api/metadata/apply').set('Authorization', `Bearer ${tokenA}`).send(manifestA);

        // Apply same manifest for Tenant B (to test isolation)
        const manifestB = JSON.parse(JSON.stringify(manifestA).replace(new RegExp(`tenant_${tenantA}`, 'g'), `tenant_${tenantB}`));
        await request(app).post('/api/metadata/apply').set('Authorization', `Bearer ${tokenB}`).send(manifestB);
    });

    afterAll(async () => {
        await cleanupTenant(tenantA);
        await cleanupTenant(tenantB);
    });

    it('Success: Tenant A trigger correctly logs to secondary schema', async () => {
        // Insert user as Tenant A (in 'core' schema)
        await request(app).post('/api/analytics/query').set('Authorization', `Bearer ${tokenA}`).send({
            queryConfig: { type: 'INSERT', schema: 'core', table: 'users', data: { email: 'alice@example.com' } }
        });

        // Verify log in audit schema
        const res = await request(app).post('/api/analytics/query').set('Authorization', `Bearer ${tokenA}`).send({
            queryConfig: { type: 'SELECT', schema: 'audit', table: 'event_logs', select: ['*'], limit: 10 }
        });

        expect(res.status).toBe(200);
        expect(res.body.data.length).toBe(1);
        expect(res.body.data[0].msg).toContain('alice@example.com');
    });

    it('Security: Tenant B CANNOT see Tenant A audit logs', async () => {
        // Query audit logs as Tenant B (in its own 'audit' schema)
        const res = await request(app).post('/api/analytics/query').set('Authorization', `Bearer ${tokenB}`).send({
            queryConfig: { type: 'SELECT', schema: 'audit', table: 'event_logs', select: ['*'], limit: 10 }
        });

        // Should return 0 rows because it's isolated (even though it has same table name in its own schema)
        expect(res.status).toBe(200);
        expect(res.body.data.length).toBe(0);
    });
});
