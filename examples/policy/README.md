# Policy Engine Examples

The **Policy Engine** gives non-RLS engines (MongoDB, Elasticsearch, remote
warehouses) the row-level security and column masking Postgres has natively. It
resolves engine-agnostic policies and:

- **injects** each row predicate into the query pushdown, so the filter runs **at
  the source** (Mongo `$match`, ES query, remote `WHERE`) — the tenant never
  receives rows they aren't entitled to; and
- **masks** sensitive columns in the returned rows (REDACT / NULL / HASH / PARTIAL).

Postgres tables keep native RLS; the fabric compensates for everything else.

## Prerequisites

```bash
npm run infra:up
npm run start            # backend :4000 (+ ui, trigger-engine)
```

## Run

```bash
# pg + mongodb come from the backend's node_modules
NODE_PATH=backend/node_modules node examples/policy/run-all.js
# or a single scenario:
NODE_PATH=backend/node_modules node examples/policy/01-row-isolation.js
```

(Or `npm run examples:policy`.)

## Scenarios

- **01 — row isolation.** Three stacked policies on a Mongo collection —
  `tenant_isolation` (`tenant_code = SESSION.tenant_id`), `region_isolation`
  (`region = SESSION.region`), `hide_deleted` (`deleted_at IS NULL`). Proves the
  predicate is injected + pushed to Mongo, is session-relative (EU vs NA return
  different slices), and that 0 rows in the result violate the policy.
- **02 — column masking.** REDACT / PARTIAL / HASH strategies on `email` / `ssn`
  / `amount`, composed with a row policy. Proves every returned row is masked and
  the row filter still applies.
- **03 — manifest policies.** The same policies authored in a table's
  `security.accessPolicies` (engine-agnostic) and synced to the control plane on
  apply; also shows the legacy `security.masking` field now enforced (it was
  previously a no-op).

## Policy shape

```jsonc
{
  "name": "tenant_isolation",
  "schema": "policy_lab",           // physical schema the leg presents (Mongo db, remote schema, or tenant_x_*)
  "table": "secure_orders",
  "roles": ["ANALYST"],             // optional — omit = applies to all roles
  "rowFilter": [
    { "column": "tenant_code", "operator": "EQ", "value": { "session": "tenant_id" } },
    { "column": "deleted_at",  "operator": "IS_NULL" }
  ],
  "masking": [
    { "column": "email", "strategy": "REDACT", "roles": ["ANALYST"] }
  ]
}
```

- **operators**: `EQ NEQ GT GTE LT LTE IN LIKE IS_NULL IS_NOT_NULL`.
- **session refs**: `{ "session": "tenant_id" | "region" | "role" | "username" }`
  are resolved per request (tenant from the token/`x-tenant-id`, region from
  `x-region`, role from the token). This is the fabric analogue of a Postgres
  policy's `current_setting('app.*')`.
- **mask strategies**: `REDACT` (`***REDACTED***`), `NULL`, `HASH`
  (`sha256:xxxxxxxx`), `PARTIAL` (keep last 4).

## API

```
GET    /api/policies         list
POST   /api/policies         create/update  (body = policy shape above)
DELETE /api/policies/:id     remove
```

## What proves it works

- Result row count drops to exactly the allowed slice; **no** returned row
  violates the predicate.
- `plan.pushed` shows `policy … injected N predicate(s)` and `policy masking …`.
- Changing `x-region` changes the slice — the predicate is session-relative.
