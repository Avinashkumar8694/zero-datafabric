# Demo Example One: Zero Data Fabric Microservice Schema & Migration Test Suite

An automated, end-to-end verification service and test suite validating **Zero Data Fabric** against real-world schema evolutions from `zero-payment-ms` (25 consecutive declarative migrations, custom functions, sequences, recursive CTEs, triggers, table partitioning, RLS, column masking, declarative views, materialized views, analytical queries, M:N relationships, exclusion constraints, in-fabric graph BFS recursion, async jobs, streaming NDJSON, REST CRUD APIs, and boundary edge cases).

> [!IMPORTANT]
> **Strict AST Architecture**: 100% of all operations across tests, mutations, queries, migrations, and function calls are executed strictly via declarative JSON AST objects sent to Data Fabric's public REST APIs (`/api/metadata/apply`, `/api/metadata/diff`, `/api/analytics/query`, `/api/analytics/query-async`, `/api/data/*`, `/api/analytics/refresh-view`). **Zero raw SQL strings or direct database client queries are used anywhere.**

---

## Features Tested & Verified

1. **Declarative Metadata Provisioning**: Full lifecycle orchestration via `/api/metadata/diff` and `/api/metadata/apply` across 25 evolution steps.
2. **Schema & Object Handling**:
   - Sequences creation (`CREATE_SEQUENCE`) with custom starts and cache settings.
   - Functions & Procedures creation (`CREATE_FUNCTION`, `CREATE_PROCEDURE`) with scalar logic, recursion, parameter modes (`IN`, `OUT`, `INOUT`), and procedural operations.
   - Enums creation (`CREATE TYPE ... AS ENUM`) and incremental value additions (`ALTER TYPE ... ADD VALUE`).
   - Tables creation (UUID v7 strategies, sequences, default values, primary & foreign keys, CHECK constraints, EXCLUDE constraints, table maintenance parameters).
   - Top-Level Declarative Relationships (`relationships: [{ cardinality: 'M:N', bridge: ... }, { cardinality: '1:M' }]`) with automatic bridge table generation.
   - Postgres Whitelisted Extensions (`btree_gist`, `citext`, `pgcrypto`).
   - Case-Insensitive Types (`CITEXT`) with uniqueness guarantees.
   - Composite Primary Keys (`identity: { type: 'PRIMARY_KEY', columns: ['tenantId', 'metaKey'] }`).
   - Table and column comments (`comment: "..."`).
   - Functional Triggers (`BEFORE INSERT ... FOR EACH ROW EXECUTE FUNCTION ...`).
   - Table Partitioning (`PARTITION BY RANGE`).
   - Stored Generated Columns (`GENERATED ALWAYS AS (...) STORED`).
   - Row-Level Security (RLS) & Column Masking (`security.enable_rls`, policies, masking).
   - Column additions (`ALTER TABLE ... ADD COLUMN IF NOT EXISTS`) across multiple existing tables.
   - Data type alterations and column widening (e.g., `webhooks.secret` widened from 255 to 500 characters, `ip_block_entries.ipOrCidr` altered for IPv6, and `tenants.plan` converted from ENUM to `VARCHAR(50)`).
3. **Cross-Type Schema Transformations**:
   - String $\rightarrow$ Number (`INTEGER`, `NUMERIC`, `BIGINT`).
   - Number $\rightarrow$ String (`VARCHAR`, `TEXT`).
   - Boolean $\rightarrow$ String (`VARCHAR(10)`).
   - String $\rightarrow$ Boolean (`'true'`, `'false'`, `'1'`, `'0'` $\rightarrow$ `BOOLEAN`).
   - Timestamp $\rightarrow$ Date (`DATE`).
   - Complex JSON text $\rightarrow$ native `JSONB`.
4. **Exhaustive Edge Cases & Boundary Conditions**:
   - **NULL Preservation**: Complete preservation of `NULL` across all converted types (`nullStrToInt`, `nullNumToStr`, `nullBoolToStr`, `nullTsToDate`).
   - **Boundary Numeric Extremes**: Exact preservation of INT4 Max (`2147483647`), INT4 Min (`-2147483648`), 64-bit BigInt (`9223372036854775806`), High-Precision Decimals (`123456789.987654`), and Negative Decimals (`-9999.75`).
   - **Unicode, Multi-Lingual & Emojis**: Complex character preservation including emoji and SQL-injection payloads (`Payment 🚀 ₹50,000 日本語 "O'Connor" ; DROP TABLE --`).
   - **Negative Rejections**: Verifying strict engine rejections on:
     1. Integer Overflow (values exceeding 32-bit INT4 Max).
     2. Decimal strings to Integer (`'123.45'` $\rightarrow$ INT).
     3. Empty strings to Integer (`''` $\rightarrow$ INT).
     4. Invalid boolean literals (`'maybe'` $\rightarrow$ BOOLEAN).
     5. Malformed JSON payloads (`'{bad json'` $\rightarrow$ JSONB).
     6. String length narrowing truncation (values longer than target `VARCHAR(N)`).
     7. Overlapping range exclusion violations (`EXCLUDE` using GIST on `INT4RANGE`).
     8. Case-insensitive duplicate collisions on `CITEXT`.
   - **Atomic Transaction Rollback**: Ensuring complete transactional rollback on Hub Postgres when incompatible DDL fails, preventing schema drift or corrupted partial state.
5. **Views & Materialized Views (Advanced Analytical Engine)**:
   - **Declarative `VIEW`**: Evaluated CTE (`WITH RECURSIVE`), window functions (`RANK`, `DENSE_RANK`, `ROW_NUMBER`), multi-table relational `JOIN`s, and computed expressions (`cp.amount * 0.18`).
   - **Declarative `MATERIALIZED_VIEW`**: Evaluated analytical aggregations (`COUNT`, `SUM`, `AVG`, `MAX`, `MIN`), `GROUP BY`, `HAVING`, and window ranking.
   - **Secondary B-Tree Indexes**: Validated secondary indexes automatically provisioned on materialized view columns.
   - **Cache Snapshot & REFRESH Lifecycle**: Validated snapshot isolation before refresh and immediate data propagation upon `REFRESH MATERIALIZED VIEW`.
6. **In-Fabric Graph Traversal (`RecursiveExecutor`)**:
   - Level-by-level BFS hierarchy walking across arbitrary resources without raw SQL.
   - Automatic `depth` annotation and breadcrumb `path` array materialization.
7. **Control Plane & Advanced Query Engine**:
   - **DISTINCT Projections**: Native deduplication in AST queries.
   - **HAVING Filters**: In-fabric post-aggregation predicate filtering.
   - **Navigation Window Functions**: `LAG` and `LEAD` with offsets and partitions.
   - **Running Window Aggregates**: Cumulative `SUM`, `AVG`.
   - **Statistical & Array Aggregates**: `ARRAY_AGG`, `VARIANCE`, `STDDEV`, `COUNT_DISTINCT`.
   - **Async Job Execution**: Background query dispatch via `POST /api/analytics/query-async` and polling `/jobs/:id`.
   - **NDJSON Streaming**: Opt-in streaming responses via `Accept: application/x-ndjson`.
   - **REST Data CRUD**: Dedicated `/api/data` endpoints (`/sequence`, `/create`, `/fetch`, `/update`, `/delete`, `/call`).
   - **Catalog Lineage & History**: Endpoints for ER relationships (`/api/metadata/relationships`) and deployment logs (`/api/metadata/history`).
8. **Data Durability & Preservation**:
   - Validated that baseline records inserted in Step 00 survived all 25 migration cycles completely intact without corruption or data loss.

---

## Supported Query Engine Operations Catalog

Zero Data Fabric's AST query engine (`QueryTranspiler`) and analytical query router support the following operations:

| Category | Supported Operations / Syntax | Description & Examples |
|:---|:---|:---|
| **CTEs (`with`)** | `WITH RECURSIVE`, `name`, `columns`, `base`, `unionAll` | Hierarchical and common table expressions combining base queries with recursive union legs |
| **In-Fabric Recursion** | `query: { recursive: { resource, connectBy, pathColumn } }` | BFS traversal with depth tracking and breadcrumb paths (`RecursiveExecutor`) |
| **Projections (`select`)** | Column names, qualified paths (`t.col`), `*`, `distinct: true` | Target column selections, aliasing (`alias: 'new_name'`), and distinct projections |
| **Computed Expressions** | `{ expression: "col * 0.18", alias: "tax" }` | Arbitrary sanitized SQL math and functional expressions |
| **Navigation Windows** | `LAG`, `LEAD` | Navigational windowing over ordered partitions with offsets |
| **Window Functions** | `RANK`, `DENSE_RANK`, `ROW_NUMBER`, `PERCENT_RANK`, `CUME_DIST` | Window evaluations with optional `partitionBy` and ordered partitions |
| **Running Aggregates** | Cumulative `SUM`, `AVG` over window partitions | Dynamic cumulative totals over time-ordered records |
| **Aggregate Functions** | `COUNT`, `SUM`, `AVG`, `MIN`, `MAX`, `STDDEV`, `VARIANCE`, `ARRAY_AGG`, `BOOL_AND`, `BOOL_OR`, `COUNT_DISTINCT` | Group-level aggregations on columns or expressions with custom aliases |
| **Relational Joins** | `INNER`, `LEFT`, `RIGHT`, `FULL`, `CROSS` | Multi-table relational joins with dotted equi-join conditions (`on: { left, operator, right }`) |
| **Predicates & Filtering (`where`)** | `EQ` (`=`), `NE` (`!=`), `GT` (`>`), `GTE` (`>=`), `LT` (`<`), `LTE` (`<=`), `LIKE`, `ILIKE`, `IN`, `NIN` (`NOT IN`), `NOT_LIKE`, `IS_NULL`, `IS_NOT_NULL` | Value comparisons, array membership, null checks, and expression predicates |
| **Full-Text Search** | `{ search: { column: 'title', query: 'enterprise' } }` | Native Postgres full-text indexing via `to_tsvector @@ plainto_tsquery` |
| **Grouping & Post-Aggregation** | `groupBy: ['tenantId', 'name']`, `having: [...]` | Aggregation grouping arrays and post-aggregate `HAVING` filters referencing aggregate aliases |
| **Ordering & Paging** | `orderBy: [{ column, direction: 'ASC'\|'DESC' }]`, `limit`, `offset` | Bounded pagination and multi-column sorting |
| **Set Operations** | `union`, `intersect`, `except` | Set combinations of distinct subqueries with top-level sorting and limits |
| **Views & Materialized Views** | `type: 'VIEW'`, `type: 'MATERIALIZED_VIEW'`, `indexes: [...]` | Declarative definitions compiled directly into Postgres views and materialized views with secondary indexing |
| **Async Execution** | `POST /api/analytics/query-async`, `GET /api/analytics/jobs/:id` | Non-blocking execution of long-running queries with job status polling |
| **Streaming Query** | `Accept: application/x-ndjson` or `stream: true` | Real-time newline-delimited JSON streaming of query rows and plan trailers |
| **REST Data CRUD** | `/api/data/{create,fetch,update,delete,call,sequence}` | Clean resource-oriented data mutations and allocations |

---

## 25 Migration Steps Covered

| Step | Migration Name | Key Schema Evolutions |
|:---:|:---|:---|
| **00** | `InitialSchema` | 14 baseline tables + 14 ENUMs (tenants, roles, payments, refunds, webhooks, audit_logs, etc.) |
| **01** | `CheckoutTokenAndProviderChannel` | `payments.checkoutToken` (VARCHAR 128 UNIQUE), `provider_configs.channel` (VARCHAR 50) |
| **02** | `DisputesCaptureAndWebhookDurability` | Table `disputes` + `dispute_status_enum`, payments capture metrics, webhooks durability |
| **03** | `TenantPendingVerification` | `ALTER TYPE tenant_status_enum ADD VALUE 'pending_verification'` |
| **04** | `CustomerIdentityAndRefundRules` | Tables `customers` and `refund_rules` |
| **05** | `ProductionHardening` | Widened `webhooks.secret` (255 $\rightarrow$ 500), `ipOrCidr` for IPv6, Table `payment_links` |
| **06** | `PaymentMethodSelection` | JSONB method restrictions on `payment_links.allowedMethods`, `enforceMethods` flag |
| **07** | `ProviderSoftDelete` | Soft deletion timestamp `provider_configs.deletedAt` |
| **08** | `MoneyHardening` | Idempotency & request hashes on `payments` and `refunds` |
| **09** | `ProviderCallbackForwarding` | Provider-scoped webhook routing via `webhooks.providerConfigId` |
| **10** | `PlansAndTrials` | Tables `plans`, `plan_requests`; **Major Type Change**: `tenants.plan` ENUM $\rightarrow$ VARCHAR(50) |
| **11** | `HideLegacyPlans` | Status migration and filtered query resolution for legacy plans |
| **12** | `BackgroundJobs` | Tables `background_jobs`, `background_job_runs`, `job_queue_items` |
| **13** | `TypeTransformations` | **Cross-Type Schema Evolution**: String $\rightarrow$ Number (`rateLimitQuota`, `retryCountString`, `priorityScore`), Number $\rightarrow$ String (`batchSize`, `timeoutMs`, `priority`), Boolean $\rightarrow$ String (`isEnabled`), String $\rightarrow$ Boolean (`autoRetry`), Timestamp $\rightarrow$ Date (`completedAt`) |
| **14** | `EdgeCasesAndBoundaries` | **Boundaries & Edge Cases**: NULL preservation, INT4 Max/Min, 64-bit BigInt, High-precision decimals, Boolean variants (`'true'`, `'false'`, `'1'`, `'0'`), JSON to JSONB, Unicode/emojis, 7 negative rejection assertions, and atomic transaction rollback |
| **15** | `ViewsAndMaterializedViews` | **Views & Materialized Views Engine**: Declarative `VIEW` (CTE, RANK, DENSE_RANK, ROW_NUMBER, 3-table JOIN, expressions), Declarative `MATERIALIZED_VIEW` (COUNT, SUM, AVG, MAX, MIN, secondary B-Tree indexes, GROUP BY, HAVING, cache REFRESH verification), Direct Query API windowing, multi-way joins, and set operations (`UNION`) |
| **16** | `SequencesAndCustomFunctions` | **Database Sequences & Custom Functions**: Native sequences (`seq_invoice_number`, `seq_settlement_batch`), custom scalar PL/pgSQL function (`calculate_processing_fee`), custom recursive function (`calculate_referral_bonus`), stored procedure (`mark_batch_settled`), and invocations via AST `type: 'CALL'` |
| **17** | `RecursiveCTEsAndTriggers` | **Hierarchical Traversals, CHECK Constraints & Triggers**: Multi-level hierarchical affiliate tree, Declarative View with `WITH RECURSIVE referral_tree`, `CHECK` constraints with range validation & rejection, and functional auto-hashing triggers |
| **18** | `PartitioningIndexesAndGeneratedCols` | **Table Partitioning & Stored Generated Columns**: Stored generated columns (`subtotal * 0.18`), range partitioning (`high_volume_audit_partitioned`), GIN index on JSONB, BRIN index on timestamp, and table maintenance parameter tuning (`fillfactor`, `autovacuum`) |
| **19** | `SecurityRLSAndMasking` | **Row-Level Security (RLS) & Column Masking**: Native table RLS (`security.enable_rls: true`), dynamic tenant isolation policies, column masking rules, and role grant permissions |
| **20** | `AdvancedQueryOperations` | **Advanced Analytical AST Operations**: Set operations `INTERSECT` and `EXCEPT`, derived subqueries in `FROM`, window functions (`PERCENT_RANK`, `CUME_DIST`), statistical aggregates (`COUNT_DISTINCT`, `AVG`, `STDDEV`), and full-text search (`search` operator) |
| **21** | `RelationshipsAndExtensions` | **Declarative Relationships & Extensions**: `tags` with `CITEXT`, `tenant_metadata` with composite PK (`tenantId` + `metaKey`), auto-generated M:N bridge table `invoice_tags_bridge`, 1:M relationships, whitelisted extensions (`btree_gist`, `citext`, `pgcrypto`) |
| **22** | `ExclusionConstraintsAndParamModes` | **Exclusion Constraints & Function Modes**: `merchant_operating_windows` with GIST EXCLUDE on `[tenantId =, slotRange &&]` using `INT4RANGE`, overlap rejections, custom function `calculate_tiered_rebate` with parameter mode `IN` |
| **23** | `InFabricGraphAndAnalytics` | **In-Fabric Graph BFS Traversal**: `organization_hierarchy` table, multi-level hierarchy querying via `RecursiveExecutor`, depth tracking, and breadcrumb path arrays |
| **24** | `AdvancedEngineFeatures` | **Engine Features & REST Data APIs**: `distinct: true`, `having`, window `LAG`/`LEAD`, running `SUM`, `ARRAY_AGG`, `VARIANCE`, async query enqueue & job polling, NDJSON streaming, REST CRUD (`/sequence`, `/create`, `/fetch`, `/update`, `/delete`, `/call`), catalog lineage and deployment history |

---

## Quick Start

### 1. Run the Test Suite CLI
```bash
cd demo/demo-example-one
npm test
# or
node src/runner.js
```

### 2. Start the Demo API Server
```bash
cd demo/demo-example-one
npm start
```
The service will start on `http://127.0.0.1:5050`.

### 3. API Endpoints
- `GET /health` — Service health and Data Fabric engine connectivity status.
- `GET /api/manifests` — Inspect all 25 migration manifests, tables, enums, views, and functions.
- `POST /api/test/run` — Trigger the full 25-step migration test suite.
- `GET /api/test/status` — Get status and summary of the latest test run.
- `GET /api/test/report` — Detailed test execution report with assertion timings.

---

## Test Execution Results

```text
══════════════════════════════════════════════════════════════════════
  ZERO DATA FABRIC: PAYMENT-MS FULL MIGRATION & ROBUSTNESS TEST
══════════════════════════════════════════════════════════════════════
Total Test Steps:        25 migrations (Steps 00 to 24)
Total Assertions:        217
Assertions Passed:       217
Assertions Failed:       0
Total Execution Time:    28.61s
Status:                  SUCCESS
══════════════════════════════════════════════════════════════════════
```
