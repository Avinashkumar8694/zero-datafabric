# How to Create & Use Custom Functions and Sequences

This guide walks through defining custom database functions and sequences inside metadata manifests, binding them to table columns, and invoking them through the query engine, complete with executable `curl` commands.

---

## 1. Supported Resource Types & Parameters

### Function Resource (`type: "FUNCTION"`)
* **`name`**: `String` | Required. Function identifier.
* **`arguments`**: `Array` | Input parameters:
  * `name`: `String` | Argument name.
  * `type`: `String` | Data type: `'STRING' | 'INTEGER' | 'BIGINT' | 'NUMERIC' | 'BOOLEAN' | 'UUID' | 'TIMESTAMP' | 'JSONB' | 'TEXT'`
  * `default`: `Any` | Optional default value.
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

---

## 2. API Endpoint for All Examples

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

## 3. Scenario: Custom Invoice Number Generator (Function + Sequence)

**Goal**: Create a sequence `invoice_seq` and a function `generate_invoice_no(prefix)` that produces formatted invoice numbers like `INV-26-000042`. Then bind it as the default value for the `invoice_no` column on the `invoices` table.

### Step 1: Define Sequence + Function + Table in One Manifest

Save as `manifest.json`:

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

### Step 2: Apply the Manifest

```bash
curl -X POST http://localhost:4000/api/metadata/apply \
  -H "Authorization: Bearer $JWT_TOKEN" \
  -H "x-tenant-id: tenant_A" \
  -F "file=@manifest.json"
```

### Step 3: Compiled Database Actions

```sql
-- 1. Create the sequence
CREATE SEQUENCE "billing"."invoice_seq" START WITH 1 INCREMENT BY 1 CACHE 20;

-- 2. Create the function
CREATE FUNCTION "billing"."generate_invoice_no"(p_prefix VARCHAR)
RETURNS VARCHAR
LANGUAGE plpgsql
VOLATILE
AS $$
DECLARE v_seq BIGINT;
BEGIN
  v_seq := nextval('billing.invoice_seq');
  RETURN p_prefix || '-' || to_char(NOW(), 'YY') || '-' || lpad(v_seq::text, 6, '0');
END;
$$;

-- 3. Create the table with function-based default
CREATE TABLE "billing"."invoices" (
  "id" UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  "invoice_no" VARCHAR(20) UNIQUE DEFAULT billing.generate_invoice_no('INV'),
  "customer_id" UUID NOT NULL,
  "total" NUMERIC NOT NULL,
  "created_at" TIMESTAMP DEFAULT NOW()
);
```

### Step 4: Insert a Record (Auto-Generated Invoice Number)

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

The `invoice_no` column is auto-populated by the function. Example response:
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

## 4. Scenario: SKU Code Generator with Region Prefix

**Goal**: Generate SKU codes like `US-PRD-00501` using a function consuming a cached sequence.

### Manifest (`manifest.json`):
```json
{
  "version": "4.0",
  "namespace": "Inventory_Core",
  "targetSource": "Fabric_Hub_Postgres",
  "schemas": [
    {
      "name": "inventory",
      "resources": [
        {
          "type": "SEQUENCE",
          "name": "sku_seq",
          "start": 500,
          "increment": 1,
          "cache": 50
        },
        {
          "type": "FUNCTION",
          "name": "generate_sku",
          "arguments": [
            { "name": "p_region", "type": "STRING" },
            { "name": "p_category", "type": "STRING" }
          ],
          "returnType": "STRING",
          "language": "plpgsql",
          "volatility": "VOLATILE",
          "body": "DECLARE v_seq BIGINT; BEGIN v_seq := nextval('inventory.sku_seq'); RETURN p_region || '-' || p_category || '-' || lpad(v_seq::text, 5, '0'); END;"
        },
        {
          "type": "TABLE",
          "name": "products",
          "columns": [
            { "name": "id", "type": "UUID", "strategy": "UUID_V7", "primaryKey": true },
            { "name": "sku", "type": "STRING", "length": 20, "unique": true },
            { "name": "name", "type": "STRING", "length": 100 },
            { "name": "price", "type": "NUMERIC" }
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

### Insert Using the Function via AST CALL:

```bash
curl -X POST http://localhost:4000/api/analytics/query \
  -H "Authorization: Bearer $JWT_TOKEN" \
  -H "x-tenant-id: tenant_A" \
  -H "Content-Type: application/json" \
  -d '{
    "queryConfig": {
      "type": "INSERT",
      "schema": "inventory",
      "query": {
        "into": { "resource": "products", "source": "Fabric_Hub_Postgres" },
        "columns": ["sku", "name", "price"],
        "values": [
          ["inventory.generate_sku('\''US'\'', '\''PRD'\'')", "Premium Widget", 49.99]
        ]
      }
    }
  }'
```

### Compiled SQL:
```sql
INSERT INTO "inventory"."products" ("sku", "name", "price")
VALUES (inventory.generate_sku('US', 'PRD'), 'Premium Widget', 49.99)
RETURNING *;
-- Result: sku = 'US-PRD-00500'
```

---

## 5. Scenario: Audit Timestamp Logger (Trigger Function)

**Goal**: Create a function that auto-stamps `updated_at` on every row update, then bind it as a trigger.

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
            { "name": "status", "type": "STRING", "length": 20 },
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
CREATE FUNCTION "public"."set_updated_at"()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
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

### Test the Trigger:
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
The `updated_at` column is now automatically set to `NOW()` by the trigger on every update.

---

## 6. Scenario: Calling a Standalone Function via Query Engine

**Goal**: Invoke a previously registered function directly via the query engine without inserting records.

### Curl Command:
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

## 7. Scenario: Sequence-Only Column Default (No Custom Function)

**Goal**: Use a sequence directly as a column default without creating a custom function.

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

### Compiled SQL:
```sql
CREATE SEQUENCE "tracking"."ticket_seq" START WITH 10000 INCREMENT BY 1
  OWNED BY "tracking"."tickets"."ticket_no";

CREATE TABLE "tracking"."tickets" (
  "id" UUID PRIMARY KEY,
  "ticket_no" BIGINT DEFAULT nextval('tracking.ticket_seq'),
  "title" VARCHAR(200),
  "status" VARCHAR(20) DEFAULT 'OPEN'
);
```
