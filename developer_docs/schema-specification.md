# Relational Schema & AST Specification

This document provides the formal JSON schema specification for both the **AST Query Language** and the **Metadata Manifests** utilized inside the Zero Data Fabric.

---

## 1. AST Query Schema

AST queries are submitted as a JSON payload to `POST /api/analytics/query`.

```json
{
  "queryConfig": {
    "type": "SELECT",
    "schema": "logical_schema_name",
    "limit": 100,
    "query": {
      "select": ["column_name", { "aggregate": "SUM", "column": "amount", "alias": "total" }],
      "from": { "resource": "table_name", "source": "datasource_name", "alias": "alias_name" },
      "joins": [
        {
          "type": "INNER",
          "resource": "joined_table",
          "source": "joined_datasource",
          "alias": "joined_alias",
          "on": { "left": "alias_name.key", "operator": "EQ", "right": "joined_alias.key" }
        }
      ],
      "where": [
        { "column": "alias_name.field", "operator": "EQ", "value": "match_value" }
      ],
      "groupBy": ["alias_name.field"],
      "orderBy": [
        { "column": "alias_name.field", "direction": "DESC" }
      ],
      "offset": 0
    }
  }
}
```

### AST Query Property Validation
* **`type`**: `String` | Must equal `"SELECT"`.
* **`schema`**: `String` | The logical namespace to resolve (e.g. `Global_Supply_Chain`).
* **`limit`**: `Integer` | Enforces top-level row pagination constraint (maximum `1000` rows).
* **`query.from`**: `Object` | Base driving resource.
  * `resource`: `String` | Target table or collection name.
  * `source`: `String` | Physical connection name registered in Data Fabric connections.
  * `alias`: `String` | Local query namespace qualifier (must match references in joins and filters).
* **`query.select`**: `Array` | List of items to project:
  * Bare strings matching valid column expressions (e.g., `["id", "name"]` or `["*"]`).
  * Aggregation maps: `{"aggregate": "COUNT"|"SUM"|"AVG"|"MIN"|"MAX"|"COUNT_DISTINCT", "column": "column_name", "alias": "alias_name"}`.
* **`query.joins`**: `Array` | Collection of join parameters:
  * `type`: `String` | Supported: `INNER` or `LEFT`.
  * `resource` / `source` / `alias`: Matches same validation rules as driving `from`.
  * `on`: `Object` | Join key map: `{"left": "a.col", "operator": "EQ", "right": "b.col"}`.
* **`query.where`**: `Array` | List of filter maps:
  * `column`: `String` | Column reference qualified with alias if joining.
  * `operator`: `String` | Allowed comparison operator enums.
  * `value`: `Any` | Match value corresponding to column type.
* **`query.groupBy`**: `Array` | String columns to partition aggregates.
* **`query.orderBy`**: `Array` | Sorting configurations:
  * `column`: `String` | Target sort projection.
  * `direction`: `String` | Must equal `ASC` or `DESC`.

---

## 2. Metadata Manifest Schema

Metadata manifests define the target state of schemas, columns, constraints, and relationships. Submitted to `POST /api/metadata/apply`.

```json
{
  "version": "4.0",
  "namespace": "Logical_Namespace",
  "targetSource": "Fabric_Hub_Postgres",
  "consistencyMode": "SAGA",
  "extensions": ["uuid-ossp", "pgcrypto"],
  "downstream": [
    { "type": "ELASTICSEARCH", "enabled": true, "fallback": "PRIMARY_SQL" }
  ],
  "schemas": [
    {
      "name": "Logical_Schema_Name",
      "targetSource": "Fabric_Hub_Postgres",
      "resources": [
        {
          "type": "TABLE",
          "name": "table_name",
          "comment": "Description of resource metadata",
          "columns": [
            {
              "name": "column_name",
              "type": "UUID",
              "strategy": "UUID_V7",
              "primaryKey": true,
              "nullable": false
            }
          ],
          "constraints": [
            { "name": "check_rule", "type": "CHECK", "expression": "price > 0" }
          ],
          "security": {
            "enable_rls": true,
            "policies": [
              { "name": "row_isolation", "using": "tenant_id = current_setting('app.tenant_id')" }
            ],
            "masking": [
              { "column": "secret_field", "roles": ["viewer"], "expression": "'REDACTED'" }
            ],
            "grants": [
              { "role": "viewer", "privileges": ["SELECT"] }
            ]
          }
        }
      ]
    }
  ],
  "relationships": [
    {
      "name": "rel_name",
      "cardinality": "1:M",
      "from": { "resource": "parents", "field": "id" },
      "to": { "resource": "children", "field": "parent_id" }
    }
  ]
}
```

### Manifest Property Validation

#### Top-Level Parameters
* **`version`**: `String` | Manifest version (currently `4.0`).
* **`namespace`**: `String` | Global metadata classification domain.
* **`targetSource`**: `String` | Core database connection mapping for provisioning.
* **`consistencyMode`**: `String` | `SAGA` (coordinated rollback transactions) or `EVENTUAL`.
* **`extensions`**: `Array` | Required database engine extensions.
* **`downstream`**: `Array` | Downstream replication config objects (Elasticsearch/Snowflake).

#### Column Configuration Maps
* **`name`**: `String` | Column naming pattern.
* **`type`**: `String` | Relational type enum (e.g. `UUID`, `STRING`, `BIGINT`, `JSONB`).
* **`nullable`**: `Boolean` | Allows `NULL` entries (defaults to `true`).
* **`primaryKey`**: `Boolean` | Identifies primary unique record identifiers.
* **`unique`**: `Boolean` | Applies unique constraint on values.
* **`default`**: `String` | Default SQL statement value (e.g. `NOW()`, `0`).
* **`strategy`**: `String` | Key generation method.
* **`generated`**: `String` | Expression for computed/virtual fields.
* **`stored`**: `Boolean` | Persist generated output in storage instead of running on reads.

#### Relationships
* **`name`**: `String` | Relation identification key.
* **`cardinality`**: `String` | Entitled mapping scopes: `1:1`, `1:M`, or `M:N`.
* **`bridge`**: `String` | Bridge table name required exclusively for `M:N` relations.
* **`from`** / **`to`**: `Object` | Connection ends identifying `resource` and linking `field`.
