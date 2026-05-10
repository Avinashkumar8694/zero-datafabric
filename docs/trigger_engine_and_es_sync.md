# Elasticsearch Sync + Trigger Engine Control Plane

## 1) Elasticsearch sync expectation (Data Fabric standard)

### Expected behavior
- All tenant-approved resources should be searchable in Elasticsearch.
- Data Fabric write path must never hard-fail when Elasticsearch is unavailable.
- Sync can be asynchronous (not necessarily inline real-time), but it must be eventually consistent.

### Current implementation status
- Metadata `apply` performs snapshot indexing for configured resources through downstream provisioning.
- Runtime row-level mutation (`INSERT/UPDATE/DELETE`) emits mutation events, but full end-to-end mutation-to-ES indexing is not fully wired yet.
- Result: ES receives snapshot updates on apply; continuous per-mutation indexing is partial/incomplete.

### Recommended standard operating model
- Primary source of truth: SQL/virtual source engines.
- ES index path: async outbox/worker pipeline.
- Consistency target: eventual (seconds/minutes), not blocking query/mutation path.
- Failure mode: if ES is down, queue/retry and keep Data Fabric APIs healthy.

## 2) Trigger Engine standard architecture

### Goals
- Central trigger governance for all trigger types.
- Non-blocking backend (trigger execution/deploy can be async).
- Full visibility of deploy outcomes and runtime trigger events in UI.

### Control plane components
- `trigger_registry`: canonical definitions per tenant/schema/table/trigger.
- `trigger_execution_logs`: deployment and execution outcomes for forensic visibility.
- `trigger-engine` service: transpiles trigger AST and can be extended to own execution workers.
- Backend Trigger API: create/list/update/delete/deploy.
- UI Trigger console: registry + deploy actions + logs.

## 3) What has been added now

- New DB tables:
  - `public.trigger_registry`
  - `public.trigger_execution_logs`
- New authenticated APIs:
  - `GET /api/triggers`
  - `POST /api/triggers`
  - `PUT /api/triggers/:id`
  - `DELETE /api/triggers/:id`
  - `POST /api/triggers/:id/deploy`
  - `GET /api/triggers/logs/list`
- New UI page:
  - `/triggers` (Trigger Control Plane)
  - Includes trigger list, create/edit via JSON, deploy, delete, and logs view.

## 4) Runtime outcome visibility

- Every trigger registry operation writes to `trigger_execution_logs`.
- Trigger deployment success/failure from trigger-engine transpilation + SQL apply is logged with detail payload.
- UI reads logs directly from Trigger API to provide operator visibility.

## 5) Next step for full enterprise-grade closure

- Add mutation outbox worker for continuous ES indexing:
  - Consume mutation events.
  - Build tenant/index routing map.
  - Apply idempotent upsert/delete to ES.
  - Retry with dead-letter handling.
- Extend trigger-engine from transpiler-only to worker runtime owner:
  - Central task queue consumer.
  - Per-trigger execution metrics and retry policy.

---

## 6) Microservice deployment model (implemented)

### What happens now
1. UI/API creates trigger definition in `trigger_registry`.
2. Deploy/delete actions enqueue jobs in `trigger_jobs`.
3. `trigger-engine` worker polls `trigger_jobs` and processes jobs asynchronously.
4. Worker writes outcomes to `trigger_execution_logs`.
5. UI reads registry + jobs + logs for full operational visibility.

### Why this is non-blocking
- Query path does not wait for trigger deployment jobs.
- Trigger actions (`AUDIT`, `WEBHOOK`, `EMAIL`, `TELEGRAM`) are processed by worker jobs.
- If `trigger-engine` is down, jobs stay queued; Data Fabric core query APIs continue.

## 7) Supported trigger action types

- `AUDIT`: worker records action outcome logs.
- `WEBHOOK`: worker records webhook target and outcome (simulation-ready; can be wired to real HTTP POST).
- `EMAIL`: worker records email target metadata and outcome (simulation-ready; can be wired to SMTP/provider).
- `TELEGRAM`: worker records chat target metadata and outcome (simulation-ready; can be wired to Bot API).
- `EXCEPTION` / `FUNCTION`: preserved in trigger transpilation path.

## 7.2 What each action does (current behavior)

1. `AUDIT`
- Worker writes a row to `fabric_admin.audit_logs` with:
  - `tenant_id`, `action = TRIGGER_<EVENT>`, `table_name`, `row_id`
  - `new_data` containing `triggerName`, `event`, `newRow`, `oldRow`.

2. `EMAIL` (live SMTP)
- Worker resolves tenant channel config from `notification_channels` (`channel_type = EMAIL`).
- Supports dynamic templates with placeholders:
  - `{{triggerName}}`, `{{event}}`, `{{tableName}}`, `{{schemaName}}`, `{{newRow.id}}`, etc.
- Delivery uses tenant channel SMTP config:
  - `smtpHost`, `smtpPort`, `smtpSecure`, `smtpUser`, `smtpPass`, `fromEmail`
- Resolved fields logged:
  - `to`, `from`, `subject`, `text`, `html`.
- Conditional placeholders are supported:
  - `{{?newRow.amount>100|HIGH|NORMAL}}`
  - `{{?newRow.status!=oldRow.status|STATUS_CHANGED|STATUS_UNCHANGED}}`

3. `TELEGRAM` (live Bot API or webhook mode)
- Worker resolves tenant `TELEGRAM` channel config.
- Supports dynamic `text` template with same placeholders.
- Bot mode config:
  - `botToken`, `chatId`, optional `parseMode`
- Webhook mode config:
  - `deliveryMode: "WEBHOOK"`, `url`, `headers`, `auth`, `payload`
- Resolved delivery details are logged.

4. `WEBHOOK` (live HTTP dispatch)
- Supports:
  - custom headers (`execute.headers`)
  - dynamic body payload (`execute.payload` templates)
  - auth block (`execute.auth`) with `NONE|BASIC|BEARER|OIDC`
- OIDC auth uses live client-credentials exchange when configured:
  - requires `tokenEndpoint`, `clientId`, `clientSecret` (optional `scope`, `audience`)
  - resulting bearer token is attached to outbound request.

## 7.4 Template placeholders (including update old/new)

- Direct field interpolation:
  - `{{newRow.id}}`, `{{oldRow.status}}`, `{{triggerName}}`, `{{tableName}}`
- Conditional expression interpolation:
  - `{{?newRow.amount>100|HIGH|NORMAL}}`
  - `{{?newRow.status!=oldRow.status|CHANGED|UNCHANGED}}`
- Supported operators in conditional expression:
  - `==`, `!=`, `>`, `<`, `>=`, `<=`

## 7.3 Example webhook auth config

```json
{
  "execute": {
    "type": "WEBHOOK",
    "url": "https://partner.example.com/hooks",
    "method": "POST",
    "headers": {
      "x-correlation-id": "{{triggerName}}-{{newRow.id}}"
    },
    "auth": {
      "type": "OIDC",
      "tokenEndpoint": "https://idp.example.com/oauth/token",
      "clientId": "fabric-webhook-client",
      "clientSecret": "secret",
      "audience": "https://partner.example.com",
      "scope": "events.publish"
    },
    "payload": {
      "event": "{{event}}",
      "rowId": "{{newRow.id}}"
    }
  }
}
```

## 7.1 Tenant-scoped channel configuration

- Channel configs are tenant-bound (`notification_channels.tenant_id`).
- Active tenant in UI (`x-tenant-id`) controls which channel set is read/written.
- Trigger-engine resolves EMAIL/TELEGRAM/WEBHOOK channel by tenant at execution time.
- One tenant cannot read or use another tenant’s channel credentials.

## 8) Scheduler behavior

- Trigger definition `schedule` metadata is stored in payload and job metadata supports delayed retries (`run_at`) and bounded retry (`max_attempts`).
- Generic scheduler trigger (no table row dependency) is supported by creating trigger with:
  - `schemaName = "__SYSTEM__"`
  - `tableName = "__SYSTEM__"`
  - `definition.schedule = { "type":"FIXED", "every": <n>, "unit":"SECOND|MINUTE|HOUR|DAY" }` OR
  - `definition.schedule = { "type":"CRON", "cron":"*/5 * * * *" }`
- These are executed as recurring `SCHEDULE_TRIGGER` jobs and emit `TRIGGER_SCHEDULE_TICK` logs.
- Worker updates status lifecycle: `PENDING -> RUNNING -> COMPLETED` or `FAILED`.
- Failed jobs can be re-enqueued via API/UI retry action.

## 9) How to run and verify

1. Start backend and UI:
   - `npm run start:backend`
   - `npm run start:ui`
2. Start trigger-engine (separate service):
   - `cd trigger-engine && npm start`
3. Seed and prepare data:
   - `npm run examples:prepare`
4. Run trigger examples:
   - `npm run examples:triggers`
5. Validate in UI:
   - Open `/triggers`
   - Check Trigger Registry, Trigger Jobs, Trigger Logs sections.
