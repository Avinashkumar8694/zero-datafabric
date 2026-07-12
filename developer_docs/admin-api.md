# Admin API

`/api/admin/*` — platform administration: tenants, datasource connections,
users, insights, catalog, and notification channels.

> **Every `/api/admin` endpoint requires an ADMIN token.** A non-admin token
> receives `403 { "error": "Admin privileges required" }`; no token at all
> receives `401 { "error": "Authentication required" }`.

Examples assume an admin token and the header array:

```bash
AH=(-H "Authorization: Bearer $ADMIN_TOKEN" -H "x-tenant-id: tenant_A" -H "Content-Type: application/json")
```

`x-tenant-id` selects the tenant an admin operates on (see
[authentication-and-tenancy.md](authentication-and-tenancy.md#tenant-scoping)).

---

## Tenants

| Method | Path | Purpose |
|--------|------|---------|
| GET | `/api/admin/tenants` | list all tenants |
| POST | `/api/admin/tenants` | create a tenant |
| PUT · PATCH | `/api/admin/tenants/:id` | update name/status |
| DELETE | `/api/admin/tenants/:id` | delete a tenant |

```bash
# List
curl -s "${AH[@]}" http://localhost:4000/api/admin/tenants

# Create
curl -s "${AH[@]}" http://localhost:4000/api/admin/tenants \
  -d '{ "id": "tenant_C", "name": "Contoso" }'
# → 201 { … tenant row … }

# Update status
curl -s "${AH[@]}" -X PATCH http://localhost:4000/api/admin/tenants/tenant_C \
  -d '{ "name": "Contoso Ltd", "status": "SUSPENDED" }'

# Delete
curl -s "${AH[@]}" -X DELETE http://localhost:4000/api/admin/tenants/tenant_C
```

**Errors:** `400 { "error": "id and name are required" }` on create; `500` on failure.

> Suspending a tenant causes its data/query requests to fail with `403`
> (`…suspended…`).

---

## Connections (datasources)

Register and manage the external databases the fabric federates over. Config
shapes per engine are in [connectors.md](connectors.md).

| Method | Path | Purpose |
|--------|------|---------|
| GET | `/api/admin/connections` | list sources, each with a live reachability probe |
| POST | `/api/admin/connections` | register (or re-integrate) a source |
| PATCH | `/api/admin/connections` | change a source's status (connect/disconnect) |
| DELETE | `/api/admin/connections/:id` | remove a source |

```bash
# List — each row is enriched with live_status: LIVE | UNREACHABLE | OFFLINE | UNKNOWN
curl -s "${AH[@]}" http://localhost:4000/api/admin/connections

# Register a Postgres source
curl -s "${AH[@]}" http://localhost:4000/api/admin/connections -d '{
  "name": "Retail_Core",
  "config": { "type": "postgres", "syncType": "VIRTUAL",
              "host": "localhost", "port": 5436, "database": "retail_core",
              "user": "remote_admin", "password": "remote_password" } }'
# → 201 (new) or 200 { "status": "RE-INTEGRATED", … } (already existed)

# Disconnect
curl -s "${AH[@]}" -X PATCH http://localhost:4000/api/admin/connections -d '{
  "sourceId": "…", "status": "DISCONNECTED" }'

# Remove
curl -s "${AH[@]}" -X DELETE http://localhost:4000/api/admin/connections/$SOURCE_ID
```

**Errors:** `400 { "error": "name and config are required" }` on register; `400 { "error": "sourceId and status are required" }` on PATCH; `400 { "error": "sourceId is required" }` on DELETE.

The `GET` probe races each connection against a 1.5s timeout so an unreachable
source cannot stall the listing.

---

## Users

| Method | Path | Purpose |
|--------|------|---------|
| GET | `/api/admin/users` | list users (`id, username, tenant_id, role, status`) |
| POST | `/api/admin/users` | create a user |
| PUT | `/api/admin/users/:id` | update a user |
| DELETE | `/api/admin/users/:id` | delete a user |

```bash
# Create
curl -s "${AH[@]}" http://localhost:4000/api/admin/users -d '{
  "username": "analyst1", "password": "s3cret",
  "tenantId": "tenant_A", "role": "ANALYST" }'
# → 201 { … }

# Update (any subset of fields)
curl -s "${AH[@]}" -X PUT http://localhost:4000/api/admin/users/$USER_ID -d '{
  "role": "EDITOR" }'

# Delete
curl -s "${AH[@]}" -X DELETE http://localhost:4000/api/admin/users/$USER_ID
# → { "id": "…", "status": "DELETED" }
```

The `role` assigned here becomes the user's `internal_role` in the JWT, which
drives governance decisions (see [governance-api.md](governance-api.md)) and
admin gating.

---

## Insights

### GET `/api/admin/stats` — dashboard counts

```bash
curl -s "${AH[@]}" http://localhost:4000/api/admin/stats
# → { "tenants": 3, "connections": 5, "audits": 42 }
```

`audits` counts audit-log rows in the last 24 hours.

### GET `/api/admin/audit-logs` — recent audit rows

```bash
curl -s "${AH[@]}" http://localhost:4000/api/admin/audit-logs
```

`200` → the 50 most recent `public.audit_logs` rows (schema/data change history).
For a tenant-scoped lightweight feed, use `GET /api/events` — see
[observability-api.md](observability-api.md#get-apievents--recent-audit-events).

### GET `/api/admin/catalog` — catalog summary

```bash
curl -s "${AH[@]}" http://localhost:4000/api/admin/catalog
```

`200` → array of `{ schema_name, table_name, row_count, last_crawled_at }` for the
tenant's schemas and its sources — a quick view of what has been discovered/
crawled. See [metadata-manifests.md](metadata-manifests.md) for crawling.

---

## Notification channels

Reusable delivery targets (webhook, email, Telegram, …) that trigger actions
route through. See [triggers-api.md](triggers-api.md).

| Method | Path | Purpose |
|--------|------|---------|
| GET | `/api/admin/notification-channels` | list channels |
| POST | `/api/admin/notification-channels` | create / update a channel (upsert) |
| DELETE | `/api/admin/notification-channels/:id` | delete a channel |
| POST | `/api/admin/notification-channels/test` | enqueue a test delivery |

```bash
# List
curl -s "${AH[@]}" http://localhost:4000/api/admin/notification-channels

# Upsert (unique on tenant + channelType + name)
curl -s "${AH[@]}" http://localhost:4000/api/admin/notification-channels -d '{
  "channelType": "WEBHOOK", "name": "ops-hook",
  "config": { "url": "https://example.com/hook" },
  "isDefault": true, "status": "ACTIVE" }'
# → { id, channelType, name, config, isDefault, status }

# Delete
curl -s "${AH[@]}" -X DELETE http://localhost:4000/api/admin/notification-channels/$ID
# → { "status": "SUCCESS" }

# Fire a test payload through the queue
curl -s "${AH[@]}" http://localhost:4000/api/admin/notification-channels/test -d '{
  "channelType": "WEBHOOK", "name": "ops-hook",
  "sample": { "url": "https://example.com/hook" } }'
# → { "status": "ENQUEUED", "jobId": "…" }
```

**Errors:** `400 { "error": "channelType, name, config required" }` on upsert; `400 { "error": "channelType required" }` on test.

Setting `isDefault: true` clears the default flag on other channels of the same
`channelType` first, so exactly one default exists per type.

---

## Related

- [connectors.md](connectors.md) — per-engine `config` shapes for registering sources.
- [metadata-manifests.md](metadata-manifests.md) — crawling and declarative schema management.
- [authentication-and-tenancy.md](authentication-and-tenancy.md) — admin tenant override and impersonation.
