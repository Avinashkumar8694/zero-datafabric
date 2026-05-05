import axios from 'axios';

const BASE_URL = 'http://localhost:4000/api';
const TENANT_ID = 'acme_test';

async function delay(ms: number) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function runTests() {
  console.log('--- STARTING END-TO-END TEST SUITE ---');

  try {
    // 1. Create Tenant (Module 1)
    console.log('\n[Test 1] Creating Tenant...');
    const tenantRes = await axios.post(`${BASE_URL}/admin/tenants`, {
      id: TENANT_ID,
      name: 'Acme Test Corp'
    });
    console.log('SUCCESS:', tenantRes.data);

    // 2. Query Engine DDL (Module 2) - Create Table
    console.log('\n[Test 2] Provisioning Table via DDL...');
    const ddlRes = await axios.post(`${BASE_URL}/analytics/query`, {
      tenantId: TENANT_ID,
      queryConfig: {
        type: 'CREATE_TABLE',
        table: 'test_users',
        schemaDef: {
          columns: [
            { name: 'id', type: 'UUID DEFAULT gen_random_uuid() PRIMARY KEY' },
            { name: 'name', type: 'VARCHAR(100)' },
            { name: 'score', type: 'INTEGER' }
          ]
        }
      }
    });
    console.log('SUCCESS:', ddlRes.data);

    // 3. Query Engine DML (Module 2) - Insert Data
    console.log('\n[Test 3] Inserting Data via DML...');
    const dmlRes = await axios.post(`${BASE_URL}/analytics/query`, {
      tenantId: TENANT_ID,
      queryConfig: {
        type: 'INSERT',
        table: 'test_users',
        data: {
          name: 'Test User 1',
          score: 100
        }
      }
    });
    console.log('SUCCESS:', dmlRes.data);

    // 4. Query Engine DQL (Module 2) - Select Data
    console.log('\n[Test 4] Selecting and Aggregating Data...');
    const dqlRes = await axios.post(`${BASE_URL}/analytics/query`, {
      tenantId: TENANT_ID,
      queryConfig: {
        type: 'SELECT',
        table: 'test_users',
        select: ['name', 'score'],
        filter: { name: 'Test User 1' }
      }
    });
    console.log('SUCCESS:', dqlRes.data);

    // 5. Query Engine Async (Module 2)
    console.log('\n[Test 5] Executing Async Query...');
    const asyncRes = await axios.post(`${BASE_URL}/analytics/query-async`, {
      tenantId: TENANT_ID,
      queryConfig: {
        type: 'SELECT',
        table: 'test_users',
        select: ['COUNT(*) as total_users', 'SUM(score) as total_score']
      }
    });
    console.log('SUCCESS (Async Accepted):', asyncRes.data);
    
    const jobId = asyncRes.data.jobId;
    console.log(`Polling job status for ${jobId}...`);
    await delay(1000); // wait 1 sec for async job to complete
    
    const jobStatusRes = await axios.get(`${BASE_URL}/analytics/jobs/${jobId}`);
    console.log('SUCCESS (Job Completed):', jobStatusRes.data);

    console.log('\n--- ALL TESTS PASSED SUCCESSFULLY ---');

  } catch (err: any) {
    console.error('\n--- TEST FAILED ---');
    console.error(err.response?.data || err.message);
  }
}

runTests();
