/**
 * Metadata manifest examples runner.
 *
 * For each example manifest it calls POST /api/metadata/diff to VALIDATE the
 * manifest and show the orchestration plan (the DDL/operations the fabric would
 * run). Diff writes nothing. Pass --apply to actually orchestrate (executes DDL
 * on the tenant's managed schemas + dispatches to external sources).
 *
 *   node run-metadata-examples.js            # validate (diff) all four
 *   node run-metadata-examples.js --apply    # validate then apply all four
 *
 * Manifests:
 *   01-single-source.json  one schema, one source (enum, sequence, tables, PK, index, check, 1:M rel)
 *   02-multi-source.json   two schemas across Postgres + Mongo, incl. a cross-source relationship
 *   03-combined.json       every object type in one schema (table/view/matview/function/procedure/trigger/enum/sequence)
 *   04-complex.json        all features (strategies, generated cols, CHECK+EXCLUDE, GIN/BRIN, RLS/masking/grants,
 *                          triggers, 1:1/1:M/M:N cross-source rels, federated view, ES+Snowflake downstream)
 */
const http = require('http');
const fs = require('fs');
const path = require('path');
const BASE = 'http://localhost:4000/api';

function req(method, p, token, body) {
  return new Promise((resolve) => {
    const data = body ? JSON.stringify(body) : null;
    const r = http.request(BASE + p, { method, headers: {
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
// multipart upload of a manifest file to /metadata/{diff,apply}
function postManifest(p, token, obj) {
  return new Promise((resolve) => {
    const boundary = '----fabricManifestBoundary';
    const payload = JSON.stringify(obj);
    const pre = `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="manifest.json"\r\nContent-Type: application/json\r\n\r\n`;
    const buf = Buffer.concat([Buffer.from(pre), Buffer.from(payload), Buffer.from(`\r\n--${boundary}--\r\n`)]);
    const r = http.request(BASE + p, { method: 'POST', headers: {
      'Content-Type': `multipart/form-data; boundary=${boundary}`, 'Content-Length': buf.length,
      Authorization: 'Bearer ' + token, 'x-tenant-id': 'tenant_A',
    }}, (res) => { let b = ''; res.on('data', c => b += c); res.on('end', () => {
      try { resolve({ status: res.statusCode, json: JSON.parse(b) }); } catch { resolve({ status: res.statusCode, json: b }); }
    }); });
    r.on('error', e => resolve({ status: 0, json: { error: e.message } }));
    r.write(buf); r.end();
  });
}

const FILES = ['01-single-source.json', '02-multi-source.json', '03-combined.json', '04-complex.json'];

(async () => {
  const apply = process.argv.includes('--apply');
  const login = await req('POST', '/auth/login', null, { username: 'admin', password: 'admin' });
  const token = login.json?.token;
  if (!token) { console.log('LOGIN FAILED'); process.exit(1); }
  console.log(`Metadata manifest examples — ${apply ? 'DIFF + APPLY' : 'DIFF (validate only)'}\n`);

  for (const f of FILES) {
    const manifest = JSON.parse(fs.readFileSync(path.join(__dirname, f), 'utf8'));
    const schemas = manifest.schemas || [];
    const resCount = schemas.reduce((n, s) => n + (s.resources || []).length, 0);
    console.log(`### ${f}  —  namespace=${manifest.namespace}, ${schemas.length} schema(s), ${resCount} resource(s), ${(manifest.relationships || []).length} relationship(s)`);

    const diff = await postManifest('/metadata/diff', token, manifest);
    if (diff.status !== 200) { console.log(`  DIFF FAILED (${diff.status}): ${JSON.stringify(diff.json).slice(0, 200)}`); continue; }
    const changes = diff.json.changes || diff.json.operations || diff.json.plan || [];
    const arr = Array.isArray(changes) ? changes : [];
    console.log(`  DIFF ok — ${arr.length} planned operation(s)`);
    const byType = {};
    for (const c of arr) { const k = c.type || c.action || c.operation || 'op'; byType[k] = (byType[k] || 0) + 1; }
    if (Object.keys(byType).length) console.log('    ops: ' + JSON.stringify(byType));
    for (const c of arr.slice(0, 4)) console.log(`      · ${c.action || c.type || ''} ${c.table || c.name || c.target || ''}`.trim());

    if (apply) {
      const res = await postManifest('/metadata/apply', token, manifest);
      if (res.status !== 200) { console.log(`  APPLY FAILED (${res.status}): ${JSON.stringify(res.json).slice(0, 200)}`); continue; }
      const results = res.json.results || res.json.applied || [];
      const ok = (Array.isArray(results) ? results : []).filter(r => String(r.status || '').startsWith('SUCCESS')).length;
      console.log(`  APPLY ok — ${ok}/${Array.isArray(results) ? results.length : '?'} operations SUCCESS`);
    }
    console.log('');
  }
  console.log('Done. (Use --apply to orchestrate; diff-only validates parsing + planning of all features.)');
})();
