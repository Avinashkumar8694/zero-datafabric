/* eslint-disable no-console */
/**
 * Federated JOIN with predicate + bind-join pushdown.
 *
 * The headline scenario: two sources each hold a table; find matching rows by a
 * key WITHOUT fetching either table wholesale. The fabric pushes the filter to
 * the driving side, then pushes the driving keys as `IN (...)` to the other
 * source (bind join). Watch the backend logs — each source is asked only for the
 * rows that can match.
 *
 * Run (stack up + seeded):  node examples/federated-join-pushdown.js
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

  banner('Cross-source JOIN with a key filter — bind-join pushdown');
  // Postgres local_inventory ⋈ Mongo remote_depot_mongo on sku=item_id, filtered
  // to a single sku. The filter is pushed to the driving side; only the matching
  // key is pushed to the other source.
  const joined = await call('federated JOIN filtered by key', () =>
    axios.post(`${BASE_URL}/analytics/query`, {
      queryConfig: {
        type: 'SELECT',
        schema: 'Global_Supply_Chain',
        limit: 100,
        query: {
          from: { resource: 'local_inventory', source: 'Fabric_Hub_Postgres', alias: 'inv' },
          joins: [{
            type: 'INNER',
            resource: 'remote_depot_mongo',
            source: 'Activity_Mongo',
            alias: 'depot',
            on: { left: 'inv.sku', operator: 'EQ', right: 'depot.item_id' },
          }],
          where: [{ column: 'inv.sku', operator: 'EQ', value: 'SKU-1' }],
        },
      },
    }, { headers }), { allowFail: true });
  if (joined) printResult('cross-source join', joined);

  banner('Post-join aggregate — join then GROUP BY on the bounded result');
  const joinAgg = await call('federated JOIN + aggregate', () =>
    axios.post(`${BASE_URL}/analytics/query`, {
      queryConfig: {
        type: 'SELECT',
        schema: 'Global_Supply_Chain',
        limit: 100,
        query: {
          from: { resource: 'local_inventory', source: 'Fabric_Hub_Postgres', alias: 'inv' },
          joins: [{
            type: 'INNER',
            resource: 'remote_depot_mongo',
            source: 'Activity_Mongo',
            alias: 'depot',
            on: { left: 'inv.sku', operator: 'EQ', right: 'depot.item_id' },
          }],
          groupBy: ['inv.sku'],
          select: ['inv.sku', { aggregate: 'SUM', column: 'depot.qty', alias: 'depot_qty' }],
        },
      },
    }, { headers }), { allowFail: true });
  if (joinAgg) printResult('post-join aggregate', joinAgg);

  console.log('\nDone. Backend logs show the pushed filter on the driving side and "bind-join: pushed N key(s) as ... IN (...)" on the other source.');
})().catch((e) => { console.error(e.message); process.exit(1); });
