# Triggers API

`/api/triggers` — the trigger **control plane**. Define reactive behaviour
declaratively (no hand-written plpgsql), deploy it, and observe every firing
through logs and a durable job queue.

There are two kinds of trigger, both visible in this one control plane:

- **Manifest triggers** — declared inside a table resource in a manifest
  (`triggers: [...]`); the orchestrator transpiles them to native Postgres DDL at
  apply time and registers them here with `source: "MANIFEST"`. See
  [metadata-manifests.md](metadata-manifests.md#triggers).
- **Control-plane triggers** — created/updated through this API (or the UI) with
  `source` API/UI. Row-based ones deploy to native DDL; schedule-based ones run
  as recurring fabric jobs.

All endpoints require `Authorization` + `x-tenant-id`. Examples use the `H`
header array from [api-overview.md](api-overview.md#required-headers).

## Trigger definition shape

A trigger record is `{ triggerName, schemaName?, tableName?, definition }`. The
`definition` declares the behaviour in one of three ways:

```jsonc
// 1. execute — the declarative action model (recommended)
{ "triggerName": "notify_big_order",
  "schemaName": "public", "tableName": "orders",
  "definition": {
    "event": "AFTER_INSERT",              // TIMING_EVENT: {BEFORE|AFTER}_{INSERT|UPDATE|DELETE}
    "execute": {
      "type": "WEBHOOK",                  // AUDIT | WEBHOOK | EMAIL | TELEGRAM | FUNCTION | EXCEPTION
      "url": "https://example.com/hook",
      "when": { "left": "NEW.total_amount", "operator": "GT", "right": 1000 }
    } } }

// 2. procedure — call an existing trigger function (escape hatch)
{ "triggerName": "audit_orders", "schemaName": "public", "tableName": "orders",
  "definition": { "event": "AFTER_UPDATE", "procedure": "audit_log_fn",
                  "execute": { "type": "FUNCTION" } } }

// 3. schedule — a recurring fabric job (no table needed)
{ "triggerName": "nightly_rollup",
  "definition": { "schedule": { "type": "FIXED", "every": 1, "unit": "HOUR" },
                  "execute": { "type": "WEBHOOK", "url": "https://example.com/rollup" } } }
```

Validation rules (all `400` on failure):
- `triggerName` and `definition` are required.
- `definition.execute.type` is required.
- For **row-based** triggers (no `schedule`): `definition.event`, `schemaName`
  and `tableName` are required.

Durable action types (`WEBHOOK`/`EMAIL`/`TELEGRAM`) fire asynchronously by
enqueuing a job on the queue; `AUDIT`/`FUNCTION`/`EXCEPTION` compile inline into
the trigger body. Fired jobs route through the configured notification channels
(see [admin-api.md](admin-api.md#notification-channels)).

---

## Endpoints

### GET `/api/triggers` — list

```bash
curl -s "${H[@]}" http://localhost:4000/api/triggers
```

`200` → array of `{ id, schemaName, tableName, triggerName, definition, status, lastDeployedAt, updatedAt }`, newest first. `status` ∈ `ACTIVE | PENDING_DEPLOY | PENDING_DELETE`.

### POST `/api/triggers` — create

Upserts on `(tenant, schema, table, name)`.

```bash
curl -s "${H[@]}" http://localhost:4000/api/triggers -d '{
  "triggerName": "notify_big_order", "schemaName": "public", "tableName": "orders",
  "definition": { "event": "AFTER_INSERT", "execute": {
    "type": "WEBHOOK", "url": "https://example.com/hook",
    "when": { "left": "NEW.total_amount", "operator": "GT", "right": 1000 } } } }'
```

**Success (`201`):** `{ id, schemaName, tableName, triggerName, definition, status }`.

**Errors:** `400 { "error": "triggerName and definition are required" }`, `400 { "error": "definition.execute.type is required" }`, etc.

### PUT `/api/triggers/:id` — update

Same body as create. `200` with the updated record; `400 { "error": "Trigger not found" }` if the id is unknown; `400 { "error": "id is required" }` if the path id is empty.

### DELETE `/api/triggers/:id` — delete

Marks the trigger `PENDING_DELETE`, cancels its outstanding queued work, and
enqueues a `DELETE_TRIGGER` job to drop the native DDL.

```bash
curl -s "${H[@]}" -X DELETE http://localhost:4000/api/triggers/$ID
```

`200 { "status": "SUCCESS" }`.

### POST `/api/triggers/:id/deploy` — deploy

Transitions the trigger to `PENDING_DEPLOY` and enqueues the deploy job — a
`DEPLOY_TRIGGER` job (native DDL) for row-based triggers, or a `SCHEDULE_TRIGGER`
job for schedule-based ones.

```bash
curl -s "${H[@]}" -X POST http://localhost:4000/api/triggers/$ID/deploy
```

**Success (`200`):** `{ "status": "ENQUEUED", "jobId": "…" }`.

### GET `/api/triggers/logs/list` — execution log

Every lifecycle and firing event.

```bash
curl -s "${H[@]}" "http://localhost:4000/api/triggers/logs/list?triggerId=$ID&limit=50&offset=0"
```

`200` → array of `{ id, triggerId, triggerName, schemaName, tableName, eventType, action, status, detail, createdAt }`. `action` includes `TRIGGER_UPSERT`, `TRIGGER_UPDATE`, `TRIGGER_DEPLOY_ENQUEUED`, `TRIGGER_DELETE_ENQUEUED`, `TRIGGER_JOBS_CANCELLED`. Omit `triggerId` for all triggers.

### GET `/api/triggers/jobs/list` — durable job queue

```bash
curl -s "${H[@]}" http://localhost:4000/api/triggers/jobs/list
```

`200` → up to 200 jobs `{ id, triggerId, jobType, status, attempts, maxAttempts, runAt, lastError, createdAt }`. `jobType` ∈ `DEPLOY_TRIGGER | SCHEDULE_TRIGGER | DELETE_TRIGGER | EXECUTE_TRIGGER_ACTION`; `status` ∈ `PENDING | RUNNING | SUCCESS | ERROR | CANCELLED`.

### POST `/api/triggers/jobs/:id/retry` — retry a job

Resets a job to `PENDING`, clears its error and sets `run_at = NOW()` so the
worker picks it up again.

```bash
curl -s "${H[@]}" -X POST http://localhost:4000/api/triggers/jobs/$JOB_ID/retry
```

**Success (`200`):** `{ "status": "ENQUEUED", "jobId": "…" }`.

---

## Manifest triggers vs control-plane triggers

| | Manifest triggers | Control-plane triggers |
|--|-------------------|------------------------|
| **Authored in** | a manifest table's `triggers[]` | this API / the UI |
| **`source`** | `MANIFEST` | `API` / `UI` |
| **When registered** | atomically inside the manifest apply transaction | on `POST`/`PUT` |
| **Deployment** | transpiled to native DDL at apply time | via `POST /:id/deploy` |
| **Visible in `/api/triggers`** | yes | yes |

Both are compiled by the same declarative action compiler, so the `execute` /
`procedure` / `action` forms are identical in either place.

## Typical flow

```bash
# 1. Create
ID=$(curl -s "${H[@]}" http://localhost:4000/api/triggers -d '{ … }' | jq -r .id)
# 2. Deploy
curl -s "${H[@]}" -X POST http://localhost:4000/api/triggers/$ID/deploy
# 3. Watch it fire
curl -s "${H[@]}" "http://localhost:4000/api/triggers/logs/list?triggerId=$ID"
curl -s "${H[@]}" http://localhost:4000/api/triggers/jobs/list
# 4. Retry a failed action job if needed
curl -s "${H[@]}" -X POST http://localhost:4000/api/triggers/jobs/$JOB_ID/retry
```
