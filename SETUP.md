# Zero Data Fabric — Setup Guide

## Prerequisites

| Requirement | Notes |
|---|---|
| Node.js 18+ | |
| Docker + Docker Compose | latest |
| zero-identity-server | running on port 3000 (IDS Postgres on 5422) |

---

## Development Mode

Full local setup with demo data, example schemas, and seed rows — self-sufficient for testing.

### Step 1 — First-time setup (infra + migrate + seed admin)

```bash
npm run dev:setup
```

Runs in order:
1. `npm install` for root + backend + ui
2. `docker-compose up -d` — starts all containers
3. `db:migrate` — applies all SQL migrations from `db/init/`
4. `seed:dev` — seeds OIDC client, tenant_A, admin user, 4 data source connections

### Step 2 — Start the server

```bash
npm start
# or:
npm run dev:start
```

Starts concurrently:
- **Backend API** → http://localhost:4000
- **UI** → http://localhost:3001
- **Trigger Engine** → background worker

### Step 3 — Load demo schemas + data (requires server running)

```bash
npm run seed:dev:demo
```

Registers 3 sources, applies the `Global_Supply_Chain` manifest, creates all schemas, and seeds demo rows (inventory, employees, shipments, shipment_details).

### Default dev credentials

| Field | Value |
|---|---|
| Username | `admin` or `admin@fabrixly.com` |
| Password | `admin` |
| Tenant | `tenant_A` |

---

## Production Mode

Minimal seed — system admin, OIDC client, tenant_A only. No demo schemas or rows.

### Step 1 — First-time setup

```bash
npm run prod:setup
```

### Step 2 — Start

```bash
npm run prod:start
```

---

## What each seed does

| Script | What it seeds |
|---|---|
| `seed:dev` | OIDC client, tenant_A, admin user, 4 data source connection records |
| `seed:dev:demo` | Applies demo manifest (Global_Supply_Chain schema), all demo rows via API |
| `seed:prod` | OIDC client, tenant_A, admin user only |

---

## Running Examples

After `seed:dev:demo`, the demo environment is ready:

```bash
# Run the full core suite (8 scripts, ~10s)
npm run examples:all

# Individual groups
npm run examples:queries        # all query types (SQL + AST)
npm run examples:multisource    # federated cross-source queries
npm run examples:inserts        # inserts across all data source types
npm run examples:views          # views, materialized views, sequences, procedures, triggers
npm run examples:mutations      # UPDATE / DELETE advanced patterns
npm run examples:complex        # aggregations, window functions, CTEs
npm run examples:triggers       # trigger engine E2E

# Advanced cross-source scenarios (each self-seeds its own external data)
npm run examples:distributed    # 3 external DBs, 50k+ rows, pushdown assertions
npm run examples:churn          # 4 sources, RFM + cohort analysis
npm run examples:elasticsearch  # Elasticsearch full-text + aggregations

# Governance / policy / recursive
npm run examples:governance     # constraints + grants + functions on Mongo
npm run examples:policy         # column masking, RLS
npm run examples:recursive      # recursive CTEs, org hierarchies

# Analytics API
npm run examples:analytics      # analytics query engine (AST + SQL)
npm run examples:analytics:all  # all analytics types including async
```

---

## Fresh restart (reset everything)

```bash
npm run infra:down              # stop containers (keeps volumes)
docker-compose down -v          # ⚠ full reset including DB volumes

npm run dev:setup               # bring back up + migrate + seed admin
npm start                       # start server
npm run seed:dev:demo           # load demo schemas + rows
```

---

## Stopping

```bash
npm run stop       # kill backend (4000) + UI (3001) processes
npm run infra:down # stop Docker containers
```

---

## Port Reference

| Service | Port |
|---|---|
| Backend API | 4000 |
| UI | 3001 |
| Identity Server (IDS) | 3000 |
| Hub Postgres | 5434 |
| IDS Postgres | 5422 |
| Remote Postgres (examples) | 5436 |
| MongoDB | 27017 |
| Elasticsearch | 9200 |
| Redis | 6379 |
