# Saved Analytics API

`/api/saved-analytics` — the fabric's **saved query / scheduled report**
primitive. Define an AST query **once** with declared `{{variable}}`
placeholders, then run it many times with different inputs from the UI or an API
call. Every run flows through the normal query engine, so pushdown, federation,
governance and the execution trace all apply.

> **AST-only.** SQL-mode saved analytics (`mode: "SQL"`, `sql`, `source`) are no
> longer supported: creating one is rejected, and running a previously stored one
> returns an error, with `code: "SQL_NOT_SUPPORTED"` (`400`/`410`). Re-save such
> analytics as AST `config`s.

All endpoints require `Authorization` + `x-tenant-id`. Examples assume the `H`
header array from [api-overview.md](api-overview.md#required-headers).

## Data model

A saved analytic captures:

| Field | Type | Notes |
|-------|------|-------|
| `name` | string | required; unique per tenant (re-creating the same name upserts) |
| `description` | string | optional |
| `mode` | `"AST"` | the definition carries an AST `config` (SQL mode is not supported) |
| `config` | object | a full `queryConfig` (`{ type:"SELECT", schema, query, limit }`) |
| `variables` | array | declared inputs: `{ name, type, label?, required?, default? }` (`type` ∈ `string`/`number`/`boolean`) |

### `{{variable}}` binding

The query body references a declared variable with a `{{name}}` token:

A token that is the *entire* string value is replaced by the **typed** value (a
number stays a number); an embedded token is substituted as a string. The bound
config then runs through the normal parameterized pushdown path — **injection-safe**.

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

**Success (`201`):** `{ id, name, description, mode, definition, variables, createdAt }`.

**Errors:** `400 { "error": "name is required" }`; `400 { "error": "AST analytic requires a \"config\"" }`; `400` with `code: "SQL_NOT_SUPPORTED"` for `mode: "SQL"` / a `sql` body.

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

### One analytic that combines recursive traversal + variables

A saved analytic can wrap a `query.recursive` traversal, parameterized by
`{{variable}}` (see [recursive-and-window-queries.md](recursive-and-window-queries.md)):

```jsonc
{
  "name": "referral_tree",
  "mode": "AST",
  "variables": [
    { "name": "rootId",   "type": "number", "required": true },
    { "name": "maxDepth", "type": "number", "default": 10 }
  ],
  "config": { "type": "SELECT", "schema": "public", "query": {
    "from": { "resource": "customers", "source": "Retail_Core" },
    "select": ["id", "referred_by"],
    "recursive": {
      "source": "Retail_Core", "resource": "customers", "select": ["id", "referred_by"],
      "connectBy": { "parent": "referred_by", "child": "id" },
      "startWith": [ { "column": "id", "operator": "EQ", "value": "{{rootId}}" } ],
      "maxDepth": "{{maxDepth}}" } } }
}
```

Run it with `{ "variables": { "rootId": 1, "maxDepth": 5 } }`.

### Composition

AST analytics compose sub-queries via `with[]` (CTE-style) and `recursive` in the
query AST — see [metadata-manifests.md](metadata-manifests.md#view--materialized_view)
for the `with` shape, which the query AST shares.

### Why AST

The planner chooses pushdown/federation automatically, queries may span **multiple
sources**, and governance (policies/masking) is applied per leg. To see the SQL an
AST compiles to, use `POST /api/queries/transpile` (preview only).
