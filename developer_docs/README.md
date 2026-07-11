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

| Guide | Contents |
|-------|----------|
| [concepts.md](concepts.md) | Core concepts: sources, resources, planner strategies, the execution trace envelope. |
| [query-language.md](query-language.md) | The AST query language — every clause and operator, joins, set-ops, aggregates, with examples. |
| [recursive-and-window-queries.md](recursive-and-window-queries.md) | Recursive CTEs, window functions, materialized views — native SQL executed at the source. |
| [crud-api.md](crud-api.md) | The simple `/api/data` fetch / create / update / delete endpoints. |
| [metadata-manifests.md](metadata-manifests.md) | Declarative schema management: every resource type, column strategy, constraint, index, RLS, trigger, relationship, downstream. |
| [connectors.md](connectors.md) | Per-engine reference: config, supported operations, pushdown behavior, quirks. |

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
