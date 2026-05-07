# Universal Data Fabric Orchestrator (v7.0)

Industrial-grade, declarative Data Fabric orchestration system for heterogeneous enterprise data environments.

## 🚀 Key Capabilities

### 1. Omni-Template Orchestration (v7.0)
Full-spectrum declarative schema management supporting:
- **Relational Cardinality**: Native `1:1`, `1:M`, `M:1`, and `M:M` (via junction tables).
- **Planetary Partitioning**: Native `RANGE` and `LIST` partitioning support.
- **Identity Orchestration**: Distributed sequences and composite primary keys.
- **Event-Driven Triggers**: Automated audit logging and side-effect orchestration.

### 2. Autonomous Governance & Security
- **PII Masking**: Dynamic column-level masking (e.g., `MASK:PARTIAL`, `MASK:REDACT`) enforced at the engine level.
- **Identity Proxy**: Multi-tenant RLS (Row Level Security) with automated ownership transfer.
- **Safety Shield**: Preventing destructive DML without predicates and enforcing analytical limits.

### 3. Heterogeneous Virtualization (FDW)
- **Virtual Source Catalog**: Unified access to remote Postgres, MySQL, and NoSQL sources via Foreign Data Wrappers.
- **Cross-Source JOINs**: Performant analytical queries merging local tenant data with remote warehouse data.

## 🛠 API Surface

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/api/auth/login` | POST | Administrative & Tenant Authentication |
| `/api/metadata/template` | GET | Download Universal Blueprint (v7.0) |
| `/api/metadata/migrate` | POST | Atomic Schema Evolution (Manifest-based) |
| `/api/metadata/crawl` | POST | Automated Metadata Discovery & Cataloging |
| `/api/analytics/query` | POST | AST-driven Query Execution with PII Masking |
| `/api/analytics/query-async` | POST | Long-running Background Analytical Jobs |

## 🧪 Verification
Run the ultimate industrial test suite:
```bash
npx ts-node src/scripts/test_full_orchestration.ts
```
