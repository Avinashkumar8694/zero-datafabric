# Saved Analytics API

`/api/saved-analytics` — the fabric's **saved query / scheduled report**
primitive. Define a query **once** (AST or SQL) with declared `{{variable}}`
placeholders, then run it many times with different inputs from the UI or an API
call. Every run flows through the normal query engine, so pushdown, federation,
governance and the execution trace all apply.

All endpoints require `Authorization` + `x-tenant-id`. Examples assume the `H`
header array from [api-overview.md](api-overview.md#required-headers).

## Data model

A saved analytic captures:

| Field | Type | Notes |
|-------|------|-------|
| `name` | string | required; unique per tenant (re-creating the same name upserts) |
| `description` | string | optional |
| `mode` | `"AST"` \| `"SQL"` | which body the definition carries |
| `config` | object | **AST mode**: a full `queryConfig` (`{ type:"SELECT", schema, query, limit }`) |
| `sql` | string | **SQL mode**: a raw SQL string |
| `source` | string | **SQL mode**: optional datasource to execute at |
| `variables` | array | declared inputs: `{ name, type, label?, required?, default? }` (`type` ∈ `string`/`number`/`boolean`) |

### `{{variable}}` binding

The query body references a declared variable with a `{{name}}` token:

- **AST mode** — a token that is the *entire* string value is replaced by the
  **typed** value (a number stays a number); an embedded token is substituted as
  a string. The bound config then runs through the normal parameterized pushdown
  path — **injection-safe**.
- **SQL mode** — tokens are replaced with safely-escaped SQL literals (numbers/
  booleans bare, strings single-quote-escaped).

At run time, undefined values fall back to the variable's `default`; a missing
`required` variable is rejected with `400`.

---

## Endpoints

### GET `/api/saved-analytics` — list

```bash
curl -s "${H[@]}" http://localhost:4000/api/saved-analytics
```

`200` → array of `{ id, name, description, mode, definition, variables, runCount, lastRunAt, createdAt, updatedAt }`, newest first.

### GET `/api/saved-analytics/top` — most-run

```bash
curl -s "${H[@]}" "http://localhost:4000/api/saved-analytics/top?limit=8"
```

`200` → up to `limit` (1–24, default 8) analytics ordered by `runCount` desc — for a dashboard "quick run" panel.

### POST `/api/saved-analytics` — create / replace

**AST example** — revenue by status for a chosen region, top *N*:

```bash
curl -s "${H[@]}" http://localhost:4000/api/saved-analytics -d '{
  "name": "revenue_by_status",
  "description": "Revenue by order status for a region",
  "mode": "AST",
  "variables": [
    { "name": "region", "type": "string", "required": true },
    { "name": "topN",   "type": "number", "default": 10 }
  ],
  "config": { "type": "SELECT", "schema": "public", "limit": "{{topN}}", "query": {
    "from": { "resource": "orders", "source": "Retail_Core" },
    "where": [ { "column": "region", "operator": "EQ", "value": "{{region}}" } ],
    "groupBy": ["status"],
    "select": ["status", { "aggregate": "SUM", "column": "total_amount", "alias": "revenue" }],
    "orderBy": [ { "column": "revenue", "direction": "DESC" } ] } } }'
```

**SQL example** — same idea in SQL mode at a source:

```bash
curl -s "${H[@]}" http://localhost:4000/api/saved-analytics -d '{
  "name": "revenue_by_status_sql",
  "mode": "SQL",
  "source": "Retail_Core",
  "variables": [ { "name": "region", "type": "string", "required": true } ],
  "sql": "SELECT status, SUM(total_amount) AS revenue FROM orders WHERE region = {{region}} GROUP BY status ORDER BY revenue DESC" }'
```

**Success (`201`):** `{ id, name, description, mode, definition, variables, createdAt }`.

**Errors:** `400 { "error": "name is required" }`; `400 { "error": "AST analytic requires a \"config\"" }` / `"SQL analytic requires a \"sql\" string"`.

### GET `/api/saved-analytics/:id` — fetch one

`200` → the definition, or `404 { "error": "analytic not found" }`.

### DELETE `/api/saved-analytics/:id`

`200 { "status": "DELETED", "id": "…" }`, or `404` if not found.

### POST `/api/saved-analytics/:id/run` — execute with variables

**Purpose:** bind variable values and run. Body is `{ "variables": { … } }` (or
the values object directly). Returns the standard query envelope plus the bound
variables and analytic identity.

```bash
curl -s "${H[@]}" http://localhost:4000/api/saved-analytics/$ID/run -d '{
  "variables": { "region": "EU", "topN": 5 } }'
```

**Success (`200`):**

```jsonc
{
  "analytic": { "id": "…", "name": "revenue_by_status", "mode": "AST" },
  "boundVariables": { "region": "EU", "topN": 5 },
  "data": [ { "status": "SHIPPED", "revenue": 128400 } ],
  "rowCount": 1,
  "warnings": [],
  "plan": { "strategy": "SINGLE_CONNECTOR", "executionMs": 11, "legs": [ … ] }
}
```

Each run bumps `runCount` / `lastRunAt` (feeds the `/top` list) and is captured in
the [query audit trail](observability-api.md) under `mode: "SAVED_ANALYTIC"`.

**Errors:**

| Status | Body | Cause |
|--------|------|-------|
| `404` | `{ "error": "analytic not found" }` | unknown `:id` |
| `400` | `{ "error": "missing required variable \"region\"" }` | required variable not supplied and no default |
| `500` | `{ "error": "<message>" }` | underlying query failure |

---

## Patterns

### One analytic that combines recursive + aggregate + HAVING + ORDER

Because SQL mode runs native SQL at the source, a single saved analytic can fold
a recursive CTE, aggregation, a `HAVING` filter and an ordering into one
definition — parameterized by `{{variable}}`:

```jsonc
{
  "name": "referral_tree_revenue",
  "mode": "SQL",
  "source": "Retail_Core",
  "variables": [
    { "name": "rootId",  "type": "number", "required": true },
    { "name": "minRev",  "type": "number", "default": 1000 }
  ],
  "sql": "WITH RECURSIVE tree AS ( SELECT id, referred_by, 1 AS depth FROM customers WHERE id = {{rootId}} UNION ALL SELECT c.id, c.referred_by, t.depth+1 FROM customers c JOIN tree t ON c.referred_by = t.id ) SELECT t.depth, count(DISTINCT o.id) AS orders, sum(o.total_amount) AS revenue FROM tree t JOIN orders o ON o.customer_id = t.id GROUP BY t.depth HAVING sum(o.total_amount) >= {{minRev}} ORDER BY revenue DESC"
}
```

Run it with `{ "variables": { "rootId": 1, "minRev": 5000 } }`. See
[recursive-and-window-queries.md](recursive-and-window-queries.md) for the SQL
building blocks.

### Sub-analytic as a CTE (composition)

A larger SQL-mode analytic can embed a smaller query's SQL as a named CTE,
composing reusable building blocks into one statement:

```sql
WITH active_customers AS (
  -- (the body of a "high-value customers" analytic)
  SELECT id FROM customers WHERE lifetime_value >= {{floor}}
),
recent_orders AS (
  SELECT customer_id, total_amount FROM orders WHERE order_date >= {{since}}
)
SELECT c.id, sum(r.total_amount) AS spend
FROM active_customers c JOIN recent_orders r ON r.customer_id = c.id
GROUP BY c.id ORDER BY spend DESC;
```

Save it as one SQL-mode analytic with variables `floor` and `since`. (AST-mode
analytics compose via `with[]`/`recursive` in the query AST — see
[metadata-manifests.md](metadata-manifests.md#view--materialized_view) for the
`with` shape, which the query AST shares.)

### AST vs SQL saved configs — when to pick which

| Prefer AST when… | Prefer SQL when… |
|------------------|------------------|
| the query is a filter/aggregate/join and may span **multiple sources** | you need window functions, recursive CTEs, `HAVING`, or matview reads at **one** SQL engine |
| you want the planner to choose pushdown/federation automatically | you want to hand-write the exact statement and pin it to a `source` |
| you want governance (policies/masking) applied per leg | (governance still applies via the source connector, but AST gives per-column masking hooks) |
