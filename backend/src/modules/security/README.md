# Module 3.1: Security & Governance (IAM)

This module implements the **Identity & Access Management (IAM)** core of the Data Fabric. It bridges the gap between web-based JWT identities and database-level security enforcement.

## Architecture: The Identity Proxy Pattern

The Data Fabric uses a "Zero-Trust" approach where security is enforced at the database engine level, not just the application layer.

### 1. Identity Propagation Flow
1.  **Auth Layer**: Users authenticate via `AuthService`, receiving a JWT containing `tenant_id` and `user_name`.
2.  **Security Middleware**: The backend (`index.ts`) verifies the JWT on every request and attaches the identity to the request object.
3.  **Session Injection**: Before executing any business logic, the `DatabaseService` uses `queryWithContext` to inject the identity into a private PostgreSQL session.
    ```sql
    SELECT set_config('app.tenant_id', 'tenant_A', true);
    SELECT set_config('app.user_name', 'admin_user', true);
    SET LOCAL ROLE fabric_user;
    ```
4.  **Policy Enforcement**: PostgreSQL RLS policies automatically filter all queries based on the `app.tenant_id` setting.

### 2. Authorization Enforcement
-   **RLS (Row-Level Security)**: Every table in the `public` and `fabric_catalog` schemas is protected by a `tenant_isolation_policy`.
-   **Security Definer Functions**: Administrative actions (like schema creation) are performed via `SECURITY DEFINER` functions to ensure high-privilege operations are executed safely under controlled conditions.

## Governance & Auditing (Module 3.2)
All modifications to the Data Fabric registry are immutably logged in `fabric_admin.audit_logs`.
-   **Tamper-Proof**: Triggers capture the `user_name` from the session context.
-   **Change Tracking**: Logs store the action type, affected row, and a full JSONB delta of the data changed.
-   **Compliance**: Provides the necessary audit trail for SOC2 and GDPR compliance.

## Implementation Examples

### 1. JWT Payload (Identity Proxy)
The application expects a JWT with the following structure to drive the session context:
```json
{
  "tenant_id": "tenant_A",
  "username": "admin_user",
  "role": "editor"
}
```

### 2. RLS Policy Definition (Zero-Trust)
All tables in the fabric are secured with policies tied to the session settings:
```sql
CREATE POLICY tenant_isolation_policy ON public.data_sources
    USING (tenant_id = current_setting('app.tenant_id', true))
    WITH CHECK (tenant_id = current_setting('app.tenant_id', true));
```

### 3. Audit Log Entry (Governance)
When a modification occurs, the trigger generates an entry like this:
```json
{
  "tenant_id": "tenant_A",
  "user_name": "admin_user",
  "action": "UPDATE",
  "table_name": "data_sources",
  "old_data": { "status": "PENDING" },
  "new_data": { "status": "ACTIVE" }
}
```

## Verification Scenarios Tested
- [x] **Unauthorized Access**: Requests without valid JWTs are rejected (401).
- [x] **Tenant Leakage**: Attempting to query another tenant's data returns an empty set or error.
- [x] **Audit Integrity**: Every DML operation is captured with the correct identity.
- [x] **System Fallback**: Operations without explicit user context are attributed to `SYSTEM`.

## Operational Scenarios

### Scenario 1: Identity context Switching (Demo Mode)
To verify RLS without logging in/out, administrators can use the `DatabaseService` to simulate different identities:
```typescript
// As Tenant A
await queryWithContext("SELECT * FROM data_sources", [], { tenantId: 'tenant_A', username: 'user1' });

// As Tenant B (returns empty)
await queryWithContext("SELECT * FROM data_sources", [], { tenantId: 'tenant_B', username: 'user1' });
```

### Scenario 2: Security Audit Forensics
In the event of a security incident, the audit trail can be queried to reconstruct the sequence of events for a specific row:
```sql
SELECT * FROM fabric_admin.audit_logs 
WHERE table_name = 'data_sources' 
AND row_id = '...' 
ORDER BY changed_at ASC;
```

### Scenario 3: Multi-Layer Isolation
The fabric implements isolation at three levels:
1.  **Schema Isolation**: Each tenant's virtualized data resides in a dedicated `tenant_<id>` schema.
2.  **Row-Level Security**: Every row in the central registry is filtered by `tenant_id`.
3.  **Audit Isolation**: Audit logs are partitioned (conceptually or physically) and filtered by `tenant_id` for compliance reporting.

## Identity Proxy Deep-Dive
The transition from `request.jwt.claims` to `app.tenant_id` was made to support:
- **DDL Compliance**: RLS policies for DDL/Utility commands cannot easily parse JSON from `current_setting`. Using flat `app.*` GUCs ensures high performance and universal compatibility.
- **Trigger Access**: Audit triggers can access the session context even during complex cascading deletions.
- **Connection Pooling**: By using `true` as the third argument in `set_config($1, $2, true)`, the settings are automatically cleared when the transaction ends, preventing context leakage in pooled environments.

## Running Tests
```bash
npm test src/modules/security/security.test.ts
```
