# 19 · Replication-Engine Microservice (Sync / CDC / Replication / DR)

## Why a separate service

Physical SYNC, CDC refresh, source→source replication, and disaster-recovery restore are
all **long-running, memory-heavy row copies**. Running them inside the API process would
block request threads, couple copy throughput to API capacity, and lose all progress if the
API restarts mid-copy. So the fabric follows the same pattern as `trigger-engine`: the API
**assigns jobs**; a dedicated **replication-engine** microservice **executes** them.

```
 ┌─────────────────┐   enqueue (202 QUEUED)   ┌──────────────────────────┐   claim: FOR UPDATE SKIP LOCKED
 │  Data Fabric API │ ───────────────────────▶ │ fabric_system.copy_jobs  │ ◀──────────────────────────────┐
 │  · POST /metadata/sync                        │  (durable queue, hub DB) │                                 │
 │  · POST /replication/:id/run|restore          └──────────────────────────┘                                 │
 │  · schedulers (enqueue, deduped) │                        │  rolls up progress                             │
 └─────────────────┘                                         ▼                                                 │
                                              fabric_system.copy_checkpoints  ◀── save() each batch ── replication-engine (N workers)
                                              (per-table cursor+rows+done)          · PhysicalSync (SYNC/CDC → hub)
                                                                                    · ReplicationService (REPLICATE/RESTORE)
                                                                                    · keyset paging, memory guard, heartbeat
```

- **Separate project** `replication-engine/` (own `package.json`/`tsconfig`), started with
  `npm --prefix replication-engine start` (`--expose-gc` for the memory guard). It imports
  the backend's connector + copy core so there is a single source of truth.
- **Embedded fallback:** the API runs an in-process worker by default (dev). Set
  `REPLICATION_ENGINE_EXTERNAL=true` to disable it and use the dedicated service.
- **Horizontal scale:** launch many workers with distinct `WORKER_ID`. `FOR UPDATE SKIP
  LOCKED` guarantees each job is claimed by exactly one worker.

## Job lifecycle

```
QUEUED ──claim──▶ RUNNING ──ok──▶ COMPLETED
   ▲                 │ error(<max) ─▶ QUEUED (retry)
   │                 │ error(=max) ─▶ FAILED
   │                 │ control=PAUSE ─▶ PAUSED ──resume──▶ QUEUED
   └──── reclaim (stale heartbeat) ◀── RUNNING (worker died)
```

Statuses live on `copy_jobs`; `control` (RUN/PAUSE) is the pause request flag; `heartbeat_at`
drives crash detection.

## Bounded-memory, resumable copy (`modules/sync/copy_util`)

- **Keyset paging** `WHERE key > lastKey ORDER BY key ASC LIMIT n` (Postgres `LIMIT`,
  Oracle `FETCH FIRST n ROWS ONLY`, etc.). Memory ≈ one page. The `lastKey` is the resume
  cursor. Falls back to OFFSET only when a table has no usable key.
- **Memory guard** samples heap between batches; over `memCeilingMb` it GCs then aborts that
  copy cleanly (no OOM).
- **Hard row cap** (`maxRows`) stops a runaway read.
- **Per-job config** `{pageSize, memCeilingMb, maxRows}` threaded from the queued job.

## Durability guarantees

| Failure | Mechanism | Result |
|---|---|---|
| Worker/host crash mid-copy | `heartbeat_at` goes stale → `reclaimStale()` requeues → resume from `copy_checkpoints` | finished tables skipped; in-progress table continues from cursor; boundary batch re-applied via **upsert** → no loss, no dup |
| User pause | `control=PAUSE` probed between batches → `CopyPaused` | status `PAUSED`, checkpoints kept; `resume` continues |
| Transient error | retry to `max_attempts` | then `FAILED` with error recorded |
| Unreachable destination | handshake `SELECT 1` before copy | fails fast, connectors closed |
| Large table | keyset paging + memory guard | heap bounded (≈40–170MB in tests) |

## Concurrent mutations during a copy & CDC CRUD Reconciliation

- **Keyset paging is monotonic** on the primary key, immune to the skip/duplicate hazards of OFFSET paging when live tables mutate mid-scan.
- **Race-Free Reconciliation**: In `CDC` strategy, the engine installs source capture triggers **before** reading the snapshot. Any mutations occurring *during* the snapshot are captured in `fabric_cdc.<outbox>` with a monotonic sequence `seq > baseline`. The subsequent CDC drain re-applies changes in commit order:
  - `INSERT` / `UPDATE`: Idempotently upserted via primary key (`ON CONFLICT` / `ON DUPLICATE KEY` / `MERGE` / `_bulk`), overwriting any stale snapshot data.
  - `DELETE` (Hard Deletes): Intercepted as tombstones (`op: 'D'`) and deleted from the destination via [`DestOps.del()`](file:///Users/avinashkumargupta/Documents/projects/Zero/zero-datafabric/backend/src/modules/replication/dest_ops.ts) (guaranteeing zero orphan records).
- **Strategy Trade-off**: In contrast, `INCREMENTAL` polls `WHERE updated_at > :wm`. Because physically deleted rows no longer exist on disk to be queried, `INCREMENTAL` cannot observe hard deletes and leaves orphans.

## Progress & analytics

`save()` seeds `total_rows` (a cheap `COUNT(*)`) then, per batch, rolls checkpoints up onto
the job: `rows_copied/rows_total`, `progress_pct`, `tables_done/tables_total`, plus
`heartbeat_at`. `GET /api/replication/analytics` aggregates success rate, total rows, and
per-active-job live % + throughput + ETA for the Replication dashboard.

## Data sources & Destination Engines

All major engines are supported across the fabric: **PostgreSQL, MySQL, MongoDB, Elasticsearch, Snowflake, and Oracle Database**.
- **Source Capture**: PostgreSQL (trigger + `to_jsonb`), MySQL (trigger + `JSON_OBJECT`), Oracle (trigger + `JSON_OBJECT`), MongoDB (native change streams / oplog).
- **Destination Engines**: PostgreSQL (multi-schema DDL + upsert), MySQL (DDL + `INSERT ... ON DUPLICATE KEY UPDATE`), MongoDB (`bulkWrite` replaceOne / deleteOne), Oracle (DDL + `MERGE`), Elasticsearch (`_bulk` index by `_id` / `deleteDoc`).
- **DR Restore**: Targets any writable database engine to replay replicas cleanly back into the source.

## Key env

`REPLICATION_ENGINE_EXTERNAL`, `WORKER_ID`, `FABRIC_COPY_POLL_MS` (2000),
`FABRIC_COPY_STALE_MS` (60000), `FABRIC_COPY_BATCH` (1000),
`FABRIC_COPY_MEM_CEILING_MB` (1024), `FABRIC_COPY_MAX_ROWS` (5,000,000).
