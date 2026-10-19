/* eslint-disable no-console */
/**
 * Unique Customer Count Optimization & Leg Analysis
 *
 * Demonstrates a cross-source UNION query to calculate unique customer (SKU) counts
 * across Postgres and MongoDB, and displays physical execution legs.
 *
 * Run: node examples/unique-customer-count-analysis.js
 */
const axios = require('axios');
const { BASE_URL, login, authHeaders, call, banner } = require('./_client');

function printAnalysis(label, res) {
  const body = res?.data || {};
  console.log(`\n[${label}] Result Summary:`);
  console.log(`  - Row Count: ${body.rowCount ?? (body.data || body.results || []).length} rows`);
  
  const plan = body.plan || {};
  console.log(`  - Strategy: ${plan.strategy || 'N/A'}`);
  if (plan.pushed && plan.pushed.length) {
    console.log(`  - Optimization Actions Pushed:`);
    plan.pushed.forEach(p => console.log(`      * ${p}`));
  }
  
  if (plan.legs && plan.legs.length) {
    console.log(`  - Physical Execution Legs:`);
    plan.legs.forEach((leg, index) => {
      console.log(`      Leg #${index + 1}:`);
      console.log(`        * Source: ${leg.source}`);
      console.log(`        * Engine: ${leg.engine}`);
      console.log(`        * Operation Mode: ${leg.mode || leg.operation}`);
      console.log(`        * Target Schema/Table: ${leg.target}`);
      console.log(`        * Rows Returned: ${leg.rowsReturned}`);
      console.log(`        * Time: ${leg.ms}ms`);
      if (leg.query) {
        console.log(`        * Generated Query Sent to Engine:`);
        console.log(`          ${leg.query.trim().replace(/\n/g, '\n          ')}`);
      }
    });
  }

  const rows = body.data || body.results || [];
  console.log(`  - Returned Data:`, JSON.stringify(rows, null, 2));
}

async function main() {
  const token = await login();
  const headers = authHeaders(token);

  banner('1. Executing SQL Deduplicating UNION Query');
  const sqlRes = await call('SQL Union Query', () =>
    axios.post(`${BASE_URL}/queries/exec`, {
      sql: `
        SELECT sku AS customer_id FROM "tenant_tenant_A_Global_Supply_Chain"."local_inventory"
        UNION
        SELECT item_id AS customer_id FROM "tenant_tenant_A_Global_Supply_Chain"."remote_depot_mongo"
      `
    }, { headers }), { allowFail: true });

  if (sqlRes) {
    printAnalysis('SQL UNION', sqlRes);
  }

  banner('2. Executing AST Deduplicating UNION Query');
  const astRes = await call('AST Union Query', () =>
    axios.post(`${BASE_URL}/analytics/query`, {
      queryConfig: {
        type: 'SELECT',
        schema: 'Global_Supply_Chain',
        limit: 10,
        query: {
          union: [
            { select: [{ column: 'sku', alias: 'customer_id' }], from: { resource: 'local_inventory', source: 'Fabric_Hub_Postgres' } },
            { select: [{ column: 'item_id', alias: 'customer_id' }], from: { resource: 'remote_depot_mongo', source: 'Activity_Mongo' } }
          ]
        }
      }
    }, { headers }), { allowFail: true });

  if (astRes) {
    printAnalysis('AST UNION', astRes);
  }
}

main().catch((e) => {
  console.error(e.message);
  process.exit(1);
});
