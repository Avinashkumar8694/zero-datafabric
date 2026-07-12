/**
 * Elasticsearch scenarios — AGGREGATIONS (AST mode).
 *
 * ES aggregations pushed down from the fabric AST: terms buckets, metric
 * sub-aggregations (count/sum/avg/min/max/cardinality), percentiles, multi-level
 * (nested) grouping, and date_histogram time-series. Each returns *groups*, not
 * documents — computed in the ES cluster, not in the fabric.
 *
 * Run:  node 04-aggregations.js
 */
const { login, ast, banner, show } = require('./_lib');
const from = { resource: 'product_reviews', source: 'Reviews_ES' };

/**
 * A1 — Terms bucket + metric: average rating and review count per category.
 * @param {string} token
 */
async function a1_avgByCategory(token) {
  const { rows, plan } = await ast(token, {
    from, groupBy: ['category'],
    select: ['category',
      { aggregate: 'COUNT', column: '*', alias: 'reviews' },
      { aggregate: 'AVG', column: 'rating', alias: 'avg_rating' }],
  }, 20);
  banner('A1 avg rating + count by category (terms + metrics)', plan);
  show(rows, 10);
}

/**
 * A2 — Multiple metrics per bucket: count, avg sentiment, min/max rating by region.
 * @param {string} token
 */
async function a2_multiMetric(token) {
  const { rows, plan } = await ast(token, {
    from, groupBy: ['region'],
    select: ['region',
      { aggregate: 'COUNT', column: '*', alias: 'n' },
      { aggregate: 'AVG', column: 'sentiment', alias: 'avg_sentiment' },
      { aggregate: 'MIN', column: 'rating', alias: 'min_rating' },
      { aggregate: 'MAX', column: 'rating', alias: 'max_rating' }],
  }, 20);
  banner('A2 count + avg sentiment + min/max rating by region', plan);
  show(rows, 6);
}

/**
 * A3 — Percentiles: the p50 and p90 rating per category (ES `percentiles` agg).
 * @param {string} token
 */
async function a3_percentiles(token) {
  const p50 = await ast(token, {
    from, groupBy: ['category'],
    select: ['category', { aggregate: 'PERCENTILE', column: 'rating', percent: 50, alias: 'p50_rating' }],
  }, 20);
  banner('A3 p50 rating by category (PERCENTILE agg)', p50.plan);
  show(p50.rows, 10);
}

/**
 * A4 — Date histogram: reviews per week (ES `date_histogram`, calendar_interval=week).
 * @param {string} token
 */
async function a4_dateHistogram(token) {
  const { rows, plan } = await ast(token, {
    from, groupBy: [{ field: 'created_at', dateInterval: 'week' }],
    select: [{ aggregate: 'COUNT', column: '*', alias: 'reviews' }],
  }, 30);
  banner('A4 reviews per week (date_histogram)', plan);
  show(rows, 6);
}

/**
 * A5 — Multi-level (nested) grouping: category → region review counts.
 * The fabric nests two `terms` aggregations and flattens the buckets to rows.
 * @param {string} token
 */
async function a5_nestedGrouping(token) {
  const { rows, plan } = await ast(token, {
    from, groupBy: ['category', 'region'],
    select: ['category', 'region', { aggregate: 'COUNT', column: '*', alias: 'n' }],
  }, 100);
  banner('A5 nested group-by category → region', plan);
  show(rows, 8);
}

/**
 * A6 — Cardinality: distinct products reviewed per brand (COUNT_DISTINCT → `cardinality`).
 * @param {string} token
 */
async function a6_cardinality(token) {
  const { rows, plan } = await ast(token, {
    from, groupBy: ['brand_key'],
    select: ['brand_key',
      { aggregate: 'COUNT_DISTINCT', column: 'product_id', alias: 'distinct_products' },
      { aggregate: 'COUNT', column: '*', alias: 'reviews' }],
  }, 20);
  banner('A6 distinct products per brand (cardinality)', plan);
  show(rows, 6);
}

(async () => {
  const token = await login();
  console.log('ELASTICSEARCH — AGGREGATION SCENARIOS (AST mode)');
  await a1_avgByCategory(token);
  await a2_multiMetric(token);
  await a3_percentiles(token);
  await a4_dateHistogram(token);
  await a5_nestedGrouping(token);
  await a6_cardinality(token);
  console.log('\nDone — aggregation scenarios.');
})().catch((e) => { console.error('FAILED:', e.message || e); process.exit(1); });
