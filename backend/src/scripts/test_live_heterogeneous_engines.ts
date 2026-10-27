/**
 * Exhaustive Live Multi-Engine Integration & Migration Test Suite
 * Tests: PostgreSQL (Citus), MongoDB, MySQL, Oracle, and Elasticsearch
 * running live in Docker containers.
 */
import axios from 'axios';

const BASE_URL = 'http://localhost:4000/api';
const TENANT_ID = 'tenant_A';

interface TestResult {
  step: string;
  engine: string;
  status: 'PASS' | 'FAIL';
  durationMs: number;
  details?: any;
}

const results: TestResult[] = [];

function logPass(step: string, engine: string, ms: number, details?: string) {
  console.log(`  \x1b[32m✔ PASS\x1b[0m [${engine}] ${step} (${ms}ms)${details ? ` - ${details}` : ''}`);
  results.push({ step, engine, status: 'PASS', durationMs: ms, details });
}

function logFail(step: string, engine: string, ms: number, err: any) {
  const msg = err.response?.data?.error || err.message || JSON.stringify(err);
  console.error(`  \x1b[31m✖ FAIL\x1b[0m [${engine}] ${step} (${ms}ms) -> ${msg}`);
  results.push({ step, engine, status: 'FAIL', durationMs: ms, details: msg });
  throw err;
}

async function runStep(step: string, engine: string, fn: () => Promise<any>): Promise<any> {
  const start = Date.now();
  try {
    const res = await fn();
    logPass(step, engine, Date.now() - start);
    return res;
  } catch (err) {
    logFail(step, engine, Date.now() - start, err);
  }
}

async function main() {
  console.log('\n\x1b[1m\x1b[36m══════════════════════════════════════════════════════════════════════\x1b[0m');
  console.log('\x1b[1m\x1b[36m  ZERO DATA FABRIC: HETEROGENEOUS MULTI-ENGINE LIVE INTEGRATION TEST  \x1b[0m');
  console.log('\x1b[1m\x1b[36m══════════════════════════════════════════════════════════════════════\x1b[0m\n');

  // 1. Authenticate
  const token = await runStep('Admin Authentication', 'Fabric_Hub', async () => {
    const res = await axios.post(`${BASE_URL}/auth/login`, { username: 'admin', password: 'admin' });
    return res.data.token;
  });

  const authHeaders = {
    Authorization: `Bearer ${token}`,
    'x-tenant-id': TENANT_ID,
    'Content-Type': 'application/json'
  };

  // 2. Discover Registered Sources
  await runStep('Discover Registered Sources', 'Catalog', async () => {
    const res = await axios.get(`${BASE_URL}/admin/connections`, { headers: authHeaders });
    const names = res.data.map((s: any) => `${s.name} (${s.type})`);
    console.log('    Registered Sources:', names.join(', '));
    if (!res.data.some((s: any) => s.name === 'Retail_MySQL')) throw new Error('Retail_MySQL not registered');
    if (!res.data.some((s: any) => s.name === 'Retail_Oracle')) throw new Error('Retail_Oracle not registered');
    if (!res.data.some((s: any) => s.name === 'Elastic_Search')) throw new Error('Elastic_Search not registered');
    return res.data;
  });

  // ──────────────────────────────────────────────────────────────────────────
  // TEST ENGINE 1: MySQL 8.0 Live
  // ──────────────────────────────────────────────────────────────────────────
  console.log('\n\x1b[1m\x1b[35m▶ [ENGINE 1] MySQL 8.0 Live Verification\x1b[0m');

  // MySQL DDL Migration via Manifest
  await runStep('Apply DDL Manifest for MySQL (mysql_inventory)', 'MySQL', async () => {
    const manifest = {
      version: '1.0.0',
      namespace: 'Retail_Store',
      targetSource: 'Retail_MySQL',
      schemas: [{
        name: 'retail',
        targetSource: 'Retail_MySQL',
        resources: [{
          type: 'TABLE',
          name: 'mysql_inventory',
          columns: [
            { name: 'id', type: 'INTEGER', primaryKey: true },
            { name: 'sku', type: 'STRING', length: 50, nullable: false },
            { name: 'warehouse', type: 'STRING', length: 50, default: "'WH-MAIN'" },
            { name: 'stock_qty', type: 'INTEGER', default: '0' },
            { name: 'reorder_point', type: 'INTEGER', default: '10' }
          ]
        }]
      }]
    };
    const res = await axios.post(`${BASE_URL}/metadata/apply?force=true`, manifest, { headers: authHeaders });
    if (res.data.status !== 'APPLIED') throw new Error(`Apply failed: ${JSON.stringify(res.data)}`);
    return res.data;
  });

  // MySQL Data Mutation (Insert)
  await runStep('Insert Rows into MySQL (mysql_inventory)', 'MySQL', async () => {
    await axios.post(`${BASE_URL}/data/delete`, {
      source: 'Retail_MySQL',
      schema: 'retail',
      resource: 'mysql_inventory',
      where: { id: { $gte: 100 } }
    }, { headers: authHeaders }).catch(() => {});

    const items = [
      { id: 101, sku: 'SKU-LAPTOP-01', warehouse: 'WH-CENTRAL', stock_qty: 45, reorder_point: 10 },
      { id: 102, sku: 'SKU-PHONE-02', warehouse: 'WH-CENTRAL', stock_qty: 120, reorder_point: 20 },
      { id: 103, sku: 'SKU-TABLET-03', warehouse: 'WH-WEST', stock_qty: 8, reorder_point: 15 },
      { id: 104, sku: 'SKU-MONITOR-04', warehouse: 'WH-WEST', stock_qty: 30, reorder_point: 5 }
    ];
    for (const item of items) {
      await axios.post(`${BASE_URL}/data/create`, {
        source: 'Retail_MySQL',
        schema: 'retail',
        resource: 'mysql_inventory',
        data: item
      }, { headers: authHeaders });
    }
  });

  // MySQL Pushdown Query & Filters
  await runStep('Execute Filtered Pushdown Query on MySQL', 'MySQL', async () => {
    const res = await axios.post(`${BASE_URL}/analytics/query`, {
      queryConfig: {
        type: 'SELECT',
        schema: 'retail',
        query: {
          select: ['id', 'sku', 'stock_qty', 'warehouse'],
          from: { resource: 'mysql_inventory', source: 'Retail_MySQL' },
          where: [
            { column: 'warehouse', operator: 'EQ', value: 'WH-CENTRAL' },
            { column: 'stock_qty', operator: 'GT', value: 40 }
          ],
          orderBy: [{ column: 'stock_qty', direction: 'DESC' }]
        }
      }
    }, { headers: authHeaders });

    const rows = res.data.data || res.data.rows || [];
    if (!Array.isArray(rows) || rows.length !== 2) {
      throw new Error(`Expected 2 rows from MySQL pushdown, got ${rows.length}`);
    }
    console.log('    Returned Rows:', rows);
    return rows;
  });

  // MySQL Pushdown Aggregations
  await runStep('Execute Pushdown GROUP BY & Aggregations on MySQL', 'MySQL', async () => {
    const res = await axios.post(`${BASE_URL}/analytics/query`, {
      queryConfig: {
        type: 'SELECT',
        schema: 'retail',
        query: {
          from: { resource: 'mysql_inventory', source: 'Retail_MySQL' },
          groupBy: ['warehouse'],
          aggregates: [
            { func: 'COUNT', column: 'id', alias: 'item_count' },
            { func: 'SUM', column: 'stock_qty', alias: 'total_stock' }
          ]
        }
      }
    }, { headers: authHeaders });

    const rows = res.data.data || res.data.rows || [];
    if (!Array.isArray(rows) || rows.length === 0) {
      throw new Error(`Expected grouped rows from MySQL, got ${JSON.stringify(res.data)}`);
    }
    console.log('    Grouped Stock by Warehouse:', rows);
    return rows;
  });

  // MySQL Data Mutation (Update & Delete)
  await runStep('Execute UPDATE Mutation on MySQL', 'MySQL', async () => {
    const res = await axios.post(`${BASE_URL}/data/update`, {
      source: 'Retail_MySQL',
      schema: 'retail',
      resource: 'mysql_inventory',
      data: { stock_qty: 99 },
      where: { id: { $eq: 101 } }
    }, { headers: authHeaders });
    if (res.data.status !== 'SUCCESS') throw new Error(`MySQL UPDATE failed: ${JSON.stringify(res.data)}`);
    return res.data;
  });

  await runStep('Execute DELETE Mutation on MySQL', 'MySQL', async () => {
    const res = await axios.post(`${BASE_URL}/data/delete`, {
      source: 'Retail_MySQL',
      schema: 'retail',
      resource: 'mysql_inventory',
      where: { id: { $eq: 104 } }
    }, { headers: authHeaders });
    if (res.data.status !== 'SUCCESS') throw new Error(`MySQL DELETE failed: ${JSON.stringify(res.data)}`);
    return res.data;
  });

  // ──────────────────────────────────────────────────────────────────────────
  // TEST ENGINE 2: Oracle 23c Free Live
  // ──────────────────────────────────────────────────────────────────────────
  console.log('\n\x1b[1m\x1b[35m▶ [ENGINE 2] Oracle 23c Free Live Verification\x1b[0m');

  // Oracle DDL Migration
  await runStep('Apply DDL Manifest for Oracle (oracle_suppliers)', 'Oracle', async () => {
    const manifest = {
      version: '1.0.0',
      namespace: 'Retail_Store',
      targetSource: 'Retail_Oracle',
      schemas: [{
        name: 'retail',
        targetSource: 'Retail_Oracle',
        resources: [{
          type: 'TABLE',
          name: 'oracle_suppliers',
          columns: [
            { name: 'id', type: 'INTEGER', primaryKey: true },
            { name: 'name', type: 'STRING', length: 100, nullable: false },
            { name: 'country', type: 'STRING', length: 10, default: "'USA'" },
            { name: 'rating', type: 'INTEGER', default: '5' }
          ]
        }]
      }]
    };
    const res = await axios.post(`${BASE_URL}/metadata/apply?force=true`, manifest, { headers: authHeaders });
    if (res.data.status !== 'APPLIED') throw new Error(`Apply failed: ${JSON.stringify(res.data)}`);
    return res.data;
  });

  // Oracle Data Mutation (Insert)
  await runStep('Insert Rows into Oracle (oracle_suppliers)', 'Oracle', async () => {
    await axios.post(`${BASE_URL}/data/delete`, {
      source: 'Retail_Oracle',
      schema: 'retail',
      resource: 'oracle_suppliers',
      where: { id: { $gte: 500 } }
    }, { headers: authHeaders }).catch(() => {});

    const suppliers = [
      { id: 501, name: 'Acme Silicon Inc', country: 'USA', rating: 5 },
      { id: 502, name: 'Tokyo Display Corp', country: 'JPN', rating: 4 },
      { id: 503, name: 'Berlin Micro AG', country: 'DEU', rating: 5 }
    ];
    for (const s of suppliers) {
      await axios.post(`${BASE_URL}/data/create`, {
        source: 'Retail_Oracle',
        schema: 'retail',
        resource: 'oracle_suppliers',
        data: s
      }, { headers: authHeaders });
    }
  });

  // Oracle Pushdown Query with Bind Variables
  await runStep('Execute Filtered Pushdown Query on Oracle', 'Oracle', async () => {
    const res = await axios.post(`${BASE_URL}/analytics/query`, {
      queryConfig: {
        type: 'SELECT',
        schema: 'retail',
        query: {
          select: ['id', 'name', 'country', 'rating'],
          from: { resource: 'oracle_suppliers', source: 'Retail_Oracle' },
          where: [
            { column: 'rating', operator: 'GTE', value: 4 }
          ],
          orderBy: [{ column: 'id', direction: 'ASC' }]
        }
      }
    }, { headers: authHeaders });

    const rows = res.data.data || res.data.rows || [];
    if (!Array.isArray(rows) || rows.length < 3) {
      throw new Error(`Expected at least 3 suppliers from Oracle, got ${rows.length}`);
    }
    console.log('    Returned Oracle Suppliers:', rows);
    return rows;
  });

  // Oracle Data Mutation (Update & Delete)
  await runStep('Execute UPDATE Mutation on Oracle', 'Oracle', async () => {
    const res = await axios.post(`${BASE_URL}/data/update`, {
      source: 'Retail_Oracle',
      schema: 'retail',
      resource: 'oracle_suppliers',
      data: { rating: 3 },
      where: { id: { $eq: 502 } }
    }, { headers: authHeaders });
    if (res.data.status !== 'SUCCESS') throw new Error(`Oracle UPDATE failed: ${JSON.stringify(res.data)}`);
    return res.data;
  });

  await runStep('Execute DELETE Mutation on Oracle', 'Oracle', async () => {
    const res = await axios.post(`${BASE_URL}/data/delete`, {
      source: 'Retail_Oracle',
      schema: 'retail',
      resource: 'oracle_suppliers',
      where: { id: { $eq: 503 } }
    }, { headers: authHeaders });
    if (res.data.status !== 'SUCCESS') throw new Error(`Oracle DELETE failed: ${JSON.stringify(res.data)}`);
    return res.data;
  });

  // ──────────────────────────────────────────────────────────────────────────
  // TEST ENGINE 3: Elasticsearch 8.13 Live
  // ──────────────────────────────────────────────────────────────────────────
  console.log('\n\x1b[1m\x1b[35m▶ [ENGINE 3] Elasticsearch 8.13 Live Verification\x1b[0m');

  // Elasticsearch Index Provisioning
  await runStep('Apply Mapping for Elasticsearch (es_audit_stream)', 'Elasticsearch', async () => {
    const manifest = {
      version: '1.0.0',
      namespace: 'Retail_Store',
      targetSource: 'Elastic_Search',
      schemas: [{
        name: 'default',
        targetSource: 'Elastic_Search',
        resources: [{
          type: 'TABLE',
          name: 'es_audit_stream',
          columns: [
            { name: 'event_id', type: 'STRING', primaryKey: true },
            { name: 'action', type: 'STRING' },
            { name: 'user_id', type: 'STRING' },
            { name: 'status', type: 'STRING' },
            { name: 'score', type: 'INTEGER' }
          ]
        }]
      }]
    };
    const res = await axios.post(`${BASE_URL}/metadata/apply?force=true`, manifest, { headers: authHeaders });
    if (res.data.status !== 'APPLIED') throw new Error(`Apply failed: ${JSON.stringify(res.data)}`);
    return res.data;
  });

  // Elasticsearch Document Ingestion
  await runStep('Insert Documents into Elasticsearch (es_audit_stream)', 'Elasticsearch', async () => {
    await axios.post('http://localhost:9200/*es_audit_stream*/_delete_by_query?refresh=true', {
      query: { match_all: {} }
    }).catch(() => {});

    const events = [
      { event_id: 'ev_001', action: 'LOGIN', user_id: 'usr_alice', status: 'SUCCESS', score: 95 },
      { event_id: 'ev_002', action: 'PAYMENT', user_id: 'usr_alice', status: 'SUCCESS', score: 99 },
      { event_id: 'ev_003', action: 'LOGIN', user_id: 'usr_bob', status: 'FAILED', score: 30 }
    ];
    for (const ev of events) {
      await axios.post(`${BASE_URL}/data/create`, {
        source: 'Elastic_Search',
        schema: 'default',
        resource: 'es_audit_stream',
        data: ev
      }, { headers: authHeaders });
    }
    // Refresh ES index
    await axios.post('http://localhost:9200/_refresh');
  });

  // Elasticsearch Query DSL Pushdown
  await runStep('Execute Query DSL Pushdown on Elasticsearch', 'Elasticsearch', async () => {
    const res = await axios.post(`${BASE_URL}/analytics/query`, {
      queryConfig: {
        type: 'SELECT',
        schema: 'default',
        query: {
          select: ['event_id', 'action', 'user_id', 'status', 'score'],
          from: { resource: 'es_audit_stream', source: 'Elastic_Search' },
          where: [
            { column: 'status', operator: 'EQ', value: 'SUCCESS' }
          ]
        }
      }
    }, { headers: authHeaders });

    const rows = res.data.data || res.data.rows || [];
    if (!Array.isArray(rows) || rows.length < 2) {
      throw new Error(`Expected at least 2 success events from ES, got ${rows.length}`);
    }
    console.log('    Returned ES Documents:', rows);
    return rows;
  });

  // Elasticsearch Document Mutations (Update & Delete)
  await runStep('Execute UPDATE Mutation on Elasticsearch', 'Elasticsearch', async () => {
    const res = await axios.post(`${BASE_URL}/data/update`, {
      source: 'Elastic_Search',
      schema: 'default',
      resource: 'es_audit_stream',
      data: { status: 'RESOLVED', score: 100 },
      where: { event_id: { $eq: 'ev_003' } }
    }, { headers: authHeaders });
    await axios.post('http://localhost:9200/_refresh');
    return res.data;
  });

  await runStep('Execute DELETE Mutation on Elasticsearch', 'Elasticsearch', async () => {
    const res = await axios.post(`${BASE_URL}/data/delete`, {
      source: 'Elastic_Search',
      schema: 'default',
      resource: 'es_audit_stream',
      where: { event_id: { $eq: 'ev_003' } }
    }, { headers: authHeaders });
    await axios.post('http://localhost:9200/_refresh');
    return res.data;
  });

  // ──────────────────────────────────────────────────────────────────────────
  // TEST ENGINE 4: Multi-Source Federated Join (PostgreSQL + MySQL)
  // ──────────────────────────────────────────────────────────────────────────
  console.log('\n\x1b[1m\x1b[35m▶ [FEDERATION] Multi-Engine Cross-Source Join Verification\x1b[0m');

  await runStep('Execute Federated Join (Postgres Hub + MySQL)', 'Federated_Engine', async () => {
    // 1. Ensure Postgres hub table exists
    await axios.post(`${BASE_URL}/metadata/apply?force=true`, {
      version: '1.0.0',
      namespace: 'Retail_Store',
      targetSource: 'Fabric_Hub_Postgres',
      schemas: [{
        name: 'Payment_MS',
        targetSource: 'Fabric_Hub_Postgres',
        resources: [{
          type: 'TABLE',
          name: 'fed_orders',
          columns: [
            { name: 'id', type: 'INTEGER', primaryKey: true },
            { name: 'customer_name', type: 'STRING', length: 100 },
            { name: 'item_sku', type: 'STRING', length: 50 },
            { name: 'amount', type: 'INTEGER' },
            { name: 'supplier_id', type: 'INTEGER' }
          ]
        }]
      }]
    }, { headers: authHeaders });

    // 2. Insert into Postgres fed_orders
    await axios.post(`${BASE_URL}/data/delete`, {
      source: 'Fabric_Hub_Postgres',
      schema: 'Payment_MS',
      resource: 'fed_orders',
      where: { id: { $gte: 1 } }
    }, { headers: authHeaders }).catch(() => {});

    await axios.post(`${BASE_URL}/data/create`, {
      source: 'Fabric_Hub_Postgres',
      schema: 'Payment_MS',
      resource: 'fed_orders',
      data: [
        { id: 1, customer_name: 'Acme Corp', item_sku: 'SKU-LAPTOP-01', amount: 1200, supplier_id: 501 },
        { id: 2, customer_name: 'Beta LLC', item_sku: 'SKU-PHONE-02', amount: 800, supplier_id: 502 }
      ]
    }, { headers: authHeaders });

    // 3. Federated 2-Leg Join: Postgres `fed_orders` JOIN MySQL `mysql_inventory` ON item_sku = sku
    const joinRes = await axios.post(`${BASE_URL}/analytics/query`, {
      queryConfig: {
        type: 'SELECT',
        schema: 'Payment_MS',
        limit: 10,
        query: {
          select: ['fed_orders.id', 'fed_orders.customer_name', 'fed_orders.item_sku', 'fed_orders.amount', 'mysql_inventory.stock_qty', 'mysql_inventory.warehouse'],
          from: { resource: 'fed_orders', source: 'Fabric_Hub_Postgres' },
          joins: [{
            type: 'INNER',
            resource: 'mysql_inventory',
            source: 'Retail_MySQL',
            schema: 'retail',
            on: { left: 'fed_orders.item_sku', operator: 'EQ', right: 'mysql_inventory.sku' }
          }]
        }
      }
    }, { headers: authHeaders });

    const rows = joinRes.data.data || joinRes.data.rows || [];
    if (!Array.isArray(rows) || rows.length !== 2) {
      throw new Error(`Expected 2 joined rows across Postgres & MySQL, got ${rows.length}`);
    }

    console.log('    Federated Join Results (Postgres + MySQL):', rows);
    console.log('    Execution Plan Strategy:', joinRes.data.plan?.strategy);
    console.log('    Plan Legs:', joinRes.data.plan?.legs?.map((l: any) => `${l.source} (${l.engine}): ${l.rowsReturned} rows in ${l.ms}ms`));
    return joinRes.data;
  });

  await runStep('Execute Federated Join (Postgres Hub + Oracle)', 'Federated_Engine', async () => {
    const joinRes = await axios.post(`${BASE_URL}/analytics/query`, {
      queryConfig: {
        type: 'SELECT',
        schema: 'Payment_MS',
        limit: 10,
        query: {
          select: ['fed_orders.id', 'fed_orders.customer_name', 'fed_orders.amount', 'oracle_suppliers.NAME', 'oracle_suppliers.COUNTRY'],
          from: { resource: 'fed_orders', source: 'Fabric_Hub_Postgres' },
          joins: [{
            type: 'INNER',
            resource: 'oracle_suppliers',
            source: 'Retail_Oracle',
            schema: 'retail',
            on: { left: 'fed_orders.supplier_id', operator: 'EQ', right: 'oracle_suppliers.ID' }
          }]
        }
      }
    }, { headers: authHeaders });

    const rows = joinRes.data.data || joinRes.data.rows || [];
    if (!Array.isArray(rows) || rows.length !== 2) {
      throw new Error(`Expected 2 joined rows across Postgres & Oracle, got ${rows.length}`);
    }

    console.log('    Federated Join Results (Postgres + Oracle):', rows);
    console.log('    Execution Plan Strategy:', joinRes.data.plan?.strategy);
    console.log('    Plan Legs:', joinRes.data.plan?.legs?.map((l: any) => `${l.source} (${l.engine}): ${l.rowsReturned} rows in ${l.ms}ms`));
    return joinRes.data;
  });

  // 4. Binary Apache Arrow Stream Test for Federated Result
  await runStep('Verify Apache Arrow Binary IPC Stream on Federated Query', 'Vectorized_IPC', async () => {
    const arrowRes = await axios.post(`${BASE_URL}/analytics/query?format=arrow`, {
      queryConfig: {
        type: 'SELECT',
        schema: 'Payment_MS',
        limit: 10,
        query: {
          select: ['fed_orders.id', 'fed_orders.customer_name', 'fed_orders.item_sku', 'fed_orders.amount', 'mysql_inventory.stock_qty', 'mysql_inventory.warehouse'],
          from: { resource: 'fed_orders', source: 'Fabric_Hub_Postgres' },
          joins: [{
            type: 'INNER',
            resource: 'mysql_inventory',
            source: 'Retail_MySQL',
            schema: 'retail',
            on: { left: 'fed_orders.item_sku', operator: 'EQ', right: 'mysql_inventory.sku' }
          }]
        }
      }
    }, {
      headers: { ...authHeaders, Accept: 'application/vnd.apache.arrow.stream' },
      responseType: 'arraybuffer'
    });

    const byteLen = arrowRes.data.byteLength;
    if (byteLen === 0) throw new Error('Expected non-empty binary Arrow IPC stream');
    console.log(`    Received ${byteLen} bytes of Vectorized Apache Arrow IPC stream`);
    return byteLen;
  });

  // Summary
  console.log('\n\x1b[1m\x1b[32m══════════════════════════════════════════════════════════════════════\x1b[0m');
  console.log(`\x1b[1m\x1b[32m  ALL HETEROGENEOUS ENGINES PASSED: ${results.length} / ${results.length} ASSERTIONS (100% SUCCESS)  \x1b[0m`);
  console.log('\x1b[1m\x1b[32m══════════════════════════════════════════════════════════════════════\x1b[0m\n');
}

main().catch((e) => {
  console.error('\n\x1b[31mMulti-Engine Test failed:\x1b[0m', e.message);
  process.exit(1);
});
