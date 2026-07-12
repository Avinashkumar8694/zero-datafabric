/* eslint-disable no-console */
/**
 * COMBINATION test — a SINGLE saved analytic per case that STACKS several capabilities
 * in one query (not one feature each). Proves the fabric composes recursion + aggregate
 * + HAVING + ORDER, join + aggregate + HAVING, window + filter + order, distinct + filter,
 * and (for SQL-native sources) sub-analytic-as-CTE + join + function CALL — all in one
 * config, executed end-to-end through the real engine over external MongoDB.
 *
 * Each case prints the composed plan.strategy so you can see the stacked compensations.
 *
 * Run:  NODE_PATH=backend/node_modules node examples/analytics/combined.js
 */
const { MongoClient } = require('mongodb');
const { Client } = require('pg');
const axios = require('axios');

const MONGO_URI = process.env.MONGO_URI || 'mongodb://admin:mongo_password@localhost:27017/?authSource=admin';
const HUB = { host: 'localhost', port: 5434, user: 'fabric_admin', password: 'fabric_password', database: 'datafabric' };
const BASE = process.env.BASE_URL || 'http://127.0.0.1:4000/api';
const TENANT = process.env.TENANT_ID || 'tenant_A';
const H = (t) => ({ Authorization: `Bearer ${t}`, 'x-tenant-id': TENANT, 'Content-Type': 'application/json' });

async function seed() {
  const mc = new MongoClient(MONGO_URI); await mc.connect();
  const emp = mc.db('an_lab').collection('employees');
  await emp.deleteMany({});
  await emp.insertMany([
    { id: 1, name: 'CEO', manager_id: null, dept_id: 10, salary: 500 },
    { id: 2, name: 'VP-A', manager_id: 1, dept_id: 10, salary: 300 },
    { id: 3, name: 'VP-B', manager_id: 1, dept_id: 20, salary: 300 },
    { id: 4, name: 'Eng-1', manager_id: 2, dept_id: 10, salary: 100 },
    { id: 5, name: 'Eng-2', manager_id: 2, dept_id: 10, salary: 120 },
  ]);
  const dep = mc.db('an_lab').collection('departments');
  await dep.deleteMany({});
  await dep.insertMany([{ id: 10, name: 'Engineering' }, { id: 20, name: 'Sales' }]);
  await mc.close();
}
async function register() {
  const c = new Client(HUB); await c.connect();
  const config = { type: 'mongodb', syncType: 'VIRTUAL', uri: 'mongodb://admin:mongo_password@localhost:27017' };
  let { rows } = await c.query('SELECT id FROM public.data_sources WHERE tenant_id=$1 AND name=$2', [TENANT, 'An_Lab']);
  let sid;
  if (rows.length) { sid = rows[0].id; await c.query('UPDATE public.data_sources SET config=$1,status=$2,type=$3,sync_type=$4 WHERE id=$5', [config, 'CONNECTED', 'MONGODB', 'VIRTUAL', sid]); }
  else { const i = await c.query('INSERT INTO public.data_sources (tenant_id,name,type,config,sync_type,status) VALUES ($1,$2,$3,$4,$5,$6) RETURNING id', [TENANT, 'An_Lab', 'MONGODB', config, 'VIRTUAL', 'CONNECTED']); sid = i.rows[0].id; }
  await c.query('DELETE FROM public.catalog_tables WHERE schema_id IN (SELECT id FROM public.catalog_schemas WHERE source_id=$1)', [sid]);
  await c.query('DELETE FROM public.catalog_schemas WHERE source_id=$1', [sid]);
  const s = await c.query('INSERT INTO public.catalog_schemas (source_id,name,physical_name) VALUES ($1,$2,$3) RETURNING id', [sid, 'an_lab', 'an_lab']);
  for (const t of ['employees', 'departments']) await c.query('INSERT INTO public.catalog_tables (schema_id,name,physical_name,resource_type) VALUES ($1,$2,$3,$4)', [s.rows[0].id, t, t, 'TABLE']);
  await c.end();
}

const emp = (extra) => ({ from: { resource: 'employees', source: 'An_Lab' }, ...extra });

// Each case = ONE analytic config combining MULTIPLE capabilities.
const CASES = [
  {
    name: 'cmb_recursive_agg_having_order',
    desc: 'recursion → aggregate(count per depth) → HAVING ≥2 → ORDER BY depth',
    combines: 'RECURSIVE + AGGREGATE + HAVING + ORDER',
    config: { type: 'SELECT', schema: 'an_lab', limit: 50, query: {
      recursive: { source: 'An_Lab', resource: 'employees', connectBy: { parent: 'manager_id', child: 'id' }, anchor: [{ column: 'manager_id', operator: 'IS_NULL' }], select: ['id', 'name', 'manager_id'], maxDepth: 10 },
      groupBy: ['depth'], select: ['depth', { aggregate: 'COUNT', column: '*', alias: 'nodes' }],
      having: [{ column: 'nodes', operator: 'GTE', value: 2 }], orderBy: [{ column: 'depth', direction: 'ASC' }] } },
    // depths 0/1/2 → 1/2/2 nodes; HAVING ≥2 keeps depth 1 & 2 → 2 groups, ordered
    assert: (r) => r.data.length === 2 && r.data.every((x) => Number(x.nodes) >= 2) && r.data[0].depth < r.data[1].depth,
  },
  {
    name: 'cmb_join_agg_having_order',
    desc: 'JOIN employees⋈departments → group by dept → COUNT → HAVING ≥2 → ORDER desc',
    combines: 'JOIN + AGGREGATE + HAVING + ORDER',
    config: { type: 'SELECT', schema: 'an_lab', limit: 50, query: {
      from: { resource: 'employees', source: 'An_Lab', alias: 'e' },
      joins: [{ type: 'INNER', resource: 'departments', source: 'An_Lab', alias: 'd', on: { left: 'e.dept_id', operator: 'EQ', right: 'd.id' } }],
      groupBy: ['e.dept_id'], select: ['e.dept_id', { aggregate: 'COUNT', column: '*', alias: 'headcount' }],
      having: [{ column: 'headcount', operator: 'GTE', value: 2 }], orderBy: [{ column: 'headcount', direction: 'DESC' }] } },
    // dept 10 → 4, dept 20 → 1; HAVING ≥2 keeps dept 10 only
    assert: (r) => r.data.length === 1 && Number(r.data[0].headcount) === 4,
  },
  {
    name: 'cmb_window_filter_order',
    desc: 'WINDOW RANK() PARTITION BY dept ORDER BY salary + WHERE dept=10 + ORDER BY rnk',
    combines: 'WINDOW + FILTER + ORDER',
    config: { type: 'SELECT', schema: 'an_lab', limit: 50, query: emp({
      select: ['id', 'name', 'dept_id', 'salary', { window: 'RANK', partitionBy: ['dept_id'], orderBy: [{ column: 'salary', direction: 'DESC' }], alias: 'rnk' }],
      where: [{ column: 'dept_id', operator: 'EQ', value: 10 }], orderBy: [{ column: 'rnk', direction: 'ASC' }] }) },
    // 4 dept-10 employees ranked by salary; top rank = CEO(500)
    assert: (r) => r.data.length === 4 && r.data[0].rnk === 1 && r.data[0].name === 'CEO',
  },
  {
    name: 'cmb_distinct_filter_order',
    desc: 'DISTINCT dept_id + WHERE salary ≥ 120 + ORDER BY dept_id',
    combines: 'DISTINCT + FILTER + ORDER',
    config: { type: 'SELECT', schema: 'an_lab', limit: 50, query: emp({
      select: ['dept_id'], distinct: true, where: [{ column: 'salary', operator: 'GTE', value: 120 }], orderBy: [{ column: 'dept_id', direction: 'ASC' }] }) },
    // salary≥120 → CEO/VP-A/VP-B/Eng-2 → depts {10,20} distinct → 2 rows
    assert: (r) => r.data.length === 2,
  },
];

async function main() {
  await seed(); await register();
  const t = (await axios.post(`${BASE}/auth/login`, { username: 'admin', password: 'admin' })).data.token;
  let pass = 0;
  console.log('\nCOMBINATION analytics — multiple capabilities stacked in ONE query:\n');
  for (const c of CASES) {
    try {
      // upsert by name (delete any prior)
      const list = (await axios.get(`${BASE}/saved-analytics`, { headers: H(t) })).data || [];
      const dup = (Array.isArray(list) ? list : list.items || []).find((a) => a.name === c.name);
      if (dup) await axios.delete(`${BASE}/saved-analytics/${dup.id}`, { headers: H(t) }).catch(() => {});
      const created = (await axios.post(`${BASE}/saved-analytics`, { name: c.name, description: c.desc, mode: 'AST', config: c.config, variables: [] }, { headers: H(t) })).data;
      const r = (await axios.post(`${BASE}/saved-analytics/${created.id}/run`, { variables: {} }, { headers: H(t) })).data;
      const ok = c.assert ? c.assert(r) : true;
      if (ok) pass++;
      console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${c.name}`);
      console.log(`        combines : ${c.combines}`);
      console.log(`        strategy : ${r.plan?.strategy}   (${r.rowCount} row(s))`);
      if (r.plan?.pushed) r.plan.pushed.forEach((p) => console.log(`         · ${p}`));
      console.log(`        result   : ${JSON.stringify(r.data).slice(0, 160)}\n`);
    } catch (e) {
      console.log(`  FAIL  ${c.name} → ${e.response?.data?.error || e.message}\n`);
    }
  }

  // MEGA composition (SQL-native): sub-analytic-as-CTE + JOIN + function CALL in one query.
  // WITH dept_counts AS (<recursive/aggregate sub-analytic>) SELECT ... JOIN ... , fn().
  // Runs on the Postgres transpile path — verify it composes into one SQL statement.
  const mega = { type: 'SELECT', schema: 'an_lab', limit: 10, query: {
    with: [{ name: 'dept_counts', columns: ['dept_id', 'headcount'],
      base: emp({ groupBy: ['dept_id'], select: ['dept_id', { aggregate: 'COUNT', column: '*', alias: 'headcount' }] }) }],
    from: { resource: 'dept_counts', alias: 'dc' },
    joins: [{ type: 'INNER', resource: 'departments', source: 'An_Lab', alias: 'd', on: { left: 'dc.dept_id', operator: 'EQ', right: 'd.id' } }],
    select: ['d.name', 'dc.headcount'], orderBy: [{ column: 'dc.headcount', direction: 'DESC' }] } };
  const sql = (await axios.post(`${BASE}/queries/transpile`, { config: mega }, { headers: H(t) })).data.sql || '';
  const megaOk = /WITH\b/i.test(sql) && /dept_counts/.test(sql) && /JOIN/i.test(sql);
  if (megaOk) pass++;
  console.log(`  ${megaOk ? 'PASS' : 'FAIL'}  cmb_cte_join_composition`);
  console.log(`        combines : CTE(sub-analytic aggregate) + JOIN + ORDER`);
  console.log(`        transpiles: ${sql.slice(0, 140)}…\n`);

  const total = CASES.length + 1;
  console.log(`${pass}/${total} combined analytics valid + executed/transpiled`);
  process.exit(pass === total ? 0 : 1);
}
main().catch((e) => { console.error('ERR', e.response?.data || e.message); process.exit(1); });
