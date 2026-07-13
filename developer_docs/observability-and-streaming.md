# Observability, Latency Profiling & Streaming Responses

This document details query execution planning, leg-by-leg performance tracing, audit logs propagation, and streaming chunked responses inside the Zero Data Fabric, complete with executable `curl` commands.

---

## 1. Supported Enums & Values

### Execution Strategy Types
* **`"SINGLE_LOCAL"`** — Query processed entirely on the PostgreSQL hub coordinator.
* **`"SINGLE_CONNECTOR"`** — Query pushed down completely to a single external connection (e.g. MySQL).
* **`"CROSS_ENGINE"`** — Query coordinated across multiple separate databases (bind-joins / federated unions).

### Engine Types (per leg)
* **`"POSTGRES"`** — PostgreSQL / Citus hub.
* **`"MYSQL"`** — MySQL connector.
* **`"MONGODB"`** — MongoDB connector.
* **`"ELASTICSEARCH"`** — Elasticsearch connector.
* **`"ORACLE"`** — Oracle DB connector.

### Audit Log Action Types
* `"SELECT"`, `"INSERT"`, `"UPDATE"`, `"DELETE"`, `"CALL"`, `"CREATE_TABLE"`, `"ALTER_TABLE"`, `"DROP_TABLE"`

---

## 2. Query Execution Traces

Each query response includes an execution plan mapping the strategy and database legs accessed.

### A. Execute a Query and Inspect the Trace

* **Endpoint**: `POST /api/analytics/query`
* **Headers**:
  * `Authorization: Bearer $JWT_TOKEN`
  * `x-tenant-id: tenant_A`
  * `Content-Type: application/json`

```bash
curl -X POST http://localhost:4000/api/analytics/query \
  -H "Authorization: Bearer $JWT_TOKEN" \
  -H "x-tenant-id: tenant_A" \
  -H "Content-Type: application/json" \
  -d '{
    "queryConfig": {
      "type": "SELECT",
      "schema": "public",
      "limit": 100,
      "query": {
        "select": ["p.sku", "o.quantity"],
        "from": { "resource": "products", "source": "Fabric_Hub_Postgres", "alias": "p" },
        "joins": [
          {
            "type": "INNER",
            "resource": "orders",
            "source": "Sales_Mongo",
            "alias": "o",
            "on": { "left": "p.id", "operator": "EQ", "right": "o.product_id" }
          }
        ],
        "where": [
          { "column": "p.stock_count", "operator": "GT", "value": 0 }
        ]
      }
    }
  }'
```

### B. Example Response (with Trace Plan)
```json
{
  "data": [
    { "sku": "SKU-100", "quantity": 5 },
    { "sku": "SKU-205", "quantity": 12 }
  ],
  "plan": {
    "strategy": "CROSS_ENGINE",
    "executionMs": 34,
    "rowsScannedAcrossSources": 150,
    "legs": [
      {
        "source": "Fabric_Hub_Postgres",
        "engine": "POSTGRES",
        "operation": "select",
        "query": "SELECT id, sku FROM public.products WHERE stock_count > 0",
        "rowsReturned": 100,
        "ms": 12
      },
      {
        "source": "Sales_Mongo",
        "engine": "MONGODB",
        "operation": "find",
        "query": "db.orders.find({ \"product_id\": { \"$in\": [\"uuid-1\", \"uuid-2\"] } })",
        "rowsReturned": 50,
        "ms": 18
      }
    ]
  }
}
```

---

## 3. Audit Logs

All query operations are cataloged inside the `audit_logs` collection for compliance tracking.

### A. Fetch Audit Logs

* **Endpoint**: `GET /api/audit-logs`
* **Headers**:
  * `Authorization: Bearer $JWT_TOKEN`
  * `x-tenant-id: tenant_A`

```bash
curl -X GET "http://localhost:4000/api/audit-logs?limit=20&action=SELECT" \
  -H "Authorization: Bearer $JWT_TOKEN" \
  -H "x-tenant-id: tenant_A"
```

### B. Example Audit Log Entry
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

## 4. Streaming Query Responses

For large datasets, the Query Engine supports **HTTP chunked transfer encoding**, streaming records as a continuous JSON Lines (`ndjson`) sequence.

* **Endpoint**: `POST /api/analytics/query-stream`
* **Headers**:
  * `Authorization: Bearer $JWT_TOKEN`
  * `x-tenant-id: tenant_A`
  * `Content-Type: application/json`

### Curl Command:
```bash
curl -N -X POST http://localhost:4000/api/analytics/query-stream \
  -H "Authorization: Bearer $JWT_TOKEN" \
  -H "x-tenant-id: tenant_A" \
  -H "Content-Type: application/json" \
  -d '{
    "queryConfig": {
      "type": "SELECT",
      "schema": "public",
      "limit": 50000,
      "query": {
        "select": ["id", "sku", "price"],
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
{"meta": { "rowsStreamed": 50000, "status": "COMPLETED", "executionTimeMs": 1420 }}
```
