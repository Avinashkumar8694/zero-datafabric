# Complex CRUD Integration Guide

This document gathers all advanced and complex CRUD operations supported by the Zero Data Fabric query engine, covering cross-engine transactions, RLS restrictions, full-text searches, and cascading soft-deletes, complete with executable `curl` commands.

---

## 1. Complex Creates (Batch, Constraints & Functions)

Executing batch inserts on tables that utilize custom procedures, functional default generators, and database check constraints.

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
    "data": [
      {
        "region": "US",
        "status": "PENDING",
        "total_amount": 1450.50,
        "metadata": { "priority": "high", "delivery_deadline": "24h" }
      },
      {
        "region": "EU",
        "status": "PENDING",
        "total_amount": 890.00,
        "metadata": { "priority": "normal", "delivery_deadline": "72h" }
      }
    ]
  }'
```

---

## 2. Complex Reads (Bind Joins, Full-Text, Grouping)

Executing multi-datasource bind-joins combined with complex text searches and aggregate groups.

* **Endpoint**: `POST /api/analytics/query`
* **Headers**: Same as above.

### Curl Command:
```bash
curl -X POST http://localhost:4000/api/analytics/query \
  -H "Authorization: Bearer $JWT_TOKEN" \
  -H "x-tenant-id: tenant_A" \
  -H "Content-Type: application/json" \
  -d '{
    "queryConfig": {
      "type": "SELECT",
      "schema": "Global_Supply_Chain",
      "limit": 50,
      "query": {
        "select": [
          "s.region",
          { "aggregate": "SUM", "column": "s.total_amount", "alias": "revenue" }
        ],
        "from": { "resource": "shipments", "source": "Fabric_Hub_Postgres", "alias": "s" },
        "joins": [
          {
            "type": "INNER",
            "resource": "shipment_details",
            "source": "Fabric_Hub_Postgres",
            "alias": "d",
            "on": { "left": "s.id", "operator": "EQ", "right": "d.shipment_id" }
          },
          {
            "type": "INNER",
            "resource": "shipment_audit_logs",
            "source": "Activity_Mongo",
            "alias": "m",
            "on": { "left": "s.id", "operator": "EQ", "right": "m.shipment_id" }
          }
        ],
        "where": [
          {
            "search": {
              "column": "d.notes",
              "type": "FULL_TEXT",
              "query": "priority"
            }
          },
          { "column": "s.status", "operator": "IN", "value": ["PENDING", "IN_TRANSIT"] }
        ],
        "groupBy": ["s.region"]
      }
    }
  }'
```

---

## 3. Complex Updates (Row-Level Security Controls)

Evaluating row-level security isolation during record modifications.

* **Endpoint**: `POST /api/data/update`
* **Headers**: Same as above.

### Curl Command:
```bash
curl -X POST http://localhost:4000/api/data/update \
  -H "Authorization: Bearer $JWT_TOKEN" \
  -H "x-tenant-id: tenant_A" \
  -H "Content-Type: application/json" \
  -d '{
    "source": "Fabric_Hub_Postgres",
    "resource": "shipments",
    "where": {
      "id": "0190a5f2-bbc2-4e95-b20b-6b518e95b25c"
    },
    "data": {
      "status": "DELIVERED"
    }
  }'
```

---

## 4. Complex Deletions (Cascade Soft-Deletes)

Soft deleting rows without violating constraints.

* **Endpoint**: `POST /api/data/delete`
* **Headers**: Same as above.

### Curl Command:
```bash
curl -X POST http://localhost:4000/api/data/delete \
  -H "Authorization: Bearer $JWT_TOKEN" \
  -H "x-tenant-id: tenant_A" \
  -H "Content-Type: application/json" \
  -d '{
    "source": "Fabric_Hub_Postgres",
    "resource": "shipments",
    "where": {
      "status": "CANCELLED"
    }
  }'
```
