# Complex CRUD Integration Guide

This document gathers all advanced and complex CRUD operations supported by the Zero Data Fabric query engine, covering cross-engine transactions, RLS restrictions, full-text searches, and cascading soft-deletes.

---

## 1. Complex Creates (Batch, Constraints & Functions)

Executing batch inserts on tables that utilize custom procedures, functional default generators, and database check constraints.

### Scenario: Batch insert on Citrus partition table with CHECK format validation
Inserting shipments with region and status properties. The `custom_id` is automatically evaluated via `generate_custom_id(region)` on the Postgres coordinator.

```json
{
  "source": "Fabric_Hub_Postgres",
  "resource": "shipments",
  "data": [
    {
      "region": "USA",
      "status": "PENDING",
      "total_amount": 1450.50,
      "metadata": { "priority": "high", "delivery_deadline": "24h" }
    },
    {
      "region": "EU",
      "status": "PENDING",
      "total_amount": 890.00,
      "metadata": { "priority": "normal", "delivery_deadline": "72h" }
    }
  ]
}
```

#### AST Query Equivalent:
```json
{
  "queryConfig": {
    "type": "INSERT",
    "schema": "Global_Supply_Chain",
    "query": {
      "into": { "resource": "shipments", "source": "Fabric_Hub_Postgres" },
      "columns": ["region", "status", "total_amount", "metadata"],
      "values": [
        ["USA", "PENDING", 1450.50, { "priority": "high" }],
        ["EU", "PENDING", 890.00, { "priority": "normal" }]
      ]
    }
  }
}
```

#### Compiled Database Actions:
```sql
-- Evaluates CHECK expression: region ~ '^[A-Z]{2,3}$' (throws 400 bad request for 'USA' as length is 3 but uppercase validation fails if format mismatch)
-- Automatically evaluates: custom_id = generate_custom_id(region)
INSERT INTO "public"."shipments" ("region", "status", "total_amount", "metadata")
VALUES ('USA', 'PENDING', 1450.50, '{"priority":"high"}'), ('EU', 'PENDING', 890.00, '{"priority":"normal"}');
```

---

## 2. Complex Reads (Bind Joins, Full-Text, Grouping)

Executing multi-datasource bind-joins combined with complex text searches and aggregate groups.

### Scenario: Federated join (Postgres ⋈ MongoDB) filtered by Full-Text search on notes
Retrieve regional revenue stats for all active shipments containing "priority" notes in their details.

```json
{
  "queryConfig": {
    "type": "SELECT",
    "schema": "Global_Supply_Chain",
    "limit": 50,
    "query": {
      "select": [
        "s.region",
        { "aggregate": "SUM", "column": "s.total_amount", "alias": "revenue" }
      ],
      "from": { "resource": "shipments", "source": "Fabric_Hub_Postgres", "alias": "s" },
      "joins": [
        {
          "type": "INNER",
          "resource": "shipment_details",
          "source": "Fabric_Hub_Postgres",
          "alias": "d",
          "on": { "left": "s.id", "operator": "EQ", "right": "d.shipment_id" }
        },
        {
          "type": "INNER",
          "resource": "shipment_audit_logs",
          "source": "Activity_Mongo",
          "alias": "m",
          "on": { "left": "s.id", "operator": "EQ", "right": "m.shipment_id" }
        }
      ],
      "where": [
        {
          "search": {
            "column": "d.notes",
            "type": "FULL_TEXT",
            "query": "priority"
          }
        },
        { "column": "s.status", "operator": "IN", "value": ["PENDING", "IN_TRANSIT"] }
      ],
      "groupBy": ["s.region"]
    }
  }
}
```

#### Compiled Database Actions:
1. **Step 1**: The coordinator issues the full-text search on PostgreSQL:
   ```sql
   SELECT s.id, s.region, s.total_amount 
   FROM public.shipments s
   INNER JOIN public.shipment_details d ON s.id = d.shipment_id
   WHERE to_tsvector('english', d.notes) @@ to_tsquery('english', 'priority')
     AND s.status IN ('PENDING', 'IN_TRANSIT');
   ```
2. **Step 2**: The returning shipment UUID keys (e.g. `['0190a5...', '0190a8...']`) are structured as a bind-join array filter and passed in-memory to MongoDB:
   ```json
   db.shipment_audit_logs.find({ "shipment_id": { "$in": ["0190a5f2-bbc2-4e95-b20b-6b518e95b25c", "0190a8a1-bca8-4e74-9074-9e1dd5cda607"] } })
   ```
3. **Step 3**: The coordinator combines both datasets and groups them by `region` to compute the `SUM(total_amount)` aggregate.

---

## 3. Complex Updates (Row-Level Security Controls)

Evaluating row-level security isolation during record modifications.

### Scenario: Regional user updates transaction status
A regional user assigned with `fabric_user` attempts to update shipment state. The system must validate RLS constraints natively.

```json
{
  "source": "Fabric_Hub_Postgres",
  "resource": "shipments",
  "where": {
    "id": "0190a5f2-bbc2-4e95-b20b-6b518e95b25c"
  },
  "data": {
    "status": "DELIVERED"
  }
}
```

#### Compiled Database Action (using Session context parameters):
```sql
-- Coordinates session parameters before firing transaction
SET LOCAL app.current_region = 'US';

-- Modifications fail if target row region does not match 'US'
UPDATE "public"."shipments" 
SET "status" = 'DELIVERED' 
WHERE "id" = '0190a5f2-bbc2-4e95-b20b-6b518e95b25c'
  AND ("region" = current_setting('app.current_region'));
```

---

## 4. Complex Deletions (Cascade Soft-Deletes)

Soft deleting rows without violating constraints.

### Scenario: Soft-deleting shipment structures
Mark a canceled shipment record. The engine updates timestamps natively:

```json
{
  "source": "Fabric_Hub_Postgres",
  "resource": "shipments",
  "where": {
    "status": "CANCELLED"
  }
}
```

#### Compiled Database Actions:
```sql
-- Cascading soft-delete marks the shipments table
UPDATE "public"."shipments" 
SET "deleted_at" = NOW() 
WHERE "status" = 'CANCELLED';

-- Subscribed downstream replication queues are notified of deletion event
-- causing matching documents to be dropped from Elasticsearch indices automatically.
```
