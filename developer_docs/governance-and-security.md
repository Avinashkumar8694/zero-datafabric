# Data Governance & Row-Level Security (RLS) Guide

This document describes how to configure role-based access control, Row-Level Security (RLS) policies, and dynamic column masking on data resources inside the Zero Data Fabric, complete with executable `curl` commands.

---

## 1. Row-Level Security (RLS) Policies

RLS policies filter table records dynamically during select, update, and delete queries depending on user session attributes (like tenant ID, region, or department).

### A. Manifest Configuration (`manifest.json`)
Apply rules ensuring users only read records matching their active tenant session:

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
          "type": "TABLE",
          "name": "shipments",
          "columns": [
            { "name": "id", "type": "UUID", "strategy": "UUID_V7", "primaryKey": true },
            { "name": "tenant_id", "type": "STRING", "nullable": false },
            { "name": "region", "type": "STRING", "length": 10 },
            { "name": "deleted_at", "type": "TIMESTAMP", "nullable": true }
          ],
          "security": {
            "enable_rls": true,
            "policies": [
              {
                "name": "tenant_isolation",
                "roles": ["fabric_user"],
                "using": "tenant_id = current_setting('\''app.current_tenant_id'\'')"
              },
              {
                "name": "hide_soft_deleted",
                "using": "deleted_at IS NULL"
              }
            ]
          }
        }
      ]
    }
  ]
}
```

### B. Applying Policies via API
Submit the manifest to activate RLS:

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

## 2. Dynamic Column Masking

Column masking allows administrators to redact or hash sensitive fields (like emails, phone numbers, or metadata payloads) for specific user roles.

### A. Manifest Configuration (`manifest.json`)
Mask the `metadata` column for the `logistics_viewer` role:

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
          "type": "TABLE",
          "name": "shipments",
          "columns": [
            { "name": "id", "type": "UUID", "strategy": "UUID_V7", "primaryKey": true },
            { "name": "region", "type": "STRING", "length": 10 },
            { "name": "metadata", "type": "JSONB" }
          ],
          "security": {
            "masking": [
              {
                "column": "metadata",
                "roles": ["logistics_viewer"],
                "expression": "'\''REDACTED'\''::jsonb"
              }
            ]
          }
        }
      ]
    }
  ]
}
```

### B. Querying to Verify Masking
Execute a select query using the `logistics_viewer` token:

* **Endpoint**: `POST /api/analytics/query`
* **Headers**:
  * `Authorization: Bearer $LOGISTICS_VIEWER_JWT_TOKEN`
  * `x-tenant-id: tenant_A`
  * `Content-Type: application/json`

```bash
curl -X POST http://localhost:4000/api/analytics/query \
  -H "Authorization: Bearer $LOGISTICS_VIEWER_JWT_TOKEN" \
  -H "x-tenant-id: tenant_A" \
  -H "Content-Type: application/json" \
  -d '{
    "queryConfig": {
      "type": "SELECT",
      "schema": "public",
      "limit": 10,
      "query": {
        "select": ["id", "region", "metadata"],
        "from": { "resource": "shipments" }
      }
    }
  }'
```

---

## 3. Role Privileges & Grants

Explicitly register what actions a database role is entitled to perform on a resource:

```json
"security": {
  "grants": [
    {
      "role": "analytics_viewer",
      "privileges": ["SELECT"]
    },
    {
      "role": "operations_admin",
      "privileges": ["SELECT", "INSERT", "UPDATE"]
    }
  ]
}
```

### Compiled Database Action:
```sql
GRANT SELECT ON TABLE "public"."shipments" TO analytics_viewer;
GRANT SELECT, INSERT, UPDATE ON TABLE "public"."shipments" TO operations_admin;
```
