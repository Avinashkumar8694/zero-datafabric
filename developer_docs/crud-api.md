# CRUD API — `/api/data`

Simple REST-style single-resource operations. No query shape to learn — just a
JSON body. Works against the hub and external sources (remote Postgres, MongoDB).
Every response carries the `plan` execution trace.

| Endpoint | Method | Purpose |
|----------|--------|---------|
| `/api/data/fetch`  | POST | read rows |
| `/api/data/create` | POST | insert one or many |
| `/api/data/update` | POST | update rows matching a filter |
| `/api/data/delete` | POST | delete rows matching a filter |

## Body fields

| Field | fetch | create | update | delete | notes |
|-------|:--:|:--:|:--:|:--:|-------|
| `source`   | ○ | ○ | ○ | ○ | datasource name; omit = hub |
| `schema`   | ○ | ○ | ○ | ○ | physical schema/db; auto-resolved from catalog if omitted |
| `resource` | ● | ● | ● | ● | table / collection (required) |
| `columns`  | ○ | | | | projection (array of names) |
| `where`    | ○ | | ● | ● | filter map (required for update/delete) |
| `orderBy`, `limit`, `offset` | ○ | | | | |
| `data`     | | ● | ● | | object or array (create); set-fields (update) |

`●` required · `○` optional

## The `where` map

`{ column: value }` for equality, or `{ column: { $op: value } }`:

| `$op` | meaning |
|-------|---------|
| `$eq` `$ne` | `= !=` |
| `$gt` `$gte` `$lt` `$lte` | `> >= < <=` |
| `$like` `$ilike` | pattern match |
| `$in` | membership (array value) |

```jsonc
{ "region": "EU" }
{ "lifetime_value": { "$gt": 45000 } }
{ "status": { "$in": ["SHIPPED", "DELIVERED"] } }
```

## fetch

```jsonc
POST /api/data/fetch
{ "source": "Retail_Core", "resource": "customers",
  "columns": ["id", "name", "region"],
  "where": { "region": "EU" }, "orderBy": [{ "column": "id", "direction": "ASC" }], "limit": 3 }
```
Returns `{ data, rowCount, plan, warnings }`. Reads run through the planner, so a
fetch can target Postgres, Mongo, or the hub with full pushdown.

## create

```jsonc
// single
POST /api/data/create
{ "source": "Retail_Core", "resource": "customers",
  "data": { "id": 900001, "name": "Acme", "region": "NA", "segment": "SMB",
            "signup_date": "2026-01-01", "lifetime_value": 100 } }

// batch
{ "source": "Retail_Core", "resource": "customers",
  "data": [ { "id": 900002, "name": "B", ... }, { "id": 900003, "name": "C", ... } ] }

// Mongo document
{ "source": "Web_Analytics", "resource": "web_events",
  "data": { "event_id": 900001, "customer_id": 1, "event_type": "checkout", "revenue": 42 } }
```
Remote Postgres → `INSERT … RETURNING *`; MongoDB → `insertMany`. Returns
`{ status, rowCount, returning, plan }`.

## update (where required)

```jsonc
POST /api/data/update
{ "source": "Retail_Core", "resource": "customers",
  "where": { "id": 900001 }, "data": { "lifetime_value": 9999, "segment": "ENTERPRISE" } }
```
Remote Postgres → `UPDATE … SET … WHERE … RETURNING *`; MongoDB → `updateMany($set)`.

## delete (where required)

```jsonc
POST /api/data/delete
{ "source": "Web_Analytics", "resource": "web_events", "where": { "event_id": 900001 } }
```
Remote Postgres → `DELETE … WHERE … RETURNING *`; MongoDB → `deleteMany`.

## Safety

`update` and `delete` **must** include a non-empty `where` — otherwise the request
is rejected with HTTP 400 (`SAFETY: update/delete require a "where" filter`).

Full runnable walkthrough (with cleanup):
[`07-crud-api-examples.js`](../examples/distributed-retail/07-crud-api-examples.js).
