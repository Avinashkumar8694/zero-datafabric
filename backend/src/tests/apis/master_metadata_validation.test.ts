import request from 'supertest';
import { app } from '../../index';
import { pool } from '../../config/database';
import { getAdminToken, cleanupTenant } from './test_helper';

describe('Industrial Data Fabric: Master Metadata Validation Suite v4.2 (Absolute Exhaustive)', () => {
    let adminToken: string;
    const ts = Date.now();
    const testTenantId = `master_v4_2_${ts}`;
    let tenantToken: string;

    beforeAll(async () => {
        adminToken = await getAdminToken();
        
        // 1. Provision Tenant
        await request(app).post('/api/admin/tenants').set('Authorization', `Bearer ${adminToken}`).send({ 
            id: testTenantId, 
            name: 'Master Industrial Test v4.2' 
        });

        // 2. Get Tenant Token
        const tokenRes = await request(app).post('/api/auth/token').set('Authorization', `Bearer ${adminToken}`).send({ tenantId: testTenantId });
        tenantToken = tokenRes.body.token;
    });

    afterAll(async () => {
        await cleanupTenant(testTenantId);
        await pool.end();
    });

    it('Exhaustive Test: Complete Supply Chain Ecosystem (Postgres + NoSQL Virtualization)', async () => {
        const masterManifest = {
            version: "4.0.0",
            namespace: "global_supply_chain",
            extensions: ["uuid-ossp", "btree_gist"],
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
                            identity: { type: "PRIMARY_KEY", columns: ["id"] },
                            maintenance: { autovacuum_enabled: true, fillfactor: 80 },
                            columns: [
                                { name: "id", type: "BIGINT", strategy: "IDENTITY_ALWAYS" },
                                { name: "sku", type: "TEXT", nullable: false },
                                { name: "price", type: "NUMERIC" },
                                { name: "tax_price", type: "NUMERIC", generated: "price * 1.15", stored: true },
                                { name: "active_range", type: "TSTZRANGE", nullable: false }
                            ],
                            constraints: [
                                { 
                                    name: "exclude_product_overlap", 
                                    type: "EXCLUDE", 
                                    using: "GIST", 
                                    columns: [{ name: "sku", operator: "=" }, { name: "active_range", operator: "&&" }] 
                                }
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
                                    { aggregate: "AVG", column: "price", alias: "avg_price" },
                                    { window: "RANK", partitionBy: ["sku"], orderBy: [{ column: "price", direction: "DESC" }], alias: "rank" }
                                ],
                                from: { resource: "products" },
                                groupBy: ["sku", "price"]
                            },
                            indexes: [{ columns: ["sku"], unique: false }]
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
        
        const schemaName = `tenant_${testTenantId}_inventory`;
        
        // 1. Verify PK with Schema Isolation
        const pkCheck = await pool.query(`
            SELECT a.attname FROM pg_index i 
            JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = ANY(i.indkey)
            JOIN pg_class c ON c.oid = i.indrelid
            JOIN pg_namespace n ON n.oid = c.relnamespace
            WHERE n.nspname = $1 AND c.relname = 'products' AND i.indisprimary
        `, [schemaName]);
        expect(pkCheck.rows[0].attname).toBe('id');

        // 2. Verify EXCLUDE Constraint with Schema Isolation
        const exCheck = await pool.query(`
            SELECT conname FROM pg_constraint c
            JOIN pg_namespace n ON n.oid = c.connamespace
            WHERE n.nspname = $1 AND c.conname = 'exclude_product_overlap'
        `, [schemaName]);
        expect(exCheck.rows.length).toBe(1);

        // 3. Verify Materialized View
        const viewCheck = await pool.query(`SELECT definition FROM pg_matviews WHERE schemaname = $1 AND matviewname = 'v_product_analytics'`, [schemaName]);
        expect(viewCheck.rows[0].definition.toUpperCase()).toContain('RANK() OVER');
    });

    it('Scenario: Trigger Guardrails & Relative Scheduling', async () => {
        const triggerManifest = {
            version: "4.0.1",
            schemas: [{
                name: "inventory_trg", // UNIQUE SCHEMA to avoid quarantine
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
                        }
                    ]
                }]
            }]
        };

        const res = await request(app).post('/api/metadata/apply').set('Authorization', `Bearer ${tenantToken}`).send(triggerManifest);
        expect(res.status).toBe(200);
        
        const schemaName = `tenant_${testTenantId}_inventory_trg`;
        const trgCheck = await pool.query(`SELECT trigger_name FROM information_schema.triggers WHERE event_object_schema = $1 AND event_object_table = 'orders'`, [schemaName]);
        expect(trgCheck.rows.length).toBeGreaterThan(0);
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
                            with: [{
                                name: "employee_levels",
                                columns: ["id", "name", "level"],
                                base: {
                                    select: ["id", "name", { expression: "1", alias: "level" }],
                                    from: { resource: "employees" },
                                    where: [{ column: "manager_id", operator: "IS_NULL" }]
                                },
                                unionAll: {
                                    select: ["e.id", "e.name", { expression: "el.level + 1", alias: "level" }],
                                    from: { resource: "employees", alias: "e" },
                                    joins: [{ resource: "employee_levels", alias: "el", type: "INNER", on: { left: "e.manager_id", operator: "EQ", right: "el.id" } }]
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
        
        const schemaName = `tenant_${testTenantId}_hr`;
        const viewCheck = await pool.query(`SELECT definition FROM pg_views WHERE schemaname = $1 AND viewname = 'v_org_hierarchy'`, [schemaName]);
        expect(viewCheck.rows[0].definition).toContain('WITH RECURSIVE');
    });

    it('Scenario: Complex Set Operations (Federated Virtualization)', async () => {
        const setOpsManifest = {
            version: "4.0.3",
            schemas: [{
                name: "warehouse",
                resources: [
                    {
                        type: "TABLE",
                        name: "local_inventory",
                        columns: [{ name: "sku", type: "TEXT", primaryKey: true }, { name: "qty", type: "INTEGER" }]
                    },
                    {
                        type: "TABLE",
                        name: "remote_inventory",
                        columns: [{ name: "sku", type: "TEXT", primaryKey: true }, { name: "qty", type: "INTEGER" }]
                    },
                    {
                        type: "VIEW",
                        name: "v_federated_inventory",
                        query: {
                            union: [
                                { select: ["sku", "qty"], from: { resource: "local_inventory" } },
                                { select: ["sku", "qty"], from: { resource: "remote_inventory" } }
                            ]
                        }
                    }
                ]
            }]
        };

        const res = await request(app).post('/api/metadata/apply').set('Authorization', `Bearer ${tenantToken}`).send(setOpsManifest);
        expect(res.status).toBe(200);
    });

    it('Scenario: Industrial Risk & Time-Machine Rollback', async () => {
        // 1. Initial State
        const v1 = { version: "1.0", schemas: [{ name: "core", resources: [{ type: "TABLE", name: "users", columns: [{ name: "id", type: "SERIAL", primaryKey: true }] }] }] };
        await request(app).post('/api/metadata/apply').set('Authorization', `Bearer ${tenantToken}`).send(v1);

        // 2. High-Risk Change (Drop Table)
        const v2 = { version: "2.0", schemas: [{ name: "core", resources: [] }] };
        const resFail = await request(app).post('/api/metadata/apply').set('Authorization', `Bearer ${tenantToken}`).send(v2);
        expect(resFail.status).toBe(400);

        // 3. Force Apply
        await request(app).post('/api/metadata/apply?force=true').set('Authorization', `Bearer ${tenantToken}`).send(v2);
        
        // 4. Rollback to v1
        const historyRes = await request(app).get('/api/metadata/history').set('Authorization', `Bearer ${tenantToken}`);
        const v1Entry = historyRes.body.find((h: any) => h.version_tag === '1.0');
        
        const rollbackRes = await request(app).post(`/api/metadata/rollback/${v1Entry.id}`).set('Authorization', `Bearer ${tenantToken}`);
        expect(rollbackRes.status).toBe(200);
        
        const schemaName = `tenant_${testTenantId}_core`;
        const tableCheck = await pool.query(`SELECT table_name FROM information_schema.tables WHERE table_schema = $1 AND table_name = 'users'`, [schemaName]);
        expect(tableCheck.rows.length).toBe(1);
    });
});
