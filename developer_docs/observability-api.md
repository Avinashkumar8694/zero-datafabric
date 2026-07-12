# Observability API

Every query the fabric runs is captured in an execution audit trail, and every
schema/data change is recorded as an event. This guide covers reading that
telemetry back.

| Method | Path | Returns |
|--------|------|---------|
| GET | `/api/query-logs` | list of recent query runs (summary) |
| GET | `/api/query-logs/:id` | one run in full (legs, TAT, mem, strategy, warnings) |
| GET | `/api/events` | last 10 audit-log events for the tenant |
| GET | `/api/admin/audit-logs` | recent audit rows (**ADMIN**, see [admin-api.md](admin-api.md)) |

All endpoints require `Authorization` + `x-tenant-id`. Examples use the `H`
header array from [api-overview.md](api-overview.md#required-headers).

## How query logging is captured

Query execution is wrapped by a capture layer that measures wall-clock TAT and
heap delta, then records the full story from the result envelope — regardless of
which strategy the planner picked or whether the query succeeded. Logging is
**best-effort**: a failure to record never affects the query result. Both
successes and errors are logged (an error row carries `status: "ERROR"` and the
message).

Captured for every AST query, CRUD op, saved-analytic run, and source-routed SQL:
mode, query text (SQL or stringified AST), chosen `strategy`, the per-leg trace,
rows scanned across sources, pushdown notes, warnings, timing and memory.

---

## GET `/api/query-logs` — list runs

**Query params:** `limit` (1–1000, default 200), `status` (`SUCCESS`|`ERROR`),
`mode` (e.g. `SELECT_AST`, `CRUD_CREATE`, `SAVED_ANALYTIC`, `SQL_ON_SOURCE`, …).

```bash
curl -s "${H[@]}" "http://localhost:4000/api/query-logs?limit=50&status=SUCCESS&mode=SELECT_AST"
```

**Success (`200`):** array (newest first) of summary rows:

```jsonc
[
  {
    "id": "a1b2c3d4-…",
    "username": "admin", "role": "ADMIN",
    "api": "/api/analytics/query", "mode": "SELECT_AST",
    "source": "Retail_Core", "strategy": "CROSS_ENGINE", "status": "SUCCESS",
    "error": null,
    "rowCount": 4, "rowsScanned": 4,
    "executionMs": 24, "tatMs": 31, "memDeltaKb": 512,
    "createdAt": "2026-07-12T09:15:03.221Z"
  }
]
```

## GET `/api/query-logs/:id` — one run in full

**Purpose:** the detail view — everything in the summary plus `queryText` and the
full per-leg trace, plan, pushdown notes and warnings.

```bash
curl -s "${H[@]}" http://localhost:4000/api/query-logs/a1b2c3d4-…
```

**Success (`200`):**

```jsonc
{
  "id": "a1b2c3d4-…",
  "username": "admin", "role": "ADMIN", "api": "/api/analytics/query",
  "mode": "SELECT_AST", "source": "Retail_Core", "strategy": "CROSS_ENGINE",
  "status": "SUCCESS", "error": null,
  "queryText": "{\"type\":\"SELECT\",\"schema\":\"public\",\"query\":{…}}",
  "rowCount": 4, "rowsScanned": 4,
  "executionMs": 24, "tatMs": 31, "memDeltaKb": 512,
  "legs": [
    { "source": "Retail_Core", "engine": "POSTGRES", "mode": "connector",
      "operation": "join-driving", "target": "public.orders",
      "query": "SELECT * FROM \"public\".\"orders\" WHERE \"customer_id\" = $1 LIMIT 50000",
      "params": [42], "rowsReturned": 2, "ms": 14 },
    { "source": "Web_Analytics", "engine": "MONGODB", "mode": "connector",
      "operation": "bind-join", "target": "retail.web_events",
      "rowsReturned": 2, "ms": 10 }
  ],
  "plan": { "strategy": "CROSS_ENGINE", "executionMs": 24, "rowsScannedAcrossSources": 4, "legs": [ … ] },
  "pushed": [ "orders: WHERE customer_id = 42 pushed to POSTGRES", "web_events: customer_id IN (42) pushed to MONGODB" ],
  "warnings": [],
  "createdAt": "2026-07-12T09:15:03.221Z"
}
```

Field guide:

| Field | Meaning |
|-------|---------|
| `strategy` | planner choice: `SINGLE_LOCAL`/`SINGLE_CONNECTOR`/`CROSS_ENGINE`/`SINGLE_CONNECTOR_RAW`/… |
| `legs[]` | per-engine trace: `source`, `engine`, `operation`, `target`, exact `query` + `params`, `rowsReturned`, `ms` |
| `executionMs` | fabric-measured query time (from the plan) |
| `tatMs` | end-to-end turnaround time (wall clock) |
| `memDeltaKb` | heap growth during the run |
| `rowsScanned` | total rows pulled across all sources (pushdown health) |
| `pushed[]` | human-readable notes on what was pushed to each source |
| `warnings[]` | e.g. per-leg row-cap hits, degraded cross-engine joins |

**Errors:** `404 { "error": "query log not found" }` for an unknown id.

### Reading the trace

- **Pushdown health** — if `rowsScanned` is small while the underlying tables are
  large, filters/aggregates were pushed down correctly. A large `rowsScanned`
  with a small `rowCount` suggests work happened in-fabric.
- **Per-engine timing** — compare each `leg.ms` to find the slow source.
- **Correctness** — each `leg.query` is the literal request the fabric sent, so
  you can replay or explain it at the source.

---

## GET `/api/events` — recent audit events

**Purpose:** the last 10 schema/data audit-log events for the tenant — a
lightweight activity feed.

```bash
curl -s "${H[@]}" http://localhost:4000/api/events
```

**Success (`200`):**

```jsonc
[
  { "id": 421, "action": "CREATE_TABLE", "tableName": "customers",
    "createdAt": "2026-07-12T08:40:11.002Z", "details": { … } }
]
```

For the broader admin audit log (`GET /api/admin/audit-logs`) and platform
counts (`GET /api/admin/stats`), see [admin-api.md](admin-api.md).
