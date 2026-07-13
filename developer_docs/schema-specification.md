# Relational Schema, DDL & AST Query Specification

This document provides the formal JSON schema specification for both the **QueryConfig (Envelope)**, the **AST Query Language**, and the **Metadata Manifests** utilized inside the Zero Data Fabric.

---

## 1. QueryConfig Root Schema (DML & DDL Envelope)

Every query request sent to `POST /api/analytics/query` or `/api/queries/engine` maps to this envelope.

```json
{
  "type": "SELECT",
  "schema": "Global_Supply_Chain",
  "source": "Fabric_Hub_Postgres",
  "resource": "shipments",
  "limit": 100,
  "offset": 0,
  "data": {
    "status": "PENDING"
  },
  "query": {
    "select": ["*"],
    "from": { "resource": "shipments" }
  }
}
```

### Root Fields:
* **`type`**: `String` | Required. The action mapping category:
  * DML/Query: `'SELECT' | 'INSERT' | 'UPDATE' | 'DELETE'`
  * DDL schema commands: `'CREATE_SCHEMA' | 'CREATE_TABLE' | 'CREATE_FOREIGN_TABLE' | 'ALTER_TABLE' | 'DROP_TABLE' | 'CREATE_INDEX' | 'CREATE_VIEW' | 'CREATE_SEQUENCE'`
* **`schema`**: `String` | Optional. Logical schema context (resolved into tenant physical schema).
* **`source`**: `String` | Optional. Registered database connection name.
* **`resource`** (or **`table`**): `String` | Optional. Table, collection, or index target.
* **`tableId`**: `String` | Optional. UUID reference to `catalog_tables`.
* **`schemaId`**: `String` | Optional. UUID reference to `catalog_schemas`.
* **`limit`**: `Integer` | Optional. Row-count boundary.
* **`offset`**: `Integer` | Optional. Pagination offset index.
* **`data`**: `Object` | `Array` | Optional. Map or array of record changes (used exclusively for inserts and updates).
* **`select`**: `Array` | Optional. Column projections for legacy mode.
* **`filter`**: `Object` | Optional. Key-value filter conditions for legacy mode.
* **`groupBy`**: `Array` | Optional. Columns for grouping results.
* **`orderBy`**: `Array` | Optional. Ordering directives `[{ "field": "col", "dir": "ASC" | "DESC" }]`.

### DDL Configurations:

#### A. `schemaDef` (For `type: "CREATE_TABLE"`)
Describes column definitions:
```json
"schemaDef": {
  "columns": [
    { "name": "id", "type": "UUID", "constraints": "PRIMARY KEY" },
    { "name": "name", "type": "VARCHAR(100)", "constraints": "NOT NULL" },
    { "name": "created_at", "type": "TIMESTAMP", "constraints": "DEFAULT NOW()" }
  ]
}
```

#### B. `indexDef` (For `type: "CREATE_INDEX"`)
```json
"indexDef": {
  "name": "idx_shipment_region",
  "columns": ["region"],
  "unique": false
}
```

#### C. `alterDef` (For `type: "ALTER_TABLE"`)
```json
"alterDef": {
  "action": "ADD_COLUMN",
  "columnName": "delivery_date",
  "columnType": "TIMESTAMP"
}
```
* `action`: `'ADD_COLUMN'` | `'DROP_COLUMN'`.

#### D. `viewDef` (For `type: "CREATE_VIEW"`)
```json
"viewDef": {
  "name": "active_shipments",
  "query": "SELECT * FROM shipments WHERE status = 'ACTIVE'",
  "materialized": false
}
```

#### E. `sequenceDef` (For `type: "CREATE_SEQUENCE"`)
```json
"sequenceDef": {
  "name": "tracking_seq",
  "start": 100000,
  "increment": 1
}
```

#### F. `foreignDef` (For `type: "CREATE_FOREIGN_TABLE"`)
```json
"foreignDef": {
  "serverName": "remote_mysql_server",
  "options": {
    "dbname": "warehouse_db",
    "table_name": "products"
  }
}
```

---

## 2. AST Query Schema (The `query` Object)

The core relational AST specified in `queryConfig.query` when executing reads or complex queries.

```json
{
  "select": [
    "id",
    { "aggregate": "SUM", "column": "total_amount", "alias": "revenue" },
    { "window": "RANK", "partitionBy": ["region"], "orderBy": [{"column": "total_amount", "direction": "DESC"}], "alias": "rank" }
  ],
  "from": { "resource": "shipments", "source": "Fabric_Hub_Postgres", "alias": "s" },
  "joins": [
    {
      "type": "INNER",
      "resource": "shipment_details",
      "source": "Fabric_Hub_Postgres",
      "alias": "d",
      "on": { "left": "s.id", "operator": "EQ", "right": "d.shipment_id" }
    }
  ],
  "where": [
    { "column": "s.region", "operator": "EQ", "value": "US" }
  ],
  "groupBy": ["region"],
  "orderBy": [
    { "column": "revenue", "direction": "DESC" }
  ]
}
```

### Projections (`select` Array):
Can contain four types of values:
1. **String**: Identifies column projections (e.g. `["*"]` or `["id", "region"]`).
2. **Aggregate Map**:
   * `aggregate`: `String` | `'COUNT' | 'SUM' | 'AVG' | 'MIN' | 'MAX' | 'COUNT_DISTINCT'`
   * `column`: `String` | Column name (use `*` for COUNT)
   * `alias`: `String` | Output column header.
3. **Window Function Map**:
   * `window`: `String` | `'RANK' | 'DENSE_RANK' | 'ROW_NUMBER' | 'LEAD' | 'LAG' | 'NTILE' | 'FIRST_VALUE' | 'LAST_VALUE'`
   * `partitionBy`: `Array` | Grouping partition columns.
   * `orderBy`: `Array` | Ordering configurations.
   * `alias`: `String` | Output column header.
4. **Expression Map**:
   * `expression`: `String` | Raw SQL statement evaluation (e.g. `{"expression": "ep.level + 1", "alias": "level"}`).

### Driving Target (`from` Object):
* `resource`: `String` | Table or collection.
* `source`: `String` | Physical connection source.
* `alias`: `String` | Qualifier alias.

### Joins (`joins` Array):
Each join element contains:
* `type`: `String` | `'INNER' | 'LEFT' | 'RIGHT' | 'FULL' | 'CROSS'`
* `resource`: `String` | Table or collection to join.
* `source`: `String` | Optional. Physical connection source (omit for same-source joins).
* `alias`: `String` | Qualifier alias.
* `on`: `Object` | Join condition:
  * `left`: `String` | Left-side qualified column.
  * `operator`: `String` | `'EQ' | 'NE' | 'GT' | 'LT'`
  * `right`: `String` | Right-side qualified column.

### Predicates (`where` Array):
List of filter maps combined with logical `AND`. Can be of two shapes:

#### Relational Predicate:
* `column`: `String` | Qualified column name.
* `operator`: `String` | `'EQ' | 'NE' | 'GT' | 'GTE' | 'LT' | 'LTE' | 'LIKE' | 'ILIKE' | 'IN' | 'NOT_IN' | 'IS_NULL' | 'IS_NOT_NULL' | 'BETWEEN'`
* `value`: `Any` | Match value (omit for Null checks; array for `IN`/`NOT_IN`; `[min, max]` for `BETWEEN`).

#### Full-Text Search:
* `search`: `Object`
  * `column`: `String` | Target text vector column.
  * `type`: `String` | Must equal `'FULL_TEXT'`.
  * `query`: `String` | Keywords to find.

### Ordering (`orderBy` Array):
* `column`: `String` | Column name.
* `direction`: `String` | `'ASC'` (ascending) or `'DESC'` (descending).

### Grouping (`groupBy` Array):
Simple array of column name strings (e.g. `["region", "status"]`).

### Recursive CTE Views (`with` Array):
Recursively parses hierarchies:
```json
"with": [
  {
    "name": "org_tree",
    "columns": ["id", "name", "manager_id", "level"],
    "base": {
      "select": ["id", "name", "manager_id", { "expression": "1", "alias": "level" }],
      "from": { "resource": "employees" },
      "where": [{ "column": "manager_id", "operator": "IS_NULL" }]
    },
    "unionAll": {
      "select": ["e.id", "e.name", "e.manager_id", { "expression": "ot.level + 1" }],
      "from": { "resource": "employees", "alias": "e" },
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
]
```
* `name`: `String` | Local recursive alias.
* `columns`: `Array` | Projected column list.
* `base`: `Object` | Base query step.
* `unionAll`: `Object` | Recursive loop step joined to base.

### Set Operations:
Cross-engine combinations using `union`, `intersect`, or `except` arrays containing AST sub-queries:
```json
{
  "union": [
    { "select": ["id", "region"], "from": { "resource": "sales_us", "source": "US_Postgres" } },
    { "select": ["id", "region"], "from": { "resource": "sales_eu", "source": "EU_MySQL" } }
  ]
}
```
