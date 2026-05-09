import request from 'supertest';
import { app } from '../../index';
import { getAdminToken, cleanupTenant } from './test_helper';

describe('Industrial Data Fabric: Master Metadata Validation Suite v4.0', () => {
    let adminToken: string;
    const ts = Date.now();
    const testTenantId = `master_v4_${ts}`;
    let tenantToken: string;

    beforeAll(async () => {
        adminToken = await getAdminToken();
        await request(app).post('/api/admin/tenants').set('Authorization', `Bearer ${adminToken}`).send({ id: testTenantId, name: 'Master Industrial Test' });
        const tokenRes = await request(app).post('/api/auth/token').set('Authorization', `Bearer ${adminToken}`).send({ tenantId: testTenantId });
        tenantToken = tokenRes.body.token;
    });

    afterAll(async () => {
        await cleanupTenant(testTenantId);
    });

    it('Exhaustive Test: Complete Supply Chain Ecosystem (Postgres + NoSQL Virtualization)', async () => {
        const masterManifest = {
            version: "4.0.0",
            namespace: "global_supply_chain",
            targetSource: "postgres_main",
            schemas: [
                {
                    name: "inventory",
                    resources: [
                        { type: "ENUM", name: "priority_level", values: ["LOW", "MEDIUM", "HIGH", "CRITICAL"] },
                        { type: "SEQUENCE", name: "tracking_seq", start: 1000 },
                        {
                            type: "FUNCTION",
                            name: "calculate_tax",
                            arguments: [{ name: "price", type: "NUMERIC" }],
                            returnType: "NUMERIC",
                            body: "BEGIN RETURN price * 0.15; END;"
                        },
                        {
                            type: "TABLE",
                            name: "warehouses",
                            columns: [
                                { name: "uuid", type: "UUID", strategy: "UUID_V7", primaryKey: true },
                                { name: "name", type: "TEXT", nullable: false },
                                { name: "location", type: "TEXT" }
                            ]
                        },
                        {
                            type: "TABLE",
                            name: "products",
                            columns: [
                                { name: "id", type: "BIGINT", strategy: "IDENTITY_ALWAYS", primaryKey: true },
                                { name: "sku", type: "TEXT", nullable: false },
                                { name: "price", type: "NUMERIC" },
                                { name: "tax_price", type: "NUMERIC", generated: "price * 1.15" }
                            ],
                            security: {
                                enable_rls: true,
                                policies: [{ name: "view_own_products", using: "TRUE" }],
                                grants: [{ role: "public", privileges: ["SELECT"] }]
                            }
                        },
                        {
                            type: "VIEW",
                            name: "v_product_analytics",
                            materialized: true,
                            query: {
                                select: [
                                    { column: "sku" },
                                    { aggregate: "AVG", column: "price", alias: "avg_price" }
                                ],
                                from: { resource: "products" },
                                groupBy: ["sku"]
                            },
                            indexes: [{ columns: ["sku"], unique: true }]
                        }
                    ]
                }
            ],
            relationships: [
                {
                    name: "warehouse_products",
                    cardinality: "M:N",
                    bridge: "warehouse_inventory_bridge",
                    from: { resource: "warehouses", field: "uuid" },
                    to: { resource: "products", field: "id" }
                }
            ]
        };

        const res = await request(app).post('/api/metadata/apply').set('Authorization', `Bearer ${tenantToken}`).send(masterManifest);
        
        expect(res.status).toBe(200);
        expect(res.body.status).toBe('APPLIED');
        expect(res.body.appliedCount).toBeGreaterThan(5);
    });

    it('Scenario: Trigger Guardrails & Relative Scheduling', async () => {
        const triggerManifest = {
            version: "4.0.1",
            schemas: [{
                name: "inventory",
                resources: [{
                    type: "TABLE",
                    name: "orders",
                    columns: [{ name: "id", type: "SERIAL", primaryKey: true }, { name: "total", type: "NUMERIC" }],
                    triggers: [
                        {
                            name: "trg_limit_order",
                            event: "BEFORE_INSERT",
                            execute: {
                                type: "EXCEPTION",
                                message: "Order exceeds limit",
                                when: { left: "NEW.total", operator: "GT", right: "10000" }
                            }
                        },
                        {
                            name: "trg_delayed_audit",
                            event: "AFTER_INSERT",
                            schedule: { type: "RELATIVE", offset: "1 hour" },
                            execute: { type: "AUDIT" }
                        }
                    ]
                }]
            }]
        };

        const res = await request(app).post('/api/metadata/apply').set('Authorization', `Bearer ${tenantToken}`).send(triggerManifest);
        expect(res.status).toBe(200);
    });

    it('Scenario: Recursive Views (Org Chart)', async () => {
        const recursiveManifest = {
            version: "4.0.2",
            schemas: [{
                name: "hr",
                resources: [
                    {
                        type: "TABLE",
                        name: "employees",
                        columns: [
                            { name: "id", type: "SERIAL", primaryKey: true },
                            { name: "name", type: "TEXT" },
                            { name: "manager_id", type: "INTEGER" }
                        ]
                    },
                    {
                        type: "VIEW",
                        name: "v_org_hierarchy",
                        recursive: true,
                        query: {
                            recursive: true,
                            with: [{
                                name: "employee_levels",
                                columns: ["id", "name", "level"],
                                base: {
                                    select: ["id", "name", { expression: "1", alias: "level" }],
                                    from: { resource: "employees" },
                                    where: [{ column: "manager_id", operator: "IS_NULL", value: "" }]
                                },
                                unionAll: {
                                    select: ["e.id", "e.name", { expression: "el.level + 1", alias: "level" }],
                                    from: { resource: "employees", alias: "e" },
                                    joins: [{ resource: "employee_levels", alias: "el", on: { left: "e.manager_id", operator: "EQ", right: "el.id" } }]
                                }
                            }],
                            select: ["*"],
                            from: { resource: "employee_levels" }
                        }
                    }
                ]
            }]
        };

        const res = await request(app).post('/api/metadata/apply').set('Authorization', `Bearer ${tenantToken}`).send(recursiveManifest);
        expect(res.status).toBe(200);
    });
});
