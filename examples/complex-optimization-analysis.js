/* eslint-disable no-console */
/**
 * Complex Query Optimization & Execution Leg Analysis
 *
 * Demonstrates a complex query in both AST and SQL formats, fetches
 * their execution plans and physical engine legs, and analyzes the pushdown/bind-join
 * optimization strategy.
 *
 * Run: node examples/complex-optimization-analysis.js
 */
const axios = require('axios');
const { MongoClient } = require('../backend/node_modules/mongodb');
const { BASE_URL, login, authHeaders, call, banner } = require('./_client');

// Connect to MongoDB and seed the remote collection
async function seedMongoDB() {
  const uri = 'mongodb://admin:mongo_password@localhost:27017';
  const client = new MongoClient(uri);
  try {
    await client.connect();
    const db = client.db('tenant_tenant_A_Global_Supply_Chain');
    const col = db.collection('remote_depot_mongo');
    // Clear and seed SKU-100 quantity
    await col.deleteMany({});
    await col.insertOne({ item_id: 'SKU-100', qty: 12 });
    console.log('MongoDB remote_depot_mongo collection successfully seeded.');
  } catch (err) {
    console.warn('MongoDB seeding skipped/failed:', err.message);
  } finally {
    await client.close();
  }
}

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
  // Seed MongoDB so the Mongo query returns valid documents
  await seedMongoDB();

  const token = await login();
  const headers = authHeaders(token);

  banner('1. Executing Complex Federated Query in AST Format');
  // AST query joining Postgres (local_inventory) and MongoDB (remote_depot_mongo)
  // on SKU = item_id, filtering to SKU-100, and performing SUM aggregate on quantity
  const astRes = await call('AST Federated Aggregation Join', () =>
    axios.post(`${BASE_URL}/analytics/query`, {
      queryConfig: {
        type: 'SELECT',
        schema: 'Global_Supply_Chain',
        limit: 10,
        query: {
          from: { resource: 'local_inventory', source: 'Fabric_Hub_Postgres', alias: 'inv' },
          joins: [{
            type: 'INNER',
            resource: 'remote_depot_mongo',
            source: 'Activity_Mongo',
            alias: 'depot',
            on: { left: 'inv.sku', operator: 'EQ', right: 'depot.item_id' }
          }],
          where: [{ column: 'inv.sku', operator: 'EQ', value: 'SKU-100' }],
          select: [
            'inv.sku',
            'inv.stock',
            { aggregate: 'SUM', column: 'depot.qty', alias: 'total_depot_qty' }
          ],
          groupBy: ['inv.sku', 'inv.stock']
        }
      }
    }, { headers }), { allowFail: true });

  if (astRes) {
    printAnalysis('AST FORMAT', astRes);
  }

  banner('2. Executing Complex Federated Query in SQL Format');
  // Equivalent SQL querying the unified logical tenancy schema views / FDW tables
  const sqlQuery = `
    SELECT inv.sku, inv.stock, SUM(depot.qty) AS total_depot_qty
    FROM "tenant_tenant_A_Global_Supply_Chain"."local_inventory" inv
    JOIN "tenant_tenant_A_Global_Supply_Chain"."remote_depot_mongo" depot
    ON inv.sku = depot.item_id
    WHERE inv.sku = 'SKU-100'
    GROUP BY inv.sku, inv.stock
  `;

  const sqlRes = await call('SQL Federated Aggregation Join', () =>
    axios.post(`${BASE_URL}/queries/exec`, {
      sql: sqlQuery
    }, { headers }), { allowFail: true });

  if (sqlRes) {
    printAnalysis('SQL FORMAT', sqlRes);
  }

  banner('3. Optimization Strategy & Execution Leg Analysis');
  console.log(`
[Optimization Breakdown]
1. Predicate Pushdown (WHERE inv.sku = 'SKU-100')
   - The query planner pushes down the filter predicate directly to the target storage engines.
   - For PostgreSQL (Fabric_Hub_Postgres): It scans "local_inventory" with a filter on "sku".
   - For MongoDB (Activity_Mongo): The filter key is passed in the FDW connection, translating 
     to a native MongoDB query like \`db.remote_depot_mongo.find({ item_id: 'SKU-100' })\`.
   - Result: Only 1 row is returned from each source database instead of performing a full table scan.

2. Bind-Join Optimization
   - Instead of streaming the entire database content across the network to perform the join 
     in backend memory, the query engine extracts the qualifying keys from the driving Postgres leg 
     and binds them as an 'IN (...)' filter to the MongoDB leg.
   - Result: Minimal network bandwidth usage and sub-millisecond execution times.

3. Engine-Level Dialect Translation
   - Under SQL mode, the FDW mapping resolves the query logic transparently inside the Hub Postgres.
   - Under AST mode, the Zero Query Planner parses the tree structure, checks credentials and RLS policies, 
     plans execution legs, and triggers parallel data fetches.
`);
}

main().catch((e) => {
  console.error(e.message);
  process.exit(1);
});
