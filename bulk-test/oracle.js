/**
 * Shared ground-truth data + JS oracle + HTTP client for the bulk test suites.
 *
 * Datasets (deterministic, keyed on id 1..28) live in FOUR objects across
 * THREE engines in tenant `tenant_advanced_test`:
 *   remote_table  @ PG_DSN_Source (Postgres)  id 1..28, value = odd?100:200, name
 *   dim           @ Local_Mongo   (MongoDB)   id 1..28, grade, region, qty=id
 *   enrich        @ Local_Mongo   (MongoDB)   id {2,4,6}, grade
 *   metrics       @ Local_MySQL   (MySQL)     id 1..28, category A/B/C/D, score=id*5
 *
 * Every generated query has its expected result computed here in JS (the oracle),
 * so data validity is checked automatically rather than eyeballed.
 */
const jwt = require('jsonwebtoken');
const http = require('http');

const TENANT = 'tenant_advanced_test';
const TOKEN = jwt.sign(
  { role: 'fabric_user', internal_role: 'ADMIN', tenant_id: TENANT, username: 'bulk', iss: 'zero-data-fabric' },
  'reallyreallyreallyreallyverysecret', { expiresIn: '2h' }
);

const SOURCES = { PG: 'PG_DSN_Source', MONGO: 'Local_Mongo', MYSQL: 'Local_MySQL', ES: 'Local_ES' };

// ---- ground truth ----
const GRADES = ['gold', 'silver', 'bronze'];
const CATS = ['A', 'B', 'C', 'D'];
const remote = Array.from({ length: 28 }, (_, i) => { const id = i + 1; return { id, name: id % 2 ? 'Remote Item 1' : 'Remote Item 2', value: id % 2 ? 100 : 200 }; });
const dim = Array.from({ length: 28 }, (_, i) => { const id = i + 1; return { id, grade: GRADES[(id - 1) % 3], region: (id - 1) % 2 === 0 ? 'EAST' : 'WEST', qty: id }; });
const metrics = Array.from({ length: 28 }, (_, i) => { const id = i + 1; return { id, category: CATS[(id - 1) % 4], score: id * 5 }; });
const enrichMap = { 2: 'gold', 4: 'silver', 6: 'bronze' };
const enrich = Object.entries(enrichMap).map(([id, grade]) => ({ id: +id, grade }));

// pre-joined views (INNER on id)
const rd = remote.map((r) => ({ ...r, ...dim[r.id - 1] }));                 // remote ⋈ dim
const rm = remote.map((r) => ({ ...r, ...metrics[r.id - 1] }));            // remote ⋈ metrics
const rdm = remote.map((r) => ({ ...r, ...dim[r.id - 1], ...metrics[r.id - 1] })); // 3-way

// ---- helpers ----
const N = (v) => (v === null || v === undefined ? v : Number(v));
const num = (a, b) => a - b;
const OPS = { EQ: (a, b) => a === b, NE: (a, b) => a !== b, GT: (a, b) => a > b, GTE: (a, b) => a >= b, LT: (a, b) => a < b, LTE: (a, b) => a <= b };
const eqSet = (a, b) => { const s = [...a].sort(num), t = [...b].sort(num); return s.length === t.length && s.every((x, i) => x === t[i]); };
const eqSeq = (a, b) => a.length === b.length && a.every((x, i) => `${x}` === `${b[i]}`);
/** read a possibly alias-qualified column from a result row (tries "a.col" then "col"). */
const read = (row, col) => (row[col] !== undefined ? row[col] : row[col.split('.').pop()]);
/** SQL-style GROUP BY + aggregates over JS rows, returned sorted by the group key. */
function groupAgg(rows, gcol, aggs) {
  const m = new Map();
  for (const r of rows) { const k = r[gcol]; if (!m.has(k)) m.set(k, []); m.get(k).push(r); }
  const out = [];
  for (const [k, rs] of m) {
    const o = { key: k };
    for (const a of aggs) {
      const vs = rs.map((r) => r[a.col]);
      o[a.alias] = a.fn === 'COUNT' ? rs.length : a.fn === 'SUM' ? vs.reduce((x, y) => x + y, 0)
        : a.fn === 'MIN' ? Math.min(...vs) : a.fn === 'MAX' ? Math.max(...vs)
          : a.fn === 'AVG' ? vs.reduce((x, y) => x + y, 0) / rs.length : NaN;
    }
    out.push(o);
  }
  return out.sort((x, y) => (`${x.key}` < `${y.key}` ? -1 : `${x.key}` > `${y.key}` ? 1 : 0));
}

function call(query) {
  const body = JSON.stringify({ queryConfig: { type: 'SELECT', query } });
  return new Promise((resolve) => {
    const req = http.request({ host: 'localhost', port: 4000, path: '/api/analytics/query', method: 'POST', headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body), Authorization: 'Bearer ' + TOKEN } },
      (res) => { let b = ''; res.on('data', (c) => (b += c)); res.on('end', () => { try { resolve(JSON.parse(b)); } catch { resolve({ error: b.slice(0, 140) }); } }); });
    req.on('error', (e) => resolve({ error: e.message })); req.write(body); req.end();
  });
}

/** Run an array of {cat, cross, query, check} cases with bounded concurrency; return a report. */
async function runCases(CASES, conc = 24) {
  const results = new Array(CASES.length);
  const strat = {};
  let idx = 0;
  async function worker() {
    while (idx < CASES.length) {
      const i = idx++; const c = CASES[i];
      const res = await call(c.query);
      const s = res.plan?.strategy || (res.error ? 'ERROR' : 'NONE');
      strat[s] = (strat[s] || 0) + 1;
      let ok = false, why = '';
      if (c.expectErr) { ok = !!res.error && c.expectErr.test(res.error); why = ok ? '' : 'want-error: ' + (res.error || 'none'); }
      else if (res.error) { why = res.error; }
      else { try { ok = c.check(res.data || []) === true; if (!ok) why = 'mismatch: ' + JSON.stringify((res.data || []).slice(0, 3)); } catch (e) { why = e.message; } }
      results[i] = { ok, cat: c.cat, cross: c.cross, strat: s, why };
    }
  }
  await Promise.all(Array.from({ length: conc }, worker));
  return { results, strat };
}

function report(title, CASES, results, strat) {
  const byCat = {}; let pass = 0, fail = 0, sP = 0, sF = 0, xP = 0, xF = 0; const fails = [];
  for (const r of results) {
    byCat[r.cat] = byCat[r.cat] || { p: 0, f: 0 };
    if (r.ok) { pass++; byCat[r.cat].p++; r.cross ? xP++ : sP++; } else { fail++; byCat[r.cat].f++; r.cross ? xF++ : sF++; fails.push(r); }
  }
  console.log(`\n===== ${title} =====`);
  console.log(`TOTAL ${CASES.length}   PASS ${pass}   FAIL ${fail}   (same-source ${sP}/${sP + sF}, cross-source ${xP}/${xP + xF})`);
  console.log('STRATEGY:', JSON.stringify(strat));
  console.log('BY CATEGORY:');
  for (const k of Object.keys(byCat).sort()) console.log(`  ${k.padEnd(20)} ${byCat[k].p}/${byCat[k].p + byCat[k].f}`);
  if (fails.length) { console.log('FIRST 15 FAILURES:'); for (const f of fails.slice(0, 15)) console.log(`  [${f.cat}] ${f.strat}: ${String(f.why).slice(0, 140)}`); }
  return { pass, fail };
}

module.exports = { SOURCES, GRADES, CATS, remote, dim, metrics, enrich, enrichMap, rd, rm, rdm, N, num, OPS, eqSet, eqSeq, read, groupAgg, call, runCases, report };
