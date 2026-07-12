# bulk-test — 2000+ generated query validation suites

Large-scale, oracle-checked validation of the query engine across **same-source**
and **cross-datasource** execution. Every query is generated as the fabric's
engine-agnostic **AST** (`queryConfig.query`) and its expected result is computed
in JavaScript from the ground-truth datasets (`oracle.js`), so data validity is
asserted automatically — not eyeballed.

## Suites

| File | Queries | Focus |
|---|---|---|
| `suite_same_and_cross.js` | ~1035 | Every core concept: scans (all operators, ranges, IN, ILIKE), projection, limit/offset, scalar + grouped aggregates (COUNT/SUM/MIN/MAX/AVG), HAVING, DISTINCT, co-located self-join, set-ops (UNION/INTERSECT/EXCEPT), CTE (scan + agg), derived tables, + cross-source INNER/LEFT joins and set-ops (PG × Mongo). |
| `suite_cross_analytics.js` | ~1052 | Cross-**datasource** analytics only (PG × Mongo × MySQL): INNER/LEFT joins, multi-key GROUP BY, all aggregates, HAVING, top-N, group + ORDER + OFFSET + LIMIT, DISTINCT, cross-source set-ops, **3-way joins**, **window functions** over a cross-engine join, multi-aggregate, multi-predicate, guarded nested-cross-engine error. |
| `examples_ast_sql.js` | 20 | **Hand-crafted real-world business analytics** over a retail star schema across **FOUR engines** (Postgres, MongoDB, MySQL, Elasticsearch), each as **paired AST + SQL** with a JS oracle. Runs AST via the planner and (for single-source) SQL via `/api/queries/exec`. Patterns: revenue trend, top-N, running rank (ROW_NUMBER/RANK), median (PERCENTILE), CTE, non-equi join, RFM, cohort revenue, category share, AOV, HAVING, 3-way join, retention set-op, search-engine aggregate. |
| `suite_crud_functions.js` | 14 checks | **Write side**: CRUD APIs (`/api/data/create,fetch,update,delete`), the fabric **sequence** endpoint (`nextval` for any engine), **write-value generators** (UUID_V7 + custom sequence on insert), a fabric **CREATE FUNCTION** + `/api/data/call`, and the update/delete WHERE-required safety guards. Stateful/sequential. |
| `EXAMPLES.md` | — | Human-readable reference: every example's SQL + AST side by side (generated via `gen_examples_md.js`). |
| `analyze_legs.js` | 23 | Per-example **leg analysis**: asserts each example's expected strategy + leg shape and prints the actual pushed query per source (pushdown / join operator / no naked scans). |
| `oracle.js` | — | Shared ground-truth datasets, JS oracle helpers, HTTP client, concurrent runner, reporter. |
| `run_all.js` | 2087 | Runs both generated suites, prints combined pass/fail + strategy (leg) distribution. |

Run the examples: `cd backend && NODE_PATH=./node_modules node ../bulk-test/examples_ast_sql.js`

## Run

```bash
# backend must be running on :4000 (npm run start:backend or ts-node src/index.ts)
cd backend
NODE_PATH=./node_modules node ../bulk-test/run_all.js
# or a single suite:
NODE_PATH=./node_modules node ../bulk-test/suite_cross_analytics.js
```

Exit code 0 iff every query passed. Output includes the **strategy distribution**
(`SINGLE_CONNECTOR` = co-located / single-source pushdown, `CROSS_ENGINE` =
federated, `CROSS_ENGINE+WINDOW` = federated + in-fabric window, `ERROR` = the one
intentionally-guarded nested-cross-engine case).

## Data setup (tenant `tenant_advanced_test`)

Deterministic datasets keyed on `id 1..28` across three engines:

| Object | Engine / source | Data |
|---|---|---|
| `remote_table` | Postgres — `PG_DSN_Source` (localhost:5436/remote_warehouse) | `id 1..28`, `value = odd?100:200`, `name` |
| `dim` | MongoDB — `Local_Mongo` (localhost:27017, db `fabric_test`) | `id 1..28`, `grade` (gold/silver/bronze cycle), `region` (EAST/WEST), `qty=id` |
| `enrich` | MongoDB — `Local_Mongo` | `id {2,4,6}`, `grade` (sparse — drives LEFT-join coverage) |
| `metrics` | MySQL — `Local_MySQL` (localhost:3307/retail) | `id 1..28`, `category` (A/B/C/D cycle), `score=id*5` |

Seed commands (idempotent):

```bash
# Mongo dim
docker exec datafabric-mongodb mongosh --quiet --eval '
db=db.getSiblingDB("fabric_test"); db.dim.drop();
const g=["gold","silver","bronze"],d=[];
for(let id=1;id<=28;id++)d.push({id,grade:g[(id-1)%3],region:((id-1)%2===0)?"EAST":"WEST",qty:id});
db.dim.insertMany(d);'

# Mongo enrich
docker exec datafabric-mongodb mongosh --quiet --eval '
db=db.getSiblingDB("fabric_test"); db.enrich.drop();
db.enrich.insertMany([{id:2,grade:"gold"},{id:4,grade:"silver"},{id:6,grade:"bronze"}]);'

# MySQL metrics
docker exec datafabric-mysql sh -lc 'mysql -uroot -pmysql_password retail <<SQL
DROP TABLE IF EXISTS metrics;
CREATE TABLE metrics (id INT PRIMARY KEY, category VARCHAR(8), score INT);
INSERT INTO metrics SELECT n, ELT((n-1)%4+1,"A","B","C","D"), n*5 FROM
 (SELECT @r:=@r+1 n FROM information_schema.columns,(SELECT @r:=0) x LIMIT 28) t;
SQL'
```

The three sources + catalog rows (`dim`, `enrich`, `metrics`) must be registered
in `public.data_sources` / `catalog_schemas` / `catalog_tables` for the tenant.

### Retail star schema (for `examples_ast_sql.js`)

Additional realistic dataset for the hand-crafted examples, across FOUR engines:

| Object | Engine / source | Data |
|---|---|---|
| `orders` | Postgres — `PG_DSN_Source` (public) | `order_id 1..100`, `customer_id`, `product_id`, `qty`, `amount`, `order_month 1..6`, `status` (86 COMPLETED / 14 CANCELLED) |
| `customers` | MongoDB — `Local_Mongo` (fabric_test) | `customer_id 1..20`, `name`, `region` (EAST/WEST), `signup_month` |
| `products` | MySQL — `Local_MySQL` (retail) | `product_id 1..10`, `category` (Electronics/Home/Toys), `price` |
| `webviews` | Elasticsearch — `Local_ES` (index `webviews`) | `customer_id 1..20`, `channel` (web/mobile/store, keyword), `views` |

```bash
# Postgres orders (remote_warehouse @ 5436)
docker exec -i -e PGPASSWORD=remote_password datafabric-remote psql -U remote_admin -d remote_warehouse <<'SQL'
DROP TABLE IF EXISTS public.orders;
CREATE TABLE public.orders (order_id int PRIMARY KEY, customer_id int, product_id int, qty int, amount int, order_month int, status text);
INSERT INTO public.orders SELECT o, ((o-1)%20)+1, ((o-1)%10)+1, ((o-1)%3)+1,
  (((o-1)%10)+1)*10*(((o-1)%3)+1), ((o-1)%6)+1,
  CASE WHEN o%7=0 THEN 'CANCELLED' ELSE 'COMPLETED' END FROM generate_series(1,100) o;
SQL

# Mongo customers
docker exec datafabric-mongodb mongosh --quiet --eval '
db=db.getSiblingDB("fabric_test"); db.customers.drop(); const d=[];
for(let c=1;c<=20;c++)d.push({customer_id:c,name:"Cust "+c,region:(c%2===1)?"EAST":"WEST",signup_month:((c-1)%6)+1});
db.customers.insertMany(d);'

# MySQL products
docker exec datafabric-mysql sh -lc 'mysql -uroot -pmysql_password retail <<SQL
DROP TABLE IF EXISTS products;
CREATE TABLE products (product_id INT PRIMARY KEY, category VARCHAR(16), price INT);
INSERT INTO products SELECT n, ELT((n-1)%3+1,"Electronics","Home","Toys"), n*10 FROM
 (SELECT @r:=@r+1 n FROM information_schema.columns,(SELECT @r:=0) x LIMIT 10) t;
SQL'

# Elasticsearch webviews (channel = keyword for grouping)
curl -s -X PUT localhost:9200/webviews -H 'Content-Type: application/json' \
  -d '{"mappings":{"properties":{"customer_id":{"type":"integer"},"channel":{"type":"keyword"},"views":{"type":"integer"}}}}'
# then bulk-index customer_id 1..20 with channel ∈ {web,mobile,store}, views = id*2
```

Register `orders` (PG/public), `customers` (Mongo/fabric_test), `products` (MySQL/retail),
`webviews` (ES/default) as catalog tables under their sources for `tenant_advanced_test`.

## What it proves

- **Same-source** queries (incl. joins, set-ops, CTEs, derived tables) collapse to
  ONE pushed-down leg (`SINGLE_CONNECTOR`), never a fabric-side scan.
- **Cross-datasource** queries federate correctly across Postgres, MongoDB, and
  MySQL — INNER/LEFT joins, grouped analytics, top-N, DISTINCT, set-ops, 3-way
  joins, and window functions all return oracle-correct data.
- The only unsupported shape (a nested CTE/derived query spanning multiple
  engines) fails with a clear, actionable error rather than a crash.
