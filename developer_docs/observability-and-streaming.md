# Observability, Latency Profiling & Streaming Responses

This document details query execution planning, leg-by-leg performance tracing, audit logs propagation, and streaming chunked responses inside the Zero Data Fabric.

---

## 1. Query Execution Traces

Each query returns an execution plan mapping the strategy and database legs accessed.

### Strategy Types:
* **`SINGLE_LOCAL`**: Query processed entirely on the PostgreSQL hub coordinator.
* **`SINGLE_CONNECTOR`**: Query pushed down completely to a single external connection (e.g. MySQL).
* **`CROSS_ENGINE`**: Query coordinated across multiple separate databases (bind-joins / federated unions).

### Example Response Trace:
```jsonc
{
  "data": [ ... ],
  "plan": {
    "strategy": "CROSS_ENGINE",
    "executionMs": 34,
    "rowsScannedAcrossSources": 150,
    "legs": [
      {
        "source": "US_Postgres",
        "engine": "POSTGRES",
        "operation": "select",
        "query": "SELECT id, sku FROM public.products",
        "rowsReturned": 100,
        "ms": 12
      },
      {
        "source": "Sales_Mongo",
        "engine": "MONGODB",
        "operation": "find",
        "query": "db.orders.find({ \"product_id\": { \"$in\": [...] } })",
        "rowsReturned": 50,
        "ms": 18
      }
    ]
  }
}
```

---

## 2. Audit Logs Configuration

All query operations are cataloged inside the `audit_logs` collection. This trace history tracks compliance constraints:

```json
{
  "timestamp": "2026-07-13T16:51:49.000Z",
  "tenant_id": "tenant_A",
  "user_id": "user-0092",
  "role": "viewer",
  "action": "SELECT",
  "resource": "shipments",
  "execution_strategy": "CROSS_ENGINE",
  "execution_time_ms": 34,
  "rows_returned": 50,
  "query_expression": "SELECT s.region, SUM(s.total_amount) FROM shipments s GROUP BY s.region;"
}
```

---

## 3. Streaming Query Responses

For large datasets, the Query Engine supports **HTTP chunked transfer encoding**, streaming records as a continuous JSON Lines (`ndjson`) sequence to prevent memory constraints on client nodes.

### Request Endpoint:
<code class="docs-badge">POST /api/analytics/query-stream</code>

```bash
curl -N -X POST http://localhost:4000/api/analytics/query-stream \
  -H "Authorization: Bearer $JWT_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "queryConfig": {
      "type": "SELECT",
      "schema": "public",
      "limit": 50000,
      "query": {
        "from": { "resource": "transaction_logs", "source": "MySQL_Archive" }
      }
    }
  }'
```

### Stream Response Blocks:
The data streams back continuously as JSON sequences separated by newlines, terminating with a metadata footer block:

```json
{"id": 1, "sku": "SKU-100", "price": 10.5}
{"id": 2, "sku": "SKU-101", "price": 15.0}
{"id": 3, "sku": "SKU-102", "price": 8.9}
...
{"meta": { "rowsStreamed": 50000, "status": "COMPLETED", "executionTimeMs": 1420 }}
```
