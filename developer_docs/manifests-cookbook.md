# Metadata Manifests Cookbook (test_manifest.json)

This document provides an exhaustive, step-by-step walkthrough of the **`test_manifest.json`** file configuration used to test and provision structures within the Zero Data Fabric.

---

## 1. Global Specifications & Downstream Sinks

At the root level, the manifest registers metadata headers, PostgreSQL extensions, and analytical replication targets:

```json
{
  "version": "4.0",
  "namespace": "Global_Supply_Chain",
  "targetSource": "Fabric_Hub_Postgres",
  "consistencyMode": "SAGA",
  "extensions": [
    "uuid-ossp",
    "pg_stat_statements"
  ],
  "downstream": [
    {
      "type": "ELASTICSEARCH",
      "enabled": true,
      "fallback": "PRIMARY_SQL"
    },
    {
      "type": "SNOWFLAKE",
      "enabled": true,
      "strategy": "CDC"
    }
  ]
}
```

### Explanation:
* **`consistencyMode`**: Set to `"SAGA"`, meaning if a provisioning step fails on a remote database during rollout, the orchestrator triggers transactional rollbacks across all other sources.
* **`extensions`**: Array of PostgreSQL extensions initialized on the core database automatically (e.g. enabling `uuid-ossp` for UUID v4 keys).
* **`downstream`**: Declares that all database updates on the hub are automatically captured by the CDC agent and mirrored into **Elasticsearch** (for text indexing) and **Snowflake** (for analytical queries).

---

## 2. Resource Enums & Sequences

Declaring custom domains and numerical sequence generators:

```json
{
  "type": "ENUM",
  "name": "shipment_status",
  "values": [
    "PENDING",
    "IN_TRANSIT",
    "DELIVERED",
    "CANCELLED"
  ]
},
{
  "type": "SEQUENCE",
  "name": "tracking_seq",
  "start": 100000,
  "increment": 1,
  "minValue": 100000,
  "maxValue": 999999999,
  "cache": 20,
  "ownedBy": {
    "table": "shipments",
    "column": "id"
  }
}
```

* **ENUM**: Forces strict input validation for the `status` column.
* **SEQUENCE**: Defines an integer generator (`tracking_seq`) starting at `100000` with a pre-allocated cache of `20` sequences to speed up concurrent writes on the `shipments` table.

---

## 3. Complex Tables & Row-Level Security (RLS)

The `shipments` table represents a production-grade database structure combining identity strategies, check constraints, database triggers, row level security policies, and column masking:

```json
{
  "type": "TABLE",
  "name": "shipments",
  "comment": "Master table for global logistics tracking",
  "columns": [
    {
      "name": "id",
      "type": "UUID",
      "default": "uuid_generate_v7()",
      "strategy": "UUID_V7"
    },
    {
      "name": "internal_id",
      "type": "BIGINT",
      "strategy": "IDENTITY_ALWAYS"
    },
    {
      "name": "region",
      "type": "STRING",
      "length": 10,
      "collation": "en_US.utf8"
    },
    {
      "name": "deleted_at",
      "type": "TIMESTAMP",
      "nullable": true,
      "strategy": "SOFT_DELETE"
    }
  ],
  "constraints": [
    {
      "name": "check_region_format",
      "type": "CHECK",
      "expression": "region ~ '\''^[A-Z]{2,3}$'\''"
    }
  ],
  "security": {
    "enable_rls": true,
    "masking": [
      {
        "column": "metadata",
        "roles": ["logistics_viewer"],
        "expression": "'\''REDACTED'\''"
      }
    ],
    "policies": [
      {
        "name": "regional_isolation",
        "roles": ["fabric_user"],
        "using": "region = current_setting('\''app.current_region'\'')"
      },
      {
        "name": "hide_deleted",
        "using": "deleted_at IS NULL"
      }
    ]
  }
}
```

### Key Configurations:
1. **`SOFT_DELETE` Strategy**: Column `deleted_at` tracks record removal. The database engine filters out records with non-null values.
2. **`CHECK` Constraints**: Enforces a regular expression constraint requiring `region` to be a 2 or 3 letter uppercase code.
3. **`enable_rls`**: Enables Row-Level Security.
   * `regional_isolation`: Entitles roles of type `fabric_user` to read rows matching their active context region session setting (`app.current_region`).
   * `hide_deleted`: Globally restricts regular users from reading soft-deleted records.
4. **Column Masking**: Overwrites sensitive `metadata` values with the string `'REDACTED'` for users connected with the `logistics_viewer` role.

---

## 4. Functions & Procedures

Custom logic mapped directly to SQL store handlers:

```json
{
  "type": "FUNCTION",
  "name": "generate_custom_id",
  "arguments": [
    { "name": "p_region", "type": "STRING" }
  ],
  "returnType": "STRING",
  "body": "DECLARE v_seq BIGINT; BEGIN v_seq := nextval('\''tracking_seq'\''); RETURN p_region || '\''-'\'' || to_char(NOW(), '\''YYYY'\'') || '\''-'\'' || lpad(v_seq::text, 8, '\''0'\''); END;"
}
```

* **Function**: Accepts a region string and computes a composite, padded alphanumeric identifier (e.g. `US-2026-00100001`) during insert steps.

---

## 5. Advanced Virtualizations (Views & MViews)

Views allow for hierarchical recursion, complex aggregates, and search filters.

### Recursive View (Management Hierarchy)
Reconstructs supervisor-employee paths dynamically:

```json
{
  "type": "VIEW",
  "name": "org_hierarchy_recursive",
  "recursive": true,
  "query": {
    "with": [
      {
        "name": "emp_path",
        "columns": ["id", "name", "manager_id", "path", "level"],
        "base": {
          "select": [
            "id", "name", "manager_id",
            { "expression": "name", "alias": "path" },
            { "expression": "1", "alias": "level" }
          ],
          "from": { "resource": "employees" },
          "where": [{ "column": "manager_id", "operator": "IS_NULL" }]
        },
        "unionAll": {
          "select": [
            "e.id", "e.name", "e.manager_id",
            { "expression": "ep.path || '\'' -> '\'' || e.name" },
            { "expression": "ep.level + 1" }
          ],
          "from": { "resource": "employees", "alias": "e" },
          "joins": [
            {
              "type": "INNER",
              "resource": "emp_path",
              "alias": "ep",
              "on": { "left": "e.manager_id", "operator": "EQ", "right": "ep.id" }
            }
          ]
        }
      }
    ],
    "select": ["*"],
    "from": { "resource": "emp_path" }
  }
}
```

### Materialized View with Concurrent Refresh
Stores pre-aggregated regional shipment statistics:

```json
{
  "type": "MATERIALIZED_VIEW",
  "name": "regional_volume_stats",
  "refreshStrategy": "CONCURRENTLY",
  "refreshInterval": "1 hour",
  "query": {
    "select": [
      { "column": "region" },
      { "aggregate": "COUNT", "alias": "volume" }
    ],
    "from": { "resource": "shipments" },
    "groupBy": ["region"]
  },
  "indexes": [
    {
      "columns": ["region"],
      "unique": true
    }
  ]
}
```

* **Materialized View**: Refreshed asynchronously every hour. Includes a unique index on `region` to support safe `CONCURRENT` updates without lock blocks on read operations.

---

## 6. Relationships (1:1, 1:M, M:N)

Declares connection maps linking tables across separate engines:

```json
"relationships": [
  {
    "name": "rel_1_1_shipment_details",
    "cardinality": "1:1",
    "from": { "resource": "shipments", "field": "id" },
    "to": { "resource": "shipment_details", "field": "shipment_id" }
  },
  {
    "name": "rel_1_M_shipment_logs",
    "cardinality": "1:M",
    "from": { "resource": "shipments", "field": "id" },
    "to": {
      "source": "Activity_Mongo",
      "resource": "shipment_audit_logs",
      "field": "shipment_id"
    }
  },
  {
    "name": "rel_M_N_shipment_tags",
    "cardinality": "M:N",
    "bridge": "shipment_tags_link",
    "from": { "resource": "shipments", "field": "id" },
    "to": {
      "source": "External_Warehouse",
      "resource": "global_tags",
      "field": "id"
    }
  }
]
```

* **`1:1`**: Simple primary key relation.
* **`1:M`**: Links one PostgreSQL shipment record to multiple MongoDB audit event logs.
* **`M:N`**: Links shipments to tags across databases using `shipment_tags_link` as the bridging connector table.
