/* eslint-disable no-console */
const axios = require('axios');
const { BASE_URL, login, authHeaders, call, banner } = require('./_client');

async function main() {
  banner('Aggregation and Complex Query Examples');
  const token = await login();
  const headers = authHeaders(token);

  // 1) Aggregate count/sum/group by (AST)
  await call('AST aggregation by status', () =>
    axios.post(`${BASE_URL}/analytics/query`, {
      queryConfig: {
        type: 'SELECT',
        schema: 'Global_Supply_Chain',
        limit: 20,
        query: {
          from: { resource: 'shipments' },
          groupBy: ['status'],
          select: [
            'status',
            { aggregate: 'COUNT', column: '*', alias: 'total_rows' },
            { aggregate: 'SUM', column: 'total_amount', alias: 'total_amount' }
          ],
          orderBy: [{ column: 'total_rows', direction: 'DESC' }]
        }
      }
    }, { headers }), { allowFail: true });

  // 2) Join (AST) - latest shipments with their details
  await call('AST LEFT JOIN shipments -> shipment_details', () =>
    axios.post(`${BASE_URL}/analytics/query`, {
      queryConfig: {
        type: 'SELECT',
        schema: 'Global_Supply_Chain',
        limit: 50,
        query: {
          select: ['ls.id', 'ls.region', 'ls.status', 'sd.notes'],
          from: { resource: 'shipments', alias: 'ls' },
          joins: [{
            type: 'LEFT',
            resource: 'shipment_details',
            alias: 'sd',
            on: { left: 'ls.id', operator: 'EQ', right: 'sd.shipment_id' }
          }],
          orderBy: [{ column: 'ls.created_at', direction: 'DESC' }]
        }
      }
    }, { headers }), { allowFail: true });

  // 3) AST -> SQL preview (read-only; nothing is executed)
  await call('AST transpile preview', () =>
    axios.post(`${BASE_URL}/queries/transpile`, {
      type: 'SELECT',
      schema: 'Global_Supply_Chain',
      limit: 20,
      query: {
        from: { resource: 'shipments' },
        select: ['status', { aggregate: 'COUNT', column: '*', alias: 'c' }],
        groupBy: ['status']
      }
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

  // 5) Async heavy query (AST)
  const asyncRes = await call('Async complex query dispatch', () =>
    axios.post(`${BASE_URL}/analytics/query-async`, {
      queryConfig: {
        type: 'SELECT',
        schema: 'Global_Supply_Chain',
        query: {
          from: { resource: 'shipments' },
          groupBy: ['region'],
          select: [
            'region',
            { aggregate: 'COUNT', column: '*', alias: 'c' },
            { aggregate: 'MAX', column: 'created_at', alias: 'latest' }
          ],
          orderBy: [{ column: 'c', direction: 'DESC' }]
        }
      }
    }, { headers }), { allowFail: true });

  const qid = asyncRes?.data?.jobId;
  if (qid) {
    await call('Async complex query poll', () =>
      axios.get(`${BASE_URL}/analytics/jobs/${qid}`, { headers }), { allowFail: true });
  }
}

main().catch((e) => {
  console.error(e.message);
  process.exit(1);
});
