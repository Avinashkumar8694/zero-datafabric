/* eslint-disable no-console */
/**
 * Shared helpers for the Policy Engine examples.
 *
 * The Policy Engine enforces row-level security + column masking on NON-RLS
 * engines (here: MongoDB) the way Postgres does natively — by resolving an
 * engine-agnostic policy and INJECTING its predicate into the pushdown (so the
 * filter runs at the source) plus masking columns in the returned rows.
 *
 * These helpers seed a Mongo collection with policy-relevant data, register it
 * as a VIRTUAL fabric source (control-plane metadata only — no test data is
 * written to the fabric DB), and expose thin query/policy helpers.
 *
 * Run with the backend's node_modules on the path (for pg + mongodb):
 *   NODE_PATH=backend/node_modules node examples/policy/run-all.js
 */
const { MongoClient } = require('mongodb');
const { Client } = require('pg');
const axios = require('axios');

const MONGO_URI = process.env.MONGO_URI || 'mongodb://admin:mongo_password@localhost:27017/?authSource=admin';
const HUB = { host: 'localhost', port: 5434, user: 'fabric_admin', password: 'fabric_password', database: 'datafabric' };
const BASE = process.env.BASE_URL || 'http://127.0.0.1:4000/api';
const TENANT = process.env.TENANT_ID || 'tenant_A';

const SOURCE = 'Policy_Lab';
const DB = 'policy_lab';
const COLLECTION = 'secure_orders';

const headers = (token, extra = {}) => ({ Authorization: `Bearer ${token}`, 'x-tenant-id': TENANT, 'Content-Type': 'application/json', ...extra });

async function login() {
  const r = await axios.post(`${BASE}/auth/login`, { username: process.env.DF_USER || 'admin', password: process.env.DF_PASS || 'admin' });
  return r.data.token;
}

/** Seed a Mongo collection: orders across two tenants, three regions, some soft-deleted, with PII. */
async function seed() {
  const mc = new MongoClient(MONGO_URI);
  await mc.connect();
  const col = mc.db(DB).collection(COLLECTION);
  await col.deleteMany({});
  const rows = [];
  let id = 1;
  for (const tenant_code of ['tenant_A', 'tenant_B']) {
    for (const region of ['EU', 'NA', 'AP']) {
      for (let i = 0; i < 3; i++) {
        rows.push({
          id: id, tenant_code, region, status: 'OPEN',
          deleted_at: i === 2 ? '2025-01-01' : null,           // one soft-deleted per group
          email: `user${id}@example.com`, ssn: `${900000000 + id}`, amount: 100 + id,
        });
        id++;
      }
    }
  }
  await col.insertMany(rows);
  await mc.close();
  return rows.length; // 18
}

/** Register the Mongo collection as a VIRTUAL source + catalog object for tenant_A. */
async function register() {
  const c = new Client(HUB);
  await c.connect();
  const config = { type: 'mongodb', syncType: 'VIRTUAL', uri: 'mongodb://admin:mongo_password@localhost:27017' };
  let { rows } = await c.query('SELECT id FROM public.data_sources WHERE tenant_id=$1 AND name=$2', [TENANT, SOURCE]);
  let sourceId;
  if (rows.length) {
    sourceId = rows[0].id;
    await c.query('UPDATE public.data_sources SET type=$1, sync_type=$2, config=$3, status=$4 WHERE id=$5', ['MONGODB', 'VIRTUAL', config, 'CONNECTED', sourceId]);
  } else {
    const ins = await c.query('INSERT INTO public.data_sources (tenant_id,name,type,config,sync_type,status) VALUES ($1,$2,$3,$4,$5,$6) RETURNING id', [TENANT, SOURCE, 'MONGODB', config, 'VIRTUAL', 'CONNECTED']);
    sourceId = ins.rows[0].id;
  }
  await c.query('DELETE FROM public.catalog_tables WHERE schema_id IN (SELECT id FROM public.catalog_schemas WHERE source_id=$1)', [sourceId]);
  await c.query('DELETE FROM public.catalog_schemas WHERE source_id=$1', [sourceId]);
  const sch = await c.query('INSERT INTO public.catalog_schemas (source_id,name,physical_name) VALUES ($1,$2,$3) RETURNING id', [sourceId, DB, DB]);
  await c.query('INSERT INTO public.catalog_tables (schema_id,name,physical_name,resource_type) VALUES ($1,$2,$3,$4)', [sch.rows[0].id, COLLECTION, COLLECTION, 'TABLE']);
  await c.end();
}

/** Remove any policies previously registered on the lab collection (clean slate). */
async function clearPolicies(token) {
  const list = (await axios.get(`${BASE}/policies`, { headers: headers(token) })).data || [];
  for (const p of list.filter((x) => x.table === COLLECTION)) {
    await axios.delete(`${BASE}/policies/${p.id}`, { headers: headers(token) });
  }
}

async function addPolicy(token, policy) {
  const r = await axios.post(`${BASE}/policies`, { schema: DB, table: COLLECTION, ...policy }, { headers: headers(token) });
  return r.data;
}

/** Federated SELECT of the whole collection (region optional via x-region header). */
async function queryAll(token, region) {
  const r = await axios.post(`${BASE}/analytics/query`, {
    queryConfig: { type: 'SELECT', schema: DB, limit: 200, query: { select: ['*'], from: { resource: COLLECTION, source: SOURCE } } },
  }, { headers: headers(token, region ? { 'x-region': region } : {}) });
  return r.data;
}

module.exports = { BASE, TENANT, SOURCE, DB, COLLECTION, login, headers, seed, register, clearPolicies, addPolicy, queryAll };
