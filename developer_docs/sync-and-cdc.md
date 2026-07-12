# Source Sync Strategies — VIRTUAL / SYNC / CDC

Every data source is registered with a **sync strategy** (`sync_type`) that decides
whether the fabric reads it **live** or keeps a **physical replica** in the hub. It's
chosen in the Connections form (or the register API) and is the single switch that
governs everything downstream — the same rule the source is configured with is what
the planner, the backfill, and the CDC poller all obey.

| Strategy | Data lives | Read path | Freshness | Extra config |
|---|---|---|---|---|
| **VIRTUAL** | at the source | live via connector (pushdown) | always current | — |
| **SYNC** | copied into hub | hub replica (native SQL) | as of last sync | — |
| **CDC** | copied into hub, kept current | hub replica (native SQL) | near-real-time | `cdc: { column, intervalMs }` |

Where it's stored: `public.data_sources.sync_type` (column) + `config.cdc` (JSON). The
**query planner reads the column** — a SYNC/CDC source is `reachableInPg`, so queries
run as one native hub SQL statement (`SINGLE_LOCAL`); a VIRTUAL source is fetched
through its connector (`SINGLE_CONNECTOR`/`CROSS_ENGINE`).

---

## How data is synced — the two replica scenarios

Both write the replica into the tenant hub schema **`tenant_<tenantId>_<sourceSchema>`**
(the same convention as manifest-provisioned tables), with the source's **primary key**
carried onto the replica so upserts have a key. Queries then read that hub copy.

### SYNC — full backfill (one-time / on-demand)
`PhysicalSync.backfill(tenantId, source)`:
1. discover the source's schemas → tables (system schemas excluded);
2. for each table: `discoverColumns` → `DROP + CREATE` the hub table (typed columns + PK), `GRANT` access to the low-priv `fabric_user`;
3. read **all** rows from the source (bounded by `FABRIC_SYNC_MAX_ROWS`, default 200k) and bulk-`INSERT` them in batches.

It is **idempotent**: re-running truncates/recreates and reloads the whole table.

**New records under SYNC:** they are picked up **only on the next full sync** (re-register with SYNC, or `POST /api/metadata/sync`). SYNC does not watch the source — it's a point-in-time snapshot. Re-syncing also captures updates, deletes, and schema changes (because it's a fresh full reload).

### CDC — backfill + incremental refresh (continuous)
Registered as CDC with a **watermark column** (`config.cdc.column`, e.g. `updated_at` or `id`) and a poll interval.
1. **Initial backfill** — same as SYNC, and it **seeds the watermark** to the current `MAX(column)` (recorded in `fabric_system.cdc_state`), so the first refresh only sees *new* rows.
2. **Incremental refresh** (`PhysicalSync.refreshCdc`) — for each replicated table with the watermark column: pull source rows where **`column > lastWatermark`**, **upsert** them into the hub replica (`ON CONFLICT (pk) DO UPDATE`), then advance the stored watermark to the new max.
3. **Poller** — `PhysicalSync.startCdcPoller` runs every `FABRIC_CDC_POLL_MS` (default 15000 ms) and refreshes **every source whose `sync_type='CDC'`** — so the configured strategy, and only that, drives what gets polled.

**New records under CDC:** captured automatically on the next poll (or a manual `mode:'cdc'` call) — **only the changed/new rows move**, not the whole table. In the live test, inserting 2 new source rows produced `rows: 2 (incremental)` and the hub grew 5003→5005.

```
SYNC  :  source ──(full copy, all rows)──▶  hub replica        [on demand]
CDC   :  source ──(full copy once)───────▶  hub replica        [at registration]
         source ──(WHERE wm > last, upsert)▶ hub replica        [every poll]
```

---

## Configuring & triggering

**At registration** (Connections form → Sync Strategy = VIRTUAL / SYNC / CDC; CDC reveals the watermark-column + poll-interval fields). SYNC/CDC auto-trigger a backfill.

**Register API** (`POST /api/admin/connections`) — `config.syncType` = `VIRTUAL|SYNC|CDC`; for CDC add `config.cdc = { column, intervalMs }`.

**Manual (re)sync** (`POST /api/metadata/sync`):
```bash
# full backfill / re-sync
curl -s $BASE/api/metadata/sync -H "Authorization: Bearer $T" -H 'x-tenant-id: tenant_A' \
     -H 'Content-Type: application/json' -d '{"source":"Retail_MySQL"}'
# incremental CDC refresh now (instead of waiting for the poller)
curl -s $BASE/api/metadata/sync -H "Authorization: Bearer $T" -H 'x-tenant-id: tenant_A' \
     -H 'Content-Type: application/json' -d '{"source":"Retail_MySQL","mode":"cdc"}'
```
Returns a per-table summary: `{ source, engine, mode, tables:[{schema,table,rows,mode}], errors:[] }`.

**Env knobs:** `FABRIC_SYNC_MAX_ROWS` (backfill cap, default 200000), `FABRIC_CDC_POLL_MS` (poll cadence, default 15000).

---

## Effect on queries (why you'd choose SYNC/CDC)

Because a SYNC/CDC source is a hub replica, the planner serves it as `SINGLE_LOCAL` —
one native Postgres statement, no per-query round-trip to the source, and it can be
**joined/aggregated locally** with other hub/synced data efficiently. A VIRTUAL source
is always fetched live through its connector. Switching strategy changes only *where the
rows are read from*; the query API is identical.

Verified live: after SYNC, `SELECT … FROM products` on `Retail_MySQL` ran as
`SINGLE_LOCAL` with leg `local tenant_tenant_A_retail` and returned data identical to the
MySQL source; reverting to VIRTUAL returned it to `SINGLE_CONNECTOR` (live federation).

---

## Limits (honest)

- **CDC is watermark/poll-based**, not log-based (no Debezium). It captures inserts and
  updates whose watermark advances; **hard deletes at the source are not captured** by a
  `> watermark` pull (use a soft-delete flag + updated_at, or a periodic full SYNC).
- The watermark column must be **monotonic** (a growing id or an `updated_at` bumped on
  every change) for correctness.
- **SYNC is not continuous** — new source rows appear only on the next full sync. Use CDC
  if you need them to flow automatically.
- Backfill is bounded by `FABRIC_SYNC_MAX_ROWS`; larger tables need a higher cap (a
  streaming/chunked backfill is future work).
- **Snowflake**: the SYNC/CDC code path exists but is untested here (no Snowflake
  instance/SDK).
