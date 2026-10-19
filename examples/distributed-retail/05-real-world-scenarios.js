/**
 * Distributed Retail Analytics — real-world analyst scenarios.
 *
 * Canonical analytics patterns used in industry, run against the external
 * sources through the fabric. Each pattern pulls a bounded, pushed-down AST
 * aggregate from the source that owns the data (GROUP BY on Postgres, $group on
 * Mongo) and finishes the scoring/windowing client-side; the funnel is assembled
 * from metrics pulled from BOTH engines — demonstrating the fabric composing a
 * KPI across databases.
 *
 * Patterns: RFM segmentation · 7-day moving average · Pareto/ABC analysis ·
 *           cross-source conversion funnel.
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
const ast = (token, query, limit = 200) => req('POST', '/analytics/query', token, { queryConfig: { type: 'SELECT', schema: 'public', limit, query } });
const rows = (r) => r.json?.data || r.json?.results || [];
const ms = (r) => r.json?.plan?.executionMs;

/** Print a table from already-derived rows; `r` is the AST response the rows came from (for the trace line). */
function table(title, r, data, cols) {
  console.log(`\n### ${title}`);
  if (r.status !== 200) { console.log('  ERROR:', r.json?.error); return; }
  console.log(`  (${data.length} rows · source-side ${ms(r)}ms · ${r.json?.plan?.strategy})`);
  data = data.slice(0, 10);
  if (!data.length) return;
  const use = cols || Object.keys(data[0]);
  console.log('  ' + use.join(' | '));
  for (const row of data) console.log('  ' + use.map(c => String(row[c])).join(' | '));
}
/** Quintile (1..5) score of v within the sorted ascending array `sorted`. */
const quintile = (sorted, v) => Math.min(5, 1 + Math.floor(5 * sorted.filter(x => x < v).length / sorted.length));
const round2 = (n) => Math.round(Number(n) * 100) / 100;

(async () => {
  const login = await req('POST', '/auth/login', null, { username: 'admin', password: 'admin' });
  const token = login.json?.token;
  if (!token) { console.log('LOGIN FAILED'); process.exit(1); }
  console.log('Real-world analytics scenarios over the distributed retail fabric');

  // 1) RFM segmentation — per-customer R/F/M aggregates pushed to Retail_Core, quintile-scored client-side.
  {
    const r = await ast(token, {
      from: { resource: 'orders', source: 'Retail_Core' }, groupBy: ['customer_id'],
      select: ['customer_id',
        { aggregate: 'MAX', column: 'order_date', alias: 'last_order' },
        { aggregate: 'COUNT', column: '*', alias: 'frequency' },
        { aggregate: 'SUM', column: 'total_amount', alias: 'monetary' }],
    }, 20000);
    const base = rows(r).map(x => ({ ...x, recency_days: Math.floor((Date.now() - new Date(x.last_order).getTime()) / 86400000),
                                     frequency: Number(x.frequency), monetary: Number(x.monetary) }));
    const sr = base.map(x => -x.recency_days).sort((a, b) => a - b), sf = base.map(x => x.frequency).sort((a, b) => a - b), sm = base.map(x => x.monetary).sort((a, b) => a - b);
    const byScore = {};
    for (const x of base) {
      const k = quintile(sr, -x.recency_days) * 100 + quintile(sf, x.frequency) * 10 + quintile(sm, x.monetary);
      (byScore[k] ||= []).push(x.monetary);
    }
    const out = Object.entries(byScore).map(([k, v]) => ({ rfm_score: Number(k), customers: v.length, avg_monetary: round2(v.reduce((a, b) => a + b, 0) / v.length) }))
      .sort((a, b) => b.rfm_score - a.rfm_score);
    table('RFM segmentation (customers scored by recency/frequency/monetary)', r, out, ['rfm_score', 'customers', 'avg_monetary']);
  }

  // 2) 7-day moving average of daily revenue — daily totals pushed to Retail_Core (matview), averaged client-side.
  {
    const r = await ast(token, {
      from: { resource: 'mv_daily_region_sales', source: 'Retail_Core' }, groupBy: ['sales_day'],
      select: ['sales_day', { aggregate: 'SUM', column: 'revenue', alias: 'revenue' }],
      orderBy: [{ column: 'sales_day', direction: 'ASC' }],
    }, 5000);
    const days = rows(r).map(x => ({ dt: x.sales_day, revenue: Number(x.revenue) }));
    const out = days.map((d, i) => {
      const w = days.slice(Math.max(0, i - 6), i + 1);
      return { dt: d.dt, revenue: round2(d.revenue), moving_avg_7d: round2(w.reduce((a, b) => a + b.revenue, 0) / w.length) };
    }).reverse();
    table('7-day moving average of daily revenue', r, out, ['dt', 'revenue', 'moving_avg_7d']);
  }

  // 3) Pareto / ABC analysis — product revenue aggregated at Product_Warehouse, cumulative share client-side.
  {
    const r = await ast(token, {
      from: { resource: 'order_items', source: 'Product_Warehouse', alias: 'i' },
      joins: [{ type: 'INNER', resource: 'products', source: 'Product_Warehouse', alias: 'p', on: { left: 'i.product_id', operator: 'EQ', right: 'p.id' } }],
      groupBy: ['p.id', 'p.name', 'p.category'],
      select: ['p.name', 'p.category', { aggregate: 'SUM', column: 'i.line_amount', alias: 'revenue' }],
      orderBy: [{ column: 'revenue', direction: 'DESC' }],
    }, 20000);
    const prod = rows(r).map(x => ({ name: x.name || x['p.name'], category: x.category || x['p.category'], revenue: Number(x.revenue) }))
      .sort((a, b) => b.revenue - a.revenue);
    const total = prod.reduce((a, b) => a + b.revenue, 0) || 1;
    let cum = 0;
    const out = prod.map((x, i) => { cum += x.revenue / total; return { rnk: i + 1, name: x.name, category: x.category, revenue: round2(x.revenue),
      cum_pct: round2(cum * 100), abc_class: cum <= 0.8 ? 'A' : cum <= 0.95 ? 'B' : 'C' }; });
    table('Pareto / ABC analysis (product revenue concentration)', r, out, ['rnk', 'name', 'category', 'revenue', 'cum_pct', 'abc_class']);
  }

  // 4) Cross-source conversion funnel — web engagement (Mongo) vs. actual orders (Postgres).
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

  console.log('\nDone — 4 real-world analytics scenarios across the distributed retail fabric.');
})();
