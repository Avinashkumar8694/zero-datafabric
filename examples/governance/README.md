# Governance Examples — constraints, grants, functions on non-SQL engines

Postgres enforces constraints, grants, and functions natively. These examples
show the fabric providing the **same guarantees on MongoDB** via its
compensation engines — the constructs from `test_manifest.json`, made to work
on an engine that doesn't have them, reachable from AST and SQL.

## Prerequisites

```bash
npm run infra:up
npm run start
```

## Run

```bash
NODE_PATH=backend/node_modules node examples/governance/run-all.js
# or:  npm run examples:governance
```

## Scenarios

- **01 — constraints.** Registers NOT NULL / UNIQUE / ENUM / CHECK / FK on a Mongo
  collection and shows the fabric accept a valid write and reject each violation
  with a clear `400 CONSTRAINT VIOLATION` — before the write reaches Mongo.
- **02 — grants.** Grants `ANALYST=SELECT` on a Mongo collection and shows the
  Grant engine allow the granted read, deny an ungranted read/write (403), and
  let ADMIN bypass. Uses `x-act-as-role` (ADMIN "view as" a role) to test roles.
- **03 — function call.** Provisions a scalar function on the hub and calls it
  from **AST** (`POST /api/data/call`) and **SQL** (`SELECT fn(...)`), confirming
  the same result — the fabric's function-as-a-service, available in both modes.

## Control-plane APIs used

```
POST /api/constraints   { schema, table, columns:[{name,notNull?,unique?,enum?,fk?}], checks:[{name,column,op,value}] }
POST /api/grants        { schema, table, grants:[{role, privileges:['SELECT','INSERT',...]}] }
POST /api/data/call     { schema?, function?|procedure?, args?[] }
```

Constraint check operators: `REGEX GT GTE LT LTE EQ NEQ IN LEN_LTE NOT_NULL`.
All three are also declarable in a manifest (`constraints[]` + column flags,
`security.grants`, `FUNCTION`/`PROCEDURE` resources) and synced automatically.

## What proves it works

- Violating writes are rejected **at the fabric** (400) — Mongo never sees them.
- A role without a privilege is denied (403); ADMIN and un-governed tables pass.
- A function returns the identical value whether invoked via AST or SQL.
