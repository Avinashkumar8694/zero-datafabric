/**
 * Distributed Retail Analytics — real-world analyst scenarios.
 *
 * Canonical analytics patterns used in industry, run against the external
 * sources through the fabric. SQL-heavy patterns (window/CTE) execute AT the
 * Postgres source that owns the data; the Mongo funnel stage is a pushed-down
 * $group aggregate; the funnel is then assembled from metrics pulled from BOTH
 * engines — demonstrating the fabric composing a KPI across databases.
 *
 * Patterns: RFM segmentation · cohort retention · 7-day moving average ·
 *           Pareto/ABC analysis · cross-source conversion funnel.
 *
 * Run (backend up on :4000):  node 05-real-world-scenarios.js
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
const ast = (token, query) => req('POST', '/analytics/query', token, { queryConfig: { type: 'SELECT', schema: 'public', limit: 200, query } });
const rows = (r) => r.json?.data || r.json?.results || [];
const ms = (r) => r.json?.plan?.executionMs;

function table(title, r, cols) {
  console.log(`\n### ${title}`);
  if (r.status !== 200) { console.log('  ERROR:', r.json?.error); return; }
  console.log(`  (${rows(r).length} rows · source-side ${ms(r)}ms · ${r.json?.plan?.strategy})`);
  const data = rows(r).slice(0, 10);
  if (!data.length) return;
  const use = cols || Object.keys(data[0]);
  console.log('  ' + use.join(' | '));
  for (const row of data) console.log('  ' + use.map(c => String(row[c])).join(' | '));
}

(async () => {
  const login = await req('POST', '/auth/login', null, { username: 'admin', password: 'admin' });
  const token = login.json?.token;
  if (!token) { console.log('LOGIN FAILED'); process.exit(1); }
  console.log('Real-world analytics scenarios over the distributed retail fabric');

  // 1) RFM segmentation — Recency / Frequency / Monetary, quintile-scored (Retail_Core).
  table('RFM segmentation (customers scored by recency/frequency/monetary)',
    await sqlOn(token, 'Retail_Core', `
      WITH base AS (
        SELECT o.customer_id,
               EXTRACT(day FROM now() - max(o.order_date))::int AS recency_days,
               count(*) AS frequency,
               sum(o.total_amount) AS monetary
        FROM orders o GROUP BY o.customer_id),
      scored AS (
        SELECT customer_id, recency_days, frequency, monetary,
               ntile(5) OVER (ORDER BY recency_days DESC) AS r,
               ntile(5) OVER (ORDER BY frequency)        AS f,
               ntile(5) OVER (ORDER BY monetary)         AS m
        FROM base)
      SELECT (r*100 + f*10 + m) AS rfm_score, count(*) AS customers,
             round(avg(monetary),2) AS avg_monetary
      FROM scored GROUP BY 1 ORDER BY rfm_score DESC LIMIT 10`),
    ['rfm_score', 'customers', 'avg_monetary']);

  // 2) Cohort retention — by signup month, activity in following months (Retail_Core).
  table('Cohort retention (signup-month cohorts × months-since-signup active customers)',
    await sqlOn(token, 'Retail_Core', `
      WITH cohort AS (
        SELECT c.id, date_trunc('month', c.signup_date) AS cohort_month FROM customers c),
      activity AS (
        SELECT o.customer_id,
               (EXTRACT(year FROM age(date_trunc('month',o.order_date), ch.cohort_month))*12
                + EXTRACT(month FROM age(date_trunc('month',o.order_date), ch.cohort_month)))::int AS month_offset,
               ch.cohort_month
        FROM orders o JOIN cohort ch ON ch.id = o.customer_id)
      SELECT to_char(cohort_month,'YYYY-MM') AS cohort, month_offset,
             count(DISTINCT customer_id) AS active
      FROM activity WHERE month_offset BETWEEN 0 AND 6
      GROUP BY 1,2 ORDER BY 1 DESC, 2 LIMIT 10`),
    ['cohort', 'month_offset', 'active']);

  // 3) 7-day moving average of daily revenue (Retail_Core).
  table('7-day moving average of daily revenue',
    await sqlOn(token, 'Retail_Core', `
      WITH d AS (SELECT date_trunc('day',order_date)::date dt, sum(total_amount) rev FROM orders GROUP BY 1)
      SELECT dt, round(rev,2) revenue,
             round(avg(rev) OVER (ORDER BY dt ROWS BETWEEN 6 PRECEDING AND CURRENT ROW),2) AS moving_avg_7d
      FROM d ORDER BY dt DESC LIMIT 10`),
    ['dt', 'revenue', 'moving_avg_7d']);

  // 4) Pareto / ABC analysis — cumulative revenue share of products (Product_Warehouse).
  table('Pareto / ABC analysis (product revenue concentration)',
    await sqlOn(token, 'Product_Warehouse', `
      WITH prod AS (
        SELECT p.id, p.name, p.category, sum(i.line_amount) AS revenue
        FROM order_items i JOIN products p ON p.id = i.product_id
        GROUP BY p.id, p.name, p.category),
      ranked AS (
        SELECT name, category, revenue,
               sum(revenue) OVER (ORDER BY revenue DESC) / sum(revenue) OVER () AS cum_share,
               row_number() OVER (ORDER BY revenue DESC) AS rnk
        FROM prod)
      SELECT rnk, name, category, round(revenue,2) revenue, round(cum_share*100,1) AS cum_pct,
             CASE WHEN cum_share <= 0.8 THEN 'A' WHEN cum_share <= 0.95 THEN 'B' ELSE 'C' END AS abc_class
      FROM ranked ORDER BY rnk LIMIT 10`),
    ['rnk', 'name', 'category', 'revenue', 'cum_pct', 'abc_class']);

  // 5) Cross-source conversion funnel — web engagement (Mongo) vs. actual orders (Postgres).
  console.log('\n### Cross-source conversion funnel (Web_Analytics Mongo → Retail_Core Postgres)');
  const web = await ast(token, {
    from: { resource: 'web_events', source: 'Web_Analytics' }, groupBy: ['event_type'],
    select: ['event_type', { aggregate: 'COUNT', column: '*', alias: 'events' }],
  });
  const ordersCount = await ast(token, {
    from: { resource: 'orders', source: 'Retail_Core' }, groupBy: ['status'],
    select: ['status', { aggregate: 'COUNT', column: '*', alias: 'n' }],
  });
  const webMap = Object.fromEntries(rows(web).map(r => [r.event_type, Number(r.events)]));
  const totalOrders = rows(ordersCount).reduce((s, r) => s + Number(r.n), 0);
  const funnel = [
    ['page_view (Mongo)', webMap.page_view || 0],
    ['add_to_cart (Mongo)', webMap.add_to_cart || 0],
    ['checkout (Mongo)', webMap.checkout || 0],
    ['orders placed (Postgres)', totalOrders],
  ];
  console.log(`  web metrics pushed to Mongo ($group, ${ms(web)}ms) · order metrics pushed to Postgres (GROUP BY, ${ms(ordersCount)}ms)`);
  const top = funnel[0][1] || 1;
  for (const [stage, n] of funnel) {
    console.log(`  ${stage.padEnd(28)} ${String(n).padStart(7)}  ${'█'.repeat(Math.round(n / top * 30))} ${(n / top * 100).toFixed(1)}%`);
  }

  console.log('\nDone — 5 real-world analytics scenarios across the distributed retail fabric.');
})();
