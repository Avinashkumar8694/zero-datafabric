# 01 — Why Elasticsearch is in the data fabric

## The problem it solves

Relational databases (PostgreSQL) and document stores (MongoDB) are excellent at
**structured data and exact matches**. They struggle with:

- **Unstructured text** — searching the *content* of support tickets, chat logs,
  reviews, documents (not just a `status` column).
- **Fuzzy / approximate matching** — the same company appears as "Acme Corp, Inc.",
  `acme.com`, and `john@acme-global.io`; an exact `JOIN` on these strings fails.
- **High-volume event/log aggregation** — millions of clickstream/log events an
  hour, with sub-second time-series rollups and anomaly detection.
- **Relevance ranking** — "which tickets are *most* about churn", ordered by how
  strongly they match, not just yes/no.

Elasticsearch is purpose-built for exactly these. So the fabric adds it as the
**search, text-analytics, and speed layer** alongside the structured engines.

## Its role in the fabric

```
Cold / batch layer   →  PostgreSQL / warehouse   (ARR, contracts, financial history, exact joins)
Hot / speed layer    →  Elasticsearch            (full-text, sentiment, log aggregation, fuzzy match)
```

This is the classic **Lambda/Kappa** split: heavy historical/financial truth lives
in SQL; fast textual + event intelligence lives in ES. The fabric lets a single
query span both — e.g. *"Enterprise accounts renewing in 90 days (Postgres) whose
support tickets show a spike in negative-sentiment language (Elasticsearch)."*

## Concrete benefits

| Without ES | With ES in the fabric |
|---|---|
| You know a ticket is "Open/Urgent" | You know *why* — the text says "canceling our contract" |
| Exact string joins drop mismatched entities | Fuzzy match links `Acme Corp` ≈ `acme.com` |
| Aggregating millions of events crawls the OLTP DB | ES returns time-series rollups in milliseconds |
| Results are unordered | Results are **ranked by relevance** (`_score`) |
| Text search means `LIKE '%x%'` full scans | Inverted-index search, analyzed + tokenized |

## When the planner uses ES

- Any query whose `from`/`join`/set-op leg targets an ES-backed source runs on ES
  via its connector (pushed down: filter, projection, sort, size, aggregations).
- Full-text (`MATCH`) and fuzzy (`FUZZY`) operators are **native** on ES; on SQL/
  Mongo they degrade to a case-insensitive substring match (documented in
  [03](03-querying-and-features.md)).
- ES also receives a **mirror** of hub tables (the sink) so relational rows are
  searchable without a separate ETL — see [02](02-what-it-stores-and-ingestion.md).

Next: [what ES stores and how data gets in →](02-what-it-stores-and-ingestion.md)
