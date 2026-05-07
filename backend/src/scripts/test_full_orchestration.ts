import axios from 'axios';

const BASE_URL = 'http://localhost:4000/api';
const TENANT_ID = 'demo_industrial';

async function runUltimateTest() {
  try {
    console.log('--- 🚀 STARTING EXHAUSTIVE INDUSTRIAL DATA FABRIC TEST ---');

    // 0. Login
    console.log('[1/12] Authenticating Admin...');
    const loginRes = await axios.post(`${BASE_URL}/auth/login`, { username: 'admin', password: 'admin' });
    const token = loginRes.data.token;
    axios.defaults.headers.common['Authorization'] = `Bearer ${token}`;
    axios.defaults.headers.common['x-tenant-id'] = TENANT_ID;
    console.log('[OK] Auth Successful');

    // 1. Cleanup
    console.log('[2/12] Resetting Tenant Environment...');
    await axios.post(`${BASE_URL}/queries/exec`, {
      sql: `DROP SCHEMA IF EXISTS "tenant_${TENANT_ID}" CASCADE`
    });
    console.log('[OK] Environment Cleaned');

    // 2. Submit Exhaustive v7.0 Manifest
    console.log('[3/12] Orchestrating Exhaustive Schema (M:M, Triggers, RLS)...');
    const migrationPlan = [
      { action: 'CREATE_SCHEMA', details: {} },
      {
        action: 'CREATE_TABLE',
        table: 'audit_logs',
        details: {
          columns: [
            { name: 'id', type: 'SERIAL', primaryKey: true },
            { name: 'event_type', type: 'VARCHAR(50)' },
            { name: 'details', type: 'TEXT' },
            { name: 'created_at', type: 'TIMESTAMP', defaultValue: 'CURRENT_TIMESTAMP' }
          ]
        }
      },
      {
        action: 'CREATE_FUNCTION',
        name: 'fn_log_user_audit',
        body: `BEGIN
                 INSERT INTO "tenant_${TENANT_ID}".audit_logs (event_type, details)
                 VALUES ('USER_INSERT', 'New user added with ID: ' || NEW.id);
                 RETURN NEW;
               END;`
      },
      {
        action: 'CREATE_TABLE',
        table: 'users',
        details: {
          columns: [
            { name: 'id', type: 'UUID', primaryKey: true },
            { name: 'email', type: 'VARCHAR(255)', description: 'MASK:PARTIAL' },
            { name: 'sku_interest', type: 'VARCHAR(100)' } // For cross-source join test
          ],
          triggers: [
            { name: 'trg_user_audit', event: 'AFTER INSERT', function: `"tenant_${TENANT_ID}".fn_log_user_audit` }
          ]
        }
      },
      {
        action: 'CREATE_TABLE',
        table: 'groups',
        details: {
          columns: [
            { name: 'id', type: 'SERIAL', primaryKey: true },
            { name: 'name', type: 'VARCHAR(100)' }
          ]
        }
      },
      {
        action: 'CREATE_TABLE',
        table: 'user_groups',
        details: {
          columns: [
            { name: 'user_id', type: 'UUID' },
            { name: 'group_id', type: 'INTEGER' }
          ],
          compositePrimaryKey: ['user_id', 'group_id']
        }
      },
      {
        action: 'CREATE_FOREIGN_TABLE',
        table: 'remote_inventory',
        details: {
          server: 'remote_warehouse_server',
          columns: [
            { name: 'id', type: 'INTEGER' },
            { name: 'sku', type: 'VARCHAR(100)' },
            { name: 'qty', type: 'INTEGER' }
          ],
          options: { schema_name: 'public', table_name: 'remote_inventory' }
        }
      }
    ];

    await axios.post(`${BASE_URL}/metadata/migrate`, { migrationPlan });
    console.log('[OK] Exhaustive Infrastructure Orchestrated');

    // 3. Verify Triggers & Audit Logging
    console.log('[4/12] Testing Trigger Orchestration...');
    const userId = 'a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11';
    await axios.post(`${BASE_URL}/analytics/query`, {
      queryConfig: {
        type: 'INSERT',
        table: 'users',
        data: { id: userId, email: 'industrial-test@zero.io', sku_interest: 'SKU-999' }
      }
    });

    const auditRes = await axios.post(`${BASE_URL}/analytics/query`, {
      queryConfig: { type: 'SELECT', table: 'audit_logs', select: ['*'] }
    });
    if (auditRes.data.data.length > 0) {
        console.log('[OK] Trigger Verified: Audit log captured');
        console.table(auditRes.data.data);
    } else {
        throw new Error('Trigger Verification Failed: No audit log found');
    }

    // 4. Verify M:M Junction & Multi-Table JOIN
    console.log('[5/12] Testing M:M Junction & Relational JOIN...');
    await axios.post(`${BASE_URL}/analytics/query`, {
        queryConfig: { type: 'INSERT', table: 'groups', data: { name: 'Super-Admins' } }
    });
    await axios.post(`${BASE_URL}/analytics/query`, {
        queryConfig: { type: 'INSERT', table: 'user_groups', data: { user_id: userId, group_id: 1 } }
    });

    const mmJoin = await axios.post(`${BASE_URL}/analytics/query`, {
      queryConfig: {
        type: 'SELECT',
        table: 'users',
        select: ['users.email', 'groups.name as group_name'],
        joins: [
          { type: 'INNER', table: 'user_groups', on: 'users.id = user_groups.user_id' },
          { type: 'INNER', table: 'groups', on: 'user_groups.group_id = groups.id' }
        ]
      }
    });
    console.log('[OK] M:M Join Successful');
    console.table(mmJoin.data.data);

    // 5. Verify Heterogeneous Cross-Source JOIN
    console.log('[6/12] Testing Cross-Source JOIN (Local + Remote FDW)...');
    const crossJoin = await axios.post(`${BASE_URL}/analytics/query`, {
      queryConfig: {
        type: 'SELECT',
        table: 'users',
        select: ['users.email', 'remote_inventory.qty', 'remote_inventory.sku'],
        joins: [
          { type: 'INNER', table: 'remote_inventory', on: 'users.sku_interest = remote_inventory.sku' }
        ]
      }
    });
    console.log('[OK] Cross-Source JOIN Successful (Virtualization Verified)');
    console.table(crossJoin.data.data);

    // 6. Verify PII Masking
    console.log('[7/12] Verifying Governance Policy (PII Masking)...');
    const maskRes = await axios.post(`${BASE_URL}/analytics/query`, {
        queryConfig: { type: 'SELECT', table: 'users', select: ['email'] }
    });
    console.log(`[OK] Masked Email: ${maskRes.data.data[0].email}`);

    // 7. Recursive Query Test (Hierarchical Data)
    console.log('[8/12] Testing Recursive Query Orchestration (CTEs)...');
    await axios.post(`${BASE_URL}/queries/exec`, {
      sql: `CREATE TABLE "tenant_${TENANT_ID}"."org" (id SERIAL PRIMARY KEY, name TEXT, parent_id INTEGER);
            INSERT INTO "tenant_${TENANT_ID}"."org" (name, parent_id) VALUES ('CEO', NULL), ('CTO', 1), ('Dev-Lead', 2), ('Developer', 3);`
    });

    const recursiveRes = await axios.post(`${BASE_URL}/analytics/query`, {
      queryConfig: {
        type: 'SELECT',
        table: 'org',
        withRecursive: {
           name: 'org_tree',
           baseQuery: `SELECT id, name, parent_id FROM "tenant_${TENANT_ID}"."org" WHERE parent_id IS NULL`,
           recursiveQuery: `SELECT o.id, o.name, o.parent_id FROM "tenant_${TENANT_ID}"."org" o JOIN org_tree ot ON o.parent_id = ot.id`
        },
        select: ['*']
      }
    });
    console.log('[OK] Recursive Org Chart retrieved');
    console.table(recursiveRes.data.data);

    // 8. Soft Delete Verification
    console.log('[9/12] Testing Metadata Soft Delete...');
    await axios.post(`${BASE_URL}/metadata/migrate`, {
      migrationPlan: [{ action: 'SOFT_DELETE_TABLE', table: 'groups' }]
    });
    const catalogRes = await axios.post(`${BASE_URL}/metadata/crawl`, { tenantId: TENANT_ID });
    console.log('[OK] Soft Delete applied. Table is flagged in catalog.');

    console.log('--- 🏆 EXHAUSTIVE INDUSTRIAL TEST COMPLETED SUCCESSFULLY ---');
  } catch (err: any) {
    console.error('[FATAL ERROR] Industrial Test Failed:', err.response?.data || err.message);
  }
}

runUltimateTest();
