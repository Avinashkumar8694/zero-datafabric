# Analytics & Query Engine API

The endpoints that execute queries against the fabric — AST queries (planner +
federation) and native SQL (executed at the owning source). This guide covers the
request/response shape of each; the **query language itself** is documented in
[query-language.md](query-language.md) and
[recursive-and-window-queries.md](recursive-and-window-queries.md).

There are two families:

- **AST mode** — engine-agnostic `queryConfig`; the planner pushes work down and
  federates across sources. Use `/api/analytics/query` (or `/api/queries/engine`).
- **SQL mode** — native SQL run at one source (window functions, recursive CTEs,
  matview reads). Use `/api/queries/exec`.

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

## SQL mode & the low-level engine

### POST `/api/queries/exec` — native SQL at a source (or the hub)

**Purpose:** run native SQL. When `source` names an external SQL engine
(Postgres/MySQL/Snowflake), the SQL executes **at that engine** — this is the
path for window functions, recursive CTEs and materialized-view reads. Omit
`source` (or use `Fabric_Hub_Postgres`) to run on the hub.

**Body:** `{ sql, source?, schema?, params?, async? }`

```bash
curl -s "${H[@]}" http://localhost:4000/api/queries/exec -d '{
  "source": "Retail_Core", "schema": "public",
  "sql": "SELECT status, count(*) FROM orders GROUP BY status ORDER BY 2 DESC" }'
```

**Success (`200`)** — for a source-routed query, the standard envelope with
`plan.strategy = "SINGLE_CONNECTOR_RAW"` and a one-leg trace (`operation: "raw-sql"`).
For a hub query, `{ "results": [ … ] }`.

**Async form** — add `"async": true` (hub only) → `202 { "queryId": "…", "status": "ACCEPTED" }`, then poll `GET /api/queries/jobs/:id` (alias `/api/queries/status/:id`).

**Errors:** `403` if tenant suspended; `500` on SQL/execution error.

See [recursive-and-window-queries.md](recursive-and-window-queries.md) for a full
cookbook of what to send here.

### POST `/api/queries/native` — SQL directly against the hub Postgres

**Purpose:** run SQL against the hub without connector routing. Returns
`{ results, rowCount }`.

```bash
curl -s "${H[@]}" http://localhost:4000/api/queries/native -d '{
  "sql": "SELECT now() AS ts" }'
# → { "results": [ { "ts": "2026-07-12T…" } ], "rowCount": 1 }
```

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
"see SQL mode" toggle in the AST builder. Does **not** execute anything.

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

## AST vs SQL — which to use

| You want… | Use |
|-----------|-----|
| Filter / project / sort / aggregate / join / set-op, possibly cross-source | **AST** — `/api/analytics/query` |
| Window functions, recursive CTEs, matview reads at one SQL engine | **SQL** — `/api/queries/exec` with `source` |
| A quick SQL run against the hub | `/api/queries/native` |
| To preview the generated SQL without running it | `/api/queries/transpile` |

Every executed query (both families) is captured in the audit trail — inspect it
via [observability-api.md](observability-api.md). To save and re-run a
parameterized query, see [saved-analytics-api.md](saved-analytics-api.md).
