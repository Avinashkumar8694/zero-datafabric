# Polyglot Relational Integration (Postgres, Mongo, ES, MySQL, Oracle)

This document is a comprehensive guide to query routing, federation, and dialect compilation across different database engines (PostgreSQL, MongoDB, Elasticsearch, MySQL, and Oracle DB) under the Zero Data Fabric.

---

## 1. Engine Namespace & Schema Resolution

| Database Engine | Namespace Structure | Datafabric Logical Mapping | AST Target Property |
|:---|:---|:---|:---|
| **PostgreSQL** | `database.schema.table` | Schema-aware mapping | `"schema": "logical_schema"`, `"resource": "table"` |
| **MySQL** | `database.table` | Single logical namespace | `"resource": "table"` |
| **Oracle DB** | `schema.table` | User/Schema-aware mapping | `"resource": "table"` |
| **MongoDB** | `database.collection` | Schema-less collection mapping | `"resource": "collection"` |
| **Elasticsearch** | `index` | Search document index | `"resource": "index"` |

---

## 2. Master Polyglot Query Scenarios

---

### Scenario A: Complex Bind-Join (Oracle DB ⋈ MongoDB ⋈ PostgreSQL)
Join Oracle warehouse products with MongoDB customer events logs and PostgreSQL local user records.

#### The Goal:
Retrieve orders where the customer is active in PostgreSQL, the event activity is logged in MongoDB, and the catalog price is retrieved from Oracle DB.

#### Relational AST Query:
```json
{
  "queryConfig": {
    "type": "SELECT",
    "schema": "public",
    "limit": 100,
    "query": {
      "select": [
        "u.name",
        "u.email",
        "m.event_name",
        "o.product_name",
        "o.price"
      ],
      "from": { "resource": "users", "source": "Fabric_Hub_Postgres", "alias": "u" },
      "joins": [
        {
          "type": "INNER",
          "resource": "web_events",
          "source": "Web_Analytics_Mongo",
          "alias": "m",
          "on": { "left": "u.id", "operator": "EQ", "right": "m.user_id" }
        },
        {
          "type": "INNER",
          "resource": "catalog_products",
          "source": "Oracle_ERP",
          "alias": "o",
          "on": { "left": "m.product_sku", "operator": "EQ", "right": "o.sku" }
        }
      ],
      "where": [
        { "column": "u.status", "operator": "EQ", "value": "ACTIVE" }
      ]
    }
  }
}
```

#### Compiled Step-by-Step Executions:
1. **Query PostgreSQL (Driver)**:
   ```sql
   SELECT id, name, email FROM public.users WHERE status = 'ACTIVE';
   ```
2. **Query MongoDB (Second Leg)**:
   Filters event logs matching the retrieved user IDs:
   ```json
   db.web_events.find({ "user_id": { "$in": ["0190a5f2...", "0190a8a1..."] } })
   ```
3. **Query Oracle DB (Third Leg)**:
   Filters catalog pricing records matching the collected product SKUs:
   ```sql
   SELECT sku, product_name, price FROM RETAIL.catalog_products WHERE sku IN ('SKU-100', 'SKU-205', 'SKU-409');
   ```
4. **Federated Merge**:
   The coordinator links keys in-memory and returns the unified records.

---

### Scenario B: Multi-Source Aggregations (MySQL ∪ Oracle DB)
Compute total sales partitioned by category running on MySQL and Oracle DB in parallel.

#### Relational AST Query:
```json
{
  "queryConfig": {
    "type": "SELECT",
    "schema": "public",
    "query": {
      "union": [
        {
          "from": { "resource": "sales_historical", "source": "MySQL_Archive" },
          "groupBy": ["category"],
          "select": ["category", { "aggregate": "SUM", "column": "amount", "alias": "total" }]
        },
        {
          "from": { "resource": "sales_live", "source": "Oracle_ERP" },
          "groupBy": ["category"],
          "select": ["category", { "aggregate": "SUM", "column": "amount", "alias": "total" }]
        }
      ]
    }
  }
}
```

#### Compiled Database Actions:
* **MySQL Execution**:
  ```sql
  SELECT category, SUM(amount) AS total FROM warehouse.sales_historical GROUP BY category;
  ```
* **Oracle DB Execution**:
  ```sql
  SELECT category, SUM(amount) AS total FROM LIVE.sales_live GROUP BY category;
  ```

---

### Scenario C: Hierarchical Organization Chart (PostgreSQL CTE)
Trace nested employee hierarchies recursively (PostgreSQL-specific).

#### Relational AST Query:
```json
{
  "queryConfig": {
    "type": "SELECT",
    "schema": "public",
    "query": {
      "with": [
        {
          "name": "org_tree",
          "columns": ["id", "name", "manager_id", "level"],
          "base": {
            "select": ["id", "name", "manager_id", { "expression": "1", "alias": "level" }],
            "from": { "resource": "employees", "source": "Fabric_Hub_Postgres" },
            "where": [{ "column": "manager_id", "operator": "IS_NULL" }]
          },
          "unionAll": {
            "select": ["e.id", "e.name", "e.manager_id", { "expression": "ot.level + 1" }],
            "from": { "resource": "employees", "source": "Fabric_Hub_Postgres", "alias": "e" },
            "joins": [
              {
                "type": "INNER",
                "resource": "org_tree",
                "alias": "ot",
                "on": { "left": "e.manager_id", "operator": "EQ", "right": "ot.id" }
              }
            ]
          }
        }
      ],
      "select": ["*"],
      "from": { "resource": "org_tree" }
    }
  }
}
```

#### Compiled Database Action:
```sql
WITH RECURSIVE org_tree(id, name, manager_id, level) AS (
  SELECT id, name, manager_id, 1 AS level FROM public.employees WHERE manager_id IS NULL
  UNION ALL
  SELECT e.id, e.name, e.manager_id, ot.level + 1 FROM public.employees e
  INNER JOIN org_tree ot ON e.manager_id = ot.id
)
SELECT * FROM org_tree;
```

---

### Scenario D: Text Search (Elasticsearch Index Query)
Hit Elasticsearch search engines directly to query structured log records.

#### Relational AST Query:
```json
{
  "queryConfig": {
    "type": "SELECT",
    "schema": "public",
    "limit": 20,
    "query": {
      "select": ["id", "log_level", "message"],
      "from": { "resource": "system_logs", "source": "Log_Elasticsearch" },
      "where": [
        { "column": "log_level", "operator": "EQ", "value": "ERROR" },
        {
          "search": {
            "column": "message",
            "type": "FULL_TEXT",
            "query": "out of memory"
          }
        }
      ]
    }
  }
}
```

#### Compiled Elasticsearch DSL:
```json
{
  "query": {
    "bool": {
      "must": [
        { "term": { "log_level.keyword": "ERROR" } },
        { "match": { "message": "out of memory" } }
      ]
    }
  },
  "size": 20
}
```

---

### Scenario E: Procedural PL/SQL calls (Oracle DB Function)
Invoke custom procedures registered on Oracle Database.

#### Relational AST Query:
```json
{
  "queryConfig": {
    "type": "CALL",
    "schema": "public",
    "query": {
      "procedure": "process_inventory_audit",
      "source": "Oracle_ERP",
      "arguments": [
        { "name": "p_store_id", "type": "NUMBER", "value": 501 }
      ]
    }
  }
}
```

#### Compiled Oracle PL/SQL Action:
```sql
DECLARE
  v_store_id NUMBER := 501;
BEGIN
  RETAIL.process_inventory_audit(p_store_id => v_store_id);
END;
```
