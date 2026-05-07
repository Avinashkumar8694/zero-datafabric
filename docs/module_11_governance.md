# Module 11: Performance & Cost Governance (Safety Shield)

## 1. Module Objective
In a Data Fabric environment, executing queries against remote virtualized sources can be computationally expensive and risky. The **Safety Shield** module implements an automated governance layer to prevent runaway queries and accidental data destruction.

## 2. Governance Policies

### 2.1. Automatic Row-Level Caps
Every synchronous query executed via the Analytics Workbench is subject to an automated `LIMIT` injection if one is not specified by the user.
*   **Rule**: `IF (SQL starts with SELECT) AND (SQL does not contain LIMIT) THEN APPEND LIMIT 1000`.
*   **Purpose**: Prevents the browser and the Orchestrator from hanging due to multi-million row result sets.

### 2.2. Mutation Safeguards
To prevent "Accidental Data Wipes," the platform strictly blocks destructive operations that lack specific filters.
*   **Blocked Patterns**:
    *   `DELETE FROM table_name;` (without `WHERE`)
    *   `UPDATE table_name SET col = val;` (without `WHERE`)
*   **Result**: Returns an `INDUSTRIAL GOVERNANCE BLOCK` error with a 403 Forbidden status.

## 3. Operational Telemetry (Health)
The platform exposes a telemetry heartbeat via `/api/health`.

| Metric | Source | Industrial Purpose |
| :--- | :--- | :--- |
| **Status** | Live Check | Real-time availability of the Hub |
| **DB Latency** | `SELECT 1` | Monitoring network/storage performance |
| **Pool Stats** | PG Pool | Detecting connection leakage or saturation |
| **Uptime** | Process | Ensuring long-term system stability |

## 4. UI Feedback
The Management UI provides immediate transparency when governance is applied:
*   **Workbench**: Displays a `Safety Applied` badge if a query was capped.
*   **Dashboard**: Displays a `Fabric Health` card with live telemetry.
