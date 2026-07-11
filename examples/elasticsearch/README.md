# Elasticsearch examples — full capability, scenario by scenario

A self-contained suite that exercises **every** Elasticsearch capability the fabric
integrates, in both **AST mode** and **SQL mode**. Each scenario is a
JSDoc-documented function you can read as living documentation.

## Dataset

`01-seed.js` builds a `product_reviews` index (4,000 docs) chosen to show every
feature:

| Field | Type | Enables |
|-------|------|---------|
| `body` | text | full-text search, relevance `_score` |
| `brand` (+ `brand_key`) | text / keyword | **fuzzy / entity resolution** (messy variants: "Acme", "Acme Inc", "ACME", "acme corp") |
| `category`, `region` | keyword | exact filters, terms aggregations |
| `rating`, `sentiment` | integer / float | range filters, metric + **percentile** aggs |
| `created_at` | date | **date_histogram** time series |
| `product_id` | integer | **cross-engine join** with Postgres `products` |

## Scenario files

| File | Scenarios |
|------|-----------|
| `03-search-and-fulltext.js` | S1 full-text `MATCH` · S2 relevance `_score` ranking · S3 **fuzzy / entity resolution** · S4 structured filters (range/bool/IN) · S5 wildcard `ILIKE` · S6 projection+sort+pagination |
| `04-aggregations.js` | A1 avg+count by category · A2 multi-metric by region · A3 **percentiles** · A4 **date_histogram** · A5 nested (multi-level) grouping · A6 cardinality (distinct) |
| `05-sql-mode.js` | Q1 SQL GROUP BY · Q2 `MATCH()`+`SCORE()` · Q3 `HISTOGRAM()` · Q4 `PERCENTILE()` · Q5 filters+sort — all via native ES `_sql` |
| `06-crud-and-federation.js` | CRUD lifecycle (create/fetch/update/delete via `/api/data`) · **cross-engine JOIN** (ES reviews ⋈ Postgres products, bind-join) |

Every scenario prints the **pushed-down query** (real ES DSL or `_sql`) from the
execution trace, so you can see exactly what ran in the cluster.

## Run

```bash
# prereqs: docker stack up (Elasticsearch :9200), backend on :4000
cd examples/elasticsearch

node run-all.js --seed     # seed the index + register the source, then all scenarios
# or, once seeded:
node 03-search-and-fulltext.js
node 04-aggregations.js
node 05-sql-mode.js
node 06-crud-and-federation.js
```

The federation scenario (`06`) joins on `product_id` against
`Product_Warehouse.products`, so it pairs with the
[distributed-retail example](../distributed-retail/) being seeded (otherwise that
one scenario returns no matches — noted at runtime).

## See also

- Concepts & architecture: [`docs/elastic_search/`](../../docs/elastic_search/)
- AST + SQL syntax reference: [`docs/QUERY_API_REFERENCE.md`](../../docs/QUERY_API_REFERENCE.md)
