# Analytics & Query Engine API

The endpoints that execute queries against the fabric — AST queries (planner +
federation). Querying is **AST-only**: raw SQL execution has been removed. This guide covers the
request/response shape of each; the **query language itself** is documented in
[query-language.md](query-language.md) and
[recursive-and-window-queries.md](recursive-and-window-queries.md).

All queries are engine-agnostic ASTs (`queryConfig`); the planner pushes work down
and federates across sources. Use `/api/analytics/query` (or `/api/queries/engine`).
Window functions, recursive queries and view reads are all expressed in the AST.

> **No raw SQL.** `POST /api/queries/exec` and `POST /api/queries/native` no longer
> exist (`404`), and request bodies carrying `sql` / `rawSql` / `nativeSql` /
> `rawQuery` (or a string `query`) on `/api/queries`, `/api/analytics`, `/api/data`
> and `/api/saved-analytics` are rejected with
> `400 { "error": "…", "code": "SQL_NOT_SUPPORTED" }`. Create or change schema/data
> via `POST /api/metadata/apply` (manifests) and `/api/data`. The only SQL endpoint
> left is `POST /api/queries/transpile`, a preview that never executes.

All endpoints require `Authorization` + `x-tenant-id`. Examples assume the `H`
array from [api-overview.md](api-overview.md#required-headers).

---

## AST queries

### POST `/api/analytics/query` — run an AST query (sync)

**Purpose:** run an engine-agnostic AST query; the planner picks a strategy
(`SINGLE_LOCAL` / `SINGLE_CONNECTOR` / `CROSS_ENGINE`) and returns the standard
envelope with a per-leg execution trace.

**Body:** `{ "queryConfig": { type, schema, limit?, query } }` — see
[query-language.md](query-language.md) for the full AST.

```bash
curl -s "${H[@]}" http://localhost:4000/api/analytics/query -d '{
  "queryConfig": { "type": "SELECT", "schema": "public", "query": {
    "from": { "resource": "orders", "source": "Retail_Core" },
    "groupBy": ["status"],
    "select": ["status", { "aggregate": "SUM", "column": "total_amount", "alias": "revenue" }]
  } } }'
```

**Success (`200`):**

```jsonc
{
  "data": [ { "status": "SHIPPED", "revenue": 128400 }, { "status": "PENDING", "revenue": 9120 } ],
  "rowCount": 2,
  "warnings": [],
  "plan": {
    "strategy": "SINGLE_CONNECTOR", "executionMs": 12, "rowsScannedAcrossSources": 2,
    "legs": [ { "source": "Retail_Core", "engine": "POSTGRES", "mode": "connector",
      "operation": "aggregate", "target": "public.orders",
      "query": "SELECT \"status\", SUM(\"total_amount\") AS \"revenue\" FROM \"public\".\"orders\" GROUP BY \"status\"",
      "rowsReturned": 2, "ms": 8 } ]
  }
}
```

**Errors:**

| Status | Body | Cause |
|--------|------|-------|
| `400` | `{ "error": "tenantId and queryConfig are required" }` | missing body |
| `400` | `{ "error": "SAFETY: SELECT requires a where, a limit, or a set operation" }` | unrestricted full-table read |
| `403` | `{ "error": "…suspended…" }` | tenant suspended |
| `500` | `{ "error": "<message>" }` | execution failure |

> ADMIN callers may add `x-act-as-role` to evaluate policies/masking as another
> role. See [governance-api.md](governance-api.md).

### POST `/api/analytics/query-async` — run an AST query (async)

**Purpose:** submit the same `queryConfig` for background execution — for
long-running federated queries you do not want to block on.

```bash
curl -s "${H[@]}" http://localhost:4000/api/analytics/query-async -d '{
  "queryConfig": { "type": "SELECT", "schema": "public", "limit": 100000, "query": {
    "from": { "resource": "orders", "source": "Retail_Core" } } } }'
```

**Success (`202`):** `{ "jobId": "b1e2…", "status": "PENDING" }`

Then poll:

### GET `/api/analytics/jobs/:jobId` (alias `/api/analytics/query/status/:jobId`)

```bash
curl -s "${H[@]}" http://localhost:4000/api/analytics/jobs/b1e2c3d4
```

Returns the job record; a completed job carries the same envelope under its
result. `404 { "status": "NOT_FOUND" }` if the id is unknown.

### POST `/api/analytics/refresh-view` — refresh a materialized view

**Purpose:** kick off a background `REFRESH MATERIALIZED VIEW`. Returns
immediately so the HTTP call never blocks on a long refresh.

```bash
curl -s "${H[@]}" http://localhost:4000/api/analytics/refresh-view -d '{
  "viewName": "mv_daily_region_sales", "schema": "public", "concurrent": true }'
```

**Success (`202`):** `{ "status": "accepted", "message": "View refresh initiated in background", "jobId": "…" }`

**Errors:** `400` if `viewName` missing; `403` if tenant suspended.

---

## The low-level engine & SQL preview

### POST `/api/queries/engine` — low-level AST executor

**Purpose:** the same AST execution as `/api/analytics/query`, exposed on the
`/api/queries` router. Accepts a bare config or `{ "config": … }`.

```bash
curl -s "${H[@]}" http://localhost:4000/api/queries/engine -d '{
  "type": "SELECT", "schema": "public", "limit": 5,
  "query": { "from": { "resource": "orders", "source": "Retail_Core" } } }'
```

### POST `/api/queries/transpile` — AST → SQL preview

**Purpose:** see the SQL the fabric *would* generate from an AST — powers the
"see SQL" preview in the AST builder. Preview only: it does **not** execute anything.

Accepts `{ config }` (a full `queryConfig`) or a bare AST `{ query }`.

```bash
curl -s "${H[@]}" http://localhost:4000/api/queries/transpile -d '{
  "config": { "type": "SELECT", "schema": "public", "limit": 10, "query": {
    "from": { "resource": "orders" },
    "where": [ { "column": "status", "operator": "EQ", "value": "SHIPPED" } ] } } }'
# → { "sql": "SELECT * FROM \"tenant_tenant_A_public\".\"orders\" WHERE \"status\" = 'SHIPPED' LIMIT 10;" }
```

Special cases (all `200`):
- A `CALL` config returns the `CALL fn(...)` / `SELECT * FROM fn(...)` form.
- A `recursive` query returns an explanatory comment — recursive traversal runs
  in-fabric level-by-level, so there is no single SQL statement.
- If transpilation fails, the response is still `200` with `{ "sql": "-- could not transpile…", "error": "<msg>" }`.

---

## Which endpoint to use

| You want… | Use |
|-----------|-----|
| Filter / project / sort / aggregate / join / set-op, possibly cross-source | `/api/analytics/query` |
| Window functions, recursive queries, view / matview reads | AST (see [recursive-and-window-queries.md](recursive-and-window-queries.md)) |
| The same AST executor on the `/api/queries` router | `/api/queries/engine` |
| To preview the generated SQL without running it | `/api/queries/transpile` |
| To create / change tables, views, functions | `POST /api/metadata/apply` (manifests) |
| To write rows | `/api/data` CRUD |

Every executed query is captured in the audit trail — inspect it
via [observability-api.md](observability-api.md). To save and re-run a
parameterized query, see [saved-analytics-api.md](saved-analytics-api.md).
