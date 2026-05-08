# Data Fabric: Architectural Behavior & User Experience Design

## 1. Core Objective: Unified Heterogeneity
The Data Fabric's primary value is making a NoSQL collection and a SQL table feel identical to the consuming application. 

---

## 2. Scenario: Adding SQL vs NoSQL Data Sources
As a user, when I add a data source, the "Fabric" should handle the heavy lifting of integration based on the engine type.

### 2.1 Behavior for SQL Sources (e.g., PostgreSQL, MySQL)
**The "Linked" Experience**:
1. **Connection Validation**: Immediate check of host/port/credentials.
2. **Infrastructure Provisioning (FDW)**:
   - Registers a `FOREIGN SERVER` on the Hub.
   - Creates `USER MAPPINGS` for the backend system and the specific tenant user.
3. **Automated Namespace Sync**:
   - Executes `IMPORT FOREIGN SCHEMA` into the tenant's isolated schema (`tenant_[id]`).
   - This makes remote tables appear as "local" tables to the tenant.
4. **Metadata Discovery**: Crawls `information_schema` to populate the Fabric Catalog with column types, primary keys, and relationships.

**User Result**: Tables appear instantly in the "Fabric Explorer" and can be queried using standard SQL through the Hub.

### 2.2 Behavior for NoSQL Sources (e.g., MongoDB)
**The "Virtualized" Experience**:
1. **Connection Validation**: Check of the Mongo Connection String.
2. **Virtual Registry entry**: No physical schema is created on the Hub (to maintain Mongo's flexibility). Instead, a "Virtual Pointer" is created in the Fabric Registry.
3. **Schema Inference (Sampling)**:
   - The Fabric samples the first ~100 documents in each collection.
   - It "infers" a virtual table structure (Fields -> Columns).
   - It maps BSON types to Fabric Unified Types (e.g., `ObjectId` -> `string`, `Int32` -> `number`).
4. **Connector Mapping**: Routes queries to the MongoDB Driver, translating SQL-like predicates to Mongo `find()` filters.

**User Result**: Collections appear as "Tables" in the "Fabric Explorer". Users can run SELECT queries on them as if they were relational.

---

## 3. Comparison of Lifecycle States

| Phase | SQL Behavior | NoSQL Behavior |
| :--- | :--- | :--- |
| **Registration** | Physical FDW Mapping | Virtual Connector Mapping |
| **Data Access** | Proxied via FDW (Native SQL) | Translated via Connector (NoSQL AST) |
| **Schema Changes** | Requires `IMPORT SCHEMA` refresh | Dynamic/Adaptive (Schema-on-read) |
| **Addressing** | `Source.Schema.Table` | `Source.Database.Collection` |

---

## 4. Scenario: The "First Query" Experience
Regardless of the source type, the user interaction is identical:

1. **Discovery**: User sees `Inventory_PG` and `Logs_Mongo` in the sidebar.
2. **Execution**:
   ```json
   // Querying Postgres
   { "source": "Inventory_PG", "table": "products", "limit": 5 }
   
   // Querying Mongo
   { "source": "Logs_Mongo", "table": "app_logs", "limit": 5 }
   ```
3. **Unified Response**: Both return an identical JSON array of objects. The application code doesn't need to implement `pg` and `mongodb` drivers separately.

---

## 5. Scenario: Resilient Application Integration
**User Case**: "I'm building an app. I store `datasource_id` and `schema_id` in my environment variables. I don't want to change my code or config if the infrastructure is reset."

### 5.1 The "ID Fragility" Problem
In a standard registry, deleting a source and re-adding it changes its UUID. If an application relies on `dataSourceId: "abc-123"`, it will break after a reset.

### 5.2 The Data Fabric Solution: Logical Fallback
The Data Fabric implements a **Hybrid Resolution Layer**:
1. **Primary Lookup (UUID)**: The engine first tries to find the source by the provided ID.
2. **Secondary Lookup (Logical Name)**: If the UUID is not found, the engine queries the current active catalog for a source with the **Same Name** for that specific **Tenant**.
3. **Transparent Remapping**: If a name match is found, the query proceeds using the *new* physical ID, and a warning is logged (or a metadata event is emitted) to suggest an ID update, but **the application does not crash**.

**UX Outcome**: "Set it and forget it." Developers can use IDs for performance, but the system "self-heals" using logical names if the infrastructure state changes.

---

## 6. Metadata Lifecycle: Handling Empty States & Evolution
The Data Fabric is a living system. It must adapt as the underlying data sources change.

### 6.1 Scenario: Fresh/Empty NoSQL Setup
When a collection is registered but contains no documents:
- **Registry State**: The table is registered with a single mandatory column: `_id`.
- **Placeholder Mode**: The UI displays the table as "Empty/Pending Discovery."
- **Auto-Bootstrap**: As soon as the first document is inserted, a "Discovery Trigger" (either manual or via CDC) should update the schema.

### 6.2 Scenario: Schema Evolution (New Properties)
In NoSQL, fields like `discount_code` may appear only in newer documents.
- **Hidden Phase**: New fields are physically present in the target DB but "Hidden" from the Fabric Catalog.
- **Adaptive Sync Strategy**:
    1. **Reverse Sampling**: Re-sampling the *latest* 100 documents (sorted by `_id` DESC) picks up recent changes.
    2. **On-the-fly Discovery**: The Query Engine can be set to "Permissive Mode," where it returns fields found in the result set even if they are missing from the Catalog.
    3. **CDC Listeners**: Real-time schema learning via database Change Streams.

### 6.3 Type Conflict Resolution
If a field is a `string` in doc A and a `number` in doc B:
- **Unified Casting**: The Fabric prioritizes **Data Safety**. It will default the Virtual Column to `string` to prevent truncation or casting errors during virtualization.

---

## 8. Scenario: Metadata-Driven Schema Creation (DDL AST)
**User Case**: "I want to provision a new business module (e.g., 'Orders') across my data sources by simply providing a schema definition file."

### 8.1 Behavior for SQL Sources (Postgres)
- **Direct Provisioning**: The Fabric translates the Metadata AST into native `CREATE TABLE` and `CREATE INDEX` SQL.
- **Namespace isolation**: The table is created in the tenant's dedicated schema.
- **FDW Visibility**: If the table is on a remote Postgres, the Hub automatically executes `IMPORT FOREIGN SCHEMA` to make the new table immediately visible to the Hub's Query Engine.

### 8.2 Behavior for NoSQL Sources (MongoDB)
- **Lazy Provisioning**: Mongo is schema-less, but the Fabric can:
    1.  Physically create the collection (`createCollection`).
    2.  Apply **JSON Schema Validation** to the collection to enforce the structure defined in the metadata.
    3.  Create indexes as defined in the AST.
- **Registry Update**: The Catalog is updated immediately, so the collection appears as a "Table" even before data is inserted.

### 8.3 Advanced Industrial Metadata AST Template (Universal DDL)
This template defines a complete business domain including logic, security, and complex relationships.

##### 8.3 Definitive Industrial Metadata AST (Universal DDL v4.0)
This template is the "Master Blueprint" for the entire fabric, integrating the exhaustive business logic of v3.0 with the federated orchestration of v4.0.

```json
{
  "version": "4.0",
  "namespace": "Global_Supply_Chain",
  "targetSource": "Fabric_Hub_Postgres",
  "consistencyMode": "SAGA", 
  "downstream": [
    { "type": "ELASTICSEARCH", "enabled": true, "fallback": "PRIMARY_SQL" },
    { "type": "SNOWFLAKE", "enabled": true, "strategy": "CDC" }
  ],
  "extensions": ["uuid-ossp", "pg_stat_statements"],
  "resources": [
    {
      "type": "ENUM",
      "name": "shipment_status",
      "values": ["PENDING", "IN_TRANSIT", "DELIVERED", "CANCELLED"]
    },
    {
      "type": "SEQUENCE",
      "name": "tracking_seq",
      "start": 100000,
      "increment": 1,
      "minValue": 100000,
      "maxValue": 999999999,
      "cache": 20,
      "ownedBy": { "table": "shipments", "column": "id" }
    },
    {
      "type": "SEQUENCE",
      "name": "tenant_aware_seq",
      "start": 1,
      "increment": 1,
      "strategy": "PROCEDURAL",
      "generator": "generate_tenant_id(tenant_id)"
    },
    {
      "type": "TABLE",
      "name": "shipments",
      "comment": "Master table for global logistics tracking",
      "partitionBy": { "type": "RANGE", "column": "created_at" },
      "identity": { "type": "PRIMARY_KEY", "columns": ["id", "region"] },
      "version": "1.4.2",
      "maintenance": { "autovacuum_enabled": true, "fillfactor": 80 },
      "columns": [
        { "name": "id", "type": "UUID", "default": "uuid_generate_v7()", "strategy": "UUID_V7" },
        { "name": "internal_id", "type": "BIGINT", "strategy": "IDENTITY_ALWAYS" },
        { "name": "legacy_id", "type": "SERIAL", "strategy": "LEGACY_SERIAL" },
        { "name": "custom_id", "type": "STRING", "default": "generate_custom_id(region)", "strategy": "FUNCTIONAL" },
        { "name": "region", "type": "STRING", "length": 10, "collation": "en_US.UTF-8" },
        { "name": "full_tracking_label", "type": "STRING", "generated": "id || ' [' || region || ']'", "stored": true },
        { "name": "status", "type": "ENUM", "ref": "shipment_status", "default": "PENDING" },
        { "name": "metadata", "type": "JSONB", "comment": "Flexible attributes for custom carrier data", "index": { "type": "GIN" } },
        { "name": "created_at", "type": "TIMESTAMP", "default": "NOW()", "index": { "type": "BRIN" } },
        { "name": "created_by", "type": "UUID", "default": "current_user_id()", "readonly": true },
        { "name": "deleted_at", "type": "TIMESTAMP", "nullable": true, "strategy": "SOFT_DELETE" }
      ],
      "constraints": [
        { "name": "check_region_format", "type": "CHECK", "expression": "region ~ '^[A-Z]{2,3}$'" },
        { "name": "exclude_overlapping_shipments", "type": "EXCLUDE", "using": "GIST", "columns": [{ "name": "region", "operator": "=" }, { "name": "created_at", "operator": "&&" }] }
      ],
      "triggers": [
        { "name": "trg_audit_shipment", "timing": "AFTER", "events": ["INSERT", "UPDATE"], "execution": "row", "procedure": "audit_log_fn" }
      ],
      "security": {
        "enable_rls": true,
        "masking": [{ "column": "metadata", "roles": ["logistics_viewer"], "expression": "'REDACTED'" }],
        "policies": [
          { "name": "regional_isolation", "roles": ["fabric_user"], "using": "region = current_setting('app.current_region')" },
          { "name": "hide_deleted", "using": "deleted_at IS NULL" }
        ],
        "grants": [{ "role": "logistics_viewer", "privileges": ["SELECT"] }]
      }
    },
    {
      "type": "FUNCTION",
      "name": "generate_custom_id",
      "arguments": [{ "name": "p_region", "type": "STRING" }],
      "returnType": "STRING",
      "body": "DECLARE v_seq BIGINT; BEGIN v_seq := nextval('tracking_seq'); RETURN p_region || '-' || to_char(NOW(), 'YYYY') || '-' || lpad(v_seq::text, 8, '0'); END;"
    },
    {
      "type": "PROCEDURE",
      "name": "process_delivery",
      "parameters": [
        { "name": "p_shipment_id", "type": "BIGINT", "mode": "IN" },
        { "name": "p_success", "type": "BOOLEAN", "mode": "OUT" }
      ],
      "body": "UPDATE shipments SET status = 'DELIVERED' WHERE id = p_shipment_id; p_success := true;"
    },
    {
      "type": "VIEW",
      "name": "org_hierarchy_recursive",
      "recursive": true,
      "query": {
        "with": [
          {
            "name": "emp_path",
            "columns": ["id", "name", "manager_id", "path", "level"],
            "base": {
              "select": ["id", "name", "manager_id", { "expression": "name", "alias": "path" }, { "expression": "1", "alias": "level" }],
              "from": "employees",
              "where": [{ "column": "manager_id", "operator": "IS_NULL" }]
            },
            "unionAll": {
              "select": ["e.id", "e.name", "e.manager_id", { "expression": "ep.path || ' -> ' || e.name" }, { "expression": "ep.level + 1" }],
              "from": { "resource": "employees", "alias": "e" },
              "joins": [{ "type": "INNER", "resource": "emp_path", "alias": "ep", "on": { "left": "e.manager_id", "operator": "EQ", "right": "ep.id" } }]
            }
          }
        ],
        "select": ["*"],
        "from": "emp_path"
      }
    },
    {
      "type": "VIEW",
      "name": "high_value_regional_summary",
      "query": {
        "select": [
          { "column": "s.region" },
          { "aggregate": "SUM", "column": "s.total_amount", "alias": "revenue" },
          { "window": "RANK", "partitionBy": ["s.region"], "orderBy": [{ "column": "s.total_amount", "direction": "DESC" }], "alias": "rank" }
        ],
        "from": { "resource": "shipments", "alias": "s" },
        "joins": [
          { "type": "LEFT", "resource": "shipment_details", "alias": "d", "on": { "left": "s.id", "operator": "EQ", "right": "d.shipment_id" } }
        ],
        "where": [
          { "search": { "column": "d.notes", "type": "FULL_TEXT", "query": "priority" } }
        ],
        "groupBy": ["s.region", "s.total_amount"]
      }
    },
    {
      "type": "VIEW",
      "name": "federated_inventory_analysis",
      "federationStrategy": "VIRTUAL",
      "query": {
        "union": [
          { "select": ["sku", "stock"], "from": "local_warehouse_pg" },
          { "select": ["item_id", "qty"], "source": "Activity_Mongo", "from": "remote_depot_mongo" }
        ],
        "intersect": [
          { "select": ["sku"], "from": "active_products_pg" },
          { "select": ["product_id"], "source": "Activity_Mongo", "from": "mongo_product_catalog" }
        ],
        "except": [
          { "select": ["sku"], "from": "local_warehouse_pg" },
          { "select": ["sku"], "from": "discontinued_items_csv" }
        ]
      }
    },
    {
      "type": "MATERIALIZED_VIEW",
      "name": "regional_volume_stats",
      "refreshStrategy": "CONCURRENTLY",
      "refreshInterval": "1 hour",
      "query": {
        "select": [{ "column": "region" }, { "aggregate": "COUNT", "alias": "volume" }],
        "from": "shipments",
        "groupBy": ["region"]
      },
      "indexes": [{ "columns": ["region"], "unique": true }]
    }
  ],
  "relationships": [
    {
      "name": "rel_1_1_shipment_details",
      "cardinality": "1:1",
      "from": { "resource": "shipments", "field": "id" },
      "to": { "resource": "shipment_details", "field": "shipment_id" }
    },
    {
      "name": "rel_1_M_shipment_logs",
      "cardinality": "1:M",
      "from": { "resource": "shipments", "field": "id" },
      "to": { "source": "Activity_Mongo", "resource": "shipment_audit_logs", "field": "shipment_id" }
    },
    {
      "name": "rel_M_N_shipment_tags",
      "cardinality": "M:N",
      "bridge": "shipment_tags_link",
      "from": { "resource": "shipments", "field": "id" },
      "to": { "resource": "tags", "field": "id" }
    }
  ]
}
```

### 8.4 Metadata Field Definitions (Universal Language)
To ensure engine-neutrality, the Data Fabric uses abstract terms that map to native database concepts:

| Fabric Term | DB Equivalent (SQL) | DB Equivalent (NoSQL) | Definition |
| :--- | :--- | :--- | :--- |
| **targetSource** | **DataSource** | **DataSource** | The physical connection name (e.g., `Main_Postgres`). |
| **namespace** | **Schema** | **Database** | The logical grouping (e.g., `Billing`, `Inventory`). |
| **name** | **Table** | **Collection** | The individual data entity. |

### 8.5 Provisioning Strategy: Blueprints vs. API Overrides
The Fabric supports a "Hybrid Deployment" model to balance **Safety** and **Flexibility**.

1.  **Self-Contained Blueprints (The "GitOps" Way)**:
    -   `targetSource` and `namespace` are defined **inside** the metadata file.
    -   **Benefit**: The file is a portable "Source of Truth." You can commit it to Git and deploy it anywhere. It knows its own destination.
    -   **Multi-Source Power**: A single file can define resources across *different* sources (e.g., one table on Postgres and one archive collection on MongoDB).

2.  **API Overrides (The "CI/CD" Way)**:
    -   Users can call `POST /api/metadata/apply?source=Staging_DB&schema=test_core`.
    -   **Behavior**: API parameters **always override** the internal file values.
    -   **Benefit**: Use the same "Module Template" (e.g., a standard 'User' profile) to provision multiple environments (Dev, Test, Prod) without changing the file content.

### 8.6 User Journey: "The Designer Experience"
1. **Design**: The user creates a `domain_model.json` using the Advanced AST above.
2. **Submit**: 
   - Simple: `POST /api/metadata/apply` (Uses internal file defaults).
   - Dynamic: `POST /api/metadata/apply?source=New_PG_Source` (Overrides target).
3. **Execution**:
    - Fabric resolves the final `DataSource` and `Schema`.
    - It generates native DDL (SQL) or Collections (NoSQL).
4. **Result**: The "Fabric Explorer" and "Query Engine" are instantly updated to support the new model.
4. **Result**: The "Fabric Explorer" updates. The user can now immediately run `INSERT INTO Inventory_DB.orders ...` or `db.orders.insert(...)` through the unified API.

### 8.7 Advanced Logic: Security Functions & Type Discovery
The Metadata AST relies on several "System Primitives" to enforce security and maintain type integrity.

#### **1. Security Functions (RLS Integration)**
In the `security` section of a table, you'll see references like `current_tenant()` and `current_setting()`:

- **`current_tenant()`**: A custom Fabric function defined in the core schema. It retrieves the active `tenant_id` from the secure session context. This ensures that no query can ever "leak" data from one tenant to another.
- **`current_setting('app.region')`**: A native Postgres function. The Data Fabric "injects" context into every database session at the start of a request (e.g., `SET app.region = 'US'`). RLS policies use this to filter data based on the user's current geographic or organizational context.

#### **2. ENUM Usage & Cross-Reference Logic**
When you define an `ENUM` resource, the Fabric handles it differently based on the engine:

- **Postgres (SQL)**: Creates a physical `TYPE ... AS ENUM`. The table column then uses this custom type.
- **MongoDB (NoSQL)**: Since Mongo doesn't have a physical ENUM type, the Fabric uses the Metadata to generate **JSON Schema Enum Validation**. This enforces that any document inserted into the `shipments` collection *must* have a `status` field matching the allowed values.

The `ref` field in the table definition tells the Fabric to look up the ENUM resource definition in the `resources` array to find the allowed values.

#### **3. Materialized View Automation & Use Cases**
To maintain performance without manual intervention, the Fabric Orchestrator utilizes the `refreshStrategy` and `refreshInterval` directives. 

**When to use a Materialized View (MV):**
- **Dashboard Aggregations**: Use an MV for `SUM`, `COUNT`, and `AVG` over large datasets where real-time calculation is too expensive.
- **Cross-Source Snapshots**: Use an MV to "flatten" data from heterogeneous sources (e.g., Postgres + MongoDB) into a single physical table to avoid slow virtual joins.
- **High-Frequency Reads**: If a complex view is being queried 100+ times per second, materialize it to reduce CPU load.

**How it works:**
- **Background Scheduling**: The Orchestrator parses the `refreshInterval` and schedules a background job (e.g., via `node-cron` or `BullMQ`). This ensures the "analytical snapshot" is never older than the defined interval.
- **Non-Blocking Access**: By using `CONCURRENTLY`, the Fabric ensures that `SELECT` queries are never blocked during a refresh. This requires a `UNIQUE INDEX` on the Materialized View, which the Fabric provisions automatically based on the `indexes` array in the AST.

---

### 8.8 Materialized View Configuration Reference
This section provides the exhaustive dictionary of allowed values for industrial analytical views.

| Property | Allowed Values | Logic / Behavior |
| :--- | :--- | :--- |
| **`refreshStrategy`** | `STANDARD`, `CONCURRENTLY`, `INCREMENTAL` | `STANDARD` locks the table. `CONCURRENTLY` allows reads during update (requires Unique Index). `INCREMENTAL` uses CDC for diff-only updates. |
| **`refreshInterval`** | `"N [minutes/hours/days]"`, `"CRON_EXPRESSION"`, `"ON_DEMAND"` | Defines the background heartbeat. Use Cron (e.g., `"0 0 * * *"`) for precision scheduling. |
| **`query` (Structured)** | `{ "select": [], "from": "", ... }` | Full AST-based definition. Recommended for cross-source federation and automatic validation. |
| **`query` (Raw)** | `"SELECT ... FROM ..."` | Direct engine-specific query string. Used for legacy SQL or complex native functions. |

#### **Select Column Syntax (Structured)**
In Structured mode, columns can be defined using the following patterns:

##### **A. Aggregated Objects**
Used for computing metrics across groups.

| Method | Example AST Object | Output (SQL) |
| :--- | :--- | :--- |
| **`COUNT`** | `{ "column": "*", "aggregate": "COUNT", "alias": "total" }` | `COUNT(*) AS total` |
| **`COUNT_DISTINCT`** | `{ "column": "user_id", "aggregate": "COUNT_DISTINCT", "alias": "unique_users" }` | `COUNT(DISTINCT user_id) AS unique_users` |
| **`SUM`** | `{ "column": "amount", "aggregate": "SUM", "alias": "total_rev" }` | `SUM(amount) AS total_rev` |
| **`AVG`** | `{ "column": "age", "aggregate": "AVG", "alias": "avg_age" }` | `AVG(age) AS avg_age` |
| **`MIN / MAX`** | `{ "column": "price", "aggregate": "MAX", "alias": "top_price" }` | `MAX(price) AS top_price` |
| **`STRING_AGG`** | `{ "column": "tag", "aggregate": "STRING_AGG", "params": [","], "alias": "tags" }` | `STRING_AGG(tag, ',') AS tags` |

##### **B. Expression Objects**
Used for calculations, formatting, and logic within a single row.

| Type | Example AST Object | Output (SQL) |
| :--- | :--- | :--- |
| **Arithmetic** | `{ "expression": "(price + tax) * quantity", "alias": "line_total" }` | `((price + tax) * quantity) AS line_total` |
| **String Logic** | `{ "expression": "UPPER(city) || ', ' || country", "alias": "location" }` | `(UPPER(city) || ', ' || country) AS location` |
| **Conditional** | `{ "expression": "CASE WHEN status = 'ERR' THEN 1 ELSE 0 END", "alias": "is_fail" }` | `(CASE WHEN status = 'ERR' ...) AS is_fail` |
| **JSON Path** | `{ "expression": "metadata->'shipping'->>'carrier'", "alias": "carrier" }` | `(metadata->'shipping'->>'carrier') AS carrier` |
| **Date Logic** | `{ "expression": "DATE_TRUNC('month', created_at)", "alias": "month_bucket" }` | `(DATE_TRUNC('month', created_at)) AS month_bucket` |
| **Type Cast** | `{ "expression": "payload::text", "alias": "raw_str" }` | `(payload::text) AS raw_str` |

##### **C. Real-World Complex Blueprint: The "Unified Performance Index"**
This example demonstrates a cross-source virtual join between **Sales (SQL)** and **Customer Feedback (NoSQL)** with complex row logic.

```json
{
  "type": "MATERIALIZED_VIEW",
  "name": "regional_performance_index",
  "federationStrategy": "VIRTUAL",
  "refreshInterval": "6 hours",
  "query": {
    "select": [
      "s.region",
      { "column": "s.amount", "aggregate": "SUM", "alias": "total_sales" },
      { "column": "r.rating", "aggregate": "AVG", "alias": "avg_customer_score" },
      { 
        "expression": "CASE WHEN SUM(s.amount) > 100000 AND AVG(r.rating) > 4.5 THEN 'ELITE' ELSE 'GROWTH' END", 
        "alias": "tier_status" 
      }
    ],
    "from": { "resource": "shipments", "alias": "s" },
    "joins": [
      { 
        "type": "LEFT", 
        "source": "Feedback_Mongo", 
        "resource": "reviews", 
        "alias": "r", 
        "on": "s.id = r.shipment_id" 
      }
    ],
    "where": [
      { "column": "s.deleted_at", "operator": "IS_NULL" },
      { "expression": "s.created_at > NOW() - INTERVAL '90 days'" }
    ],
    "groupBy": ["s.region"]
  }
}
```

#### **8.9 Engineering Rules for AST Construction**
To ensure high-performance federation and cross-engine compatibility, developers must follow these "Golden Rules":

1.  **Alias Discipline**: In any Join or View, always use explicit table aliases (`s.id`, `r.name`). Never rely on implicit column names to avoid "ambiguous column" errors during federation.
2.  **The "Safety Net" Principle**: When performing math in expressions, always use `COALESCE(val, 0)` to prevent a single NULL value from zeroing out an entire calculation.
3.  **Standardized Logic**: Use standard SQL functions (`UPPER`, `TRIM`, `DATE_TRUNC`) that the Fabric's translation compiler can easily map to NoSQL equivalents.
4.  **Expression Priority**: Keep `CASE` statements and complex logic inside the `expression` object. Do not mix raw SQL logic into the `column` name field.
5.  **Predicate Ordering**: Put the most restrictive filters (e.g., `tenant_id` or `deleted_at`) at the top of the `where` array to optimize query planning.
6.  **Explicit Casting**: Use type casts (e.g., `::numeric`, `::text`) for all cross-source math to ensure the Orchestrator handles precision correctly across different DB engines.
7.  **Explicit Column Selection**: Never use `SELECT *` in any View (Standard or Materialized). Standard Views "freeze" column lists at creation time, meaning they won't automatically see new source columns. Explicitly defining columns ensures "Contract Stability," prevents accidental leakage of sensitive fields, and optimizes network bandwidth by only fetching the data required for the specific business logic.

---

### 8.10 Cardinality Mechanics: Single vs. Multiple Datasources
When transitioning from a monolithic database to a Data Fabric, the nature of relationships changes from **Physical Enforcement** to **Logical Orchestration**.

#### **A. Single Datasource (Physical Cardinality)**
In a single database (e.g., Postgres-only), cardinality is enforced by the engine itself:
- **Foreign Keys (FK)**: The database physically prevents "Orphan" records. You cannot delete a Parent if a Child exists.
- **Native Joins**: The engine uses local indexes to perform joins with near-zero latency.
- **Integrity**: 100% guaranteed by the ACID properties of the database.

#### **B. Multiple Datasources (Logical Cardinality)**
When linking heterogeneous sources (e.g., Postgres to MongoDB), cardinality is virtual:
- **Orchestrator-Driven**: There are no physical Foreign Keys across the network. The Fabric Orchestrator "logicalizes" the link by fetching IDs from Source A and querying them in Source B.
- **Integrity & Sagas**: Since databases cannot communicate FKs, the Fabric must use **Distributed Sagas** or background workers to handle "Cascading Deletes" and prevent orphans.
- **M:N Bridge Strategy**: For Many-to-Many relationships across sources, the **Fabric Hub (Postgres)** typically hosts the Bridge Table, acting as the "unifying ledger" between the two external worlds.

#### **C. Comparison Matrix**
| Feature | Single Source (Postgres) | Multi-Source (SQL + NoSQL) |
| :--- | :--- | :--- |
| **Mechanism** | Physical Foreign Keys | Logical Metadata Mapping |
| **Enforcement** | Database Constraint | Orchestrator Code / Sagas |
| **Performance** | Local Index Join | Distributed Virtual Join |
| **Orphan Risk** | Impossible | High (Requires Fabric Cleanup) |

---

### 8.11 Relationship Configuration Reference
This section defines the rules for connecting entities across the Data Fabric using the `relationships` array.

#### **1. The `from` and `to` Objects**
These define the direction and fields of the link.
- **`resource` (Required)**: The name of the table or collection.
- **`field` (Required)**: The primary or foreign key used for the join.
- **`source` (Conditional)**: 
    - **Rule**: Only include if the resource lives in a **different** database than the `targetSource` defined at the top of the AST.
    - **Usage**: Used to trigger the Orchestrator's "Virtual Join" logic across the network.

#### **2. Cardinality-Specific Requirements**
| Cardinality | Mandatory Fields | Implementation Rule |
| :--- | :--- | :--- |
| **`1:1`** | `from`, `to` | Usually used for table splitting (e.g., `shipments` to `shipment_details`). Ensure both sides have unique indexes on the join fields. |
| **`1:M`** | `from`, `to` | The "Standard" parent-child link. `from` is always the Parent (One); `to` is always the Child (Many). |
| **`M:N`** | `from`, `to`, `bridge` | **`bridge` is Required.** You must specify the name of the link table that contains the mapping between the two resources. |

#### **3. Cross-Source Federation Rule**
If the `source` property in the `from` block does not match the `source` in the `to` block, the Data Fabric automatically upgrades the link to a **Federated Relationship**.
- **Behavior**: The Fabric Hub will fetch data from both sources and perform an in-memory hash-join.
- **Integrity**: Physical constraints (FKs) are ignored; the link is maintained purely through Metadata.

---

## 9. Concurrency & Enterprise Scalability
To support **10,000+ concurrent users**, the Data Fabric moves from a single instance to a distributed, high-availability architecture.

### 9.1 Session & Context Isolation
- **Stateless Orchestration**: Backend instances are stateless. Context (Tenant, Region, User) is injected into the database session *per request* using `SET` commands.
- **No Data Leakage**: Session variables are local to the connection. Multiple users can share the same connection pool without seeing each other's security context.

### 9.2 The High-Concurrency Roadmap
| Component | Scaling Strategy | Tooling |
| :--- | :--- | :--- |
| **Backend** | Horizontal Auto-scaling | Kubernetes (K8s) |
| **DB Connection Pool** | Industrial-grade multiplexing | **PgBouncer** |
| **Read Load** | Distributed query execution | **Postgres Read Replicas** |
| **Metadata Lookup** | Microsecond caching | **Redis** |
| **NoSQL Access** | Horizontal partitioning | **MongoDB Sharding** |

---

## 10. Implementation Lifecycle
- **Unified DDL Generator**: Translate the v4.0 AST into dialect-specific commands.
- **Adaptive Query Engine**: Implement name-based resolution and ID-fallback logic.
- **Real-time Catalog Sync**: Use CDC (Change Data Capture) to keep the Catalog in sync with schema evolution automatically.

---

## 11. Engineering Deep-Dive: Universal Feature Translation
This section details the internal mechanics, safety guarantees, and failure modes for every metadata attribute across heterogeneous sources.

### 11.1 Identity & Sequence Orchestration
| Resource | SQL (Postgres) | NoSQL (MongoDB) |
| :--- | :--- | :--- |
| **SEQUENCE** | Native `SEQUENCE` | **Virtual Counter Collection** |

- **How it Works (NoSQL)**: The Fabric maintains a `__fabric_counters` collection.
    - **Atomicity**: Uses MongoDB's atomic `findAndModify` with `{ upsert: true, new: true }`. This ensures that even with 100 concurrent requests, no two users get the same sequence number.
    - **Industrial Edge Case**: If the counters collection is unavailable, the Orchestrator queues the request with an exponential backoff. For ultra-high scale, we recommend the **Decentralized Strategy** (UUIDv7) to avoid this single-document bottleneck.
- **Identity Strategies**:
    - **UUID_V7**: Generated at the **Orchestrator Layer**. It includes a 48-bit timestamp, ensuring it is naturally k-sortable (indexed efficiently) without a database round-trip.

### 11.2 Security & Virtual Isolation Layer
| Feature | SQL (Postgres) | NoSQL (MongoDB) |
| :--- | :--- | :--- |
| **RLS Policy** | Native `POLICY` | **Filter Injection Engine** |

- **How it Works (NoSQL)**: 
    - **Sanitization**: Before execution, the Query Engine parses the user's incoming query. It forcibly prepends a `$match` stage derived from the RLS metadata. 
    - **Safety Guarantee**: Users cannot override this injected stage. If a user tries to inject their own `$match` that conflicts with the RLS, the Orchestrator rejects the query.
- **Data Masking**: 
    - **Middleware Projection**: Masking is enforced by an mandatory `$project` stage. Even if a user runs `db.collection.find({})`, the Fabric's Query Engine rewrites the response projection to redact PII (e.g., `email: { $cond: [is_admin, "$email", "REDACTED"] }`).

### 11.3 Table Constraints & Logic
| Feature | SQL (Postgres) | NoSQL (MongoDB) |
| :--- | :--- | :--- |
| **CONSTRAINTS** | Native `CHECK` | **JSON Schema + Middleware** |

- **How it Works (NoSQL)**: 
    - **Schema Level**: Translated to `$jsonSchema` validator. This is enforced by the database engine itself for simple type and range checks.
    - **Logic Level (Exclusion)**: For complex exclusion constraints (e.g., "no overlapping bookings"), MongoDB has no native support. The Fabric implements a **Distributed Lock** using Redis or the Hub DB. The Orchestrator acquires a lock on the "range" before allowing the write to MongoDB.
- **Triggers**: 
    - **Change Stream Reliability**: The Fabric uses **Resume Tokens** for MongoDB Change Streams. If the Orchestrator restarts, it picks up exactly where it left off, ensuring no "Trigger" events are ever missed.

### 11.4 View & Materialized View Orchestration
| Feature | SQL (Postgres) | NoSQL (MongoDB) |
| :--- | :--- | :--- |
| **MATERIALIZED** | Native `MAT VIEW` | **Atomic Merge Strategy** |

- **How it Works (NoSQL)**: 
    - **Refresh Atomicity**: When a refresh is triggered, the Fabric executes the aggregation pipeline into a **Temporary Collection**. Once the pipeline completes successfully, it uses the `$merge` operator to update the production view collection atomically.
    - **Failure Mode**: If the refresh pipeline fails, the production view remains untouched. The system logs a "Stale Data" alert but maintains read-availability.
- **Standard Views**: 
    - **Performance Warning**: Since MongoDB `$lookup` (Joins) are not as optimized as SQL joins, the Fabric's Query Engine automatically adds **Index Hints** to the view's aggregation pipeline to prevent full collection scans.

### 11.5 Resource Dependencies & Ordering
The Fabric uses a **Directed Acyclic Graph (DAG)** to apply metadata.
1. **Infrastructure**: Extensions and custom ENUM types.
2. **Identity**: Sequences and Identity-generating functions.
3. **Storage**: Tables (with partitions and physical indexes).
4. **Security**: RLS Policies and Masking rules.
5. **Virtualization**: Views and Materialized Views (which depend on tables).
6. **Logic**: Triggers and Procedures (which depend on views/tables).

---

## 13. Data Access Pillar: The "Lens" (READ Architecture)
The Data Fabric acts as a unified lens, allowing you to "look through" multiple data silos as if they were a single database.

### 13.1 Comparing Joining Strategies
| Feature | **Virtual Join** (In the App) | **FDW Join** (In the Database) |
| :--- | :--- | :--- |
| **Logic Location** | Fabric Orchestrator (Node.js) | Hub Postgres Engine |
| **Setup** | Zero Configuration | Requires "Mounting" Source |
| **Performance** | Good for small/medium data | **High** (Optimized by SQL Engine) |
| **Capability** | Simple Matching logic | Full SQL Power (Joins, CTEs) |

- **Virtual Joins**: The Orchestrator pulls raw data from Postgres and MongoDB separately and "zips" them together in memory. This is the default for most cloud-native requests.
- **FDW Joins**: For heavy analytics, we "mount" MongoDB inside Postgres. This allows the Postgres Query Planner to perform massive joins with surgical precision.

---

## 14. Data Mutation Pillar: The "Nervous System" (WRITE Architecture)
This pillar ensures that every update sent to the Fabric is safely transmitted to every relevant source, keeping the entire ecosystem in sync.

### 14.1 The Distributed Write Lifecycle
When a user sends a write request (INSERT/UPDATE/DELETE) to the Fabric API, the system follows this deterministic flow:

1. **Identification**: The Orchestrator looks at the `targetSource` in the resource metadata.
2. **Translation**: The **Connector Layer** translates the AST write command into the native dialect:
    - **SQL**: `UPDATE shipments SET status = 'DELIVERED' WHERE id = 101`
    - **NoSQL**: `db.shipments.updateOne({ _id: 101 }, { $set: { status: 'DELIVERED' } })`
3. **Saga Orchestration (Multi-Source Integrity)**:
    - If the write impacts multiple sources (e.g., Postgres and MongoDB), the Orchestrator starts a **Saga**.
    - **Step A**: Update the primary source (e.g., Postgres).
    - **Step B**: Update the secondary source (e.g., MongoDB Activity Log).
    - **Failure Protection**: If Step B fails, the Orchestrator automatically issues a **Compensating Transaction** to the primary source to "roll back" the change, ensuring both databases stay in sync.
4. **Synchronous Cache Invalidation**: The Orchestrator immediately updates or invalidates the relevant **Redis** cache keys so that subsequent reads for all 10,000+ users reflect the fresh data instantly.
5. **Asynchronous CDC Push**: Once the primary write is confirmed, the **CDC (Change Data Capture)** engine detects the change and pushes the update to peripheral systems like ElasticSearch (for search) or Snowflake (for long-term analytics) without blocking the user's request.

### 14.2 Consistency Models
| Strategy | Implementation | Trade-off |
| :--- | :--- | :--- |
| **Strong Consistency** | Direct native write | Limited to a single database engine. |
| **Eventual Consistency** | CDC / Background Sync | Ultra-high performance, but slight delay for secondary sources. |
| **Orchestrated Consistency** | **The Saga Pattern** | Bridges heterogeneous sources with built-in rollback logic. |

---

## 15. The Unified Industrial Workflow: A Case Study
To visualize how these pillars interact, consider a **User Profile Update**:

1. **The Mutation (Nervous System)**:
    - User uploads a new profile picture.
    - **Saga** triggers: Save the URL in **Postgres** (User Table) AND log the event in **MongoDB** (Activity Audit).
    - **Write-Through**: The user's **Redis** session is updated instantly.
2. **The Access (The Lens)**:
    - A friend visits the profile. The Fabric runs a **Virtual Join** between Postgres (Profile Data) and MongoDB (Latest Posts) to show the new picture and the user's recent activity in one screen.
3. **The Global Sync (CDC)**:
    - **CDC** detects the update and pushes the new picture URL to **ElasticSearch** (so the user is searchable by status) and **Snowflake** (for marketing analytics).

---

## 16. Why This Architecture is Non-Negotiable (The Industrial Result)
By combining these concepts, we aren't just building a backend; we are building a **Data Operating System**. Here is why each pillar is essential:

- **Metadata AST**: This is our "Single Source of Truth." Without it, developers are forced back into the nightmare of writing hard-coded queries for every different database engine.
- **Virtual & FDW Joins**: These are our "Silo Breakers." Without them, users are forced to manually combine data in Excel or across separate, disconnected applications.
- **Sagas & CDC**: These ensure "Data Integrity." Without them, your Postgres transaction data and your MongoDB activity data will inevitably drift apart and become inconsistent.
- **RLS & Masking**: These provide "Enterprise Security." Without them, you risk catastrophic data leaks and failure to meet global compliance standards (GDPR, HIPAA).
- **Logical Addressing (DataSource.Schema.Table)**: This is our "Resilience Engine." Without it, your entire application crashes if a physical database is moved or a UUID is reset.

### The Industrial Result
Our Data Fabric platform enables a new paradigm where your team can:
1. **Provision**: Deploy a complex, heterogeneous schema in seconds.
2. **Query**: Access data across 5+ different databases as if they were a single local table.
3. **Secure**: Enforce security and masking automatically based on user roles, regardless of where the data lives.
4. **Scale**: Support 10,000+ concurrent users without compromising database stability or performance.

---

## 18. Downstream Consumers: Operational vs Analytical
The Fabric routes data to different engines based on the "Job-to-be-Done," ensuring maximum efficiency and cost-control.

### 18.1 Efficiency Comparison
| Feature | **ElasticSearch** (Operational) | **Snowflake** (Analytical) |
| :--- | :--- | :--- |
| **Primary Use** | High-speed User Search | Deep Business Intelligence |
| **Data Model** | Inverted Text Index | Columnar Warehouse |
| **Concurrency** | Optimized for 10,000+ Users | Optimized for 10-100 Analysts |
| **Latency** | < 50ms (Instant) | 1s - 10m (Batch/Complex) |

- **Why we need both**: Using Snowflake for real-time search is too slow and expensive. Using ElasticSearch for massive financial aggregations is inefficient. The Fabric uses CDC to feed both simultaneously.

---

## 19. Graceful Degradation & Optional Connectors
The Data Fabric treats downstream systems as **Optional Enhancements**. The core application must remain functional even if search or analytics are disabled or down.

### 19.1 Settings-Driven Toggles
Every connector in the AST/Config includes an `enabled: true/false` flag.
- **If Disabled**: The Orchestrator and CDC engine skip the target entirely, incurring zero performance overhead.

### 19.2 The "Safe-to-Fail" Fallback Strategy
| System | Failure/Disabled Mode | Fallback Action |
| :--- | :--- | :--- |
| **ElasticSearch** | Disabled/Down | **Query Fallback**: Automatically switch to native SQL `LIKE`/`ILIKE` on Postgres. |
| **Snowflake** | Disabled/Down | **Queueing**: Ignore update or queue for later sync. Core transactions continue. |
| **Redis** | Disabled/Down | **Bypass**: Route all requests directly to the DB. (Slower, but functional). |

### 19.3 Circuit Breakers
To prevent "Cascading Failures," the Fabric uses circuit breakers for all downstream connectors. If a system (e.g., Snowflake) is reachable but timing out, the Fabric "trips" the breaker, immediately failing downstream calls for a cooling-off period to protect the primary API responsiveness.

---

## 20. Final Roadmap for Implementation
1. **Metadata Compiler**: Build the logic to transform AST into SQL/NoSQL DDL.
2. **Federated Engine**: Implement the "Virtual Join" and "Search Fallback" logic.
3. **Consistency Manager**: Build the Saga orchestration and compensation handlers.
4. **Resilience Layer**: Implement the Circuit Breaker and logical addressing logic.
