# API Overview

Everything an integrator needs to call the Zero Data Fabric REST API: base URL,
authentication, the headers every request carries, the standard response
envelope, the error contract, and a directory of every endpoint grouped by area.

## Base URL

```
http://localhost:4000
```

All application endpoints live under `/api`. An interactive OpenAPI/Swagger
reference is served at **`http://localhost:4000/api-docs`** (raw spec at
`/api-docs.json`).

Two unauthenticated health probes exist:

| Method | Path | Returns |
|--------|------|---------|
| GET | `/api/health` | `{ status, uptime, database:{ latency, pool } }` (503 if DB unreachable) |
| GET | `/health` | `{ status: "UP" }` (liveness) |

## Authentication

Get a token, then send it on every call. See
[authentication-and-tenancy.md](authentication-and-tenancy.md) for the full
flow (tenants, impersonation, multi-tenant token exchange).

```bash
curl -s http://localhost:4000/api/auth/login \
  -H 'Content-Type: application/json' \
  -d '{"username":"admin","password":"admin"}'
# → { "token": "eyJ…", "user": { "id": 1, "username": "admin", "tenant_id": "tenant_A" } }
```

## Required headers

| Header | Required | Applies to | Purpose |
|--------|:--:|-----------|---------|
| `Authorization: Bearer <jwt>` | ● | everything except `/api/auth/login` and the health probes | authenticates the caller; the token carries `tenant_id` and `internal_role` |
| `x-tenant-id: <tenant>` | ◐ | all data/query/governance calls | selects the active tenant. For an **ADMIN** token this **overrides** the token's tenant (cross-tenant operation). For a non-admin token it is informational — the tenant is taken from the token. |
| `Content-Type: application/json` | ● | any request with a JSON body | |
| `x-act-as-role: <ROLE>` | ○ | data/query/analytics/governance calls | **ADMIN only** — evaluate policies, grants and masking as if the caller had `<ROLE>`. Ignored for non-admin tokens. See [authentication-and-tenancy.md](authentication-and-tenancy.md#impersonation). |
| `x-region: <REGION>` | ○ | data/query calls | supplies the session `region` used by row policies (`{ session: 'region' }`). Defaults to `AP`. |

`●` required · `◐` required in practice · `○` optional

A convenient shell setup used throughout these docs:

```bash
TOKEN=$(curl -s http://localhost:4000/api/auth/login \
  -H 'Content-Type: application/json' \
  -d '{"username":"admin","password":"admin"}' | jq -r .token)

H=(-H "Authorization: Bearer $TOKEN" -H "x-tenant-id: tenant_A" -H "Content-Type: application/json")
```

## The standard query response envelope

Every read/write that runs through the query engine (`/api/analytics/query`,
`/api/data/*`, saved-analytic runs, `/api/queries/exec` against a source) returns
the same shape:

```jsonc
{
  "data": [ /* result rows */ ],
  "rowCount": 4,
  "warnings": [],                       // e.g. per-leg row-cap hits, degraded joins
  "plan": {
    "strategy": "CROSS_ENGINE",         // SINGLE_LOCAL | SINGLE_CONNECTOR | CROSS_ENGINE
                                        //  | SINGLE_CONNECTOR_RAW | SINGLE_CONNECTOR_WRITE | RAW_SQL
    "executionMs": 24,
    "rowsScannedAcrossSources": 4,      // total rows pulled from all sources
    "pushed": [ "human-readable pushdown notes" ],
    "legs": [
      { "source": "Retail_Core", "engine": "POSTGRES", "mode": "connector",
        "operation": "join-driving", "target": "public.orders",
        "query": "SELECT * FROM \"public\".\"orders\" WHERE \"customer_id\" = $1 LIMIT 50000",
        "params": [42], "rowsReturned": 2, "ms": 14 }
    ]
  }
}
```

Read the `plan` to verify correctness: if `rowsScannedAcrossSources` is small
while the tables are large, pushdown worked. Each `leg.query` is the actual
request the fabric sent to that engine. See
[concepts.md](concepts.md#the-execution-trace) for the full model.

> Mutations return `{ status, rowCount, returning, plan }`; async submissions
> return `202 { jobId, status }`; some low-level endpoints (`/api/queries/native`,
> the sync form of `/api/queries/exec`) return `{ results, rowCount }` without a
> full `plan`.

## Error format & status codes

Errors are always a JSON object with an `error` string:

```jsonc
{ "error": "SAFETY: update/delete require a \"where\" filter" }
```

| Status | Meaning | Typical triggers |
|--------|---------|------------------|
| `200` | success | reads, sync writes, transpile |
| `201` | created | new policy / constraint / grant / trigger / saved analytic |
| `202` | accepted (async) | `query-async`, async `exec`, `refresh-view`, trigger deploy/retry |
| `400` | bad request | missing required field, `SAFETY:` violation, `CONSTRAINT VIOLATION`, missing saved-analytic variable |
| `401` | unauthenticated | missing/invalid bearer token |
| `403` | forbidden | suspended tenant, `ACCESS DENIED` (grant enforcement), non-admin hitting `/api/admin` |
| `404` | not found | unknown id (job, saved analytic, policy, query log) |
| `500` | server error | unexpected failure (message echoed in `error`) |

Safety rails that surface as `400`: a `SELECT` must have a `where`, a `limit`, or
be a set operation; `update`/`delete` must include a non-empty `where`.

## Endpoint directory

All paths are prefixed with the base URL. Every endpoint below requires
`Authorization` (and, in practice, `x-tenant-id`) unless noted.

### Authentication — [guide](authentication-and-tenancy.md)

| Method | Path | Description |
|--------|------|-------------|
| POST | `/api/auth/login` | Username/password → bearer token (no auth required). |
| POST | `/api/auth/token` | Exchange current session for a tenant-scoped token. |

### Analytics & query engine — [guide](analytics-api.md)

| Method | Path | Description |
|--------|------|-------------|
| POST | `/api/analytics/query` | Run an AST `queryConfig` synchronously (planner + federation). |
| POST | `/api/analytics/query-async` | Submit an AST query for background execution → `{ jobId }`. |
| GET | `/api/analytics/jobs/:jobId` | Poll an async analytics job. |
| GET | `/api/analytics/query/status/:jobId` | Alias of the job-status poll. |
| POST | `/api/analytics/refresh-view` | Refresh a materialized view in the background. |
| POST | `/api/queries/engine` | Run an AST query via the low-level engine endpoint. |
| POST | `/api/queries/exec` | Execute native SQL at a `source` (or the hub); `async:true` → job. |
| POST | `/api/queries/native` | Run SQL directly against the hub Postgres. |
| POST | `/api/queries/transpile` | Preview the SQL the fabric would generate from an AST. |
| GET | `/api/queries/jobs/:id` · `/api/queries/status/:id` | Poll an async raw-SQL job. |

### Saved analytics — [guide](saved-analytics-api.md)

| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/saved-analytics` | List saved analytics for the tenant. |
| GET | `/api/saved-analytics/top` | Most-run analytics (`?limit=`). |
| POST | `/api/saved-analytics` | Create/replace a saved analytic (AST or SQL + variables). |
| GET | `/api/saved-analytics/:id` | Fetch one definition. |
| DELETE | `/api/saved-analytics/:id` | Delete one. |
| POST | `/api/saved-analytics/:id/run` | Run with `{{variable}}` values → query envelope. |

### Data CRUD — [guide](data-crud-api.md) · [crud-api.md](crud-api.md)

| Method | Path | Description |
|--------|------|-------------|
| POST | `/api/data/fetch` | Read rows (planner + pushdown). |
| POST | `/api/data/create` | Insert one or many. |
| POST | `/api/data/update` | Update rows matching a `where` (required). |
| POST | `/api/data/delete` | Delete rows matching a `where` (required). |
| POST | `/api/data/call` | Invoke a provisioned function/procedure. |
| POST | `/api/data/sequence` | Allocate `nextval` for any engine. |

### Governance — [guide](governance-api.md)

| Method | Path | Description |
|--------|------|-------------|
| GET · POST · DELETE | `/api/policies` · `/api/policies/:id` | Row predicates + column masking. |
| GET · POST | `/api/constraints` | NOT NULL / UNIQUE / ENUM / CHECK / FK compensation. |
| GET · POST | `/api/grants` | Table privileges (default-allow, ADMIN bypass). |

### Triggers — [guide](triggers-api.md)

| Method | Path | Description |
|--------|------|-------------|
| GET · POST | `/api/triggers` | List / create trigger definitions. |
| PUT · DELETE | `/api/triggers/:id` | Update / delete a trigger. |
| POST | `/api/triggers/:id/deploy` | Deploy (enqueue DDL / scheduler job). |
| GET | `/api/triggers/logs/list` | Execution log (`?triggerId=&limit=&offset=`). |
| GET | `/api/triggers/jobs/list` | Durable job queue. |
| POST | `/api/triggers/jobs/:id/retry` | Re-enqueue a job. |

### Observability — [guide](observability-api.md)

| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/query-logs` | Query audit trail (`?limit=&status=&mode=`). |
| GET | `/api/query-logs/:id` | Full detail: legs, TAT, mem, strategy, rows scanned, warnings. |
| GET | `/api/events` | Last 10 audit-log events for the tenant. |
| GET | `/api/admin/audit-logs` | Recent audit rows (ADMIN). |

### Metadata & manifests — [metadata-manifests.md](metadata-manifests.md)

| Method | Path | Description |
|--------|------|-------------|
| POST | `/api/metadata/diff` · `/api/metadata/apply` | Dry-run / apply a manifest (multipart `file`). |
| GET | `/api/metadata/export` | Export the live catalog as a manifest. |
| POST | `/api/metadata/crawl` | Introspect sources into the catalog. |
| GET | `/api/metadata/{sources,schemas,tables,columns,relationships,preview}` | Catalog browsing. |
| GET · POST | `/api/metadata/{history,rollback/:id,downstream,downstream/toggle}` | History & downstream sinks. |

### Admin — [guide](admin-api.md) — **requires an ADMIN token**

| Method | Path | Description |
|--------|------|-------------|
| GET · POST · PUT · PATCH · DELETE | `/api/admin/tenants` · `/:id` | Tenant lifecycle. |
| GET · POST · PATCH · DELETE | `/api/admin/connections` · `/:id` | Register / probe / remove datasources. |
| GET · POST · PUT · DELETE | `/api/admin/users` · `/:id` | User management. |
| GET | `/api/admin/stats` | Dashboard counts. |
| GET | `/api/admin/catalog` | Catalog summary (schemas/tables/row counts). |
| GET · POST · DELETE | `/api/admin/notification-channels` · `/:id` · `/test` | Notification channels. |

## Where to go next

- [authentication-and-tenancy.md](authentication-and-tenancy.md) — login, tenants, impersonation.
- [query-language.md](query-language.md) — the AST language every read speaks.
- [concepts.md](concepts.md) — sources, planner strategies, the execution trace.
