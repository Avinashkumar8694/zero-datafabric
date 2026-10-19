/* eslint-disable no-console */
const axios = require('axios');
const { BASE_URL, login, authHeaders, call, banner } = require('./_client');

const SCHEMA = 'Global_Supply_Chain';

/** AST SELECT * from a resource (table / view / materialized view) in the logical schema. */
function selectAll(headers, resource, limit = 20, schema = SCHEMA) {
  return axios.post(`${BASE_URL}/analytics/query`, {
    queryConfig: { type: 'SELECT', schema, limit, query: { select: ['*'], from: { resource } } }
  }, { headers });
}

async function main() {
  banner('Views, MViews, Sequences, Procedures, Triggers');
  const token = await login();
  const headers = authHeaders(token);

  // 1) View query examples (views are just resources to the AST engine)
  await call('Query standard view', () =>
    selectAll(headers, 'federated_inventory_analysis'), { allowFail: true });

  await call('Query manifest-generated view (if present)', () =>
    selectAll(headers, 'high_value_regional_summary'), { allowFail: true });

  // 2) Materialized view query + refresh
  await call('Query materialized view', () =>
    selectAll(headers, 'regional_volume_stats'), { allowFail: true });

  await call('Refresh materialized view (analytics endpoint)', () =>
    axios.post(`${BASE_URL}/analytics/refresh-view`, {
      schema: SCHEMA,
      viewName: 'regional_volume_stats',
      concurrent: true
    }, { headers }), { allowFail: true });

  // 3) Sequence usage examples (fabric nextval for any engine)
  await call('Sequence nextval (POST /data/sequence)', () =>
    axios.post(`${BASE_URL}/data/sequence`, { name: 'tracking_seq', count: 2 }, { headers }), { allowFail: true });

  // 4) Function / procedure examples
  await call('Call scalar function generate_custom_id', () =>
    axios.post(`${BASE_URL}/data/call`, {
      schema: SCHEMA, function: 'generate_custom_id', args: ['APAC']
    }, { headers }), { allowFail: true });

  await call('Call procedure process_delivery (if defined)', () =>
    axios.post(`${BASE_URL}/data/call`, {
      schema: SCHEMA, procedure: 'process_delivery', args: []
    }, { headers }), { allowFail: true });

  // 5) Trigger use case flow (inspect configured triggers)
  await call('Inspect trigger definitions (trigger registry)', async () => {
    const res = await axios.get(`${BASE_URL}/triggers`, { headers });
    console.log(`triggers: ${(res.data || []).length}`);
    return res;
  }, { allowFail: true });

  await call('Read shipment_audit_logs trigger sink (if configured)', () =>
    axios.post(`${BASE_URL}/analytics/query`, {
      queryConfig: {
        type: 'SELECT',
        schema: 'Activity_Logs',
        limit: 10,
        query: { select: ['*'], from: { resource: 'shipment_audit_logs' } }
      }
    }, { headers }), { allowFail: true });
}

main().catch((e) => {
  console.error(e.message);
  process.exit(1);
});
