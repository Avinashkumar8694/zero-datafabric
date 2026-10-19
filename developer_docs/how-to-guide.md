# How-To Developer Guide

A step-by-step developer tutorial demonstrating how to connect data sources, provision relational structures, run federated queries, and sync downstream indices, complete with executable `curl` commands.

---

## Step 1: Connect a New Data Source

To connect an external database instance (e.g. MySQL) to the fabric, register its connection details:

* **Endpoint**: `POST /api/connections`
* **Headers**:
  * `Authorization: Bearer $JWT_TOKEN`
  * `x-tenant-id: tenant_A`
  * `Content-Type: application/json`

### Curl Command:
```bash
curl -X POST http://localhost:4000/api/connections \
  -H "Authorization: Bearer $JWT_TOKEN" \
  -H "x-tenant-id: tenant_A" \
  -H "Content-Type: application/json" \
  -d '{
    "name": "Warehouse_MySQL",
    "type": "mysql",
    "config": {
      "host": "mysql-prod-endpoint",
      "port": 3306,
      "username": "fabric_reader",
      "password": "secure_password",
      "database": "warehouse_db"
    }
  }'
```

---

## Step 2: Provision Schemas with Manifests

Create a metadata manifest file (`manifest.json`) defining your target database structures:

```json
{
  "version": "4.0",
  "namespace": "Production_Core",
  "targetSource": "Fabric_Hub_Postgres",
  "schemas": [
    {
      "name": "Inventory",
      "targetSource": "Fabric_Hub_Postgres",
      "resources": [
        {
          "type": "TABLE",
          "name": "products",
          "columns": [
            { "name": "id", "type": "UUID", "strategy": "UUID_V7", "primaryKey": true },
            { "name": "sku", "type": "STRING", "length": 50, "unique": true },
            { "name": "stock_count", "type": "BIGINT", "default": "0" }
          ]
        }
      ]
    }
  ]
}
```

### A. Dry-Run the Changes (Diff)
Generate a migration roadmap showing what actions the orchestrator will take without writing changes:

* **Endpoint**: `POST /api/metadata/diff`
* **Headers**:
  * `Authorization: Bearer $JWT_TOKEN`
  * `x-tenant-id: tenant_A`
  * `Content-Type: multipart/form-data`

```bash
curl -X POST http://localhost:4000/api/metadata/diff \
  -H "Authorization: Bearer $JWT_TOKEN" \
  -H "x-tenant-id: tenant_A" \
  -F "file=@manifest.json"
```

### B. Apply the Changes
Execute the migration roadmap across connected sources:

* **Endpoint**: `POST /api/metadata/apply`
* **Headers**: Same as diff.

```bash
curl -X POST http://localhost:4000/api/metadata/apply \
  -H "Authorization: Bearer $JWT_TOKEN" \
  -H "x-tenant-id: tenant_A" \
  -F "file=@manifest.json"
```

---

## Step 3: Execute Federated Queries

Once the schema structures are active, query across separate physical endpoints in a single relational AST query.

* **Endpoint**: `POST /api/analytics/query`
* **Headers**:
  * `Authorization: Bearer $JWT_TOKEN`
  * `x-tenant-id: tenant_A`
  * `Content-Type: application/json`

### Example: Join PostgreSQL `products` with MongoDB `orders`
Submit this AST payload:

```bash
curl -X POST http://localhost:4000/api/analytics/query \
  -H "Authorization: Bearer $JWT_TOKEN" \
  -H "x-tenant-id: tenant_A" \
  -H "Content-Type: application/json" \
  -d '{
    "queryConfig": {
      "type": "SELECT",
      "schema": "Inventory",
      "limit": 100,
      "query": {
        "select": [
          "p.sku",
          "p.stock_count",
          "o.customer_id",
          "o.quantity"
        ],
        "from": { "resource": "products", "source": "Fabric_Hub_Postgres", "alias": "p" },
        "joins": [
          {
            "type": "INNER",
            "resource": "orders",
            "source": "Sales_Mongo",
            "alias": "o",
            "on": { "left": "p.id", "operator": "EQ", "right": "o.product_id" }
          }
        ],
        "where": [
          { "column": "p.stock_count", "operator": "GT", "value": 0 }
        ]
      }
    }
  }'
```

---

## Step 4: Stream Data Downstream (CDC)

Enable downstream replication to Elasticsearch to accelerate text searches.

### A. Register Downstream in Manifest (`manifest.json`)
Add the `downstream` block to your manifest:

```json
{
  "version": "4.0",
  "namespace": "Production_Core",
  "targetSource": "Fabric_Hub_Postgres",
  "downstream": [
    {
      "type": "ELASTICSEARCH",
      "enabled": true,
      "fallback": "PRIMARY_SQL"
    }
  ],
  "schemas": [
    {
      "name": "Inventory",
      "targetSource": "Fabric_Hub_Postgres",
      "resources": [
        {
          "type": "TABLE",
          "name": "products",
          "columns": [
            { "name": "id", "type": "UUID", "strategy": "UUID_V7", "primaryKey": true },
            { "name": "sku", "type": "STRING", "length": 50, "unique": true },
            { "name": "stock_count", "type": "BIGINT", "default": "0" }
          ]
        }
      ]
    }
  ]
}
```

### B. Apply Manifest to Trigger Downstream Sync
Submit the updated manifest file:

```bash
curl -X POST http://localhost:4000/api/metadata/apply \
  -H "Authorization: Bearer $JWT_TOKEN" \
  -H "x-tenant-id: tenant_A" \
  -F "file=@manifest.json"
```

The Replication Engine automatically subscribes to write-ahead logs, captures updates in real-time, and streams them into the Elasticsearch index. Subsequent queries matching search requirements are routed to Elasticsearch dynamically.
