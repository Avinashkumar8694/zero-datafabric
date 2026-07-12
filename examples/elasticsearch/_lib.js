/**
 * Shared helpers for the Elasticsearch example scenarios.
 * @module examples/elasticsearch/_lib
 */
const http = require('http');
const BASE = 'http://localhost:4000/api';

/**
 * Low-level JSON request to the fabric API.
 * @param {string} method HTTP method
 * @param {string} path   API path under /api
 * @param {string|null} token Bearer JWT (null for login)
 * @param {object} [body] request body
 * @returns {Promise<{status:number, json:any}>}
 */
function req(method, path, token, body) {
  return new Promise((resolve) => {
    const data = body ? JSON.stringify(body) : null;
    const r = http.request(BASE + path, { method, headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: 'Bearer ' + token, 'x-tenant-id': 'tenant_A' } : {}),
      ...(data ? { 'Content-Length': Buffer.byteLength(data) } : {}),
    }}, (res) => { let b = ''; res.on('data', c => b += c); res.on('end', () => {
      try { resolve({ status: res.statusCode, json: JSON.parse(b) }); } catch { resolve({ status: res.statusCode, json: b }); } }); });
    r.on('error', e => resolve({ status: 0, json: { error: e.message } }));
    if (data) r.write(data); r.end();
  });
}

/** Log in as admin and return a JWT. @returns {Promise<string>} */
async function login() {
  const r = await req('POST', '/auth/login', null, { username: 'admin', password: 'admin' });
  if (!r.json?.token) { console.error('LOGIN FAILED'); process.exit(1); }
  return r.json.token;
}

/**
 * Run an AST query against the fabric (`/api/analytics/query`).
 * @param {string} token JWT
 * @param {object} query the AST `query` object
 * @param {number} [limit=50] top-level row cap
 * @returns {Promise<{rows:any[], plan:object, raw:any}>}
 */
async function ast(token, query, limit = 50) {
  const r = await req('POST', '/analytics/query', token, { queryConfig: { type: 'SELECT', schema: 'default', limit, query } });
  if (r.status !== 200) throw new Error(r.json?.error || `HTTP ${r.status}`);
  return { rows: r.json.data || [], plan: r.json.plan || {}, raw: r.json };
}

/**
 * Run native SQL at a source (`/api/queries/exec`) — for ES this hits the `_sql` endpoint.
 * @param {string} token JWT
 * @param {string} source datasource name
 * @param {string} sql native SQL
 * @returns {Promise<{rows:any[], plan:object}>}
 */
async function sqlOn(token, source, sql) {
  const r = await req('POST', '/queries/exec', token, { source, schema: 'default', sql });
  if (r.status !== 200) throw new Error(r.json?.error || `HTTP ${r.status}`);
  return { rows: r.json.data || r.json.results || [], plan: r.json.plan || {} };
}

/** CRUD helper (`/api/data/{op}`). @returns {Promise<{status:number,json:any}>} */
const data = (token, op, body) => req('POST', `/data/${op}`, token, body);

/** Pretty scenario header + the pushed-down leg query from the trace. */
function banner(title, plan) {
  const leg = (plan?.legs || [])[0] || {};
  console.log(`\n━━ ${title}`);
  if (leg.query) console.log(`   pushed: ${String(leg.query).slice(0, 150)}`);
  if (plan?.executionMs != null) console.log(`   ${leg.engine || ''}/${leg.mode || ''} · ${plan.executionMs}ms`);
}
const show = (rows, n = 3) => rows.slice(0, n).forEach(r => console.log('   ', JSON.stringify(r)));

module.exports = { req, login, ast, sqlOn, data, banner, show };
