# 09 — Execution trace

Every read/write returns a `plan` describing exactly how it ran. This is the
fabric's observability contract and the proof that pushdown/federation behaved.

## Shape

```mermaid
classDiagram
  class QueryPlan {
    +string strategy
    +int executionMs
    +int rowsScannedAcrossSources
    +string[] pushed
    +LegTrace[] legs
  }
  class LegTrace {
    +string source
    +string engine
    +string mode
    +string operation
    +string target
    +string query
    +any[] params
    +int rowsReturned
    +int ms
  }
  QueryPlan "1" o-- "*" LegTrace
```

`operation` values: `scan`, `aggregate`, `join-driving`, `bind-join`,
`join-probe`, `partial-aggregate`, `union-leg` / `intersect-leg` / `except-leg`,
`single-sql`, `raw-sql`, `create` / `update` / `delete`.

## How it's produced

```mermaid
flowchart LR
  subgraph Federation
    FLD[fetchLegDirect] -->|time + record| T1[leg: source, engine, mode, op, query, rows, ms]
  end
  subgraph Local
    SQL1[single hub SQL] -->|time| T2[leg: single-sql]
  end
  subgraph Raw/Write
    RQ[connector.rawQuery / mutate] -->|time| T3[leg: raw-sql / write]
  end
  T1 & T2 & T3 --> PLAN[plan.legs] --> ENV[response envelope]
```

- Each leg is timed independently at the point of execution; `executionMs` is the
  wall-clock for the whole engine call.
- `query` is the **actual** pushed request (compiled SQL text or Mongo
  find/aggregate spec) — not a paraphrase — so it's copy-pasteable for debugging.
- `rowsScannedAcrossSources` = Σ `legs[].rowsReturned`: compare it to table sizes
  to confirm pushdown (small = good).

## Using it

- **Verify pushdown** — a filtered query should show a small `rowsReturned` per
  leg and the predicate inside `leg.query`.
- **Verify federation** — a cross-source join shows a `join-driving` leg and a
  `bind-join` leg with `IN (…)` / `$in`.
- **Diagnose latency** — per-leg `ms` isolates the slow source.
- **Audit** — the trace is the same for CRUD writes, so mutations show the exact
  SQL/op executed at the source.

The `examples/distributed-retail/*.js` suites assert against this trace to prove
correct behavior on every scenario.
