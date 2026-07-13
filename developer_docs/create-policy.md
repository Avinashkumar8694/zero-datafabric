# How to Create RLS & Masking Policies (Scenario Guide)

This guide describes the supported features, rules, and configuration steps for Row-Level Security (RLS) and column-masking policies in the Zero Data Fabric, based on realistic enterprise scenarios.

---

## 1. Supported Security Features & Rules

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

---

## 2. Exhaustive Mapping Reference (Allowed Values & Enums)

To map security parameters correctly, utilize the following predefined enums, system variables, and role keys:

### A. Allowed Privileges (DML Grants)
The `privileges` array under `grants` only supports the following exact SQL operation strings:
* **`"SELECT"`** — Grant read authorization.
* **`"INSERT"`** — Grant record creation authorization.
* **`"UPDATE"`** — Grant record modification authorization.
* **`"DELETE"`** — Grant record deletion/soft-deletion authorization.

### B. Predefined Database Roles
You can map policies and grants to system-defined or user-defined tenant roles:
* **`"fabric_user"`** — Standard application database user role.
* **`"logistics_viewer"`** — Read-only role for carrier-focused endpoints.
* **`"support_agent"`** — Role assigned to customer support technicians.
* **`"operations_admin"`** — Role assigned to operational administrators.
* **`"compliance_role"`** — Auditor role with bypass authorization (e.g., bypasses soft-deletes).
* **`"analytics_viewer"`** — Read-only analytical reporter role.
* **`"viewer"`** — Global read-only role.
* **`"admin"`** — Tenant administrator role.

### C. Supported Session Settings (Context Settings)
Inside `using` and `withCheck` expressions, query the connection's session settings set dynamically by the coordinator on each query leg:
* **`current_setting('app.current_tenant_id')`** — Evaluates to the active tenant ID string (e.g. `'tenant_A'`).
* **`current_setting('app.current_region')`** — Evaluates to the operator's current location region string (e.g. `'US'`, `'EU'`).
* **`current_setting('app.current_user_id')`** — Evaluates to the active UUID user key.
* **`current_setting('app.current_role')`** — Evaluates to the active session role string.

### D. Common Column Masking SQL Expressions
Configure the `expression` property to evaluate valid database function targets:
* **Literal Redaction**: `"'REDACTED'"` or `"'REDACTED'::jsonb"`
* **MD5 Hashing**: `"md5(column_name)"` or `"md5(column_name) || '@masked.com'"`
* **SHA256 Hashing**: `"encode(sha256(column_name::bytea), 'hex')"`
* **Partial Mask (Substrings)**: `"'XXXX-XXXX-XXXX-' || right(column_name, 4)"`
* **Zero Out (Numeric)**: `"0"` or `"0.00"`
* **Null Out**: `"NULL"`

---

## 3. Security Configuration Scenarios

---

### Scenario A: Multi-Tenant Data Isolation
**Requirement**: In a B2B SaaS environment, a tenant's users must only read and write records belonging to their active tenant ID.

#### Manifest Configuration:
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

#### API Apply Endpoint:
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

#### Compiled Database Commands:
```sql
ALTER TABLE "public"."orders" ENABLE ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation ON "public"."orders"
  FOR ALL TO fabric_user
  USING (tenant_id = current_setting('app.current_tenant_id'))
  WITH CHECK (tenant_id = current_setting('app.current_tenant_id'));
```

---

### Scenario B: Column-Level PII Masking (Hashed vs. Redacted)
**Requirement**: Mask customer emails (md5 hashed) and credit card info (fully redacted) for users with the `support_agent` role, while leaving them fully visible for the `admin` role.

#### Manifest Configuration:
```json
{
  "type": "TABLE",
  "name": "customers",
  "columns": [
    { "name": "id", "type": "UUID", "strategy": "UUID_V7", "primaryKey": true },
    { "name": "email", "type": "STRING" },
    { "name": "card_number", "type": "STRING" }
  ],
  "security": {
    "enable_rls": false,
    "masking": [
      {
        "column": "card_number",
        "roles": ["support_agent"],
        "expression": "'\''XXXX-XXXX-XXXX-'\'' || right(card_number, 4)"
      },
      {
        "column": "email",
        "roles": ["support_agent"],
        "expression": "md5(email) || '\''@masked.com'\''"
      }
    ],
    "grants": [
      { "role": "support_agent", "privileges": ["SELECT"] }
    ]
  }
}
```

#### Compiled Projection Rewrite:
When a user acting as `support_agent` queries the customer table, the query engine rewrites the projection list dynamically:

```sql
-- Original AST select: SELECT email, card_number FROM customers;
-- Compiled execution:
SELECT 
  md5("email") || '@masked.com' AS "email", 
  'XXXX-XXXX-XXXX-' || right("card_number", 4) AS "card_number" 
FROM "public"."customers";
```

---

### Scenario C: Soft-Delete Auto-Filtering
**Requirement**: Soft-delete records when deleted. Hide these records from regular views automatically, but allow compliance auditors (`compliance_role`) to see them.

#### Manifest Configuration:
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

#### Compiled Database Actions:
```sql
ALTER TABLE "public"."shipments" ENABLE ROW LEVEL SECURITY;

CREATE POLICY hide_deleted_from_regular_users ON "public"."shipments"
  FOR SELECT TO fabric_user
  USING (deleted_at IS NULL);
```

---

### Scenario D: Region-Based Write Restrictions
**Requirement**: Regional operators can only register or modify orders situated in their own assigned region.

#### Manifest Configuration:
```json
{
  "type": "TABLE",
  "name": "orders",
  "columns": [
    { "name": "id", "type": "UUID", "strategy": "UUID_V7", "primaryKey": true },
    { "name": "region", "type": "STRING", "length": 5 }
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

#### Compiled Database Action:
```sql
ALTER TABLE "public"."orders" ENABLE ROW LEVEL SECURITY;

CREATE POLICY regional_write_lock ON "public"."orders"
  FOR ALL TO regional_operator
  USING (region = current_setting('app.current_region'))
  WITH CHECK (region = current_setting('app.current_region'));
```
