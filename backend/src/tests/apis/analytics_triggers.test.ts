import request from 'supertest';
import { app } from '../../index';
import { getAdminToken, cleanupTenant, createTenantViaApi, uniqueTenantId } from './test_helper';

describe('Analytics: Industrial Trigger & Isolation', () => {
    let adminToken: string;
    const tenantA = uniqueTenantId('anaa');
    const tenantB = uniqueTenantId('anab');
    let tokenA: string;
    let tokenB: string;

    // A manifest in the current shape (no free-form SQL needed: the trigger uses the structured INSERT action, which is available
    // to every workspace owner). Manifest triggers can only write to their own schema (dotted/cross-schema targets are refused
    // by the manifest validator), so the audit table lives next to the table it audits.
    const manifest = {
        version: '1.0',
        schemas: [
            {
                name: 'core',
                resources: [
                    {
                        type: 'TABLE',
                        name: 'users',
                        columns: [
                            { name: 'id', type: 'SERIAL', primaryKey: true },
                            { name: 'email', type: 'TEXT' },
                        ],
                        triggers: [{
                            name: 'trg_audit_user',
                            timing: 'AFTER',
                            events: ['INSERT'],
                            execution: 'row',
                            action: { type: 'INSERT', into: 'event_logs', values: { msg: 'NEW.email' } },
                        }],
                    },
                    {
                        type: 'TABLE',
                        name: 'event_logs',
                        columns: [
                            { name: 'id', type: 'SERIAL', primaryKey: true },
                            { name: 'msg', type: 'TEXT' },
                        ],
                    },
                ],
            },
        ],
    };
    const manifestFor = (_tenantId: string) => manifest;

    beforeAll(async () => {
        adminToken = await getAdminToken();
        tokenA = await createTenantViaApi(adminToken, tenantA, 'Analytics Tenant A');
        tokenB = await createTenantViaApi(adminToken, tenantB, 'Analytics Tenant B');

        const a = await request(app).post('/api/metadata/apply').set('Authorization', `Bearer ${tokenA}`).send(manifestFor(tenantA));
        const b = await request(app).post('/api/metadata/apply').set('Authorization', `Bearer ${tokenB}`).send(manifestFor(tenantB));
        if (a.status !== 200 || b.status !== 200) console.error('Manifest apply failed:', a.status, JSON.stringify(a.body), b.status, JSON.stringify(b.body));
        expect([a.status, b.status]).toEqual([200, 200]);
    });

    afterAll(async () => {
        await cleanupTenant(tenantA);
        await cleanupTenant(tenantB);
    });

    it('Success: Tenant A trigger correctly logs to its audit table', async () => {
        // Insert user as Tenant A (in 'core' schema)
        await request(app).post('/api/analytics/query').set('Authorization', `Bearer ${tokenA}`).send({
            queryConfig: { type: 'INSERT', schema: 'core', table: 'users', data: { email: 'alice@example.com' } }
        });

        // Verify the audit row
        const res = await request(app).post('/api/analytics/query').set('Authorization', `Bearer ${tokenA}`).send({
            queryConfig: { type: 'SELECT', schema: 'core', table: 'event_logs', select: ['*'], limit: 10 }
        });

        expect(res.status).toBe(200);
        expect(res.body.data.length).toBe(1);
        expect(res.body.data[0].msg).toContain('alice@example.com');
    });

    it('Security: Tenant B CANNOT see Tenant A audit logs', async () => {
        // Query audit logs as Tenant B (its own 'core' schema)
        const res = await request(app).post('/api/analytics/query').set('Authorization', `Bearer ${tokenB}`).send({
            queryConfig: { type: 'SELECT', schema: 'core', table: 'event_logs', select: ['*'], limit: 10 }
        });

        // Should return 0 rows because it's isolated (it has the same table name in its own schema)
        expect(res.status).toBe(200);
        expect(res.body.data.length).toBe(0);
    });
});
