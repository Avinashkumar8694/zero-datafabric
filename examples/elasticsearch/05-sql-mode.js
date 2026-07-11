/**
 * Elasticsearch scenarios — SQL MODE (native ES `_sql`).
 *
 * The same index queried through the SQL interface (`POST /api/queries/exec` with
 * `source`). The SQL is routed to Elasticsearch's native `_sql` endpoint and run
 * at the source. ES SQL is a read-only subset: SELECT / WHERE / GROUP BY /
 * aggregates, `MATCH()` for full-text, `SCORE()` for relevance, `HISTOGRAM()` for
 * time buckets, `PERCENTILE()` — but NO joins (use AST mode for cross-engine).
 *
 * Run:  node 05-sql-mode.js
 */
const { login, sqlOn, banner, show } = require('./_lib');
const SRC = 'Reviews_ES';

/**
 * Q1 — Aggregate GROUP BY via ES SQL.
 * @param {string} token
 */
async function q1_groupBy(token) {
  const { rows, plan } = await sqlOn(token, SRC,
    `SELECT category, COUNT(*) AS reviews, AVG(rating) AS avg_rating
     FROM product_reviews GROUP BY category ORDER BY avg_rating DESC`);
  banner('Q1 SQL: GROUP BY category → count, avg(rating)', plan);
  show(rows, 10);
}

/**
 * Q2 — Full-text + relevance via ES SQL functions MATCH() and SCORE().
 * @param {string} token
 */
async function q2_fullTextScore(token) {
  const { rows, plan } = await sqlOn(token, SRC,
    `SELECT review_id, brand_key, SCORE() AS sc
     FROM product_reviews WHERE MATCH(body, 'refund broke disappointed')
     ORDER BY SCORE() DESC LIMIT 5`);
  banner('Q2 SQL: MATCH(body,...) + SCORE() relevance ranking', plan);
  show(rows, 5);
}

/**
 * Q3 — Time-series buckets via ES SQL HISTOGRAM().
 * @param {string} token
 */
async function q3_histogram(token) {
  const { rows, plan } = await sqlOn(token, SRC,
    `SELECT HISTOGRAM(created_at, INTERVAL 1 MONTH) AS month, COUNT(*) AS reviews
     FROM product_reviews GROUP BY month ORDER BY month`);
  banner('Q3 SQL: HISTOGRAM(created_at, INTERVAL 1 MONTH)', plan);
  show(rows, 6);
}

/**
 * Q4 — Percentiles via ES SQL PERCENTILE().
 * @param {string} token
 */
async function q4_percentile(token) {
  const { rows, plan } = await sqlOn(token, SRC,
    `SELECT region, PERCENTILE(rating, 90) AS p90_rating, PERCENTILE(sentiment, 50) AS median_sentiment
     FROM product_reviews GROUP BY region`);
  banner('Q4 SQL: PERCENTILE(rating,90) + PERCENTILE(sentiment,50) by region', plan);
  show(rows, 6);
}

/**
 * Q5 — Filters + ORDER BY + LIMIT via ES SQL.
 * @param {string} token
 */
async function q5_filterSort(token) {
  const { rows, plan } = await sqlOn(token, SRC,
    `SELECT review_id, brand_key, rating, sentiment
     FROM product_reviews WHERE rating >= 4 AND verified = true
     ORDER BY sentiment DESC LIMIT 5`);
  banner('Q5 SQL: WHERE rating>=4 AND verified ORDER BY sentiment DESC', plan);
  show(rows, 5);
}

(async () => {
  const token = await login();
  console.log('ELASTICSEARCH — SQL MODE SCENARIOS (native _sql)');
  await q1_groupBy(token);
  await q2_fullTextScore(token);
  await q3_histogram(token);
  await q4_percentile(token);
  await q5_filterSort(token);
  console.log('\nDone — ES SQL-mode scenarios.');
})().catch((e) => { console.error('FAILED:', e.message || e); process.exit(1); });
