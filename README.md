# Universal Data Fabric Orchestrator (v7.0)

Industrial-grade, declarative Data Fabric orchestration system for heterogeneous enterprise data environments.

---

## 🚀 Key Capabilities

### 1. Omni-Template Orchestration
Full-spectrum declarative schema management:
- **Relational Cardinality**: Native `1:1`, `1:M`, `M:1`, and `M:M` support.
- **Planetary Partitioning**: Native `RANGE` and `LIST` support.
- **Identity Orchestration**: Distributed sequences and composite primary keys.
- **Event-Driven Triggers**: Native PL/pgSQL function orchestration.

### 2. Autonomous Governance
- **PII Masking**: Column-level partial redaction (e.g., `ind****`).
- **Industrial Safety Shield**: 
    - **Mandatory Filters**: Blocked `UPDATE` and `DELETE` without a `filter` predicate.
    - **Analytical Guard**: Automatic `LIMIT 1000` applied to standard `SELECT` scans if no limit is provided.
    - **Aggregate Bypass**: Unrestricted execution for aggregate queries (e.g., `count(*)`).
- **Identity Proxy**: Automated ownership transfer to `fabric_user`.
- **Soft Deletes**: Diversion of destructive DDL to catalog-level flags.

---

## 🏗 Orchestration Blueprint (v7.0) Spec
Submitted via `POST /api/metadata/migrate`.

### **Action: CREATE_TABLE**
| Key | Type | Description |
| :--- | :--- | :--- |
| `table` | String | Target table name. |
| `details.columns` | Array | `[{ name, type, primaryKey, description, defaultValue }]`. |
| `details.columns[].description` | String | Governance tags: `"MASK:PARTIAL"`, `"MASK:REDACT"`. |
| `details.compositePrimaryKey` | Array | List of columns for multi-column PK. |
| `details.partitioned` | Object | `{ type: "RANGE\|LIST", column: "field" }`. |
| `details.triggers` | Array | `[{ name, event, function }]`. |
| `details.policies` | Array | `[{ name, action, check }]` (RLS policies). |

### **Action: CREATE_FUNCTION**
| Key | Type | Description |
| :--- | :--- | :--- |
| `name` | String | Function name. |
| `body` | String | PL/pgSQL function body. |

### **Action: CREATE_VIEW**
| Key | Type | Description |
| :--- | :--- | :--- |
| `table` | String | View name. |
| `details.materialized` | Boolean | If true, creates a materialized view. |
| `details.config` | Object | Full Query AST (see below). |

### **Action: CREATE_FOREIGN_TABLE**
| Key | Type | Description |
| :--- | :--- | :--- |
| `table` | String | Local name for foreign table. |
| `details.server` | String | FDW Server name (e.g., `remote_warehouse_server`). |
| `details.columns` | Array | Remote column definitions. |
| `details.options` | Object | `{ schema_name, table_name }`. |

---

## 📊 Query Orchestration Syntax (AST)
Used in `/api/analytics/query` and `CREATE_VIEW`.

### **The SELECT AST**
| Key | Type | Description |
| :--- | :--- | :--- |
| `type` | String | Must be `"SELECT"`. |
| `table` | String | Target table name. |
| `select` | Array | List of columns or expressions: `["email", "count(*)"]`. |
| `filter` | Object | Advanced predicates: `{ "col": { "$gt": 10 } }`. |
| `joins` | Array | List of join objects: `{ type: "INNER\|LEFT", table: "target", on: "condition" }`. |
| `groupBy` | Array | List of columns to group by: `["groups.name"]`. |
| `orderBy` | Array | List of order objects: `[{ "field": "name", "dir": "ASC" }]`. |
| `limit` | Number | Max results to return. |
| `withRecursive` | Object | Recursive CTE configuration. |

*Note: Aggregate queries (count, sum, etc.) bypass the Industrial Safety Shield to allow for global metric gathering.*

#### **Supported Filter Operators**

```json
{
  "type": "SELECT",
  "table": "users",
  "select": ["users.email", "groups.name as group_name"],
  "joins": [
    { "type": "INNER", "table": "user_groups", "on": "users.id = user_groups.user_id" },
    { "type": "INNER", "table": "groups", "on": "user_groups.group_id = groups.id" }
  ],
  "filter": {
    "groups.name": { "$eq": "Admins" },
    "users.created_at": { "$gt": "2024-01-01" }
  },
  "groupBy": ["groups.name"],
  "orderBy": [{ "field": "groups.name", "dir": "ASC" }],
  "limit": 100,
  "withRecursive": {
    "name": "org_tree",
    "baseQuery": "SELECT id, name, parent_id FROM org WHERE parent_id IS NULL",
    "recursiveQuery": "SELECT o.id, o.name, o.parent_id FROM org o JOIN org_tree ot ON o.parent_id = ot.id"
  }
}
```

#### **Supported Filter Operators**
| Operator | SQL Equivalent | Example |
| :--- | :--- | :--- |
| `$eq` | `=` | `{ "status": { "$eq": "active" } }` |
| `$ne` | `!=` | `{ "type": { "$ne": "internal" } }` |
| `$gt` | `>` | `{ "price": { "$gt": 100 } }` |
| `$lt` | `<` | `{ "age": { "$lt": 18 } }` |
| `$gte` | `>=` | `{ "score": { "$gte": 50 } }` |
| `$lte` | `<=` | `{ "qty": { "$lte": 5 } }` |
| `$like` | `LIKE` | `{ "email": { "$like": "%@gmail.com" } }` |
| `$in` | `IN (...)` | `{ "id": { "$in": [1, 2, 3] } }` |

### **DML Syntax**
- **INSERT**: `{ "type": "INSERT", "table": "users", "data": { "email": "new@io.com" } }`
- **UPDATE**: `{ "type": "UPDATE", "table": "users", "data": { "status": "active" }, "filter": { "id": 1 } }`
- **DELETE**: `{ "type": "DELETE", "table": "users", "filter": { "id": 1 } }`

---

## 🛠 API Surface

| Endpoint | Method | Description | Payload Key Params |
|----------|--------|-------------|-------------------|
| `/api/auth/login` | POST | Authentication | `username`, `password` |
| `/api/metadata/diff` | POST | Drift Analysis | `file` (manifest.json) or JSON body |
| `/api/metadata/apply` | POST | Declarative Sync | `file` (manifest.json) or JSON body |
| `/api/metadata/migrate` | POST | Manual Orchestration | `migrationPlan` (Array of Actions) |
| `/api/analytics/query` | POST | Sync Analytics | `queryConfig` (AST) |
| `/api/analytics/query-async` | POST | Job Dispatch | `queryConfig` (AST) |
| `/api-docs` | GET | Swagger UI | Open Interactive Spec |

---

## 🧪 Verification
The platform includes an **Exhaustive Industrial Verification Suite** covering 12 stages of orchestration:
```bash
cd backend && npx ts-node src/scripts/test_full_orchestration.ts
```

## 📘 Additional Ops Docs
- Elasticsearch usage, readiness, and validation flow: `docs/elasticsearch_usage.md`
