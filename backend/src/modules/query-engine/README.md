# Query Engine Module (Module 2)

The **Advanced Query Engine** provides scalable, high-performance data retrieval across diverse sources (SQL and NoSQL). It uses PostgreSQL's Foreign Data Wrappers (FDW) for unified querying and Citus for distributed computing.

## Features

- **Distributed Querying**: Leverages Citus to shard large tables.
- **Cross-Source JOINs**: Seamlessly join local SQL tables with external NoSQL datasets (via FDWs) using an Abstract Syntax Tree (AST) JSON payload.
- **Dynamic Aggregation**: Support for on-the-fly SQL aggregation (`GROUP BY`, `ORDER BY`, `COUNT`, `SUM`).
- **Materialized View Management**: Provides API-driven concurrent refreshes of materialized views for complex, long-running analytics.

---

## Architecture: How Different Databases Are Used

The Data Fabric operates on a unified SQL layer powered by PostgreSQL. You do **not** write MongoDB syntax or MySQL syntax directly. Instead, different databases are connected via **Foreign Data Wrappers (FDW)**:
1. **Connection Registration**: The Integration Module establishes a link (e.g., to MongoDB using `mongo_fdw` or MySQL using `mysql_fdw`).
2. **Virtual Tables**: The external data is mapped into PostgreSQL as a "Foreign Table".
3. **Unified Querying**: The Query Engine queries these foreign tables exactly as if they were local Postgres tables. The underlying FDW translates the SQL into the remote database's native dialect (Pushdown execution).

---

## 1. Primary API Endpoint

All queries, aggregations, schema management (DDL), and basic mutations (CRUD) utilize a single, unified endpoint:
**`POST /api/analytics/query`**

You pass an Abstract Syntax Tree (AST) inside the `queryConfig` body parameter to define exactly what you want the Data Fabric to do.

## 2. AST Syntax Reference & Supported Configurations

The engine dynamically translates your JSON AST into safe, parameterized SQL.

### Core AST Properties:
- `type`: The operation type. Options: `'SELECT'`, `'INSERT'`, `'UPDATE'`, `'DELETE'`, `'CREATE_TABLE'`, `'CREATE_INDEX'`.
- `table`: Target source table (can be a local table or a mapped NoSQL FDW table).
- `filter`: Key-value pairs for equality filtering (e.g. `{"status": "COMPLETED"}`). Automatically parameterized (`WHERE key = $1`) to prevent SQL injection.
- `joins`: Array defining relationships. Requires `type` (`INNER`, `LEFT`, etc.), `table`, and an `on` clause.
- `groupBy`: Array of fields to group by.
- `orderBy`: Sorting instructions array. e.g. `[{"field": "total_revenue", "dir": "DESC"}]`.
- `limit`: Integer restricting the number of returned records.

### `select` Options & Syntax Reference:
The `select` array defines the exact fields and transformations to return. Because the Data Fabric operates on PostgreSQL natively, you have access to powerful built-in functions.

**Basic Selection & Aliasing**
- Standard Field: `"first_name"`
- Aliasing: `"first_name AS name"`
- Dot Notation (for JOINs): `"orders.amount"`

**NoSQL JSONB Extraction Options**
- Extract as Text: `"metadata->>'role'"` (Returns the string value of the nested `role` key)
- Extract as JSON Object: `"metadata->'preferences'"` (Returns the nested JSON block)
- Deep Extraction: `"metadata->'preferences'->>'contact_method'"`

**Supported Aggregate Methods (Used with `groupBy`)**
- `COUNT`: Count rows. e.g., `"COUNT(*) as total_users"`, `"COUNT(DISTINCT user_id)"`
- `SUM`: Calculate total. e.g., `"SUM(amount) as total_revenue"`
- `AVG`: Calculate average. e.g., `"AVG(score) as average_rating"`
- `MIN` / `MAX`: Find boundaries. e.g., `"MAX(created_at) as latest_order"`
- `ARRAY_AGG`: Roll up values into a flat array. e.g., `"ARRAY_AGG(product_id) as product_list"`
- `JSON_AGG`: Roll up related relational rows into a nested JSON array. e.g., `"JSON_AGG(json_build_object('id', id, 'name', name)) as nested_children"`

**Mathematical & String Operations**
- Math: `"(price * quantity) AS total_line_item"`
- Concatenation: `"first_name || ' ' || last_name AS full_name"`

---

## 3. Data Fabric Best Practices: Schema & Object Management

While the Query Engine supports on-the-fly DDL (Data Definition Language) like `CREATE_TABLE`, an industrial-grade Data Fabric manages databases, tables, columns, and sequences using a more robust architectural pattern:

### 1. Database & Schema Tenancy
Instead of provisioning an entirely new PostgreSQL database (which consumes high overhead for connection pooling), **Schema-Based Tenancy** is used. 
- When a new client is onboarded, the system executes `CREATE SCHEMA "tenant_xyz"`. 
- All tables for that client reside in their isolated schema, ensuring strict logical separation without the hardware cost of spinning up new DB instances.

### 2. Declarative Table & Column Management (GitOps)
Tables and columns should not be managed by ad-hoc API DDL calls in production. Instead, they should be managed via a **Schema Registry** or **GitOps flow** (Module 8):
- A metadata JSON/YAML file defines the desired state of a tenant's tables and columns.
- When this file is updated, a Migration Engine diffs the desired state against the current Postgres catalog state.
- It automatically generates and executes the necessary `ALTER TABLE ADD COLUMN` or `DROP COLUMN` commands.

### 3. Sequences vs UUIDs in Distributed Systems
In a distributed Data Fabric (especially when using Citus for sharding), traditional auto-incrementing sequences (`SERIAL` or `CREATE SEQUENCE`) can cause massive bottlenecks because coordinating sequence locks across multiple worker nodes is slow.
- **Best Practice**: Use **UUIDv4** (Random) or **UUIDv7** (Time-sortable) for primary keys. They can be generated safely by any distributed node without locking or sequence coordination.

### 4. Foreign Table Management
In a Data Fabric, "creating a table" often actually means mapping an external NoSQL or API source.
- Instead of creating local tables, the Schema Registry executes `CREATE FOREIGN TABLE` definitions.
- This maps the external MongoDB collection or REST API endpoint directly into the tenant's schema as a virtual table.

---

## 2. API Query Examples (Scenario by Scenario)

The following examples demonstrate the power of the `POST /api/analytics/query` endpoint across multiple data access patterns.

### Scenario 1: Basic Filtering (SQL)
**Objective**: Retrieve the first 50 completed orders from a standard relational table.
```json
{
  "tenantId": "acme-corp",
  "queryConfig": {
    "type": "SELECT",
    "table": "orders",
    "select": ["id", "amount", "created_at"],
    "filter": {
      "status": "COMPLETED"
    },
    "limit": 50
  }
}
```

### Scenario 2: Extracting Data from NoSQL (JSONB)
**Objective**: Retrieve specific fields nested deep within a MongoDB JSON document using the `->>` operator.
```json
{
  "tenantId": "acme-corp",
  "queryConfig": {
    "type": "SELECT",
    "table": "mongodb_users",
    "select": ["id", "metadata->>'loyalty_tier' as tier", "metadata->'preferences'->>'contact_method' as contact"],
    "filter": {
      "is_active": true
    }
  }
}
```

### Scenario 3: Complex Cross-Source JOIN (Sync Type: Real-Time Pushdown)
**Objective**: Join a local SQL `orders` table with a remote MongoDB `users` collection in real-time.
**How it works**: The FDW pushes down the request to MongoDB to fetch the users, and Postgres performs the join locally.
```json
{
  "tenantId": "acme-corp",
  "queryConfig": {
    "type": "SELECT",
    "table": "orders",
    "select": ["orders.id", "orders.amount", "mongodb_users.metadata->>'loyalty_tier' as tier"],
    "filter": {
      "status": "COMPLETED"
    },
    "joins": [
      {
        "type": "INNER",
        "table": "mongodb_users",
        "on": "\"tenant_acme-corp\".\"orders\".user_id = \"tenant_acme-corp\".\"mongodb_users\".id"
      }
    ]
  }
}
```

### Scenario 4: Querying CDC Replicated Data (Sync Type: Async/Replicated)
**Objective**: Querying data that has been replicated from a legacy MySQL database via Change Data Capture (CDC) into a local PostgreSQL table for fast analytics.
```json
{
  "tenantId": "acme-corp",
  "queryConfig": {
    "type": "SELECT",
    "table": "cdc_legacy_transactions",
    "select": ["transaction_id", "gross_amount", "settlement_date"],
    "filter": {
      "settled": true
    },
    "orderBy": [
      {
        "field": "settlement_date",
        "dir": "DESC"
      }
    ],
    "limit": 100
  }
}
```

### Scenario 5: Simple Aggregation (`GROUP BY`)
**Objective**: Calculate the total number of orders and total revenue per status.
```json
{
  "tenantId": "acme-corp",
  "queryConfig": {
    "type": "SELECT",
    "table": "orders",
    "select": ["status", "COUNT(*) as total_orders", "SUM(amount) as total_revenue"],
    "groupBy": ["status"]
  }
}
```

### Scenario 6: The Ultimate Complex Query (Cross-Source + Aggregation + Sorting + Limits)
**Objective**: Find the top 5 MongoDB loyalty tiers that generate the most revenue from completed local SQL orders.
**How it works**: Joins local SQL and remote NoSQL, filters for completed orders, groups by the nested NoSQL loyalty tier, sums the SQL order amounts, orders by the highest revenue, and limits to the top 5.
```json
{
  "tenantId": "acme-corp",
  "queryConfig": {
    "type": "SELECT",
    "table": "orders",
    "select": [
      "mongodb_users.metadata->>'loyalty_tier' as tier", 
      "SUM(\"orders\".amount) as total_revenue"
    ],
    "filter": {
      "status": "COMPLETED"
    },
    "joins": [
      {
        "type": "INNER",
        "table": "mongodb_users",
        "on": "\"tenant_acme-corp\".\"orders\".user_id = \"tenant_acme-corp\".\"mongodb_users\".id"
      }
    ],
    "groupBy": ["mongodb_users.metadata->>'loyalty_tier'"],
    "orderBy": [
      {
        "field": "total_revenue",
        "dir": "DESC"
      }
    ],
    "limit": 5
  }
}
```

### Scenario 7: Generic Nested Data Fetch Across Multiple DB Sources (SQL, NoSQL, APIs)
**Objective**: Fetch parent data from a local SQL database and deeply nest related child records from a **MongoDB** database and an external **REST API** into a single JSON array, avoiding the N+1 query problem.

**How it works generically**: 
Because the Data Fabric uses Foreign Data Wrappers (FDW), all external sources (MongoDB via `mongo_fdw`, APIs via `http_fdw`) appear as standard relational tables to the Query Engine. 
The Engine pushes down the fetch requests to the respective sources, pulls the raw data into the Postgres coordinator node, and then uses Postgres' native `json_agg` and `json_build_object` functions to stitch together the hierarchical nested JSON object. This means the query syntax remains exactly the same regardless of the underlying database type.

**Example**: A local SQL `departments` table joined with a MongoDB `nosql_employees` collection, and nested with a REST API `api_performance_reviews` endpoint.

```json
{
  "tenantId": "acme-corp",
  "queryConfig": {
    "type": "SELECT",
    "table": "departments",
    "select": [
      "departments.id", 
      "departments.name", 
      "json_agg(json_build_object('emp_id', nosql_employees.id, 'role', nosql_employees.metadata->>'role', 'review_score', api_performance_reviews.score)) as nested_employee_data"
    ],
    "joins": [
      {
        "type": "LEFT",
        "table": "nosql_employees",
        "on": "\"tenant_acme-corp\".\"departments\".id = \"tenant_acme-corp\".\"nosql_employees\".department_id"
      },
      {
        "type": "LEFT",
        "table": "api_performance_reviews",
        "on": "\"tenant_acme-corp\".\"nosql_employees\".id = \"tenant_acme-corp\".\"api_performance_reviews\".employee_id"
      }
    ],
    "groupBy": ["departments.id", "departments.name"]
  }
}
```

### Scenario 8: Recursive Queries (Hierarchical Data Fetch)
**Objective**: Fetch a full organizational chart or category tree of unknown depth.
**How it works**: Uses the `withRecursive` configuration to generate a `WITH RECURSIVE` Common Table Expression (CTE). The query defines a `baseQuery` (e.g. finding the CEO), and a `recursiveQuery` that joins the employees table to the CTE to find all subordinates recursively.
```json
{
  "tenantId": "acme-corp",
  "queryConfig": {
    "type": "SELECT",
    "withRecursive": {
      "name": "org_tree",
      "baseQuery": "SELECT id, manager_id, name, 1 as depth FROM \"tenant_acme-corp\".\"employees\" WHERE manager_id IS NULL",
      "recursiveQuery": "SELECT e.id, e.manager_id, e.name, t.depth + 1 FROM \"tenant_acme-corp\".\"employees\" e INNER JOIN org_tree t ON e.manager_id = t.id"
    },
    "table": "org_tree",
    "select": ["id", "manager_id", "name", "depth"],
    "orderBy": [
      {
        "field": "depth",
        "dir": "ASC"
      }
    ]
  }
}
```

### Scenario 9: Metadata-Driven Schema Provisioning (DDL)
**Objective**: Dynamically provision a new tenant table (`CREATE_TABLE`) and index (`CREATE_INDEX`) based on metadata discovery.
**How it works**: Uses the `schemaDef` and `indexDef` configurations to execute safe DDL commands on the tenant's isolated schema.

**1. Create Table:**
```json
{
  "tenantId": "acme-corp",
  "queryConfig": {
    "type": "CREATE_TABLE",
    "table": "customers",
    "schemaDef": {
      "columns": [
        {"name": "id", "type": "UUID", "constraints": "PRIMARY KEY"},
        {"name": "name", "type": "VARCHAR(255)", "constraints": "NOT NULL"},
        {"name": "email", "type": "VARCHAR(255)", "constraints": "UNIQUE"}
      ]
    }
  }
}
```

**2. Create Index:**
```json
{
  "tenantId": "acme-corp",
  "queryConfig": {
    "type": "CREATE_INDEX",
    "table": "customers",
    "indexDef": {
      "name": "idx_customer_email",
      "columns": ["email"],
      "unique": true
    }
  }
}
```

### Scenario 10: Basic CRUD Operations (DML)
**Objective**: Insert a new record, update it, and delete it using parameterized queries to prevent SQL injection.

**1. Insert Record:**
```json
{
  "tenantId": "acme-corp",
  "queryConfig": {
    "type": "INSERT",
    "table": "customers",
    "data": {
      "id": "123e4567-e89b-12d3-a456-426614174000",
      "name": "Acme Employee",
      "email": "employee@acme.com"
    }
  }
}
```

**2. Update Record:**
```json
{
  "tenantId": "acme-corp",
  "queryConfig": {
    "type": "UPDATE",
    "table": "customers",
    "data": {
      "name": "Acme Senior Employee"
    },
    "filter": {
      "id": "123e4567-e89b-12d3-a456-426614174000"
    }
  }
}
```

**3. Delete Record:**
```json
{
  "tenantId": "acme-corp",
  "queryConfig": {
    "type": "DELETE",
    "table": "customers",
    "filter": {
      "email": "employee@acme.com"
    }
  }
}
```

### Scenario 11: Long-Running Asynchronous Analytics (Async Job Queue)
**Objective**: Execute a massive cross-source aggregation that takes too long for a standard HTTP request to complete without timing out.

**1. Submit Async Query:**
Use the `POST /api/analytics/query-async` endpoint instead. The payload is identical to a standard query.
```json
{
  "tenantId": "acme-corp",
  "queryConfig": {
    "type": "SELECT",
    "table": "historical_sales_fdw",
    "select": ["product_id", "SUM(amount) as lifetime_revenue"],
    "groupBy": ["product_id"]
  }
}
```
**Response (202 Accepted):**
```json
{
  "jobId": "f47ac10b-58cc-4372-a567-0e02b2c3d479",
  "status": "PENDING"
}
```

**2. Poll for Job Status/Results:**
Use `GET /api/analytics/jobs/f47ac10b-58cc-4372-a567-0e02b2c3d479` to retrieve the data once the background job finishes.
```json
{
  "status": "COMPLETED",
  "result": [
    { "product_id": "P123", "lifetime_revenue": 50000 }
  ],
  "createdAt": "2026-05-05T12:00:00Z"
}
```

---

## 4. Refreshing Materialized Views

When queries involve massive aggregations across billions of rows, they should be pre-computed into Materialized Views. 

**API Request:** `POST /api/analytics/refresh-view`
```json
{
  "tenantId": "acme-corp",
  "viewName": "monthly_sales_mv",
  "concurrent": true
}
```
*Note: The `concurrent: true` flag ensures that the view remains accessible for reads while the background refresh computation occurs.*
