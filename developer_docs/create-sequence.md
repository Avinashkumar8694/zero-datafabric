# How to Create Database Sequences

This guide describes how to define numerical sequence generators in the Data Fabric.

---

## 1. Defining Sequences in Manifest

Add the `SEQUENCE` resource definition block inside a schema block:

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
          "name": "tracking_seq",
          "start": 100000,
          "increment": 1,
          "minValue": 100000,
          "maxValue": 999999999,
          "cache": 20,
          "ownedBy": {
            "table": "shipments",
            "column": "id"
          }
        }
      ]
    }
  ]
}
```

---

## 2. API Endpoints

### Option A: Metadata Apply (Via Manifest)
Submit the manifest block (`manifest.json`):

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

### Option B: Query Engine Envelope DDL
Directly register a sequence dynamically using the DDL QueryConfig envelope:

* **Endpoint**: `POST /api/analytics/query`
* **Headers**:
  * `Authorization: Bearer $JWT_TOKEN`
  * `x-tenant-id: tenant_A`
  * `Content-Type: application/json`

```bash
curl -X POST http://localhost:4000/api/analytics/query \
  -H "Authorization: Bearer $JWT_TOKEN" \
  -H "x-tenant-id: tenant_A" \
  -H "Content-Type: application/json" \
  -d '{
    "type": "CREATE_SEQUENCE",
    "schema": "Global_Supply_Chain",
    "sequenceDef": {
      "name": "tracking_seq",
      "start": 100000,
      "increment": 1
    }
  }'
```

---

## 3. Querying Sequence (nextval)

To increment and allocate the next sequence number across any engine:

* **Endpoint**: `POST /api/data/sequence`
* **Headers**: Same as above.

```bash
curl -X POST http://localhost:4000/api/data/sequence \
  -H "Authorization: Bearer $JWT_TOKEN" \
  -H "x-tenant-id: tenant_A" \
  -H "Content-Type: application/json" \
  -d '{
    "name": "tracking_seq"
  }'
```

---

## 4. Compiled Database Action (Postgres)

```sql
CREATE SEQUENCE "public"."tracking_seq"
  START WITH 100000
  INCREMENT BY 1
  MINVALUE 100000
  MAXVALUE 999999999
  CACHE 20
  OWNED BY "public"."shipments"."id";
```
