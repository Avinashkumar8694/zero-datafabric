# How to Create & Use Custom Functions and Sequences

This guide walks through defining custom database functions and sequences inside metadata manifests, binding them to table columns, and invoking them through the query engine **across all supported data sources**, complete with executable `curl` commands.

---

## 1. Multi-Engine Architecture Overview

The Zero Data Fabric uses a **capability compensation** pattern to deliver consistent function and sequence behavior across heterogeneous engines:

| Capability | PostgreSQL | MySQL | MongoDB | Elasticsearch |
|:---|:---|:---|:---|:---|
| `CREATE SEQUENCE` | ✅ Native | ❌ No native sequences | ❌ No sequences | ❌ No sequences |
| `CREATE FUNCTION` | ✅ PL/pgSQL | ❌ Not managed via manifest | ❌ Not applicable | ❌ Not applicable |
| Auto-increment ID | ✅ `SERIAL` / `IDENTITY` | ✅ `AUTO_INCREMENT` | ❌ Uses `ObjectId` | ❌ Uses `_id` |
| **Fabric Sequence** | ✅ Available | ✅ Available | ✅ Available | ✅ Available |
| **Fabric Function** | ✅ Available | ✅ Available | ✅ Available | ✅ Available |

### How It Works:

```
┌─────────────────────────────────────────────────────────────────────┐
│                       Zero Data Fabric Hub                          │
│                                                                     │
│  ┌─────────────────────┐     ┌──────────────────────────────────┐  │
│  │  FabricSequenceService│     │  Hub-Hosted Functions             │  │
│  │  (fabric_sequences)  │     │  (PL/pgSQL in hub Postgres)       │  │
│  └─────────┬───────────┘     └──────────┬───────────────────────┘  │
│            │                            │                           │
│  ┌─────────▼────────────────────────────▼───────────────────────┐  │
│  │  FabricWriteGenerators (capability compensation)              │  │
│  │  At write-time: resolves UUIDs, sequences, custom functions   │  │
│  │  BEFORE dispatching the row to the target engine              │  │
│  └──────────────────────────────────────────────────────────────┘  │
│            │              │               │              │          │
│      ┌─────▼────┐  ┌─────▼────┐  ┌───────▼──────┐  ┌───▼────┐    │
│      │ Postgres  │  │  MySQL   │  │   MongoDB    │  │   ES   │    │
│      │ (native)  │  │ (INSERT) │  │ (insertOne)  │  │(index) │    │
│      └──────────┘  └──────────┘  └──────────────┘  └────────┘    │
└─────────────────────────────────────────────────────────────────────┘
```

**Key principle**: Functions and sequences are **always defined on the Hub Postgres**. When you write to **any** data source, the `FabricWriteGenerators` engine calls the hub-hosted function or sequence **first**, resolves the value, and then sends the completed row to the target engine.

---

## 2. Supported Resource Parameters

### Function Resource (`type: "FUNCTION"`)
* **`name`**: `String` | Required. Function identifier.
* **`arguments`**: `Array` | Input parameters:
  * `name`: `String` | Argument name.
  * `type`: `String` | Data type: `'STRING' | 'INTEGER' | 'BIGINT' | 'NUMERIC' | 'BOOLEAN' | 'UUID' | 'TIMESTAMP' | 'JSONB' | 'TEXT'`
  * `default`: `Any` | Optional default value.
  * `mode`: `String` | Parameter mode: `'IN'` (default) | `'OUT'` | `'INOUT'`.
* **`returnType`**: `String` | Output data type (same enum as above, plus `'VOID'` and `'TRIGGER'`).
* **`language`**: `String` | Procedural language:
  * `"plpgsql"` — PL/pgSQL (default).
  * `"sql"` — Pure SQL function.
* **`volatility`**: `String` | Caching hint:
  * `"VOLATILE"` — Result changes on every call (default).
  * `"STABLE"` — Result doesn't change within a single query.
  * `"IMMUTABLE"` — Result never changes for same inputs; can be indexed.
* **`body`**: `String` | Function body code.

### Sequence Resource (`type: "SEQUENCE"`)
* **`name`**: `String` | Required. Sequence identifier.
* **`start`**: `Integer` | Starting value (default: `1`).
* **`increment`**: `Integer` | Step value (default: `1`).
* **`minValue`**: `Integer` | Minimum boundary.
* **`maxValue`**: `Integer` | Maximum boundary.
* **`cache`**: `Integer` | Pre-allocated count.
* **`cycle`**: `Boolean` | Wrap around at boundaries (default: `false`).
* **`ownedBy`**: `Object` | Auto-drop with table:
  * `table`: `String` | Target table.
  * `column`: `String` | Target column.

### Write Generator Rule (`generate` block in `queryConfig`)
Used at write-time to invoke hub-hosted generators for any engine:
* **UUID strategy**: `{ "strategy": "UUID_V7" }` — Hub's `uuid_generate_v7()` with JS fallback.
* **Sequence**: `{ "sequence": "seq_name", "start": 1, "increment": 1 }` — Fabric sequence engine.
* **Function**: `{ "function": "fn_name", "args": [...], "schema": "LogicalSchema" }` — Hub-hosted function call.

---

## 3. API Endpoint for Manifest Application

All manifests below are applied via:

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

---

## 4. Scenario 1 — PostgreSQL: Invoice Generator (Function + Sequence as Column Default)

**Goal**: Create a sequence `invoice_seq` and a function `generate_invoice_no(prefix)` that produces formatted invoice numbers like `INV-26-000042`, bound as the default for the `invoice_no` column.

### Manifest (`manifest.json`):
```json
{
  "version": "4.0",
  "namespace": "Billing_Core",
  "targetSource": "Fabric_Hub_Postgres",
  "schemas": [
    {
      "name": "billing",
      "resources": [
        {
          "type": "SEQUENCE",
          "name": "invoice_seq",
          "start": 1,
          "increment": 1,
          "cache": 20
        },
        {
          "type": "FUNCTION",
          "name": "generate_invoice_no",
          "arguments": [
            { "name": "p_prefix", "type": "STRING" }
          ],
          "returnType": "STRING",
          "language": "plpgsql",
          "volatility": "VOLATILE",
          "body": "DECLARE v_seq BIGINT; BEGIN v_seq := nextval('billing.invoice_seq'); RETURN p_prefix || '-' || to_char(NOW(), 'YY') || '-' || lpad(v_seq::text, 6, '0'); END;"
        },
        {
          "type": "TABLE",
          "name": "invoices",
          "columns": [
            { "name": "id", "type": "UUID", "strategy": "UUID_V7", "primaryKey": true },
            { "name": "invoice_no", "type": "STRING", "length": 20, "default": "generate_invoice_no('INV')", "unique": true },
            { "name": "customer_id", "type": "UUID", "nullable": false },
            { "name": "total", "type": "NUMERIC", "nullable": false },
            { "name": "created_at", "type": "TIMESTAMP", "default": "NOW()" }
          ]
        }
      ]
    }
  ]
}
```

### Apply:
```bash
curl -X POST http://localhost:4000/api/metadata/apply \
  -H "Authorization: Bearer $JWT_TOKEN" \
  -H "x-tenant-id: tenant_A" \
  -F "file=@manifest.json"
```

### Compiled SQL:
```sql
CREATE SEQUENCE "billing"."invoice_seq" START WITH 1 INCREMENT BY 1 CACHE 20;

CREATE OR REPLACE FUNCTION "billing"."generate_invoice_no"(p_prefix VARCHAR)
RETURNS VARCHAR LANGUAGE plpgsql VOLATILE AS $$
DECLARE v_seq BIGINT;
BEGIN
  v_seq := nextval('billing.invoice_seq');
  RETURN p_prefix || '-' || to_char(NOW(), 'YY') || '-' || lpad(v_seq::text, 6, '0');
END;
$$;

CREATE TABLE IF NOT EXISTS "billing"."invoices" (
  "id" UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  "invoice_no" VARCHAR(20) UNIQUE DEFAULT billing.generate_invoice_no('INV'),
  "customer_id" UUID NOT NULL,
  "total" NUMERIC NOT NULL,
  "created_at" TIMESTAMP DEFAULT NOW()
);
```

### Insert (auto-generated invoice number):
```bash
curl -X POST http://localhost:4000/api/data/create \
  -H "Authorization: Bearer $JWT_TOKEN" \
  -H "x-tenant-id: tenant_A" \
  -H "Content-Type: application/json" \
  -d '{
    "source": "Fabric_Hub_Postgres",
    "resource": "invoices",
    "data": {
      "customer_id": "0190a5f2-bbc2-4e95-b20b-6b518e95b25c",
      "total": 1250.00
    }
  }'
```

### Response:
```json
{
  "id": "019a1b2c-3d4e-7f00-8a9b-0c1d2e3f4a5b",
  "invoice_no": "INV-26-000001",
  "customer_id": "0190a5f2-bbc2-4e95-b20b-6b518e95b25c",
  "total": 1250.00,
  "created_at": "2026-07-13T17:10:00.000Z"
}
```

---

## 5. Scenario 2 — MongoDB: Sequence + Function via Write Generator

**Goal**: Insert a document into a MongoDB collection and auto-generate an `order_no` using a hub-hosted function and fabric sequence — even though MongoDB has no native sequence or function support.

### Step 1: Define the Function and Sequence on the Hub

Use the same manifest approach as Scenario 1, targeting `Fabric_Hub_Postgres`:

```json
{
  "version": "4.0",
  "namespace": "Order_Core",
  "targetSource": "Fabric_Hub_Postgres",
  "schemas": [
    {
      "name": "ordering",
      "resources": [
        {
          "type": "SEQUENCE",
          "name": "order_seq",
          "start": 50000,
          "increment": 1
        },
        {
          "type": "FUNCTION",
          "name": "generate_order_no",
          "arguments": [
            { "name": "p_region", "type": "STRING" }
          ],
          "returnType": "STRING",
          "language": "plpgsql",
          "volatility": "VOLATILE",
          "body": "DECLARE v_seq BIGINT; BEGIN v_seq := nextval('ordering.order_seq'); RETURN 'ORD-' || p_region || '-' || lpad(v_seq::text, 7, '0'); END;"
        }
      ]
    }
  ]
}
```

### Apply:
```bash
curl -X POST http://localhost:4000/api/metadata/apply \
  -H "Authorization: Bearer $JWT_TOKEN" \
  -H "x-tenant-id: tenant_A" \
  -F "file=@manifest.json"
```

### Step 2: Insert into MongoDB with the `generate` Block

The `generate` block tells the fabric to resolve values from the hub **before** dispatching the insert to MongoDB:

```bash
curl -X POST http://localhost:4000/api/analytics/query \
  -H "Authorization: Bearer $JWT_TOKEN" \
  -H "x-tenant-id: tenant_A" \
  -H "Content-Type: application/json" \
  -d '{
    "queryConfig": {
      "type": "INSERT",
      "schema": "ordering",
      "query": {
        "into": { "resource": "orders", "source": "Sales_Mongo" },
        "columns": ["order_no", "id", "customer_name", "total", "region"],
        "values": [
          [null, null, "Acme Corp", 4500.00, "US"]
        ],
        "generate": {
          "id": { "strategy": "UUID_V7" },
          "order_no": { "function": "generate_order_no", "args": ["US"], "schema": "ordering" }
        }
      }
    }
  }'
```

### What Happens Under the Hood:
1. `FabricWriteGenerators.resolve()` calls hub Postgres: `SELECT ordering.generate_order_no('US')` → returns `"ORD-US-0050000"`
2. `FabricWriteGenerators.resolve()` calls hub Postgres: `SELECT public.uuid_generate_v7()::text` → returns a UUID
3. The completed document is sent to MongoDB: `db.orders.insertOne({ id: "019a...", order_no: "ORD-US-0050000", customer_name: "Acme Corp", ... })`

### Response:
```json
{
  "id": "019a1b2c-3d4e-7f00-8a9b-0c1d2e3f4a5b",
  "order_no": "ORD-US-0050000",
  "customer_name": "Acme Corp",
  "total": 4500.00,
  "region": "US"
}
```

---

## 6. Scenario 3 — MySQL: Fabric Sequence (No Custom Function)

**Goal**: Insert into a MySQL table and auto-generate a `ticket_no` from the fabric sequence engine — without any custom function, just a raw sequence.

### Step 1: Register the Sequence on the Hub

```json
{
  "version": "4.0",
  "namespace": "Support_Core",
  "targetSource": "Fabric_Hub_Postgres",
  "schemas": [
    {
      "name": "support",
      "resources": [
        {
          "type": "SEQUENCE",
          "name": "ticket_seq",
          "start": 100000,
          "increment": 1
        }
      ]
    }
  ]
}
```

### Apply:
```bash
curl -X POST http://localhost:4000/api/metadata/apply \
  -H "Authorization: Bearer $JWT_TOKEN" \
  -H "x-tenant-id: tenant_A" \
  -F "file=@manifest.json"
```

### Step 2: Insert into MySQL with the `generate` Block

```bash
curl -X POST http://localhost:4000/api/analytics/query \
  -H "Authorization: Bearer $JWT_TOKEN" \
  -H "x-tenant-id: tenant_A" \
  -H "Content-Type: application/json" \
  -d '{
    "queryConfig": {
      "type": "INSERT",
      "schema": "support",
      "query": {
        "into": { "resource": "tickets", "source": "Support_MySQL" },
        "columns": ["id", "ticket_no", "title", "status"],
        "values": [
          [null, null, "Login page broken on Safari", "OPEN"]
        ],
        "generate": {
          "id": { "strategy": "UUID_V7" },
          "ticket_no": { "sequence": "ticket_seq", "start": 100000, "increment": 1 }
        }
      }
    }
  }'
```

### What Happens Under the Hood:
1. `FabricSequenceService.nextval("tenant_A", "ticket_seq")` → atomic `INSERT … ON CONFLICT DO UPDATE … RETURNING` on `fabric_system.fabric_sequences` → returns `100000`
2. `uuid_generate_v7()` → returns a UUID
3. Completed row sent to MySQL: `INSERT INTO tickets (id, ticket_no, title, status) VALUES ('019a...', 100000, 'Login page broken on Safari', 'OPEN')`

### Response:
```json
{
  "id": "019b2c3d-4e5f-7a00-8b9c-0d1e2f3a4b5c",
  "ticket_no": 100000,
  "title": "Login page broken on Safari",
  "status": "OPEN"
}
```

---

## 7. Scenario 4 — Elasticsearch: UUID Generation via Write Generator

**Goal**: Index a document into Elasticsearch with a fabric-generated UUID as the `_id`.

```bash
curl -X POST http://localhost:4000/api/analytics/query \
  -H "Authorization: Bearer $JWT_TOKEN" \
  -H "x-tenant-id: tenant_A" \
  -H "Content-Type: application/json" \
  -d '{
    "queryConfig": {
      "type": "INSERT",
      "schema": "search",
      "query": {
        "into": { "resource": "product_catalog", "source": "Search_Elasticsearch" },
        "columns": ["id", "name", "category", "price"],
        "values": [
          [null, "Industrial Valve X200", "HVAC", 899.99]
        ],
        "generate": {
          "id": { "strategy": "UUID_V7" }
        }
      }
    }
  }'
```

### Response:
```json
{
  "id": "019c3d4e-5f6a-7b00-9c0d-1e2f3a4b5c6d",
  "name": "Industrial Valve X200",
  "category": "HVAC",
  "price": 899.99
}
```

---

## 8. Scenario 5 — PostgreSQL: Trigger Function (Auto-Stamp `updated_at`)

**Goal**: Create a function returning `TRIGGER` that auto-stamps `updated_at` on every row update.

### Manifest (`manifest.json`):
```json
{
  "version": "4.0",
  "namespace": "Governance_Core",
  "targetSource": "Fabric_Hub_Postgres",
  "schemas": [
    {
      "name": "public",
      "resources": [
        {
          "type": "FUNCTION",
          "name": "set_updated_at",
          "arguments": [],
          "returnType": "TRIGGER",
          "language": "plpgsql",
          "volatility": "VOLATILE",
          "body": "BEGIN NEW.updated_at := NOW(); RETURN NEW; END;"
        },
        {
          "type": "TABLE",
          "name": "shipments",
          "columns": [
            { "name": "id", "type": "UUID", "strategy": "UUID_V7", "primaryKey": true },
            { "name": "region", "type": "STRING", "length": 10 },
            { "name": "status", "type": "STRING", "length": 20 },
            { "name": "total_amount", "type": "NUMERIC" },
            { "name": "updated_at", "type": "TIMESTAMP", "default": "NOW()" }
          ],
          "triggers": [
            {
              "name": "trg_set_updated_at",
              "timing": "BEFORE",
              "events": ["UPDATE"],
              "execution": "row",
              "procedure": "set_updated_at"
            }
          ]
        }
      ]
    }
  ]
}
```

### Apply:
```bash
curl -X POST http://localhost:4000/api/metadata/apply \
  -H "Authorization: Bearer $JWT_TOKEN" \
  -H "x-tenant-id: tenant_A" \
  -F "file=@manifest.json"
```

### Compiled SQL:
```sql
CREATE OR REPLACE FUNCTION "public"."set_updated_at"()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  NEW.updated_at := NOW();
  RETURN NEW;
END;
$$;

CREATE TRIGGER trg_set_updated_at
BEFORE UPDATE ON "public"."shipments"
FOR EACH ROW
EXECUTE FUNCTION set_updated_at();
```

### Test:
```bash
curl -X POST http://localhost:4000/api/data/update \
  -H "Authorization: Bearer $JWT_TOKEN" \
  -H "x-tenant-id: tenant_A" \
  -H "Content-Type: application/json" \
  -d '{
    "source": "Fabric_Hub_Postgres",
    "resource": "shipments",
    "where": { "id": "0190a5f2-bbc2-4e95-b20b-6b518e95b25c" },
    "data": { "status": "DELIVERED" }
  }'
```
The `updated_at` column is automatically stamped to `NOW()` by the trigger.

---

## 9. Scenario 6 — Calling a Hub Function Directly (Any Engine Context)

**Goal**: Invoke a hub-hosted function directly without inserting records.

```bash
curl -X POST http://localhost:4000/api/analytics/query \
  -H "Authorization: Bearer $JWT_TOKEN" \
  -H "x-tenant-id: tenant_A" \
  -H "Content-Type: application/json" \
  -d '{
    "queryConfig": {
      "type": "CALL",
      "schema": "billing",
      "query": {
        "procedure": "generate_invoice_no",
        "source": "Fabric_Hub_Postgres",
        "arguments": [
          { "name": "p_prefix", "type": "STRING", "value": "ORD" }
        ]
      }
    }
  }'
```

### Compiled SQL:
```sql
SELECT billing.generate_invoice_no('ORD');
-- Result: 'ORD-26-000002'
```

---

## 10. Scenario 7 — Sequence-Only Column Default (PostgreSQL Native)

**Goal**: Use a sequence directly as a column default without creating a custom function. The simplest possible pattern.

### Manifest (`manifest.json`):
```json
{
  "version": "4.0",
  "namespace": "Tracking_Core",
  "targetSource": "Fabric_Hub_Postgres",
  "schemas": [
    {
      "name": "tracking",
      "resources": [
        {
          "type": "SEQUENCE",
          "name": "ticket_seq",
          "start": 10000,
          "increment": 1,
          "ownedBy": { "table": "tickets", "column": "ticket_no" }
        },
        {
          "type": "TABLE",
          "name": "tickets",
          "columns": [
            { "name": "id", "type": "UUID", "strategy": "UUID_V7", "primaryKey": true },
            { "name": "ticket_no", "type": "BIGINT", "default": "nextval('tracking.ticket_seq')" },
            { "name": "title", "type": "STRING", "length": 200 },
            { "name": "status", "type": "STRING", "length": 20, "default": "'OPEN'" }
          ]
        }
      ]
    }
  ]
}
```

### Apply:
```bash
curl -X POST http://localhost:4000/api/metadata/apply \
  -H "Authorization: Bearer $JWT_TOKEN" \
  -H "x-tenant-id: tenant_A" \
  -F "file=@manifest.json"
```

### Insert (ticket_no auto-fills):
```bash
curl -X POST http://localhost:4000/api/data/create \
  -H "Authorization: Bearer $JWT_TOKEN" \
  -H "x-tenant-id: tenant_A" \
  -H "Content-Type: application/json" \
  -d '{
    "source": "Fabric_Hub_Postgres",
    "resource": "tickets",
    "data": {
      "title": "Login page crashes on Safari",
      "status": "OPEN"
    }
  }'
```

### Response:
```json
{
  "id": "019b2c3d-4e5f-7a00-8b9c-0d1e2f3a4b5c",
  "ticket_no": 10000,
  "title": "Login page crashes on Safari",
  "status": "OPEN"
}
```

---

## 11. Scenario 8 — Bulk MongoDB Insert with Block Sequence Allocation

**Goal**: Insert 3 MongoDB documents in one call, each getting a unique sequential `order_no` from a single atomic block allocation (no duplicates, no gaps).

```bash
curl -X POST http://localhost:4000/api/analytics/query \
  -H "Authorization: Bearer $JWT_TOKEN" \
  -H "x-tenant-id: tenant_A" \
  -H "Content-Type: application/json" \
  -d '{
    "queryConfig": {
      "type": "INSERT",
      "schema": "ordering",
      "query": {
        "into": { "resource": "orders", "source": "Sales_Mongo" },
        "columns": ["id", "order_no", "customer_name", "total"],
        "values": [
          [null, null, "Acme Corp", 1200.00],
          [null, null, "Wayne Industries", 3400.00],
          [null, null, "Stark Solutions", 7800.00]
        ],
        "generate": {
          "id": { "strategy": "UUID_V7" },
          "order_no": { "sequence": "order_seq", "start": 50000, "increment": 1 }
        }
      }
    }
  }'
```

### What Happens Under the Hood:
1. `FabricSequenceService.nextval("tenant_A", "order_seq", { count: 3 })` → Atomic block allocation returns `[50000, 50001, 50002]`
2. Three UUIDs are generated
3. Three complete documents dispatched to MongoDB: `db.orders.insertMany([...])`

### Response:
```json
[
  { "id": "019a...", "order_no": 50000, "customer_name": "Acme Corp", "total": 1200.00 },
  { "id": "019b...", "order_no": 50001, "customer_name": "Wayne Industries", "total": 3400.00 },
  { "id": "019c...", "order_no": 50002, "customer_name": "Stark Solutions", "total": 7800.00 }
]
```

---

## 12. Rules & Key Guidelines

| Rule | Description |
|:---|:---|
| **Functions and sequences are always defined on `Fabric_Hub_Postgres`** | Even if you're inserting into MySQL/MongoDB, the function/sequence lives on the hub |
| **Use the `generate` block for non-Postgres writes** | The `generate` block in `queryConfig.query` triggers the `FabricWriteGenerators` engine to resolve values before dispatch |
| **Column `default` works only on Postgres tables** | If `targetSource` is `Fabric_Hub_Postgres`, you can use `"default": "my_function()"` and Postgres evaluates it natively |
| **Manifest provisioning of SEQUENCE/FUNCTION is Postgres-only** | The diff engine skips these resource types for non-Postgres targets |
| **Fabric sequences are engine-agnostic** | `FabricSequenceService` stores state in `fabric_system.fabric_sequences` on the hub — all engines can use it via the `generate` block |
| **Block allocation prevents gaps** | `FabricSequenceService.nextval(count: N)` reserves N contiguous values in a single atomic transaction |
| **Functions run under tenant schema** | The `schema` parameter in a `generate` function rule sets the `search_path` to the tenant's physical schema |
| **Order: SEQUENCE → FUNCTION → TABLE** | Define sequences before functions that reference them, and functions before tables that use them as defaults |
