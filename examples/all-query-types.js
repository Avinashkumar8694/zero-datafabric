/* eslint-disable no-console */
const axios = require('axios');
const { BASE_URL, login, authHeaders, call, banner } = require('./_client');

async function main() {
  banner('All Query Types Examples');
  const token = await login();
  const headers = authHeaders(token);

  // AST -> SQL preview (nothing is executed; raw SQL execution is not supported)
  await call('AST transpile preview', () =>
    axios.post(`${BASE_URL}/queries/transpile`, {
      type: 'SELECT',
      schema: 'Global_Supply_Chain',
      limit: 20,
      query: { select: ['id', 'status'], from: { resource: 'shipments' } }
    }, { headers }), { allowFail: true });

  // Manifest-style AST SELECT
  await call('AST SELECT manifest-style', () =>
    axios.post(`${BASE_URL}/analytics/query`, {
      queryConfig: {
        type: 'SELECT',
        schema: 'Global_Supply_Chain',
        limit: 20,
        query: {
          select: ['id', 'name'],
          from: { resource: 'employees', source: 'Fabric_Hub_Postgres' }
        }
      }
    }, { headers }), { allowFail: true });

  await call('AST SELECT with WHERE + ORDER', () =>
    axios.post(`${BASE_URL}/analytics/query`, {
      queryConfig: {
        type: 'SELECT',
        schema: 'Global_Supply_Chain',
        limit: 20,
        query: {
          select: ['id', 'status', 'created_at'],
          from: { resource: 'shipments' },
          where: [{ column: 'status', operator: 'EQ', value: 'PENDING' }],
          orderBy: [{ column: 'created_at', direction: 'DESC' }]
        }
      }
    }, { headers }), { allowFail: true });

  await call('AST JOIN', () =>
    axios.post(`${BASE_URL}/analytics/query`, {
      queryConfig: {
        type: 'SELECT',
        schema: 'Global_Supply_Chain',
        limit: 20,
        query: {
          select: ['shipments.id', 'shipment_details.notes'],
          from: { resource: 'shipments' },
          joins: [
            {
              type: 'INNER',
              resource: 'shipment_details',
              on: { left: 'shipments.id', operator: 'EQ', right: 'shipment_details.shipment_id' }
            }
          ]
        }
      }
    }, { headers }), { allowFail: true });

  await call('AST UNION', () =>
    axios.post(`${BASE_URL}/analytics/query`, {
      queryConfig: {
        type: 'SELECT',
        schema: 'Global_Supply_Chain',
        limit: 50,
        query: {
          union: [
            { select: ['sku', 'stock'], from: { resource: 'local_inventory' } },
            { select: ['item_id', 'qty'], from: { resource: 'remote_depot_mongo' } }
          ]
        }
      }
    }, { headers }), { allowFail: true });

  // Recursive (engine-native config)
  await call('AST recursive CTE config', () =>
    axios.post(`${BASE_URL}/analytics/query`, {
      queryConfig: {
        type: 'SELECT',
        schema: 'Global_Supply_Chain',
        query: {
          from: { resource: 'employees' },
          select: ['id', 'manager_id', 'name'],
          recursive: {
            resource: 'employees',
            select: ['id', 'manager_id', 'name'],
            connectBy: { parent: 'manager_id', child: 'id' },
            direction: 'down',
            maxDepth: 10
          }
        }
      }
    }, { headers }), { allowFail: true });

  // Async AST
  const jobRes = await call('AST async dispatch', () =>
    axios.post(`${BASE_URL}/analytics/query-async`, {
      queryConfig: {
        type: 'SELECT',
        schema: 'Global_Supply_Chain',
        limit: 10,
        query: { select: ['*'], from: { resource: 'employees' } }
      }
    }, { headers }), { allowFail: true });

  const jobId = jobRes?.data?.jobId;
  if (jobId) {
    await call('AST async poll', () =>
      axios.get(`${BASE_URL}/analytics/jobs/${jobId}`, { headers }), { allowFail: true });
  }
}

main().catch((e) => {
  console.error(e.message);
  process.exit(1);
});
