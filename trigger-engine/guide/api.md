# Trigger API Reference

The Trigger system is primarily managed through the Backend API, with the Trigger Engine handling internal transpilation and health checks.

## Backend Orchestrator APIs (Port 4000)

### 1. Trigger Management
- **GET `/api/triggers`**: List all triggers in the active tenant.
- **POST `/api/triggers`**: Create a new trigger definition.
- **PUT `/api/triggers/:id`**: Update an existing trigger.
- **DELETE `/api/triggers/:id`**: Enqueue deletion of a trigger.
- **POST `/api/triggers/:id/deploy`**: Enqueue deployment (physical creation) of a trigger.

### 2. Job & Log Monitoring
- **GET `/api/triggers/jobs/list`**: View recent background jobs (deployment, actions).
- **POST `/api/triggers/jobs/retry/:id`**: Manually retry a failed job.
- **GET `/api/triggers/logs/list`**: View detailed execution logs (audit trail).

### 3. Notification Channels
- **GET `/api/admin/notification-channels`**: List configured targets.
- **POST `/api/admin/notification-channels`**: Upsert a channel (EMAIL, TELEGRAM, WEBHOOK).
- **DELETE `/api/admin/notification-channels/:id`**: Remove a channel.
- **POST `/api/admin/notification-channels/test`**: Enqueue a test notification.

---

## Trigger Engine APIs (Port 4001)

These are used internally by the Backend and for diagnostics.

### 1. Transpilation
- **POST `/api/trig-engine/transpile`**:
    - **Payload**: `{ trigger: {...}, schemaName: "...", tableName: "..." }`
    - **Returns**: `{ sql: ["CREATE FUNCTION...", "CREATE TRIGGER..."] }`

### 2. Health & Control
- **GET `/api/trig-engine/health`**: Check if the worker is active and polling.
- **POST `/api/trig-engine/jobs/run-once`**: Force a worker tick immediately.

## Trigger Action Payload Structure

When a trigger fires, the `execute` payload follows this structure:

### EMAIL
```json
{
  "type": "EMAIL",
  "params": {
    "to": "ops@example.com",
    "subject": "Alert: {{newRow.id}}",
    "text": "Status changed to {{newRow.status}}"
  }
}
```

### WEBHOOK
```json
{
  "type": "WEBHOOK",
  "url": "https://api.service.com/hook",
  "method": "POST",
  "headers": { "Authorization": "Bearer ..." },
  "payload": { "id": "{{newRow.id}}", "event": "{{event}}" }
}
```

### TELEGRAM
```json
{
  "type": "TELEGRAM",
  "params": {
    "chatId": "@alerts",
    "text": "Trigger fired!"
  }
}
```
