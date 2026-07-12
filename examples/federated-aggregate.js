/* eslint-disable no-console */
/**
 * Multi-source aggregate pushdown.
 *
 * Demonstrates the "partial-aggregate split": the fabric pushes a partial
 * aggregate (GROUP BY + COUNT/SUM/AVG) to EACH source so every source returns
 * only #groups rows, then merges the partials in the fabric. No source is ever
 * fully fetched.
 *
 * Run (stack up + seeded):  node examples/federated-aggregate.js
 * Env: BASE_URL, TENANT_ID, DF_USER, DF_PASS
 */
const axios = require('axios');
const { BASE_URL, login, authHeaders, call, banner } = require('./_client');

function printResult(label, res) {
  const body = res?.data || {};
  console.log(`  ${label}: ${body.rowCount ?? (body.data || []).length} rows`);
  if (body.plan) console.log(`  plan: ${body.plan.strategy} :: ${(body.plan.pushed || []).join(' | ')}`);
  if (body.warnings && body.warnings.length) console.log(`  warnings: ${body.warnings.join(' | ')}`);
  console.log('  data:', JSON.stringify(body.data || body, null, 2));
}

(async () => {
  const token = await login();
  const headers = authHeaders(token);

  banner('Multi-source aggregate — global COUNT + SUM across two sources');
  // Each UNION leg is itself an aggregate query against a different source.
  // The fabric pushes COUNT/SUM to each source and SUMs the partials.
  const globalAgg = await call('federated COUNT+SUM (fan aggregate)', () =>
    axios.post(`${BASE_URL}/analytics/query`, {
      queryConfig: {
        type: 'SELECT',
        schema: 'Global_Supply_Chain',
        limit: 100,
        query: {
          union: [
            {
              from: { resource: 'local_inventory', source: 'Fabric_Hub_Postgres' },
              select: [{ aggregate: 'COUNT', column: '*', alias: 'n' }, { aggregate: 'SUM', column: 'stock', alias: 'total' }],
            },
            {
              from: { resource: 'remote_depot_mongo', source: 'Activity_Mongo' },
              select: [{ aggregate: 'COUNT', column: '*', alias: 'n' }, { aggregate: 'SUM', column: 'qty', alias: 'total' }],
            },
          ],
        },
      },
    }, { headers }), { allowFail: true });
  if (globalAgg) printResult('global aggregate', globalAgg);

  banner('Multi-source aggregate — GROUP BY with AVG (partial SUM+COUNT merge)');
  const groupedAgg = await call('federated GROUP BY + AVG', () =>
    axios.post(`${BASE_URL}/analytics/query`, {
      queryConfig: {
        type: 'SELECT',
        schema: 'Global_Supply_Chain',
        limit: 100,
        query: {
          union: [
            {
              from: { resource: 'local_inventory', source: 'Fabric_Hub_Postgres' },
              groupBy: ['sku'],
              select: ['sku', { aggregate: 'SUM', column: 'stock', alias: 'total' }, { aggregate: 'AVG', column: 'stock', alias: 'avg_qty' }],
            },
            {
              from: { resource: 'remote_depot_mongo', source: 'Activity_Mongo' },
              groupBy: ['item_id'],
              select: ['item_id', { aggregate: 'SUM', column: 'qty', alias: 'total' }, { aggregate: 'AVG', column: 'qty', alias: 'avg_qty' }],
            },
          ],
        },
      },
    }, { headers }), { allowFail: true });
  if (groupedAgg) printResult('grouped aggregate', groupedAgg);

  banner('Single-source aggregate pushed to one connector (Mongo $group)');
  const singleAgg = await call('single-source GROUP BY (connector pushdown)', () =>
    axios.post(`${BASE_URL}/analytics/query`, {
      queryConfig: {
        type: 'SELECT',
        schema: 'Global_Supply_Chain',
        limit: 100,
        query: {
          from: { resource: 'remote_depot_mongo', source: 'Activity_Mongo' },
          groupBy: ['item_id'],
          select: ['item_id', { aggregate: 'COUNT', column: '*', alias: 'n' }],
        },
      },
    }, { headers }), { allowFail: true });
  if (singleAgg) printResult('single-source aggregate', singleAgg);

  console.log('\nDone. Inspect the backend logs for [Federation] "partial aggregate ... pushed to <source>" lines.');
})().catch((e) => { console.error(e.message); process.exit(1); });
