# 20 · Query Planning & Federated Execution — how a production data fabric decides

This is the reference for **how the fabric decides to run a query**: when it pushes the whole
thing to one database, when it decomposes into legs, how legs are prepared, in what order they
fire, and which join algorithm it picks. It first states how real production fabrics
(Trino/Starburst, Denodo, Dremio, Postgres FDW, Spark SQL) do it, then maps that to this
engine, with the exact decision matrix.

## 1. The universal pipeline (every production fabric)

```
SQL / AST ─▶ Parse ─▶ Bind & Resolve (catalog) ─▶ Logical plan ─▶ Optimize (RBO + CBO) ─▶ Physical plan ─▶ Execute
                                                     │                                      │
                                       rules: pushdown, predicate propagation,   operators: Scan/Filter/Join/
                                       column pruning, constant folding,         Aggregate/Sort/Limit, chosen
                                       join reorder; costs: cardinality,          per-source capability + cost
                                       selectivity, network, engine caps
```

The single most important optimization is **pushdown**: do work *in the source* (which has the
indexes, statistics, and is closest to the data) and move as few bytes as possible into the
fabric. Everything below is in service of that.

## 2. The first decision: single-source vs multi-source

**Resolve every referenced table** (`from`, every `join`, every set-op leg) to a physical
location — `(engine, host, port, database, schema, table)`. Then:

- **All legs on ONE physical database** (same connection fingerprint) **and** that engine
  speaks SQL → **push the entire statement down as ONE native query.** JOIN, GROUP BY,
  aggregates, HAVING, ORDER BY, LIMIT — all of it. The source's planner does the join with its
  indexes; the fabric just streams the result. This is *co-located* / *pushed* execution.
  - Trino calls this **pushdown into a single catalog**; Denodo calls it **full delegation**;
    Postgres FDW does it when all rels are on the same foreign server (**`postgres_fdw` join
    pushdown**).
  - **Key subtlety:** "same database", not "same server". Postgres/Oracle cannot join across
    two databases on one server; MySQL can. So the co-location fingerprint must include the
    database for PG/Oracle. Two *differently-named* fabric sources that point at the same DB
    are still co-located — fingerprint by connection, not by source name.

- **Legs span multiple databases/engines** → **decompose into legs and federate.** Now the
  fabric is a distributed executor and must choose a *join algorithm* and a *leg order*.

## 3. Multi-source: which join algorithm, and when

Real fabrics choose per-join from a small menu, driven by **cardinality + selectivity +
key-uniqueness + engine capability**:

| Algorithm | When it wins | How it runs | Cost |
|---|---|---|---|
| **Co-located / pushed join** | both sides same DB | one native SQL to that DB | cheapest — no data leaves the source |
| **Broadcast / bind (semi-join)** | one side **small & selective** (the *build* side), other large & indexed on the key | fetch the small side; push its keys as `IN (…)` / a temp filter to the big side | 2 round-trips; big side stays remote & index-probed |
| **Shuffle / hash join** | both sides **large**, no small side to broadcast | fetch both with max pushdown, build a hash table on the smaller, probe with the larger, in-fabric | memory ∝ smaller side; 2 parallel scans |
| **Sort-merge join** | both sides already **sorted on the key** (or cheaply sortable), very large | stream both ordered, merge | low memory, but needs ordering |
| **Nested-loop / index bind** | tiny driving side, indexed probe key | per-driver-row indexed lookup | only for very small driving cardinality |

Production rule of thumb (Trino/Spark): **broadcast when the build side fits a threshold, else
shuffle-hash; sort-merge only when inputs are pre-sorted.** The killer mistake — and exactly
the anti-pattern to avoid — is an **unbounded bind-join**: if the "small" driving side is
actually 10k+ rows, an `IN (…10k…)` or 10k point-lookups is the **N+1 problem**. Guard it with
a **bind-key cap**; above the cap, switch to a hash join.

## 4. Leg preparation, order, and dependencies

1. **Prepare each leg with maximum pushdown** — project only needed columns, push every
   sargable predicate, push `LIMIT` when semantically safe, push a *partial* aggregate.
2. **Predicate / transitive propagation** — `a.id = b.id AND a.id > 0` ⇒ also push `b.id > 0`.
   A join key equality lets a filter on one side seed the other. This shrinks both legs before
   any data moves.
3. **Driver selection** — the **most selective / smallest** leg is the driver (build side).
   Cardinality comes from catalog stats, a cheap `COUNT(*)` with the pushed filter, or a sample.
4. **Ordering & dependency** — a leg whose filter is *derived* from another leg's output (bind
   join) **must run after** its producer; independent legs (set-op branches, broadcast builds)
   run **in parallel**. The plan is a DAG: parallel where independent, sequenced on data deps.
5. **Semi-join reduction** — before a big join, reduce a side by the distinct join keys of the
   other (a bloom/`IN` filter) to cut rows early.

## 5. Aggregation & the operator pipeline

- **Partial aggregate + final merge** — push `GROUP BY g, COUNT/SUM/MIN/MAX/partial-AVG` to
  each source (each returns *#groups*, not *#rows*), then merge partials in the fabric. `AVG` →
  push `SUM` + `COUNT`, divide at the end. `COUNT(DISTINCT)` → push distinct keys, merge-count.
- **Pipeline** — `Scan(pushdown) → [PartialAgg] → Join(broadcast|hash|merge) → [FinalAgg] →
  Having → Sort → Limit`. Bounded operators, streamed batches, spill to disk if a hash side
  exceeds memory. Memory is O(build side / batch), never O(total).

## 6. The cost signals (what feeds the decisions)

`rowcount` (stats / `COUNT` / sample) · `selectivity` of each predicate · `distinct keys` /
key uniqueness · `network cost` (bytes × latency) · **engine capability** (can this source do
the join / aggregate / regex / window at all?). A fabric that lacks stats falls back to
**rule-based** heuristics: push everything pushable, broadcast the filtered side, cap bind
keys, hash otherwise.

---

## 7. How THIS fabric maps to the model

Strategies produced by `QueryPlanner.classify`:

| Strategy | Meaning | Executor |
|---|---|---|
| `SINGLE_LOCAL` | all legs resolve inside the tenant hub Postgres (local / FDW / synced) | one SQL via `QueryTranspiler` → hub (Postgres/Citus/FDW pushes to remotes) |
| `SINGLE_CONNECTOR` | one connector source, simple SELECT | one pushed SQL/Mongo/ES op via the connector |
| **`SINGLE_CONNECTOR` (co-located)** | **all legs same physical DB, SQL engine — incl. joins/group-by/set-ops** | **one native SQL pushed via `connector.rawQuery` (NEW)** |
| `CROSS_ENGINE` | legs span sources/engines | `FederationExecutor`: pushdown + predicate propagation + bind/hash join + partial-aggregate merge |

Federation already implements: per-leg pushdown (`PushdownCompiler`), transitive predicate
propagation, **bind-join with a key cap** (`FABRIC_FED_BIND_MAX_KEYS`, default 1000) that
**falls back to a left-driven hash join** above the cap, per-leg row cap
(`FABRIC_FED_MAX_ROWS_PER_LEG`, 50000), and partial-aggregate decomposition + merge.

### The gap this doc's change closes — IMPLEMENTED & verified
A JOIN where **every leg is the same physical database** was being sent to `CROSS_ENGINE`
(bind-join + in-fabric aggregation) instead of being pushed down as one native SQL — the
reported `Remote_PG` self-join case. Fix: `QueryPlanner.classify` now fingerprints each leg's
**connection** (`connFingerprint` = engine|host:port/database, or the connection string) and,
when all legs share one fingerprint on a SQL engine (POSTGRES/MYSQL/ORACLE/SNOWFLAKE) *and*
the query has joins/set-ops, classifies it `SINGLE_CONNECTOR` with `colocated=true`. The
executor (`query-engine.service.ts`) then calls `PushdownCompiler.toJoinSql` to compile the
full `JOIN + WHERE + GROUP BY + aggregates + HAVING + ORDER BY + LIMIT` to that engine's
dialect — every value **parameterized**, every identifier whitelist-quoted, every operator
mapped from a fixed table — and runs it in **one** `connector.rawQuery` round-trip.

Safety valves, in order: (1) grants are enforced per table; (2) if any involved table carries
a row-level policy or masking rule, it falls back to federation (which injects/masks); (3) any
unsupported construct (raw expression, full-text search, window fn, CTE, unknown operator)
throws inside the compiler and also falls back. **Co-location only ever changes speed, never
results.**

Verified live on the exact reported query: it now returns a single `colocated-pushdown` leg —
`SELECT "a"."value", COUNT(*) AS "n" FROM "public"."remote_table" "a" INNER JOIN
"public"."remote_table" "b" ON "a"."id" = "b"."id" WHERE "a"."id" > $1 GROUP BY "a"."value"`
(params `[0]`) — instead of two bind-join legs, and a no-join single-source query still takes
the ordinary `scan` pushdown path (not co-located).

## 8. The decision matrix (implemented)

```
resolve legs → fingerprint each (engine, host, port, database)

if all legs == hub Postgres ............................. SINGLE_LOCAL  (one hub SQL)
elif one connector leg, no join/set-op ................. SINGLE_CONNECTOR (one pushed op)
elif all legs share ONE fingerprint AND engine ∈ SQL ... SINGLE_CONNECTOR co-located
                                                          → one native JOIN/GROUP-BY SQL, one round-trip
else (multi-source / multi-engine) ..................... CROSS_ENGINE (federate):
     per join:
       small+selective driving side → BIND/broadcast (push IN(keys) to the probe side)
       driving keys > cap ........... → HASH join in-fabric (fetch both bounded, hash-probe)
       aggregates ................... → partial aggregate per leg + final merge
     leg order: producers before bind-consumers; independent legs in parallel
     safety: per-leg row cap + bind-key cap + mandatory filter/limit on SELECT
```

## 9. Borrowing from how a single database engine works internally

A federation planner is a distributed re-implementation of what one RDBMS does inside a box.
The concepts transfer directly — the fabric's "sources" are the DB's "storage", and the
network is the DB's "disk":

| DB-internals concept | What it does inside one engine | Fabric analog (this system) |
|---|---|---|
| **Parser → Binder → Optimizer → Executor** | staged compilation | AST → `QueryPlanner.classify` → executor |
| **Volcano / iterator model** (pull) & **vectorized/push** (batch) | operators `next()` a row / a batch | fabric operator pipeline over **row batches**; streaming (`stream_source`) = push |
| **Access methods**: seq scan vs **index scan** / index-only / bitmap | pick the cheapest way to read a table | **pushdown**: send the filter/projection to the source so *it* uses its index; fetch only matching, only-needed columns |
| **Sargable predicate pushdown to storage** | only index-usable predicates prune at the storage layer | `PushdownCompiler` emits WHERE/`IN`/range so the source index-probes; non-pushable predicates compensate in-fabric |
| **Join algorithms**: nested-loop / **index-nested-loop**, **hash join** (build/probe, grace/hybrid **spill**), **sort-merge** | chosen by the optimizer per join | same menu, one level up: bind/broadcast = index-nested-loop; in-fabric **hash join** with spill guard; sort-merge when pre-sorted |
| **Cost-based optimizer + statistics** (`ANALYZE`: histograms, `n_distinct`, `null_frac`, correlation) | estimate cardinality/selectivity → cost each plan | rule-based today; **roadmap**: persisted per-source column stats → cardinality-driven driver/algorithm choice |
| **Join-order search** (DP / greedy, left-deep vs bushy) | reorder joins to minimize intermediate rows | co-located → delegated to the source; federated → left-deep + driver-first; **roadmap**: bushy search |
| **Partition pruning** | skip partitions that can't match | **skip legs / sources** a predicate excludes; Citus shard pruning on the hub |
| **Runtime filters / bloom / semi-join reduction** | build a filter from one side to prune the other early | bind-join `IN(keys)` **is** a runtime semi-join filter pushed to the probe side |
| **Adaptive Query Execution** (re-optimize mid-run, Spark AQE) | switch strategy when real cardinality ≠ estimate | fabric switches **bind → hash** at runtime when driving keys exceed the cap |
| **MVCC / snapshot isolation** | consistent read without blocking writers | keyset snapshot during copy; CDC resume token / log seq = a consistent cut |
| **Buffer pool / page cache** | keep hot pages in memory | **Redis** result cache for hot catalog/query reads |
| **WAL / redo log** | durability + replication source of truth | **CDC log capture** (trigger-outbox / change-stream) + copy-job checkpoints |
| **`EXPLAIN` / plan introspection** | show the chosen plan | the per-leg **plan trace** (`plan.legs[].query`, mode, rows, ms) returned with every query |
| **Late materialization / column pruning** | defer/avoid reading unused columns | projection pushdown — request only `select` columns from each source |

**Design takeaway:** don't invent distributed-systems machinery where a DB concept already
answers the question. "Should I push this filter?" = *is it sargable?* "Which join?" = *the
same build/probe cost question an optimizer asks, with network as the dominant IO term.* "How
do I stay consistent while copying?" = *MVCC snapshot / log position.* The fabric's job is to
be a thin, correct distributed optimizer that **maximizes delegation to the engines that
already do this well**, and only does in-fabric what no single source can (cross-engine joins,
partial-aggregate merges, capability compensation).

## 9b. Cross-source federation — verified behaviour

When legs span *different* physical databases the fabric federates. Confirmed live
(`tenant_advanced_test`, two Postgres DBs `5434/datafabric` vs `5436/remote_warehouse` + Mongo):

| Query shape | Strategy chosen | What executed |
|---|---|---|
| self-join, one DB | `SINGLE_CONNECTOR` co-located | one native `JOIN…GROUP BY`, 1 round-trip |
| UNION, both legs one DB | `SINGLE_CONNECTOR` co-located | one native `UNION`, 1 round-trip |
| UNION across two DBs | `CROSS_ENGINE` | two `union-leg` fetches (each pushed down), merged in-fabric |
| INNER JOIN across two DBs | `CROSS_ENGINE` | `join-driving` leg → distinct keys → `bind-join` `WHERE key IN (…)` on the probe |
| single table, no join | `SINGLE_CONNECTOR` (not co-located) | ordinary `scan` pushdown |

The false-positive guard is the **connection fingerprint**: two Postgres sources pointing at
different servers/databases produce different fingerprints, so they never collapse into a
co-located push — they federate, correctly.

**Projection pushdown on federated joins (NEW).** Previously each join leg was fetched
`SELECT *`. Now `FederationExecutor.joinLegProjections` attributes every `alias.column`
reference (select + join keys + where + order/group/having) to its leg and pushes only those
columns — e.g. the verified trace went from `SELECT *` to
`SELECT "name","id" …` (driving) and `SELECT "type","name" …` (bind-join). It bails to
`SELECT *` for any leg whose columns can't be unambiguously attributed (unqualified column in a
multi-table join, `*`/`alias.*`, raw expression/window) — over-fetch, never under-fetch.
Combined with predicate pushdown + the bind-join semi-join filter, a cross-source join now
moves only *matching rows × needed columns* across the network.

## 9c. How production federation engines do it — and what we adopted

The four reference systems and the algorithms that matter, each mapped to a concrete mechanism
in this fabric.

### Trino / Presto (MPP query federation)
- **Architecture:** a coordinator parses → plans → schedules; workers run pipelined stages
  connected by *exchanges*. Each data source is a **connector** behind a stable SPI.
- **CBO from connector statistics:** row counts, data size, distinct-value counts (NDV), null
  fraction. The optimizer reorders joins and picks join strategy from these.
- **Pushdown:** predicate, projection (columns), `LIMIT`/`TopN`, aggregation, and **join
  pushdown** — when both tables live in the *same* catalog, the whole join is pushed to the
  source. ← this is our **co-located pushdown**.
- **Join distribution:** `BROADCAST` (replicate the small build side to every worker) vs
  `PARTITIONED` (hash-repartition both sides). `AUTOMATIC` uses stats to choose. ← our
  **bind-join** = broadcast the small side's *keys*; **hash fallback** = the partitioned case.
- **Dynamic filtering:** at runtime the build side emits a summary (min/max, a distinct-value
  set, or a bloom filter) that is pushed into the probe side's scan so it reads only matching
  rows. ← our **bind-join `IN(keys)`** is exactly this, as a static per-query semi-join.

### Apache Calcite (the planner framework others embed — Flink, Drill, Hive, Beam)
- **Not an engine — a planner.** A tree of `RelNode`s (relational algebra) over `RexNode`
  expressions, carrying **traits**: `Convention` (which backend), `RelCollation` (sort),
  `RelDistribution`.
- **Two optimizers:** `VolcanoPlanner` (cost-based, top-down, dynamic programming over
  equivalence classes `RelSet`/`RelSubset`, applies rules to a fixed point, keeps least-cost)
  and `HepPlanner` (heuristic, rule-order driven).
- **Adapter pushdown:** a subtree entirely in one `Convention` (e.g. `JdbcConvention`) is turned
  back into that source's dialect by `RelToSqlConverter` and executed remotely. ← our
  **`connFingerprint` = Convention**, and **`PushdownCompiler.toJoinSql` = RelToSqlConverter**.
- **Cost metadata:** `RelMetadataQuery.getRowCount / getSelectivity / getDistinctRowCount`.
- **Mapping:** our planner is a small, special-cased Calcite — a tiny rule set
  (co-located / single-connector / cross-engine) rather than a general Volcano search.

### Denodo (commercial data virtualization — the closest analog to "a data fabric")
- **CBO + rule-based rewrites** over gathered source statistics and index metadata.
- **Signature techniques:** aggregation pushdown; **branch pruning** (drop branches that can't
  contribute); **join reordering**; and **automatic data movement** — temporarily copy the
  smaller side into the other source so a cross-source join collapses into a single-source
  pushdown (MPP-lite).
- **Join method selection:** merge / hash / nested-loop / **"join by subquery"** — injects the
  driving side's keys as an `IN`-list into the second source. ← identical to our **bind-join**.
- **Mapping:** our **cost-based driving-side selection + bind-join** *is* Denodo's cost-based
  join-method selection + "join by subquery." **Data movement** is a roadmap item — our
  replication engine is the substrate that would implement it.

### Spark SQL (Catalyst + Tungsten + AQE)
- **Catalyst:** rule-based logical optimization (predicate/projection pushdown, column pruning,
  constant folding) + cost-based join reordering using table stats + column **histograms**.
- **DataSource V2 pushdown:** filters, required columns, aggregates, limit. ← our
  `PushdownCompiler` + per-connector pushdown.
- **Physical joins:** `BroadcastHashJoin` (small side broadcast), `SortMergeJoin` (both large),
  `ShuffleHashJoin`.
- **Adaptive Query Execution (AQE):** re-optimizes at *stage boundaries* using **runtime**
  stats — coalesces shuffle partitions, flips `SortMergeJoin → BroadcastHashJoin` when a side
  turns out small, splits skewed partitions. ← our **live cardinality probe** (a runtime stat,
  not a precomputed one) and the **bind→hash fallback** past `FABRIC_FED_BIND_MAX_KEYS` are
  lightweight AQE.

### Synthesis — technique → who does it → our mechanism → status

| Technique | Trino | Calcite | Denodo | Spark | This fabric | Status |
|---|:--:|:--:|:--:|:--:|---|---|
| Single-source subtree pushdown | ✔ (same-catalog join) | ✔ (adapter/`RelToSql`) | ✔ | ✔ | co-located `toJoinSql` | **done** |
| Predicate pushdown | ✔ | ✔ | ✔ | ✔ | `PushdownCompiler` filter | **done** |
| Projection pushdown | ✔ | ✔ | ✔ | ✔ | `joinLegProjections` (+ single-leg) | **done** |
| Aggregation pushdown (+partial/merge) | ✔ | ✔ | ✔ | ✔ | `aggregate.ts` partial+merge | **done** |
| Semi-join / dynamic filter / "join by subquery" | ✔ | — | ✔ | ✔ | bind-join `IN(keys)` | **done** |
| Cost-based driving/build-side selection | ✔ | ✔ | ✔ | ✔ | live cardinality probe → smaller drives | **done (NEW)** |
| Runtime strategy switch (AQE) | ✔ | — | — | ✔ | broadcast/bind chosen from live probe; bind→hash past cap | **partial** |
| Broadcast hash join (both sides small) | ✔ | — | ✔ | ✔ | parallel fetch both + in-fabric hash | **done (NEW)** |
| Batched semi-join for large key sets | ✔ | — | ✔ | ✔ | chunked `IN(...)` batches | **done (NEW)** |
| Partitioned/shuffle/grace-hash (both large) | ✔ | — | ✔ | ✔ | in-fabric hash (no spill yet) | **partial** |
| Join reordering across >2 legs | ✔ | ✔ | ✔ | ✔ | left-deep only | **roadmap** |
| Persisted stats / histograms (avoid live probe) | ✔ | ✔ | ✔ | ✔ | live probe instead | **roadmap** |
| Data movement to enable pushdown | — | — | ✔ | — | replication engine (substrate) | **roadmap** |

**Verified live (Postgres × MongoDB, one join):** `FROM` = Postgres `remote_table` (28 rows)
`INNER JOIN` Mongo `enrich` (3 rows). The cost probe reported `a~28, e~3`, chose **Mongo to
drive**, shipped **3** keys as `id IN ($1,$2,$3)` to Postgres (not a 28-row scan), pushed
projection `e:{grade,id} a:{id,name}`, and returned the correct 3 joined rows — Trino/Denodo
"smaller side builds" + "join by subquery" + Spark DS-V2 column pushdown, together, across two
engines.

## 9d. Critique of the observed leg execution — "should it run like this?"

Watching the real cross-engine join (Postgres 28 × Mongo 3) exposed exactly how many
round-trips it costs and where the waste is. The first implementation did:

```
wave 1 (parallel):  COUNT(*) → PG        COUNT(*) → Mongo         (cost probe)
wave 2:             fetch driving (Mongo, 3 rows)
wave 3:             bind fetch (PG WHERE id IN (3 keys))
in-fabric:          hash join → 3 rows
```

Three sequential latency waves. The critique, and what each points to:

| Observation | Why it's suboptimal | Algorithmic fix | Status |
|---|---|---|---|
| Bind is **2 sequential fetches** (driving → then probe) even when both sides are tiny | Latency = 2 waves when it could be 1 | **Broadcast hash join**: fetch both in parallel, join in-fabric (when both ≤ ceiling) | **done** |
| Key set > `bindMax` **abandoned the filter → bounded full scan** of the probe table | Can scan millions to find a few matches | **Batched bind**: chunk the `IN`-list into ≤`bindMax` batches (bounded fan-out) before falling back | **done** |
| Cost probe adds **2 extra round-trips** every join | For tiny tables the probe costs more than it saves | **Persisted stats cache** (catalog `row_count` + NDV) → skip the live probe | roadmap |
| Driving side chosen by **row count**, not distinct **join-key** count | Bind-list size = *distinct keys*, not rows; NDV is the true cost | Probe `COUNT(DISTINCT joinkey)` / use NDV stats | roadmap |
| `>2`-leg joins run **strictly left-deep, one leg at a time** | Independent dimensions (star schema) could be fetched **concurrently** | Dependency-DAG scheduling + parallel independent legs | roadmap |
| Hash index always built from the **probe** side | Should build from the **smaller** of (driving, probe) | Build-side = min(|L|,|R|) | roadmap |
| Whole leg result **materialized** before join | Peak memory = full leg; large joins risk the cap | **Streaming / grace-hash with spill** (pipelined iterator) | roadmap |
| No **`LIMIT` push-through** on joins | Outer `LIMIT k` can't bound leg fetches | Safe limit-pushdown (1:1 / semijoin-preserving shapes) | roadmap |
| Repeated joins **re-fetch** every leg | No reuse of hot leg results | Redis **segment/result cache** keyed by (source,table,filter,proj) | roadmap |

### The full solution space (system-design menu)

- **Statistics & cost:** persisted row counts / NDV / histograms / min-max (ANALYZE-style,
  TTL-refreshed) → a real CBO that needs no live probe; selectivity estimation for filters.
- **Physical join operators:** broadcast-hash (small side), bind/semi-join (few keys, large
  probe), repartitioned/**grace-hash with spill** (both large, bounded memory),
  **sort-merge** (both large & pre-sorted — push `ORDER BY key`, merge streams), nested-loop
  (non-equi). Choose per-join from cost.
- **Scheduling / topology:** operator **DAG** instead of a left-deep loop; **parallel**
  independent legs; **pipelined/streaming** execution (Volcano iterator / vectorized batches)
  to overlap I/O and bound memory; **adaptive** re-selection mid-run (AQE).
- **Large-key handling:** batched `IN` (done), **temp-table / VALUES-join** pushdown, **bloom
  filter** semi-join for huge key sets, or **data movement** (replicate the small side into the
  other engine and push the whole join — Denodo-style; our replication engine is the substrate).
- **Memory & spill:** build from the smaller side; spill the hash table past a ceiling; the
  existing row cap + cap-and-warn.
- **Reuse:** Redis result cache for hot legs; materialized replicas as accelerators; a plan
  cache keyed by AST shape.

### What this turn implemented (highest value, lowest risk, provably correct)
1. **Broadcast hash join** for a 2-leg INNER equijoin when both post-filter counts ≤
   `FABRIC_FED_BROADCAST_MAX` (5000): both legs fetched **in parallel**, joined in-fabric — one
   latency wave, not two. Verified live: the 28×3 join now runs `broadcast-build ∥ broadcast-build`.
2. **Batched bind**: a key set above `FABRIC_FED_BIND_MAX_KEYS` is split into ≤`bindMax`
   chunks (up to `FABRIC_FED_MAX_BIND_BATCHES`, default 20) and each chunk pushed as its own
   `IN(...)`, instead of silently degrading to an unfiltered scan of the probe table.

Both preserve results exactly (broadcast only when a side is already small; batched bind is the
same semi-join, chunked) — they change *how fast*, never *what*.

## 10. Honest limits / roadmap
- **Driving-side selection uses a LIVE probe, not persisted stats.** For a single INNER
  equijoin the fabric pushes a `COUNT(*)` to each side and drives from the smaller one
  (`FABRIC_FED_COST_PROBE=0` disables it). This costs one extra tiny round-trip per side; a
  **persisted per-source stats cache (row counts, NDV, histograms)** would remove the probe and
  enable a full CBO — the next tier.
- **Join reordering across >2 legs** is left-deep in fixed order (the co-located case delegates
  reordering to the source). A cost-based multi-way reorder / bushy search is future work.
- **Cross-DB-same-server MySQL joins** are treated as multi-source (safe) rather than pushed.
- Co-located pushdown covers SQL engines (PG/MySQL/Oracle/Snowflake); Mongo/ES joins are always
  federated (no relational join in-engine).
- **Data movement to enable pushdown** (Denodo-style: copy the small side into the other source
  so the join collapses to a single-source push) is not done; the replication engine is the
  substrate for it.
