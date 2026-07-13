# Data Governance & Row-Level Security (RLS) Guide

This document describes how to configure role-based access control, Row-Level Security (RLS) policies, and dynamic column masking on data resources inside the Zero Data Fabric.

---

## 1. Row-Level Security (RLS) Policies

RLS policies filter table records dynamically during select, update, and delete queries depending on user session attributes (like tenant ID, region, or department).

### Scenario: Tenant Isolation & Status Gating
Apply rules ensuring users only read records matching their active tenant session and hide deleted records.

```json
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
```

### Compiled Database Action:
When a query is dispatched, the coordinator sets session properties inside the database connection transaction context:

```sql
-- Coordinator pre-query setup
SET LOCAL app.current_tenant_id = 'tenant_A';

-- The query is compiled with the policy conditions appended automatically
SELECT * FROM "public"."shipments" 
WHERE ("tenant_id" = current_setting('app.current_tenant_id'))
  AND ("deleted_at" IS NULL);
```

---

## 2. Dynamic Column Masking

Column masking allows administrators to redact or hash sensitive fields (like emails, phone numbers, or metadata payloads) for specific user roles.

### Scenario: Redacting client metadata for viewers
A role of type `logistics_viewer` can select shipments, but the `metadata` JSON column must be masked.

```json
"security": {
  "masking": [
    {
      "column": "metadata",
      "roles": ["logistics_viewer"],
      "expression": "'\''REDACTED'\''::jsonb"
    }
  ]
}
```

### Compiled Query Evaluation:
If the active session caller maps to the `logistics_viewer` role, the engine rewrites the projection list before executing:

```sql
-- Original SELECT id, region, metadata FROM shipments;
-- Compiled representation:
SELECT "id", "region", 'REDACTED'::jsonb AS "metadata" 
FROM "public"."shipments" 
WHERE ("deleted_at" IS NULL);
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
