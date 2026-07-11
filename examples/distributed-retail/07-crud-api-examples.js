/**
 * CRUD API examples — the simple REST-style endpoints under /api/data.
 *
 *   POST /api/data/fetch   { source?, schema?, resource, columns?, where?, orderBy?, limit?, offset? }
 *   POST /api/data/create  { source?, schema?, resource, data }            // data: object | object[]
 *   POST /api/data/update  { source?, schema?, resource, where, data }     // where required
 *   POST /api/data/delete  { source?, schema?, resource, where }           // where required
 *
 * `where` accepts { col: value } or { col: { $op: value } } with
 * $eq $ne $gt $gte $lt $lte $like $ilike $in. Writes run at the owning source
 * (remote Postgres SQL or Mongo ops); every response carries the plan/trace.
 * All example writes use id >= 900000 and clean up after themselves.
 *
 * Run (backend up on :4000):  node 07-crud-api-examples.js
 */
const http = require('http');
const BASE = 'http://localhost:4000/api';
function req(method, path, token, body) {
  return new Promise((resolve) => {
    const data = body ? JSON.stringify(body) : null;
    const r = http.request(BASE + path, { method, headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: 'Bearer ' + token, 'x-tenant-id': 'tenant_A' } : {}),
      ...(data ? { 'Content-Length': Buffer.byteLength(data) } : {}),
    }}, (res) => { let b = ''; res.on('data', c => b += c); res.on('end', () => {
      try { resolve({ status: res.statusCode, json: JSON.parse(b) }); } catch { resolve({ status: res.statusCode, json: b }); }
    }); });
    r.on('error', e => resolve({ status: 0, json: { error: e.message } }));
    if (data) r.write(data); r.end();
  });
}
let TOKEN;
const call = (op, body) => req('POST', `/data/${op}`, TOKEN, body);
function show(label, r) {
  if (r.status !== 200) { console.log(`  ${label}: HTTP ${r.status} ${JSON.stringify(r.json)}`); return r; }
  const leg = (r.json.plan?.legs || [])[0];
  const n = r.json.rowCount ?? (r.json.data ? r.json.data.length : '—');
  console.log(`  ${label}: rows=${n}${leg ? `  [${leg.source}/${leg.engine} ${leg.operation} ${leg.ms}ms] ${String(leg.query).slice(0, 90)}` : ''}`);
  return r;
}

(async () => {
  const login = await req('POST', '/auth/login', null, { username: 'admin', password: 'admin' });
  TOKEN = login.json?.token;
  if (!TOKEN) { console.log('LOGIN FAILED'); process.exit(1); }
  console.log('CRUD API examples — /api/data over external sources');

  // ---- FETCH (read) with different operators ----
  console.log('\n── fetch (read) ──');
  show('fetch region=EU (limit 3)', await call('fetch', { source: 'Retail_Core', resource: 'customers', columns: ['id', 'name', 'region'], where: { region: 'EU' }, limit: 3 }));
  show('fetch lifetime_value > 45000', await call('fetch', { source: 'Retail_Core', resource: 'customers', where: { lifetime_value: { $gt: 45000 } }, orderBy: [{ column: 'lifetime_value', direction: 'DESC' }], limit: 3 }));
  show('fetch status IN (SHIPPED,DELIVERED)', await call('fetch', { source: 'Retail_Core', resource: 'orders', where: { status: { $in: ['SHIPPED', 'DELIVERED'] } }, limit: 3 }));
  show('fetch Mongo web_events device=mobile', await call('fetch', { source: 'Web_Analytics', resource: 'web_events', where: { device: 'mobile' }, limit: 2 }));

  // ---- CREATE / UPDATE / DELETE on remote Postgres (Retail_Core) ----
  console.log('\n── create / update / delete on remote Postgres (Retail_Core.customers) ──');
  show('create single (id 900001)', await call('create', { source: 'Retail_Core', resource: 'customers',
    data: { id: 900001, name: 'CRUD_Demo_A', region: 'NA', segment: 'SMB', signup_date: '2026-01-01', lifetime_value: 100 } }));
  show('create batch (900002-900003)', await call('create', { source: 'Retail_Core', resource: 'customers',
    data: [
      { id: 900002, name: 'CRUD_Demo_B', region: 'EU', segment: 'GOV', signup_date: '2026-01-02', lifetime_value: 200 },
      { id: 900003, name: 'CRUD_Demo_C', region: 'APAC', segment: 'ENTERPRISE', signup_date: '2026-01-03', lifetime_value: 300 },
    ] }));
  show('fetch created (id >= 900000)', await call('fetch', { source: 'Retail_Core', resource: 'customers', where: { id: { $gte: 900000 } }, orderBy: [{ column: 'id', direction: 'ASC' }] }));
  show('update (id 900001 → lifetime_value 9999)', await call('update', { source: 'Retail_Core', resource: 'customers', where: { id: 900001 }, data: { lifetime_value: 9999, segment: 'ENTERPRISE' } }));
  show('delete (id >= 900000)', await call('delete', { source: 'Retail_Core', resource: 'customers', where: { id: { $gte: 900000 } } }));
  show('fetch after delete (should be 0)', await call('fetch', { source: 'Retail_Core', resource: 'customers', where: { id: { $gte: 900000 } } }));

  // ---- CREATE / UPDATE / DELETE on MongoDB (Web_Analytics) ----
  console.log('\n── create / update / delete on MongoDB (Web_Analytics.web_events) ──');
  show('create doc (event_id 900001)', await call('create', { source: 'Web_Analytics', resource: 'web_events',
    data: { event_id: 900001, customer_id: 1, event_type: 'checkout', device: 'desktop', revenue: 42 } }));
  show('fetch doc', await call('fetch', { source: 'Web_Analytics', resource: 'web_events', where: { event_id: 900001 } }));
  show('update doc (revenue 999)', await call('update', { source: 'Web_Analytics', resource: 'web_events', where: { event_id: 900001 }, data: { revenue: 999 } }));
  show('delete doc', await call('delete', { source: 'Web_Analytics', resource: 'web_events', where: { event_id: 900001 } }));

  // ---- Safety guard ----
  console.log('\n── safety ──');
  const guard = await call('update', { source: 'Retail_Core', resource: 'customers', data: { region: 'X' } });
  console.log(`  update without where → HTTP ${guard.status}: ${guard.json.error}`);

  console.log('\nDone — CRUD API examples complete (all demo rows cleaned up).');
})();
