# Read (Fetch) API Guide

This document describes how to perform data retrieval, projections, filters, and joins via the Data Fabric Read API.

---

## 1. REST Endpoint: `POST /api/data/fetch`

Retrieve rows from a resource with filtering, ordering, and limits.

```bash
curl -X POST http://localhost:4000/api/data/fetch \
  -H "Authorization: Bearer $JWT_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "source": "Fabric_Hub_Postgres",
    "resource": "shipments",
    "columns": ["id", "region", "total_amount"],
    "where": {
      "region": "US",
      "total_amount": { "$gt": 100 }
    },
    "orderBy": [
      { "column": "total_amount", "direction": "DESC" }
    ],
    "limit": 10
  }'
```

### JSON Fields reference:
* **`source`**: `String` | Registered connection source.
* **`resource`**: `String` | Target table/collection.
* **`columns`**: `Array` | Fields to project (defaults to `["*"]`).
* **`where`**: `Object` | Operator filters mapping (`$eq`, `$ne`, `$gt`, `$gte`, `$lt`, `$lte`, `$like`, `$ilike`, `$in`).
* **`orderBy`**: `Array` | Sorting configurations.
* **`limit`** / **`offset`**: `Integer` | Pagination caps.

---

## 2. AST Query Equivalent: `SELECT`

The relational AST matches the structure below:

```json
{
  "queryConfig": {
    "type": "SELECT",
    "schema": "Global_Supply_Chain",
    "limit": 10,
    "query": {
      "select": ["id", "region", "total_amount"],
      "from": { "resource": "shipments", "source": "Fabric_Hub_Postgres" },
      "where": [
        { "column": "region", "operator": "EQ", "value": "US" },
        { "column": "total_amount", "operator": "GT", "value": 100 }
      ],
      "orderBy": [
        { "column": "total_amount", "direction": "DESC" }
      ]
    }
  }
}
```

---

## 3. Native SQL Translation

```sql
-- Compiled PostgreSQL statement
SELECT "id", "region", "total_amount" 
FROM "public"."shipments" 
WHERE "region" = 'US' AND "total_amount" > 100 
ORDER BY "total_amount" DESC 
LIMIT 10;
```
