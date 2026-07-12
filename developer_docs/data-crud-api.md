# Data CRUD API

`/api/data/*` — simple REST-style single-resource operations over the fabric. No
query shape to learn: send an ergonomic JSON body and get back the standard
envelope (with the per-leg execution `plan`). Works against the hub and every
external source, with full pushdown, governance and audit logging.

> This guide covers the full `/api/data` surface, including `call` and `sequence`.
> For the concise `fetch`/`create`/`update`/`delete` field reference and the
> `where`-map operator table, see [crud-api.md](crud-api.md) — this page does not
> repeat it.

All endpoints require `Authorization` + `x-tenant-id`. Examples use the `H`
header array from [api-overview.md](api-overview.md#required-headers). ADMIN
callers may add `x-act-as-role` to exercise governance as another role.

## Endpoints

| Method | Path | Purpose |
|--------|------|---------|
| POST | `/api/data/fetch` | read rows (planner + pushdown) |
| POST | `/api/data/create` | insert one or many |
| POST | `/api/data/update` | update rows matching a `where` (**required**) |
| POST | `/api/data/delete` | delete rows matching a `where` (**required**) |
| POST | `/api/data/call` | invoke a provisioned function/procedure |
| POST | `/api/data/sequence` | allocate `nextval` for any engine |

Full field reference (`source`, `schema`, `resource`, `columns`, `where`,
`orderBy`, `limit`, `offset`, `data`) and the `where`-map operators
(`$eq $ne $gt $gte $lt $lte $like $ilike $in`) are in
[crud-api.md](crud-api.md#body-fields).

---

## fetch — `POST /api/data/fetch`

```bash
curl -s "${H[@]}" http://localhost:4000/api/data/fetch -d '{
  "source": "Retail_Core", "resource": "customers",
  "columns": ["id", "name", "region"],
  "where": { "region": "EU", "lifetime_value": { "$gt": 45000 } },
  "orderBy": [ { "column": "id", "direction": "ASC" } ], "limit": 3 }'
```

**Success (`200`):** `{ data, rowCount, plan, warnings }` — reads run through the
planner, so a fetch can target Postgres, Mongo, ES or the hub with full pushdown.

## create — `POST /api/data/create`

```bash
curl -s "${H[@]}" http://localhost:4000/api/data/create -d '{
  "source": "Retail_Core", "resource": "customers",
  "data": { "id": 900001, "name": "Acme", "region": "NA", "lifetime_value": 100 } }'
```

Pass an **array** for `data` to batch-insert. **Success (`200`):** `{ status, rowCount, returning, plan }` (Postgres `INSERT … RETURNING *`; Mongo `insertMany`).

## update — `POST /api/data/update` (where required)

```bash
curl -s "${H[@]}" http://localhost:4000/api/data/update -d '{
  "source": "Retail_Core", "resource": "customers",
  "where": { "id": 900001 }, "data": { "lifetime_value": 9999 } }'
```

## delete — `POST /api/data/delete` (where required)

```bash
curl -s "${H[@]}" http://localhost:4000/api/data/delete -d '{
  "source": "Web_Analytics", "resource": "web_events", "where": { "event_id": 900001 } }'
```

## call — `POST /api/data/call`

**Purpose:** invoke a provisioned function or procedure (fabric
function-as-a-service). Equivalent to the AST `{ type: "CALL" }` form and to SQL
`CALL fn(...)` / `SELECT * FROM fn(...)`.

**Body:** `{ schema?, function? | procedure?, args?: any[] }`.

```bash
# Function returning rows
curl -s "${H[@]}" http://localhost:4000/api/data/call -d '{
  "schema": "public", "function": "generate_custom_id", "args": ["NA"] }'

# Procedure (no result set)
curl -s "${H[@]}" http://localhost:4000/api/data/call -d '{
  "schema": "public", "procedure": "archive_asset", "args": ["a1b2c3"] }'
```

**Success (`200`):** the standard envelope (`data`/`returning` + `plan`).

## sequence — `POST /api/data/sequence`

**Purpose:** allocate the next value(s) from a fabric sequence — a Postgres-style
`nextval()` that works for **any** engine (e.g. to give MongoDB inserts
consistent sequential IDs).

**Body:** `{ name, start?, increment?, count? }`.

```bash
curl -s "${H[@]}" http://localhost:4000/api/data/sequence -d '{
  "name": "web_event_id", "count": 3 }'
# → allocates the next 3 values from the "web_event_id" sequence
```

**Errors:** `400 { "error": "name is required" }`.

---

## Safety & error handling

The `/api/data` handler maps errors to precise status codes:

| Status | When | Example `error` |
|--------|------|------------------|
| `400` | safety / validation | `SAFETY: update/delete require a "where" filter` |
| `400` | constraint failure (non-SQL engine, compensated) | `CONSTRAINT VIOLATION: "CLOSED" not in {ACTIVE, SUSPENDED}` |
| `400` | missing/invalid field, unsupported op | `name is required`, `… does not support …` |
| `403` | grant enforcement | `ACCESS DENIED: role "ANALYST" lacks INSERT on public.customers` |
| `403` | suspended tenant | `… suspended …` |
| `500` | unexpected failure | `<message>` |

`update` and `delete` **must** include a non-empty `where`. Governance
(policies, masking, constraints, grants) is applied automatically — see
[governance-api.md](governance-api.md). Every call is captured in the
[query audit trail](observability-api.md) under modes `FETCH`, `CRUD_CREATE`,
`CRUD_UPDATE`, `CRUD_DELETE`, `CALL`, `SEQUENCE`.

Full runnable walkthrough (with cleanup):
[`07-crud-api-examples.js`](../examples/distributed-retail/07-crud-api-examples.js).
