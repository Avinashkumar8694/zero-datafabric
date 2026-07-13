# How to Create RLS & Masking Policies (Scenario Guide)

This guide describes the supported parameters, enums, rules, and configuration steps for Row-Level Security (RLS) and column-masking policies in the Zero Data Fabric.

---

## 1. Supported Parameters & Mapping Values

Within your metadata manifest, the `security` block inside a `TABLE` resource supports:

* **`enable_rls`**: `Boolean` | Activates Row-Level Security on the database table.
* **`policies`**: `Array` | Relational filter restrictions:
  * `name`: `String` | Unique policy identifier.
  * `roles`: `Array` | List of role names the policy applies to (omit to apply to all roles).
  * `using`: `String` | SQL boolean check expression applied to `SELECT` and `DELETE` filters.
  * `withCheck`: `String` | SQL boolean check expression validated during `INSERT` and `UPDATE` writes.
* **`masking`**: `Array` | Dynamic projection overrides:
  * `column`: `String` | Column to mask.
  * `roles`: `Array` | Target roles to mask (other roles see the unmasked values).
  * `expression`: `String` | Output replacement SQL expression (e.g. `'REDACTED'`, `md5(email)`).
* **`grants`**: `Array` | Table privileges mapping:
  * `role`: `String` | Target database role.
  * `privileges`: `Array` | Allowed DML: `['SELECT', 'INSERT', 'UPDATE', 'DELETE']`.

### Predefined Database Roles (Enums)
* `"fabric_user"` — Standard tenant user.
* `"support_agent"` — Customer support technician.
* `"logistics_viewer"` — Logistics viewer.
* `"compliance_role"` — Compliance auditor.
* `"analytics_viewer"` — Analytical reporter.
* `"viewer"` — Read-only role.
* `"admin"` — Tenant admin.

### Predefined Session Variables
* `current_setting('app.current_tenant_id')` — Active tenant ID.
* `current_setting('app.current_region')` — Operator location region.
* `current_setting('app.current_user_id')` — Active user UUID.
* `current_setting('app.current_role')` — Active session role.

---

## 2. 10 Enterprise Policy Scenarios

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

### Scenario 1: Multi-Tenant Data Isolation
* **Description**: Restrict reads and writes so users can only access rows belonging to their active tenant ID.
* **Manifest JSON**:
```json
{
  "type": "TABLE",
  "name": "orders",
  "columns": [
    { "name": "id", "type": "UUID", "strategy": "UUID_V7", "primaryKey": true },
    { "name": "tenant_id", "type": "STRING", "nullable": false },
    { "name": "amount", "type": "NUMERIC" }
  ],
  "security": {
    "enable_rls": true,
    "policies": [
      {
        "name": "tenant_isolation",
        "roles": ["fabric_user"],
        "using": "tenant_id = current_setting('\''app.current_tenant_id'\'')",
        "withCheck": "tenant_id = current_setting('\''app.current_tenant_id'\'')"
      }
    ]
  }
}
```
* **Compiled Database SQL**:
```sql
ALTER TABLE "public"."orders" ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "public"."orders" FOR ALL TO fabric_user USING (tenant_id = current_setting('app.current_tenant_id')) WITH CHECK (tenant_id = current_setting('app.current_tenant_id'));
```

---

### Scenario 2: Region-Based Write Restrictions
* **Description**: Operators can only register or modify orders situated in their own assigned region.
* **Manifest JSON**:
```json
{
  "type": "TABLE",
  "name": "shipments",
  "columns": [
    { "name": "id", "type": "UUID", "strategy": "UUID_V7", "primaryKey": true },
    { "name": "region", "type": "STRING", "length": 10 }
  ],
  "security": {
    "enable_rls": true,
    "policies": [
      {
        "name": "regional_write_lock",
        "roles": ["regional_operator"],
        "using": "region = current_setting('\''app.current_region'\'')",
        "withCheck": "region = current_setting('\''app.current_region'\'')"
      }
    ]
  }
}
```
* **Compiled Database SQL**:
```sql
ALTER TABLE "public"."shipments" ENABLE ROW LEVEL SECURITY;
CREATE POLICY regional_write_lock ON "public"."shipments" FOR ALL TO regional_operator USING (region = current_setting('app.current_region')) WITH CHECK (region = current_setting('app.current_region'));
```

---

### Scenario 3: Soft-Delete Auto-Filtering
* **Description**: Hide soft-deleted records from regular views automatically, but allow compliance auditors to see them.
* **Manifest JSON**:
```json
{
  "type": "TABLE",
  "name": "shipments",
  "columns": [
    { "name": "id", "type": "UUID", "strategy": "UUID_V7", "primaryKey": true },
    { "name": "deleted_at", "type": "TIMESTAMP", "nullable": true, "strategy": "SOFT_DELETE" }
  ],
  "security": {
    "enable_rls": true,
    "policies": [
      {
        "name": "hide_deleted_from_regular_users",
        "roles": ["fabric_user"],
        "using": "deleted_at IS NULL"
      }
    ]
  }
}
```
* **Compiled Database SQL**:
```sql
ALTER TABLE "public"."shipments" ENABLE ROW LEVEL SECURITY;
CREATE POLICY hide_deleted_from_regular_users ON "public"."shipments" FOR SELECT TO fabric_user USING (deleted_at IS NULL);
```

---

### Scenario 4: Role-Based Creation Limits (Write Restrictions)
* **Description**: Prevent standard users from creating new entries on critical system configurations, reserving it for admins.
* **Manifest JSON**:
```json
{
  "type": "TABLE",
  "name": "system_configs",
  "columns": [
    { "name": "key", "type": "STRING", "primaryKey": true },
    { "name": "value", "type": "STRING" }
  ],
  "security": {
    "enable_rls": true,
    "policies": [
      {
        "name": "admin_only_writes",
        "roles": ["fabric_user"],
        "using": "true",
        "withCheck": "current_setting('\''app.current_role'\'') = '\''admin'\''"
      }
    ]
  }
}
```
* **Compiled Database SQL**:
```sql
ALTER TABLE "public"."system_configs" ENABLE ROW LEVEL SECURITY;
CREATE POLICY admin_only_writes ON "public"."system_configs" FOR ALL TO fabric_user USING (true) WITH CHECK (current_setting('app.current_role') = 'admin');
```

---

### Scenario 5: User Ownership Row isolation
* **Description**: Users can only read and write records they created.
* **Manifest JSON**:
```json
{
  "type": "TABLE",
  "name": "user_profiles",
  "columns": [
    { "name": "id", "type": "UUID", "strategy": "UUID_V7", "primaryKey": true },
    { "name": "owner_id", "type": "UUID" }
  ],
  "security": {
    "enable_rls": true,
    "policies": [
      {
        "name": "owner_isolation",
        "roles": ["fabric_user"],
        "using": "owner_id = current_setting('\''app.current_user_id'\'')::uuid",
        "withCheck": "owner_id = current_setting('\''app.current_user_id'\'')::uuid"
      }
    ]
  }
}
```
* **Compiled Database SQL**:
```sql
ALTER TABLE "public"."user_profiles" ENABLE ROW LEVEL SECURITY;
CREATE POLICY owner_isolation ON "public"."user_profiles" FOR ALL TO fabric_user USING (owner_id = current_setting('app.current_user_id')::uuid) WITH CHECK (owner_id = current_setting('app.current_user_id')::uuid);
```

---

### Scenario 6: Email MD5 Hashing Mask
* **Description**: Hash emails to MD5 strings for support agents, keeping domain info.
* **Manifest JSON**:
```json
{
  "type": "TABLE",
  "name": "users",
  "columns": [
    { "name": "id", "type": "UUID", "strategy": "UUID_V7", "primaryKey": true },
    { "name": "email", "type": "STRING" }
  ],
  "security": {
    "enable_rls": false,
    "masking": [
      {
        "column": "email",
        "roles": ["support_agent"],
        "expression": "md5(email) || '\''@masked.com'\''"
      }
    ]
  }
}
```
* **Compiled Database SQL**:
```sql
-- Evaluated dynamically by the coordinator on Select projections:
SELECT md5("email") || '@masked.com' AS "email" FROM "public"."users";
```

---

### Scenario 7: Credit Card Partial Redaction Mask
* **Description**: Mask credit card details for support staff, leaving the last 4 digits visible.
* **Manifest JSON**:
```json
{
  "type": "TABLE",
  "name": "payments",
  "columns": [
    { "name": "id", "type": "UUID", "strategy": "UUID_V7", "primaryKey": true },
    { "name": "card_number", "type": "STRING" }
  ],
  "security": {
    "enable_rls": false,
    "masking": [
      {
        "column": "card_number",
        "roles": ["support_agent"],
        "expression": "'\''XXXX-XXXX-XXXX-'\'' || right(card_number, 4)"
      }
    ]
  }
}
```
* **Compiled Database SQL**:
```sql
SELECT 'XXXX-XXXX-XXXX-' || right("card_number", 4) AS "card_number" FROM "public"."payments";
```

---

### Scenario 8: JSONB Column Payload Redaction Mask
* **Description**: Completely redact JSONB metadata payloads for log viewers.
* **Manifest JSON**:
```json
{
  "type": "TABLE",
  "name": "logs",
  "columns": [
    { "name": "id", "type": "UUID", "strategy": "UUID_V7", "primaryKey": true },
    { "name": "payload", "type": "JSONB" }
  ],
  "security": {
    "enable_rls": false,
    "masking": [
      {
        "column": "payload",
        "roles": ["logistics_viewer"],
        "expression": "'\''{\"status\":\"REDACTED\"}'\''::jsonb"
      }
    ]
  }
}
```
* **Compiled Database SQL**:
```sql
SELECT '{"status":"REDACTED"}'::jsonb AS "payload" FROM "public"."logs";
```

---

### Scenario 9: Price Zeroing-Out Mask
* **Description**: Zero out commercial prices for basic viewers.
* **Manifest JSON**:
```json
{
  "type": "TABLE",
  "name": "catalog",
  "columns": [
    { "name": "id", "type": "UUID", "strategy": "UUID_V7", "primaryKey": true },
    { "name": "price", "type": "NUMERIC" }
  ],
  "security": {
    "enable_rls": false,
    "masking": [
      {
        "column": "price",
        "roles": ["viewer"],
        "expression": "0.00"
      }
    ]
  }
}
```
* **Compiled Database SQL**:
```sql
SELECT 0.00 AS "price" FROM "public"."catalog";
```

---

### Scenario 10: Conditional Role Masking
* **Description**: Mask unless the active user has administrator privileges.
* **Manifest JSON**:
```json
{
  "type": "TABLE",
  "name": "salaries",
  "columns": [
    { "name": "id", "type": "UUID", "strategy": "UUID_V7", "primaryKey": true },
    { "name": "amount", "type": "NUMERIC" }
  ],
  "security": {
    "enable_rls": false,
    "masking": [
      {
        "column": "amount",
        "roles": ["fabric_user"],
        "expression": "CASE WHEN current_setting('\''app.current_role'\'') = '\''admin'\'' THEN amount ELSE 0.00 END"
      }
    ]
  }
}
```
* **Compiled Database SQL**:
```sql
SELECT CASE WHEN current_setting('app.current_role') = 'admin' THEN "amount" ELSE 0.00 END AS "amount" FROM "public"."salaries";
```
