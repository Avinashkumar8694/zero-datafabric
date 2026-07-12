# Capability Model & Matrix — one model, two modes, three tiers

This document explains **how every feature of the fabric works**, checked against
every construct in `test_manifest.json`, and how each is reachable **consistently
from both the AST query mode and the SQL query mode**.

## 1. One model

Two entry modes normalize to a **single canonical AST** before planning:

- **AST mode** — a structured `query` object (`{ select, from, where, joins,
  groupBy, with, recursive, … }`).
- **SQL mode** — a SQL string. On a SQL-native engine (Postgres/remote) it runs
  natively; on a non-SQL engine (Mongo) it is translated to the same AST by
  `sqlToAst`, then planned identically.

Because both modes converge on the same AST + planner, every capability below is
available the same way from either — that is the consistency guarantee.

## 2. Three enforcement tiers (the compensation philosophy)

For each capability the planner picks, per engine:

| Tier | Meaning |
|---|---|
| **Push-down** | the source enforces/executes it natively (Postgres RLS, CHECK, GRANT, `nextval`, functions, `WITH RECURSIVE`) |
| **Compensate-in-fabric** | a fabric engine does it when the source can't — the whole point for Mongo/ES |
| **Reject-if-impossible** | explicit, non-silent error (e.g. `EXCLUDE … USING GIST` on Mongo) |

"If Mongo doesn't support it, the fabric adds its own engine/helper" — that is
tier 2, applied uniformly.

## 3. The fabric engines (tier-2 compensations)

| Engine | File | Compensates |
|---|---|---|
| PushdownCompiler | `query-engine/pushdown.ts` | filter/projection/sort/limit → SQL / Mongo / ES |
| FederationExecutor | `query-engine/federation.ts` | cross-engine JOIN / UNION / INTERSECT / EXCEPT, partial-aggregate merge, bind-join |
| Aggregate engine | `query-engine/aggregate.ts` | multi-source GROUP BY (partial + merge) |
| Window engine | `query-engine/compensate.ts` | RANK / ROW_NUMBER / SUM OVER … in-fabric |
| Recursive engine | `query-engine/recursive.ts` | `WITH RECURSIVE` / hierarchy traversal over any engine |
| Sequence engine | `query-engine/sequence.service.ts` | `nextval` for engines with no sequences |
| Write-value engine | `query-engine/write_generators.ts` | UUID_V7 / IDENTITY / FUNCTIONAL / SOFT_DELETE defaults |
| **Policy engine** | `security/policy.service.ts` | row-predicate injection + column masking |
| **Constraint engine** | `query-engine/constraint.service.ts` | NOT NULL / UNIQUE / CHECK / ENUM / FK on write |
| **Grant engine** | `security/grant.service.ts` | role/privilege table access gate |
| Function-as-a-service | `CALL` op + `write_generators.ts` | run functions/procedures on the hub for any engine |
| SQL translator | `query-engine/sql_translator.ts` | SQL → AST for non-SQL engines |
| Trigger engine | `trigger-engine/` MS + `triggers/*` | durable action triggers + native manifest triggers |

## 4. Capability matrix — every `test_manifest.json` construct

`PG` = native Postgres. `Mongo/ES` = the non-SQL compensation tier.

| Manifest construct | AST mode | SQL mode | PG | Mongo/ES (compensation) |
|---|---|---|---|---|
| ENUM type | apply | apply | native `CREATE TYPE` | validated in-fabric on write (Constraint engine) |
| SEQUENCE (incl. PROCEDURAL) | ✅ | ✅ | native `nextval` | Sequence engine (atomic allocator) |
| Column strategies (UUID_V7 / IDENTITY / LEGACY_SERIAL / FUNCTIONAL / SOFT_DELETE) | ✅ `generate` | ✅ | native defaults | Write-value engine supplies values |
| TABLE / columns / types | ✅ | ✅ | native DDL | `createCollection` + indexes |
| **CHECK constraint** | ✅ | ✅ | native | **Constraint engine** (regex/comparison eval on write) |
| **UNIQUE** | ✅ | ✅ | native | Mongo unique index + fabric pre-check |
| **NOT NULL** | ✅ | ✅ | native | **Constraint engine** |
| **FOREIGN KEY** | ✅ | ✅ | native (relationship or `constraints[]`) | **Constraint engine** (existence lookup) |
| EXCLUDE … USING GIST | ✅ | — | native | **reject-if-impossible** (Postgres-only) |
| TRIGGER (manifest) | ✅ | via manifest | native `CREATE TRIGGER` | native trigger enqueues durable job |
| TRIGGER (API/UI action) | ✅ | ✅ | — | Trigger-engine MS + durable queue |
| **masking** | ✅ | ✅ | native (or fabric) | **Policy engine** post-fetch redaction |
| **RLS policies** | ✅ | ✅ | native RLS | **Policy engine** predicate injection (pushed to source) |
| **grants** | ✅ | ✅ | native GRANT | **Grant engine** role/privilege gate |
| **FUNCTION** (author) | ✅ | ✅ | native | provisioned on hub (FaaS) |
| **FUNCTION/PROCEDURE (call)** | ✅ `{type:'CALL'}` | ✅ `CALL`/`SELECT fn()` | native | **function-as-a-service** on hub |
| VIEW (plain / window / aggregate) | ✅ | ✅ | native view | window/aggregate engines |
| VIEW (federated VIRTUAL union/intersect/except) | ✅ | use AST | — | FederationExecutor set-ops |
| **recursive VIEW / WITH RECURSIVE** | ✅ `query.with` / `query.recursive` | PG passthrough; Mongo → use AST | native `WITH RECURSIVE` | **Recursive engine** (in-fabric traversal) |
| MATERIALIZED VIEW (+ refresh) | ✅ | ✅ | native matview | (Postgres target) |
| relationships (1:1 / 1:M / M:N) | ✅ | ✅ | native FK / bridge | FK compensation via Constraint engine |

### Notes on `WITH`/CTE in SQL mode
`WITH`/`WITH RECURSIVE` runs natively when the SQL targets a SQL engine
(Postgres/remote — passthrough). For a **non-SQL** engine, `sqlToAst` returns an
actionable error pointing to the AST equivalents (`query.with` for Postgres,
`query.recursive` for cross-engine in-fabric traversal), which **do** run on
Mongo/ES. So recursion is always available — the SQL string form just isn't the
vehicle for a document store.

## 5. Control-plane APIs (all engine-agnostic, all synced from the manifest too)

| API | Purpose |
|---|---|
| `POST/GET/DELETE /api/policies` | row policies + masking |
| `POST/GET /api/constraints` | NOT NULL / UNIQUE / ENUM / CHECK / FK |
| `POST/GET /api/grants` | table privileges by role |
| `POST/GET/PUT/DELETE /api/triggers` | action triggers + durable jobs |
| `POST /api/data/{fetch,create,update,delete,call,sequence}` | CRUD + FaaS + sequences |
| `POST /api/analytics/query` | AST/SQL queries (federation, recursion, window, aggregate) |
| `POST/GET/DELETE /api/saved-analytics` (+ `/:id/run`) | reusable, `{{variable}}`-bound analytics; run/trigger with inputs |

**Session context** (`tenant`, `role`, `region`) is threaded from the request
(token + `x-tenant-id` + `x-region`); ADMIN may `x-act-as-role: <role>` to test
policies/grants/masking as another role ("view as").

## 6. Why this is efficient

- Row policies compile into the **pushdown**, so the predicate runs at the source
  (Mongo `$match`) — the fabric never fetches then filters.
- Constraints validate the **write payload** (and a single bounded lookup for
  UNIQUE/FK) before dispatch — O(rows), not a scan.
- Recursion pushes one `IN(…)` **bind-filter per level** — not a query per node.
- Grants are a single cached decision; masking is an O(rows) post-map.
