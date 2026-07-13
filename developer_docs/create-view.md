# How to Create Views & Materialized Views

This guide describes how to define standard and materialized database views in your manifests or DDL requests.

---

## 1. Defining Views in Manifest

Add view configurations containing relational query ASTs inside a schema block:

### A. Standard View Definition
```json
{
  "type": "VIEW",
  "name": "active_us_shipments",
  "query": {
    "select": ["id", "region", "total_amount"],
    "from": { "resource": "shipments" },
    "where": [
      { "column": "region", "operator": "EQ", "value": "US" },
      { "column": "deleted_at", "operator": "IS_NULL" }
    ]
  }
}
```

### B. Materialized View Definition
Materialized views cache results physically and support automatic refresh intervals.
```json
{
  "type": "MATERIALIZED_VIEW",
  "name": "regional_volume_stats",
  "refreshStrategy": "CONCURRENTLY",
  "refreshInterval": "1 hour",
  "query": {
    "select": [
      { "column": "region" },
      { "aggregate": "COUNT", "alias": "volume" }
    ],
    "from": { "resource": "shipments" },
    "groupBy": ["region"]
  },
  "indexes": [
    {
      "columns": ["region"],
      "unique": true
    }
  ]
}
```

---

## 2. API Endpoints

### Option A: Metadata Apply (Via Manifest)
Submit the manifest block (`manifest.json`):

* **Endpoint**: `POST /api/metadata/apply`
* **Headers**:
  * `Authorization: Bearer $JWT_TOKEN`
  * `x-tenant-id: tenant_A`
  * `Content-Type: multipart/form-data`

```bash
curl -X POST http://localhost:4000/api/metadata/apply \
  -H "Authorization: Bearer $JWT_TOKEN" \
  -H "x-tenant-id: tenant_A" \
  -F "file=@manifest.json"
```

### Option B: Trigger Background Refresh for Materialized Views
Kick off a background refresh task without blocking the connection:

* **Endpoint**: `POST /api/analytics/refresh-view`
* **Headers**:
  * `Authorization: Bearer $JWT_TOKEN`
  * `x-tenant-id: tenant_A`
  * `Content-Type: application/json`

```bash
curl -X POST http://localhost:4000/api/analytics/refresh-view \
  -H "Authorization: Bearer $JWT_TOKEN" \
  -H "x-tenant-id: tenant_A" \
  -H "Content-Type: application/json" \
  -d '{
    "viewName": "regional_volume_stats"
  }'
```

---

## 3. Compiled Database Commands (Postgres)

```sql
-- Standard View
CREATE VIEW "public"."active_us_shipments" AS
  SELECT "id", "region", "total_amount" 
  FROM "public"."shipments" 
  WHERE "region" = 'US' AND "deleted_at" IS NULL;

-- Materialized View
CREATE MATERIALIZED VIEW "public"."regional_volume_stats" AS
  SELECT "region", COUNT(*) AS "volume" 
  FROM "public"."shipments" 
  GROUP BY "region";

-- Index for concurrent refreshes
CREATE UNIQUE INDEX regional_volume_stats_region_idx 
  ON "public"."regional_volume_stats" (region);
```
