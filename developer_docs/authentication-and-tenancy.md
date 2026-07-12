# Authentication & Tenancy

How to obtain a token, how the fabric scopes every request to a tenant, and how an
administrator can operate across tenants or impersonate a role.

## 1. Log in → bearer token

**`POST /api/auth/login`** — the public entry point (no auth required).

```bash
curl -s http://localhost:4000/api/auth/login \
  -H 'Content-Type: application/json' \
  -d '{"username":"admin","password":"admin"}'
```

Success (`200`):

```jsonc
{
  "token": "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9…",
  "user": { "id": 1, "username": "admin", "tenant_id": "tenant_A" }
}
```

The JWT encodes `tenant_id`, `internal_role` (e.g. `ADMIN`, `USER`, or a custom
role) and `username`. Send it on every subsequent request:

```
Authorization: Bearer <token>
```

Errors:

| Status | Body | Cause |
|--------|------|-------|
| `401` | `{ "error": "Invalid credentials" }` | username/password mismatch |
| `500` | `{ "error": "<message>" }` | unexpected failure (e.g. DB error) |

> There is no self-service signup on the API. New users are created by an
> administrator via `POST /api/admin/users` — see [admin-api.md](admin-api.md#users).

## 2. Tenant scoping

Every data, query and governance operation runs inside exactly one **tenant**.
The tenant is resolved as follows:

- **Non-admin token** — the tenant is taken from the token's `tenant_id`. The
  `x-tenant-id` header is informational and cannot escalate to another tenant.
- **ADMIN token** — if `x-tenant-id` is present it **overrides** the token's
  tenant, letting an operator act on any tenant with a single admin token. This
  is why `x-tenant-id` is shown as required throughout these docs: for admins it
  selects the target tenant.

```bash
# Admin operating on tenant_B
curl -s http://localhost:4000/api/data/fetch \
  -H "Authorization: Bearer $ADMIN_TOKEN" \
  -H "x-tenant-id: tenant_B" \
  -H "Content-Type: application/json" \
  -d '{"source":"Retail_Core","resource":"customers","limit":3}'
```

A request for a **suspended** tenant fails with `403` and an `error` message
containing `suspended`.

## 3. Tenant-scoped token exchange

**`POST /api/auth/token`** — mint a *new* token scoped to a specific tenant
without re-entering credentials. Used by multi-tenant users/admins to "act as"
a tenant so the token itself carries the right scope (rather than relying on the
`x-tenant-id` header on every call).

Requires an already-authenticated request.

```bash
curl -s http://localhost:4000/api/auth/token \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"tenantId":"tenant_B"}'
# → { "token": "eyJ…" }   (same username & role, scoped to tenant_B)
```

Errors:

| Status | Body | Cause |
|--------|------|-------|
| `401` | `{ "error": "Authentication required" }` | no bearer token on the request |
| `400` | `{ "error": "tenantId is required" }` | missing `tenantId` in the body |

## 4. Impersonation — `x-act-as-role`

Row policies, column masking and grants are evaluated against the session
**role**. An ADMIN caller can preview how data appears to another role by sending:

```
x-act-as-role: VIEWER
```

The fabric then evaluates policies/grants/masking as if the session role were
`VIEWER`, while the request still runs under the admin's tenant. This is a
read-through *view-as* aid for testing governance — it is **honoured only for
ADMIN tokens** and ignored otherwise.

```bash
# See customers the way a VIEWER would (masked columns, row filters applied)
curl -s http://localhost:4000/api/data/fetch \
  -H "Authorization: Bearer $ADMIN_TOKEN" \
  -H "x-tenant-id: tenant_A" \
  -H "x-act-as-role: VIEWER" \
  -H "Content-Type: application/json" \
  -d '{"source":"Retail_Core","resource":"customers","limit":5}'
```

Related optional header — `x-region: <REGION>` supplies the session `region`
used by region-scoped row policies (`{ session: 'region' }`); it defaults to
`AP`. See [governance-api.md](governance-api.md).

## 5. Roles at a glance

| Role | Capabilities |
|------|--------------|
| `ADMIN` | Full access; may set `x-tenant-id` cross-tenant and `x-act-as-role`; bypasses grant enforcement; only role allowed on `/api/admin/*`. |
| `USER` / custom roles | Scoped to their token's tenant; subject to policies, masking and grants declared for the tables they touch. |

## Header quick reference

| Header | Who sets it | Effect |
|--------|-------------|--------|
| `Authorization: Bearer <jwt>` | every caller | authenticates; carries tenant + role |
| `x-tenant-id` | admins (override); others (informational) | selects the active tenant |
| `x-act-as-role` | ADMIN only | evaluate governance as this role |
| `x-region` | any caller | session region for row policies (default `AP`) |

See [api-overview.md](api-overview.md) for the full endpoint directory.
