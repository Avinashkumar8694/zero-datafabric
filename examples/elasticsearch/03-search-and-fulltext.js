/**
 * Elasticsearch scenarios — SEARCH & FULL-TEXT (AST mode).
 *
 * Demonstrates the text-search capabilities that make ES the fabric's search
 * layer: full-text relevance, fuzzy / entity-resolution matching, scoring,
 * structured filters, wildcards, projection, sort and pagination — all via the
 * engine-agnostic AST (`POST /api/analytics/query`).
 *
 * Run (backend up, index seeded + registered):  node 03-search-and-fulltext.js
 */
const { login, ast, banner, show } = require('./_lib');
const SRC = 'Reviews_ES';
const from = { resource: 'product_reviews', source: SRC };

/**
 * S1 — Full-text search on an analyzed `text` field.
 * ES tokenizes `body` and matches on terms (not substrings), returning documents
 * that mention "refund" or "broke". This is impossible to do well in SQL.
 * @param {string} token
 */
async function s1_fullText(token) {
  const { rows, plan } = await ast(token, {
    from, select: ['review_id', 'brand_key', 'rating', 'body', '_score'],
    where: [{ column: 'body', operator: 'MATCH', value: 'refund broke' }],
  }, 5);
  banner('S1 full-text MATCH(body, "refund broke")', plan);
  show(rows);
}

/**
 * S2 — Relevance ranking with `_score`.
 * ES scores each match by relevance; ordering by `_score DESC` surfaces the most
 * relevant reviews first (a review mentioning several negative phrases outranks one).
 * @param {string} token
 */
async function s2_relevance(token) {
  const { rows, plan } = await ast(token, {
    from, select: ['review_id', '_score', 'body'],
    where: [{ column: 'body', operator: 'MATCH', value: 'terrible disappointed refund' }],
    orderBy: [{ column: '_score', direction: 'DESC' }],
  }, 5);
  banner('S2 relevance ranking (ORDER BY _score DESC)', plan);
  show(rows);
}

/**
 * S3 — Fuzzy match / ENTITY RESOLUTION.
 * The brand is stored with messy variants ("Acme", "Acme Inc", "ACME", "acme corp").
 * A fuzzy query with a typo ("Acmee Corp") still links them via Levenshtein
 * distance (fuzziness=AUTO) — the primitive for resolving the same entity across
 * inconsistent spellings. `brand_key` shows the canonical ground-truth.
 * @param {string} token
 */
async function s3_fuzzyEntityResolution(token) {
  const { rows, plan } = await ast(token, {
    from, select: ['brand', 'brand_key', '_score'],
    where: [{ column: 'brand', operator: 'FUZZY', value: 'Acmee Corp' }],
    orderBy: [{ column: '_score', direction: 'DESC' }],
  }, 6);
  banner('S3 fuzzy / entity resolution — FUZZY(brand, "Acmee Corp")', plan);
  show(rows, 6);
}

/**
 * S4 — Structured filters: numeric range + boolean + keyword IN.
 * Exact/range predicates compile to ES `range`/`term`/`terms` in filter context
 * (fast, cached, unscored).
 * @param {string} token
 */
async function s4_structuredFilters(token) {
  const { rows, plan } = await ast(token, {
    from, select: ['review_id', 'rating', 'verified', 'region'],
    where: [
      { column: 'rating', operator: 'GTE', value: 4 },
      { column: 'verified', operator: 'EQ', value: true },
      { column: 'region', operator: 'IN', value: ['EU', 'NA'] },
    ],
  }, 5);
  banner('S4 structured filters (rating>=4 AND verified AND region IN[EU,NA])', plan);
  show(rows);
}

/**
 * S5 — Wildcard match (`ILIKE`) on a text field → ES `wildcard`.
 * @param {string} token
 */
async function s5_wildcard(token) {
  const { rows, plan } = await ast(token, {
    from, select: ['brand', 'brand_key'],
    where: [{ column: 'brand', operator: 'ILIKE', value: 'glob%' }],
  }, 5);
  banner('S5 wildcard ILIKE(brand, "glob%")', plan);
  show(rows);
}

/**
 * S6 — Projection + sort + pagination (page 2, 5 per page).
 * @param {string} token
 */
async function s6_pagination(token) {
  const { rows, plan } = await ast(token, {
    from, select: ['review_id', 'rating'],
    orderBy: [{ column: 'review_id', direction: 'ASC' }], offset: 5,
  }, 5);
  banner('S6 projection + sort + pagination (offset 5, size 5)', plan);
  show(rows, 5);
}

(async () => {
  const token = await login();
  console.log('ELASTICSEARCH — SEARCH & FULL-TEXT SCENARIOS (AST mode)');
  await s1_fullText(token);
  await s2_relevance(token);
  await s3_fuzzyEntityResolution(token);
  await s4_structuredFilters(token);
  await s5_wildcard(token);
  await s6_pagination(token);
  console.log('\nDone — search & full-text scenarios.');
})().catch((e) => { console.error('FAILED:', e.message || e); process.exit(1); });
