/**
 * REAL-WORLD ADVANCED ANALYTICS EXAMPLES — paired AST + SQL.
 * ==========================================================
 * Hand-crafted business questions (not generated), each expressed BOTH as the
 * fabric's engine-agnostic AST and as the equivalent SQL, over a realistic
 * retail star schema spread across THREE engines:
 *
 *   orders     @ PG_DSN_Source (Postgres)  order_id, customer_id, product_id, qty, amount, order_month, status  (100 rows)
 *   customers  @ Local_Mongo   (MongoDB)   customer_id, name, region, signup_month                              (20 rows)
 *   products   @ Local_MySQL   (MySQL)      product_id, category, price                                          (10 rows)
 *
 * Patterns are drawn from real BI use cases (see README "Sources"): revenue
 * trend, top-N, running rank, RFM, cohort revenue, category share, AOV, market
 * basket, retention set-ops, median, HAVING, window ROW_NUMBER/RANK.
 *
 * Each example runs its AST via POST /api/analytics/query (federated planner),
 * and — for single-source examples — ALSO runs its SQL via POST /api/queries/exec
 * (SQL runs natively at the source, or is translated to Mongo). Both results are
 * checked against a JS oracle computed from the same seed data.
 *
 * Run:  cd backend && NODE_PATH=./node_modules node ../bulk-test/examples_ast_sql.js
 */
const http = require('http');
const O = require('./oracle');
const { N, read, groupAgg, SOURCES: S } = O;

// ---- seed data mirrored for the oracle ----
const orders = [], customers = [], products = [];
for (let o = 1; o <= 100; o++) { const product_id = ((o - 1) % 10) + 1, qty = ((o - 1) % 3) + 1, price = product_id * 10; orders.push({ order_id: o, customer_id: ((o - 1) % 20) + 1, product_id, qty, amount: price * qty, order_month: ((o - 1) % 6) + 1, status: o % 7 === 0 ? 'CANCELLED' : 'COMPLETED' }); }
for (let c = 1; c <= 20; c++) customers.push({ customer_id: c, name: 'Cust ' + c, region: c % 2 === 1 ? 'EAST' : 'WEST', signup_month: ((c - 1) % 6) + 1 });
for (let p = 1; p <= 10; p++) products.push({ product_id: p, category: ['Electronics', 'Home', 'Toys'][(p - 1) % 3], price: p * 10 });
const webviews = [];
for (let c = 1; c <= 20; c++) webviews.push({ customer_id: c, channel: ['web', 'mobile', 'store'][(c - 1) % 3], views: c * 2 });
const chanOf = Object.fromEntries(webviews.map((w) => [w.customer_id, w.channel]));
const custOf = Object.fromEntries(customers.map((c) => [c.customer_id, c]));
const prodOf = Object.fromEntries(products.map((p) => [p.product_id, p]));
const completed = orders.filter((o) => o.status === 'COMPLETED');
const oc = (rows) => rows.map((o) => ({ ...o, ...custOf[o.customer_id] }));       // ⋈ customers
const op = (rows) => rows.map((o) => ({ ...o, category: prodOf[o.product_id].category, price: prodOf[o.product_id].price })); // ⋈ products

const gkey = (data, k) => new Map(data.map((r) => [String(read(r, k)), r]));
const checkGroup = (data, k, oracle, alias) => { const m = gkey(data, k); if (m.size !== oracle.length) return false; return oracle.every((o) => { const r = m.get(String(o.key)); return r && Math.abs(N(read(r, alias)) - o[alias]) < 1e-6; }); };
const seq = (a, b) => a.length === b.length && a.every((x, i) => `${x}` === `${b[i]}`);
const setEq = (a, b) => { const s = [...a].sort(), t = [...b].sort(); return s.length === t.length && s.every((x, i) => `${x}` === `${t[i]}`); };

function callSql(source, sql) {
  const body = JSON.stringify({ source, sql });
  const jwt = require('jsonwebtoken');
  const tok = jwt.sign({ role: 'fabric_user', internal_role: 'ADMIN', tenant_id: 'tenant_advanced_test', username: 'ex', iss: 'zero-data-fabric' }, 'reallyreallyreallyreallyverysecret', { expiresIn: '2h' });
  return new Promise((resolve) => {
    const req = http.request({ host: 'localhost', port: 4000, path: '/api/queries/exec', method: 'POST', headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body), Authorization: 'Bearer ' + tok } },
      (res) => { let b = ''; res.on('data', (c) => (b += c)); res.on('end', () => { try { resolve(JSON.parse(b)); } catch { resolve({ error: b.slice(0, 140) }); } }); });
    req.on('error', (e) => resolve({ error: e.message })); req.write(body); req.end();
  });
}
const sqlData = (r) => (Array.isArray(r?.data) ? r.data : Array.isArray(r?.rows) ? r.rows : Array.isArray(r) ? r : null);

// ============ THE EXAMPLES ============
const T = (res, src, alias) => ({ resource: res, source: src, alias });
const EX = [];
const add = (e) => EX.push(e);

// 1. Monthly revenue trend (completed) — Postgres, co-located
add({ n: 1, title: 'Monthly revenue trend (completed orders)', engines: 'PG', sqlOn: S.PG,
  sql: `SELECT order_month, SUM(amount) AS revenue FROM public.orders WHERE status='COMPLETED' GROUP BY order_month ORDER BY order_month`,
  ast: { from: T('orders', S.PG), select: ['order_month', { aggregate: 'SUM', column: 'amount', alias: 'revenue' }], where: [{ column: 'status', operator: 'EQ', value: 'COMPLETED' }], groupBy: ['order_month'], orderBy: [{ column: 'order_month', direction: 'ASC' }] },
  check: (d) => checkGroup(d, 'order_month', groupAgg(completed, 'order_month', [{ fn: 'SUM', col: 'amount', alias: 'revenue' }]), 'revenue') });

// 2. Top-5 highest-value orders — Postgres, ORDER+LIMIT (tie-broken by id)
add({ n: 2, title: 'Top 5 highest-value orders', engines: 'PG', sqlOn: S.PG,
  sql: `SELECT order_id, amount FROM public.orders ORDER BY amount DESC, order_id ASC LIMIT 5`,
  ast: { from: T('orders', S.PG), select: ['order_id', 'amount'], where: [{ column: 'order_id', operator: 'GT', value: 0 }], orderBy: [{ column: 'amount', direction: 'DESC' }, { column: 'order_id', direction: 'ASC' }], limit: 5 },
  check: (d) => seq(d.map((r) => N(r.order_id)), [...orders].sort((a, b) => b.amount - a.amount || a.order_id - b.order_id).slice(0, 5).map((r) => r.order_id)) });

// 3. Window: global ranking of orders by amount (ROW_NUMBER) — capability compensation
add({ n: 3, title: 'Rank all orders by amount (ROW_NUMBER window)', engines: 'PG', win: true,
  sql: `SELECT order_id, amount, ROW_NUMBER() OVER (ORDER BY amount DESC) AS rnk FROM public.orders`,
  ast: { from: T('orders', S.PG), select: ['order_id', 'amount', { window: 'ROW_NUMBER', orderBy: [{ column: 'amount', direction: 'DESC' }], alias: 'rnk' }], where: [{ column: 'order_id', operator: 'GT', value: 0 }], limit: 200 },
  check: (d) => { const rr = d.map((r) => N(read(r, 'rnk'))).sort((a, b) => a - b); return seq(rr, orders.map((_, i) => i + 1)) && N(read(d.find((r) => N(read(r, 'rnk')) === 1), 'amount')) === 300; } });

// 4. Window: RANK products' orders within each product (PARTITION BY) — filter one product
add({ n: 4, title: 'RANK orders within product #10 by amount (PARTITION BY)', engines: 'PG', win: true,
  sql: `SELECT order_id, amount, RANK() OVER (PARTITION BY product_id ORDER BY amount DESC) AS rnk FROM public.orders WHERE product_id=10`,
  ast: { from: T('orders', S.PG), select: ['order_id', 'amount', { window: 'RANK', partitionBy: ['product_id'], orderBy: [{ column: 'amount', direction: 'DESC' }], alias: 'rnk' }], where: [{ column: 'product_id', operator: 'EQ', value: 10 }], limit: 50 },
  check: (d) => d.length === 10 && d.every((r) => { const a = N(read(r, 'amount')), rk = N(read(r, 'rnk')); return (a === 300 && rk === 1) || (a === 200 && rk === 4) || (a === 100 && rk === 7); }) });

// 5. Median order amount (PERCENTILE_CONT 0.5) — Postgres
add({ n: 5, title: 'Median order amount (percentile_cont 0.5)', engines: 'PG', sqlOn: S.PG,
  sql: `SELECT percentile_cont(0.5) WITHIN GROUP (ORDER BY amount) AS median FROM public.orders`,
  ast: { from: T('orders', S.PG), select: [{ aggregate: 'PERCENTILE', column: 'amount', percent: 50, alias: 'median' }] },
  check: (d) => { const a = [...orders.map((o) => o.amount)].sort((x, y) => x - y); const mid = (a[49] + a[50]) / 2; return d.length === 1 && Math.abs(N(read(d[0], 'median')) - mid) < 1e-6; } });

// 6. CTE: high-value orders, then monthly count — Postgres co-located CTE
add({ n: 6, title: 'CTE — monthly count of high-value (amount>=200) orders', engines: 'PG',
  sql: `WITH hv AS (SELECT order_id, order_month FROM public.orders WHERE amount>=200) SELECT order_month, COUNT(*) AS n FROM hv GROUP BY order_month ORDER BY order_month`,
  ast: { with: [{ name: 'hv', columns: ['order_id', 'order_month'], base: { from: T('orders', S.PG), select: ['order_id', 'order_month'], where: [{ column: 'amount', operator: 'GTE', value: 200 }] } }], from: { resource: 'hv' }, select: ['order_month', { aggregate: 'COUNT', column: '*', alias: 'n' }], groupBy: ['order_month'], orderBy: [{ column: 'order_month', direction: 'ASC' }] },
  check: (d) => checkGroup(d, 'order_month', groupAgg(orders.filter((o) => o.amount >= 200), 'order_month', [{ fn: 'COUNT', col: 'order_id', alias: 'n' }]), 'n') });

// 7. Non-equi join: count (order, product) pairs where the order exceeds a product's base price
//    — cross-engine PG×MySQL, exercises the nested-loop (non-equijoin) path. NOTE: the AST `on`
//    holds ONE predicate, so compound/inequality joins on two columns use a single operator here.
add({ n: 7, title: 'Non-equi join — orders exceeding a product base price', engines: 'PG×MySQL', cross: true,
  sql: `SELECT COUNT(*) AS n FROM orders o JOIN products p ON o.amount > p.price`,
  ast: { from: T('orders', S.PG, 'o'), joins: [{ type: 'INNER', resource: 'products', source: S.MYSQL, alias: 'p', on: { left: 'o.amount', operator: 'GT', right: 'p.price' } }], select: [{ aggregate: 'COUNT', column: '*', alias: 'n' }], where: [{ column: 'o.order_id', operator: 'GT', value: 0 }] },
  check: (d) => { let c = 0; for (const o of orders) for (const p of products) if (o.amount > p.price) c++; return N(read(d[0], 'n')) === c; } });

// 8. Distinct active customers (completed) — Postgres DISTINCT
add({ n: 8, title: 'Distinct active customers (completed orders)', engines: 'PG',
  sql: `SELECT DISTINCT customer_id FROM public.orders WHERE status='COMPLETED' ORDER BY customer_id`,
  ast: { from: T('orders', S.PG), select: ['customer_id'], distinct: true, where: [{ column: 'status', operator: 'EQ', value: 'COMPLETED' }], orderBy: [{ column: 'customer_id', direction: 'ASC' }], limit: 100 },
  check: (d) => setEq(d.map((r) => N(r.customer_id)), [...new Set(completed.map((o) => o.customer_id))]) });

// 9. Customers per region — Mongo single-source aggregate
add({ n: 9, title: 'Customers per region', engines: 'Mongo', sqlOn: S.MONGO,
  sql: `SELECT region, COUNT(*) AS n FROM customers GROUP BY region`,
  ast: { from: T('customers', S.MONGO), select: ['region', { aggregate: 'COUNT', column: '*', alias: 'n' }], groupBy: ['region'], orderBy: [{ column: 'region', direction: 'ASC' }] },
  check: (d) => checkGroup(d, 'region', groupAgg(customers, 'region', [{ fn: 'COUNT', col: 'customer_id', alias: 'n' }]), 'n') });

// 10. Products per category + avg price — MySQL single-source aggregate
add({ n: 10, title: 'Products per category with avg price', engines: 'MySQL', sqlOn: S.MYSQL,
  sql: `SELECT category, COUNT(*) AS n, AVG(price) AS avg_price FROM products GROUP BY category ORDER BY category`,
  ast: { from: T('products', S.MYSQL), select: ['category', { aggregate: 'COUNT', column: '*', alias: 'n' }, { aggregate: 'AVG', column: 'price', alias: 'avg_price' }], groupBy: ['category'], orderBy: [{ column: 'category', direction: 'ASC' }] },
  check: (d) => checkGroup(d, 'category', groupAgg(products, 'category', [{ fn: 'COUNT', col: 'product_id', alias: 'n' }]), 'n') && checkGroup(d, 'category', groupAgg(products, 'category', [{ fn: 'AVG', col: 'price', alias: 'avg_price' }]), 'avg_price') });

// 11. Revenue by product category — PG × MySQL cross-engine
add({ n: 11, title: 'Revenue by product category', engines: 'PG×MySQL', cross: true,
  sql: `SELECT p.category, SUM(o.amount) AS revenue FROM orders o JOIN products p ON o.product_id=p.product_id WHERE o.status='COMPLETED' GROUP BY p.category ORDER BY p.category`,
  ast: { from: T('orders', S.PG, 'o'), joins: [{ type: 'INNER', resource: 'products', source: S.MYSQL, alias: 'p', on: { left: 'o.product_id', operator: 'EQ', right: 'p.product_id' } }], select: ['p.category', { aggregate: 'SUM', column: 'o.amount', alias: 'revenue' }], where: [{ column: 'o.status', operator: 'EQ', value: 'COMPLETED' }], groupBy: ['p.category'], orderBy: [{ column: 'p.category', direction: 'ASC' }] },
  check: (d) => checkGroup(d, 'p.category', groupAgg(op(completed), 'category', [{ fn: 'SUM', col: 'amount', alias: 'revenue' }]), 'revenue') });

// 12. Top 5 customers by revenue — PG × Mongo cross-engine
add({ n: 12, title: 'Top 5 customers by revenue', engines: 'PG×Mongo', cross: true,
  sql: `SELECT c.customer_id, SUM(o.amount) AS revenue FROM orders o JOIN customers c ON o.customer_id=c.customer_id WHERE o.status='COMPLETED' GROUP BY c.customer_id ORDER BY revenue DESC LIMIT 5`,
  ast: { from: T('orders', S.PG, 'o'), joins: [{ type: 'INNER', resource: 'customers', source: S.MONGO, alias: 'c', on: { left: 'o.customer_id', operator: 'EQ', right: 'c.customer_id' } }], select: ['c.customer_id', { aggregate: 'SUM', column: 'o.amount', alias: 'revenue' }], where: [{ column: 'o.status', operator: 'EQ', value: 'COMPLETED' }], groupBy: ['c.customer_id'], orderBy: [{ column: 'revenue', direction: 'DESC' }], limit: 5 },
  check: (d) => { const top = groupAgg(completed, 'customer_id', [{ fn: 'SUM', col: 'amount', alias: 'revenue' }]).sort((a, b) => b.revenue - a.revenue).slice(0, 5).map((g) => g.revenue); return seq(d.map((r) => N(read(r, 'revenue'))), top); } });

// 13. Average order value by region — PG × Mongo
add({ n: 13, title: 'Average order value (AOV) by region', engines: 'PG×Mongo', cross: true,
  sql: `SELECT c.region, AVG(o.amount) AS aov FROM orders o JOIN customers c ON o.customer_id=c.customer_id GROUP BY c.region ORDER BY c.region`,
  ast: { from: T('orders', S.PG, 'o'), joins: [{ type: 'INNER', resource: 'customers', source: S.MONGO, alias: 'c', on: { left: 'o.customer_id', operator: 'EQ', right: 'c.customer_id' } }], select: ['c.region', { aggregate: 'AVG', column: 'o.amount', alias: 'aov' }], where: [{ column: 'o.order_id', operator: 'GT', value: 0 }], groupBy: ['c.region'], orderBy: [{ column: 'c.region', direction: 'ASC' }] },
  check: (d) => checkGroup(d, 'c.region', groupAgg(oc(orders), 'region', [{ fn: 'AVG', col: 'amount', alias: 'aov' }]), 'aov') });

// 14. RFM per customer (Recency, Frequency, Monetary) — PG × Mongo multi-aggregate
add({ n: 14, title: 'RFM per customer (recency/frequency/monetary)', engines: 'PG×Mongo', cross: true,
  sql: `SELECT c.customer_id, MAX(o.order_month) AS recency, COUNT(*) AS frequency, SUM(o.amount) AS monetary FROM orders o JOIN customers c ON o.customer_id=c.customer_id WHERE o.status='COMPLETED' GROUP BY c.customer_id`,
  ast: { from: T('orders', S.PG, 'o'), joins: [{ type: 'INNER', resource: 'customers', source: S.MONGO, alias: 'c', on: { left: 'o.customer_id', operator: 'EQ', right: 'c.customer_id' } }], select: ['c.customer_id', { aggregate: 'MAX', column: 'o.order_month', alias: 'recency' }, { aggregate: 'COUNT', column: '*', alias: 'frequency' }, { aggregate: 'SUM', column: 'o.amount', alias: 'monetary' }], where: [{ column: 'o.status', operator: 'EQ', value: 'COMPLETED' }], groupBy: ['c.customer_id'], orderBy: [{ column: 'c.customer_id', direction: 'ASC' }] },
  check: (d) => { const orc = groupAgg(completed, 'customer_id', [{ fn: 'MAX', col: 'order_month', alias: 'recency' }, { fn: 'COUNT', col: 'order_id', alias: 'frequency' }, { fn: 'SUM', col: 'amount', alias: 'monetary' }]); return checkGroup(d, 'c.customer_id', orc, 'recency') && checkGroup(d, 'c.customer_id', orc, 'frequency') && checkGroup(d, 'c.customer_id', orc, 'monetary'); } });

// 15. Category revenue by region — 3-way PG × MySQL × Mongo, multi-key group
add({ n: 15, title: 'Category revenue by region (3-way join)', engines: 'PG×MySQL×Mongo', cross: true,
  sql: `SELECT p.category, c.region, SUM(o.amount) AS revenue FROM orders o JOIN products p ON o.product_id=p.product_id JOIN customers c ON o.customer_id=c.customer_id WHERE o.status='COMPLETED' GROUP BY p.category, c.region ORDER BY p.category, c.region`,
  ast: { from: T('orders', S.PG, 'o'), joins: [{ type: 'INNER', resource: 'products', source: S.MYSQL, alias: 'p', on: { left: 'o.product_id', operator: 'EQ', right: 'p.product_id' } }, { type: 'INNER', resource: 'customers', source: S.MONGO, alias: 'c', on: { left: 'o.customer_id', operator: 'EQ', right: 'c.customer_id' } }], select: ['p.category', 'c.region', { aggregate: 'SUM', column: 'o.amount', alias: 'revenue' }], where: [{ column: 'o.status', operator: 'EQ', value: 'COMPLETED' }], groupBy: ['p.category', 'c.region'], orderBy: [{ column: 'p.category', direction: 'ASC' }, { column: 'c.region', direction: 'ASC' }] },
  check: (d) => { const rows = completed.map((o) => ({ ...o, category: prodOf[o.product_id].category, region: custOf[o.customer_id].region })); const key = (r) => r.category + '|' + r.region; const m = new Map(); for (const r of rows) m.set(key(r), (m.get(key(r)) || 0) + r.amount); if (d.length !== m.size) return false; return d.every((r) => m.get(read(r, 'p.category') + '|' + read(r, 'c.region')) === N(read(r, 'revenue'))); } });

// 16. Customers with more than 5 completed orders — PG × Mongo HAVING
add({ n: 16, title: 'Customers with > 5 completed orders (HAVING)', engines: 'PG×Mongo', cross: true,
  sql: `SELECT c.customer_id, COUNT(*) AS n FROM orders o JOIN customers c ON o.customer_id=c.customer_id WHERE o.status='COMPLETED' GROUP BY c.customer_id HAVING COUNT(*) > 5 ORDER BY c.customer_id`,
  ast: { from: T('orders', S.PG, 'o'), joins: [{ type: 'INNER', resource: 'customers', source: S.MONGO, alias: 'c', on: { left: 'o.customer_id', operator: 'EQ', right: 'c.customer_id' } }], select: ['c.customer_id', { aggregate: 'COUNT', column: '*', alias: 'n' }], where: [{ column: 'o.status', operator: 'EQ', value: 'COMPLETED' }], groupBy: ['c.customer_id'], having: [{ column: 'n', operator: 'GT', value: 5 }], orderBy: [{ column: 'c.customer_id', direction: 'ASC' }] },
  check: (d) => { const exp = groupAgg(completed, 'customer_id', [{ fn: 'COUNT', col: 'order_id', alias: 'n' }]).filter((g) => g.n > 5).map((g) => g.key); return setEq(d.map((r) => `${N(read(r, 'c.customer_id'))}`), exp); } });

// 17. Cohort revenue by signup month — PG × Mongo
add({ n: 17, title: 'Cohort revenue by customer signup month', engines: 'PG×Mongo', cross: true,
  sql: `SELECT c.signup_month, SUM(o.amount) AS revenue FROM orders o JOIN customers c ON o.customer_id=c.customer_id WHERE o.status='COMPLETED' GROUP BY c.signup_month ORDER BY c.signup_month`,
  ast: { from: T('orders', S.PG, 'o'), joins: [{ type: 'INNER', resource: 'customers', source: S.MONGO, alias: 'c', on: { left: 'o.customer_id', operator: 'EQ', right: 'c.customer_id' } }], select: ['c.signup_month', { aggregate: 'SUM', column: 'o.amount', alias: 'revenue' }], where: [{ column: 'o.status', operator: 'EQ', value: 'COMPLETED' }], groupBy: ['c.signup_month'], orderBy: [{ column: 'c.signup_month', direction: 'ASC' }] },
  check: (d) => { const rows = completed.map((o) => ({ ...o, signup_month: custOf[o.customer_id].signup_month })); return checkGroup(d, 'c.signup_month', groupAgg(rows, 'signup_month', [{ fn: 'SUM', col: 'amount', alias: 'revenue' }]), 'revenue'); } });

// 18. Retention set-op: EAST customers who placed a completed order — PG ∩ Mongo
add({ n: 18, title: 'EAST-region customers who ordered (INTERSECT, cross-engine)', engines: 'PG∩Mongo', cross: true,
  sql: `(SELECT customer_id FROM orders WHERE status='COMPLETED') INTERSECT (SELECT customer_id FROM customers WHERE region='EAST')`,
  ast: { intersect: [{ from: T('orders', S.PG), select: ['customer_id'], where: [{ column: 'status', operator: 'EQ', value: 'COMPLETED' }] }, { from: T('customers', S.MONGO), select: ['customer_id'], where: [{ column: 'region', operator: 'EQ', value: 'EAST' }] }], limit: 100 },
  check: (d) => { const A = new Set(completed.map((o) => o.customer_id)); const exp = customers.filter((c) => c.region === 'EAST' && A.has(c.customer_id)).map((c) => c.customer_id); return setEq(d.map((r) => N(r.customer_id)), exp); } });

// 19. Web views by channel — Elasticsearch single-source aggregate
add({ n: 19, title: 'Web views by channel', engines: 'ES',
  sql: `SELECT channel, SUM(views) AS v FROM webviews GROUP BY channel`,
  ast: { from: T('webviews', S.ES), select: ['channel', { aggregate: 'SUM', column: 'views', alias: 'v' }], groupBy: ['channel'], orderBy: [{ column: 'channel', direction: 'ASC' }] },
  check: (d) => checkGroup(d, 'channel', groupAgg(webviews, 'channel', [{ fn: 'SUM', col: 'views', alias: 'v' }]), 'v') });

// 20. Revenue by acquisition channel — PG × Elasticsearch cross-engine
add({ n: 20, title: 'Revenue by acquisition channel (orders × ES web views)', engines: 'PG×ES', cross: true,
  sql: `SELECT w.channel, SUM(o.amount) AS revenue FROM orders o JOIN webviews w ON o.customer_id=w.customer_id WHERE o.status='COMPLETED' GROUP BY w.channel ORDER BY w.channel`,
  ast: { from: T('orders', S.PG, 'o'), joins: [{ type: 'INNER', resource: 'webviews', source: S.ES, alias: 'w', on: { left: 'o.customer_id', operator: 'EQ', right: 'w.customer_id' } }], select: ['w.channel', { aggregate: 'SUM', column: 'o.amount', alias: 'revenue' }], where: [{ column: 'o.status', operator: 'EQ', value: 'COMPLETED' }], groupBy: ['w.channel'], orderBy: [{ column: 'w.channel', direction: 'ASC' }] },
  check: (d) => { const rows = completed.map((o) => ({ ...o, channel: chanOf[o.customer_id] })); return checkGroup(d, 'w.channel', groupAgg(rows, 'channel', [{ fn: 'SUM', col: 'amount', alias: 'revenue' }]), 'revenue'); } });

// 21. CTE + filter-on-aggregate — months with completed revenue > 500 (Postgres co-located)
//     (the canonical "can't filter a GROUP BY result in WHERE → use a CTE" pattern)
add({ n: 21, title: 'Months with revenue > 500 (CTE + filter on aggregate)', engines: 'PG',
  sql: `WITH monthly AS (SELECT order_month, SUM(amount) AS rev FROM public.orders WHERE status='COMPLETED' GROUP BY order_month) SELECT order_month, rev FROM monthly WHERE rev > 500 ORDER BY order_month`,
  ast: { with: [{ name: 'monthly', columns: ['order_month', 'rev'], base: { from: T('orders', S.PG), select: ['order_month', { aggregate: 'SUM', column: 'amount', alias: 'rev' }], where: [{ column: 'status', operator: 'EQ', value: 'COMPLETED' }], groupBy: ['order_month'] } }], from: { resource: 'monthly' }, select: ['order_month', 'rev'], where: [{ column: 'rev', operator: 'GT', value: 500 }], orderBy: [{ column: 'order_month', direction: 'ASC' }] },
  check: (d) => { const exp = groupAgg(completed, 'order_month', [{ fn: 'SUM', col: 'amount', alias: 'rev' }]).filter((g) => g.rev > 500).sort((a, b) => a.key - b.key); return seq(d.map((r) => `${N(read(r, 'order_month'))}:${N(read(r, 'rev'))}`), exp.map((g) => `${g.key}:${g.rev}`)); } });

// 22. CTE + COUNT_DISTINCT — distinct customers & products among completed orders (Postgres)
add({ n: 22, title: 'Distinct customers & products (CTE + COUNT DISTINCT)', engines: 'PG',
  sql: `WITH t AS (SELECT customer_id, product_id FROM public.orders WHERE status='COMPLETED') SELECT COUNT(DISTINCT customer_id) AS custs, COUNT(DISTINCT product_id) AS prods FROM t`,
  ast: { with: [{ name: 't', columns: ['customer_id', 'product_id'], base: { from: T('orders', S.PG), select: ['customer_id', 'product_id'], where: [{ column: 'status', operator: 'EQ', value: 'COMPLETED' }] } }], from: { resource: 't' }, select: [{ aggregate: 'COUNT_DISTINCT', column: 'customer_id', alias: 'custs' }, { aggregate: 'COUNT_DISTINCT', column: 'product_id', alias: 'prods' }] },
  check: (d) => N(read(d[0], 'custs')) === new Set(completed.map((o) => o.customer_id)).size && N(read(d[0], 'prods')) === new Set(completed.map((o) => o.product_id)).size });

// 23. Nested CTE chain — monthly count of high-value orders (Postgres co-located)
add({ n: 23, title: 'Nested CTE chain — monthly count of high-value orders', engines: 'PG',
  sql: `WITH hv AS (SELECT customer_id, order_month FROM public.orders WHERE amount>=200), m AS (SELECT order_month, COUNT(*) AS n FROM hv GROUP BY order_month) SELECT order_month, n FROM m ORDER BY order_month LIMIT 12`,
  ast: { with: [{ name: 'hv', columns: ['customer_id', 'order_month'], base: { from: T('orders', S.PG), select: ['customer_id', 'order_month'], where: [{ column: 'amount', operator: 'GTE', value: 200 }] } }, { name: 'm', columns: ['order_month', 'n'], base: { from: { resource: 'hv' }, select: ['order_month', { aggregate: 'COUNT', column: '*', alias: 'n' }], groupBy: ['order_month'] } }], from: { resource: 'm' }, select: ['order_month', 'n'], orderBy: [{ column: 'order_month', direction: 'ASC' }], limit: 12 },
  check: (d) => { const exp = groupAgg(orders.filter((o) => o.amount >= 200), 'order_month', [{ fn: 'COUNT', col: 'order_id', alias: 'n' }]).sort((a, b) => a.key - b.key); return seq(d.map((r) => `${N(read(r, 'order_month'))}:${N(read(r, 'n'))}`), exp.map((g) => `${g.key}:${g.n}`)); } });

module.exports = { EX };

// ---- runner ----
if (require.main === module) {
  (async () => {
    console.log('#  TITLE'.padEnd(52), 'ENGINES'.padEnd(16), 'STRATEGY'.padEnd(18), 'AST', ' SQL  LEGS');
    console.log('-'.repeat(140));
    let astPass = 0, sqlPass = 0, sqlRun = 0, fail = 0;
    for (const e of EX) {
      const res = await O.call(e.ast);
      const p = res.plan || {};
      const astOk = !res.error && (() => { try { return e.check(res.data || []); } catch { return false; } })();
      let sqlMark = ' - ';
      if (e.sqlOn) {
        sqlRun++;
        const sres = await callSql(e.sqlOn, e.sql);
        const sdata = sqlData(sres);
        const sqlOk = sdata && (() => { try { return e.check(sdata); } catch { return false; } })();
        sqlMark = sqlOk ? 'PASS' : 'FAIL';
        if (sqlOk) sqlPass++;
      }
      if (astOk) astPass++; else fail++;
      const legs = (p.legs || []).map((l) => `${String(l.source).replace('_DSN_Source', '').replace('Local_', '')}:${l.operation}`).join('+');
      console.log(`${String(e.n).padStart(2)} ${e.title}`.padEnd(52), String(e.engines).padEnd(16), String(p.strategy || (res.error ? 'ERR' : '-')).padEnd(18), astOk ? 'PASS' : 'FAIL', ` ${sqlMark}  ${legs}`);
      if (!astOk) console.log('     AST err/data:', res.error || JSON.stringify((res.data || []).slice(0, 3)));
    }
    console.log('-'.repeat(140));
    console.log(`AST: ${astPass}/${EX.length} pass    SQL: ${sqlPass}/${sqlRun} pass (single-source examples)`);
  })();
}
