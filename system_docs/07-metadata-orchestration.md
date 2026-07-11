# 07 — Metadata orchestration

Declarative schema management: a manifest describes the target state; the
orchestrator computes and applies the delta across sources under SAGA
consistency, and can export the live catalog back into a manifest.

## Diff / apply pipeline

```mermaid
sequenceDiagram
  autonumber
  participant C as Client
  participant ORCH as Orchestrator
  participant DIFF as DiffEngine
  participant TR as Transpiler (DDL)
  participant HUB as Hub (tenant schemas + catalog)
  participant EXT as External sources

  C->>ORCH: POST /metadata/apply (manifest file)
  ORCH->>ORCH: ensureFabricPrimitives (uuid_generate_v7, audit_log_fn, tenant helpers)
  ORCH->>DIFF: manifest vs. current catalog
  DIFF-->>ORCH: ordered ops (CREATE_SCHEMA → ENUM → SEQUENCE → TABLE → FUNCTION → VIEW → MATVIEW → RELATIONSHIP → downstream)
  loop each op
    ORCH->>TR: generate DDL (SET LOCAL statement_timeout='180s')
    alt target = hub / local
      ORCH->>HUB: execute DDL
    else target = external
      ORCH->>EXT: dispatch via connector (SAGA)
      Note over ORCH,EXT: failure ⇒ deployStatus=DEGRADED (non-fatal), not rollback
    end
    ORCH-->>C: record {op, target, status}
  end
  ORCH->>HUB: persist catalog + relationships (fabric_catalog.relationships)
```

`diff` runs the same pipeline up to the ordered-ops step and returns them without
executing — a safe dry run.

## Ordering & idempotency

Operations are ordered so dependencies exist first (schema → enum/sequence →
table → function/procedure → view/matview → relationship → downstream). Re-applying
is a no-op where the catalog already matches (diff yields no op).

## SAGA consistency

Remote/downstream dispatch (Mongo, remote warehouse, ES, Snowflake) is wrapped so
a failing leg marks that op `DEGRADED` rather than aborting the whole apply — the
hub-side schema still lands. This keeps a single unreachable external engine from
blocking the rest of the orchestration.

## Export (reverse)

```mermaid
flowchart LR
  CAT[(catalog_schemas + catalog_tables + relationships)] --> EXP[exportManifest]
  EXP -->|definition_ast present| RT[round-trip verbatim]
  EXP -->|crawled, no ast| REC[reconstruct columns via connector.discoverColumns / information_schema]
  RT & REC --> M[manifest JSON]
  M -->|single-source| W[warn on cross-source dependencies]
```

Export prefers each resource's stored `definition_ast` (perfect round-trip) and
reconstructs crawled resources from live introspection; system schemas are
filtered; single-source exports flag resources that depend on other sources.

Implementation: `MetadataService` (crawl/export), orchestrator + `DiffEngine` +
`Transpiler`. Manifest reference: [../developer_docs/metadata-manifests.md](../developer_docs/metadata-manifests.md).
