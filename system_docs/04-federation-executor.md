# 04 — Federation executor

Executes `CROSS_ENGINE` (and `SINGLE_CONNECTOR`) queries: fetch each leg from its
own engine with maximum pushdown, then merge bounded results in-fabric. Three
merge shapes: **join**, **set operation**, **partial aggregate**.

## Cross-engine JOIN (bind-join / semi-join)

Instead of fetching both tables whole, the driving side is fetched first (with its
predicates), its join keys are collected, and `key IN (…)` is pushed to the other
source — so the second engine returns only rows that can match.

```mermaid
sequenceDiagram
  autonumber
  participant FED as FederationExecutor
  participant A as Driving source (e.g. Postgres orders)
  participant B as Probe source (e.g. Mongo web_events)

  Note over FED: buildLegFilters(): attribute WHERE to legs +<br/>transitively propagate equijoin constants
  FED->>A: SELECT * FROM orders WHERE customer_id = 42   (pushed)
  A-->>FED: driving rows (bounded)  ➜ trace leg "join-driving"
  FED->>FED: collect distinct join keys from driving rows
  alt keys ≤ FABRIC_FED_BIND_MAX_KEYS
    FED->>B: find({ customer_id: { $in: [42] } })         (bind-join)
    B-->>FED: only matching rows  ➜ trace leg "bind-join"
  else too many keys
    FED->>B: bounded full fetch (warned)
  end
  FED->>FED: in-memory hash join on alias-qualified keys
  FED-->>FED: merged rows (INNER/LEFT)
```

**Transitive predicate propagation:** a constant on one side of an equijoin
(`o.customer_id = 42` with join `o.customer_id = w.customer_id`) is propagated to
the other side (`w.customer_id = 42`) via union-find over the join keys — so
*both* sources are filtered before any fetch.

**Guarantees & limits:** output columns are alias-qualified to avoid collisions;
cross-engine `RIGHT`/`FULL` run as `INNER` (warned); each leg is capped at
`FABRIC_FED_MAX_ROWS_PER_LEG`.

## Set operations (UNION / INTERSECT / EXCEPT)

```mermaid
flowchart LR
  L1[leg 1 → source A<br/>pushed filter+projection] --> M{merge}
  L2[leg 2 → source B<br/>pushed filter+projection] --> M
  M -->|UNION| U[distinct union]
  M -->|INTERSECT| I[rows in all legs]
  M -->|EXCEPT| E[leg1 minus rest]
```

Rows are compared by a stable serialization of sorted key/value pairs. (Mongo
projections drop the implicit `_id` so projected rows match relational rows.)

## Multi-source partial aggregate

For a `union` of aggregate legs, a **partial** aggregate is pushed to each source
and merged — each source returns *#groups* rows, not *#rows*.

```mermaid
flowchart TD
  Q["GROUP BY g, AVG(x)…"] --> S[partialSpec: rewrite AVG → SUM + COUNT]
  S --> A[source A: GROUP BY g → partial SUM,COUNT per group]
  S --> B[source B: GROUP BY g → partial SUM,COUNT per group]
  A --> M[mergePartials by group key]
  B --> M
  M --> R["final: SUM=ΣSUM, COUNT=ΣCOUNT,<br/>AVG=ΣSUM/ΣCOUNT, MIN/MAX=min/max"]
```

| Aggregate | Pushed per source | Final merge |
|-----------|-------------------|-------------|
| `COUNT` | `COUNT … GROUP BY g` | Σ |
| `SUM` | `SUM(x)` | Σ |
| `MIN`/`MAX` | `MIN`/`MAX(x)` | min / max |
| `AVG` | `SUM(x)`, `COUNT(x)` | ΣSUM / ΣCOUNT |
| `COUNT_DISTINCT` | distinct keys per group | merge set, count |

## Aggregate after a cross-engine join

The join runs first (bind-join optimized); the bounded joined result is then
aggregated in-fabric (`post-join aggregate`).

Implementation: `backend/src/modules/query-engine/federation.ts` (+
`aggregate.ts`). Runnable proof: `examples/distributed-retail/03-analytics-suite.js`.
