/* eslint-disable no-console */
/**
 * MongoDB Native Co-located Join Performance Analysis
 *
 * Seeds two collections in MongoDB, executes a co-located aggregate join
 * in AST mode, and validates the `$lookup` query pushdown optimization.
 *
 * Run: node examples/mongo-colocated-join.js
 */
const { MongoClient } = require('../backend/node_modules/mongodb');
const axios = require('axios');
const { BASE_URL, login, authHeaders, call, banner } = require('./_client');

const TENANT_SCHEMA = 'tenant_tenant_A_Global_Supply_Chain';

async function seedMongo() {
  const uri = 'mongodb://admin:mongo_password@localhost:27017';
  const client = new MongoClient(uri);
  try {
    await client.connect();
    const db = client.db(TENANT_SCHEMA);

    // 1. Seed Product Catalog Collection
    const catalog = db.collection('mongo_product_catalog');
    await catalog.deleteMany({});
    await catalog.insertOne({ product_id: 'SKU-100', name: 'Premium Coffee Bean' });
    console.log('MongoDB mongo_product_catalog seeded.');

    // 2. Seed Remote Depot Collection
    const depot = db.collection('remote_depot_mongo');
    await depot.deleteMany({});
    await depot.insertOne({ item_id: 'SKU-100', qty: 45 });
    console.log('MongoDB remote_depot_mongo seeded.');
  } finally {
    await client.close();
  }
}

async function runJoinQuery() {
  const token = await login();
  const headers = authHeaders(token);

  banner('Executing Co-located MongoDB Join via AST');

  const res = await call('MongoDB Pushdown Lookup Join', () =>
    axios.post(`${BASE_URL}/analytics/query`, {
      queryConfig: {
        type: 'SELECT',
        schema: 'Global_Supply_Chain',
        limit: 10,
        query: {
          from: { resource: 'mongo_product_catalog', source: 'Activity_Mongo', alias: 'catalog' },
          joins: [{
            type: 'INNER',
            resource: 'remote_depot_mongo',
            source: 'Activity_Mongo',
            alias: 'depot',
            on: { left: 'catalog.product_id', operator: 'EQ', right: 'depot.item_id' }
          }],
          select: [
            'catalog.product_id',
            'catalog.name',
            { column: 'depot.qty', alias: 'quantity' }
          ]
        }
      }
    }, { headers })
  );

  if (res && res.data) {
    const body = res.data;
    console.log('\n=== Query Results ===');
    console.log(`- Row Count: ${body.rowCount} rows`);
    console.log(`- Data:`, JSON.stringify(body.data, null, 2));

    const plan = body.plan || {};
    console.log(`\n=== Optimization Analysis ===`);
    console.log(`- Strategy Picked: ${plan.strategy} (Expected: SINGLE_CONNECTOR)`);
    if (plan.legs && plan.legs.length) {
      console.log(`- Execution Legs:`);
      plan.legs.forEach(leg => {
        console.log(`    * Engine: ${leg.engine}`);
        console.log(`    * Operation: ${leg.operation} (Expected: colocated-mongo-pushdown)`);
        console.log(`    * Pushed MongoDB Pipeline:`);
        console.log(`      ${leg.query}`);
      });
    }
  }
}

async function main() {
  await seedMongo();
  await runJoinQuery();
}

main().catch((e) => {
  console.error(e.message);
  process.exit(1);
});
