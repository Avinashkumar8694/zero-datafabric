# Metadata manifest examples

Declarative schema manifests applied by the fabric's orchestrator. Each shows a
different level of complexity. The runner validates (diff) or orchestrates (apply)
them against the live fabric.

| Manifest | Scope | Features shown |
|----------|-------|----------------|
| `01-single-source.json` | 1 schema, 1 source | enum, sequence, tables, PK, unique, BRIN index, CHECK constraint, 1:M relationship |
| `02-multi-source.json` | 2 schemas across Postgres + Mongo | per-schema `targetSource`, a **cross-source** 1:M relationship |
| `03-combined.json` | 1 schema, every object type | table, view, materialized view, function, procedure, trigger, enum, sequence, relationship |
| `04-complex.json` | all features | column strategies (UUID_V7 / IDENTITY_ALWAYS / LEGACY_SERIAL / FUNCTIONAL / SOFT_DELETE), generated/stored column, collation, CHECK + EXCLUDE(GIST), GIN + BRIN indexes, RLS + masking + policies + grants, trigger, recursive/window/aggregate views, federated view (union/except), matview, 1:1 / 1:M / M:N (bridge, cross-source) relationships, ES + Snowflake downstream |

## Manifest shape

See [`docs/QUERY_API_REFERENCE.md`](../../docs/QUERY_API_REFERENCE.md) and the
annotated reference manifest [`test_manifest.json`](../../test_manifest.json).
Top level: `{ version, namespace, targetSource, consistencyMode?, downstream?, extensions?, schemas[], relationships[] }`.
Each schema: `{ name, targetSource, resources[] }`. Resources are typed
(`TABLE | VIEW | MATERIALIZED_VIEW | ENUM | SEQUENCE | FUNCTION | PROCEDURE`).

## Run

```bash
cd examples/metadata

# validate + show the orchestration plan for all four (writes nothing):
node run-metadata-examples.js

# actually orchestrate them (executes DDL on the tenant's managed schemas
# and dispatches to external sources):
node run-metadata-examples.js --apply
```

`diff` reports the exact operations the fabric would run (CREATE_SCHEMA,
CREATE_TABLE, CREATE_ENUM, PROVISION_RELATIONSHIP, …). Complex features that are
environment-dependent (EXCLUDE needs distinct rows, external trigger engine,
Snowflake) apply best-effort under SAGA consistency — non-fatal legs are marked
DEGRADED rather than aborting the whole apply.
