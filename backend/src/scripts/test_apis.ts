import axios from 'axios';

const BASE_URL = 'http://localhost:4000/api';
const TENANT_ID = 'tenant123';

async function runTests() {
  try {
    console.log('--- Starting Industrial Data Fabric API Verification ---');

    // 0. Login to get Token
    console.log('[Auth] Logging in as admin...');
    const loginRes = await axios.post(`${BASE_URL}/auth/login`, {
      username: 'admin',
      password: 'admin'
    });
    const token = loginRes.data.token;
    console.log('[OK] Authenticated successfully');

    // Set common headers
    axios.defaults.headers.common['Authorization'] = `Bearer ${token}`;
    axios.defaults.headers.common['x-tenant-id'] = TENANT_ID;

    // 1. Setup Local Data for JOIN test
    console.log('[Test 1] Preparing local products table...');
    await axios.post(`${BASE_URL}/analytics/query`, {
      queryConfig: { type: 'DROP_TABLE', table: 'local_products' }
    });

    await axios.post(`${BASE_URL}/analytics/query`, {
      queryConfig: {
        type: 'CREATE_TABLE',
        table: 'local_products',
        schemaDef: {
          columns: [
            { name: 'sku', type: 'VARCHAR(100)', constraints: 'PRIMARY KEY' },
            { name: 'name', type: 'VARCHAR(255)' }
          ]
        }
      }
    });

    await axios.post(`${BASE_URL}/analytics/query`, {
      queryConfig: {
        type: 'INSERT',
        table: 'local_products',
        data: { sku: 'SKU-999', name: 'Ultra High-Def Monitor' }
      }
    });
    console.log('[OK] Local products seeded');

    // 2. Metadata Discovery (Crawl)
    console.log('[Test 2] Triggering Metadata Discovery (Crawl)...');
    const crawlRes = await axios.post(`${BASE_URL}/metadata/crawl`, { tenantId: TENANT_ID });
    console.log(`[OK] Crawled ${crawlRes.data.columnCount} columns`);

    // 3. Query Virtual Data
    console.log('[Test 3] Querying Virtual Table directly...');
    const virtualQuery = await axios.post(`${BASE_URL}/analytics/query`, {
      queryConfig: {
        type: 'SELECT',
        table: 'remote_inventory',
        select: ['*']
      }
    });
    console.log(`[OK] Retrieved ${virtualQuery.data.length} records from remote_db`);
    console.table(virtualQuery.data);

    // 4. Cross-Source JOIN (The ultimate Data Fabric test)
    console.log('[Test 4] Executing Cross-Source JOIN (Local Postgres + Remote Postgres)...');
    const joinQuery = await axios.post(`${BASE_URL}/analytics/query`, {
      queryConfig: {
        type: 'SELECT',
        table: 'local_products',
        select: ['local_products.name', 'remote_inventory.qty'],
        joins: [
          {
            type: 'INNER',
            table: 'remote_inventory',
            on: 'local_products.sku = remote_inventory.sku'
          }
        ]
      }
    });
    console.log(`[OK] JOIN Successful! Data merged across sources.`);
    console.table(joinQuery.data);

    // 5. Async Query Test
    console.log('[Test 5] Triggering Asynchronous Analytics Job...');
    const asyncRes = await axios.post(`${BASE_URL}/analytics/query-async`, {
      queryConfig: {
        type: 'SELECT',
        table: 'remote_inventory',
        select: ['SUM(qty) as total_qty']
      }
    });
    const jobId = asyncRes.data.jobId;
    console.log(`[OK] Job started with ID: ${jobId}`);

    // Poll for status
    let completed = false;
    while (!completed) {
      const statusRes = await axios.get(`${BASE_URL}/analytics/jobs/${jobId}`);
      if (statusRes.data.status === 'COMPLETED') {
        console.log('[OK] Async Job Completed!');
        console.table(statusRes.data.result);
        completed = true;
      } else if (statusRes.data.status === 'FAILED') {
        throw new Error(`Async job failed: ${statusRes.data.error}`);
      } else {
        console.log(`... job status: ${statusRes.data.status}`);
        await new Promise(r => setTimeout(r, 1000));
      }
    }

    console.log('--- All Industrial Verification Tests PASSED ---');
  } catch (err: any) {
    console.error('[FATAL ERROR] API Verification Failed:', err.response?.data || err.message);
  }
}

runTests();
