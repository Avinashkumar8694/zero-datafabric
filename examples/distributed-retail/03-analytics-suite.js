/**
 * Distributed Retail Analytics — complex query suite + pushdown verification.
 *
 * Every scenario runs against the LIVE fabric API over the three external
 * databases (Retail_Core PG, Product_Warehouse PG, Web_Analytics Mongo) and then
 * INSPECTS the per-leg execution trace to prove the fabric did the right thing:
 *   - cross-source queries: each leg executed at its OWN source with a pushed-down
 *     predicate / bind-join / aggregate, and only the bounded result was merged;
 *   - single-source window / recursive / matview / view queries: expressed as AST
 *     (`window` select items, `recursive`, plain resource reads) and run at (or
 *     compensated in front of) the source that owns the data.
 *
 * These double as runnable EXAMPLES of what the data fabric supports.
 *
 * Run (backend must be up on :4000):  node 03-analytics-suite.js
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

const ast = (token, query, extra = {}) => req('POST', '/analytics/query', token, { queryConfig: { type: 'SELECT', schema: 'public', limit: 100, query, ...extra } });

let pass = 0, fail = 0;
function check(name, cond, detail) {
  if (cond) { pass++; console.log(`  PASS  ${name}${detail ? ' — ' + detail : ''}`); }
  else { fail++; console.log(`  FAIL  ${name}${detail ? ' — ' + detail : ''}`); }
}
function planLine(p) {
  if (!p) return '(no plan)';
  return `strategy=${p.strategy} totalMs=${p.executionMs} rowsFromSources=${p.rowsScannedAcrossSources ?? 'n/a'}`;
}
function printLegs(p) {
  for (const l of (p?.legs || [])) {
    console.log(`     · ${l.source} [${l.engine}/${l.mode}] ${l.operation} → ${l.rowsReturned} rows in ${l.ms}ms`);
    console.log(`         ${String(l.query).slice(0, 150)}`);
  }
}
const legs = (r) => r.json?.plan?.legs || [];
const strat = (r) => r.json?.plan?.strategy;
const rows = (r) => r.json?.data || r.json?.results || [];

(async () => {
  const login = await req('POST', '/auth/login', null, { username: 'admin', password: 'admin' });
  const token = login.json?.token;
  if (!token) { console.log('LOGIN FAILED'); process.exit(1); }
  console.log('login ok — running distributed analytics suite\n');

  // ============ CROSS-SOURCE FEDERATION ============
  console.log('── FEDERATED (cross-source) ──────────────────────────────');

  // F1: point join Postgres orders ⋈ Mongo web_events on customer_id
  {
    console.log('\n[F1] Point join: orders(Retail_Core PG) ⋈ web_events(Web_Analytics Mongo) WHERE customer_id=42');
    const r = await ast(token, {
      select: ['*'], from: { resource: 'orders', source: 'Retail_Core', alias: 'o' },
      joins: [{ type: 'INNER', resource: 'web_events', source: 'Web_Analytics', alias: 'w', on: { left: 'o.customer_id', operator: 'EQ', right: 'w.customer_id' } }],
      where: [{ column: 'o.customer_id', operator: 'EQ', value: 42 }],
    });
    console.log('   ' + planLine(r.json.plan)); printLegs(r.json.plan);
    check('F1 strategy CROSS_ENGINE', strat(r) === 'CROSS_ENGINE');
    check('F1 both legs run at their own source via connector', legs(r).length === 2 && legs(r).every(l => l.mode === 'connector'));
    check('F1 driving predicate pushed to Retail_Core', legs(r).some(l => l.source === 'Retail_Core' && /customer_id.*=/.test(l.query)));
    check('F1 bind-join key pushed to Mongo (not full scan)', legs(r).some(l => l.source === 'Web_Analytics' && /\$in/.test(l.query)));
    check('F1 only a handful of rows pulled from sources', (r.json.plan.rowsScannedAcrossSources ?? 1e9) < 50, `pulled=${r.json.plan.rowsScannedAcrossSources}`);
  }

  // F2: Postgres ⋈ Postgres across two DBs (orders ⋈ order_items on order_id)
  {
    console.log('\n[F2] Cross-DB join: orders(Retail_Core) ⋈ order_items(Product_Warehouse) WHERE order_id=1234');
    const r = await ast(token, {
      select: ['*'], from: { resource: 'orders', source: 'Retail_Core', alias: 'o' },
      joins: [{ type: 'INNER', resource: 'order_items', source: 'Product_Warehouse', alias: 'i', on: { left: 'o.id', operator: 'EQ', right: 'i.order_id' } }],
      where: [{ column: 'o.id', operator: 'EQ', value: 1234 }],
    });
    console.log('   ' + planLine(r.json.plan)); printLegs(r.json.plan);
    check('F2 strategy CROSS_ENGINE', strat(r) === 'CROSS_ENGINE');
    check('F2 order_items fetched by bind-join (order_id IN ...)', legs(r).some(l => l.source === 'Product_Warehouse' && /\$in|IN \(/.test(l.query)));
    check('F2 bounded rows pulled', (r.json.plan.rowsScannedAcrossSources ?? 1e9) < 200, `pulled=${r.json.plan.rowsScannedAcrossSources}`);
  }

  // F3: single-source aggregate pushed to Mongo ($group)
  {
    console.log('\n[F3] Aggregate pushdown to Mongo: web_events GROUP BY event_type → COUNT, SUM(revenue)');
    const r = await ast(token, {
      from: { resource: 'web_events', source: 'Web_Analytics' },
      groupBy: ['event_type'],
      select: ['event_type', { aggregate: 'COUNT', column: '*', alias: 'events' }, { aggregate: 'SUM', column: 'revenue', alias: 'revenue' }],
    });
    console.log('   ' + planLine(r.json.plan)); printLegs(r.json.plan);
    check('F3 aggregate pushed ($group), few group rows returned', rows(r).length > 0 && rows(r).length <= 10, `groups=${rows(r).length}`);
    check('F3 leg query is a Mongo aggregate', legs(r).some(l => /aggregate\(/.test(l.query)));
  }

  // F4: single-source aggregate pushed to remote Postgres (GROUP BY)
  {
    console.log('\n[F4] Aggregate pushdown to Retail_Core PG: orders GROUP BY status → COUNT, SUM(total_amount)');
    const r = await ast(token, {
      from: { resource: 'orders', source: 'Retail_Core' },
      groupBy: ['status'],
      select: ['status', { aggregate: 'COUNT', column: '*', alias: 'n' }, { aggregate: 'SUM', column: 'total_amount', alias: 'revenue' }],
    });
    console.log('   ' + planLine(r.json.plan)); printLegs(r.json.plan);
    check('F4 GROUP BY pushed to source, few rows returned', rows(r).length > 0 && rows(r).length <= 10, `groups=${rows(r).length}`);
    check('F4 leg SQL contains GROUP BY', legs(r).some(l => /GROUP BY/i.test(l.query)));
  }

  // F5: filter + projection pushdown
  {
    console.log('\n[F5] Filter+projection pushdown: customers region=EU segment=ENTERPRISE');
    const r = await ast(token, {
      select: ['id', 'name', 'region', 'segment'], from: { resource: 'customers', source: 'Retail_Core' },
      where: [{ column: 'region', operator: 'EQ', value: 'EU' }, { column: 'segment', operator: 'EQ', value: 'ENTERPRISE' }],
    }, { limit: 25 });
    console.log('   ' + planLine(r.json.plan)); printLegs(r.json.plan);
    check('F5 WHERE pushed to source', legs(r).some(l => /region.*=/.test(l.query) && /segment.*=/.test(l.query)));
    check('F5 rows returned and bounded', rows(r).length > 0 && rows(r).length <= 25, `rows=${rows(r).length}`);
  }

  // ============ SINGLE-SOURCE COMPLEX AST (window / recursive / matview / view) ============
  console.log('\n\n── SINGLE-SOURCE COMPLEX AST (window / recursive / views) ─');

  const complexQs = [
    { n: 'R1', src: 'Retail_Core', title: 'Window: running total of revenue over the daily matview',
      query: { from: { resource: 'mv_daily_region_sales', source: 'Retail_Core' },
               select: ['sales_day', 'region', 'revenue',
                 { window: 'SUM', column: 'revenue', orderBy: [{ column: 'sales_day', direction: 'ASC' }], alias: 'running_total' }] } },
    { n: 'R2', src: 'Retail_Core', title: 'Recursive: customer referral tree depth counts from root 1',
      query: { from: { resource: 'customers', source: 'Retail_Core' }, select: ['id', 'referred_by'],
               recursive: { source: 'Retail_Core', resource: 'customers', select: ['id', 'referred_by'],
                 connectBy: { parent: 'referred_by', child: 'id' },
                 startWith: [{ column: 'id', operator: 'EQ', value: 1 }], direction: 'down', maxDepth: 25 } } },
    { n: 'R3', src: 'Retail_Core', title: 'Materialized view read: top revenue days',
      query: { from: { resource: 'mv_daily_region_sales', source: 'Retail_Core' },
               select: ['sales_day', 'region', 'order_count', 'revenue'],
               orderBy: [{ column: 'revenue', direction: 'DESC' }] }, limit: 10 },
    { n: 'R4', src: 'Retail_Core', title: 'View read + aggregate: revenue by region via v_customer_orders',
      query: { from: { resource: 'v_customer_orders', source: 'Retail_Core' }, groupBy: ['region'],
               select: ['region', { aggregate: 'COUNT', column: '*', alias: 'orders' }, { aggregate: 'SUM', column: 'total_amount', alias: 'revenue' }],
               orderBy: [{ column: 'revenue', direction: 'DESC' }] } },
    { n: 'R5', src: 'Retail_Core', title: 'RANK: enterprise customers by lifetime value within region',
      query: { from: { resource: 'customers', source: 'Retail_Core' },
               select: ['id', 'region', 'lifetime_value',
                 { window: 'RANK', partitionBy: ['region'], orderBy: [{ column: 'lifetime_value', direction: 'DESC' }], alias: 'ltv_rank' }],
               where: [{ column: 'segment', operator: 'EQ', value: 'ENTERPRISE' }] }, limit: 20 },
    { n: 'R6', src: 'Product_Warehouse', title: 'RANK: products by price within category (window)',
      query: { from: { resource: 'products', source: 'Product_Warehouse' },
               select: ['category', 'name', 'price',
                 { window: 'RANK', partitionBy: ['category'], orderBy: [{ column: 'price', direction: 'DESC' }], alias: 'rank_in_category' }] }, limit: 18 },
    { n: 'R7', src: 'Retail_Core', title: 'LAG: previous-day revenue from the daily matview',
      query: { from: { resource: 'mv_daily_region_sales', source: 'Retail_Core' },
               select: ['sales_day', 'region', 'revenue',
                 { window: 'LAG', column: 'revenue', partitionBy: ['region'], orderBy: [{ column: 'sales_day', direction: 'ASC' }], alias: 'prev_revenue' }] }, limit: 12 },
  ];

  for (const q of complexQs) {
    console.log(`\n[${q.n}] ${q.title}  @${q.src}`);
    const r = await ast(token, q.query, q.limit ? { limit: q.limit } : {});
    if (r.status !== 200) { check(`${q.n} executes`, false, r.json?.error); continue; }
    console.log('   ' + planLine(r.json.plan)); printLegs(r.json.plan);
    check(`${q.n} executed at ${q.src}`, legs(r).some(l => l.source === q.src));
    check(`${q.n} returned rows`, rows(r).length > 0, `rows=${rows(r).length}`);
  }

  console.log(`\n════════════════════════════════════════════════\n  ${pass} PASS · ${fail} FAIL\n════════════════════════════════════════════════`);
  process.exit(fail ? 1 : 0);
})();
