# Trigger Examples

End-to-end, runnable examples covering **every trigger type and every creation
path** the Data Fabric supports. Each script logs PASS/FAIL and prints the
evidence (audit rows, job `run_at`, execution logs) so you can see the engine
actually did the work.

## Prerequisites

```bash
npm run infra:up          # Postgres hub/remote, Mongo, ES, Redis
npm run start             # backend :4000 + ui :3001 + trigger-engine :4001
```

The **trigger-engine microservice must be running** (`:4001`) for the API/UI,
schedule, and durability scenarios — it owns the durable `trigger_jobs` queue
and dispatches actions. Manifest DB-procedure triggers (01) work even without
it, because they are transpiled natively by the orchestrator.

## Run

```bash
node examples/triggers/run-all.js          # whole suite
node examples/triggers/03-relative-schedule.js   # one scenario
```

## The three creation paths

| Path | Shape | Compiled by | Example |
|------|-------|-------------|---------|
| **Manifest** | `triggers:[{ name, timing, events, … }]` on a TABLE | Orchestrator → native `CREATE TRIGGER` (owner privileges) | `01`, `06` |
| **API / UI** | `definition:{ event, execute:{type} }` in the trigger registry, then deploy | trigger-engine MS → native trigger that enqueues a durable job | `02`–`05` |
| **Raw SQL** | `CREATE TRIGGER …` via `/queries/exec` | *Denied by design* — tenant users run sandboxed and cannot DDL managed schemas. Use the manifest or API instead. | — |

## Declarative authoring — no hand-written plpgsql

A manifest trigger declares its behaviour in one of three ways; none require a
plpgsql function body (see `06`):

```jsonc
// 1) action — mini SQL/AST DSL
{ "action": { "type": "INSERT", "into": "order_events",
              "values": { "order_id": "NEW.id", "op": "TG_OP", "at": "NOW()" } } }
{ "action": { "type": "RAISE", "when": {"left":"NEW.amount","operator":"GT","right":"100000"},
              "message": "amount exceeds limit" } }
{ "action": { "type": "UPDATE", "table": "t", "set": {...}, "where": {...} } }   // where required
{ "action": { "type": "DELETE", "from": "t", "where": {...} } }                  // where required
{ "action": { "type": "PERFORM", "function": "fn" } }
{ "action": { "sql": "INSERT INTO audit(order_id, op) VALUES (NEW.id, TG_OP)" } } // single-statement escape

// 2) execute — the same declarative model API/UI triggers use
{ "execute": { "type": "AUDIT" } }                       // → built-in audit_log_fn
{ "execute": { "type": "WEBHOOK", "url": "…", "auth": {…} } }  // enqueues a durable job
{ "execute": { "type": "EXCEPTION", "when": {…}, "message": "…" } }

// 3) procedure — EXECUTE an existing trigger function (advanced)
{ "procedure": "audit_log_fn" }
```

Value expressions are compiled through a safe whitelist — `NEW.`/`OLD.` column
refs, `TG_OP` / `TG_TABLE_NAME` / `NOW()` / `CURRENT_TIMESTAMP` / boolean / null
keywords, and numeric literals pass through; anything else becomes a quoted
string literal — so nothing authored in a manifest can inject SQL.

## Control-plane visibility

**Every** trigger appears in the control plane (`GET /api/triggers`, the Triggers
UI page). Manifest triggers are registered in `trigger_registry` with
`definition.source = 'MANIFEST'`; API/UI triggers have no `source` marker.

## Deleting a trigger

Deleting a trigger drops the native trigger **and cancels its still-pending
jobs** — recurring `SCHEDULE_TRIGGER` ticks and any future `RELATIVE` action
jobs move to `CANCELLED`, so nothing fires after the trigger is gone (`06`
demonstrates this). A `DELETE_TRIGGER` job never cancels itself.

## Scenarios

- **01 — manifest DB-procedure trigger.** Declares an `AFTER INSERT/UPDATE`
  trigger in a manifest that runs `public.audit_log_fn()`. Proves it fired by
  watching `fabric_admin.audit_logs`.
- **02 — API/UI action triggers.** One trigger per `execute.type`:
  `AUDIT`, `WEBHOOK` (OIDC auth + templating), `EMAIL` (conditional templates),
  `TELEGRAM`, `FUNCTION` (inline `PERFORM`), `EXCEPTION` (blocks an over-limit
  insert). AUDIT/FUNCTION/EXCEPTION are verified deterministically.
- **03 — RELATIVE schedule.** The headline for column-anchored scheduling:
  deploys one trigger anchored to a row's `event_time` column and one anchored
  to firing time, then reads the enqueued `trigger_jobs.run_at` and asserts each
  matches its anchor + interval.
- **04 — FIXED + CRON schedulers.** Standalone recurring `__SYSTEM__`
  schedulers; confirms each is armed with a future `run_at` and reschedules.
- **05 — autoDrop + durability.** A one-shot trigger that self-drops when a row
  meets `autoDrop.when`, plus a demonstration that jobs persist in Postgres
  (store-and-forward) and drain when the worker runs.
- **06 — declarative authoring + control plane + delete cleanup.** Manifest
  triggers authored with the mini action DSL and the declarative `execute` block
  (no plpgsql); proves all appear in the control plane and that deleting a
  trigger cancels its pending jobs.

## Schedule types

```jsonc
// RELATIVE — defer a fired action
{ "type": "RELATIVE", "after": 30, "unit": "MINUTE", "column": "event_time" }
//   column set   → run_at = row.event_time + 30m  (NEW on insert/update, OLD on delete; falls back to NOW())
//   column unset → run_at = NOW() + 30m
// `unit`: SECOND | MINUTE | HOUR | DAY | MONTH ;  `relativeColumn` is an accepted alias for `column`.

{ "type": "FIXED", "every": 1, "unit": "MINUTE" }   // recur every N units
{ "type": "CRON",  "cron": "*/5 * * * *" }           // recur on a cron expression
```

## What proves it works

- **audit_logs** row appears for the affected table → a DB trigger fired.
- **trigger_jobs.run_at** equals the expected anchor + interval → RELATIVE
  scheduling (incl. column-relative) is correct.
- **trigger_execution_logs** entries per action type → the worker dispatched.
- **pg_trigger** no longer lists the trigger after a matching row → autoDrop ran.
