# Create (Insert) API Guide

This document describes how to execute single and batch record insertions via the Data Fabric Create API.

---

## 1. REST Endpoint: `POST /api/data/create`

Insert one or many rows into a target resource.

```bash
curl -X POST http://localhost:4000/api/data/create \
  -H "Authorization: Bearer $JWT_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "source": "Fabric_Hub_Postgres",
    "resource": "shipments",
    "data": {
      "region": "US",
      "status": "PENDING",
      "total_amount": 450.00
    }
  }'
```

### JSON Fields reference:
* **`source`**: `String` | Target registered datasource connection.
* **`resource`**: `String` | Target table or collection name.
* **`data`**: `Object` | Column-value mappings of the row to insert.

---

## 2. Batch Creation (Multi-row Insertions)

To perform bulk inserts, pass a JSON **array** of objects inside the `data` parameter:

```json
{
  "source": "Fabric_Hub_Postgres",
  "resource": "shipments",
  "data": [
    { "region": "US", "status": "PENDING", "total_amount": 120.0 },
    { "region": "EU", "status": "PENDING", "total_amount": 250.0 }
  ]
}
```

---

## 3. AST Query Equivalent: `INSERT`

Alternatively, submit a structured AST query block to `POST /api/analytics/query`:

```json
{
  "queryConfig": {
    "type": "INSERT",
    "schema": "Global_Supply_Chain",
    "query": {
      "into": { "resource": "shipments", "source": "Fabric_Hub_Postgres" },
      "columns": ["region", "status", "total_amount"],
      "values": [
        ["US", "PENDING", 120.0],
        ["EU", "PENDING", 250.0]
      ]
    }
  }
}
```

---

## 4. Native SQL Translation

The orchestrator compiles the AST or REST request into target dialect instructions executed on the database source:

```sql
-- Compiled PostgreSQL statement
INSERT INTO "public"."shipments" ("region", "status", "total_amount")
VALUES ('US', 'PENDING', 120.0), ('EU', 'PENDING', 250.0)
RETURNING *;
```
