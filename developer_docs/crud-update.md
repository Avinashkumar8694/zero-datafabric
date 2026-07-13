# Update API Guide

This document describes how to execute record updates with predicates via the Data Fabric Update API.

---

## 1. REST Endpoint: `POST /api/data/update`

Modify values in columns for rows matching a predicate filter.

```bash
curl -X POST http://localhost:4000/api/data/update \
  -H "Authorization: Bearer $JWT_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "source": "Fabric_Hub_Postgres",
    "resource": "shipments",
    "where": {
      "id": "0190a5f2-bbc2-4e95-b20b-6b518e95b25c"
    },
    "data": {
      "status": "IN_TRANSIT"
    }
  }'
```

> [!IMPORTANT]
> The `where` object is **mandatory** for all update requests to prevent unintentional updates across the entire table.

---

## 2. AST Query Equivalent: `UPDATE`

Submit updates using AST format:

```json
{
  "queryConfig": {
    "type": "UPDATE",
    "schema": "Global_Supply_Chain",
    "query": {
      "target": { "resource": "shipments", "source": "Fabric_Hub_Postgres" },
      "set": {
        "status": "IN_TRANSIT"
      },
      "where": [
        { "column": "id", "operator": "EQ", "value": "0190a5f2-bbc2-4e95-b20b-6b518e95b25c" }
      ]
    }
  }
}
```

---

## 3. Native SQL Translation

```sql
-- Compiled PostgreSQL statement
UPDATE "public"."shipments" 
SET "status" = 'IN_TRANSIT' 
WHERE "id" = '0190a5f2-bbc2-4e95-b20b-6b518e95b25c';
```
