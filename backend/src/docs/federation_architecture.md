# Zero Data Fabric — Federated Query Architecture

This document explains how the fabric executes queries across one or many
heterogeneous data sources **efficiently** — pushing work down to each source
instead of fetching everything into the application and filtering/aggregating in
memory.

## 1. Design principle: push work down, merge little

The single most important rule: **the fabric should move as few rows as
possible.** Every technique below exists to make each source return the smallest
possible result before anything is combined centrally.

- If a query can be answered by **one** source (or by Postgres/Citus + FDW
  foreign tables), it is compiled to **one SQL statement** and the source's own
  planner does the work. Citus already provides distributed, memory-managed
  execution for the hub.
- If a query spans **multiple** sources, each leg is fetched with **maximum
  pushdown** (predicate, projection, sort, limit, bind-join keys, partial
  aggregates) and the fabric only merges bounded partial results.

## 2. The execution pipeline (operator model)

```
Scan(source, pushdown)  →  [PartialAggregate]  →  Combine(SetOp | HashJoin)  →  [FinalAggregate]  →  Order/Limit
```

Each stage is a bounded operator over row batches. This shape is deliberately
**distribution-ready**: the `Scan`/`Combine` seam (in `federation.ts`,
`fetchLegDirect` → set-op/join) is where a future distributed / columnar /
Arrow-based worker runtime would plug in. Today the merge runs in a single Node
process, which is correct because pushdown keeps the merged data tiny.

**On "a distributed memory engine":** it is the right north star, but building a
Spark/Trino-class runtime in Node is unwarranted here. Citus already distributes
hub SQL; partial-aggregate + bind-join pushdown keep in-fabric memory small. The
pragmatic path is to keep pushing work to the sources and keep the operator seam
clean so a distributed executor can be swapped in later without changing the
planner or connectors.

## 3. Planner: choosing a strategy (`planner.ts`)

`QueryPlanner.classify` resolves every referenced resource to its engine +
sync mode via the catalog and picks:

| Strategy | When | How executed |
|---|---|---|
| `SINGLE_LOCAL` | all legs resolve in the tenant Postgres schema (local / FDW / synced) **and** ≤1 distinct source | one SQL via `QueryTranspiler` → Postgres/Citus/FDW |
| `SINGLE_CONNECTOR` | one connector-only source, no joins/set-ops | push the whole query (incl. aggregate) to that connector |
| `CROSS_ENGINE` | legs span >1 distinct source, or a join/set-op crosses the boundary | `FederationExecutor` |

Multi-*distinct*-source queries are routed to `CROSS_ENGINE` even when both are
Postgres, to avoid cross-source table-name collisions and full FDW scans.

## 4. Pushdown compiler (`pushdown.ts`)

Translates a canonical query shape into engine-native, **parameterized** requests:

- **SQL** (`postgres` `$n`/`"id"`, `mysql`/`snowflake` `?`/quoted): `WHERE`,
  projection, `ORDER BY`, `LIMIT/OFFSET`, and `GROUP BY` + aggregate `SELECT`.
- **MongoDB**: `find(filter, projection).sort().skip().limit()`, or a `$group`
  aggregation pipeline (`toMongoAggregate`).
- **Elasticsearch** (in the connector): query-DSL filter/sort/`_source`/size, or
  `terms` + metric sub-aggregations.

Operator vocabulary: `$eq $ne $gt $gte $lt $lte $like $ilike $in`.

## 5. Federated JOIN (`federation.ts` → `executeJoin`)

For a cross-engine join the fabric does **not** fetch whole tables. It:

1. **Attributes** each `WHERE` conjunct to its leg (by alias) and pushes it down.
2. **Transitively propagates** equality constants across equijoin keys:
   `c1.id = 5` + `c1.id = c2.id` ⟹ push `c2.id = 5` to the other source too.
3. **Bind join (semi-join):** fetches the filtered driving side, collects its
   distinct join-key values, and pushes `key IN (…)` to the other side so it only
   returns rows that can match.
4. **Hash-joins** the (tiny) results in memory, output columns **alias-qualified**
   so two same-named tables don't overwrite each other.

Worked example — *find one customer by id across two sources*:
`ds1.customer c1 JOIN ds2.customer c2 ON c1.id=c2.id WHERE c1.id=5` →
ds1 gets `WHERE id=5` (1 row), ds2 gets `WHERE id IN (5)` (1 row), join → 1 row.

## 6. Multi-source aggregation (`aggregate.ts`)

The **partial-aggregate split**: push a partial aggregate to each source, merge
in the fabric. Each source returns **#groups rows, not #rows**.

| Aggregate | Partial (per source) | Final merge |
|---|---|---|
| COUNT(*) / COUNT(c) | COUNT … GROUP BY g | SUM of partials |
| SUM(c) | SUM(c) | SUM |
| MIN/MAX(c) | MIN/MAX(c) | MIN/MAX |
| AVG(c) | SUM(c) + COUNT(c) | ΣSUM / ΣCOUNT |
| COUNT(DISTINCT c) | distinct keys per source | merge set, count (cap-and-warn) |

- **Fan aggregate** (same aggregate over a UNION of sources): `fanAggregate`
  pushes `partialSpec` to each leg then `mergePartials`.
- **Post-join aggregate**: join first (bind-join optimized), then `aggregateRaw`
  on the bounded joined result.
- **Single-source aggregate**: pushed whole to that one source/connector.

## 7. Safety & bounds (never silent)

- `FABRIC_FED_MAX_ROWS_PER_LEG` (default 50000): per-leg fetch cap; a leg that
  hits it is truncated **with a warning** in the response `warnings[]`.
- `FABRIC_FED_BIND_MAX_KEYS` (default 1000): above this, a bind-join falls back to
  a bounded scan **with a warning**.
- The industrial safety shield rejects unrestricted `SELECT/UPDATE/DELETE`
  (no filter, no limit, no aggregate).
- Every query returns a `plan` (strategy + what was pushed) and `warnings` so the
  behavior is observable in the workbench Query-Plan panel.

## 8. Connector matrix

| Engine | Read | Pushdown | Aggregates | Sync modes |
|---|---|---|---|---|
| Postgres | ✅ | ✅ | ✅ (SQL) | VIRTUAL (FDW) / SYNC / CDC |
| MySQL | ✅ | ✅ | ✅ (SQL) | SYNC; testConnection + DDL dispatch |
| MongoDB | ✅ | ✅ | ✅ (`$group`) | SYNC |
| Elasticsearch | ✅ (read + write sink) | ✅ (query-DSL) | ✅ (`terms`+metrics) | VIRTUAL |
| Snowflake | ✅ (via `snowflake-sdk`) | ✅ (SQL) | ✅ (SQL) | external |

## 9. Known limitations / next milestones

- Cross-engine `RIGHT`/`FULL` join executes as `INNER` (warned).
- `COUNT(DISTINCT)` across sources is exact only up to the distinct-key cap.
- Aggregation is not yet pushed *through* a cross-engine join (join then
  aggregate). Pushing partial aggregates below the join is a future optimization.
- The in-fabric merge is single-process; the operator seam is ready for a
  distributed/columnar executor when data volumes require it.
