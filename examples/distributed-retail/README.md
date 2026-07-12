# Distributed Retail Analytics — federation example & test suite

A realistic, multi-database analytics scenario that doubles as the fabric's
integration test. Data is distributed across **three genuinely separate external
databases** that the data fabric federates over — **nothing is stored in the
fabric's own control-plane database**.

## Topology

| Fabric source        | Engine            | Physical DB              | Tables / collections                              |
|----------------------|-------------------|--------------------------|---------------------------------------------------|
| `Retail_Core`        | PostgreSQL `:5436`| `retail_core`            | `customers`, `orders`, `v_customer_orders` (view), `mv_daily_region_sales` (materialized view) |
| `Product_Warehouse`  | PostgreSQL `:5436`| `retail_wh`              | `products`, `order_items`                         |
| `Web_Analytics`      | MongoDB `:27017`  | `retail`                 | `web_events`                                      |

Every table holds **5,000+ rows** (customers 6k, orders 9k, products 5k,
order_items 18k, web_events 12k). Foreign keys are maintained **across
databases** (`order_items.order_id → orders.id`; `web_events.customer_id →
customers.id`) — no cross-DB FK is enforceable, which is exactly why the fabric
must join them.

## What it demonstrates

1. **Cross-source federation with pushdown** — a join of Postgres `orders` and
   Mongo `web_events` filtered to one customer pushes the predicate to Postgres,
   then a **bind-join** (`customer_id IN (…)`) to Mongo, pulling only the handful
   of matching rows and merging the final result. Proven by the per-leg
   execution trace in the response (`plan.legs`).
2. **Partial-aggregate pushdown** — `GROUP BY` runs as native `GROUP BY` on
   Postgres and as a `$group` pipeline on Mongo; each source returns *groups*,
   not rows.
3. **Complex single-source SQL at the owning engine** — window functions,
   recursive CTEs and materialized-view reads execute **at** the external
   Postgres that owns the data (via the connector's native-SQL path), not on the
   fabric hub.
4. **Execution transparency** — every query returns `plan.strategy`,
   `plan.executionMs`, `plan.rowsScannedAcrossSources`, and a per-leg trace
   (`source / engine / mode / operation / rowsReturned / ms / query`) so you can
   see what ran where.

## Scripts

| File | What it does |
|------|--------------|
| `01-seed-external-sources.js` | Creates + seeds the three external databases (5k+ rows each). |
| `02-register-sources.js`      | Registers them as fabric datasources + populates the catalog (metadata only). |
| `03-analytics-suite.js`       | 12 scenarios (federated joins/aggregates + remote window/recursive/matview) with **pushdown assertions** on the trace. |
| `04-tat-audit.js`             | Execution-time / TAT audit: matview vs live recompute, REFRESH cost, recursive traversal. |
| `05-real-world-scenarios.js`  | RFM · cohort retention · moving average · Pareto/ABC · cross-source funnel. |
| `06-ast-cookbook.js`          | Every AST feature: projection, all WHERE operators, sort/paginate, aggregates+GROUP BY, multi-source aggregate, cross-source joins, UNION/INTERSECT/EXCEPT. |
| `07-crud-api-examples.js`     | The simple `/api/data` fetch/create/update/delete endpoints on Postgres + Mongo (self-cleaning). |
| `run-all.js`                  | Runs everything (`--seed` to (re)seed + register first). |

See also [`docs/QUERY_API_REFERENCE.md`](../../docs/QUERY_API_REFERENCE.md) for the
complete AST + CRUD syntax, and [`examples/metadata/`](../metadata/) for manifest examples.

## Run

```bash
# prereqs: docker stack up (hub, remote PG :5436, mongo :27017, redis), backend on :4000
cd examples/distributed-retail

# first time (seed external DBs + register sources), then run all tests:
node run-all.js --seed

# subsequent runs (data already present):
node run-all.js
```

Individual scripts can be run directly, e.g. `node 03-analytics-suite.js`.
The seed/register scripts need the driver libs, so run them with
`NODE_PATH=../../backend/node_modules` (handled automatically by `run-all.js`).
