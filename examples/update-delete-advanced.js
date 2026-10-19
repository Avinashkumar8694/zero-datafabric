/* eslint-disable no-console */
const axios = require('axios');
const { BASE_URL, login, authHeaders, call, banner } = require('./_client');

async function main() {
  banner('Update/Delete Advanced Use Cases');
  const token = await login();
  const headers = authHeaders(token);

  // Seed one detail row for update/delete demonstrations
  await call('Seed row for update/delete', () =>
    axios.post(`${BASE_URL}/analytics/query`, {
      queryConfig: {
        type: 'INSERT',
        schema: 'Global_Supply_Chain',
        table: 'shipment_details',
        data: {
          id: '00000000-0000-0000-0000-000000000888',
          shipment_id: '00000000-0000-0000-0000-000000000889',
          notes: 'before-update'
        }
      }
    }, { headers }), { allowFail: true });

  // 1) UPDATE via current engine format
  await call('UPDATE with filter (engine format)', () =>
    axios.post(`${BASE_URL}/analytics/query`, {
      queryConfig: {
        type: 'UPDATE',
        schema: 'Global_Supply_Chain',
        table: 'shipment_details',
        data: { notes: 'updated-by-engine-format' },
        filter: { id: { $eq: '00000000-0000-0000-0000-000000000888' } }
      }
    }, { headers }), { allowFail: true });

  // 2) DELETE via current engine format
  await call('DELETE with filter (engine format)', () =>
    axios.post(`${BASE_URL}/analytics/query`, {
      queryConfig: {
        type: 'DELETE',
        schema: 'Global_Supply_Chain',
        table: 'shipment_details',
        filter: { id: { $eq: '00000000-0000-0000-0000-000000000888' } }
      }
    }, { headers }), { allowFail: true });

  // 3) Soft-delete style update example
  await call('Soft delete pattern (set deleted_at)', () =>
    axios.post(`${BASE_URL}/analytics/query`, {
      queryConfig: {
        type: 'UPDATE',
        schema: 'Global_Supply_Chain',
        table: 'shipments',
        data: { deleted_at: new Date().toISOString() },
        filter: { id: { $eq: '00000000-0000-0000-0000-000000000777' } }
      }
    }, { headers }), { allowFail: true });

  // 4) Verify post-mutation state
  await call('Verify mutation results', () =>
    axios.post(`${BASE_URL}/analytics/query`, {
      queryConfig: {
        type: 'SELECT',
        schema: 'Global_Supply_Chain',
        limit: 10,
        query: {
          select: ['id', 'shipment_id', 'notes'],
          from: { resource: 'shipment_details' },
          orderBy: [{ column: 'id', direction: 'DESC' }]
        }
      }
    }, { headers }), { allowFail: true });
}

main().catch((e) => {
  console.error(e.message);
  process.exit(1);
});
