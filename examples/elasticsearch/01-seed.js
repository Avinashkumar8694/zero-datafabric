/**
 * Elasticsearch example suite — dataset seeder.
 *
 * Builds a rich `product_reviews` index that showcases every ES capability the
 * fabric integrates:
 *   • text fields (body, brand)          → full-text + fuzzy search + relevance
 *   • keyword fields (category, region)  → exact filters + terms aggregations
 *   • numeric fields (rating, sentiment) → range filters + metric/percentile aggs
 *   • date field (created_at)            → date_histogram time-series
 *   • messy brand variants               → fuzzy / entity-resolution scenarios
 *   • product_id                         → cross-engine join with Postgres products
 *
 * Run:  NODE_PATH=../../backend/node_modules node 01-seed.js
 */
const axios = require('axios');
const ES = 'http://localhost:9200';
const INDEX = 'product_reviews';
const N = 4000;

// Canonical brands, each with deliberately messy real-world variants so that an
// exact match fails but a fuzzy / entity-resolution query links them.
const BRANDS = {
  Acme:      ['Acme', 'Acme Inc', 'Acme Corporation', 'ACME', 'acme corp', 'Acme  Inc.'],
  Globex:    ['Globex', 'Globex LLC', 'globex', 'Globex Co', 'Glob ex'],
  Initech:   ['Initech', 'Initech Ltd', 'INITECH', 'initech inc'],
  Umbrella:  ['Umbrella', 'Umbrella Corp', 'umbrella corporation', 'Umbrela'],
  Soylent:   ['Soylent', 'Soylent Corp', 'soylent industries'],
};
const CATEGORIES = ['ELECTRONICS', 'APPAREL', 'HOME', 'GROCERY', 'TOYS'];
const REGIONS = ['NA', 'EU', 'APAC', 'LATAM'];
const POSITIVE = ['excellent quality', 'works perfectly', 'highly recommend', 'great value', 'fast delivery'];
const NEGATIVE = ['broke after a week', 'requesting a refund', 'terrible experience', 'stopped working', 'very disappointed'];

const rnd = (n) => Math.floor(Math.random() * n);
const pick = (a) => a[rnd(a.length)];
const money = (lo, hi) => Math.round((lo + Math.random() * (hi - lo)) * 100) / 100;
const daysAgo = (d) => new Date(Date.now() - d * 86400000).toISOString();

(async () => {
  await axios.delete(`${ES}/${INDEX}`).catch(() => {});
  await axios.put(`${ES}/${INDEX}`, {
    mappings: { properties: {
      review_id:  { type: 'integer' },
      product_id: { type: 'integer' },          // FK to Postgres products (federation)
      account_id: { type: 'integer' },
      brand:      { type: 'text' },              // messy → fuzzy/entity resolution
      brand_key:  { type: 'keyword' },           // canonical brand (ground truth)
      category:   { type: 'keyword' },
      region:     { type: 'keyword' },
      rating:     { type: 'integer' },
      sentiment:  { type: 'float' },
      verified:   { type: 'boolean' },
      body:       { type: 'text' },              // analyzed full-text
      created_at: { type: 'date' },
    } },
  }, { headers: { 'Content-Type': 'application/json' } });

  const brandNames = Object.keys(BRANDS);
  let bulk = '';
  for (let id = 1; id <= N; id++) {
    const canonical = pick(brandNames);
    const positive = Math.random() < 0.6;
    const rating = positive ? 4 + rnd(2) : 1 + rnd(3);
    const doc = {
      review_id: id,
      product_id: 1 + rnd(5000),              // pairs with distributed-retail Product_Warehouse.products
      account_id: 1 + rnd(2000),
      brand: pick(BRANDS[canonical]),         // a messy variant
      brand_key: canonical,                   // the canonical brand
      category: pick(CATEGORIES),
      region: pick(REGIONS),
      rating,
      sentiment: positive ? money(0.6, 1.0) : money(0.0, 0.4),
      verified: Math.random() < 0.7,
      body: `${pick(positive ? POSITIVE : NEGATIVE)} — ${pick(positive ? POSITIVE : NEGATIVE)}.`,
      created_at: daysAgo(rnd(180)),
    };
    bulk += JSON.stringify({ index: { _index: INDEX, _id: String(id) } }) + '\n' + JSON.stringify(doc) + '\n';
    if (id % 2000 === 0) { await axios.post(`${ES}/_bulk`, bulk, { headers: { 'Content-Type': 'application/x-ndjson' } }); bulk = ''; }
  }
  if (bulk) await axios.post(`${ES}/_bulk`, bulk, { headers: { 'Content-Type': 'application/x-ndjson' } });
  await axios.post(`${ES}/${INDEX}/_refresh`);
  const count = (await axios.get(`${ES}/${INDEX}/_count`)).data.count;
  console.log(`[Reviews_ES] ${INDEX} seeded = ${count} documents (brands: ${brandNames.join(', ')})`);
})().catch((e) => { console.error('SEED FAILED:', e.message || e); process.exit(1); });
