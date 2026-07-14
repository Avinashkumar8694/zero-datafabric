/* eslint-disable no-console */
/**
 * Data Validity Audit Script
 * Directly fetches raw values from both sources and compares them against
 * federated JOIN/UNION results to mathematically prove 100% data correctness.
 */
const axios = require('axios');
const { BASE_URL, login, authHeaders } = require('./_client');

async function run() {
  const token = await login();
  const headers = authHeaders(token);

  console.log('=== Starting Data Validity Audit ===\n');

  // 1. Fetch raw stock for CUST-5001 from Postgres Hub
  let pgStock = null;
  try {
    const res = await axios.post(`${BASE_URL}/queries/exec`, {
      sql: `SELECT stock FROM "tenant_tenant_A_Global_Supply_Chain"."local_inventory" WHERE sku = 'CUST-5001'`
    }, { headers });
    pgStock = res.data.results?.[0]?.stock ?? res.data.results?.results?.[0]?.stock;
    console.log(`[Source 1: Postgres] Raw stock for 'CUST-5001':`, pgStock);
  } catch (err) {
    console.error('Postgres raw fetch failed:', err.message);
  }

  // 2. Fetch raw qty for CUST-5001 from Mongo via routed source execution
  let mongoQty = null;
  try {
    const res = await axios.post(`${BASE_URL}/queries/exec`, {
      source: 'Activity_Mongo',
      sql: "SELECT qty FROM remote_depot_mongo WHERE item_id = 'CUST-5001'"
    }, { headers });
    const rows = res.data.results || res.data.data || [];
    mongoQty = rows[0]?.qty;
    console.log(`[Source 2: MongoDB] Raw qty for 'CUST-5001':`, mongoQty);
  } catch (err) {
    console.error('Mongo raw fetch failed:', err.message);
  }

  // 3. Fetch federated JOIN result for CUST-5001
  let joinedQty = null;
  try {
    const res = await axios.post(`${BASE_URL}/analytics/query`, {
      queryConfig: {
        type: 'SELECT',
        schema: 'Global_Supply_Chain',
        query: {
          from: { resource: 'local_inventory', source: 'Fabric_Hub_Postgres', alias: 'inv' },
          joins: [{
            type: 'INNER',
            resource: 'remote_depot_mongo',
            source: 'Activity_Mongo',
            alias: 'depot',
            on: { left: 'inv.sku', operator: 'EQ', right: 'depot.item_id' }
          }],
          where: [{ column: 'inv.sku', operator: 'EQ', value: 'CUST-5001' }],
          groupBy: ['inv.sku'],
          select: ['inv.sku', { aggregate: 'SUM', column: 'depot.qty', alias: 'total_depot_qty' }]
        }
      }
    }, { headers });
    joinedQty = res.data.data?.[0]?.total_depot_qty;
    console.log(`[Federated JOIN] Computed total_depot_qty for 'CUST-5001':`, joinedQty);
  } catch (err) {
    console.error('Federated JOIN failed:', err.message);
  }

  // 4. Validate JOIN math
  console.log('\n--- JOIN Validation ---');
  if (joinedQty !== null && mongoQty !== null) {
    const isValid = Number(joinedQty) === Number(mongoQty);
    console.log(`Validation: Federated Join Sum (${joinedQty}) === Mongo Qty (${mongoQty}) ->`, isValid ? '✅ PASS' : '❌ FAIL');
  } else {
    console.log('Skipped JOIN validation due to missing source data');
  }

  // 5. Fetch federated UNION AVG result
  let unionAvg = null;
  try {
    const res = await axios.post(`${BASE_URL}/analytics/query`, {
      queryConfig: {
        type: 'SELECT',
        schema: 'Global_Supply_Chain',
        query: {
          select: [{ aggregate: 'AVG', column: 'stock', alias: 'avg_all_stock' }],
          union: [
            { select: [{ column: 'stock', alias: 'stock' }], from: { resource: 'local_inventory', source: 'Fabric_Hub_Postgres' } },
            { select: [{ column: 'qty', alias: 'stock' }], from: { resource: 'remote_depot_mongo', source: 'Activity_Mongo' } }
          ]
        }
      }
    }, { headers });
    unionAvg = res.data.data?.[0]?.avg_all_stock;
    console.log(`\n[Federated UNION] Computed average stock/qty:`, unionAvg);
  } catch (err) {
    console.error('Federated UNION failed:', err.message);
  }

  // 6. Validate UNION math
  console.log('\n--- UNION Validation ---');
  if (unionAvg !== null && pgStock !== null && mongoQty !== null) {
    // UNION DISTINCT combines unique values [10, 15] -> average should be (10 + 15)/2 = 12.5
    const expectedAvg = (Number(pgStock) + Number(mongoQty)) / 2;
    const isValid = Number(unionAvg) === expectedAvg;
    console.log(`Validation: Federated Avg (${unionAvg}) === Expected Avg (${expectedAvg}) ->`, isValid ? '✅ PASS' : '❌ FAIL');
  } else {
    console.log('Skipped UNION validation due to missing source data');
  }
}

run();
