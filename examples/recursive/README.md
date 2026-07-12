# Recursive Traversal Examples

Postgres does `WITH RECURSIVE` natively, but a hierarchy whose rows live in
**MongoDB / Elasticsearch / a remote warehouse** can't use it. The fabric's
**in-fabric iterative traversal** walks the hierarchy level by level — the same
result `$graphLookup` or `WITH RECURSIVE` would give, over an engine that has
neither:

1. **Seed** the anchor rows (roots, or an explicit `startWith`).
2. **Expand** each level with a single `IN(…parent keys…)` bind-filter **pushed to
   the source** (never a scan-per-node); tag each row with its `depth` and an
   optional breadcrumb `path`.
3. **Repeat** to a fixpoint, bounded by `maxDepth` + a row cap, with a `seen` set
   guarding against cycles.

Because each level is a normal fabric query, predicate pushdown **and the Policy
Engine apply at every level**.

## Prerequisites

```bash
npm run infra:up
npm run start
```

## Run

```bash
NODE_PATH=backend/node_modules node examples/recursive/run-all.js
# or:  npm run examples:recursive
```

## Scenarios

- **01 — org hierarchy (descend).** Full tree from the roots over MongoDB;
  verifies the complete transitive closure, correct per-node `depth`, and
  materialised `path` (`CEO > VP-A > Dir-A1 > Eng-1`).
- **02 — subtree + ancestors.** `startWith` begins recursion at any node:
  descend from VP-A for its subtree, or `direction: 'up'` from an engineer to
  walk the chain of command to the CEO.
- **03 — depth cap + cycle guard.** `maxDepth` stops early and flags
  `truncatedByDepth`; a deliberately cyclic graph terminates with each node
  visited exactly once.

## Spec shape

```jsonc
{
  "recursive": {
    "source": "Org_Lab",              // any engine (Mongo/ES/remote/PG)
    "resource": "employees",
    "connectBy": { "parent": "manager_id", "child": "id" },  // child.manager_id = parent.id
    "anchor":    [{ "column": "manager_id", "operator": "IS_NULL" }],  // roots (default)
    "startWith": [{ "column": "id", "operator": "EQ", "value": 2 }],   // optional — begin anywhere
    "direction": "down",              // 'down' (children) | 'up' (ancestors)
    "select":    ["id", "name", "manager_id"],
    "maxDepth":  25,                  // bound (default 25, hard cap 100)
    "maxRows":   50000,               // total-row bound
    "pathColumn": "name"              // materialise a breadcrumb path[]
  }
}
```

Issued via `POST /api/analytics/query` with
`{ queryConfig: { type: 'SELECT', schema, query: { recursive: {...} } } }`.

## What proves it works

- The result is the full transitive closure with correct `depth` per node.
- `plan.strategy = 'RECURSIVE_IN_FABRIC'` and `plan.traversal` shows per-level
  fan-out (`d0:+1 d1:+2 d2:+3 …`) — each level a single bind-pushdown fetch.
- A cyclic graph terminates (no infinite loop); `maxDepth` truncates and warns.
