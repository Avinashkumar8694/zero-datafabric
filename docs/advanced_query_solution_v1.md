# Advanced Query Solution v1

## 1. Objective

Enable a simpler query syntax on top of existing query engine capabilities, while keeping current SQL/AST formats fully supported.

Key goals:
- Keep existing joins and queryConfig behavior unchanged.
- Add relationship-aware shorthand based on catalog cardinality.
- Support parent-to-child and child-to-parent traversal without writing manual joins.
- Add simpler update/delete syntax while preserving existing update/delete APIs.

## 2. Design Principles

- Backward compatible: no breaking changes.
- Explicit fallback: when shorthand is ambiguous, return clear error and suggest full join syntax.
- Tenant-safe: all generated SQL must stay inside tenant-scoped schema resolution.
- Governance-safe: safety shield still applies.

## 3. Relationship-Aware Query Syntax

## 3.1 New Shorthand Block

`queryConfig` supports an optional `graph` block:

```json
{
  "queryConfig": {
    "type": "SELECT",
    "schema": "Global_Supply_Chain",
    "graph": {
      "root": "shipments",
      "select": ["id", "status"],
      "expand": [
        { "path": "shipment_details", "fields": ["notes"], "mode": "OBJECT" },
        { "path": "shipment_tags_link.global_tags", "fields": ["tag_name"], "mode": "ARRAY" }
      ]
    },
    "limit": 50
  }
}
```

`root`:
- Logical table/resource name.

`expand.path`:
- Relationship path through catalog relationships.
- Supports direct and chained traversal.

`mode`:
- `OBJECT` for 1:1
- `ARRAY` for 1:M / M:N

## 3.2 Direct Arrow Syntax (Optional user-facing sugar)

Equivalent shorthand for advanced users:

`shipments(id,status) -> shipment_details(notes) [1:1]`

`shipments(id) -> shipment_tags_link() -> global_tags(tag_name) [M:N]`

This can be accepted in UI/parser, then transpiled into `graph` or full AST joins.

## 3.3 Parent -> Child and Child -> Parent

Parent to child:
- `shipments -> shipment_details`
- Generated as LEFT JOIN or nested projection based on cardinality.

Child to parent:
- `shipment_details -> shipments`
- Inverse traversal allowed using relationship registry.

Rules:
- 1:1: map to single object projection.
- 1:M: map to aggregated array projection.
- M:1: map to single parent object.
- M:N: route through bridge table from metadata.

## 3.4 Nested Multi-Hop Traversal (`A->B->C->...`)

Support deep path traversal in both directions:
- Forward: `A -> B -> C -> D`
- Reverse: `D -> C -> B -> A`
- Mixed: `A -> B <- C -> D` (explicit edge direction when needed)

Example graph request:

```json
{
  "queryConfig": {
    "type": "SELECT",
    "schema": "Global_Supply_Chain",
    "graph": {
      "root": "shipments",
      "select": ["id", "status"],
      "expand": [
        {
          "path": "shipment_details.delivery_events.event_attachments",
          "fields": ["id", "file_name", "event_type"],
          "mode": "AUTO"
        }
      ]
    },
    "limit": 50
  }
}
```

Reverse traversal example:

```json
{
  "queryConfig": {
    "type": "SELECT",
    "schema": "Global_Supply_Chain",
    "graph": {
      "root": "event_attachments",
      "select": ["id", "file_name"],
      "expand": [
        { "path": "delivery_events.shipment_details.shipments", "fields": ["id", "status"], "mode": "AUTO" }
      ]
    },
    "limit": 50
  }
}
```

Path semantics:
- Dot notation: `A.B.C`
- Arrow notation equivalent: `A->B->C`
- Direction-aware (optional): `A->B<-C`

Auto cardinality shaping (`mode: AUTO`):
- Hop ending in 1:1 or M:1 => nested object
- Hop ending in 1:M or M:N => nested array

Max depth and complexity guardrails:
- Default `maxDepth = 5` (configurable)
- Default `maxExpandedNodes = 20`
- Reject cyclic paths unless `allowCycles = true` and bounded by `maxDepth`

## 4. Existing Join Syntax Coexistence

Current syntax remains valid:

```json
{
  "queryConfig": {
    "type": "SELECT",
    "table": "shipments",
    "select": ["shipments.id", "shipment_details.notes"],
    "joins": [
      { "type": "INNER", "table": "shipment_details", "on": "shipments.id = shipment_details.shipment_id" }
    ],
    "limit": 50
  }
}
```

Engine behavior:
- If `graph` present: parse shorthand -> expand to joins/JSON projection.
- Else: current behavior unchanged.

## 5. Simplified Update/Delete Syntax

## 5.1 Simple Update

Add `mutate` block:

```json
{
  "queryConfig": {
    "type": "UPDATE",
    "schema": "Global_Supply_Chain",
    "mutate": {
      "target": "shipments",
      "set": { "status": "DELIVERED" },
      "where": [{ "column": "id", "operator": "EQ", "value": "..." }]
    }
  }
}
```

Compatibility:
- Existing `type=UPDATE`, `table`, `data`, `filter` still supported.

## 5.2 Simple Delete

```json
{
  "queryConfig": {
    "type": "DELETE",
    "schema": "Global_Supply_Chain",
    "mutate": {
      "target": "shipment_details",
      "where": [{ "column": "shipment_id", "operator": "EQ", "value": "..." }]
    }
  }
}
```

Optional policy mode:
- `deleteMode: "SOFT"` -> translate to `deleted_at = now()` if configured.
- `deleteMode: "HARD"` -> actual delete (subject to role/safety policy).

## 5.3 Relationship-Aware Update/Delete (Phase 2)

Support path-scoped updates/deletes:

```json
{
  "queryConfig": {
    "type": "UPDATE",
    "schema": "Global_Supply_Chain",
    "mutate": {
      "targetPath": "shipments->shipment_details",
      "set": { "notes": "updated via parent path" },
      "where": [{ "column": "shipments.id", "operator": "EQ", "value": "..." }]
    }
  }
}
```

Engine resolves target physical table and join predicate from relationship registry.

## 6. Metadata Requirements

Need reliable relationship registry entries with:
- `name`
- `cardinality` (1:1, 1:M, M:1, M:N)
- `from.resource`, `from.field`
- `to.resource`, `to.field`
- `bridge` (for M:N)
- `source/schema context`

Source of truth:
- metadata manifest relationships
- persisted catalog relationship table (recommended).

## 7. Query Planning Pipeline

1. Parse input:
- legacy queryConfig OR manifest-style OR graph/mutate shorthand.

2. Normalize:
- convert shorthand to canonical internal AST.

3. Resolve relationships:
- map path segments to join edges.
- validate ambiguity/cardinality.
- build multi-hop join graph for nested expansions.

4. Generate SQL:
- reuse existing SQL generator.
- preserve safety shield checks.

5. Execute + shape response:
- flat rows for standard queries.
- nested JSON for `mode=OBJECT/ARRAY` graph expansions.

## 8. Validation Rules

- Fail if path has multiple possible edges and no disambiguation provided.
- Fail if traversal crosses tenant boundary.
- Enforce update/delete requires where/filter unless privileged override.
- Enforce max expand depth (default 3) to avoid runaway graph scans.
- Validate every hop in multi-level path exists in relationship registry.
- For reverse traversal, confirm inverse edge is derivable from stored relation metadata.
- Reject unbounded fan-out traversals unless explicit limit is provided.

## 9. Response Shape (Graph mode)

Example:

```json
{
  "data": [
    {
      "id": "...",
      "status": "PENDING",
      "shipment_details": { "notes": "..." },
      "global_tags": [{ "tag_name": "fragile" }, { "tag_name": "priority" }]
    }
  ],
  "meta": {
    "mode": "GRAPH",
    "root": "shipments",
    "expandedPaths": ["shipment_details", "shipment_tags_link.global_tags"],
    "depth": 2
  }
}
```

Nested response example (depth 3):

```json
{
  "data": [
    {
      "id": "...",
      "status": "IN_TRANSIT",
      "shipment_details": {
        "id": "...",
        "delivery_events": [
          {
            "id": "...",
            "event_attachments": [
              { "id": "...", "file_name": "proof.jpg" }
            ]
          }
        ]
      }
    }
  ],
  "meta": {
    "mode": "GRAPH",
    "root": "shipments",
    "expandedPaths": ["shipment_details.delivery_events.event_attachments"],
    "depth": 3
  }
}
```

## 10. Rollout Plan

Phase 1:
- `graph` shorthand for SELECT.
- `mutate` shorthand for UPDATE/DELETE.
- keep legacy formats unchanged.

Phase 2:
- path-aware update/delete across relationships.
- optional arrow syntax parser in UI/workbench.
- multi-hop (`A->B->C->...`) traversal in both forward and reverse directions.

Phase 3:
- query assistant in Workbench (visual relation picker + auto-generation).
- path cost estimator + explain-plan preview for deep traversals.

## 11. Open Risks / Notes

- Cardinality correctness depends on metadata quality.
- M:N path traversal can be expensive without indexes.
- RLS and custom policies (e.g., region context) still apply and may block graph queries if session context not set.
- Deep graph expansions can create very large payloads; pagination/windowing per nested array is recommended.

## 12. Acceptance Criteria (v1)

- Users can run simple relationship expansions without manually writing joins.
- Users can run nested multi-hop expansions (`A->B->C...`) and reverse traversals.
- Existing query syntax still works exactly as before.
- Users can perform simplified update/delete with safety constraints.
- Errors are deterministic and actionable when shorthand cannot be resolved.
