# 02 — Request lifecycle

End-to-end path of an AST query (`POST /api/analytics/query`).

```mermaid
sequenceDiagram
  autonumber
  participant C as Client
  participant API as Routes/Auth
  participant QES as QueryEngineService
  participant PLN as QueryPlanner
  participant CAT as Catalog (hub)
  participant FED as FederationExecutor
  participant PC as PushdownCompiler
  participant SRC as Source engine(s)

  C->>API: POST /api/analytics/query (JWT, x-tenant-id)
  API->>API: verify token, resolve tenant
  API->>QES: executeQuery(tenant, queryConfig)
  QES->>QES: safety check (where | limit | set-op)
  QES->>PLN: classify(ast)
  PLN->>CAT: resolve each {source, resource} → engine, sync, physical name
  PLN-->>QES: plan {strategy, legs, resolveMap}
  alt SINGLE_LOCAL
    QES->>SRC: one SQL on hub (Citus/FDW optimizes)
  else SINGLE_CONNECTOR / CROSS_ENGINE
    QES->>FED: execute(ast, plan)
    loop each leg
      FED->>PC: compile canonical → SQL / Mongo
      FED->>SRC: pushed-down query (filter / agg / IN keys)
      SRC-->>FED: bounded rows (+ record leg trace)
    end
    FED->>FED: merge (hash-join / set-op / partial-aggregate)
    FED-->>QES: {data, warnings, trace}
  end
  QES-->>API: {data, rowCount, plan{strategy, executionMs, legs}, warnings}
  API-->>C: JSON envelope
```

## Stages

1. **Auth & tenant** — JWT verified; `x-tenant-id` sets the tenant context used
   for catalog lookups and RLS.
2. **Safety** — SELECT without `where`/`limit`/set-op is rejected.
3. **Plan** — the planner resolves every referenced resource against the catalog
   and picks a strategy ([03-query-planner.md](03-query-planner.md)).
4. **Execute** — one hub SQL (SINGLE_LOCAL) or the federation executor
   ([04-federation-executor.md](04-federation-executor.md)); each leg compiled by
   the pushdown compiler ([05-pushdown-compiler.md](05-pushdown-compiler.md)).
5. **Envelope** — data + `plan` (strategy, total ms, per-leg trace) + warnings.

Native SQL (`/api/queries/exec`) and CRUD (`/api/data/*`) reuse stages 1–2 and 5;
their execution paths are in [06-crud-write-routing.md](06-crud-write-routing.md).
