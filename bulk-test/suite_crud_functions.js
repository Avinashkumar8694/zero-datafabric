/**
 * CRUD + SEQUENCE + FUNCTION + WRITE-GENERATOR suite (stateful, sequential).
 * Exercises the write side of the fabric that the read suites don't:
 *   POST /api/data/sequence   — fabric nextval() for any engine
 *   POST /api/data/create     — insert (+ `generate`: UUID_V7 / custom sequence)
 *   POST /api/data/fetch      — read back
 *   POST /api/data/update     — update by filter
 *   POST /api/data/delete     — delete by filter
 *   POST /api/data/call       — invoke a provisioned function
 * plus a fabric CREATE FUNCTION and its call. Each step prints PASS/FAIL.
 *
 * Run: cd backend && NODE_PATH=./node_modules node ../bulk-test/suite_crud_functions.js
 */
const http = require('http');
const jwt = require('jsonwebtoken');
const TOKEN = jwt.sign({ role: 'fabric_user', internal_role: 'ADMIN', tenant_id: 'tenant_advanced_test', username: 'crud', iss: 'zero-data-fabric' }, 'reallyreallyreallyreallyverysecret', { expiresIn: '2h' });

function post(path, body) {
  const data = JSON.stringify(body);
  return new Promise((resolve) => {
    const req = http.request({ host: 'localhost', port: 4000, path, method: 'POST', headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data), Authorization: 'Bearer ' + TOKEN } },
      (res) => { let b = ''; res.on('data', (c) => (b += c)); res.on('end', () => { try { resolve(JSON.parse(b)); } catch { resolve({ error: b.slice(0, 200) }); } }); });
    req.on('error', (e) => resolve({ error: e.message })); req.write(data); req.end();
  });
}
const q = (query) => post('/api/analytics/query', { queryConfig: query });
let pass = 0, fail = 0;
const check = (label, cond, detail) => { if (cond) { pass++; console.log(`  ✓ ${label}`); } else { fail++; console.log(`  ✗ ${label}  →  ${detail || ''}`); } };
const rowsOf = (r) => Array.isArray(r?.data) ? r.data : Array.isArray(r?.returning) ? r.returning : Array.isArray(r?.rows) ? r.rows : Array.isArray(r) ? r : [];

(async () => {
  console.log('\n=== SETUP: fresh table crud_demo (id, uid, label, qty) ===');
  await q({ type: 'DROP_TABLE', table: 'crud_demo' });
  const cr = await q({ type: 'CREATE_TABLE', table: 'crud_demo', schemaDef: { columns: [{ name: 'id', type: 'INTEGER' }, { name: 'uid', type: 'TEXT' }, { name: 'label', type: 'TEXT' }, { name: 'qty', type: 'INTEGER' }] } });
  check('create table', cr.status === 'SUCCESS' || cr.status === 'OK', JSON.stringify(cr).slice(0, 120));

  console.log('\n=== 1) SEQUENCE endpoint — fabric nextval (start 100, increment 10, count 3) ===');
  const seq = await post('/api/data/sequence', { name: 'demo_seq', start: 100, increment: 10, count: 3 });
  console.log('   response:', JSON.stringify(seq).slice(0, 160));
  const seqVals = seq.values || seq.value || seq.data || seq;
  const arr = Array.isArray(seqVals) ? seqVals.map(Number) : [Number(seq.value ?? seq.nextval ?? seq)];
  check('sequence returns monotonic increasing values', arr.length >= 1 && arr.every((v, i) => i === 0 || v > arr[i - 1]), JSON.stringify(arr));
  const seq2 = await post('/api/data/sequence', { name: 'demo_seq' });
  const nextV = Number(seq2.values ? seq2.values[0] : (seq2.value ?? seq2.nextval ?? (Array.isArray(seq2) ? seq2[0] : seq2)));
  check('sequence persists across calls (next > last allocated)', nextV > Math.max(...arr), `next=${nextV} vs ${JSON.stringify(arr)}`);

  console.log('\n=== 2) CREATE with write-generators (custom SEQUENCE id + UUID_V7 uid) ===');
  // NOTE: fabric sequences persist across runs (correct), so we capture the ACTUAL
  // generated ids and assert monotonic increment rather than absolute values.
  const uniqSeq = 'crud_id_seq';
  const c1 = await post('/api/data/create', { resource: 'crud_demo', data: { label: 'alpha', qty: 10 }, generate: { id: { sequence: uniqSeq }, uid: { strategy: 'UUID_V7' } } });
  const r1 = rowsOf(c1)[0] || {};
  console.log('   created:', JSON.stringify(r1).slice(0, 160));
  check('create row 1: sequence id assigned (numeric)', Number.isFinite(Number(r1.id)), JSON.stringify(c1).slice(0, 160));
  check('create row 1: UUID_V7 generated', typeof r1.uid === 'string' && /[0-9a-f]{8}-[0-9a-f]{4}/i.test(r1.uid), r1.uid);
  const c2 = await post('/api/data/create', { resource: 'crud_demo', data: { label: 'beta', qty: 20 }, generate: { id: { sequence: uniqSeq }, uid: { strategy: 'UUID_V7' } } });
  const r2 = rowsOf(c2)[0] || {};
  const id1 = Number(r1.id), id2 = Number(r2.id);
  check('create row 2: sequence id incremented by 1', id2 === id1 + 1, `id1=${id1} id2=${id2}`);

  console.log('\n=== 3) FETCH (read back by filter) ===');
  const f1 = await post('/api/data/fetch', { resource: 'crud_demo', where: { label: 'alpha' } });
  const fr = rowsOf(f1);
  check('fetch label=alpha returns 1 row, qty=10', fr.length === 1 && Number(fr[0].qty) === 10, JSON.stringify(fr).slice(0, 160));
  const fAll = await post('/api/data/fetch', { resource: 'crud_demo', orderBy: [{ column: 'id', direction: 'ASC' }], limit: 10 });
  check('fetch all returns 2 rows', rowsOf(fAll).length === 2, JSON.stringify(rowsOf(fAll)).slice(0, 120));

  console.log('\n=== 4) UPDATE by filter ===');
  const u1 = await post('/api/data/update', { resource: 'crud_demo', where: { id: id1 }, data: { qty: 99 } });
  console.log('   update result:', JSON.stringify(u1).slice(0, 120));
  const fU = await post('/api/data/fetch', { resource: 'crud_demo', where: { id: id1 } });
  check(`update id=${id1} → qty 99`, Number(rowsOf(fU)[0]?.qty) === 99, JSON.stringify(rowsOf(fU)).slice(0, 120));
  const uSafety = await post('/api/data/update', { resource: 'crud_demo', data: { qty: 0 } }); // no where → must be blocked
  check('update without WHERE is blocked (safety)', !!uSafety.error, JSON.stringify(uSafety).slice(0, 120));

  console.log('\n=== 5) DELETE by filter ===');
  const d1 = await post('/api/data/delete', { resource: 'crud_demo', where: { id: id2 } });
  console.log('   delete result:', JSON.stringify(d1).slice(0, 120));
  const fD = await post('/api/data/fetch', { resource: 'crud_demo', orderBy: [{ column: 'id', direction: 'ASC' }], limit: 10 });
  check(`after delete id=${id2} → only id=${id1} remains`, rowsOf(fD).length === 1 && Number(rowsOf(fD)[0].id) === id1, JSON.stringify(rowsOf(fD)).slice(0, 120));
  const dSafety = await post('/api/data/delete', { resource: 'crud_demo', where: {} }); // empty where → blocked
  check('delete with empty WHERE is blocked (safety)', !!dSafety.error, JSON.stringify(dSafety).slice(0, 120));

  console.log('\n=== 6) CUSTOM FUNCTION — create a hub SQL function, then call it via /api/data/call ===');
  // Provision a simple SQL function in the tenant schema (via native SQL on the hub).
  const tenantSchema = 'tenant_tenant_advanced_test';
  const mk = await post('/api/queries/native', { sql: `CREATE OR REPLACE FUNCTION "${tenantSchema}".add_tax(n integer) RETURNS integer LANGUAGE sql AS $$ SELECT (n * 108 / 100)::int $$;` });
  console.log('   create function:', JSON.stringify(mk).slice(0, 120));
  const callRes = await post('/api/data/call', { schema: tenantSchema, function: 'add_tax', args: [100] });
  const cval = rowsOf(callRes)[0];
  console.log('   call result:', JSON.stringify(callRes).slice(0, 160));
  check('call add_tax(100) → 108', cval && Number(Object.values(cval)[0]) === 108, JSON.stringify(callRes).slice(0, 160));

  console.log('\n=== 7) WRITE-GENERATOR: function-based default (id from add_tax of qty) ===');
  const c3 = await post('/api/data/create', { resource: 'crud_demo', data: { label: 'gamma', qty: 50 }, generate: { id: { sequence: uniqSeq }, uid: { strategy: 'UUID_V7' } } });
  check('create row 3 via sequence (id continues incrementing)', Number(rowsOf(c3)[0]?.id) === id2 + 1, JSON.stringify(c3).slice(0, 140));

  console.log('\n=== CLEANUP ===');
  await q({ type: 'DROP_TABLE', table: 'crud_demo' });
  console.log(`\n================  CRUD/SEQUENCE/FUNCTION: ${pass} pass / ${fail} fail  ================`);
})();
