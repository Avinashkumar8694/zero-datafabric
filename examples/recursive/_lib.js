/* eslint-disable no-console */
/**
 * Shared helpers for the recursive-traversal examples.
 *
 * A recursive hierarchy over MongoDB can't use Postgres `WITH RECURSIVE`, so the
 * fabric walks it level by level (in-fabric iterative traversal). Each level is a
 * normal single-source query, so predicate pushdown + the Policy Engine apply per
 * level, and the executor binds the next level with a single `IN(...)` on the
 * parent keys — never a full scan per node.
 *
 * We seed two Mongo collections: an org tree (acyclic) and a small cyclic graph
 * to exercise the cycle guard. No test data touches the fabric's own DB.
 *
 * Run:  NODE_PATH=backend/node_modules node examples/recursive/run-all.js
 */
const { MongoClient } = require('mongodb');
const { Client } = require('pg');
const axios = require('axios');

const MONGO_URI = process.env.MONGO_URI || 'mongodb://admin:mongo_password@localhost:27017/?authSource=admin';
const HUB = { host: 'localhost', port: 5434, user: 'fabric_admin', password: 'fabric_password', database: 'datafabric' };
const BASE = process.env.BASE_URL || 'http://127.0.0.1:4000/api';
const TENANT = process.env.TENANT_ID || 'tenant_A';
const SOURCE = 'Org_Lab';
const DB = 'org_lab';

const headers = (token) => ({ Authorization: `Bearer ${token}`, 'x-tenant-id': TENANT, 'Content-Type': 'application/json' });
async function login() {
  const r = await axios.post(`${BASE}/auth/login`, { username: process.env.DF_USER || 'admin', password: process.env.DF_PASS || 'admin' });
  return r.data.token;
}

/**
 * Org tree (child.manager_id = parent.id):
 *      1 CEO
 *     /        \
 *   2 VP-A     3 VP-B
 *   /   \         \
 *  4     5         6
 *  |
 *  7,8  (under 4)
 */
const ORG = [
  { id: 1, name: 'CEO', manager_id: null },
  { id: 2, name: 'VP-A', manager_id: 1 },
  { id: 3, name: 'VP-B', manager_id: 1 },
  { id: 4, name: 'Dir-A1', manager_id: 2 },
  { id: 5, name: 'Dir-A2', manager_id: 2 },
  { id: 6, name: 'Dir-B1', manager_id: 3 },
  { id: 7, name: 'Eng-1', manager_id: 4 },
  { id: 8, name: 'Eng-2', manager_id: 4 },
];

// Cyclic graph: A → B → C → A (parent_id points to the next node's id).
const CYCLE = [
  { id: 'A', name: 'A', parent_id: null },
  { id: 'B', name: 'B', parent_id: 'A' },
  { id: 'C', name: 'C', parent_id: 'B' },
  { id: 'A2', name: 'A-again', parent_id: 'C' }, // fine
  // deliberate cycle: make C's child point back to A's subtree via a bad edge
  { id: 'LOOP', name: 'LOOP', parent_id: 'A2' },
  { id: 'A2b', name: 'cycle-edge', parent_id: 'LOOP' },
];

async function seed() {
  const mc = new MongoClient(MONGO_URI);
  await mc.connect();
  const emp = mc.db(DB).collection('employees');
  await emp.deleteMany({}); await emp.insertMany(ORG);
  const g = mc.db(DB).collection('graph');
  await g.deleteMany({}); await g.insertMany(CYCLE);
  // Introduce a real cycle: A2b's parent is LOOP, and LOOP's parent is A2 — plus
  // make A2's parent loop back to A2b to close the ring.
  await g.updateOne({ id: 'A2' }, { $set: { parent_id: 'A2b' } });
  await mc.close();
}

async function register() {
  const c = new Client(HUB);
  await c.connect();
  const config = { type: 'mongodb', syncType: 'VIRTUAL', uri: 'mongodb://admin:mongo_password@localhost:27017' };
  let { rows } = await c.query('SELECT id FROM public.data_sources WHERE tenant_id=$1 AND name=$2', [TENANT, SOURCE]);
  let sid;
  if (rows.length) { sid = rows[0].id; await c.query('UPDATE public.data_sources SET config=$1,status=$2,type=$3,sync_type=$4 WHERE id=$5', [config, 'CONNECTED', 'MONGODB', 'VIRTUAL', sid]); }
  else { const i = await c.query('INSERT INTO public.data_sources (tenant_id,name,type,config,sync_type,status) VALUES ($1,$2,$3,$4,$5,$6) RETURNING id', [TENANT, SOURCE, 'MONGODB', config, 'VIRTUAL', 'CONNECTED']); sid = i.rows[0].id; }
  await c.query('DELETE FROM public.catalog_tables WHERE schema_id IN (SELECT id FROM public.catalog_schemas WHERE source_id=$1)', [sid]);
  await c.query('DELETE FROM public.catalog_schemas WHERE source_id=$1', [sid]);
  const s = await c.query('INSERT INTO public.catalog_schemas (source_id,name,physical_name) VALUES ($1,$2,$3) RETURNING id', [sid, DB, DB]);
  for (const tbl of ['employees', 'graph']) {
    await c.query('INSERT INTO public.catalog_tables (schema_id,name,physical_name,resource_type) VALUES ($1,$2,$3,$4)', [s.rows[0].id, tbl, tbl, 'TABLE']);
  }
  await c.end();
}

/** Run a recursive query and return the enveloped result. */
async function recurse(token, spec) {
  const r = await axios.post(`${BASE}/analytics/query`, {
    queryConfig: { type: 'SELECT', schema: DB, query: { recursive: spec } },
  }, { headers: headers(token) });
  return r.data;
}

module.exports = { BASE, SOURCE, DB, login, headers, seed, register, recurse };
