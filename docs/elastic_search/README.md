# Elasticsearch in Zero Data Fabric

How Elasticsearch is integrated, why, what it stores, how data flows in and out,
and how to query it — with worked examples and the architecture.

## Documents

| Doc | Contents |
|-----|----------|
| [01-why-elasticsearch.md](01-why-elasticsearch.md) | Why ES is in the fabric, its role, benefits, and when to use it vs Postgres/Mongo |
| [02-what-it-stores-and-ingestion.md](02-what-it-stores-and-ingestion.md) | What ES stores, indices/mappings, and the two ways data gets in |
| [03-querying-and-features.md](03-querying-and-features.md) | Every integrated feature with request/response examples |
| [04-architecture.md](04-architecture.md) | Architectural design + diagrams (read source, write sink, hot/cold layering) |
| [05-limitations-and-roadmap.md](05-limitations-and-roadmap.md) | Honest current limits and what's next |

## TL;DR

Elasticsearch is the fabric's **search + text + speed layer**. It plays **two roles**:

1. **Federated read/search source** — you query ES indices with the same AST as
   any other source (filter, projection, sort, pagination, aggregations), plus
   ES-native superpowers: **full-text search**, **fuzzy / entity-resolution
   matching**, **relevance scoring**, **percentiles**, and **date-histogram**
   time-series aggregation. ES legs participate in cross-engine joins and set-ops.
2. **Downstream search mirror (sink)** — hub table mutations are streamed into ES
   so relational data becomes instantly searchable.

**Two query modes:** ES is queryable through **AST mode** (`/api/analytics/query`
— cross-engine, full feature set) *and* **SQL mode** (`/api/queries/exec` — native
Elasticsearch SQL via the `_sql` endpoint, single-source). See
[03 — Querying](03-querying-and-features.md#two-ways-to-query-elasticsearch-ast-mode-and-sql-mode).

Everything below is implemented and live-tested against the `support_tickets`
index used in the [churn-predictor example](../../examples/churn-predictor/).
Connector code: `backend/src/modules/metadata/connectors/factory.ts`
(`ElasticsearchConnector`); sink: `es_mutation_worker.ts`.
