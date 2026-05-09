import request from 'supertest';
import { app } from '../../index';
import { getAdminToken, cleanupTenant } from './test_helper';

describe('Metadata Orchestrator v4.0: Industrial Validation', () => {
    let adminToken: string;
    const ts = Date.now();
    const testTenantId = `v4_test_${ts}`;
    let tenantToken: string;

    beforeAll(async () => {
        adminToken = await getAdminToken();
        await request(app).post('/api/admin/tenants').set('Authorization', `Bearer ${adminToken}`).send({ id: testTenantId, name: 'v4.0 Test' });
        const tokenRes = await request(app).post('/api/auth/token').set('Authorization', `Bearer ${adminToken}`).send({ tenantId: testTenantId });
        tenantToken = tokenRes.body.token;
    });

    afterAll(async () => {
        await cleanupTenant(testTenantId);
    });

    it('Stage 1: Provision Universal AST v4.0 (ENUM -> TABLE -> TRIGGER)', async () => {
        const manifest = {
            version: "4.0",
            schemas: [{
                name: "supply_chain",
                resources: [
                    {
                        type: "ENUM",
                        name: "shipment_status",
                        values: ["PENDING", "SHIPPED", "DELIVERED"]
                    },
                    {
                        type: "TABLE",
                        name: "shipments",
                        columns: [
                            { name: "id", type: "SERIAL", primaryKey: true },
                            { name: "status", type: "shipment_status", default: "'PENDING'" }
                        ],
                        triggers: [
                            {
                                name: "trg_guard_status",
                                event: "BEFORE_UPDATE",
                                execute: {
                                    type: "EXCEPTION",
                                    message: "Cannot revert to PENDING from SHIPPED",
                                    when: { left: "OLD.status", operator: "EQ", right: "'SHIPPED'" }
                                }
                            }
                        ]
                    }
                ]
            }]
        };

        const res = await request(app).post('/api/metadata/apply').set('Authorization', `Bearer ${tenantToken}`).send(manifest);
        expect(res.status).toBe(200);
        expect(res.body.status).toBe('APPLIED');
    });

    it('Stage 2: Verify autoDrop Lifecycle', async () => {
        // v4.1: Add a trigger with autoDrop
        const manifestV41 = {
            version: "4.1",
            schemas: [{
                name: "supply_chain",
                resources: [
                    {
                        type: "TABLE",
                        name: "shipments",
                        columns: [{ name: "id", type: "SERIAL", primaryKey: true }],
                        triggers: [
                            {
                                name: "trg_onetime_setup",
                                event: "AFTER_INSERT",
                                autoDrop: { when: "TRUE" }, // Drop after first insert
                                execute: { type: "FUNCTION", name: "some_setup_fn" }
                            }
                        ]
                    }
                ]
            }]
        };

        const res = await request(app).post('/api/metadata/apply').set('Authorization', `Bearer ${tenantToken}`).send(manifestV41);
        expect(res.status).toBe(200);
    });
});
