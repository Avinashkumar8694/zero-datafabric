# How-To Developer Guide

A step-by-step developer tutorial demonstrating how to connect data sources, provision relational structures, run federated queries, and sync downstream indices.

---

## Step 1: Connect a New Data Source

To connect an external database instance (e.g. MySQL) to the fabric, register its connection details:

```bash
curl -X POST http://localhost:4000/api/connections \
  -H "Authorization: Bearer $JWT_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "name": "Retail_MySQL",
    "type": "mysql",
    "config": {
      "host": "mysql-endpoint-dns",
      "port": 3306,
      "username": "fabric_user",
      "password": "secure_password",
      "database": "retail_db"
    }
  }'
```

---

## Step 2: Provision Schemas with Manifests

Write a metadata manifest file (`manifest.json`) defining your target database structures:

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

### Dry-Run the Changes (Diff)
Generate a migration roadmap showing what actions the orchestrator will take without writing changes:
```bash
curl -F "file=@manifest.json" \
  -H "Authorization: Bearer $JWT_TOKEN" \
  http://localhost:4000/api/metadata/diff
```

### Apply the Changes
Execute the migration roadmap across connected sources:
```bash
curl -F "file=@manifest.json" \
  -H "Authorization: Bearer $JWT_TOKEN" \
  http://localhost:4000/api/metadata/apply
```

---

## Step 3: Execute Federated Queries

Once the schema structures are active, query across separate physical endpoints in a single relational AST query. 

### Example: Join PostgreSQL `products` with MongoDB `order_details`
Submit this AST payload to `POST /api/analytics/query`:

```json
{
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
}
```

---

## Step 4: Stream Data Downstream (CDC)

Enable downstream replication to Elasticsearch to accelerate text searches.

1. Add the Elasticsearch downstream block to your `manifest.json` under the root level:
```json
"downstream": [
  {
    "type": "ELASTICSEARCH",
    "enabled": true,
    "fallback": "PRIMARY_SQL"
  }
]
```

2. Apply the manifest. The **Replication Engine** will subscribe to the PostgreSQL replication slot, capture mutations in real-time, and index them into Elasticsearch automatically.
3. Queries requesting search mappings can now hit Elasticsearch dynamically, avoiding heavy transactional queries on the hub.
