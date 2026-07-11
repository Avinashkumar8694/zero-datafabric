# Metadata & Manifests

Declarative schema management. You describe the **target state** of your schemas
across sources in a manifest; the orchestrator diffs it against the live catalog
and applies the delta (creating enums, sequences, tables, views, functions,
relationships, …) on the tenant's managed schemas and dispatching to external
sources under SAGA consistency.

| Endpoint | Purpose |
|----------|---------|
| `POST /api/metadata/diff` (multipart `file`) | dry-run: show the ordered plan, write nothing |
| `POST /api/metadata/apply` (multipart `file`) | execute the plan |
| `GET /api/metadata/export?source=` | reverse: export the live catalog as a manifest |
| `POST /api/metadata/crawl` | introspect sources into the catalog |

```bash
curl -F "file=@manifest.json" http://localhost:4000/api/metadata/diff  -H "Authorization: Bearer $T" -H "x-tenant-id: tenant_A"
curl -F "file=@manifest.json" http://localhost:4000/api/metadata/apply -H "Authorization: Bearer $T" -H "x-tenant-id: tenant_A"
```

---

## Top-level shape

```jsonc
{
  "version": "4.0",
  "namespace": "My_Domain",
  "targetSource": "Fabric_Hub_Postgres",
  "consistencyMode": "SAGA",           // optional
  "extensions": ["uuid-ossp"],          // optional Postgres extensions
  "downstream": [ … ],                  // optional ES / Snowflake sinks
  "schemas": [ { "name", "targetSource", "resources": [ … ] } ],
  "relationships": [ … ]
}
```

A **schema** groups resources and names its `targetSource` (so different schemas
in one manifest can provision into different engines). A **resource** is typed.

## Resource types

### TABLE

```jsonc
{
  "type": "TABLE",
  "name": "assets",
  "comment": "…",
  "columns": [ … ],
  "constraints": [ … ],
  "triggers": [ … ],
  "security": { … }
}
```

#### Columns

```jsonc
{ "name": "id",         "type": "UUID",   "strategy": "UUID_V7", "primaryKey": true }
{ "name": "serial_no",  "type": "BIGINT", "strategy": "IDENTITY_ALWAYS" }
{ "name": "legacy_id",  "type": "SERIAL", "strategy": "LEGACY_SERIAL" }
{ "name": "code",       "type": "STRING", "default": "generate_custom_id(region)", "strategy": "FUNCTIONAL" }
{ "name": "region",     "type": "STRING", "length": 10, "collation": "en_US.utf8" }
{ "name": "label",      "type": "STRING", "generated": "id || ' [' || region || ']'", "stored": true }
{ "name": "status",     "type": "ENUM",   "ref": "asset_status", "default": "DRAFT" }
{ "name": "attributes", "type": "JSONB",  "index": { "type": "GIN" } }
{ "name": "created_at", "type": "TIMESTAMP", "default": "NOW()", "index": { "type": "BRIN" } }
{ "name": "email",      "type": "STRING", "unique": true }
{ "name": "deleted_at", "type": "TIMESTAMP", "nullable": true, "strategy": "SOFT_DELETE" }
```

- **types**: `UUID BIGINT SERIAL STRING(+length) NUMERIC TIMESTAMP JSONB BOOLEAN ENUM(+ref)`.
- **strategies**: `UUID_V7`, `IDENTITY_ALWAYS`, `LEGACY_SERIAL`, `FUNCTIONAL`
  (default via function), `SOFT_DELETE`.
- **generated/stored**: generated column expression.
- **index**: `{ "type": "GIN" | "BRIN" | "BTREE" }` or `true`.
- flags: `primaryKey`, `unique`, `nullable`, `readonly`.

#### Constraints

```jsonc
{ "name": "chk_region", "type": "CHECK", "expression": "region ~ '^[A-Z]{2,3}$'" }
{ "name": "excl_overlap", "type": "EXCLUDE", "using": "GIST",
  "columns": [ { "name": "region", "operator": "=" }, { "name": "created_at", "operator": "=" } ] }
```

#### Triggers

```jsonc
{ "name": "trg_audit", "timing": "AFTER", "events": ["INSERT", "UPDATE"],
  "execution": "row", "procedure": "audit_log_fn" }
```

#### Row-level security

```jsonc
"security": {
  "enable_rls": true,
  "policies": [
    { "name": "region_isolation", "roles": ["fabric_user"], "using": "region = current_setting('app.current_region')" },
    { "name": "hide_deleted", "using": "deleted_at IS NULL" }
  ],
  "masking": [ { "column": "attributes", "roles": ["viewer"], "expression": "'REDACTED'" } ],
  "grants":  [ { "role": "viewer", "privileges": ["SELECT"] } ]
}
```

### ENUM
```jsonc
{ "type": "ENUM", "name": "asset_status", "values": ["DRAFT", "ACTIVE", "ARCHIVED"] }
```

### SEQUENCE
```jsonc
{ "type": "SEQUENCE", "name": "asset_seq", "start": 500000, "increment": 1,
  "minValue": 500000, "maxValue": 999999999, "cache": 20,
  "ownedBy": { "table": "assets", "column": "id" } }
```

### FUNCTION / PROCEDURE
```jsonc
{ "type": "FUNCTION", "name": "generate_custom_id",
  "arguments": [ { "name": "p_region", "type": "STRING" } ], "returnType": "STRING",
  "body": "DECLARE v BIGINT; BEGIN v := nextval('asset_seq'); RETURN p_region||'-'||v; END;" }

{ "type": "PROCEDURE", "name": "archive_asset",
  "parameters": [ { "name": "p_id", "type": "UUID", "mode": "IN" } ],
  "body": "UPDATE assets SET status='ARCHIVED' WHERE id = p_id;" }
```

### VIEW / MATERIALIZED_VIEW

Views are defined with a query **AST** (same shape as the query language, plus
`with`/`window`/`recursive`):

```jsonc
{ "type": "VIEW", "name": "region_rank", "query": {
  "select": [ { "column": "region" },
              { "aggregate": "SUM", "column": "value", "alias": "total" },
              { "window": "RANK", "partitionBy": ["region"], "orderBy": [ { "column": "value", "direction": "DESC" } ], "alias": "rank" } ],
  "from": { "resource": "assets" }, "groupBy": ["region", "value"] } }

{ "type": "MATERIALIZED_VIEW", "name": "volume_by_region", "refreshStrategy": "CONCURRENTLY",
  "refreshInterval": "1 hour",
  "query": { "select": [ { "column": "region" }, { "aggregate": "COUNT", "alias": "volume" } ],
             "from": { "resource": "assets" }, "groupBy": ["region"] },
  "indexes": [ { "columns": ["region"], "unique": true } ] }
```

**Recursive view** — set `"recursive": true` and use `with[].base` + `with[].unionAll`:
```jsonc
{ "type": "VIEW", "name": "org_tree", "recursive": true, "query": {
  "with": [ { "name": "emp_path", "columns": ["id","name","manager_id","level"],
    "base": { "select": ["id","name","manager_id", { "expression": "1", "alias": "level" } ],
              "from": { "resource": "employees" }, "where": [ { "column": "manager_id", "operator": "IS_NULL" } ] },
    "unionAll": { "select": ["e.id","e.name","e.manager_id", { "expression": "ep.level+1" } ],
              "from": { "resource": "employees", "alias": "e" },
              "joins": [ { "type": "INNER", "resource": "emp_path", "alias": "ep",
                           "on": { "left": "e.manager_id", "operator": "EQ", "right": "ep.id" } } ] } } ],
  "select": ["*"], "from": { "resource": "emp_path" } } }
```

**Federated view** — `"federationStrategy": "VIRTUAL"` with union/intersect/except
legs across sources.

## Relationships

```jsonc
{ "name": "rel_1_1", "cardinality": "1:1",
  "from": { "resource": "assets", "field": "id" }, "to": { "resource": "asset_meta", "field": "asset_id" } }

{ "name": "rel_1_M", "cardinality": "1:M",
  "from": { "resource": "owners", "field": "id" }, "to": { "resource": "assets", "field": "owner_id" } }

// cross-source & many-to-many with a bridge table
{ "name": "rel_M_N", "cardinality": "M:N", "bridge": "asset_tags_link",
  "from": { "resource": "assets", "field": "id" },
  "to":   { "source": "External_Warehouse", "resource": "global_tags", "field": "id" } }
```

## Downstream sinks

```jsonc
"downstream": [
  { "type": "ELASTICSEARCH", "enabled": true, "fallback": "PRIMARY_SQL" },
  { "type": "SNOWFLAKE", "enabled": true, "strategy": "CDC" }
]
```

## Worked example manifests

Four graded examples + a runner in
[`examples/metadata/`](../examples/metadata/):
`01-single-source` · `02-multi-source` · `03-combined` · `04-complex` (all features).
The fully-annotated reference is [`test_manifest.json`](../test_manifest.json).
