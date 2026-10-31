# Distributed Execution: Worker Nodes, AST-only, Swagger, Landing

Status legend: [ ] todo, [x] done. Updated as work lands.

## 0. Findings (current system)
- Hub = Citus coordinator (`citusdata/citus`, container `datafabric-hub`), single node today; `create_distributed_table` already wrapped in `QueryEngineService` (~L1491).
- Sources (Postgres/MySQL/Oracle/Mongo/ES) are reached by connectors/FDW; Citus workers are the *compute* tier in front of them.
- SQL execution surface to remove: `POST /api/queries/exec`, `/native`, `QueryEngineService.executeRawSql / executeAsyncRawSql / executeSqlOnSource`, `rawSql` in `stream_source.ts` + analytics, workbench SQL mode, examples. `/api/queries/transpile` (AST -> SQL *preview*) stays: it never executes.
- Auth: login JWT only (`AuthService`), global middleware in `backend/src/index.ts`. No developer API tokens exist.
- UI: Express + EJS (`ui/src/views`), payment-ms Console is React/Tailwind, so the landing is ported to EJS + scoped CSS (`.df-landing`, `lp-` classes) with the same tokens/layout/breakpoints.

## 1. Features and tasks

### F1 Worker node management (Citus)
- [x] Migration `17-worker-nodes`: `fabric_worker_nodes` registry (id, name, host, port, status, should_have_shards, labels, citus_node_id, last_health_*, created_by, timestamps; UNIQUE host+port, UNIQUE name). Mirror in `db/init`.
- [x] `WorkerNodeService`: capability probe (is `citus` extension present, is this the coordinator), list (registry joined with `pg_dist_node` + live probe), add (`citus_add_node`), activate/deactivate (`citus_set_node_property shouldhaveshards`), drain (`citus_drain_node`), remove (`citus_remove_node`, refuses while shards remain unless drained), rebalance (`rebalance_table_shards` + status), distributed table list (`citus_tables`), distribute/undistribute table, health check, sync-metadata.
- [x] Admin routes `/api/admin/workers/*` (ADMIN only), audit-logged.
- [x] Graceful degradation: no Citus => registry readable, mutating calls return 409 `CITUS_UNAVAILABLE` with a clear message.
- [x] Settings UI: "Worker nodes" tab (cards + table, add form, activate/drain/remove/rebalance, health badges, distributed-tables panel), responsive.
- [x] docker-compose: pin coordinator to `citusdata/citus:13.0`, add `worker1`, `worker2`, a `worker-init` registration step; `.env` knobs.

### F2 AST-only execution
- [x] Delete `/exec`, `/native`; remove SQL-on-source, async raw SQL, `rawSql` stream path, workbench SQL mode.
- [x] Reject any request body containing `sql`/`rawSql`/`nativeSql` keys with 400 `SQL_NOT_SUPPORTED` on query/analytics/data endpoints (defence in depth).
- [ ] AST validator: allow-list node types/operators; identifiers validated; no string-fragment escape hatches (`select`/`on` expressions are parsed, not concatenated).
- [ ] Migrate examples/tests/docs to AST; keep `/transpile` as preview only.

### F3 Developer tokens
- [x] `api_tokens` table (hash only, prefix, scopes, expiry, last_used, revoked_at, tenant_id, created_by).
- [x] `POST/GET/DELETE /api/developer/tokens` (JWT session required to mint; token value shown once; `dft_` prefix; sha256 stored).
- [x] Auth middleware accepts `Authorization: Bearer dft_...` and `x-api-key`; scopes enforced (`query:read`, `data:write`, `metadata:write`, `admin:*` never grantable).

### F4 Two Swagger specs
- [x] `/api-docs/developer` (+ `.json`): auth, token mint, data CRUD, AST query/analytics, metadata, triggers; headers (`Authorization`, `x-api-key`, `x-tenant-id`, `x-act-as-role`, `x-region`, `Accept: application/x-ndjson`), auth flows, error model, rate limits, examples.
- [x] `/api-docs/system` (+ `.json`): admin, tenants, users, connections, workers, replication, plans/licensing, settings, health, query logs, audit.
- [x] Every operation: security, headers, request/response/error schemas, examples. Validation test that every mounted route appears in one of the specs.

### F5 Landing + theme
- [x] Public `/` landing in EJS (hero, features, distributed-fabric architecture diagram, how-it-works, plans, CTA), dark/light toggle, same tokens as FabPay landing.
- [x] Shared theme tokens into `style.css` for the console views; responsive at 360 / 768 / 1024 / 1440; no horizontal scroll.

## 2. Edge-case test list
Workers
- E1 add worker when Citus extension missing -> 409, registry unchanged
- E2 add duplicate host:port / duplicate name -> 409
- E3 add unreachable host -> 502/400 with message, no half-registered row (transaction + compensation)
- E4 invalid port (0, 70000, "abc"), invalid host (empty, spaces, `;`, URL form) -> 400
- E5 add the coordinator itself as worker -> 400
- E6 remove worker that still holds shards -> 409 unless drained first
- E7 remove last remaining worker while tables distributed -> 409
- E8 drain then reactivate; drain already drained node (idempotent)
- E9 rebalance with no workers / one worker / mid-flight rebalance already running -> clear status
- E10 worker goes down: health shows DOWN, list still works (probe timeout 3s, parallel)
- E11 concurrent add of same node (race) -> exactly one succeeds
- E12 registry row exists but node missing in `pg_dist_node` (drift) -> flagged `DRIFT`, resync action
- E13 distribute table that has no PK/distribution column, already distributed, is foreign table, or belongs to another tenant -> 400/409
- E14 non-admin / tenant user calls any worker endpoint -> 403
AST-only
- E20 body with `sql`, `rawSql`, `query` as string, `nativeSql` -> 400 `SQL_NOT_SUPPORTED`
- E21 removed routes `/api/queries/exec|native` -> 404
- E22 AST with stacked statements in identifiers (`users; DROP TABLE x`) -> 400
- E23 AST with `select: ["*", "pg_sleep(10)"]` function allow-list -> 400
- E24 `limit` negative / huge / non-numeric -> clamped or 400
- E25 async AST job poll for foreign tenant job id -> 404
Tokens
- E30 expired token, revoked token, wrong prefix, truncated token, token for suspended tenant -> 401/403
- E31 token shown only on creation; list never returns secret or hash
- E32 scope missing for route -> 403 with required scope in message
- E33 token minting using an API token (no token-from-token) -> 403
Landing/UI
- E40 no horizontal scroll at 320px; touch targets >= 40px; prefers-color-scheme honoured; JS disabled still readable

## 3. Security test list
- S1 SQL injection through every worker field (name, host, port, labels) and distribute-table params -> parameterised or strictly validated (citus UDF args use bound params; identifiers via `quote_ident` + allow-list regex).
- S2 SSRF: worker host pointing at metadata endpoints (169.254.169.254, localhost, link-local) -> deny-list unless `ALLOW_PRIVATE_WORKERS=true` (needed for docker/private nets; default allows RFC1918, blocks link-local/metadata/loopback-not-self).
- S3 AuthZ matrix: anonymous 401, USER 403, tenant ADMIN-vs-platform ADMIN, `x-tenant-id` override ignored for non-admins; api token cannot reach `/api/admin/*`.
- S4 Credentials never returned (worker passwords, token hashes), never logged; worker conninfo not stored (Citus uses coordinator auth/`pg_hba`/`citus.node_conninfo`).
- S5 Rate limit + audit trail on worker mutations (who/what/when/before/after).
- S6 Token storage hashed (sha256), constant-time compare, `last_used` update non-blocking, brute force limited.
- S7 CORS: `x-api-key`, `x-act-as-role`, `x-region` allowed deliberately; `x-act-as-role` honoured for ADMIN JWT only, never for API tokens.
- S8 Swagger "Try it out" does not embed credentials; example tokens are placeholders; spec contains no real secrets/hostnames.
- S9 Removed SQL paths unreachable: grep gate in tests for `queryWithContext(` with user-supplied strings; fuzz AST identifiers.
- S10 Landing page: no inline script from user data, CSP-friendly, links `rel=noopener`.
- S11 Multi-tenant isolation: distributed table list filtered to caller tenant schemas for non-platform admins (workers themselves are platform-level, ADMIN only).

## 4. Verification log (live Citus 14.2 coordinator + 2 workers)
- Verified: E1(unit)/E2/E3/E4/E5(env)/E6/E7/E8/E9/E10/E13/E14, S1/S2/S3/S4(no creds)/S5, token E30-E33, scope tightening (CALL/DML via token needs data:write), AST-only guard E20-E22, both swagger specs mounted (69 / 134 operations).
- Finding: shard moves need `wal_level=logical`; service now falls back to `block_writes` and warns.
- Not automated yet: E11 (concurrent add), E12 (drift) , E23-E25, E40 (320px sweep of every console page), S6 brute-force limit on token auth, S9 grep gate. Tracked below.
