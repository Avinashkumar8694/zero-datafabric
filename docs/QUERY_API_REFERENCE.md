# Zero Data Fabric — Query & Data API Reference

Complete syntax for querying and mutating data across federated sources. There
are three layers, from highest-level to lowest:

| Layer | Endpoint(s) | Use it for |
|-------|-------------|-----------|
| **CRUD façade** | `POST /api/data/{fetch,create,update,delete}` | Simple single-resource reads/writes. Ergonomic JSON, no query shape to learn. |
| **AST query** | `POST /api/analytics/query` (also `/api/queries/engine`) | Structured, engine-agnostic queries: joins, set-ops, aggregates, cross-source federation. **The primary interface.** |
| **Native SQL** | `POST /api/queries/exec`, `POST /api/queries/native` | Raw SQL for complex single-source analytics (window functions, recursive CTEs, matviews) executed *at* the owning engine. |

**Auth (all endpoints):** header `Authorization: Bearer <token>` and `x-tenant-id: <tenant>`.

---

## 1. The response envelope

Every read returns the same shape:

```jsonc
{
  "data": [ { ... } ],          // result rows (writes use "returning" / "rowCount")
  "rowCount": 12,
  "warnings": [ "..." ],        // e.g. row-cap hit
  "plan": {
    "strategy": "CROSS_ENGINE", // SINGLE_LOCAL | SINGLE_CONNECTOR | CROSS_ENGINE | SINGLE_CONNECTOR_RAW | SINGLE_CONNECTOR_WRITE
    "executionMs": 24,
    "rowsScannedAcrossSources": 4,   // total rows pulled from all sources (proof of pushdown)
    "pushed": [ "human-readable notes" ],
    "legs": [                        // per-source execution trace
      { "source": "Retail_Core", "engine": "POSTGRES", "mode": "connector",
        "operation": "join-driving", "target": "public.orders",
        "query": "SELECT * FROM \"public\".\"orders\" WHERE \"customer_id\" = $1 ...",
        "params": [42], "rowsReturned": 2, "ms": 14 }
    ]
  }
}
```

**`plan.legs` is the proof of correct federation:** each entry shows which engine
ran what query and how many rows it returned. If `rowsScannedAcrossSources` is
small while the tables are large, pushdown worked (the fabric did **not** fetch
whole tables and filter in memory).

### Planner strategies
- **SINGLE_LOCAL** — everything resolves inside the tenant Postgres hub → one SQL statement.
- **SINGLE_CONNECTOR** — one external source → one pushed-down query (filter/projection/sort/limit/aggregate).
- **CROSS_ENGINE** — legs span ≥2 distinct sources → each leg pushed down independently, results merged in-fabric (bind-join for joins, partial-aggregate merge for aggregates, set-op merge).
- **SINGLE_CONNECTOR_RAW / _WRITE** — native SQL / CRUD write executed at one external source.

---

## 2. AST query — `POST /api/analytics/query`

### Request wrapper
```jsonc
{
  "queryConfig": {
    "type": "SELECT",
    "schema": "public",     // logical schema (hub tenant schema); ignored for external legs
    "limit": 100,           // top-level cap (also enforces the safety rule below)
    "query": { /* the AST, see below */ }
  }
}
```
> **Safety:** a SELECT must have either a `where` on the query, a `limit`, or be a set-op — unrestricted full-table reads are blocked.

### The `query` object
```jsonc
{
  "from":   { "resource": "orders", "source": "Retail_Core", "alias": "o" },
  "select": [ "id", "region", { "aggregate": "SUM", "column": "total_amount", "alias": "revenue" } ],
  "where":  [ { "column": "status", "operator": "EQ", "value": "SHIPPED" } ],
  "joins":  [ { "type": "INNER", "resource": "web_events", "source": "Web_Analytics", "alias": "w",
               "on": { "left": "o.customer_id", "operator": "EQ", "right": "w.customer_id" } } ],
  "groupBy":[ "region" ],
  "orderBy":[ { "column": "revenue", "direction": "DESC" } ],
  "limit": 50,
  "offset": 0
}
```

| Field | Meaning |
|-------|---------|
| `from` | `{ resource, source?, alias? }`. `source` = datasource name (omit → hub). |
| `select` | array of column names and/or aggregate specs (see below). Omit or `["*"]` for all. |
| `where` | array of predicates, AND-combined: `{ column, operator, value }`. |
| `joins` | array of joins (see below). |
| `groupBy` | array of grouping columns (used with aggregates). |
| `orderBy` | array of `{ column, direction: "ASC"|"DESC" }`. |
| `limit` / `offset` | pagination. |
| `union` / `intersect` / `except` | array of sub-queries for set operations (see below). |

### WHERE operators
| operator | meaning | example value |
|----------|---------|---------------|
| `EQ` | `=` | `"SHIPPED"` |
| `NE` | `!=` | `"CANCELLED"` |
| `GT` `GTE` `LT` `LTE` | `> >= < <=` | `4900` |
| `LIKE` | case-sensitive pattern | `"Customer_100%"` |
| `ILIKE` | case-insensitive pattern | `"%priority%"` |
| `IN` | membership | `["SHIPPED","DELIVERED"]` |

For a join, a constant on one side is **transitively propagated** to the other
side across the equijoin key, so both sources get filtered before any fetch.

### Aggregate specs (in `select`)
```jsonc
{ "aggregate": "COUNT",          "column": "*",            "alias": "n" }
{ "aggregate": "SUM"|"AVG"|"MIN"|"MAX"|"COUNT_DISTINCT", "column": "total_amount", "alias": "revenue" }
```
Aggregates + `groupBy` are pushed to the source: Postgres/MySQL/Snowflake run a
native `GROUP BY`; MongoDB runs a `$group` pipeline; each source returns *groups*,
not rows. Across sources (via UNION legs), a **partial aggregate** is pushed to
each and merged in-fabric (`AVG` = ΣSUM/ΣCOUNT, etc.).

### Joins
```jsonc
{ "type": "INNER"|"LEFT", "resource": "order_items", "source": "Product_Warehouse", "alias": "i",
  "on": { "left": "o.id", "operator": "EQ", "right": "i.order_id" } }
```
- Cross-source joins use a **bind-join**: the driving side is fetched first (with
  its predicates), its join keys are collected, and `key IN (...)` is pushed to
  the other side — so the second source returns only rows that can match.
- `RIGHT`/`FULL` across engines are executed as `INNER` with a warning.
- Output columns are alias-qualified (`o.id`, `w.event_type`) to avoid collisions.

### Set operations
```jsonc
{ "union":     [ <query>, <query> ] }   // OR (distinct)
{ "intersect": [ <query>, <query> ] }   // AND
{ "except":    [ <query>, <query> ] }   // difference (first minus rest)
```
Each leg may target a different source/engine. Legs support `select`, `where`,
`orderBy`, `limit`. Example — customers who ordered **and** browsed:
```jsonc
{ "query": { "intersect": [
  { "select": ["customer_id"], "from": { "resource": "orders",     "source": "Retail_Core" } },
  { "select": ["customer_id"], "from": { "resource": "web_events",  "source": "Web_Analytics" } }
] } }
```

---

## 3. CRUD façade — `POST /api/data/*`

Simple single-resource operations. Body fields:

| Field | fetch | create | update | delete |
|-------|:----:|:-----:|:-----:|:-----:|
| `source` (datasource name; omit = hub) | ✓ | ✓ | ✓ | ✓ |
| `schema` (physical schema/db; auto-resolved from catalog if omitted) | ✓ | ✓ | ✓ | ✓ |
| `resource` (table/collection) — **required** | ✓ | ✓ | ✓ | ✓ |
| `columns` (projection) | ✓ | | | |
| `where` — **required for update/delete** | ✓ | | ✓ | ✓ |
| `orderBy`, `limit`, `offset` | ✓ | | | |
| `data` (object or array) — **required for create/update** | | ✓ | ✓ | |

### `where` map convention
`{ column: value }` → equality, or `{ column: { $op: value } }` with
`$eq $ne $gt $gte $lt $lte $like $ilike $in`:
```jsonc
{ "region": "EU" }
{ "lifetime_value": { "$gt": 45000 } }
{ "status": { "$in": ["SHIPPED","DELIVERED"] } }
```

### Examples
```jsonc
// fetch
POST /api/data/fetch
{ "source":"Retail_Core", "resource":"customers",
  "columns":["id","name","region"], "where":{ "region":"EU" }, "limit":3 }

// create (single or batch)
POST /api/data/create
{ "source":"Retail_Core", "resource":"customers",
  "data":{ "id":900001, "name":"Acme", "region":"NA", "segment":"SMB",
           "signup_date":"2026-01-01", "lifetime_value":100 } }

// update (where required)
POST /api/data/update
{ "source":"Retail_Core", "resource":"customers",
  "where":{ "id":900001 }, "data":{ "lifetime_value":9999 } }

// delete (where required)
POST /api/data/delete
{ "source":"Web_Analytics", "resource":"web_events", "where":{ "event_id":900001 } }
```
Writes execute at the owning source: **remote Postgres** via parameterized SQL,
**MongoDB** via `insertMany`/`updateMany`/`deleteMany`. Responses include the
`plan.legs` trace. Hub writes additionally emit change events + Elasticsearch sync.

---

## 4. Native SQL — `POST /api/queries/exec`

Run arbitrary SQL. Add `source` to execute it **at that external engine** (for
window functions, recursive CTEs, materialized-view reads that the AST layer
doesn't model):
```jsonc
POST /api/queries/exec
{
  "source": "Retail_Core",      // omit → runs on the hub
  "schema": "public",           // sets search_path at the source
  "sql": "WITH d AS (SELECT date_trunc('day',order_date)::date dt, sum(total_amount) rev FROM orders GROUP BY 1) SELECT dt, rev, sum(rev) OVER (ORDER BY dt) running FROM d ORDER BY dt"
}
```
Returns the standard envelope with `plan.strategy = "SINGLE_CONNECTOR_RAW"` and a
one-leg trace. SQL-native engines (Postgres/MySQL/Snowflake) run the SQL directly;
**Elasticsearch** also accepts `source` — the SQL is routed to its native `_sql`
endpoint (read-only subset: `SELECT`/`WHERE`/`GROUP BY`/aggregates, `MATCH()` for
full-text, `SCORE()` for relevance, no JOINs). MongoDB has no SQL — use AST mode.

`POST /api/queries/native` behaves the same for a single `{ sql, source?, schema? }`.

---

## 5. Worked examples

Runnable, self-verifying examples live in
[`examples/distributed-retail/`](../examples/distributed-retail/):

- `06-ast-cookbook.js` — every AST feature above, printing the plan/trace.
- `07-crud-api-examples.js` — the `/api/data` CRUD endpoints end-to-end.
- `03-analytics-suite.js` — 12 scenarios with pushdown assertions.
- `05-real-world-scenarios.js` — RFM, cohort, moving average, Pareto, cross-source funnel.

Run `node run-all.js --seed` from that folder to seed the external sources and
execute everything.
