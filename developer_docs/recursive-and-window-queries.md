# Recursive queries, window functions & materialized views

All querying is **AST-only**. Raw SQL execution (`/api/queries/exec`,
`/api/queries/native`, `rawSql`) has been removed, so hierarchies, rankings and
view reads are expressed as AST bodies on `POST /api/analytics/query` (or
`POST /api/queries/engine`, which takes the bare config). Use `POST /api/queries/transpile` to preview the SQL
an AST would compile to (preview only, nothing is executed).

Request bodies carrying `sql` / `rawSql` / `nativeSql` / `rawQuery` (or a string
`query`) are rejected with `400 { code: "SQL_NOT_SUPPORTED" }`.

---

## Recursive queries

Traverse hierarchies / graphs (org charts, referral trees, BOM, categories) with
`query.recursive`. The fabric walks the hierarchy level by level; each level is a
normal single-source query, so predicate pushdown and policies apply at every step,
and it works on any engine (Postgres, MongoDB, Elasticsearch).

### Downward traversal (tree from a root)

```jsonc
POST /api/analytics/query
{ "queryConfig": { "type": "SELECT", "schema": "public", "query": {
    "from": { "resource": "customers", "source": "Retail_Core" },
    "select": ["id", "referred_by"],
    "recursive": {
      "source": "Retail_Core",
      "resource": "customers",
      "select": ["id", "referred_by"],
      "connectBy": { "parent": "referred_by", "child": "id" },
      "startWith": [ { "column": "id", "operator": "EQ", "value": 1 } ],
      "direction": "down",
      "maxDepth": 25
    } } } }
```

- `connectBy` — `child.<parent> = parent.<child>`; for an org tree
  (`manager_id` points at `id`) use `{ "parent": "manager_id", "child": "id" }`.
- Seed rows come from `startWith`, else `anchor`, else `<parent> IS NULL` (all roots).
- `direction` — `down` (default) walks children; `up` walks ancestors.
- `maxDepth` is clamped to 1 to 100 (default 25); `maxRows` to 1 to 200000 (default 50000).
  Overruns set `truncatedByDepth` / `truncatedByRows` and emit a warning.
- `pathColumn` — materialise a breadcrumb `path` of that column at each node.
- Each returned row is tagged with its `depth`; cycles and diamonds are guarded by a
  `seen` set.

### Full-forest traversal (all roots)

Omit `startWith` and `anchor`; the default seed is every row where the parent
column is `NULL`.

### Aggregating the closure

Aggregate over the traversal result by adding `groupBy` / aggregate selects to the
same query; the fabric aggregates the traversal rows after the walk.

### Recursive views (declarative)

A recursive **view** is defined in a manifest with `with[].base` + `with[].unionAll`
(`"recursive": true`), see [metadata-manifests.md](metadata-manifests.md). Once
applied it is read like any other resource with a plain AST `select`.

---

## Window functions

Ranking, running totals, lead/lag, quartiles, expressed as `window` select items
(`RANK`, `ROW_NUMBER`, ...) with `partitionBy` and `orderBy`:

```jsonc
POST /api/analytics/query
{ "queryConfig": { "type": "SELECT", "schema": "public", "query": {
    "select": [ "category", "name", "price",
      { "window": "RANK", "partitionBy": ["category"],
        "orderBy": [ { "column": "price", "direction": "DESC" } ],
        "alias": "rank_in_category" } ],
    "from": { "resource": "products" } } } }
```

Window functions run natively on Postgres and are compensated in-fabric (after a
bounded, filter-pushed base fetch) on engines that cannot express them. See
[queries-cookbook.md](queries-cookbook.md#5-window-functions--rankings) and
[../system_docs/14-algorithms.md](../system_docs/14-algorithms.md).

---

## Materialized views & views

Views, materialized views, sequences and functions are **created** declaratively
via manifests, see [metadata-manifests.md](metadata-manifests.md) (apply with
`POST /api/metadata/apply`).

Reads are plain AST selects against the view name:

```jsonc
POST /api/analytics/query
{ "queryConfig": { "type": "SELECT", "schema": "public", "limit": 10, "query": {
    "select": ["sales_day", "region", "revenue"],
    "from": { "resource": "mv_daily_region_sales" },
    "orderBy": [ { "column": "revenue", "direction": "DESC" } ] } } }
```

A **materialized view** is pre-computed storage: reads are fast and don't
recompute. Refresh it with `POST /api/analytics/refresh-view` (background job,
see [analytics-api.md](analytics-api.md)) or via the manifest `refreshStrategy` /
`refreshInterval`. A plain **view** is always recomputed on read.

Runnable examples & a TAT (execution-time) audit:
[`03-analytics-suite.js`](../examples/distributed-retail/03-analytics-suite.js),
[`04-tat-audit.js`](../examples/distributed-retail/04-tat-audit.js),
[`05-real-world-scenarios.js`](../examples/distributed-retail/05-real-world-scenarios.js)
(these example scripts may predate the SQL removal; treat any raw-SQL calls in them as obsolete).
