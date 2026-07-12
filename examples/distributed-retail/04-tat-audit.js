/**
 * Distributed Retail Analytics — TAT / execution-time audit for materialized
 * views, views, and recursive queries (all executed AT the external source that
 * owns the data). Proves the value of a matview (prefetched, fast) vs. computing
 * the same result live, and measures REFRESH cost + recursive traversal cost.
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
const sqlOn = (token, source, sql) => req('POST', '/queries/exec', token, { source, schema: 'public', sql });

async function timeIt(token, source, sql, runs = 8) {
  const server = [], client = [];
  let rowCount = 0;
  for (let i = 0; i < runs; i++) {
    const t0 = Date.now();
    const r = await sqlOn(token, source, sql);
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

  // 1) Materialized view read vs. computing the SAME result live from base tables.
  console.log('── Materialized view vs. live recompute (Retail_Core) ──');
  const mv = await timeIt(token, 'Retail_Core',
    `SELECT sales_day, region, order_count, revenue FROM mv_daily_region_sales ORDER BY sales_day, region`);
  row('matview read  (prefetched)', mv);
  const live = await timeIt(token, 'Retail_Core',
    `SELECT date_trunc('day',o.order_date)::date sales_day, c.region, count(*) order_count, sum(o.total_amount) revenue
     FROM orders o JOIN customers c ON c.id=o.customer_id GROUP BY 1,2 ORDER BY 1,2`);
  row('live recompute (join+group base tables)', live);
  if (!mv.error && !live.error && mv.serverAvg > 0) {
    const factor = (live.serverAvg / Math.max(mv.serverAvg, 1)).toFixed(1);
    console.log(`  → matview is ~${factor}x faster than recomputing (${live.serverAvg}ms → ${mv.serverAvg}ms)`);
  }

  // 2) REFRESH cost (online, CONCURRENTLY — needs the unique index we created).
  console.log('\n── Materialized view REFRESH cost ──');
  const refresh = await timeIt(token, 'Retail_Core', `REFRESH MATERIALIZED VIEW CONCURRENTLY mv_daily_region_sales`, 3);
  row('REFRESH MATERIALIZED VIEW CONCURRENTLY', refresh);

  // 3) View read + aggregate (recomputed each call — no prefetch).
  console.log('\n── View (always live) ──');
  row('v_customer_orders → revenue by region',
    await timeIt(token, 'Retail_Core',
      `SELECT region, count(*) orders, round(sum(total_amount),2) revenue FROM v_customer_orders GROUP BY region ORDER BY revenue DESC`));

  // 4) Recursive CTE traversal cost (full referral forest, all roots).
  console.log('\n── Recursive CTE traversal (Retail_Core) ──');
  row('referral tree: full forest depth counts',
    await timeIt(token, 'Retail_Core',
      `WITH RECURSIVE tree AS (
         SELECT id, referred_by, 1 AS depth FROM customers WHERE referred_by IS NULL
         UNION ALL
         SELECT c.id, c.referred_by, t.depth+1 FROM customers c JOIN tree t ON c.referred_by=t.id
       ) SELECT depth, count(*) members FROM tree GROUP BY depth ORDER BY depth`));

  // 5) Recursive CTE whose base reads a VIEW (recursive-from-view).
  console.log('\n── Recursive CTE reading FROM a view ──');
  row('deepest referral chains joined to v_customer_orders',
    await timeIt(token, 'Retail_Core',
      `WITH RECURSIVE tree AS (
         SELECT id, referred_by, 1 AS depth FROM customers WHERE referred_by IS NULL
         UNION ALL
         SELECT c.id, c.referred_by, t.depth+1 FROM customers c JOIN tree t ON c.referred_by=t.id
       )
       SELECT t.depth, count(DISTINCT vco.order_id) orders, round(coalesce(sum(vco.total_amount),0),2) revenue
       FROM tree t LEFT JOIN v_customer_orders vco ON vco.customer_id = t.id
       GROUP BY t.depth ORDER BY t.depth`));

  console.log('\nDone. All timings are source-side execution at the external engine (not the fabric hub).');
})();
