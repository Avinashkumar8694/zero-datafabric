# Delete API Guide

This document describes how to execute record deletions via the Data Fabric delete endpoints, complete with executable `curl` commands.

---

## 1. REST Endpoint: `POST /api/data/delete`

Delete rows matching a predicate filter.

* **Endpoint**: `POST /api/data/delete`
* **Headers**:
  * `Authorization: Bearer $JWT_TOKEN`
  * `x-tenant-id: tenant_A`
  * `Content-Type: application/json`

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

> [!IMPORTANT]
> The `where` filter object is **mandatory** for all delete requests to prevent accidental deletion of entire datasets.

---

## 2. AST Query Engine equivalent: `DELETE`

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
      "type": "DELETE",
      "schema": "Global_Supply_Chain",
      "query": {
        "target": { "resource": "shipments", "source": "Fabric_Hub_Postgres" },
        "where": [
          { "column": "status", "operator": "EQ", "value": "CANCELLED" }
        ]
      }
    }
  }'
```

---

## 3. Soft-Delete Configurations

If the target table has been provisioned with the `SOFT_DELETE` strategy inside the metadata manifest, deletions do not perform physical row drops. Instead, the fabric compiles the query to set the deletion timestamp:

```sql
-- Compiled soft-deletion statement
UPDATE "public"."shipments" 
SET "deleted_at" = NOW() 
WHERE "status" = 'CANCELLED';
```

If a resource does not configure soft-deletes, a physical delete is performed:

```sql
-- Compiled physical delete
DELETE FROM "public"."shipments" 
WHERE "status" = 'CANCELLED';
```
