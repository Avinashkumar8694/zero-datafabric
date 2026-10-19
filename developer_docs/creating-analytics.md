# Creating Analytics & Custom Dashboard Widgets

This document guides developers on how to design, register, and render custom analytics widgets and saved queries for the Data Fabric **Analytics Dashboard** page.

---

## 1. Overview: How Dashboard Analytics Work

The Data Fabric Analytics page dynamically polls and displays structured metrics. By utilizing the **Saved Analytics API**, developers can register parameterized queries (relational JSON ASTs; raw SQL is not supported) once and run them on the fly from the frontend dashboard by passing runtime variables.

Each saved widget automatically:
* Benefits from the Query Planner's federated query routing.
* Inherits Row Level Security (RLS) and column masking policies.
* Generates granular trace spans that populate the Audit log system.
* Increments query counters to track popular analytics for quick-access cards.

---

## 2. Dynamic Variable Bindings (`{{variable}}`)

Saved analytics queries support custom placeholders using double curly braces (e.g. `{{region}}`). 

The query planner replaces the placeholder with the safely parsed, typed value (e.g., number tokens are kept as numbers to prevent schema conversion failures), and the bound AST runs through the parameterized pushdown path.

---

## 3. Step-by-Step Guide to Registering Analytics

### Step 1: Declare the Metric Query
Build the metric as an AST (`mode: "AST"`): engine-agnostic, handles multi-datasource federation, and supports `window` select items and `recursive` traversal (see [recursive-and-window-queries.md](recursive-and-window-queries.md)). SQL-mode saved analytics are rejected with `SQL_NOT_SUPPORTED`.

### Step 2: Define Runtime Variables
Provide variable maps with standard configuration properties:
```json
"variables": [
  { "name": "region", "type": "string", "required": true },
  { "name": "row_limit", "type": "number", "default": 10 }
]
```

### Step 3: Register via API

* **Endpoint**: `POST /api/saved-analytics`
* **Headers**:
  * `Authorization: Bearer $JWT_TOKEN`
  * `x-tenant-id: tenant_A`
  * `Content-Type: application/json`

#### Example Request: AST Mode Widget
Create a regional sales dashboard widget tracking categories:

```bash
curl -X POST http://localhost:4000/api/saved-analytics \
  -H "Authorization: Bearer $JWT_TOKEN" \
  -H "Content-Type: application/json" \
  -H "x-tenant-id: tenant_A" \
  -d '{
    "name": "regional_sales_revenue",
    "description": "Calculates category revenue rankings filtered by regional sales",
    "mode": "AST",
    "variables": [
      { "name": "region", "type": "string", "required": true },
      { "name": "row_limit", "type": "number", "default": 5 }
    ],
    "config": {
      "type": "SELECT",
      "schema": "public",
      "limit": "{{row_limit}}",
      "query": {
        "from": { "resource": "orders", "source": "US_Postgres" },
        "groupBy": ["category"],
        "select": [
          "category",
          { "aggregate": "SUM", "column": "total_amount", "alias": "revenue" }
        ],
        "where": [
          { "column": "region", "operator": "EQ", "value": "{{region}}" }
        ],
        "orderBy": [{ "column": "revenue", "direction": "DESC" }]
      }
    }
  }'
```

#### Example Request: Threshold-filtered Widget
Create a revenue-by-category chart filtered by a numeric threshold variable:

```bash
curl -X POST http://localhost:4000/api/saved-analytics \
  -H "Authorization: Bearer $JWT_TOKEN" \
  -H "Content-Type: application/json" \
  -H "x-tenant-id: tenant_A" \
  -d '{
    "name": "revenue_by_category",
    "description": "Revenue per category above a minimum order amount at the US source",
    "mode": "AST",
    "variables": [
      { "name": "min_amount", "type": "number", "required": true }
    ],
    "config": {
      "type": "SELECT",
      "schema": "public",
      "limit": 100,
      "query": {
        "from": { "resource": "orders", "source": "US_Postgres" },
        "where": [ { "column": "total_amount", "operator": "GTE", "value": "{{min_amount}}" } ],
        "groupBy": ["category"],
        "select": [
          "category",
          { "aggregate": "SUM", "column": "total_amount", "alias": "revenue" }
        ],
        "orderBy": [{ "column": "revenue", "direction": "DESC" }]
      }
    }
  }'
```

---

## 4. How to Execute Saved Analytics

To execute the registered analytical metrics from the frontend client, post the inputs payload to the run endpoint:

* **Endpoint**: `POST /api/saved-analytics/:id/run`
* **Headers**:
  * `Authorization: Bearer $JWT_TOKEN`
  * `Content-Type: application/json`

```bash
curl -X POST http://localhost:4000/api/saved-analytics/12c3d4/run \
  -H "Authorization: Bearer $JWT_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "inputs": {
      "region": "US",
      "row_limit": 10
    }
  }'
```

---

## 5. UI Integration Map

To render the widgets on your dashboard screen, fetch the analytics registry payload from `GET /api/saved-analytics`. The response contains:

* **`runCount`**: Used to order top-run metrics for primary display.
* **`variables`**: Renders dynamic forms (inputs, number fields) inside the UI configuration overlays automatically.
* **`data` Array**: Binds to chart frameworks (e.g. Chart.js, Recharts, or CSS grid progress bars) to display tabular summaries.
