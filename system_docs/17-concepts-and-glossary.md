# 17 — Concepts & glossary

Definitions of every key term used across these docs. Each entry says what the
concept *is* and where it lives in this system, with cross-references.

## Core architecture

**Data fabric.** An access layer that presents many heterogeneous data sources
(Postgres, MySQL, Snowflake, MongoDB, Elasticsearch) as **one** queryable surface
without physically consolidating the data. Zero Data Fabric is that layer: one
API, one query model, many engines.

**Federation.** Executing a single logical query across **multiple sources** by
fetching bounded partial results from each and combining them in-fabric (joins,
set-ops, partial aggregates). See [04](04-federation-executor.md).

**Virtualization.** Exposing a remote table/collection as a fabric resource that
is **queried live at the source** (not copied). The opposite of materializing/
replicating it into the hub.

**Control plane vs. data plane.** The **control plane** is the hub Postgres: it
holds only *metadata* — `data_sources`, `catalog_*`, tenants, and the
governance/audit catalogs (`fabric_system.*`). The **data plane** is the
registered external sources where tenant/analytics data actually lives and is
federated over. The fabric never becomes the system of record for tenant data.

**Hub.** The control-plane Postgres/Citus instance that hosts the catalog,
tenant-managed schemas, fabric primitives (`uuid_generate_v7`, `audit_log_fn`),
sequences, and provisioned functions. Referred to logically as
`Fabric_Hub_Postgres`.

## Sources, catalog, resources

**Connector.** A per-engine adapter (`discover / query / rawQuery / write /
close`) the fabric instantiates via `ConnectorFactory` to talk to a source in its
native protocol (SQL, Mongo find/aggregate, ES query DSL).

**Source (data source).** A registered external system (`data_sources` row):
engine type, sync type, and connection config.

**Resource.** A logical table / collection / view exposed by the fabric,
independent of the physical object it maps to.

**Catalog.** The fabric's map from **logical** names to **physical** locations:
`data_sources → catalog_schemas → catalog_tables`, plus
`fabric_catalog.relationships`. The planner reads it to resolve
`{source, resource}` → engine + physical schema/table. See [08](08-caching-and-catalog.md).

**Schema catalog / physical name.** `catalog_schemas`/`catalog_tables` store the
logical name **and** the `physical_name` (e.g. a tenant schema
`tenant_<id>_<logical>`, a Mongo db name, a remote PG schema) so execution targets
the right place.

**Manifest.** A declarative document describing the desired state of a tenant's
schemas, tables, types, sequences, functions, views, relationships, and
governance (`security.{policies,masking,grants}`). The orchestrator diffs it
against the catalog and applies the delta. See [07](07-metadata-orchestration.md).

**`definition_ast` / `definition_sql`.** A resource's stored canonical definition;
used for perfect manifest round-trip on export and for column metadata.

## Sync types

**VIRTUAL.** Queried **live** through the connector; nothing is copied into the
hub. A VIRTUAL remote Postgres is still reached via its connector (not FDW),
because `IMPORT FOREIGN SCHEMA` can't cover matviews/sequences/functions.

**SYNC.** Physically synced/replicated into a hub schema, so it is
`reachableInPg` — the planner can fold it into a single hub SQL statement.

**CDC.** Change-data-capture-fed shadow in the hub; like SYNC for planning
purposes (`reachableInPg = true`), kept current by a change stream.

## Query model

**AST mode.** A structured query object (`{ select, from, where, joins, groupBy,
with, recursive, … }`). The canonical form.

**SQL mode.** A SQL string. On a SQL-native engine it runs natively; on a non-SQL
engine (`sqlToAst`) it is translated to the **same AST** and planned identically.
See [12](12-capability-model-and-matrix.md).

**Canonical query.** The single normalized shape (`{ select, filter, orderBy,
limit, offset, groupBy, aggregates }`) both modes converge on before the
`PushdownCompiler` turns it into an engine-native request. See [05](05-pushdown-compiler.md).

**Pushdown compiler.** The single source of truth compiling the canonical query
to SQL (`$n`/`?`) or Mongo (find / aggregation pipeline), parameterized and
identifier-quoted. See [05](05-pushdown-compiler.md).

**Query planner.** Classifies a query into a **strategy** by resolving every
referenced resource and counting distinct sources / cross-boundary joins. See
[03](03-query-planner.md).

**SINGLE_LOCAL / SINGLE_CONNECTOR / CROSS_ENGINE.** The three strategies: one hub
SQL statement; one pushed query to a single connector source; or federate across
≥2 sources (or a cross-boundary join/set-op) and merge.

## Federation & compensation mechanics

**Push-down / compensate / reject.** The three-tier decision for every capability
a query needs: run it at the source if it can; else compute it in-fabric over the
**bounded** pushed-down result; else return a precise error. Never silently wrong.
See [10](10-capability-compensation-engine.md).

**Capability compensation.** The fabric providing a feature a source lacks
(sequences, window functions, HAVING, RLS, recursion) by pre- or post-processing
around the source's native query — the way a SQL DB layers window/sort logic on a
scan. See [10](10-capability-compensation-engine.md)–[12](12-capability-model-and-matrix.md).

**Bind-join (semi-join).** Cross-engine join optimization: fetch the driving side
(filtered), collect its distinct join keys, push `key IN (…)` to the other source
so it returns only matchable rows. Capped by `FABRIC_FED_BIND_MAX_KEYS`. See
[14 §2](14-algorithms.md#2-bind-join--in-key-propagation).

**Transitive predicate propagation.** Propagating a constant across an equijoin
(union-find over join columns) so *both* sides filter before any fetch.

**Partial aggregate.** Each source computes a partial `GROUP BY` (returns #groups,
not #rows); the fabric merges partials. `AVG` is decomposed into mergeable
`SUM`+`COUNT`. See [14 §3](14-algorithms.md#3-partial-aggregate-decomposition--merge).

**CTE composition / `WITH`.** Common Table Expressions in the AST (`query.with`)
or SQL. Non-recursive CTEs compose sub-queries; recursion uses `WITH RECURSIVE`
(Postgres-native) or the in-fabric recursive engine for other engines.

**In-fabric recursion.** Level-by-level hierarchy traversal (`RecursiveExecutor`):
seed the anchor, then repeatedly push one `IN(…)` bind-filter for the next level,
bounded by depth and row caps. See [14 §4](14-algorithms.md#4-in-fabric-recursive-traversal).

**Window compensation.** Computing `RANK/ROW_NUMBER/LAG/LEAD/running-SUM…` in the
fabric over a bounded base fetch (partition → sort → compute). See [14 §5](14-algorithms.md#5-window-function-compensation).

**Function-as-a-service (FaaS).** Running a hub-hosted custom function/procedure
as a value or query service for engines that can't host it (`/api/data/call`, AST
`{type:'CALL'}`, or a write-value `function` generator).

**Write-value generation.** Supplying column values (`UUID_V7`, sequence
`nextval`, functional defaults) at write time for engines without column defaults,
so IDs are consistent wherever the row lands. See [14 §9](14-algorithms.md#9-write-value-generation).

**Fabric sequence.** An atomic, monotonic allocator in the control plane
reproducing Postgres `nextval` semantics (gap-free, no duplicates under
concurrency; block allocation) for any engine.

## Governance & security

**Tenant.** An isolation boundary. Data is scoped to `tenant_<id>_*` schemas;
every catalog and governance row is keyed by `tenant_id`; the JWT carries the
tenant. See [15](15-security-and-governance-architecture.md).

**Row-level security (RLS).** Restricting *which rows* a caller sees. Native on
Postgres (JWT-claim policy); compensated on other engines by injecting the policy
predicate into the pushed query (Policy engine).

**Masking.** Obscuring *column values* for certain roles — `REDACT / NULL / HASH /
PARTIAL` — applied post-fetch by the Policy engine.

**Policy / SESSION reference.** A stored `{ rowFilter[], masking[] }` rule; a
clause value may be a session reference `{ session: 'tenant_id'|'region'|'role'|
'username' }` resolved per request (the analogue of `current_setting('app.*')`).

**Grant.** An engine-agnostic table privilege (SELECT/INSERT/UPDATE/DELETE) by
role; **default-allow** unless declared, ADMIN/SYSTEM bypass. See [15 §4](15-security-and-governance-architecture.md#4-the-grant-engine-engine-agnostic-privileges).

**`x-act-as-role` impersonation ("view as").** An ADMIN header that sets the
session role, so policies/grants/masking can be tested as another role without
that user's credentials.

**Constraint.** An engine-agnostic data-quality rule (NOT NULL / UNIQUE / ENUM /
CHECK / FK) validated in-fabric on write for non-SQL engines. See [15 §5](15-security-and-governance-architecture.md#5-the-constraint-engine).

**Industrial safety shield.** Guards that reject unbounded reads/writes (no
LIMIT + no WHERE + not aggregate) and require a `where` on update/delete — mapped
to `400`. See [15 §7](15-security-and-governance-architecture.md#7-the-industrial-safety-shield).

## Operations & observability

**Execution trace / plan.** The per-response `plan { strategy, executionMs,
rowsScannedAcrossSources, pushed[], legs[] }` proving how a query ran. See
[09](09-execution-trace.md).

**Leg.** One source-level unit of work within a query (a scan, bind-join,
partial-aggregate, set-op leg, …), traced individually.

**Query log.** The durable audit trail (`fabric_system.query_logs`): every run's
mode, strategy, TAT, memory delta, row counts, legs, warnings, and outcome. See
[16](16-observability-and-query-log.md).

**TAT (turnaround time).** End-to-end wall-clock for a request including fabric
overhead; `tat_ms − execution_ms` isolates planning/merge/compensation cost.

**Saved analytic.** A reusable, `{{variable}}`-parameterized query (AST or SQL)
defined once and run/triggered with inputs — the fabric's saved-query / scheduled-
report primitive. See [13](13-api-catalog.md#saved-analytics--apisaved-analytics-requireauth).

**Trigger.** A declarative action (procedure / execute / action) fired around a
mutation or on a schedule, backed by a durable job queue; native manifest triggers
run in Postgres and enqueue a durable job for downstream engines. See [11](11-stateful-feature-compensation.md).

**SAGA consistency.** Manifest apply semantics where a failing remote/downstream
leg marks that op `DEGRADED` (hub schema still lands) rather than rolling back the
whole apply. See [07](07-metadata-orchestration.md).

**Cap-and-warn.** The bounded-memory discipline: federated legs
(`FABRIC_FED_MAX_ROWS_PER_LEG`) and bind-key lists (`FABRIC_FED_BIND_MAX_KEYS`)
are capped and the truncation is reported in `warnings[]` — never silent.
