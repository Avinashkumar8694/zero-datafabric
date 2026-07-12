/* eslint-disable no-console */
/**
 * Shared helpers for the governance examples (constraints, grants, functions).
 *
 * Demonstrates the fabric's compensation model on a NON-SQL engine (MongoDB):
 * constraints and grants — which Postgres enforces natively — are enforced
 * in-fabric on Mongo writes/reads, and functions are invoked via the fabric's
 * function-as-a-service. Data lives only in the external Mongo (no test data in
 * the fabric DB); the fabric holds control-plane metadata.
 *
 * Run:  NODE_PATH=backend/node_modules node examples/governance/run-all.js
 */
const { MongoClient } = require('mongodb');
const { Client } = require('pg');
const axios = require('axios');

const MONGO_URI = process.env.MONGO_URI || 'mongodb://admin:mongo_password@localhost:27017/?authSource=admin';
const HUB = { host: 'localhost', port: 5434, user: 'fabric_admin', password: 'fabric_password', database: 'datafabric' };
const BASE = process.env.BASE_URL || 'http://127.0.0.1:4000/api';
const TENANT = process.env.TENANT_ID || 'tenant_A';
const SOURCE = 'Gov_Lab';
const DB = 'gov_lab';

const H = (token, extra = {}) => ({ Authorization: `Bearer ${token}`, 'x-tenant-id': TENANT, 'Content-Type': 'application/json', ...extra });
async function login() {
  const r = await axios.post(`${BASE}/auth/login`, { username: process.env.DF_USER || 'admin', password: process.env.DF_PASS || 'admin' });
  return r.data.token;
}

/** Seed the inventory + warehouses collections (warehouses backs FK checks). */
async function seed() {
  const mc = new MongoClient(MONGO_URI); await mc.connect();
  const inv = mc.db(DB).collection('inventory');
  await inv.deleteMany({});
  await inv.insertOne({ sku: 'SKU-1', qty: 5, status: 'ACTIVE', warehouse_id: 'WH1' }); // seed one for UNIQUE demo
  const wh = mc.db(DB).collection('warehouses');
  await wh.deleteMany({}); await wh.insertMany([{ id: 'WH1', name: 'East' }, { id: 'WH2', name: 'West' }]);
  await mc.close();
}

async function register() {
  const c = new Client(HUB); await c.connect();
  const config = { type: 'mongodb', syncType: 'VIRTUAL', uri: 'mongodb://admin:mongo_password@localhost:27017' };
  let { rows } = await c.query('SELECT id FROM public.data_sources WHERE tenant_id=$1 AND name=$2', [TENANT, SOURCE]);
  let sid;
  if (rows.length) { sid = rows[0].id; await c.query('UPDATE public.data_sources SET config=$1,status=$2,type=$3,sync_type=$4 WHERE id=$5', [config, 'CONNECTED', 'MONGODB', 'VIRTUAL', sid]); }
  else { const i = await c.query('INSERT INTO public.data_sources (tenant_id,name,type,config,sync_type,status) VALUES ($1,$2,$3,$4,$5,$6) RETURNING id', [TENANT, SOURCE, 'MONGODB', config, 'VIRTUAL', 'CONNECTED']); sid = i.rows[0].id; }
  await c.query('DELETE FROM public.catalog_tables WHERE schema_id IN (SELECT id FROM public.catalog_schemas WHERE source_id=$1)', [sid]);
  await c.query('DELETE FROM public.catalog_schemas WHERE source_id=$1', [sid]);
  const s = await c.query('INSERT INTO public.catalog_schemas (source_id,name,physical_name) VALUES ($1,$2,$3) RETURNING id', [sid, DB, DB]);
  for (const t of ['inventory', 'warehouses']) await c.query('INSERT INTO public.catalog_tables (schema_id,name,physical_name,resource_type) VALUES ($1,$2,$3,$4)', [s.rows[0].id, t, t, 'TABLE']);
  await c.end();
}

/** Attempt a create; returns {ok, status, error}. */
async function create(token, data, headers = {}) {
  try { const r = await axios.post(`${BASE}/data/create`, { source: SOURCE, schema: DB, resource: 'inventory', data }, { headers: H(token, headers) }); return { ok: true, r: r.data }; }
  catch (e) { return { ok: false, status: e.response?.status, error: e.response?.data?.error || e.message }; }
}
async function fetch(token, headers = {}) {
  try { const r = await axios.post(`${BASE}/data/fetch`, { source: SOURCE, schema: DB, resource: 'inventory', limit: 5 }, { headers: H(token, headers) }); return { ok: true, r: r.data }; }
  catch (e) { return { ok: false, status: e.response?.status, error: e.response?.data?.error || e.message }; }
}

module.exports = { BASE, SOURCE, DB, TENANT, login, H, seed, register, create, fetch };
