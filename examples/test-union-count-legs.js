/* eslint-disable no-console */
/**
 * Test and Analyze Union of Count Legs
 */
const axios = require('axios');
const { BASE_URL, login, authHeaders } = require('./_client');

async function run() {
  const token = await login();
  const headers = authHeaders(token);

  console.log('\n=== Running Query 1: UNION of COUNT (*) ===');
  try {
    const res1 = await axios.post(`${BASE_URL}/analytics/query`, {
      queryConfig: {
        type: 'SELECT',
        schema: 'Global_Supply_Chain',
        query: {
          union: [
            { select: [{ func: 'COUNT', column: null, alias: 'cnt' }], from: { resource: 'local_inventory', source: 'Fabric_Hub_Postgres' } },
            { select: [{ func: 'COUNT', column: null, alias: 'cnt' }], from: { resource: 'remote_depot_mongo', source: 'Activity_Mongo' } }
          ]
        }
      }
    }, { headers });

    console.log('Response Status:', res1.status);
    console.log('Data Returned:', JSON.stringify(res1.data.data));
  } catch (err) {
    console.error('Query 1 failed:', err.response ? err.response.data : err.message);
  }

  console.log('\n=== Running Query 2: SELECT COUNT (*) over UNION (Unique Deduplicated Count) ===');
  try {
    const res2 = await axios.post(`${BASE_URL}/analytics/query`, {
      queryConfig: {
        type: 'SELECT',
        schema: 'Global_Supply_Chain',
        query: {
          select: [{ aggregate: 'COUNT', column: null, alias: 'total_count' }],
          union: [
            { select: [{ column: 'sku', alias: 'customer_id' }], from: { resource: 'local_inventory', source: 'Fabric_Hub_Postgres' } },
            { select: [{ column: 'item_id', alias: 'customer_id' }], from: { resource: 'remote_depot_mongo', source: 'Activity_Mongo' } }
          ]
        }
      }
    }, { headers });

    console.log('Response Status:', res2.status);
    console.log('Data Returned:', JSON.stringify(res2.data.data));
    console.log('Pushed Notes:', res2.data.plan.pushed);
    console.log('Execution Ms:', res2.data.plan.executionMs);
    console.log('Rows Scanned Across Sources:', res2.data.plan.rowsScannedAcrossSources);
  } catch (err) {
    console.error('Query 2 failed:', err.response ? err.response.data : err.message);
  }

  console.log('\n=== Running Query 3: SELECT SUM(cnt) over UNION of COUNT (Total Combined Count) ===');
  try {
    const res3 = await axios.post(`${BASE_URL}/analytics/query`, {
      queryConfig: {
        type: 'SELECT',
        schema: 'Global_Supply_Chain',
        query: {
          select: [{ aggregate: 'SUM', column: 'cnt', alias: 'total_sum' }],
          union: [
            { select: [{ func: 'COUNT', column: null, alias: 'cnt' }], from: { resource: 'local_inventory', source: 'Fabric_Hub_Postgres' } },
            { select: [{ func: 'COUNT', column: null, alias: 'cnt' }], from: { resource: 'remote_depot_mongo', source: 'Activity_Mongo' } }
          ]
        }
      }
    }, { headers });

    console.log('Response Status:', res3.status);
    console.log('Data Returned:', JSON.stringify(res3.data.data));
    console.log('Pushed Notes:', res3.data.plan.pushed);
    console.log('Execution Ms:', res3.data.plan.executionMs);
    console.log('Rows Scanned Across Sources:', res3.data.plan.rowsScannedAcrossSources);
  } catch (err) {
    console.error('Query 3 failed:', err.response ? err.response.data : err.message);
  }
}

run();
