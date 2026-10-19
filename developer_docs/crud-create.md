# Create (Insert) API Guide

This document describes how to execute single and batch record insertions via the Data Fabric Create API and AST Query Engine, complete with executable `curl` commands.

---

## 1. REST Endpoint: Single Record Create

* **Endpoint**: `POST /api/data/create`
* **Headers**:
  * `Authorization: Bearer $JWT_TOKEN`
  * `x-tenant-id: tenant_A`
  * `Content-Type: application/json`

### Curl Command:
```bash
curl -X POST http://localhost:4000/api/data/create \
  -H "Authorization: Bearer $JWT_TOKEN" \
  -H "x-tenant-id: tenant_A" \
  -H "Content-Type: application/json" \
  -d '{
    "source": "Fabric_Hub_Postgres",
    "resource": "shipments",
    "data": {
      "region": "US",
      "status": "PENDING",
      "total_amount": 450.00,
      "metadata": {
        "priority": "high",
        "notes": "Verify loading dock schedule before dispatch"
      }
    }
  }'
```

---

## 2. REST Endpoint: Batch (Bulk) Record Create

* **Endpoint**: `POST /api/data/create`
* **Headers**: Same as single create.

### Curl Command:
```bash
curl -X POST http://localhost:4000/api/data/create \
  -H "Authorization: Bearer $JWT_TOKEN" \
  -H "x-tenant-id: tenant_A" \
  -H "Content-Type: application/json" \
  -d '{
    "source": "Fabric_Hub_Postgres",
    "resource": "shipments",
    "data": [
      {
        "region": "US",
        "status": "PENDING",
        "total_amount": 120.00,
        "metadata": { "priority": "normal" }
      },
      {
        "region": "EU",
        "status": "PENDING",
        "total_amount": 250.50,
        "metadata": { "priority": "urgent" }
      }
    ]
  }'
```

---

## 3. AST Query Engine equivalent: `INSERT`

* **Endpoint**: `POST /api/analytics/query` (or `POST /api/queries/engine`)
* **Headers**: Same as above.

### Curl Command:
```bash
curl -X POST http://localhost:4000/api/analytics/query \
  -H "Authorization: Bearer $JWT_TOKEN" \
  -H "x-tenant-id: tenant_A" \
  -H "Content-Type: application/json" \
  -d '{
    "queryConfig": {
      "type": "INSERT",
      "schema": "Global_Supply_Chain",
      "query": {
        "into": { "resource": "shipments", "source": "Fabric_Hub_Postgres" },
        "columns": ["region", "status", "total_amount", "metadata"],
        "values": [
          ["US", "PENDING", 120.00, { "priority": "normal" }],
          ["EU", "PENDING", 250.50, { "priority": "urgent" }]
        ]
      }
    }
  }'
```

---

## 4. Native SQL Translation

The orchestrator compiles the request into target dialect instructions executed on the database source:

```sql
-- Compiled PostgreSQL statement executed under Citus Hub
INSERT INTO "public"."shipments" ("region", "status", "total_amount", "metadata")
VALUES 
  ('US', 'PENDING', 120.00, '{"priority":"normal"}'), 
  ('EU', 'PENDING', 250.50, '{"priority":"urgent"}')
RETURNING *;
```
