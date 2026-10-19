/**
 * Distributed Retail Analytics — TAT / execution-time audit for materialized
 * views, views, and recursive traversals (AST queries against the external
 * sources that own the data). Proves the value of a matview (prefetched, fast)
 * vs. computing a comparable result live, and measures recursive traversal cost.
 *
 * Times reported are the SOURCE-side execution ms from plan.executionMs (pure
 * engine time, excluding HTTP), each run K times → min / avg.
 *
 * Run (backend up on :4000):  node 04-tat-audit.js
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
const astOn = (token, query) => req('POST', '/analytics/query', token, { queryConfig: { type: 'SELECT', schema: 'public', limit: 5000, query } });

async function timeIt(token, query, runs = 8) {
  const server = [], client = [];
  let rowCount = 0;
  for (let i = 0; i < runs; i++) {
    const t0 = Date.now();
    const r = await astOn(token, query);
    client.push(Date.now() - t0);
    if (r.status !== 200) return { error: r.json?.error };
    server.push(r.json.plan?.executionMs ?? 0);
    rowCount = (r.json.data || r.json.results || []).length;
  }
  const min = (a) => Math.min(...a), avg = (a) => Math.round(a.reduce((x, y) => x + y, 0) / a.length);
  return { serverMin: min(server), serverAvg: avg(server), clientAvg: avg(client), rowCount };
}
function row(label, r) {
  if (r.error) return console.log(`  ${label.padEnd(46)}  ERROR: ${r.error}`);
  console.log(`  ${label.padEnd(46)}  src ${String(r.serverMin).padStart(4)}ms(min)/${String(r.serverAvg).padStart(4)}ms(avg)  rows=${r.rowCount}`);
}

(async () => {
  const login = await req('POST', '/auth/login', null, { username: 'admin', password: 'admin' });
  const token = login.json?.token;
  if (!token) { console.log('LOGIN FAILED'); process.exit(1); }
  console.log('TAT / execution-time audit (source-side ms, 8 runs each)\n');

  // 1) Materialized view read vs. computing a comparable result live from base tables.
  console.log('── Materialized view vs. live recompute (Retail_Core) ──');
  const mv = await timeIt(token, {
    from: { resource: 'mv_daily_region_sales', source: 'Retail_Core' },
    groupBy: ['region'],
    select: ['region', { aggregate: 'SUM', column: 'order_count', alias: 'order_count' }, { aggregate: 'SUM', column: 'revenue', alias: 'revenue' }],
  });
  row('matview read  (prefetched)', mv);
  const live = await timeIt(token, {
    from: { resource: 'orders', source: 'Retail_Core', alias: 'o' },
    joins: [{ type: 'INNER', resource: 'customers', source: 'Retail_Core', alias: 'c', on: { left: 'o.customer_id', operator: 'EQ', right: 'c.id' } }],
    groupBy: ['c.region'],
    select: ['c.region', { aggregate: 'COUNT', column: '*', alias: 'order_count' }, { aggregate: 'SUM', column: 'o.total_amount', alias: 'revenue' }],
  });
  row('live recompute (join+group base tables)', live);
  if (!mv.error && !live.error && mv.serverAvg > 0) {
    const factor = (live.serverAvg / Math.max(mv.serverAvg, 1)).toFixed(1);
    console.log(`  → matview is ~${factor}x faster than recomputing (${live.serverAvg}ms → ${mv.serverAvg}ms)`);
  }

  // 2) View read + aggregate (recomputed each call — no prefetch).
  console.log('\n── View (always live) ──');
  row('v_customer_orders → revenue by region',
    await timeIt(token, {
      from: { resource: 'v_customer_orders', source: 'Retail_Core' }, groupBy: ['region'],
      select: ['region', { aggregate: 'COUNT', column: '*', alias: 'orders' }, { aggregate: 'SUM', column: 'total_amount', alias: 'revenue' }],
      orderBy: [{ column: 'revenue', direction: 'DESC' }],
    }));

  // 3) Recursive traversal cost (full referral forest, all roots; level-by-level in the fabric).
  console.log('\n── Recursive traversal (Retail_Core) ──');
  row('referral tree: full forest, members per depth',
    await timeIt(token, {
      from: { resource: 'customers', source: 'Retail_Core' }, select: ['id', 'referred_by'],
      recursive: { source: 'Retail_Core', resource: 'customers', select: ['id', 'referred_by'],
        connectBy: { parent: 'referred_by', child: 'id' }, direction: 'down', maxDepth: 25 },
    }, 3));

  console.log('\nDone. Timings are fabric plan execution times for AST queries against the external sources.');
})();
