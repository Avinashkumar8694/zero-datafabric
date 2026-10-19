# AST & SQL Queries Cookbook

This document is a comprehensive compilation of all query operations used across the Zero Data Fabric codebase, demonstrating the exact JSON AST constructs and native translations for every example scenario.

---

## 1. Multi-Datasource Queries

Querying distinct databases individually or routing specific operations depending on the dataset location.

### Example: PostgreSQL Direct Table Read
Querying primary user directories on the Postgres Hub.

```json
{
  "queryConfig": {
    "type": "SELECT",
    "schema": "public",
    "limit": 10,
    "query": {
      "select": ["id", "name", "email"],
      "from": { "resource": "users", "source": "Fabric_Hub_Postgres" }
    }
  }
}
```

### Example: MongoDB Audit Fetch
Querying audit activity records from MongoDB. Note that MongoDB documents are parsed back as relational records automatically.

```json
{
  "queryConfig": {
    "type": "SELECT",
    "schema": "Activity_Logs",
    "limit": 5,
    "query": {
      "select": ["user_id", "action", "timestamp"],
      "from": { "resource": "user_activity", "source": "Activity_Mongo" }
    }
  }
}
```

---

## 2. Federated Cross-Engine Joins

The query planner maps cross-source joins using an optimized **bind-join** strategy: it fetches keys from the driver table first, then streams them in optimized batches (using `$in` or `IN (...)` arrays) to query the target datasource.

### Example: Postgres Hub `users` joined with MongoDB `user_activity`
Retrieve users and matching document activities across relational and NoSQL engines.

```json
{
  "queryConfig": {
    "type": "SELECT",
    "schema": "public",
    "limit": 50,
    "query": {
      "select": ["u.name", "u.email", "a.action", "a.timestamp"],
      "from": { "resource": "users", "source": "Fabric_Hub_Postgres", "alias": "u" },
      "joins": [
        {
          "type": "INNER",
          "resource": "user_activity",
          "source": "Activity_Mongo",
          "alias": "a",
          "on": { "left": "u.id", "operator": "EQ", "right": "a.user_id" }
        }
      ]
    }
  }
}
```

---

## 3. Set Operations (Union, Intersect, Except)

Combine independent sub-queries targeting completely different database engines in a single virtual view.

### Example: Cross-Engine Intersection (Postgres ∩ MongoDB)
Retrieve only users who have both ordered (stored in PostgreSQL) and completed active browsing events (stored in MongoDB).

```json
{
  "queryConfig": {
    "type": "SELECT",
    "schema": "public",
    "query": {
      "intersect": [
        {
          "select": ["customer_id"],
          "from": { "resource": "orders", "source": "Fabric_Hub_Postgres" }
        },
        {
          "select": ["customer_id"],
          "from": { "resource": "web_events", "source": "Web_Analytics_Mongo" }
        }
      ]
    }
  }
}
```

### Example: Cross-Engine Union (Postgres ∪ MySQL)
Unify regional sales tables from US (Postgres) and EU (MySQL) into a single virtual transaction query.

```json
{
  "queryConfig": {
    "type": "SELECT",
    "schema": "public",
    "query": {
      "union": [
        {
          "select": ["id", "amount", "currency"],
          "from": { "resource": "sales_us", "source": "US_Postgres" }
        },
        {
          "select": ["id", "amount", "currency"],
          "from": { "resource": "sales_eu", "source": "EU_MySQL" }
        }
      ]
    }
  }
}
```

---

## 4. Complex Aggregations & Grouping

Aggregations are pushed down to the physical sources as native `GROUP BY` (SQL) or `$group` (MongoDB) blocks. The coordinator then merges group aggregates in-memory.

### Example: Grouped Sales Revenue
Group orders by category, calculating row count, sum, and average values.

```json
{
  "queryConfig": {
    "type": "SELECT",
    "schema": "public",
    "query": {
      "from": { "resource": "orders", "source": "Fabric_Hub_Postgres" },
      "groupBy": ["category"],
      "select": [
        "category",
        { "aggregate": "COUNT", "column": "*", "alias": "count_sales" },
        { "aggregate": "SUM", "column": "amount", "alias": "total_revenue" },
        { "aggregate": "AVG", "column": "amount", "alias": "avg_order_value" }
      ]
    }
  }
}
```

---

## 5. Window Functions & Rankings

Generate partitioned sequences and ranks dynamically within records.

### Example: High-Value Product Ranks
Retrieve products ranked by price inside their categories.

```json
{
  "queryConfig": {
    "type": "SELECT",
    "schema": "public",
    "query": {
      "select": [
        "category",
        "price",
        {
          "window": "RANK",
          "partitionBy": ["category"],
          "orderBy": [{ "column": "price", "direction": "DESC" }],
          "alias": "rank_in_category"
        }
      ],
      "from": { "resource": "products" }
    }
  }
}
```
