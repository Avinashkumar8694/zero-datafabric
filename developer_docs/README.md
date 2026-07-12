# Zero Data Fabric — Developer Documentation

Everything you need to query and manage data across heterogeneous sources
(PostgreSQL, MySQL, MongoDB, Snowflake, Elasticsearch) through one uniform API.

## What the fabric does

You register external databases as **datasources**. You then query and mutate
them using **fabric terms** (resource, source, column) — regardless of the
underlying engine. The fabric:

- **pushes work down** to each source (filters, projections, sorts, limits,
  `GROUP BY` aggregates) instead of fetching whole tables and filtering in memory;
- **federates across sources** — cross-engine joins (bind-join), multi-source
  aggregates (partial-aggregate merge), and set operations (UNION/INTERSECT/EXCEPT);
- **runs complex native SQL at the owning engine** — window functions, recursive
  CTEs, materialized-view reads;
- returns an **execution trace** with every response, so you can see which engine
  ran what and how long it took.

## Documentation map

**Start here**

| Guide | Contents |
|-------|----------|
| [api-overview.md](api-overview.md) | Base URL, auth, required headers, the standard response envelope, error format + status codes, and a directory of **every** endpoint by area. |
| [authentication-and-tenancy.md](authentication-and-tenancy.md) | Login → JWT, tenant scoping, tenant-scoped token exchange, and ADMIN impersonation (`x-act-as-role`). |
| [concepts.md](concepts.md) | Core concepts: sources, resources, planner strategies, the execution trace envelope. |

**Querying**

| Guide | Contents |
|-------|----------|
| [query-language.md](query-language.md) | The AST query language — every clause and operator, joins, set-ops, aggregates, with examples. |
| [recursive-and-window-queries.md](recursive-and-window-queries.md) | Recursive CTEs, window functions, materialized views — native SQL executed at the source. |
| [analytics-api.md](analytics-api.md) | The query endpoints: `/api/analytics/query` (+async, jobs, refresh-view) and `/api/queries` (engine/exec/native/transpile); AST vs SQL modes. |
| [streaming-responses.md](streaming-responses.md) | `stream: true \| false` — buffered JSON envelope vs NDJSON row stream + `{__meta__}` trailer; processing, response shape, and curl/Node/browser client patterns. |
| [sync-and-cdc.md](sync-and-cdc.md) | Source sync strategies **VIRTUAL / SYNC / CDC** — how data is replicated into the hub, how new records are handled, watermark CDC config, the `/api/metadata/sync` endpoint, and the query-planner effect. |
| [saved-analytics-api.md](saved-analytics-api.md) | `/api/saved-analytics` CRUD + `/top` + `/:id/run`; `{{variable}}` binding, AST vs SQL saved configs, recursive+aggregate composition patterns. |

**Data & governance**

| Guide | Contents |
|-------|----------|
| [crud-api.md](crud-api.md) | The `/api/data` fetch / create / update / delete field reference and `where`-map operators. |
| [data-crud-api.md](data-crud-api.md) | Full `/api/data` surface including `call` and `sequence`, error-code mapping, governance & audit. |
| [governance-api.md](governance-api.md) | `/api/policies` (row predicates + masking), `/api/constraints`, `/api/grants`; AST vs SQL modes and the push-down / compensate / reject philosophy. |
| [metadata-manifests.md](metadata-manifests.md) | Declarative schema management: every resource type, column strategy, constraint, index, RLS, trigger, relationship, downstream. |
| [connectors.md](connectors.md) | Per-engine reference: config, supported operations, pushdown behavior, quirks. |

**Automation, operations & admin**

| Guide | Contents |
|-------|----------|
| [triggers-api.md](triggers-api.md) | `/api/triggers` CRUD, deploy, logs, jobs, retry; manifest triggers vs control-plane triggers. |
| [observability-api.md](observability-api.md) | `/api/query-logs` (list + detail: legs/TAT/mem/strategy/rows scanned/warnings), `/api/events`, and how query logging is captured. |
| [admin-api.md](admin-api.md) | `/api/admin` tenants, connections, users, stats, catalog, notification channels. |

Interactive API reference (OpenAPI/Swagger): **`http://localhost:4000/api-docs`**
(raw spec at `/api-docs.json`). Architecture & design: [`../system_docs/`](../system_docs/).
Runnable examples: [`../examples/distributed-retail/`](../examples/distributed-retail/).

## Authentication

All endpoints require:

```
Authorization: Bearer <jwt>
x-tenant-id: <tenant>
```

Get a token:

```bash
curl -s http://localhost:4000/api/auth/login \
  -H 'Content-Type: application/json' \
  -d '{"username":"admin","password":"admin"}'
# → { "token": "eyJ..." }
```

## 60-second tour

```bash
TOKEN=...   # from /api/auth/login
H=(-H "Authorization: Bearer $TOKEN" -H "x-tenant-id: tenant_A" -H "Content-Type: application/json")

# 1. Simple read (pushed down to the source)
curl -s "${H[@]}" http://localhost:4000/api/data/fetch \
  -d '{"source":"Retail_Core","resource":"customers","where":{"region":"EU"},"limit":3}'

# 2. Structured aggregate (GROUP BY pushed to the source)
curl -s "${H[@]}" http://localhost:4000/api/analytics/query -d '{
  "queryConfig":{"type":"SELECT","schema":"public","query":{
    "from":{"resource":"orders","source":"Retail_Core"},
    "groupBy":["status"],
    "select":["status",{"aggregate":"SUM","column":"total_amount","alias":"revenue"}]}}}'

# 3. Cross-engine join (Postgres ⋈ Mongo, bind-join)
curl -s "${H[@]}" http://localhost:4000/api/analytics/query -d '{
  "queryConfig":{"type":"SELECT","schema":"public","limit":20,"query":{
    "from":{"resource":"orders","source":"Retail_Core","alias":"o"},
    "joins":[{"type":"INNER","resource":"web_events","source":"Web_Analytics","alias":"w",
              "on":{"left":"o.customer_id","operator":"EQ","right":"w.customer_id"}}],
    "where":[{"column":"o.customer_id","operator":"EQ","value":42}]}}}'

# 4. Complex native SQL at the source (recursive CTE)
curl -s "${H[@]}" http://localhost:4000/api/queries/exec -d '{
  "source":"Retail_Core","schema":"public",
  "sql":"WITH RECURSIVE t AS (SELECT id,referred_by,1 lvl FROM customers WHERE referred_by IS NULL UNION ALL SELECT c.id,c.referred_by,t.lvl+1 FROM customers c JOIN t ON c.referred_by=t.id) SELECT lvl, count(*) FROM t GROUP BY lvl ORDER BY lvl"}'
```

Every response carries a `plan` describing how it ran — see
[concepts.md](concepts.md#the-execution-trace).
