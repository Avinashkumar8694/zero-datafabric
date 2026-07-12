# Zero Data Fabric — Examples

Runnable scripts that exercise the fabric's query, federation, aggregation and
orchestration capabilities against the running API.

## Prerequisites

```bash
npm run setup                 # install deps + docker-compose up -d + db:migrate
cd backend && npm run db:seed # seed tenant_A, admin/admin, default data sources
npm run start:backend         # API on :4000  (npm run start also starts the UI)
npm run examples:prepare      # provisions demo schemas/tables/rows + sources
```

All scripts share `examples/_client.js`. Configure via env vars:

| Var | Default |
|---|---|
| `BASE_URL` | `http://127.0.0.1:4000/api` |
| `TENANT_ID` | `tenant_A` |
| `DF_USER` / `DF_PASS` | `admin` / `admin` |

Scripts print `PASS`/`WARN`/`FAIL` per call. Most federation examples use
`allowFail` so a missing demo source doesn't abort the run.

## Run everything

```bash
npm run examples:all        # ordered end-to-end suite (prepare → queries → federation → …)
```

## Catalog of examples

| Script | npm script | Demonstrates |
|---|---|---|
| `prepare-demo-env.js` | `examples:prepare` | Registers 3 sources + provisions demo schemas/tables/rows (run first) |
| `register-3-datasources.js` | `examples:sources` | Registering Postgres/Mongo/ES sources |
| `inserts-all-datasources.js` | `examples:inserts` | AST + SQL INSERT across sources |
| `all-query-types.js` | `examples:queries` | SQL & AST: SELECT, WHERE, ORDER BY, JOIN, UNION, recursive CTE, sync/async |
| `multi-datasource-queries.js` | `examples:multisource` | Cross-source UNION / INTERSECT / EXCEPT (planner → federation) |
| **`federated-aggregate.js`** | **`examples:fed-aggregate`** | **Multi-source COUNT/SUM/AVG/GROUP BY via partial-aggregate pushdown** |
| **`federated-join-pushdown.js`** | **`examples:fed-join`** | **Cross-source JOIN with predicate + bind-join pushdown; post-join aggregate** |
| `aggregation-and-complex.js` | `examples:complex` | Single-source aggregates, window functions, CTE + multi-join |
| `update-delete-advanced.js` | `examples:mutations` | AST UPDATE/DELETE (Mongo-style filters), soft-delete |
| `views-mviews-sequences-procs-triggers.js` | `examples:views` | Views, materialized views, sequences, procedures |
| `trigger-engine-examples.js` | `examples:triggers` | Trigger control plane (ROW / CRON / webhook / email) |

## What to watch

The federation examples print the response `plan` (strategy + what was pushed)
and `warnings`. On the backend logs you'll see the efficiency proof:

- `[PostgresConnector]/[MongoDBConnector]/[ElasticsearchConnector] Pushdown …`
- `[Federation] local leg … / connector leg …`
- `[Federation] … bind-join: pushed N key(s) as <col> IN (...)`
- `[Federation] … partial aggregate [SUM,COUNT] GROUP BY [region] pushed to <source>`

These confirm the fabric pushes filters/joins/aggregates down to each source
instead of fetching whole tables. See `backend/src/docs/federation_architecture.md`.
