# How to Create Database Sequences (Scenario Guide)

This guide describes the supported parameters, options, rules, and configuration steps for numerical sequences in the Zero Data Fabric.

---

## 1. Supported Parameters & Rules

Within your metadata manifest, the `SEQUENCE` resource supports:

* **`name`**: `String` | Required. Unique sequence identifier.
* **`start`**: `Integer` | Starting value (defaults to `1`).
* **`increment`**: `Integer` | Increment step value (defaults to `1`).
* **`minValue`**: `Integer` | Minimum boundary limit.
* **`maxValue`**: `Integer` | Maximum boundary limit.
* **`cache`**: `Integer` | Pre-allocated sequence memory count for concurrent inserts.
* **`ownedBy`**: `Object` | Automatically drops the sequence when the table is dropped.
  * `table`: `String` | Target table.
  * `column`: `String` | Target column.

---

## 2. 10 Enterprise Sequence Scenarios

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

### Scenario 1: Standard Autoincrement Sequence
* **Description**: Create a simple numerical counter starting from 1.
* **Manifest JSON**:
```json
{
  "version": "4.0",
  "namespace": "Global_Supply_Chain",
  "schemas": [
    {
      "name": "Global_Supply_Chain",
      "resources": [
        {
          "type": "SEQUENCE",
          "name": "standard_id_seq"
        }
      ]
    }
  ]
}
```
* **Compiled Database SQL**:
```sql
CREATE SEQUENCE "public"."standard_id_seq" START WITH 1 INCREMENT BY 1;
```

---

### Scenario 2: High-Start Partition Sequence
* **Description**: Set a large starting sequence to avoid conflicts with legacy IDs.
* **Manifest JSON**:
```json
{
  "version": "4.0",
  "namespace": "Global_Supply_Chain",
  "schemas": [
    {
      "name": "Global_Supply_Chain",
      "resources": [
        {
          "type": "SEQUENCE",
          "name": "partition_seq",
          "start": 10000000
        }
      ]
    }
  ]
}
```
* **Compiled Database SQL**:
```sql
CREATE SEQUENCE "public"."partition_seq" START WITH 10000000 INCREMENT BY 1;
```

---

### Scenario 3: Tenant-Aware Custom Procedural Sequence
* **Description**: Custom generator leveraging tenant contexts.
* **Manifest JSON**:
```json
{
  "version": "4.0",
  "namespace": "Global_Supply_Chain",
  "schemas": [
    {
      "name": "Global_Supply_Chain",
      "resources": [
        {
          "type": "SEQUENCE",
          "name": "tenant_seq",
          "start": 1,
          "increment": 1,
          "strategy": "PROCEDURAL",
          "generator": "generate_tenant_id(tenant_id)"
        }
      ]
    }
  ]
}
```
* **Compiled Database SQL**:
```sql
CREATE SEQUENCE "public"."tenant_seq" START WITH 1 INCREMENT BY 1;
```

---

### Scenario 4: Table-Column Owned Sequence
* **Description**: Binds a sequence to a table column so it drops automatically when the table is dropped.
* **Manifest JSON**:
```json
{
  "version": "4.0",
  "namespace": "Global_Supply_Chain",
  "schemas": [
    {
      "name": "Global_Supply_Chain",
      "resources": [
        {
          "type": "SEQUENCE",
          "name": "order_id_seq",
          "ownedBy": {
            "table": "orders",
            "column": "id"
          }
        }
      ]
    }
  ]
}
```
* **Compiled Database SQL**:
```sql
CREATE SEQUENCE "public"."order_id_seq" OWNED BY "public"."orders"."id";
```

---

### Scenario 5: Custom Incremented Jumps
* **Description**: Increment identifiers in jumps of 5 (useful for spacing IDs).
* **Manifest JSON**:
```json
{
  "version": "4.0",
  "namespace": "Global_Supply_Chain",
  "schemas": [
    {
      "name": "Global_Supply_Chain",
      "resources": [
        {
          "type": "SEQUENCE",
          "name": "jumped_seq",
          "start": 100,
          "increment": 5
        }
      ]
    }
  ]
}
```
* **Compiled Database SQL**:
```sql
CREATE SEQUENCE "public"."jumped_seq" START WITH 100 INCREMENT BY 5;
```

---

### Scenario 6: Range-Bound Sequence
* **Description**: Restrict allocations within a set range.
* **Manifest JSON**:
```json
{
  "version": "4.0",
  "namespace": "Global_Supply_Chain",
  "schemas": [
    {
      "name": "Global_Supply_Chain",
      "resources": [
        {
          "type": "SEQUENCE",
          "name": "bounded_seq",
          "start": 500,
          "minValue": 500,
          "maxValue": 9999
        }
      ]
    }
  ]
}
```
* **Compiled Database SQL**:
```sql
CREATE SEQUENCE "public"."bounded_seq" START WITH 500 INCREMENT BY 1 MINVALUE 500 MAXVALUE 9999;
```

---

### Scenario 7: Non-Cycling Sequence Boundary Lock
* **Description**: Enforce sequence exhaustion limits without cycling (wrap-around) errors.
* **Manifest JSON**:
```json
{
  "version": "4.0",
  "namespace": "Global_Supply_Chain",
  "schemas": [
    {
      "name": "Global_Supply_Chain",
      "resources": [
        {
          "type": "SEQUENCE",
          "name": "finite_seq",
          "start": 1,
          "maxValue": 500000,
          "cycle": false
        }
      ]
    }
  ]
}
```
* **Compiled Database SQL**:
```sql
CREATE SEQUENCE "public"."finite_seq" START WITH 1 MAXVALUE 500000 NO CYCLE;
```

---

### Scenario 8: High-Throughput Cached Sequence
* **Description**: Pre-allocate 50 values in memory for high-write bulk insert pipelines.
* **Manifest JSON**:
```json
{
  "version": "4.0",
  "namespace": "Global_Supply_Chain",
  "schemas": [
    {
      "name": "Global_Supply_Chain",
      "resources": [
        {
          "type": "SEQUENCE",
          "name": "cached_seq",
          "start": 1,
          "cache": 50
        }
      ]
    }
  ]
}
```
* **Compiled Database SQL**:
```sql
CREATE SEQUENCE "public"."cached_seq" START WITH 1 CACHE 50;
```

---

### Scenario 9: Sequence Call Inside Alphanumeric Key Generator
* **Description**: Create a function that consumes the sequence to generate custom order numbers.
* **Manifest JSON**:
```json
{
  "type": "FUNCTION",
  "name": "generate_invoice_no",
  "arguments": [
    { "name": "p_code", "type": "STRING" }
  ],
  "returnType": "STRING",
  "body": "DECLARE v_seq BIGINT; BEGIN v_seq := nextval('\''invoice_seq'\''); RETURN p_code || '\''-'\'' || to_char(NOW(), '\''YY'\'') || '\''-'\'' || lpad(v_seq::text, 6, '\''0'\''); END;"
}
```
* **Compiled Database SQL**:
```sql
CREATE FUNCTION generate_invoice_no(p_code VARCHAR) RETURNS VARCHAR AS $$
DECLARE v_seq BIGINT; 
BEGIN 
  v_seq := nextval('invoice_seq'); 
  RETURN p_code || '-' || to_char(NOW(), 'YY') || '-' || lpad(v_seq::text, 6, '0'); 
END;
$$ LANGUAGE plpgsql;
```

---

### Scenario 10: CREATE_SEQUENCE DDL Envelope Query
* **Description**: Create a sequence dynamically without applying a full manifest file.
* **API Endpoint**: `POST /api/analytics/query`
* **Headers**:
  * `Authorization: Bearer $JWT_TOKEN`
  * `x-tenant-id: tenant_A`
  * `Content-Type: application/json`
* **Request JSON**:
```json
{
  "type": "CREATE_SEQUENCE",
  "schema": "Global_Supply_Chain",
  "sequenceDef": {
    "name": "on_the_fly_seq",
    "start": 1000,
    "increment": 1
  }
}
```
* **Compiled Database SQL**:
```sql
CREATE SEQUENCE "public"."on_the_fly_seq" START WITH 1000 INCREMENT BY 1;
```
