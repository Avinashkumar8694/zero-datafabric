# Core concepts

## Sources & resources

- **Source** — a registered external database (e.g. `Retail_Core` = a PostgreSQL
  DB, `Web_Analytics` = a MongoDB DB). The hub itself is the implicit source
  `Fabric_Hub_Postgres`.
- **Resource** — a table, view, materialized view, or collection inside a source.
  You always refer to it by its **logical name**; the fabric maps it to the
  physical schema/table (or db/collection) via the catalog.
- **Sync type** — `VIRTUAL` (queried live through the connector — the default for
  external sources) or `SYNC`/`CDC` (replicated into the hub).

You reference data as `{ resource, source }`. Omitting `source` targets the hub.

## Planner strategies

When you run an AST query, the **planner** inspects every resource it references
and picks a strategy:

| Strategy | When | How it runs |
|----------|------|-------------|
| `SINGLE_LOCAL` | everything is in the hub Postgres | one SQL statement |
| `SINGLE_CONNECTOR` | exactly one external source | one pushed-down query to that source |
| `CROSS_ENGINE` | ≥2 distinct sources, or a join/set-op crossing the boundary | each leg pushed down independently, merged in-fabric |
| `SINGLE_CONNECTOR_RAW` | native SQL sent to one source (`/api/queries/exec` with `source`) | executed at that engine |
| `SINGLE_CONNECTOR_WRITE` | CRUD write to one external source | executed at that engine |

## Pushdown — the core idea

The fabric never "fetches everything and filters in the app". For each leg it
compiles the **maximum pushdown** the source supports:

- **Postgres / MySQL / Snowflake** → parameterized SQL with `WHERE`, column list,
  `ORDER BY`, `LIMIT`/`OFFSET`, and `GROUP BY` + aggregates.
- **MongoDB** → `find(filter, projection).sort().limit()` or a `$group` aggregation pipeline.

For cross-engine **joins**, a **bind-join** is used: the driving side is fetched
(with its predicates), its join keys are collected, and `key IN (...)` is pushed
to the other side — so the second source returns only rows that can match. A
constant on one side of an equijoin is **transitively propagated** to the other
side before any fetch.

For multi-source **aggregates**, a **partial aggregate** is pushed to each source
and merged in-fabric (`COUNT`→ΣCOUNT, `SUM`→ΣSUM, `AVG`→ΣSUM/ΣCOUNT, `MIN`/`MAX`→
min/max of partials). Each source returns *groups*, not rows.

## The execution trace

Every read/write returns a `plan` you can inspect:

```jsonc
"plan": {
  "strategy": "CROSS_ENGINE",
  "executionMs": 24,
  "rowsScannedAcrossSources": 4,     // total rows pulled from all sources
  "pushed": [ "human-readable notes" ],
  "legs": [
    { "source": "Retail_Core", "engine": "POSTGRES", "mode": "connector",
      "operation": "join-driving", "target": "public.orders",
      "query": "SELECT * FROM \"public\".\"orders\" WHERE \"customer_id\" = $1 LIMIT 50000",
      "params": [42], "rowsReturned": 2, "ms": 14 },
    { "source": "Web_Analytics", "engine": "MONGODB", "mode": "connector",
      "operation": "bind-join", "target": "retail.web_events",
      "query": "db.web_events.find({ filter: {\"customer_id\":{\"$in\":[42]}}, limit: 50000 })",
      "rowsReturned": 2, "ms": 10 }
  ]
}
```

**Read the trace to verify correctness:** if `rowsScannedAcrossSources` is small
while the tables are large, pushdown worked. Each `leg.query` is the actual
request the fabric sent to that engine.

## Safety rails

- A `SELECT` must have a `where`, a `limit`, or be a set-op — unrestricted
  full-table reads are blocked.
- `update` / `delete` (both AST and CRUD) require a filter.
- Every federated leg is capped (`FABRIC_FED_MAX_ROWS_PER_LEG`, default 50000);
  hitting the cap adds a `warnings[]` entry rather than silently truncating.
