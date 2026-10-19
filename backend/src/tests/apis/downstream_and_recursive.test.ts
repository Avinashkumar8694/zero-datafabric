import request from 'supertest';
import { app } from '../../index';
import { getAdminToken, cleanupTenant, createTenantViaApi, uniqueTenantId, describeIfReachable } from './test_helper';
import { pool } from '../../config/database';

describe('Industrial Data Fabric: Downstream & Recursive Orchestration Suite', () => {
    let adminToken: string;
    const testTenantId = uniqueTenantId('dwn');
    let tenantToken: string;
    const ES = { host: process.env.ES_HOST || 'localhost', port: Number(process.env.ES_PORT || 9200) };

    beforeAll(async () => {
        adminToken = await getAdminToken();
        tenantToken = await createTenantViaApi(adminToken, testTenantId, 'Downstream Test');
    });

    afterAll(async () => {
        await cleanupTenant(testTenantId);
    });

    const downstreamManifest = (snowflakeEnabled: boolean) => ({
        version: "4.0",
        namespace: "GSC_Downstream",
        downstream: [
            { "type": "ELASTICSEARCH", "enabled": true, "fallback": "PRIMARY_SQL" },
            { "type": "SNOWFLAKE", "enabled": snowflakeEnabled, "strategy": "CDC" }
        ],
        resources: [
            {
                "type": "TABLE",
                "name": "shipments",
                "columns": [
                    { "name": "id", "type": "UUID", "primaryKey": true },
                    { "name": "region", "type": "STRING" }
                ]
            },
            {
              "type": "PROCEDURE",
              "name": "process_delivery",
              "parameters": [
                { "name": "p_shipment_id", "type": "UUID", "mode": "IN" },
                { "name": "p_success", "type": "BOOLEAN", "mode": "OUT" }
              ],
              "body": "BEGIN p_success := true; END;"
            }
        ]
    });

    it('Scenario: downstream targets are recorded in the registry; without a configured engine they are NOT_CONFIGURED, disabled ones DISABLED', async () => {
        const res = await request(app).post('/api/metadata/apply').set('Authorization', `Bearer ${tenantToken}`).send(downstreamManifest(true));
        expect(res.status).toBe(200);
        expect(res.body.downstream).toBeDefined();

        // Verify persistence in the registry: no ES / Snowflake data source is registered for this workspace.
        const registryCheck = await pool.query(`SELECT target_type, status FROM fabric_system.downstream_registry WHERE tenant_id = $1`, [testTenantId]);
        expect(registryCheck.rows.length).toBe(2);
        expect(registryCheck.rows.find(r => r.target_type === 'ELASTICSEARCH').status).toBe('NOT_CONFIGURED');
        expect(registryCheck.rows.find(r => r.target_type === 'SNOWFLAKE').status).toBe('NOT_CONFIGURED');

        // Scenario: Disabling Snowflake
        await request(app).post('/api/metadata/apply').set('Authorization', `Bearer ${tenantToken}`).send(downstreamManifest(false)).expect(200);
        const registryCheckV2 = await pool.query(`SELECT status FROM fabric_system.downstream_registry WHERE tenant_id = $1 AND target_type = 'SNOWFLAKE'`, [testTenantId]);
        expect(registryCheckV2.rows[0].status).toBe('DISABLED');

        const status = await request(app).get('/api/metadata/downstream').set('Authorization', `Bearer ${tenantToken}`);
        expect(status.status).toBe(200);
        expect(status.body.find((t: any) => t.target_type === 'SNOWFLAKE').status).toBe('DISABLED');
    });

    // Needs a real Elasticsearch (external infrastructure; override with ES_HOST / ES_PORT). Skipped with a reason when unreachable.
    describeIfReachable('elasticsearch', ES.host, ES.port)('with Elasticsearch', () => {
        it('Scenario: an Elasticsearch data source makes the ELASTICSEARCH downstream ACTIVE', async () => {
            const reg = await request(app).post('/api/admin/connections').set('Authorization', `Bearer ${tenantToken}`)
                .send({ name: 'Downstream_ES', config: { type: 'elasticsearch', host: ES.host, port: ES.port, syncType: 'VIRTUAL' } });
            expect([200, 201]).toContain(reg.status);

            const res = await request(app).post('/api/metadata/apply').set('Authorization', `Bearer ${tenantToken}`).send(downstreamManifest(false));
            expect(res.status).toBe(200);
            const registryCheck = await pool.query(`SELECT status FROM fabric_system.downstream_registry WHERE tenant_id = $1 AND target_type = 'ELASTICSEARCH'`, [testTenantId]);
            expect(registryCheck.rows[0].status).toBe('ACTIVE');
        });
    });

    it('Scenario: Recursive Organizational Hierarchy View', async () => {
        const manifest = {
            version: "4.0",
            namespace: "Org_Recursive",
            resources: [
                {
                    "type": "TABLE",
                    "name": "employees",
                    "columns": [
                        { "name": "id", "type": "INTEGER", "primaryKey": true },
                        { "name": "name", "type": "STRING" },
                        { "name": "manager_id", "type": "INTEGER", "nullable": true }
                    ]
                },
                {
                    "type": "VIEW",
                    "name": "org_hierarchy",
                    "recursive": true,
                    "query": {
                      "with": [
                        {
                          "name": "emp_path",
                          "columns": ["id", "name", "manager_id", "path", "level"],
                          "base": {
                            "select": ["id", "name", "manager_id", { "expression": "name", "alias": "path" }, { "expression": "1", "alias": "level" }],
                            "from": { "resource": "employees" },
                            "where": [{ "column": "manager_id", "operator": "IS_NULL" }]
                          },
                          "unionAll": {
                            "select": ["e.id", "e.name", "e.manager_id", { "expression": "ep.path || ' -> ' || e.name" }, { "expression": "ep.level + 1" }],
                            "from": { "resource": "employees", "alias": "e" },
                            "joins": [{ "type": "INNER", "resource": "emp_path", "alias": "ep", "on": { "left": "e.manager_id", "operator": "EQ", "right": "ep.id" } }]
                          }
                        }
                      ],
                      "select": ["*"],
                      "from": { "resource": "emp_path" }
                    }
                }
            ]
        };

        const res = await request(app).post('/api/metadata/apply').set('Authorization', `Bearer ${tenantToken}`).send(manifest);
        expect(res.status).toBe(200);

        const schemaName = `tenant_${testTenantId}_Org_Recursive`;
        const viewCheck = await pool.query(`SELECT 1 FROM information_schema.views WHERE table_schema = $1 AND table_name = 'org_hierarchy'`, [schemaName]);
        expect(viewCheck.rows.length).toBe(1);
    });

    it('Scenario: Federated Inventory Analysis (UNION/INTERSECT/EXCEPT)', async () => {
        const manifest = {
            version: "4.0",
            namespace: "Inventory_Federated",
            resources: [
                { "type": "TABLE", "name": "local_stock", "columns": [{ "name": "sku", "type": "STRING", "primaryKey": true }, { "name": "qty", "type": "INTEGER" }] },
                { "type": "TABLE", "name": "remote_stock", "columns": [{ "name": "sku", "type": "STRING", "primaryKey": true }, { "name": "qty", "type": "INTEGER" }] },
                {
                    "type": "VIEW",
                    "name": "global_inventory",
                    "query": {
                        "union": [
                            { "select": ["sku", "qty"], "from": { "resource": "local_stock" } },
                            { "select": ["sku", "qty"], "from": { "resource": "remote_stock" } }
                        ]
                    }
                }
            ]
        };

        const res = await request(app).post('/api/metadata/apply').set('Authorization', `Bearer ${tenantToken}`).send(manifest);
        expect(res.status).toBe(200);
    });
});
