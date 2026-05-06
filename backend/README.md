# Zero-DataFabric Backend (Industrial Grade)

An enterprise-ready Data Fabric built on PostgreSQL, featuring multi-tenancy, virtualization, and zero-trust security.

## Core Modules

### [Module 1: Authentication & Identity](src/modules/auth)
- JWT-based authentication.
- Multi-tenant token issuance.

### [Module 2: Query Engine & Analytics](src/modules/query-engine)
- Tenant-isolated SQL execution.
- Automated schema management.

### [Module 3.1: Integration & Virtualization](src/modules/integration)
- PostgreSQL Foreign Data Wrapper (FDW) orchestration.
- Zero-copy data access.
- [Read Module Docs](src/modules/integration/README.md)

### [Module 3.2: Security & Governance](src/modules/security)
- Row-Level Security (RLS) enforcement.
- Immutable Audit Logging.
- Identity Proxying (IAM).
- [Read Module Docs](src/modules/security/README.md)

## Getting Started

### Prerequisites
- Node.js v18+
- PostgreSQL 14+

### Setup
1. `npm install`
2. `cp .env.example .env`
3. `npx ts-node src/tests/init-db.ts`

### Testing
```bash
npm test # Runs all suites
```

## Security Architecture (IAM)
The fabric enforces security at the database layer using **PostgreSQL RLS**. Every request is scoped to a `tenant_id` injected into the database session via an identity proxy.
