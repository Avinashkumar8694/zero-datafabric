# Read (Fetch) API Guide

This document describes how to execute single-resource reads and complex AST queries via the Data Fabric fetch endpoints, complete with executable `curl` commands.

---

## 1. REST Endpoint: `POST /api/data/fetch`

Retrieve rows from a resource with filtering, ordering, projections, and limits.

* **Endpoint**: `POST /api/data/fetch`
* **Headers**:
  * `Authorization: Bearer $JWT_TOKEN`
  * `x-tenant-id: tenant_A`
  * `Content-Type: application/json`

### Curl Command:
```bash
curl -X POST http://localhost:4000/api/data/fetch \
  -H "Authorization: Bearer $JWT_TOKEN" \
  -H "x-tenant-id: tenant_A" \
  -H "Content-Type: application/json" \
  -d '{
    "source": "Fabric_Hub_Postgres",
    "resource": "shipments",
    "columns": ["id", "region", "total_amount", "status"],
    "where": {
      "region": "US",
      "total_amount": { "$gt": 100 }
    },
    "orderBy": [
      { "column": "total_amount", "direction": "DESC" }
    ],
    "limit": 10,
    "offset": 0
  }'
```

---

## 2. AST Query Engine equivalent: `SELECT`

Retrieve federated datasets across connected databases using engine-agnostic query syntax.

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
      "limit": 10,
      "query": {
        "select": ["id", "region", "total_amount", "status"],
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
  }'
```

---

## 3. Native SQL Translation

```sql
-- Compiled PostgreSQL statement executed natively
SELECT "id", "region", "total_amount", "status" 
FROM "public"."shipments" 
WHERE "region" = 'US' 
  AND "total_amount" > 100 
ORDER BY "total_amount" DESC 
LIMIT 10;
```
