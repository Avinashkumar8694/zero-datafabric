/* eslint-disable no-console */
const axios = require('axios');
const { BASE_URL, login, authHeaders, call, banner, TENANT_ID } = require('./_client');

async function main() {
  banner('Aggregation and Complex Query Examples');
  const token = await login();
  const headers = authHeaders(token);

  // 1) Aggregate count/sum/group by (SQL)
  await call('SQL aggregation by status', () =>
    axios.post(`${BASE_URL}/queries/exec`, {
      sql: `
      SELECT status, COUNT(*) AS total_rows, COALESCE(SUM(total_amount),0) AS total_amount
      FROM "tenant_${TENANT_ID}_Global_Supply_Chain"."shipments"
      GROUP BY status
      ORDER BY total_rows DESC
      LIMIT 20
      `
    }, { headers }), { allowFail: true });

  // 2) Window function example
  await call('SQL window function rank by region', () =>
    axios.post(`${BASE_URL}/queries/exec`, {
      sql: `
      SELECT
        id,
        region,
        total_amount,
        RANK() OVER (PARTITION BY region ORDER BY total_amount DESC) AS regional_rank
      FROM "tenant_${TENANT_ID}_Global_Supply_Chain"."shipments"
      LIMIT 50
      `
    }, { headers }), { allowFail: true });

  // 3) CTE + multi-join complex query
  await call('SQL CTE + multi-join complex query', () =>
    axios.post(`${BASE_URL}/queries/exec`, {
      sql: `
      WITH latest_shipments AS (
        SELECT id, region, status, created_at
        FROM "tenant_${TENANT_ID}_Global_Supply_Chain"."shipments"
        ORDER BY created_at DESC
        LIMIT 200
      )
      SELECT
        ls.id,
        ls.region,
        ls.status,
        sd.notes
      FROM latest_shipments ls
      LEFT JOIN "tenant_${TENANT_ID}_Global_Supply_Chain"."shipment_details" sd
        ON sd.shipment_id = ls.id
      ORDER BY ls.created_at DESC
      LIMIT 50
      `
    }, { headers }), { allowFail: true });

  // 4) AST aggregate example
  await call('AST aggregate count(*)', () =>
    axios.post(`${BASE_URL}/analytics/query`, {
      queryConfig: {
        type: 'SELECT',
        schema: 'Global_Supply_Chain',
        table: 'shipments',
        select: ['count(*)']
      }
    }, { headers }), { allowFail: true });

  // 5) Async heavy query
  const asyncRes = await call('Async complex query dispatch', () =>
    axios.post(`${BASE_URL}/queries/exec`, {
      async: true,
      sql: `
      SELECT s.region, COUNT(*) AS c, MAX(s.created_at) AS latest
      FROM "tenant_${TENANT_ID}_Global_Supply_Chain"."shipments" s
      GROUP BY s.region
      ORDER BY c DESC
      `
    }, { headers }), { allowFail: true });

  const qid = asyncRes?.data?.queryId;
  if (qid) {
    await call('Async complex query poll', () =>
      axios.get(`${BASE_URL}/queries/jobs/${qid}`, { headers }), { allowFail: true });
  }
}

main().catch((e) => {
  console.error(e.message);
  process.exit(1);
});
