# 🌌 Industrial Data Fabric 🚀

**A production-grade, multi-tenant Data Fabric built on PostgreSQL.** 
Engineered for zero-trust security, automated virtualization, and identity-aware analytics.

---

## 🛠️ Monorepo Orchestration

Manage the entire fabric lifecycle with high-level commands from the root directory.

| Command | Action |
| :--- | :--- |
| `npm run setup` | **Full Lifecycle Initialization** (Install -> Infra -> Migrate) |
| `npm start` | **Launch Fabric** (Runs Backend & UI concurrently) |
| `npm run stop` | **Emergency Shutdown** (Clears all fabric ports) |
| `npm run db:migrate` | **Schema Provisioning** (RLS & Governance rollout) |
| `npm run infra:up` | **Infrastructure Spin-up** (Postgres, Kafka, PostgREST) |

---

## 📦 Core Modules

### 🔐 Module 1: Auth & Identity (Zero-Trust)
- **Features**: JWT-based identity proxy, session context injection, and role propagation.
- **UI**: Premium Login and real-time **Identity Switcher**.

### 📊 Module 2: Query Engine & Analytics
- **Features**: Synchronous & Asynchronous SQL execution with native RLS enforcement.
- **UI**: **Query Workbench** for live multi-tenant data exploration.

### 🔗 Module 3: Integration & Security (FDW)
- **Features**: Automated virtualization (FDW), ID-aware CDC, and tamper-proof audit trails.
- **UI**: **Connection Manager** and **Security Forensics Viewer**.

---

## Getting Started: Monorepo Orchestration

The root `package.json` provides unified commands to manage the entire fabric lifecycle.

### 1. One-Step Setup
Installs all dependencies, starts infrastructure, and migrates the database.
```bash
npm run setup
```

### 2. Infrastructure Management
```bash
npm run infra:up    # Start Postgres, Kafka, PostgREST
npm run infra:down  # Stop and remove infrastructure
```

### 3. Database Migration
```bash
npm run db:migrate  # Provision schemas and policies
```

### 4. Running the Fabric
```bash
npm start           # Run Backend and UI concurrently
npm run stop        # Stop all running fabric processes
```

### 5. Individual Services
```bash
npm run start:backend
npm run start:ui
```

---

## Feature Tour (UI Access)

### Accessing the Dashboard
1. Open `http://localhost:3001`
2. Login (Demo credentials: any tenant ID like `tenant_A`)
3. Use the **Identity Switcher** at the top to toggle between different tenant contexts.

### Module 1: Switch Identity
Change the **Identity Context** in the header. Notice how the Active Connections, Metadata, and Audit Logs automatically filter to the selected tenant.

### Module 2: Execute Queries
Go to the **Query Workbench**. Try running:
```sql
-- Replace tenant_A with your active tenant schema
SELECT * FROM tenant_tenant_A.orders;
```
Switch the identity and run it again. RLS will ensure you only see data belonging to your active context.

### Module 3: Manage Connections
Use the **Virtual Data Sources** form to link a remote PostgreSQL database. Monitor the **Security Audit Trail** below to see the immutable record of the link establishment.

---

## Verification & Tests
Run the industrial test suite to verify end-to-end integrity:
```bash
cd backend
npm test
```
