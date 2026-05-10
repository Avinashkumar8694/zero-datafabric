# Trigger Journey Sequence Diagrams

This document visualizes the step-by-step flow of trigger operations.

## 1. Trigger Creation & Deployment

```mermaid
sequenceDiagram
    participant U as User (UI)
    participant B as Backend
    participant D as Database
    participant W as Trigger Worker

    U->>B: POST /api/triggers (Define)
    B->>D: INSERT INTO trigger_registry
    B-->>U: 201 Created

    U->>B: POST /api/triggers/:id/deploy
    B->>D: INSERT INTO trigger_jobs (DEPLOY_TRIGGER)
    B-->>U: 202 Enqueued

    loop Every 1.5s
        W->>D: SELECT PENDING jobs
        D-->>W: DEPLOY_TRIGGER job
        W->>W: Transpile JSON to SQL
        W->>D: EXECUTE CREATE TRIGGER...
        W->>D: UPDATE trigger_jobs (COMPLETED)
        W->>D: UPDATE trigger_registry (ACTIVE)
    end
```

## 2. Trigger Firing & Action Execution

```mermaid
sequenceDiagram
    participant T as Target Table
    participant PG as Postgres Engine
    participant D as Database (Jobs)
    participant W as Trigger Worker
    participant E as External Service

    T->>PG: Data Update (INSERT/UPDATE)
    PG->>PG: Fire Database Trigger
    PG->>D: INSERT INTO trigger_jobs (EXECUTE_TRIGGER_ACTION)

    loop Every 1.5s
        W->>D: SELECT PENDING jobs
        D-->>W: EXECUTE_TRIGGER_ACTION job
        W->>D: SELECT Notification Channel Config
        W->>E: Send Notification (Email/WH/TG)
        E-->>W: 200 OK
        W->>D: UPDATE trigger_jobs (COMPLETED)
        W->>D: INSERT INTO trigger_execution_logs
    end
```

## 3. Trigger Deletion

```mermaid
sequenceDiagram
    participant U as User (UI)
    participant B as Backend
    participant D as Database
    participant W as Trigger Worker

    U->>B: DELETE /api/triggers/:id
    B->>D: UPDATE status = 'PENDING_DELETE'
    B->>D: INSERT INTO trigger_jobs (DELETE_TRIGGER)
    B-->>U: 200 Accepted

    loop Every 1.5s
        W->>D: SELECT PENDING jobs
        D-->>W: DELETE_TRIGGER job
        W->>D: DROP TRIGGER IF EXISTS...
        W->>D: DELETE FROM trigger_registry
        W->>D: UPDATE trigger_jobs (COMPLETED)
    end
```
