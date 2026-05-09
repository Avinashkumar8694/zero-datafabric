# Elasticsearch In Data Fabric

This document explains exactly how Elasticsearch is used in this project: what existed before, what was added, when indexing happens, what result to expect, and how to verify everything in Kibana/API.

## 1. What Was Available vs What Was Added

Earlier state:
- Elasticsearch container could run.
- Elasticsearch connection could be registered.
- Downstream status could be shown.

What is now implemented:
- Real indexing during metadata apply for local hub tables.
- Index creation per table with generated mappings.
- Bulk document load from tenant schema tables into Elasticsearch.
- Kibana included in local docker-compose for visual inspection.
- Engine-aware connection form fields in UI.
- Live connection checks with clear status (`LIVE`, `UNREACHABLE`, etc.).

## 2. Why Elasticsearch Is Used

Use Elasticsearch for:
- fast text search over large datasets
- relevance/fuzzy search
- low-latency search APIs and dashboards

Keep Postgres/Mongo as:
- source of truth
- transactional write store
- integrity-enforced system

In this project, Elasticsearch is a downstream search target enabled in manifest via:

```json
{
  "downstream": [
    { "type": "ELASTICSEARCH", "enabled": true, "fallback": "PRIMARY_SQL" }
  ]
}
```

## 3. Local Services and UI

Local services:
- Elasticsearch: `http://127.0.0.1:9200`
- Kibana: `http://127.0.0.1:5601`

Start:

```bash
npm run infra:up
```

Health:

```bash
curl -s http://127.0.0.1:9200/_cluster/health
```

Important Kibana note:
- If Kibana opens on **Integrations**, that is normal.
- For Data Fabric search verification, use **Dev Tools** and **Discover**.

## 4. Default Seeded Connection

`backend/src/seed_admin.ts` seeds this for `tenant_A`:

```json
{
  "name": "Elastic_Search",
  "type": "ELASTICSEARCH",
  "sync_type": "VIRTUAL",
  "config": {
    "host": "localhost",
    "port": 9200,
    "connectionString": "http://localhost:9200"
  }
}
```

If Elasticsearch security is enabled, add:
- `user`
- `pass`

The backend health check supports Basic Auth.

## 5. Connection Form Fields (Engine-Aware)

The Add Connection UI is dynamic by engine:

- PostgreSQL/MySQL:
  - `host`, `port`, `dbName`, `user`, `pass`
- MongoDB:
  - `connectionString` OR `host`/`port` (+ optional `dbName`, `user`, `pass`)
- Elasticsearch:
  - `connectionString` OR `host`/`port` (+ optional `user`, `pass`)
- Snowflake:
  - `account`, `user`, `pass` (+ recommended: `warehouse`, `role`, `schema`)

Use **Check All Connections** in Connections page to refresh live status.

## 6. End-to-End Runtime Flow (What Happens and When)

### Step A: Register/Verify Connection
1. Open `/connections`.
2. Add or verify `Elastic_Search`.
3. Click **Check All Connections**.
4. Expected: `live_status = LIVE`.

### Step B: Apply Metadata
1. Trigger `POST /api/metadata/apply` (UI or API).
2. During apply:
   - Downstream service resolves Elasticsearch connector for tenant.
   - For each local hub table in manifest, it:
     - creates index if missing
     - generates mapping from table column types
     - fetches table rows from Postgres tenant schema
     - bulk indexes rows into Elasticsearch
3. Apply response includes downstream provisioning summary.

### Step C: Query Search Data
1. Open Kibana Dev Tools.
2. Check indices and docs.
3. Use Discover/dashboard as needed.

## 7. Expected Results

After successful apply:
- Elasticsearch has indices per table, e.g.:
  - `tenant_a_global_supply_chain_shipments`
- `_search` returns documents
- Connections page shows Elasticsearch `LIVE`
- Downstream status is `ACTIVE/PROVISIONED` (if configured and reachable)

If Elasticsearch is unreachable:
- Connection live status becomes `UNREACHABLE`
- Downstream status may become `ERROR`/`NOT_CONFIGURED`
- Core metadata apply can still complete for primary DB orchestration

## 8. Verification Commands

### API Checks

Login:
```bash
curl -s -X POST http://127.0.0.1:4000/api/auth/login \
  -H "Content-Type: application/json" \
  -d '{"username":"admin","password":"admin"}'
```

Connections:
```bash
curl -s http://127.0.0.1:4000/api/admin/connections \
  -H "Authorization: Bearer <token>"
```

Downstream:
```bash
curl -s http://127.0.0.1:4000/api/metadata/downstream \
  -H "Authorization: Bearer <token>"
```

### Elasticsearch Checks

```bash
curl -s http://127.0.0.1:9200/_cat/indices?v
curl -s "http://127.0.0.1:9200/tenant_a_global_supply_chain_shipments/_search?q=*&size=10"
```

### Kibana Dev Tools

```http
GET _cluster/health
GET _cat/indices?v
GET tenant_a_global_supply_chain_shipments/_search?q=*&size=10
```

## 9. Current Limitation / Next Step

Current implementation performs indexing during metadata apply (initial load / re-apply path).

Planned next improvement:
- continuous sync on every `INSERT/UPDATE/DELETE` mutation event so Elasticsearch updates in near real-time without requiring re-apply.
