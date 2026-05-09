import request from 'supertest';
import { app } from '../../index';
import { pool } from '../../config/database';
import { getAdminToken, cleanupTenant } from './test_helper';

describe('Industrial Data Fabric: Global Supply Chain v4.0 (The Ultimate Test)', () => {
    let adminToken: string;
    const ts = Date.now();
    const testTenantId = `gsc_v4_${ts}`;
    let tenantToken: string;

    const gscManifest = {
      "version": "4.0.0",
      "namespace": "Global_Supply_Chain",
      "targetSource": "Fabric_Hub_Postgres",
      "consistencyMode": "SAGA", 
      "downstream": [
        { "type": "ELASTICSEARCH", "enabled": true, "fallback": "PRIMARY_SQL" },
        { "type": "SNOWFLAKE", "enabled": true, "strategy": "CDC" }
      ],
      "extensions": ["uuid-ossp", "pg_stat_statements", "btree_gist"],
      "resources": [
        {
          "type": "ENUM",
          "name": "shipment_status",
          "values": ["PENDING", "IN_TRANSIT", "DELIVERED", "CANCELLED"]
        },
        {
          "type": "SEQUENCE",
          "name": "tracking_seq",
          "start": 100000,
          "increment": 1,
          "minValue": 100000,
          "maxValue": 999999999,
          "cache": 20
        },
        {
          "type": "FUNCTION",
          "name": "generate_custom_id",
          "arguments": [{ "name": "p_region", "type": "STRING" }],
          "returnType": "STRING",
          "body": "DECLARE v_seq BIGINT; BEGIN v_seq := nextval('tracking_seq'); RETURN p_region || '-' || to_char(NOW(), 'YYYY') || '-' || lpad(v_seq::text, 8, '0'); END;"
        },
        {
          "type": "TABLE",
          "name": "shipments",
          "comment": "Master table for global logistics tracking",
          "partitionBy": { "type": "RANGE", "column": "created_at" },
          "identity": { "type": "PRIMARY_KEY", "columns": ["id", "region", "created_at"] },
          "maintenance": { "autovacuum_enabled": true, "fillfactor": 80 },
          "columns": [
            { "name": "id", "type": "UUID", "default": "gen_random_uuid()", "strategy": "UUID_V7" },
            { "name": "internal_id", "type": "BIGINT", "strategy": "IDENTITY_ALWAYS" },
            { "name": "legacy_id", "type": "SERIAL", "strategy": "LEGACY_SERIAL" },
            { "name": "custom_id", "type": "STRING", "default": "generate_custom_id(region)", "strategy": "FUNCTIONAL" },
            { "name": "region", "type": "STRING", "length": 10 },
            { "name": "full_tracking_label", "type": "STRING", "generated": "id || ' [' || region || ']'", "stored": true },
            { "name": "status", "type": "ENUM", "ref": "shipment_status", "default": "PENDING" },
            { "name": "metadata", "type": "JSONB", "comment": "Flexible attributes", "index": { "type": "GIN" } },
            { "name": "created_at", "type": "TIMESTAMP", "default": "NOW()", "index": { "type": "BRIN" } }
          ],
          "constraints": [
            { "name": "exclude_overlapping_shipments", "type": "EXCLUDE", "using": "GIST", "columns": [{ "name": "region", "operator": "=" }, { "name": "created_at", "operator": "=" }] }
          ]
        },
        {
          "type": "TABLE",
          "name": "shipment_details",
          "columns": [
            { "name": "shipment_id", "type": "UUID", "primaryKey": true },
            { "name": "total_amount", "type": "NUMERIC" }
          ]
        },
        {
          "type": "VIEW",
          "name": "high_value_regional_summary",
          "query": {
            "select": [
              { "column": "s.region" },
              { "aggregate": "SUM", "column": "d.total_amount", "alias": "revenue" },
              { "window": "RANK", "partitionBy": ["s.region"], "orderBy": [{ "column": "d.total_amount", "direction": "DESC" }], "alias": "rank" }
            ],
            "from": { "resource": "shipments", "alias": "s" },
            "joins": [
              { "type": "LEFT", "resource": "shipment_details", "alias": "d", "on": { "left": "s.id", "operator": "EQ", "right": "d.shipment_id" } }
            ],
            "groupBy": ["s.region", "d.total_amount"]
          }
        }
      ]
    };

    beforeAll(async () => {
        adminToken = await getAdminToken();
        await request(app).post('/api/admin/tenants').set('Authorization', `Bearer ${adminToken}`).send({ id: testTenantId, name: 'Global Supply Chain v4' });
        const tokenRes = await request(app).post('/api/auth/token').set('Authorization', `Bearer ${adminToken}`).send({ tenantId: testTenantId });
        tenantToken = tokenRes.body.token;
    });

    afterAll(async () => {
        await cleanupTenant(testTenantId);
        await pool.end();
    });

    it('Scenario: Global Supply Chain v4.0 Full Deployment', async () => {
        const res = await request(app).post('/api/metadata/apply').set('Authorization', `Bearer ${tenantToken}`).send(gscManifest);
        expect(res.status).toBe(200);
        expect(res.body.status).toBe('APPLIED');
        
        const schemaName = `tenant_${testTenantId}_Global_Supply_Chain`;

        // 1. Verify GIN/BRIN Indexes
        const idxCheck = await pool.query(`SELECT indexname, indexdef FROM pg_indexes WHERE schemaname = $1`, [schemaName]);
        const idxNames = idxCheck.rows.map(r => r.indexname);
        expect(idxNames).toContain('idx_shipments_metadata');
        expect(idxNames).toContain('idx_shipments_created_at');
        expect(idxCheck.rows.find(r => r.indexname === 'idx_shipments_created_at').indexdef).toContain('USING brin');

        // 2. Verify Table Comments
        const commentCheck = await pool.query(`SELECT obj_description('"${schemaName}"."shipments"'::regclass, 'pg_class') as comment`);
        expect(commentCheck.rows[0].comment).toBe('Master table for global logistics tracking');

        // 3. Verify Functional Trigger (custom_id)
        const trgCheck = await pool.query(`SELECT trigger_name FROM information_schema.triggers WHERE event_object_schema = $1 AND event_object_table = 'shipments'`, [schemaName]);
        expect(trgCheck.rows.map(r => r.trigger_name)).toContain('trg_func_shipments_custom_id');
    });

    it('Scenario: Industrial Rollback (Time-Machine) for Global Supply Chain', async () => {
        const v2 = { ...gscManifest, version: "4.0.1", resources: [] };
        const resFail = await request(app).post('/api/metadata/apply').set('Authorization', `Bearer ${tenantToken}`).send(v2);
        expect(resFail.status).toBe(400); // Guardrail Triggered (Empty recursos = Integrity Violation)

        await request(app).post('/api/metadata/apply?force=true').set('Authorization', `Bearer ${tenantToken}`).send(v2);
        
        const historyRes = await request(app).get('/api/metadata/history').set('Authorization', `Bearer ${tenantToken}`);
        const v1Entry = historyRes.body.find((h: any) => h.version_tag === '4.0.0');
        
        const rollbackRes = await request(app).post(`/api/metadata/rollback/${v1Entry.id}`).set('Authorization', `Bearer ${tenantToken}`);
        expect(rollbackRes.status).toBe(200);
        
        const schemaName = `tenant_${testTenantId}_Global_Supply_Chain`;
        const tableCheck = await pool.query(`SELECT table_name FROM information_schema.tables WHERE table_schema = $1 AND table_name = 'shipments'`, [schemaName]);
        expect(tableCheck.rows.length).toBe(1);
    });
});
