/**
 * AST Query Cookbook — every AST feature the fabric supports, as runnable examples.
 * All run through POST /api/analytics/query { queryConfig: { type:'SELECT', schema, limit, query } }.
 * Each prints the resolved plan (strategy + per-leg pushdown trace) so you can see
 * exactly what executed at each source.
 *
 * Sections: projection · filter operators · sort/paginate · aggregates+groupBy ·
 *           multi-source aggregate · joins (cross-source) · set operations.
 *
 * Run (backend up on :4000):  node 06-ast-cookbook.js
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
async function runAst(title, query, limit = 20) {
  console.log(`\n### ${title}`);
  console.log('   AST: ' + JSON.stringify(query));
  const r = await req('POST', '/analytics/query', TOKEN, { queryConfig: { type: 'SELECT', schema: 'public', limit, query } });
  if (r.status !== 200) { console.log('   ERROR:', r.json?.error); return; }
  const p = r.json.plan || {};
  console.log(`   plan: ${p.strategy} · ${p.executionMs}ms · ${p.rowsScannedAcrossSources ?? '-'} rows from sources`);
  for (const l of (p.legs || [])) console.log(`     · ${l.source}[${l.engine}/${l.mode}] ${l.operation} → ${l.rowsReturned} rows :: ${String(l.query).slice(0, 110)}`);
  const rows = r.json.data || [];
  console.log(`   → ${rows.length} rows; sample: ${JSON.stringify(rows[0] || null).slice(0, 160)}`);
}

(async () => {
  const login = await req('POST', '/auth/login', null, { username: 'admin', password: 'admin' });
  TOKEN = login.json?.token;
  if (!TOKEN) { console.log('LOGIN FAILED'); process.exit(1); }
  console.log('AST QUERY COOKBOOK — federated retail fabric');

  console.log('\n══ 1. Projection & column selection ══');
  await runAst('SELECT specific columns', { select: ['id', 'name', 'region'], from: { resource: 'customers', source: 'Retail_Core' } }, 5);
  await runAst('SELECT * (all columns)', { select: ['*'], from: { resource: 'products', source: 'Product_Warehouse' } }, 3);

  console.log('\n══ 2. Filter operators (WHERE) ══');
  await runAst('EQ  — region = EU', { from: { resource: 'customers', source: 'Retail_Core' }, where: [{ column: 'region', operator: 'EQ', value: 'EU' }] }, 3);
  await runAst('NE  — segment != CONSUMER', { from: { resource: 'customers', source: 'Retail_Core' }, where: [{ column: 'segment', operator: 'NE', value: 'CONSUMER' }] }, 3);
  await runAst('GT/LT — total_amount > 4900', { from: { resource: 'orders', source: 'Retail_Core' }, where: [{ column: 'total_amount', operator: 'GT', value: 4900 }] }, 3);
  await runAst('GTE/LTE — 100 <= price <= 105', { from: { resource: 'products', source: 'Product_Warehouse' }, where: [{ column: 'price', operator: 'GTE', value: 100 }, { column: 'price', operator: 'LTE', value: 105 }] }, 3);
  await runAst('LIKE — name LIKE Customer_100%', { from: { resource: 'customers', source: 'Retail_Core' }, where: [{ column: 'name', operator: 'LIKE', value: 'Customer_100%' }] }, 5);
  await runAst('IN — status IN (SHIPPED, DELIVERED)', { from: { resource: 'orders', source: 'Retail_Core' }, where: [{ column: 'status', operator: 'IN', value: ['SHIPPED', 'DELIVERED'] }] }, 3);
  await runAst('Mongo filter — event_type = checkout', { from: { resource: 'web_events', source: 'Web_Analytics' }, where: [{ column: 'event_type', operator: 'EQ', value: 'checkout' }] }, 3);

  console.log('\n══ 3. Sort & paginate ══');
  await runAst('ORDER BY lifetime_value DESC', { select: ['id', 'lifetime_value'], from: { resource: 'customers', source: 'Retail_Core' }, orderBy: [{ column: 'lifetime_value', direction: 'DESC' }] }, 5);
  await runAst('OFFSET (page 2, 5/page)', { select: ['id'], from: { resource: 'customers', source: 'Retail_Core' }, orderBy: [{ column: 'id', direction: 'ASC' }], offset: 5 }, 5);

  console.log('\n══ 4. Aggregates + GROUP BY (pushed to the source) ══');
  await runAst('COUNT by status (Postgres GROUP BY)', { from: { resource: 'orders', source: 'Retail_Core' }, groupBy: ['status'], select: ['status', { aggregate: 'COUNT', column: '*', alias: 'n' }] });
  await runAst('SUM+AVG+MIN+MAX amount by channel', { from: { resource: 'orders', source: 'Retail_Core' }, groupBy: ['channel'], select: ['channel', { aggregate: 'SUM', column: 'total_amount', alias: 'total' }, { aggregate: 'AVG', column: 'total_amount', alias: 'avg' }, { aggregate: 'MIN', column: 'total_amount', alias: 'min' }, { aggregate: 'MAX', column: 'total_amount', alias: 'max' }] });
  await runAst('COUNT by event_type (Mongo $group)', { from: { resource: 'web_events', source: 'Web_Analytics' }, groupBy: ['event_type'], select: ['event_type', { aggregate: 'COUNT', column: '*', alias: 'events' }] });

  console.log('\n══ 5. Multi-source aggregate (partial aggregate merged in-fabric) ══');
  await runAst('Events per customer across Postgres orders + Mongo web_events (UNION of partial COUNTs)', {
    union: [
      { from: { resource: 'orders', source: 'Retail_Core' }, groupBy: ['customer_id'], select: ['customer_id', { aggregate: 'COUNT', column: '*', alias: 'cnt' }], where: [{ column: 'customer_id', operator: 'LT', value: 20 }] },
      { from: { resource: 'web_events', source: 'Web_Analytics' }, groupBy: ['customer_id'], select: ['customer_id', { aggregate: 'COUNT', column: '*', alias: 'cnt' }], where: [{ column: 'customer_id', operator: 'LT', value: 20 }] },
    ],
  });

  console.log('\n══ 6. Joins (cross-source, bind-join pushdown) ══');
  await runAst('INNER: orders(PG) ⋈ web_events(Mongo) for customer 7', {
    select: ['*'], from: { resource: 'orders', source: 'Retail_Core', alias: 'o' },
    joins: [{ type: 'INNER', resource: 'web_events', source: 'Web_Analytics', alias: 'w', on: { left: 'o.customer_id', operator: 'EQ', right: 'w.customer_id' } }],
    where: [{ column: 'o.customer_id', operator: 'EQ', value: 7 }],
  });
  await runAst('INNER cross-DB: orders(retail_core) ⋈ order_items(retail_wh) for order 555', {
    select: ['*'], from: { resource: 'orders', source: 'Retail_Core', alias: 'o' },
    joins: [{ type: 'INNER', resource: 'order_items', source: 'Product_Warehouse', alias: 'i', on: { left: 'o.id', operator: 'EQ', right: 'i.order_id' } }],
    where: [{ column: 'o.id', operator: 'EQ', value: 555 }],
  });

  console.log('\n══ 7. Set operations (cross-engine) ══');
  const legOrders = { select: ['customer_id'], from: { resource: 'orders', source: 'Retail_Core' }, where: [{ column: 'customer_id', operator: 'LT', value: 40 }] };
  const legEvents = { select: ['customer_id'], from: { resource: 'web_events', source: 'Web_Analytics' }, where: [{ column: 'customer_id', operator: 'LT', value: 40 }] };
  await runAst('UNION — customers who ordered OR browsed (ids < 40)', { union: [legOrders, legEvents] }, 60);
  await runAst('INTERSECT — customers who ordered AND browsed', { intersect: [legOrders, legEvents] }, 60);
  await runAst('EXCEPT — ordered but never browsed', { except: [legOrders, legEvents] }, 60);

  console.log('\nDone — AST cookbook complete.');
})();
