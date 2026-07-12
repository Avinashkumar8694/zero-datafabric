# Recursive CTEs, window functions & materialized views

The AST layer covers filter/join/aggregate/set-op. For **complex single-source
analytics** — recursive CTEs, window functions, materialized-view reads — send
**native SQL** and target the source that owns the data with `source`:

```
POST /api/queries/exec
{ "source": "Retail_Core", "schema": "public", "sql": "<SQL>" }
```

- `source` — the datasource to execute at (omit to run on the hub). Only
  SQL-native engines (Postgres/MySQL/Snowflake) accept it.
- `schema` — sets `search_path` at the source so unqualified names resolve.
- Response is the standard envelope with `plan.strategy = "SINGLE_CONNECTOR_RAW"`
  and a one-leg trace (`operation: "raw-sql"`, with source-side `ms`).

---

## Recursive CTEs

Traverse hierarchies / graphs (org charts, referral trees, BOM, categories).

### Downward traversal (tree from a root)

```sql
WITH RECURSIVE tree AS (
  SELECT id, referred_by, 1 AS depth
  FROM customers
  WHERE id = 1                          -- anchor
  UNION ALL
  SELECT c.id, c.referred_by, t.depth + 1
  FROM customers c
  JOIN tree t ON c.referred_by = t.id   -- recursive step
)
SELECT depth, count(*) AS members
FROM tree GROUP BY depth ORDER BY depth;
```

```jsonc
POST /api/queries/exec
{ "source": "Retail_Core", "schema": "public",
  "sql": "WITH RECURSIVE tree AS (SELECT id, referred_by, 1 AS depth FROM customers WHERE id=1 UNION ALL SELECT c.id, c.referred_by, t.depth+1 FROM customers c JOIN tree t ON c.referred_by=t.id) SELECT depth, count(*) members FROM tree GROUP BY depth ORDER BY depth" }
```

### Full-forest traversal (all roots)

```sql
WITH RECURSIVE tree AS (
  SELECT id, referred_by, 1 AS depth FROM customers WHERE referred_by IS NULL
  UNION ALL
  SELECT c.id, c.referred_by, t.depth + 1 FROM customers c JOIN tree t ON c.referred_by = t.id
)
SELECT depth, count(*) FROM tree GROUP BY depth ORDER BY depth;
```

### Path accumulation

```sql
WITH RECURSIVE p AS (
  SELECT id, name, name::text AS path, 1 lvl FROM employees WHERE manager_id IS NULL
  UNION ALL
  SELECT e.id, e.name, p.path || ' -> ' || e.name, p.lvl + 1
  FROM employees e JOIN p ON e.manager_id = p.id
)
SELECT * FROM p ORDER BY path LIMIT 20;
```

> Guard cyclic data with a `depth < N` predicate or `UNION` (dedup) instead of
> `UNION ALL`.

### Recursive CTE reading from a view

The recursive term can reference views/matviews of the same source:

```sql
WITH RECURSIVE tree AS (
  SELECT id, referred_by, 1 depth FROM customers WHERE referred_by IS NULL
  UNION ALL
  SELECT c.id, c.referred_by, t.depth+1 FROM customers c JOIN tree t ON c.referred_by = t.id
)
SELECT t.depth, count(DISTINCT vco.order_id) orders, sum(vco.total_amount) revenue
FROM tree t LEFT JOIN v_customer_orders vco ON vco.customer_id = t.id
GROUP BY t.depth ORDER BY t.depth;
```

---

## Window functions

Ranking, running totals, moving averages, lead/lag, quartiles.

```sql
-- Top-N per group
SELECT category, name, revenue FROM (
  SELECT p.category, p.name, sum(i.line_amount) revenue,
         row_number() OVER (PARTITION BY p.category ORDER BY sum(i.line_amount) DESC) rn
  FROM order_items i JOIN products p ON p.id = i.product_id
  GROUP BY p.category, p.name
) q WHERE rn <= 3 ORDER BY category, revenue DESC;

-- Running total
SELECT dt, rev, sum(rev) OVER (ORDER BY dt) AS running_total FROM daily;

-- 7-day moving average
SELECT dt, avg(rev) OVER (ORDER BY dt ROWS BETWEEN 6 PRECEDING AND CURRENT ROW) mov7 FROM daily;

-- Month-over-month delta
SELECT ym, orders, orders - lag(orders) OVER (ORDER BY ym) AS delta FROM monthly;

-- Quartiles
SELECT ntile(4) OVER (ORDER BY lifetime_value) quartile, count(*) FROM customers GROUP BY 1;
```

Send any of these via `/api/queries/exec` with the owning `source`.

---

## Materialized views & views

Reads go through the same native-SQL path. A **materialized view** is
pre-computed storage — reads are fast and don't recompute; refresh explicitly:

```sql
-- read (fast, prefetched)
SELECT sales_day, region, revenue FROM mv_daily_region_sales ORDER BY revenue DESC LIMIT 10;

-- refresh (online, needs a unique index)
REFRESH MATERIALIZED VIEW CONCURRENTLY mv_daily_region_sales;
```

A **view** is always recomputed on read:

```sql
SELECT region, count(*) orders, sum(total_amount) revenue FROM v_customer_orders GROUP BY region;
```

Views, materialized views, sequences and functions are **created** declaratively
via manifests — see [metadata-manifests.md](metadata-manifests.md).

Runnable examples & a TAT (execution-time) audit:
[`03-analytics-suite.js`](../examples/distributed-retail/03-analytics-suite.js),
[`04-tat-audit.js`](../examples/distributed-retail/04-tat-audit.js),
[`05-real-world-scenarios.js`](../examples/distributed-retail/05-real-world-scenarios.js).
