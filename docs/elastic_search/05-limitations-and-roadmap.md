# 05 — Elasticsearch: current limitations & roadmap

An honest account of what is and isn't implemented, so you know the edges.

## Implemented ✅

- **Read source**: filter (`EQ/NE/GT/GTE/LT/LTE/IN/LIKE/ILIKE`), multi-predicate
  ranges, projection, sort, pagination (window-clamped).
- **Full-text** `MATCH` (analyzed relevance) and **fuzzy** `FUZZY`
  (`fuzziness: AUTO`) — the entity-resolution/typo-tolerant primitive.
- **Relevance `_score`** surfaced on documents + orderable by `_score`.
- **Aggregations**: `terms` (nested group-by), metrics
  (`COUNT/SUM/MIN/MAX/AVG/COUNT_DISTINCT`), **`PERCENTILE`**, and
  **`date_histogram`** time-series buckets.
- **CRUD writes**: create (`_bulk`), update (`_update_by_query`), delete
  (`_delete_by_query`) via `/api/data`.
- **Federation**: ES legs in cross-engine joins (bind-join `terms` filter) and
  set operations; faithful `_search` DSL in the execution trace.
- **Discovery**: indices → resources, `_mapping` → columns (system indices hidden).
- **Downstream sink**: hub mutations mirrored into ES with retry/`PRIMARY_SQL` fallback.

## Limitations / not yet implemented ⚠️

| Area | Limitation |
|---|---|
| Entity resolution | `FUZZY` gives fuzzy *matching* (the primitive); there is no end-to-end **entity-resolution service** that clusters variants into a canonical ID across sources. |
| Large result sets | Non-aggregate reads clamped to `max_result_window` (10 000). No `search_after` / scroll / `composite` aggregation for very large exports. |
| Aggregation depth | No `significant_terms`, nested/`reverse_nested`, moving-function, or sub-bucket pipeline aggs; date-histogram uses `calendar_interval` only. |
| Cross-source merge of ES aggs | `PERCENTILE` and `date_histogram` are single-source (not merged across engines in a UNION partial-aggregate — a percentile isn't additively mergeable). Terms/metric partials do merge. |
| Text niceties | No highlighting, suggesters/autocomplete, or synonyms exposed through the AST. |
| Vector / semantic | No kNN / dense-vector / semantic search. |
| Mapping provisioning | Declaring an index mapping via manifest apply is best-effort; production indices are expected to pre-exist or be dynamically mapped by the sink. |
| Streaming ingestion | The sink is enqueue-and-bulk-index of **hub** mutations; it is not a Logstash/Kafka streaming pipeline, and **external-source** changes are not streamed to ES. |

## Roadmap (highest value first)

1. **`search_after` pagination** + `composite` aggregation to lift the 10k ceiling.
2. **Entity-resolution helper** — a fabric operation that takes messy strings,
   runs fuzzy match + scoring, and returns canonical clusters/IDs for joining.
3. **Richer aggregations** — `significant_terms`, moving averages, sub-bucket
   pipelines; percentile-merge approximation (t-digest) for cross-source.
4. **Highlighting + suggesters** surfaced through the AST for search UIs.
5. **kNN / vector search** for semantic retrieval.
6. **Streaming ingestion** (Kafka → ES) and mirroring of external-source changes,
   not just hub mutations.

## Cross-engine operator behavior (reference)

`MATCH`/`FUZZY` are native on ES. On other engines they degrade gracefully:

| Operator | Elasticsearch | PostgreSQL / Snowflake | MySQL | MongoDB |
|---|---|---|---|---|
| `MATCH` | `match` (analyzed) | `ILIKE '%v%'` | `LIKE '%v%'` | `$regex` (i) |
| `FUZZY` | `match` + `fuzziness:AUTO` | `ILIKE '%v%'` | `LIKE '%v%'` | `$regex` (i) |
| `PERCENTILE` | `percentiles` agg | `percentile_cont` | `AVG` fallback | — |
| `date_histogram` | `date_histogram` | `date_trunc` | `DATE()` | field only |
