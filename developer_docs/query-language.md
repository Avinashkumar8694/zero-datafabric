# The AST Query Language

The primary way to query the fabric. `POST /api/analytics/query` with a
`queryConfig` wrapping an engine-agnostic AST. The planner pushes work to each
source and federates across sources automatically.

```
POST /api/analytics/query
{ "queryConfig": { "type": "SELECT", "schema": "public", "limit": 100, "query": { … } } }
```

- `type` — always `"SELECT"` for reads.
- `schema` — logical schema (used for hub resolution; ignored for external legs).
- `limit` — top-level row cap (also satisfies the safety rule).
- `query` — the AST, documented below.

> A SELECT must include a `where`, a `limit`, or be a set operation.

---

## `from` — the driving resource

```jsonc
"from": { "resource": "orders", "source": "Retail_Core", "alias": "o" }
```
`source` is the datasource name (omit for the hub). `alias` is used to qualify
columns in joins.

## `select` — projection & aggregates

Array of column names and/or aggregate specs. Omit (or `["*"]`) for all columns.

```jsonc
"select": [ "id", "region", { "aggregate": "SUM", "column": "total_amount", "alias": "revenue" } ]
```

Aggregate spec: `{ "aggregate": FUNC, "column": COL, "alias": NAME }` where `FUNC`
∈ `COUNT | SUM | AVG | MIN | MAX | COUNT_DISTINCT`. Use `"column": "*"` for
`COUNT(*)`.

## `where` — predicates (AND-combined)

```jsonc
"where": [ { "column": "status", "operator": "EQ", "value": "SHIPPED" } ]
```

| operator | SQL / Mongo | value example |
|----------|-------------|---------------|
| `EQ`  | `=` | `"SHIPPED"` |
| `NE`  | `!=` | `"CANCELLED"` |
| `GT` `GTE` `LT` `LTE` | `> >= < <=` | `4900` |
| `LIKE`  | `LIKE` (case-sensitive) | `"Customer_100%"` |
| `ILIKE` | `ILIKE` (case-insensitive) | `"%priority%"` |
| `IN`  | `IN (…)` / `$in` | `["SHIPPED","DELIVERED"]` |

**Example — operator filters:**
```jsonc
{ "queryConfig": { "type": "SELECT", "schema": "public", "limit": 5, "query": {
  "from": { "resource": "orders", "source": "Retail_Core" },
  "where": [
    { "column": "total_amount", "operator": "GTE", "value": 1000 },
    { "column": "status", "operator": "IN", "value": ["SHIPPED", "DELIVERED"] }
  ] } } }
```

## `orderBy`, `limit`, `offset`

```jsonc
"orderBy": [ { "column": "revenue", "direction": "DESC" } ],
"limit": 50,
"offset": 100
```

## Aggregates + `groupBy`

Pushed to the source as native `GROUP BY` (SQL) or `$group` (Mongo). Each source
returns *groups*, not rows.

```jsonc
{ "queryConfig": { "type": "SELECT", "schema": "public", "query": {
  "from": { "resource": "orders", "source": "Retail_Core" },
  "groupBy": ["channel"],
  "select": [ "channel",
    { "aggregate": "COUNT", "column": "*",            "alias": "n" },
    { "aggregate": "SUM",   "column": "total_amount", "alias": "total" },
    { "aggregate": "AVG",   "column": "total_amount", "alias": "avg" } ] } } }
```

Same shape works against a Mongo source (`Web_Analytics.web_events`) — it compiles
to a `$group` pipeline.

## `joins` — including cross-source

```jsonc
"joins": [
  { "type": "INNER", "resource": "web_events", "source": "Web_Analytics", "alias": "w",
    "on": { "left": "o.customer_id", "operator": "EQ", "right": "w.customer_id" } }
]
```

- `type`: `INNER` | `LEFT` (cross-engine `RIGHT`/`FULL` run as `INNER` with a warning).
- Cross-source joins use a **bind-join**: driving side fetched first, its keys
  pushed as `IN (…)` to the other side. Output columns are alias-qualified
  (`o.id`, `w.event_type`).

**Example — Postgres `orders` ⋈ Mongo `web_events` for one customer:**
```jsonc
{ "queryConfig": { "type": "SELECT", "schema": "public", "limit": 20, "query": {
  "select": ["*"],
  "from": { "resource": "orders", "source": "Retail_Core", "alias": "o" },
  "joins": [ { "type": "INNER", "resource": "web_events", "source": "Web_Analytics", "alias": "w",
               "on": { "left": "o.customer_id", "operator": "EQ", "right": "w.customer_id" } } ],
  "where": [ { "column": "o.customer_id", "operator": "EQ", "value": 42 } ] } } }
```
The trace shows `WHERE customer_id = 42` pushed to Postgres and
`{customer_id: {$in:[42]}}` pushed to Mongo — only matching rows are pulled.

## Set operations — cross-engine

`union` / `intersect` / `except`, each an array of sub-queries that may target
different engines. Legs support `select`, `where`, `orderBy`, `limit`.

```jsonc
// Customers who ordered (Postgres) AND browsed (Mongo)
{ "queryConfig": { "type": "SELECT", "schema": "public", "query": {
  "intersect": [
    { "select": ["customer_id"], "from": { "resource": "orders",    "source": "Retail_Core" } },
    { "select": ["customer_id"], "from": { "resource": "web_events", "source": "Web_Analytics" } }
  ] } } }
```
`union` = OR (distinct), `intersect` = AND, `except` = first minus the rest.

## Multi-source aggregate

A `union` whose legs are aggregates triggers **partial-aggregate pushdown**: each
source computes its partial groups, and the fabric merges them.

```jsonc
{ "queryConfig": { "type": "SELECT", "schema": "public", "query": {
  "union": [
    { "from": { "resource": "orders",     "source": "Retail_Core" },  "groupBy": ["customer_id"],
      "select": ["customer_id", { "aggregate": "COUNT", "column": "*", "alias": "cnt" }] },
    { "from": { "resource": "web_events",  "source": "Web_Analytics" }, "groupBy": ["customer_id"],
      "select": ["customer_id", { "aggregate": "COUNT", "column": "*", "alias": "cnt" }] }
  ] } } }
```

## Per-engine pushdown support

| Feature | Postgres | MySQL | Snowflake | MongoDB | Elasticsearch |
|---------|:--:|:--:|:--:|:--:|:--:|
| filter / projection / sort / limit | ✓ | ✓ | ✓ | ✓ (find) | ✓ (query DSL) |
| `GROUP BY` aggregate | ✓ | ✓ | ✓ | ✓ (`$group`) | ✓ (aggs) |
| bind-join (as `IN` filter) | ✓ | ✓ | ✓ | ✓ (`$in`) | ✓ |
| native SQL (`/queries/exec`) | ✓ window/recursive | ✓ | ✓ | — (use AST) | ✓ ES `_sql` (subset, no JOINs) |

For window functions & recursive CTEs, see
[recursive-and-window-queries.md](recursive-and-window-queries.md).

## Reading the result

```jsonc
{ "data": [ … ], "rowCount": 4, "warnings": [],
  "plan": { "strategy": "CROSS_ENGINE", "executionMs": 24, "rowsScannedAcrossSources": 4,
            "legs": [ { "source": "...", "engine": "...", "operation": "...", "query": "...", "rowsReturned": 2, "ms": 14 } ] } }
```

A full runnable cookbook of every feature above:
[`examples/distributed-retail/06-ast-cookbook.js`](../examples/distributed-retail/06-ast-cookbook.js).
