/* eslint-disable no-console */
const axios = require('axios');
const { BASE_URL, login, authHeaders, call, banner, TENANT_ID } = require('./_client');

function tenantSchema(suffix = 'Global_Supply_Chain') {
  return `"tenant_${TENANT_ID}_${suffix}"`;
}

async function main() {
  banner('Views, MViews, Sequences, Procedures, Triggers');
  const token = await login();
  const headers = authHeaders(token);

  // 1) View query examples
  await call('Query standard view', () =>
    axios.post(`${BASE_URL}/queries/exec`, {
      sql: `SELECT * FROM ${tenantSchema()}."federated_inventory_analysis" LIMIT 20`
    }, { headers }), { allowFail: true });

  await call('Query manifest-generated view (if present)', () =>
    axios.post(`${BASE_URL}/queries/exec`, {
      sql: `SELECT * FROM ${tenantSchema()}."high_value_regional_summary" LIMIT 20`
    }, { headers }), { allowFail: true });

  // 2) Materialized view query + refresh
  await call('Query materialized view', () =>
    axios.post(`${BASE_URL}/queries/exec`, {
      sql: `SELECT * FROM ${tenantSchema()}."regional_volume_stats" LIMIT 20`
    }, { headers }), { allowFail: true });

  await call('Refresh materialized view (analytics endpoint)', () =>
    axios.post(`${BASE_URL}/analytics/refresh-view`, {
      schema: 'Global_Supply_Chain',
      viewName: 'regional_volume_stats',
      concurrent: true
    }, { headers }), { allowFail: true });

  // 3) Sequence usage examples
  await call('Sequence nextval + currval same session', () =>
    axios.post(`${BASE_URL}/queries/exec`, {
      sql: `SELECT nextval('"tenant_${TENANT_ID}_Global_Supply_Chain"."tracking_seq"') AS next_tracking, currval('"tenant_${TENANT_ID}_Global_Supply_Chain"."tracking_seq"') AS current_tracking`
    }, { headers }), { allowFail: true });

  // 4) Function / procedure examples
  await call('Call scalar function generate_custom_id', () =>
    axios.post(`${BASE_URL}/queries/exec`, {
      sql: `SELECT ${tenantSchema()}."generate_custom_id"('APAC') AS custom_id`
    }, { headers }), { allowFail: true });

  await call('Call procedure process_delivery (if defined)', () =>
    axios.post(`${BASE_URL}/queries/exec`, {
      sql: `CALL ${tenantSchema()}."process_delivery"()`
    }, { headers }), { allowFail: true });

  // 5) Trigger use case flow (inspect configured triggers)
  await call('Inspect trigger definitions in schema', () =>
    axios.post(`${BASE_URL}/queries/exec`, {
      sql: `
      SELECT trigger_name, event_object_table, action_timing
      FROM information_schema.triggers
      WHERE trigger_schema = 'tenant_${TENANT_ID}_Global_Supply_Chain'
      ORDER BY trigger_name
      LIMIT 20
      `
    }, { headers }), { allowFail: true });

  await call('Read shipment_audit_logs trigger sink (if configured)', () =>
    axios.post(`${BASE_URL}/queries/exec`, {
      sql: `SELECT * FROM "tenant_${TENANT_ID}_Activity_Logs"."shipment_audit_logs" ORDER BY 1 DESC LIMIT 10`
    }, { headers }), { allowFail: true });
}

main().catch((e) => {
  console.error(e.message);
  process.exit(1);
});
