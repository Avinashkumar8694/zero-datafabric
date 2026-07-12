/* eslint-disable no-console */
/**
 * Saved Analytics — create parameterized analytics (AST + SQL, with {{variable}}
 * bindings), list them, and TRIGGER them via API with different inputs.
 *
 * This is the fabric's "saved query / scheduled report" primitive: define once,
 * run many times with different variable values, from the UI (Saved Analytics
 * page → Play) or programmatically (POST /api/saved-analytics/:id/run).
 *
 * Seeds a small Mongo org tree, registers it, then:
 *   1. AST analytic with a typed {{mgr}} variable — trigger with mgr=1 and mgr=2.
 *   2. SQL analytic with a {{region}} variable (hub) — trigger with a value.
 *
 * Run:  NODE_PATH=backend/node_modules node examples/analytics/run.js
 */
const { MongoClient } = require('mongodb');
const { Client } = require('pg');
const axios = require('axios');

const MONGO_URI = process.env.MONGO_URI || 'mongodb://admin:mongo_password@localhost:27017/?authSource=admin';
const HUB = { host: 'localhost', port: 5434, user: 'fabric_admin', password: 'fabric_password', database: 'datafabric' };
const BASE = process.env.BASE_URL || 'http://127.0.0.1:4000/api';
const TENANT = process.env.TENANT_ID || 'tenant_A';
const H = (t) => ({ Authorization: `Bearer ${t}`, 'x-tenant-id': TENANT, 'Content-Type': 'application/json' });

async function seedAndRegister() {
  const mc = new MongoClient(MONGO_URI); await mc.connect();
  const col = mc.db('an_lab').collection('employees');
  await col.deleteMany({});
  await col.insertMany([
    { id: 1, name: 'CEO', manager_id: null }, { id: 2, name: 'VP-A', manager_id: 1 },
    { id: 3, name: 'VP-B', manager_id: 1 }, { id: 4, name: 'Eng-1', manager_id: 2 }, { id: 5, name: 'Eng-2', manager_id: 2 },
  ]);
  await mc.close();
  const c = new Client(HUB); await c.connect();
  const config = { type: 'mongodb', syncType: 'VIRTUAL', uri: 'mongodb://admin:mongo_password@localhost:27017' };
  let { rows } = await c.query('SELECT id FROM public.data_sources WHERE tenant_id=$1 AND name=$2', [TENANT, 'An_Lab']);
  let sid;
  if (rows.length) { sid = rows[0].id; await c.query('UPDATE public.data_sources SET config=$1,status=$2,type=$3,sync_type=$4 WHERE id=$5', [config, 'CONNECTED', 'MONGODB', 'VIRTUAL', sid]); }
  else { const i = await c.query('INSERT INTO public.data_sources (tenant_id,name,type,config,sync_type,status) VALUES ($1,$2,$3,$4,$5,$6) RETURNING id', [TENANT, 'An_Lab', 'MONGODB', config, 'VIRTUAL', 'CONNECTED']); sid = i.rows[0].id; }
  await c.query('DELETE FROM public.catalog_tables WHERE schema_id IN (SELECT id FROM public.catalog_schemas WHERE source_id=$1)', [sid]);
  await c.query('DELETE FROM public.catalog_schemas WHERE source_id=$1', [sid]);
  const s = await c.query('INSERT INTO public.catalog_schemas (source_id,name,physical_name) VALUES ($1,$2,$3) RETURNING id', [sid, 'an_lab', 'an_lab']);
  await c.query('INSERT INTO public.catalog_tables (schema_id,name,physical_name,resource_type) VALUES ($1,$2,$3,$4)', [s.rows[0].id, 'employees', 'employees', 'TABLE']);
  await c.end();
}

(async () => {
  console.log('=== Saved Analytics example ===');
  await seedAndRegister();
  const t = (await axios.post(`${BASE}/auth/login`, { username: 'admin', password: 'admin' })).data.token;

  // 1) AST analytic with a typed {{mgr}} variable.
  const ast = (await axios.post(`${BASE}/saved-analytics`, {
    name: 'reports_by_manager', description: 'Direct reports of a manager', mode: 'AST',
    variables: [{ name: 'mgr', type: 'number', label: 'Manager id', required: false, default: 1 }],
    config: { type: 'SELECT', schema: 'an_lab', limit: 50, query: {
      select: ['id', 'name', 'manager_id'], from: { resource: 'employees', source: 'An_Lab' },
      where: [{ column: 'manager_id', operator: 'EQ', value: '{{mgr}}' }] } },
  }, { headers: H(t) })).data;
  console.log(`\ncreated AST analytic "${ast.name}" (id=${ast.id})`);

  for (const mgr of [1, 2]) {
    const r = (await axios.post(`${BASE}/saved-analytics/${ast.id}/run`, { variables: { mgr } }, { headers: H(t) })).data;
    console.log(`  run mgr=${mgr} → reports ${JSON.stringify((r.data || []).map((x) => x.id))} (bound ${JSON.stringify(r.boundVariables)})`);
  }
  const dflt = (await axios.post(`${BASE}/saved-analytics/${ast.id}/run`, {}, { headers: H(t) })).data;
  console.log(`  run default → reports ${JSON.stringify((dflt.data || []).map((x) => x.id))} (mgr defaulted to ${dflt.boundVariables.mgr})`);

  // 2) SQL analytic with a {{region}} variable (runs on the hub).
  const sql = (await axios.post(`${BASE}/saved-analytics`, {
    name: 'label_probe', description: 'Format a region label via SQL', mode: 'SQL',
    variables: [{ name: 'region', type: 'string', required: true }],
    sql: "SELECT {{region}} AS region, upper({{region}}) AS code",
  }, { headers: H(t) })).data;
  const sqlRun = (await axios.post(`${BASE}/saved-analytics/${sql.id}/run`, { variables: { region: 'eu' } }, { headers: H(t) })).data;
  console.log(`\ncreated SQL analytic "${sql.name}"; run region=eu → ${JSON.stringify(sqlRun.data)}`);

  // 3) List.
  const list = (await axios.get(`${BASE}/saved-analytics`, { headers: H(t) })).data;
  console.log(`\nsaved analytics: ${list.map((a) => `${a.name}[${a.mode}]`).join(', ')}`);

  const ok = dflt.boundVariables.mgr === 1 && (dflt.data || []).length === 2;
  console.log(`\n${ok ? 'PASS' : 'FAIL'} create + variable-bound trigger via API works`);
  process.exit(ok ? 0 : 1);
})().catch((e) => { console.error('ERR', e.response?.data || e.message); process.exit(1); });
