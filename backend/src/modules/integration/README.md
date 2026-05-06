# Module 3.1: Data Integration & Virtualization

This module handles the heterogeneous integration of remote data sources into the unified Data Fabric.

## Key Features
- **Zero-Copy Virtualization**: Uses PostgreSQL Foreign Data Wrappers (FDW) to link remote databases without moving data.
- **Automated Provisioning**: Automatically creates tenant-specific namespaces and imports remote schemas.
- **Security-First Integration**: Every virtualized source is automatically tagged with a `tenant_id` and locked under RLS.
- **Flexible Sync Strategy**: Supports both `VIRTUAL` (FDW) and `PHYSICAL` (CDC/Sync) integration types.

## Virtualization Workflow
1.  **Source Registration**: User provides connection details for a remote source.
2.  **Connectivity Check**: The system validates the link before registration.
3.  **FDW Orchestration**: 
    - Creates a dedicated `FOREIGN SERVER`.
    - Establishes a secure `USER MAPPING`.
    - Executes `IMPORT FOREIGN SCHEMA` into the tenant's isolated namespace.
4.  **Metadata Cataloging**: (Triggered post-registration) Crawls the remote schema to populate the central metadata catalog.

## Health Monitoring
The `IntegrationService` provides hooks for periodic health checks, ensuring that virtualized links are alive and credentials haven't expired.

## API Usage Examples

### 1. Registering a Virtual Source
**POST** `/api/admin/connections`
```json
{
  "tenantId": "tenant_A",
  "name": "Ecom_DB",
  "config": {
    "host": "production-db.internal",
    "port": 5432,
    "dbName": "orders",
    "user": "fabric_reader",
    "pass": "...",
    "syncType": "VIRTUAL"
  }
}
```

### 2. Resulting Database State
After successful registration, the following objects are created:
- **Foreign Server**: `server_tenant_A_Ecom_DB` (isolated to host/db).
- **User Mapping**: Secure credential mapping for the application role.
- **Foreign Schema**: Remote tables are imported into the `tenant_tenant_A` namespace.

## Verification Scenarios Tested
- [x] **Zero-Copy Link**: Verifies FDW server and user mapping creation.
- [x] **Schema Isolation**: Ensures remote tables are imported into the correct tenant schema.
- [x] **System Table Protection**: Verifies that extension/system tables (Citus, etc.) are excluded from import.
- [x] **Clean De-provisioning**: Verifies that `DROP SERVER ... CASCADE` removes all virtual links on deletion.
- [x] **Idempotency**: Registering the same source multiple times is handled gracefully.

## Operational Scenarios

### Scenario 1: Handling Schema Drift
When a remote source changes its schema (e.g., a new column is added), the virtualized schema in Data Fabric must be refreshed.
1.  **Detection**: Use the `IntegrationService` to compare local metadata with remote catalog.
2.  **Resolution**: Re-run the `registerPostgresSource` command. The `register_remote_source` stored procedure is idempotent and will update the existing `FOREIGN SERVER` and refresh the schema imports.

### Scenario 2: Industrial Performance Tuning
For high-volume virtualized sources, use FDW options to optimize throughput:
- **`fetch_count`**: Set the number of rows fetched per trip (default 100).
- **`use_remote_estimate`**: Allow Postgres to use remote statistics for better query planning.
```sql
ALTER SERVER "server_tenant_A_Ecom_DB" OPTIONS (ADD fetch_count '500', ADD use_remote_estimate 'true');
```

### Scenario 3: Identity-Aware Virtualization
The Data Fabric uses **User Mapping** to ensure that remote queries are executed under a specific identity, not a superuser.
- When `registerPostgresSource` is called, it creates a mapping:
```sql
CREATE USER MAPPING FOR current_user 
SERVER "server_tenant_A_Ecom_DB" 
OPTIONS (user 'fabric_reader', password '...');
```

## Security Hardening
- **Credential Rotation**: To rotate credentials, call the `registerPostgresSource` API with the same `name` but updated `config`. The system will atomically update the `USER MAPPING`.
- **System Table Protection**: The fabric explicitly excludes system tables during virtualization to prevent naming collisions and security leaks:
```sql
IMPORT FOREIGN SCHEMA public 
EXCEPT (pg_catalog, information_schema, fabric_registry) 
FROM SERVER "source" INTO "tenant_schema";
```

## Troubleshooting
- **Error: `relation does not exist`**: Ensure the FDW server was created and the schema was imported into the correct tenant namespace (`tenant_tenant_A`).
- **Error: `permission denied`**: Verify the remote user has `SELECT` privileges on the target schema in the source database.

## Running Tests
```bash
npm test src/modules/integration/integration.test.ts
```
