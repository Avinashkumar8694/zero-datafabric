# How to Create RLS & Masking Policies

This guide describes how to declare Row-Level Security (RLS) policies and column-level masking rules inside your metadata manifests, complete with executable `curl` commands.

---

## 1. Defining Policies in Manifest

Add the `security` configuration block inside a `TABLE` resource definition.

```json
{
  "type": "TABLE",
  "name": "shipments",
  "columns": [
    { "name": "id", "type": "UUID", "strategy": "UUID_V7", "primaryKey": true },
    { "name": "region", "type": "STRING", "length": 10 },
    { "name": "metadata", "type": "JSONB" },
    { "name": "deleted_at", "type": "TIMESTAMP", "nullable": true }
  ],
  "security": {
    "enable_rls": true,
    "policies": [
      {
        "name": "regional_isolation",
        "roles": ["fabric_user"],
        "using": "region = current_setting('\''app.current_region'\'')"
      },
      {
        "name": "hide_deleted",
        "using": "deleted_at IS NULL"
      }
    ],
    "masking": [
      {
        "column": "metadata",
        "roles": ["logistics_viewer"],
        "expression": "'\''REDACTED'\''::jsonb"
      }
    ],
    "grants": [
      {
        "role": "logistics_viewer",
        "privileges": ["SELECT"]
      }
    ]
  }
}
```

---

## 2. API Endpoints

To apply the security policies defined in your manifest, submit the manifest file (`manifest.json`):

* **Endpoint**: `POST /api/metadata/apply`
* **Headers**:
  * `Authorization: Bearer $JWT_TOKEN`
  * `x-tenant-id: tenant_A`
  * `Content-Type: multipart/form-data`

### Curl Command:
```bash
curl -X POST http://localhost:4000/api/metadata/apply \
  -H "Authorization: Bearer $JWT_TOKEN" \
  -H "x-tenant-id: tenant_A" \
  -F "file=@manifest.json"
```

---

## 3. Compiled Database Commands

The Metadata Engine translates the policy declarations into native security constraints:

```sql
-- 1. Enable Row-Level Security
ALTER TABLE "public"."shipments" ENABLE ROW LEVEL SECURITY;

-- 2. Create isolation policies
CREATE POLICY regional_isolation ON "public"."shipments" 
  FOR ALL TO fabric_user 
  USING (region = current_setting('app.current_region'));

CREATE POLICY hide_deleted ON "public"."shipments" 
  FOR ALL 
  USING (deleted_at IS NULL);

-- 3. Apply grants
GRANT SELECT ON TABLE "public"."shipments" TO logistics_viewer;
```
