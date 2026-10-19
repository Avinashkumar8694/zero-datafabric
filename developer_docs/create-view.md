# How to Create Views & Materialized Views (Scenario Guide)

This guide describes how to define standard and materialized database views in your manifests or DDL requests.

---

## 1. Supported Parameters & Rules

Within your metadata manifest, the view resources support:

* **`type`**: `String` | `'VIEW'` (virtual view computed on read) or `'MATERIALIZED_VIEW'` (physically cached results).
* **`name`**: `String` | Unique view naming qualifier.
* **`refreshStrategy`** (Materialized View): `String` | `'CONCURRENTLY'` (refresh without locking reads) or `'IMMEDIATE'`.
* **`refreshInterval`** (Materialized View): `String` | Automatic scheduler frequency (e.g. `'1 hour'`).
* **`query`**: `Object` | Relational AST query projection defining the view.
* **`indexes`** (Materialized View): `Array` | Unique indices required to run concurrent refreshes.

---

## 2. 10 View Scenarios

To apply any of the manifests below, write the JSON to a file (e.g., `manifest.json`) and run the metadata apply API call:

* **API Endpoint**: `POST /api/metadata/apply`
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

---

### Scenario 1: Standard Query View
* **Description**: Create a virtual filter listing active US shipments.
* **Manifest JSON**:
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
* **Compiled Database SQL**:
```sql
CREATE VIEW "public"."active_us_shipments" AS
SELECT "id", "region", "total_amount" FROM "public"."shipments" WHERE "region" = 'US' AND "deleted_at" IS NULL;
```

---

### Scenario 2: Joined Multi-Table View
* **Description**: Join shipments with shipment details to display combined logistics status.
* **Manifest JSON**:
```json
{
  "type": "VIEW",
  "name": "detailed_shipment_view",
  "query": {
    "select": ["s.id", "s.region", "d.notes"],
    "from": { "resource": "shipments", "alias": "s" },
    "joins": [
      {
        "type": "INNER",
        "resource": "shipment_details",
        "alias": "d",
        "on": { "left": "s.id", "operator": "EQ", "right": "d.shipment_id" }
      }
    ]
  }
}
```
* **Compiled Database SQL**:
```sql
CREATE VIEW "public"."detailed_shipment_view" AS
SELECT s.id, s.region, d.notes FROM "public"."shipments" s INNER JOIN "public"."shipment_details" d ON s.id = d.shipment_id;
```

---

### Scenario 3: Grouped Aggregate View
* **Description**: Pre-calculate total revenues grouped by location regions.
* **Manifest JSON**:
```json
{
  "type": "VIEW",
  "name": "regional_revenue_summary",
  "query": {
    "select": [
      "region",
      { "aggregate": "SUM", "column": "total_amount", "alias": "total_revenue" }
    ],
    "from": { "resource": "shipments" },
    "groupBy": ["region"]
  }
}
```
* **Compiled Database SQL**:
```sql
CREATE VIEW "public"."regional_revenue_summary" AS
SELECT "region", SUM("total_amount") AS "total_revenue" FROM "public"."shipments" GROUP BY "region";
```

---

### Scenario 4: Materialized View for Concurrent Refresh
* **Description**: Cache data physically and support non-blocking background updates.
* **Manifest JSON**:
```json
{
  "type": "MATERIALIZED_VIEW",
  "name": "cached_volume_stats",
  "refreshStrategy": "CONCURRENTLY",
  "refreshInterval": "1 hour",
  "query": {
    "select": [
      "region",
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
* **Compiled Database SQL**:
```sql
CREATE MATERIALIZED VIEW "public"."cached_volume_stats" AS
SELECT "region", COUNT(*) AS "volume" FROM "public"."shipments" GROUP BY "region";

CREATE UNIQUE INDEX cached_volume_stats_region_idx ON "public"."cached_volume_stats" (region);
```

---

### Scenario 5: Daily Summary Materialized View
* **Description**: Physically cache aggregated daily sales volumes.
* **Manifest JSON**:
```json
{
  "type": "MATERIALIZED_VIEW",
  "name": "daily_sales_cache",
  "query": {
    "select": [
      "created_at",
      { "aggregate": "SUM", "column": "total_amount", "alias": "daily_amount" }
    ],
    "from": { "resource": "shipments" },
    "groupBy": ["created_at"]
  }
}
```
* **Compiled Database SQL**:
```sql
CREATE MATERIALIZED VIEW "public"."daily_sales_cache" AS
SELECT "created_at", SUM("total_amount") AS "daily_amount" FROM "public"."shipments" GROUP BY "created_at";
```

---

### Scenario 6: Virtual Federated Cross-Source View
* **Description**: Unify local Postgres inventory tables and remote MySQL warehouse tables.
* **Manifest JSON**:
```json
{
  "type": "VIEW",
  "name": "global_stock_view",
  "federationStrategy": "VIRTUAL",
  "query": {
    "union": [
      {
        "select": ["sku", "stock"],
        "from": { "resource": "local_inventory", "source": "Fabric_Hub_Postgres" }
      },
      {
        "select": ["item_sku", "quantity"],
        "from": { "resource": "mysql_stock", "source": "Warehouse_MySQL" }
      }
    ]
  }
}
```
* **Compiled Database SQL**:
```sql
-- Queried virtually by the coordinator. Legs are fetched independently from:
-- Leg 1: SELECT sku, stock FROM public.local_inventory;
-- Leg 2: SELECT item_sku, quantity FROM warehouse.mysql_stock;
-- Resulting lists are merged in-memory.
```

---

### Scenario 7: RLS-Filtered View
* **Description**: Create views whose outputs filter automatically based on active user tenant contexts.
* **Manifest JSON**:
```json
{
  "type": "VIEW",
  "name": "tenant_orders_view",
  "query": {
    "select": ["id", "tenant_id", "amount"],
    "from": { "resource": "orders" },
    "where": [
      { "column": "tenant_id", "operator": "EQ", "value": "current_setting('\''app.current_tenant_id'\'')" }
    ]
  }
}
```
* **Compiled Database SQL**:
```sql
CREATE VIEW "public"."tenant_orders_view" AS
SELECT "id", "tenant_id", "amount" FROM "public"."orders" WHERE "tenant_id" = current_setting('app.current_tenant_id');
```

---

### Scenario 8: Column-Masked View
* **Description**: Create views that redact PII variables natively.
* **Manifest JSON**:
```json
{
  "type": "VIEW",
  "name": "public_users_view",
  "query": {
    "select": [
      "id",
      { "expression": "'\''REDACTED'\''", "alias": "email" }
    ],
    "from": { "resource": "users" }
  }
}
```
* **Compiled Database SQL**:
```sql
CREATE VIEW "public"."public_users_view" AS
SELECT "id", 'REDACTED' AS "email" FROM "public"."users";
```

---

### Scenario 9: Sub-Query Filtered View
* **Description**: Filter views utilizing nested sub-query variables.
* **Manifest JSON**:
```json
{
  "type": "VIEW",
  "name": "large_shipments_view",
  "query": {
    "select": ["id", "region", "total_amount"],
    "from": { "resource": "shipments" },
    "where": [
      { "column": "total_amount", "operator": "GT", "value": 500 }
    ]
  }
}
```
* **Compiled Database SQL**:
```sql
CREATE VIEW "public"."large_shipments_view" AS
SELECT "id", "region", "total_amount" FROM "public"."shipments" WHERE "total_amount" > 500;
```

---

### Scenario 10: Window Ranked View
* **Description**: Create views listing ranked products in categories.
* **Manifest JSON**:
```json
{
  "type": "VIEW",
  "name": "ranked_products_view",
  "query": {
    "select": [
      "category",
      "price",
      {
        "window": "RANK",
        "partitionBy": ["category"],
        "orderBy": [{ "column": "price", "direction": "DESC" }],
        "alias": "price_rank"
      }
    ],
    "from": { "resource": "products" }
  }
}
```
* **Compiled Database SQL**:
```sql
CREATE VIEW "public"."ranked_products_view" AS
SELECT "category", "price", RANK() OVER (PARTITION BY "category" ORDER BY "price" DESC) as "price_rank" FROM "public"."products";
```
---

## 3. Refreshing Materialized Views (API Call)

* **API Endpoint**: `POST /api/analytics/refresh-view`
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
    "viewName": "cached_volume_stats"
  }'
```
