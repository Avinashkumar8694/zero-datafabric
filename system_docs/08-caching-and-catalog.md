# 08 — Catalog & Redis caching

## The catalog

The catalog is the fabric's map from **logical** names to **physical** locations.

```mermaid
erDiagram
  data_sources ||--o{ catalog_schemas : has
  catalog_schemas ||--o{ catalog_tables : has
  data_sources {
    uuid id
    string tenant_id
    string name
    string type
    string sync_type
    jsonb config
  }
  catalog_schemas {
    uuid id
    uuid source_id
    string name
    string physical_name
  }
  catalog_tables {
    uuid id
    uuid schema_id
    string name
    string physical_name
    string resource_type
    jsonb definition_ast
    text definition_sql
  }
```

- `data_sources` — registered sources (engine, sync type, connection config).
- `catalog_schemas` / `catalog_tables` — logical→physical mapping + object type +
  optional `definition_ast` (for manifest round-trip and column metadata).
- `fabric_catalog.relationships` — FK / manifest relationships (for ER diagrams &
  export).

The planner reads this to resolve `{source, resource}` → engine + physical
schema/table; export reads it to reconstruct a manifest.

## Redis caching

Hot read paths (`sources`, `schemas`, `tables`, `columns`, `relationships`) are
cached tenant-scoped with a TTL, and invalidated on any change.

```mermaid
flowchart TD
  REQ[metadata read] --> C{cache hit?}
  C -- yes --> HIT[return cached]
  C -- no --> DB[query catalog] --> SET[cacheSet TTL] --> RET[return]
  subgraph Invalidation
    CRAWL[crawl] --> INV[invalidateTenant]
    APPLY[apply] --> INV
    CONN[connection change] --> INV
  end
  INV -.clears.-> C
```

- Keys are namespaced `meta:<tenant>:<kind>[:id]`.
- `cached(key, ttl, loader)` wraps each read; `invalidateTenant(tenant)` clears
  all `*<tenant>*` keys on crawl / apply / connection add/remove.
- The client is a graceful no-op if Redis is unavailable — reads fall through to
  the catalog, so the system degrades rather than fails.

Implementation: `backend/src/config/cache.ts`, metadata controller read handlers.
