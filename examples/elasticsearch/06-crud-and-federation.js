/**
 * Elasticsearch scenarios — CRUD WRITES & CROSS-ENGINE FEDERATION.
 *
 * Shows ES as a full read+write federated source:
 *   • CRUD via /api/data → ES `_bulk` (create), `_update_by_query`, `_delete_by_query`.
 *   • A cross-engine JOIN where an ES index is the driving side and a PostgreSQL
 *     table is the bind-join probe (ES review → Postgres product catalog).
 *
 * The federation scenario pairs with the distributed-retail example: it joins on
 * product_id against Product_Warehouse.products. If that source isn't seeded the
 * join simply returns no matches (noted at runtime).
 *
 * Run:  node 06-crud-and-federation.js
 */
const { login, ast, data, banner, show } = require('./_lib');
const SRC = 'Reviews_ES';

/**
 * C1–C4 — Full CRUD lifecycle on the ES index via the simple /api/data endpoints.
 * create → fetch → update → delete → confirm gone. All writes hit ES natively.
 * @param {string} token
 */
async function crudLifecycle(token) {
  console.log('\n━━ CRUD lifecycle on product_reviews (Elasticsearch)');
  const doc = { _id: '990001', review_id: 990001, product_id: 7, account_id: 1, brand: 'Acme Inc',
    brand_key: 'Acme', category: 'ELECTRONICS', region: 'NA', rating: 2, sentiment: 0.2, verified: true,
    body: 'stopped working — requesting a refund.', created_at: new Date().toISOString() };

  const c = await data(token, 'create', { source: SRC, resource: 'product_reviews', data: doc });
  console.log(`   create → ${c.json.status} (insertedCount=${c.json.insertedCount})   [${(c.json.plan?.legs||[])[0]?.query || ''}]`);

  const f = await data(token, 'fetch', { source: SRC, resource: 'product_reviews', where: { review_id: 990001 } });
  console.log(`   fetch  → ${f.json.rowCount} row`);

  const u = await data(token, 'update', { source: SRC, resource: 'product_reviews', where: { review_id: 990001 }, data: { rating: 5, sentiment: 0.9 } });
  console.log(`   update → ${u.json.status} (modifiedCount=${u.json.modifiedCount})`);

  const d = await data(token, 'delete', { source: SRC, resource: 'product_reviews', where: { review_id: 990001 } });
  console.log(`   delete → ${d.json.status} (deletedCount=${d.json.deletedCount})`);

  const g = await data(token, 'fetch', { source: SRC, resource: 'product_reviews', where: { review_id: 990001 } });
  console.log(`   verify gone → ${g.json.rowCount} rows`);
}

/**
 * F1 — Cross-engine JOIN: Elasticsearch reviews ⋈ PostgreSQL products.
 * The ES index is the DRIVING side (filtered to a few low-rating reviews); the
 * fabric collects the product_id keys and pushes `id IN (...)` as a bind-join to
 * the Postgres Product_Warehouse.products table — so each engine does only its
 * part and the fabric merges. The trace shows both legs.
 * @param {string} token
 */
async function federatedJoin(token) {
  const { rows, plan } = await ast(token, {
    select: ['*'],
    from: { resource: 'product_reviews', source: SRC, alias: 'r' },
    joins: [{ type: 'INNER', resource: 'products', source: 'Product_Warehouse', alias: 'p',
              on: { left: 'r.product_id', operator: 'EQ', right: 'p.id' } }],
    where: [{ column: 'r.rating', operator: 'EQ', value: 1 }, { column: 'r.region', operator: 'EQ', value: 'EU' }],
  }, 20);
  banner('F1 cross-engine JOIN: reviews(ES) ⋈ products(Postgres) on product_id', plan);
  console.log(`   strategy=${plan.strategy}  legs:`);
  for (const l of plan.legs || []) console.log(`     · ${l.source}[${l.engine}/${l.mode}] ${l.operation} → ${l.rowsReturned} rows`);
  console.log(`   merged ${rows.length} enriched review(s):`);
  show(rows.map(r => ({ review: r['r.review_id'], brand: r['r.brand_key'], rating: r['r.rating'], product: r['p.name'], category: r['p.category'] })), 5);
  if (!rows.length) console.log('   (0 matches — ensure examples/distributed-retail is seeded so Product_Warehouse.products exists)');
}

(async () => {
  const token = await login();
  console.log('ELASTICSEARCH — CRUD & CROSS-ENGINE FEDERATION');
  await crudLifecycle(token);
  await federatedJoin(token);
  console.log('\nDone — CRUD & federation scenarios.');
})().catch((e) => { console.error('FAILED:', e.message || e); process.exit(1); });
