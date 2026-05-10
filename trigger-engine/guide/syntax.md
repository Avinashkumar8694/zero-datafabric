# Trigger Syntax Reference

This guide provides the full JSON schema and possible values for defining triggers in the Zero Data Fabric.

## Root Properties

| Property | Type | Description |
| :--- | :--- | :--- |
| `name` | `string` | Unique identifier for the trigger. |
| `event` | `enum` | When the trigger should fire. See [Event Types](#event-types). |
| `condition` | `object | string` | Optional filter expression (SQL-like) before executing the action. |
| `execute` | `object` | The action to perform. See [Execute Types](#execute-types). |
| `schedule` | `object` | Optional timing/repetition settings. See [Schedule Settings](#schedule-settings). |
| `autoDrop` | `object` | Optional self-deletion condition. See [AutoDrop Settings](#autodrop-settings). |

---

## Event Types

The event determines when the trigger fires and which variables are available in the context.

| Event | Logic Point | Available Variables |
| :--- | :--- | :--- |
| `BEFORE_INSERT` | Before row is saved | `NEW` (proposed values) |
| `AFTER_INSERT` | After row is saved | `NEW` (final values + generated IDs) |
| `BEFORE_UPDATE` | Before changes are saved | `NEW` (new data), `OLD` (original data) |
| `AFTER_UPDATE` | After changes are saved | `NEW` (new data), `OLD` (original data) |
| `BEFORE_DELETE` | Before row is removed | `OLD` (the row to be deleted) |
| `AFTER_DELETE` | After row is removed | `OLD` (the row that was deleted) |

---

## Condition Syntax

The `condition` property determines if the action should be executed. It can be defined in two formats:

### 1. String Format (SQL-like)
A standard PostgreSQL boolean expression. Use `NEW` and `OLD` to reference row states.
- **Value Change**: `"NEW.status != OLD.status"`
- **Numeric Threshold**: `"NEW.quantity < 5"`
- **Multiple Criteria**: `"NEW.amount > 1000 AND NEW.category = 'Electronics'"`

### 2. Object Format (AST)
A structured format often used by UI builders to avoid string parsing issues.
- **Equals**: `{ "column": "NEW.status", "operator": "EQ", "value": "ACTIVE" }`
- **Greater Than**: `{ "column": "NEW.amount", "operator": "GT", "value": 5000 }`
- **Not Equal**: `{ "column": "NEW.type", "operator": "NE", "value": "SYSTEM" }`
- **Pattern Match**: `{ "column": "NEW.email", "operator": "ILIKE", "value": "%@gmail.com" }`
- **Native Expression**: `{ "column": "NEW.created_at", "operator": "LT", "expression": "NOW() - INTERVAL '30 days'" }`
- **Null Check**: `{ "column": "NEW.deleted_at", "operator": "IS_NULL" }`
- **Set Inclusion**: `{ "column": "NEW.status", "operator": "IN", "value": ["ACTIVE", "PENDING"] }`
- **Raw Expression**: `{ "expression": "NEW.amount * 1.1 > OLD.amount" }`

**Supported Operators**: `EQ` (=), `NE` (!=), `GT` (>), `LT` (<), `GTE` (>=), `LTE` (<=), `LIKE`, `ILIKE`, `IN`, `IS_NULL`, `IS_NOT_NULL`.

## Variable Scopes: NEW vs OLD

Understanding when to use prefixes is critical for correct trigger behavior.

### 1. In Conditions (`condition`, `autoDrop.when`)
These use the PostgreSQL trigger row aliases.
- **`NEW.status`**: Accesses the value **after** the change.
- **`OLD.status`**: Accesses the value **before** the change.
- **Usage**: Use them to detect specific transitions, e.g., `NEW.status = 'ACTIVE' AND OLD.status = 'PENDING'`.

### 2. In Templates & Payloads (`payload`, `message`, `subject`)
Variables are resolved from a JSON context. You can use the `NEW` and `OLD` prefixes, or use direct shorthands.
- **Full Path**: `{{NEW.status}}`, `{{OLD.amount}}`
- **Shorthand**: `{{status}}` (automatically maps to `{{NEW.status}}`)
- **Metadata**: `{{triggerName}}`, `{{event}}`, `{{tableName}}`

### 3. In Stop Conditions (`schedule.stopCondition`)
Evaluated by the worker against the current database state. Prefixes are optional.
- **Direct**: `{ "column": "status", "operator": "EQ", "value": "ACTIVE" }`
- **Prefix (Optional)**: `{ "column": "NEW.status", "operator": "EQ", "value": "ACTIVE" }`
- **Why**: Since background jobs check the "Live" state, the engine treats `status` and `NEW.status` as identical current-state lookups.

---

## Execute Types

### 1. EMAIL
Sends an email using the tenant's configured SMTP channel.
```json
{
  "type": "EMAIL",
  "params": {
    "to": "recipient@example.com",
    "subject": "Subject template",
    "text": "Plain text body",
    "html": "<p>HTML body</p>"
  }
}
```

### 2. WEBHOOK
Calls an external HTTP endpoint.
```json
{
  "type": "WEBHOOK",
  "url": "https://api.site.com/hook",
  "method": "POST",
  "headers": { "X-Custom": "Value" },
  "auth": {
    "type": "BEARER",
    "token": "secret-token"
  },
  "payload": { "id": "{{newRow.id}}", "data": "..." }
}
```

### 3. TELEGRAM
Sends a message to a Telegram chat or channel.
```json
{
  "type": "TELEGRAM",
  "params": {
    "chatId": "123456789",
    "text": "Message with <b>{{newRow.title}}</b>"
  }
}
```

### 4. EXCEPTION
Prevents the database operation by throwing an error (Rollback).
```json
{
  "type": "EXCEPTION",
  "message": "Invalid inventory update!",
  "when": "NEW.quantity < 0"
}
```

### 5. AUDIT
Logs the event to the centralized audit table.
```json
{ "type": "AUDIT" }
```

### 6. FUNCTION
Calls an existing PostgreSQL function in the same schema.
```json
{
  "type": "FUNCTION",
  "name": "my_custom_cleanup_fn"
}
```

---

## Schedule Settings

### FIXED / RELATIVE
| Property | Type | Description |
| :--- | :--- | :--- |
| `type` | `enum` | `FIXED` (recurring) or `RELATIVE` (initial delay). |
| `after` | `number` | Initial delay (used with `RELATIVE`). |
| `every` | `number` | Repetition interval (used with `FIXED`). |
| `unit` | `enum` | `SECOND`, `MINUTE`, `HOUR`, `DAY`, `MONTH`. |

### CRON
| Property | Type | Description |
| :--- | :--- | :--- |
| `type` | `string` | `CRON`. |
| `cron` | `string` | Standard 5-part cron expression (e.g., `0 9 * * *`). |

---

## AutoDrop Settings
```json
{
  "autoDrop": {
    "when": "NEW.status = 'COMPLETED'",
    "message": "Cleanup after completion"
  }
}
```

---

## Complete Examples

### 1. Standalone Maintenance (Generic CRON)
Runs every Sunday at midnight to clean up audit logs.
```json
{
  "name": "weekly_audit_cleanup",
  "event": "AFTER_INSERT",
  "execute": {
    "type": "FUNCTION",
    "name": "cleanup_old_audits"
  },
  "schedule": {
    "type": "CRON",
    "cron": "0 0 * * 0"
  }
}
```

### 2. Standalone Monitoring (Generic FIXED)
Checks system health every 5 minutes.
```json
{
  "name": "health_check_tick",
  "event": "AFTER_INSERT",
  "execute": {
    "type": "WEBHOOK",
    "url": "https://monitor.io/ping",
    "method": "GET"
  },
  "schedule": {
    "type": "FIXED",
    "every": 5,
    "unit": "MINUTE"
  }
}
```

### 3. Escalation Workflow (Delayed Action)
Sends an email 1 hour after a high-priority ticket is created.
```json
{
  "name": "ticket_escalation",
  "event": "AFTER_INSERT",
  "condition": "NEW.priority = 'HIGH'",
  "execute": {
    "type": "EMAIL",
    "params": {
      "to": "supervisor@service.com",
      "subject": "Ticket #{{newRow.id}} still pending!"
    }
  },
  "schedule": {
    "type": "RELATIVE",
    "after": 1,
    "unit": "HOUR"
  }
}
```

### 4. Periodic Reminder (Repeating Action)
Sends a Slack notification every 1 day until a shipment is delivered.
```json
{
  "name": "delivery_reminder",
  "event": "AFTER_UPDATE",
  "condition": "NEW.status = 'IN_TRANSIT'",
  "execute": {
    "type": "WEBHOOK",
    "url": "https://hooks.slack.com/...",
    "payload": { "text": "Shipment {{newRow.id}} is still on its way." }
  },
  "schedule": {
    "type": "FIXED",
    "every": 1,
    "unit": "DAY"
  },
  "autoDrop": {
    "when": "NEW.status = 'DELIVERED'",
    "message": "Stopping reminders - Delivered"
  }
}
```

### 5. Business Rule Validation (Exception)
Blocks updates if the quantity becomes negative.
```json
{
  "name": "enforce_positive_inventory",
  "event": "BEFORE_UPDATE",
  "execute": {
    "type": "EXCEPTION",
    "message": "Inventory cannot be negative (Requested: {{newRow.quantity}})",
    "when": "NEW.quantity < 0"
  }
}
```

### 6. Dynamic Webhook (Context Injection)
Sends changed data to an external service using dynamic IDs.
```json
{
  "name": "sync_to_crm",
  "event": "AFTER_UPDATE",
  "condition": "NEW.status != OLD.status",
  "execute": {
    "type": "WEBHOOK",
    "url": "https://crm.api.com/sync/{{newRow.crm_id}}",
    "method": "PATCH",
    "payload": {
      "id": "{{newRow.id}}",
      "old_status": "{{oldRow.status}}",
      "new_status": "{{newRow.status}}",
      "updated_at": "{{newRow.updated_at}}"
    }
  }
}
```

### 7. Service Lifecycle Orchestration
This pattern uses multiple triggers to manage a row's lifecycle across external services.

#### Trigger A: Delayed Initialization
When a row moves to `IN_PROGRESS`, trigger a `/create` API call after a 10-minute stabilization window.
```json
{
  "name": "delayed_provisioning",
  "event": "AFTER_UPDATE",
  "condition": "NEW.status = 'IN_PROGRESS' AND OLD.status != 'IN_PROGRESS'",
  "execute": {
    "type": "WEBHOOK",
    "url": "https://api.provider.com/create",
    "payload": { "resourceId": "{{newRow.id}}" }
  },
  "schedule": {
    "type": "RELATIVE",
    "after": 10,
    "unit": "MINUTE"
  }
}
```

#### Trigger B: Immediate Decommissioning
When a row moves to `ACTIVE` (or a terminal state), trigger a `/delete` API call immediately.
```json
{
  "name": "immediate_cleanup",
  "event": "AFTER_UPDATE",
  "condition": "NEW.status = 'ACTIVE' AND OLD.status != 'ACTIVE'",
  "execute": {
    "type": "WEBHOOK",
    "url": "https://api.provider.com/delete",
    "payload": { "resourceId": "{{newRow.id}}" }
  }
}
```

#### Trigger C: Periodic Status Notification
While the row is `IN_PROGRESS`, send a notification to `/notify` every 1 hour.
```json
{
  "name": "hourly_status_ping",
  "event": "AFTER_UPDATE",
  "condition": "NEW.status = 'IN_PROGRESS' AND OLD.status != 'IN_PROGRESS'",
  "execute": {
    "type": "WEBHOOK",
    "url": "https://api.provider.com/notify",
    "payload": { "id": "{{newRow.id}}", "status": "still processing" }
  },
  "schedule": {
    "type": "FIXED",
    "every": 1,
    "unit": "HOUR"
  },
  "autoDrop": {
    "when": "NEW.status = 'ACTIVE'",
    "message": "Stopping hourly pings - Task Active"
  }
}
```
