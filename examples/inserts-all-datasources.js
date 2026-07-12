/* eslint-disable no-console */
const axios = require('axios');
const { BASE_URL, login, authHeaders, call, banner } = require('./_client');
const { randomUUID } = require('node:crypto');

async function main() {
  banner('Insert Examples Across Data Sources');
  const token = await login();
  const headers = authHeaders(token);

  // 1) Local Postgres (hub tenant schema) insert
  await call('Insert into local hub table (shipment_details)', () =>
    axios.post(`${BASE_URL}/analytics/query`, {
      queryConfig: {
        type: 'INSERT',
        schema: 'Global_Supply_Chain',
        table: 'shipment_details',
        data: {
          id: randomUUID(),
          shipment_id: randomUUID(),
          notes: 'inserted from inserts-all-datasources.js'
        }
      }
    }, { headers }), { allowFail: true });

  // 2) Virtual Mongo source write (depends on FDW/connector write support in runtime)
  await call('Insert to Mongo virtualized resource (capability-dependent)', () =>
    axios.post(`${BASE_URL}/queries/exec`, {
      sql: `
      INSERT INTO "tenant_tenant_A_Activity_Logs"."user_activity"
      ("user_id","action","timestamp")
      VALUES ('00000000-0000-0000-0000-000000000333','INSERT_TEST',NOW())
      RETURNING *;
      `
    }, { headers }), { allowFail: true });

  // 3) Virtual Postgres external source write (capability-dependent)
  await call('Insert to external Postgres virtualized resource (capability-dependent)', () =>
    axios.post(`${BASE_URL}/queries/exec`, {
      sql: `
      INSERT INTO "tenant_tenant_A_External_Archive"."global_tags" ("id","tag_name")
      VALUES (gen_random_uuid(),'runner_tag')
      RETURNING *;
      `
    }, { headers }), { allowFail: true });

  // 4) Elasticsearch note:
  // ES is downstream indexed during metadata apply; there is no direct /analytics INSERT into ES endpoint currently.
  await call('ES downstream status check', () =>
    axios.get(`${BASE_URL}/metadata/downstream`, { headers }), { allowFail: true });

  console.log('Note: Direct INSERT into Elasticsearch is not exposed via analytics API currently.');
  console.log('Use metadata apply for ES indexing in current implementation.');
}

main().catch((e) => {
  console.error(e.message);
  process.exit(1);
});
