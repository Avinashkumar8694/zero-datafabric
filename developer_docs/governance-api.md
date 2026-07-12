# Governance API

Three engine-agnostic control planes let you govern data uniformly across every
engine — even ones without native support:

| Area | Endpoint | Governs |
|------|----------|---------|
| **Policies** | `/api/policies` | row predicates (RLS) + column masking |
| **Constraints** | `/api/constraints` | NOT NULL / UNIQUE / ENUM / CHECK / FK data quality |
| **Grants** | `/api/grants` | table privileges (SELECT/INSERT/UPDATE/DELETE) |

All endpoints require `Authorization` + `x-tenant-id`. Examples use the `H`
header array from [api-overview.md](api-overview.md#required-headers).

## The capability-compensation philosophy

Postgres enforces RLS, constraints and grants natively. Document/search engines
(MongoDB, Elasticsearch) and remote warehouses do not. Rather than push a
lowest-common-denominator model, the fabric stores each rule **once**,
engine-agnostically, and applies it by the best available means per engine:

- **push-down** — if the source can enforce it, compile it into the pushed query
  (e.g. a row predicate becomes a Mongo `$match` / ES filter / remote `WHERE`), so
  the source only ever returns permitted rows.
- **compensate-in-fabric** — if the source cannot, the fabric enforces it itself:
  masking is applied to result rows post-fetch; constraints are validated before
  a write is dispatched to a non-SQL engine; grant decisions gate the request.
- **reject-if-impossible** — a rule the fabric cannot model (e.g. an `EXCLUDE …
  USING GIST` constraint) is surfaced as an explicit, non-silent skip rather than
  silently dropped.

The same definition therefore behaves consistently whether the data lives in
Postgres, Mongo, ES or a remote warehouse.

### AST vs SQL modes

- **AST-mode reads** (`/api/analytics/query`, `/api/data/*`) — the fabric resolves
  the policies/grants/masking for each leg and injects/compensates as above. This
  is where governance has full effect (row-filter injection **and** per-column
  masking).
- **SQL-mode reads** (`/api/queries/exec` at a source) — the statement runs at the
  engine; native RLS/grants there apply, but fabric-side row injection and masking
  are not layered on top of an opaque SQL string. Prefer AST mode when you rely on
  fabric-enforced masking/row filters for non-RLS engines.

ADMIN callers can preview any role's view with `x-act-as-role` (see
[authentication-and-tenancy.md](authentication-and-tenancy.md#impersonation)).

---

## Policies — `/api/policies`

Row predicates + column masking, enforced on non-RLS engines by row-filter
injection (at the source) and post-fetch masking (in-fabric).

### Policy shape

```jsonc
{
  "name": "region_isolation",
  "schema": "Global_Supply_Chain",   // logical or physical (tenant_x_<logical>)
  "table": "shipments",
  "roles": ["VIEWER", "USER"],        // omit = applies to all roles
  "rowFilter": [
    { "column": "region", "operator": "EQ", "value": { "session": "region" } }
  ],
  "masking": [
    { "column": "customer_email", "roles": ["VIEWER"], "strategy": "PARTIAL" }
  ]
}
```

- **`rowFilter[]`** — clauses `{ column, operator, value }`, AND-combined.
  Operators: `EQ NEQ GT GTE LT LTE IN LIKE IS_NULL IS_NOT_NULL`. `value` is a
  literal, an array (for `IN`), or a **session reference**
  `{ "session": "tenant_id" | "region" | "role" | "username" }` resolved per
  request — the analogue of Postgres `current_setting('app.*')`.
- **`masking[]`** — `{ column, roles?, strategy }`. Strategies: `REDACT`
  (`***REDACTED***`), `NULL`, `HASH` (`sha256:<digest>`), `PARTIAL` (keeps last 4
  chars). Omit `roles` to mask for everyone.

A policy must declare at least a `rowFilter` **or** a `masking` rule.

### GET `/api/policies` — list

```bash
curl -s "${H[@]}" http://localhost:4000/api/policies
```

`200` → array of `{ id, name, schema, table, roles, rowFilter, masking, source, updatedAt }`.

### POST `/api/policies` — create / replace

Upserts on `(tenant, schema, table, name)`.

```bash
curl -s "${H[@]}" http://localhost:4000/api/policies -d '{
  "name": "region_isolation", "schema": "public", "table": "shipments",
  "roles": ["VIEWER"],
  "rowFilter": [ { "column": "region", "operator": "EQ", "value": { "session": "region" } } ],
  "masking": [ { "column": "customer_email", "roles": ["VIEWER"], "strategy": "PARTIAL" } ] }'
```

**Success (`201`):** the persisted policy row.

**Errors:** `400 { "error": "name, schema and table are required" }`; `400 { "error": "a policy needs at least a rowFilter or masking rule" }`.

### DELETE `/api/policies/:id`

`200 { "status": "DELETED", "id": "…" }`, or `404 { "error": "policy not found" }`.

> **Tip — schema naming.** Policies are matched against the schema **exactly as
> the query leg presents it**: for tenant-managed Postgres that is
> `tenant_<id>_<logical>`; for external connectors it is the remote db/schema
> (e.g. a Mongo database name). Store the policy's `schema` to match that.

---

## Constraints — `/api/constraints`

Engine-agnostic data-quality rules. Postgres enforces natively (so those writes
skip fabric validation); Mongo/ES writes are validated **in-fabric before
dispatch**.

### Constraint spec shape

```jsonc
{
  "schema": "public",
  "table": "customers",
  "columns": [
    { "name": "email",  "notNull": true, "unique": true },
    { "name": "status", "enum": ["ACTIVE", "SUSPENDED", "CLOSED"] },
    { "name": "owner_id", "fk": { "schema": "public", "table": "owners", "column": "id" } }
  ],
  "checks": [
    { "name": "ltv_non_negative", "column": "lifetime_value", "op": "GTE", "value": 0 },
    { "name": "region_code",      "column": "region",         "op": "REGEX", "value": "^[A-Z]{2,3}$" }
  ]
}
```

- **`columns[]`** — per-column rules: `notNull`, `unique`, `enum: string[]`,
  `fk: { source?, schema?, table, column }`.
- **`checks[]`** — `{ name, column, op, value? }`. Ops: `REGEX GT GTE LT LTE EQ
  NEQ IN LEN_LTE NOT_NULL`.

`UNIQUE` and `FK` require the fabric to look up the source at write time; `NOT
NULL` / `ENUM` / `CHECK` are validated synchronously. On update, only columns
being written are validated.

### GET `/api/constraints` — list

```bash
curl -s "${H[@]}" http://localhost:4000/api/constraints
```

`200` → array of `{ id, schema, table, spec, source, updatedAt }`.

### POST `/api/constraints` — create / replace

Upserts on `(tenant, schema, table)`.

```bash
curl -s "${H[@]}" http://localhost:4000/api/constraints -d '{
  "schema": "public", "table": "customers",
  "columns": [ { "name": "email", "notNull": true, "unique": true } ],
  "checks":  [ { "name": "ltv_non_negative", "column": "lifetime_value", "op": "GTE", "value": 0 } ] }'
```

**Success (`201`):** the persisted constraint row.

**Errors:** `400 { "error": "schema and table are required" }`; `400 { "error": "provide at least one column rule or check" }`.

### How a violation surfaces

When a `/api/data/create` or `/api/data/update` to a non-SQL engine violates a
compensated constraint, the write is rejected with `400` and an error beginning
`CONSTRAINT VIOLATION` (see [data-crud-api.md](data-crud-api.md)). Example:

```jsonc
{ "error": "CONSTRAINT VIOLATION: \"CLOSED\" not in {ACTIVE, SUSPENDED} (status_enum)" }
```

---

## Grants — `/api/grants`

Engine-agnostic table privileges. **Default-allow**: a table is only governed
once grants are declared for it, so existing queries are unaffected until you opt
in. **ADMIN** (and `SYSTEM`) always pass.

### Grant shape

```jsonc
{
  "schema": "public",
  "table": "customers",
  "grants": [
    { "role": "ANALYST", "privileges": ["SELECT"] },
    { "role": "EDITOR",  "privileges": ["SELECT", "INSERT", "UPDATE"] }
  ]
}
```

Privileges: `SELECT INSERT UPDATE DELETE`.

### GET `/api/grants` — list

```bash
curl -s "${H[@]}" http://localhost:4000/api/grants
```

`200` → array of `{ id, schema, table, grants, source, updatedAt }`.

### POST `/api/grants` — create / replace

Upserts on `(tenant, schema, table)` — re-applying replaces the rule set.

```bash
curl -s "${H[@]}" http://localhost:4000/api/grants -d '{
  "schema": "public", "table": "customers",
  "grants": [ { "role": "ANALYST", "privileges": ["SELECT"] } ] }'
```

**Success (`201`):** the persisted grant row.

**Errors:** `400 { "error": "schema, table and a non-empty grants[] are required" }`.

### How a denial surfaces

When a governed table is accessed by a role lacking the privilege, the request
fails with `403`:

```jsonc
{ "error": "ACCESS DENIED: role \"ANALYST\" lacks INSERT on public.customers" }
```

Test what a role can do without a second login using `x-act-as-role` on an ADMIN
token.

---

## Relationship to manifests

Policies, constraints and grants can also be declared **declaratively** in a
manifest's `security` block (`policies`, `masking`, `grants`) and table
`constraints[]`; the orchestrator syncs them into these same catalogs (with
`source: "MANIFEST"`). The API is the imperative equivalent (`source: "API"`).
See [metadata-manifests.md](metadata-manifests.md#row-level-security).
