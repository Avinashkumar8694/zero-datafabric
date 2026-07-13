/* eslint-disable no-console */
const axios = require('axios');
const { BASE_URL, TENANT_ID, login, authHeaders, call, banner } = require('./_client');

async function main() {
  banner('Register 3 Data Sources');
  const token = await login();
  const headers = authHeaders(token);

  const payloads = [
    {
      name: 'Fabric_Hub_Postgres',
      config: {
        type: 'postgres',
        host: 'localhost',
        port: 5436,
        dbName: 'remote_warehouse',
        user: 'remote_admin',
        pass: 'remote_password',
        syncType: 'VIRTUAL'
      }
    },
    {
      name: 'Activity_Mongo',
      config: {
        type: 'mongodb',
        host: 'localhost',
        port: 27017,
        dbName: 'admin',
        user: 'admin',
        pass: 'mongo_password',
        syncType: 'VIRTUAL'
      }
    },
    {
      name: 'Elastic_Search',
      config: {
        type: 'elasticsearch',
        host: 'localhost',
        port: 9200,
        connectionString: 'http://localhost:9200',
        syncType: 'VIRTUAL'
      }
    }
  ];

  for (const payload of payloads) {
    await call(`Register ${payload.name}`, () =>
      axios.post(`${BASE_URL}/admin/connections`, payload, { headers }), { allowFail: true });
  }

  const list = await call('List connections', () =>
    axios.get(`${BASE_URL}/admin/connections`, { headers }));

  if (list?.data) {
    console.log(`Tenant: ${TENANT_ID}`);
    console.log(`Connections returned: ${Array.isArray(list.data) ? list.data.length : 0}`);
  }
}

main().catch((e) => {
  console.error(e.message);
  process.exit(1);
});
