/* eslint-disable no-console */
/**
 * STREAMING examples — `stream: false` (buffered envelope) vs `stream: true`
 * (NDJSON: one row per line + a final {__meta__} trailer).
 *
 * Shows, for AST (/api/analytics/query) and SQL (/api/queries/exec):
 *   - what the RESPONSE looks like in each mode, and
 *   - how a client CONSUMES a stream incrementally (row-by-row, then the trailer).
 *
 * Run:  NODE_PATH=backend/node_modules node examples/analytics/streaming.js
 */
const axios = require('axios');
const readline = require('readline');
const B = 'http://localhost:4000/api';
const H = (t) => ({ Authorization: `Bearer ${t}`, 'x-tenant-id': 'tenant_A', 'Content-Type': 'application/json' });

// A client helper: POST a streaming request and process each row AS IT ARRIVES.
async function consumeStream(url, body, token, onRow) {
  const res = await axios.post(url, body, { headers: H(token), responseType: 'stream' });
  const rl = readline.createInterface({ input: res.data, crlfDelay: Infinity });
  let meta = null, n = 0;
  for await (const line of rl) {
    if (!line.trim()) continue;
    const obj = JSON.parse(line);
    if (obj.__meta__) { meta = obj.__meta__; }        // trailer — last line
    else { n++; onRow(obj, n); }                       // a data row
  }
  return { rows: n, meta };
}

async function main() {
  const t = (await axios.post(`${B}/auth/login`, { username: 'admin', password: 'admin' })).data.token;

  const astBody = { queryConfig: { type: 'SELECT', schema: 'an_lab', limit: 5, query: {
    from: { resource: 'employees', source: 'An_Lab' }, select: ['id', 'name', 'dept_id', 'salary'],
    where: [{ column: 'dept_id', operator: 'EQ', value: 10 }] } } };

  console.log('\n════ AST · /api/analytics/query ════');

  // 1) stream:false — one buffered JSON envelope (default).
  const buffered = (await axios.post(`${B}/analytics/query`, astBody, { headers: H(t) })).data;
  console.log('\n[stream:false] buffered envelope (arrives all at once):');
  console.log('  Content-Type: application/json');
  console.log(`  { data:[${buffered.rowCount} rows], rowCount:${buffered.rowCount}, plan.strategy:${buffered.plan?.strategy}, warnings:${(buffered.warnings||[]).length} }`);

  // 2) stream:true — NDJSON, consumed row-by-row, trailer at the end.
  console.log('\n[stream:true] NDJSON — client processes each row as it arrives:');
  console.log('  Content-Type: application/x-ndjson   (X-Fabric-Stream: ndjson)');
  const s = await consumeStream(`${B}/analytics/query`, { ...astBody, stream: true }, t,
    (row, i) => console.log(`   → row ${i}: ${JSON.stringify(row)}`));
  console.log(`   ⟶ trailer {__meta__}: rowCount=${s.meta.rowCount} strategy=${s.meta.strategy} streamed=${s.meta.streamed}`);
  console.log(`   (client saw ${s.rows} rows incrementally, then the plan/legs trailer)`);

  console.log('\n════ SQL · /api/queries/exec ════');
  const sqlBody = { sql: 'SELECT generate_series(1,5) AS n, now() AS ts' };

  const sqlBuffered = (await axios.post(`${B}/queries/exec`, sqlBody, { headers: H(t) })).data;
  console.log(`\n[stream:false] { results:[${(sqlBuffered.results?.results||sqlBuffered.results||[]).length} rows] }  (application/json)`);

  console.log('\n[stream:true] NDJSON rows + trailer:');
  const s2 = await consumeStream(`${B}/queries/exec`, { ...sqlBody, stream: true }, t,
    (row, i) => console.log(`   → row ${i}: ${JSON.stringify(row)}`));
  console.log(`   ⟶ trailer: rowCount=${s2.meta.rowCount} strategy=${s2.meta.strategy}`);

  console.log('\n════ curl equivalents ════');
  console.log(`  # buffered:\n  curl -s $BASE/api/analytics/query -H "Authorization: Bearer $T" -H 'x-tenant-id: tenant_A' \\`);
  console.log(`       -H 'Content-Type: application/json' -d '{"queryConfig":{...}}'`);
  console.log(`  # streamed (rows appear as they arrive):\n  curl -N -s $BASE/api/analytics/query -H "Authorization: Bearer $T" -H 'x-tenant-id: tenant_A' \\`);
  console.log(`       -H 'Content-Type: application/json' -d '{"stream":true,"queryConfig":{...}}'`);
  console.log('\nDone.');
}
main().catch((e) => { console.error('ERR', e.response?.data || e.message); process.exit(1); });
