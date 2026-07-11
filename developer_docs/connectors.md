# Connectors — per-engine reference

Each datasource is backed by a connector that implements discovery
(`discoverSchemas/Tables/Columns`), read (`query`, with pushdown), and — where
applicable — native SQL (`rawQuery`) and document writes. Register sources with
`POST /api/admin/connections` (or seed rows for tests); the `config` object shape
per engine is below.

## Registering a source

```jsonc
POST /api/admin/connections
{ "name": "Retail_Core",
  "config": { "type": "postgres", "syncType": "VIRTUAL",
              "host": "localhost", "port": 5436, "database": "retail_core",
              "user": "remote_admin", "password": "remote_password" } }
```
`syncType`: `VIRTUAL` (queried live via connector) or `SYNC`/`CDC` (replicated into the hub).

---

## PostgreSQL

**config**: `{ type:"postgres", host, port, database, user, password }` (or `connectionString`).

| Capability | Support |
|-----------|---------|
| filter / projection / sort / limit / offset | ✓ parameterized SQL |
| `GROUP BY` + `COUNT/SUM/AVG/MIN/MAX/COUNT_DISTINCT` | ✓ |
| bind-join (`col IN (…)`) | ✓ |
| native SQL — window, recursive CTE, matview | ✓ via `/api/queries/exec` with `source` |
| writes (create/update/delete) | ✓ parameterized `… RETURNING *` |
| discovery | tables, views, matviews, foreign tables, sequences, functions, procedures, enums |

Discovery uses `pg_class`/`pg_attribute`/`pg_proc`/`pg_type`, so materialized views
and every object type are catalogued.

## MySQL

**config**: `{ type:"mysql", host, port, database, user, password }`.

| Capability | Support |
|-----------|---------|
| filter / projection / sort / limit | ✓ (`?` placeholders, backtick idents) |
| `GROUP BY` aggregates | ✓ |
| bind-join | ✓ |
| native SQL | ✓ (`rawQuery`) |
| discovery | tables, views, columns |

## MongoDB

**config**: `{ type:"mongodb", uri:"mongodb://user:pass@host:port" }` (or host/port/user/pass).
Schema = database name, resource = collection.

| Capability | Support |
|-----------|---------|
| filter | ✓ `find(match)` — `$eq/$ne/$gt/$gte/$lt/$lte/$in`, `$like/$ilike` → `$regex` |
| projection | ✓ (`_id` excluded unless requested, so rows match relational shape in joins/set-ops) |
| sort / limit / skip | ✓ |
| aggregates + groupBy | ✓ `$group` pipeline (`COUNT_DISTINCT` via `$addToSet`+`$size`) |
| bind-join | ✓ (`{ key: { $in: [...] } }`) |
| writes | ✓ `insertMany` / `updateMany($set)` / `deleteMany` |
| SQL via `/queries/exec` | ✓ **fabric-translated** — SQL → AST → native `find`/`$group` (`plan.translatedFrom:"SQL"`); single-collection, no JOINs |

## Snowflake

**config**: `{ type:"snowflake", account, user, password, warehouse, role, database, schema }`.
Driver `snowflake-sdk` is lazy-loaded (install only if you use Snowflake).

| Capability | Support |
|-----------|---------|
| filter / projection / sort / limit | ✓ |
| `GROUP BY` aggregates | ✓ |
| bind-join | ✓ |
| native SQL / writes | ✓ (`rawQuery`) |

## Elasticsearch

**config**: `{ type:"elasticsearch", node|uri:"http://host:9200", username?, password? }`.
Index = resource.

| Capability | Support |
|-----------|---------|
| filter / projection / sort / size | ✓ query DSL |
| full-text (`MATCH`) + fuzzy (`FUZZY`) + relevance `_score` | ✓ |
| aggregations (terms, metrics, `PERCENTILE`, `date_histogram`) | ✓ |
| bind-join | ✓ (terms filter) |
| native SQL (`/api/queries/exec`) | ✓ via ES `_sql` (read-only subset, no JOINs) |
| writes (create/update/delete via `/api/data`) | ✓ `_bulk` / `_update_by_query` / `_delete_by_query` |
| downstream sink (mirror hub mutations) | ✓ mutation-sync worker |

---

## How pushdown is compiled

All connectors share one `PushdownCompiler` that turns the canonical query
(`{ select, filter, orderBy, limit, offset, groupBy, aggregates }`) into:

- **SQL** (`toSql`, dialect postgres/mysql/snowflake) — quoted idents, parameter
  placeholders, `GROUP BY` + aggregate expressions;
- **Mongo** (`toMongo` / `toMongoAggregate`) — `find` spec or `$group` pipeline.

This is why the same AST query works unchanged across every engine, and why the
`plan.legs[].query` trace shows the real request each source received.

See [../system_docs/pushdown.md](../system_docs/pushdown.md) for the compiler design.
