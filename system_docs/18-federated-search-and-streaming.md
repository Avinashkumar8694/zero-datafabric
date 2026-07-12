# 18 · Federated Search Model, Bottom-Up Evaluation & Streaming

> Research note. How the fabric searches across multiple data sources today, why the
> execution order is already *bottom-up* but the plan is *flat*, and a design for two
> complementary optimizations: (A) a recursive bottom-up plan tree, and (B) row
> **streaming** node-to-node and to the client (`stream: true|false`). Grounded in the
> live leg traces captured from `/api/analytics/query`.

---

## 1. How the fabric searches multiple sources today

Path: `QueryEngineService.executeQuery` → `QueryPlanner.classify` → `FederationExecutor.execute`.

1. **`collectRefs`** walks the AST tree (recursing into set-ops and CTE bases) and enumerates every `(source, resource)` **leaf**.
2. **`classify`** resolves each leaf's engine from the catalog and picks a strategy:
   - `SINGLE_LOCAL` — all legs reachable in the hub Postgres → one SQL statement (Postgres/Citus/FDW optimizes).
   - `SINGLE_CONNECTOR` — one connector-only source, no join/set-op → one pushdown SELECT.
   - `CROSS_ENGINE` — multiple sources, or a join/set-op crossing the hub↔connector boundary → `FederationExecutor`.
3. **`execute`** dispatches on the **top-level AST shape** and combines the leaf results in-fabric.

### The physical operator order IS bottom-up

The `plan.pushed` trace from a real `JOIN ⋈ + AGGREGATE + HAVING + ORDER` (An_Lab, two Mongo collections) reads leaves-first, root-last:

```
1. federated across 1 sources [engines: MONGODB]
2. bind-join: pushed 2 key(s) as id IN (...) to An_Lab.departments
3. post-join aggregate: grouped 5 joined rows by [e.dept_id]
4. HAVING applied in-fabric on 2 group(s) → 2
legs:
   • join-driving  An_Lab(MONGODB) 5r :: db.employees.find({ filter:{}, limit:50000 })
   • bind-join     An_Lab(MONGODB) 2r :: db.departments.find({ id:{$in:[10,20]}, limit:50000 })
```

Order = **Scan(leaves) → Combine(join/set-op) → PostAggregate → Having → Project → Order/Limit.** That is the standard bottom-up physical plan: work is pushed to the leaves, results bubble up.

### What is pushed to the leaves (the efficiency lever that already works)

- Predicates / projection / sort / limit → the source (`WHERE`, `$match`, ES query DSL).
- **Partial aggregates** (`COUNT/SUM/MIN/MAX/AVG`) → each source returns *#groups* rows, merged in-fabric.
- **Bind-join** — the driving leg's keys are pushed to the probe leg as `id IN (...)` (a semi-join), so the probe source only returns matching rows.
- **Set-op limit** — `UNION LIMIT n` pushes `LIMIT n` to each leg (top-n per leg ⊇ global top-n).

---

## 2. Bottom-up: yes in order, no in structure

The order is bottom-up, but the **plan is flat**, not a recursive tree. `execute` hand-dispatches a *single* top-level combining operator:

| Requested shape | Executes? | Evidence (live) |
|---|---|---|
| filter / project / sort / limit | ✅ pushed to source | `SINGLE_CONNECTOR` |
| aggregate + GROUP BY + HAVING | ✅ partial-agg or post-join | `+AGGREGATE(+HAVING)` |
| window RANK/PARTITION BY | ✅ computed in-fabric over base | `SINGLE_CONNECTOR+WINDOW` |
| **window over a join** | ✅ composes (join → then window) | `CROSS_ENGINE+WINDOW`, 5 rows |
| join-chain + bind-join | ✅ left-driven hash join | `join-driving` + `bind-join` legs |
| set-op (UNION/INTERSECT/EXCEPT) | ✅ scan legs → combine | `CROSS_ENGINE` |
| **CTE (WITH) cross-engine** | ⚠️ **transpile only** — not executed in-fabric | returns SQL text, no rows |
| subquery in FROM / nested set-op-of-joins | ❌ not modeled | — |

So the engine composes a **known set of single-level stacks** (join→aggregate→having→order; join→window) through explicit code in `execute()`. It is **not** a general evaluator that walks an arbitrary AST tree node-by-node. The user's instinct is correct: *the AST is a tree, so the natural model is a recursive bottom-up evaluator where each node runs after its children.*

### Why full materialization shows up

Every operator reads its **entire** input into a JS array before emitting: the driving leg buffers up to the `FABRIC_FED_MAX_ROWS_PER_LEG` cap (50000), the hash-join builds a full `Map`, aggregate/having/sort/dedup all buffer. This is simple and correct, and the per-leg cap prevents OOM — but peak memory ≈ sum of all materialized intermediates, and the client waits for the whole result (see §8-memory of doc 14, and the CROSS_ENGINE memory analysis).

---

## 3. Optimization A — a recursive bottom-up plan tree

Turn the flat dispatch into a **physical plan tree** mirroring the AST, evaluated depth-first (children before parents). Two viable models:

### A1. Volcano / iterator model (classic)
Each operator is a node exposing `open() / next() / close()` (or an async generator). Leaves are source scans; internal nodes (`HashJoin`, `Aggregate`, `Window`, `SetOp`, `CteRef`, `Sort`, `Limit`) pull rows from their children. Pushdown is a planner rewrite that shoves `Filter`/`Project`/`Limit`/`PartialAggregate` **down** the tree toward each leaf until the source can no longer absorb it. This is how Trino/Presto and Calcite-based engines work. It naturally supports arbitrary nesting **and** streaming (§4).

### A2. Materialize-to-hub-temp-tables, then one SQL (pragmatic)
For a cross-engine tree, an **exchange operator** writes each connector leg's (pushed-down) result into a temporary table in the hub Postgres, then rewrites the *rest* of the tree — CTEs, joins, `RANK() OVER (PARTITION BY …)`, `HAVING`, recursive CTEs — as **one SQL statement over those temp tables**, executed by Postgres/Citus.

This is attractive because it **immediately unlocks the current gaps** (cross-engine CTE, window-over-join-over-setop, arbitrary nesting) by delegating the hard "combine" to a mature SQL executor, and the temp table *is* the DB-spill substrate streaming wants (§4). Cost: a materialization round-trip per leg. Best when the combine is complex; A1 is better when the combine is simple and the win is early-termination.

**Recommendation:** A2 as the near-term unlock for nested/CTE/window cross-engine queries (reuse `QueryTranspiler` for the hub SQL); evolve the pipelineable segments toward A1 iterators for streaming.

---

## 4. Optimization B — streaming (`stream: true | false`)

Today an operator returns `any[]`; nothing flows until it is complete, and the whole envelope is buffered before the HTTP response is sent. Streaming replaces `any[]` with an **async row stream** between nodes and, optionally, to the client.

### 4a. Node-to-node streaming (intra-query)
Replace the array boundary with `AsyncIterable<Row>` (async generators). Operators split into two classes:

| Class | Operators | Streams? |
|---|---|---|
| **Pipelineable (non-blocking)** | Scan, Filter, Project, Limit, bind-join *probe* side | ✅ emit rows as they arrive; `LIMIT` early-terminates upstream (stops the scan) |
| **Blocking (pipeline breakers)** | Sort, Aggregate/GROUP BY, DISTINCT/dedup, Window (per-partition), hash-join *build* side, bind-join *driving* side (must collect keys) | ⚠️ must buffer their working set before emitting the first output row |

So streaming shrinks peak memory and time-to-first-row for the **pipelineable segment below the lowest blocking operator**, and enables early-exit on `LIMIT`. A blocking operator still buffers its working set — but only *that* set, not the whole downstream.

### 4b. Where the buffer lives — memory vs DB
- **Memory** (async iterators, bounded batches): lowest latency; use for pipelineable flow and small blocking sets.
- **DB / disk spill** (temp table on the hub, or a spill file): for large blocking intermediates (big join build side, large sort). Trades heap for I/O, bounds memory, and — via A2 — lets Postgres do the sort/aggregate/window efficiently. This is the "stream node-to-node via DB" idea: the exchange operator's temp table doubles as the spill + the combine substrate.

### 4c. Response streaming (to the client)
With `stream: true`, emit rows to the HTTP response as the root operator produces them — **NDJSON** (one JSON object per line) or **SSE/chunked** — so a caller sees the first rows without waiting for the full result. The `plan`/`legs` trace (needed for the audit log) is sent as a **final trailer event** after the last row, and `QueryLogService.capture` records it exactly as today.

### 4d. The config
```jsonc
// per-query, in the queryConfig
{ "type": "SELECT", "stream": true, "limit": 100000, "query": { … } }
```
- `stream: false` (default) — current behaviour: buffered `{ data, rowCount, plan, warnings }` envelope. Keep as default because the UI table, saved-analytics, and the audit modal expect the full envelope, and blocking-heavy queries (sort/aggregate) gain little.
- `stream: true` — NDJSON/SSE row stream + trailer. Shines for large scans with filter/project/limit and cross-engine UNION; a query dominated by a top-level `ORDER BY`/aggregate still blocks until that operator finishes (be honest about this in the response — streaming is not a universal speedup).

Global default and transport via env (e.g. `FABRIC_STREAM_DEFAULT=false`, `FABRIC_STREAM_FORMAT=ndjson`).

---

## 5. Honest limits & interactions

- **Streaming ≠ free.** A query whose *root* is a blocking operator (final `ORDER BY`, top-level aggregate, `DISTINCT`) cannot emit its first row until that operator drains its input. Streaming helps the sub-pipeline, not the barrier.
- **Bind-join is inherently semi-blocking:** the driving leg must be materialized to collect the `IN (…)` keys before the probe leg is fetched. The probe side and everything above a non-blocking parent can still stream.
- **Order preservation:** streaming must preserve `ORDER BY`; a parallel/streamed merge needs a k-way merge if legs are pre-sorted, else it stays blocking.
- **Backpressure & cancellation:** an async-iterator pipeline gives natural backpressure and lets a client disconnect early-terminate upstream scans (freeing source cursors) — a real efficiency win the array model can't offer.
- **Audit parity:** the `plan.legs` trace, TAT and memory telemetry must be emitted as a trailer in stream mode so `query_logs` stays complete.

---

## 6. Phased roadmap & status

1. **Plan tree (A2)** — *not yet built.* An `Exchange` operator that materializes connector legs to hub temp tables + rewrites the residual tree to one hub SQL via `QueryTranspiler`. Unlocks cursor-blocking cross-engine **CTE / window / rank / arbitrary nesting**.
2. **Async-iterator leaves + pipelineable ops (A1)** — ✅ **DONE for pass-through scans.** `stream_source.ts` streams a single-source scan (hub Postgres via `pg-query-stream`, remote-Postgres connector, or MongoDB cursor) in bounded batches; `LIMIT` early-terminates the source cursor and a client disconnect cancels it. Blocking shapes fall back.
3. **`stream: true` response (NDJSON)** — ✅ **DONE** on `/api/analytics/query` + `/api/queries/exec`: rows as NDJSON, `plan`/`legs` as a `{__meta__}` trailer, `QueryLogService` records the (now bounded) memory. Config: `FABRIC_STREAM_INTERNAL`, `FABRIC_STREAM_DEFAULT`, `FABRIC_STREAM_BATCH`, `FABRIC_STREAM_HIGHWATER` (see `config/stream-config.ts`).
4. **DB-spill for blocking ops** — *not yet built.* Spill large sort/join-build sets to hub temp tables (reuse the A2 exchange), bounding memory for very large blocking intermediates.

**Implemented today:** internal cursor streaming for pass-through scans (Phase 2) + NDJSON response streaming (Phase 3), config-gated and backward-compatible (default `stream:false`; blocking shapes fall back to compute-then-stream; measured ~4.5× lower `memDeltaKb` on a 50k-row scan, widening with size). **Remaining:** Phases 1 & 4 (temp-table exchange + spill) for streaming/unblocking the *blocking* cross-engine shapes.

---

## 7. TL;DR

- The fabric **already executes bottom-up** (leaves pushed down, results combined upward) and pushes filters/projection/partial-aggregates/bind-join/limit to sources.
- It is **flat, not recursive**: it composes a fixed set of single-level operator stacks; **cross-engine CTE only transpiles**, and arbitrary nesting isn't modeled.
- It **fully materializes** every intermediate (bounded by the per-leg cap) and buffers the whole response.
- Two complementary upgrades: **(A) a recursive bottom-up plan tree** — pragmatically via *materialize-legs-to-hub-temp-tables + one SQL* (`QueryTranspiler`), which also unlocks the CTE/window/rank gaps — and **(B) streaming** — async-iterator node-to-node flow with `LIMIT` early-termination, optional DB-spill for blocking operators, and a `stream: true|false` NDJSON/SSE response mode (default off, with the audit trace sent as a trailer).
