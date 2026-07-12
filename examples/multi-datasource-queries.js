/* eslint-disable no-console */
const axios = require('axios');
const { BASE_URL, login, authHeaders, call, banner } = require('./_client');

async function main() {
  banner('Multi-DataSource Query Examples');
  const token = await login();
  const headers = authHeaders(token);

  await call('SQL federated UNION (local + mongo-style resource)', () =>
    axios.post(`${BASE_URL}/queries/exec`, {
      sql: `
      SELECT sku, stock AS qty, 'local_inventory' AS src
      FROM "tenant_tenant_A_Global_Supply_Chain"."local_inventory"
      UNION ALL
      SELECT item_id AS sku, qty, 'remote_depot_mongo' AS src
      FROM "tenant_tenant_A_Global_Supply_Chain"."remote_depot_mongo"
      LIMIT 100
      `
    }, { headers }), { allowFail: true });

  await call('AST set operation UNION', () =>
    axios.post(`${BASE_URL}/analytics/query`, {
      queryConfig: {
        type: 'SELECT',
        schema: 'Global_Supply_Chain',
        limit: 100,
        query: {
          union: [
            { select: ['sku', 'stock'], from: { resource: 'local_inventory', source: 'Fabric_Hub_Postgres' } },
            { select: ['item_id', 'qty'], from: { resource: 'remote_depot_mongo', source: 'Activity_Mongo' } }
          ]
        }
      }
    }, { headers }), { allowFail: true });

  await call('AST set operation INTERSECT', () =>
    axios.post(`${BASE_URL}/analytics/query`, {
      queryConfig: {
        type: 'SELECT',
        schema: 'Global_Supply_Chain',
        limit: 100,
        query: {
          intersect: [
            { select: ['sku'], from: { resource: 'active_products', source: 'External_Warehouse' } },
            { select: ['product_id'], from: { resource: 'mongo_product_catalog', source: 'Activity_Mongo' } }
          ]
        }
      }
    }, { headers }), { allowFail: true });

  await call('AST set operation EXCEPT', () =>
    axios.post(`${BASE_URL}/analytics/query`, {
      queryConfig: {
        type: 'SELECT',
        schema: 'Global_Supply_Chain',
        limit: 100,
        query: {
          except: [
            { select: ['sku'], from: { resource: 'quarantined_items', source: 'External_Warehouse' } }
          ]
        }
      }
    }, { headers }), { allowFail: true });
}

main().catch((e) => {
  console.error(e.message);
  process.exit(1);
});
