# 03 — Querying Elasticsearch & every integrated feature

You query ES with the **same AST** as any source, via `POST /api/analytics/query`
(or the simple `/api/data/fetch`). The `ElasticsearchConnector` compiles the
canonical query into an ES `_search` request and returns flat rows. Every response
carries the execution trace with the real ES DSL (`plan.legs[].query`).

All examples use the `support_tickets` index (`Support_ES` source). Header set for
every call: `Authorization: Bearer <jwt>`, `x-tenant-id: <tenant>`.

---

## Querying Elasticsearch: AST only

Elasticsearch is queried through the engine-agnostic AST, on `POST /api/analytics/query`
(or `POST /api/queries/engine`). The connector compiles it to an ES `_search` request.
This mode can also federate ES with other engines (joins, set-ops, multi-source
aggregates), and it exposes every ES feature below.

```jsonc
{ "queryConfig": { "type": "SELECT", "schema": "default", "limit": 5, "query": {
  "from":   { "resource": "support_tickets", "source": "Support_ES" },
  "select": ["account_id", "priority", "_score"],
  "where":  [ { "column": "body", "operator": "MATCH", "value": "canceling competitor" },
              { "column": "priority", "operator": "EQ", "value": "Urgent" } ],
  "orderBy":[ { "column": "_score", "direction": "DESC" } ] } } }
```

Aggregates use the same AST (`groupBy` + `aggregate` select items); see the
aggregation sections below.

- Raw / native Elasticsearch SQL execution (the former `POST /api/queries/exec`) has
  been removed. Request bodies containing `sql` / `rawSql` are rejected with
  `400 { code: "SQL_NOT_SUPPORTED" }`.
- Writes use `/api/data` CRUD (see section 7).
- Use `POST /api/queries/transpile` to preview generated SQL for SQL engines (preview
  only); for Elasticsearch the real ES DSL is shown in `plan.legs[].query` on every
  response.

---

## 1. Filter operators → ES query DSL

`where` predicates compile to ES clauses. Exact/range go to the (non-scoring)
`filter` context; full-text/fuzzy go to the (scoring) `must` context.

| Operator | ES clause |
|---|---|
| `EQ` / `NE` | `term` / `bool.must_not.term` |
| `GT` `GTE` `LT` `LTE` | `range` |
| `IN` | `terms` |
| `LIKE` / `ILIKE` | `wildcard` (`%`→`*`, `_`→`?`) |
| `MATCH` | `match` (analyzed full-text) |
| `FUZZY` | `match` with `fuzziness: AUTO` |

Multiple predicates on the same column combine (e.g. a range):

```jsonc
POST /api/analytics/query
{ "queryConfig": { "type": "SELECT", "schema": "default", "limit": 5, "query": {
  "from": { "resource": "support_tickets", "source": "Support_ES" },
  "where": [
    { "column": "priority", "operator": "EQ",  "value": "Urgent" },
    { "column": "status",   "operator": "IN",  "value": ["Open", "Pending"] },
    { "column": "csat",     "operator": "LT",  "value": 3 }
  ] } } }
```
→ `bool.filter: [ {term:{priority:"Urgent"}}, {terms:{status:["Open","Pending"]}}, {range:{csat:{lt:3}}} ]`

## 2. Full-text search (`MATCH`)

Analyzed, tokenized relevance search over a `text` field — the thing SQL can't do.

```jsonc
{ "queryConfig": { "type": "SELECT", "schema": "default", "limit": 5, "query": {
  "from": { "resource": "support_tickets", "source": "Support_ES" },
  "select": ["account_id", "body", "_score"],
  "where": [ { "column": "body", "operator": "MATCH", "value": "canceling competitor" } ],
  "orderBy": [ { "column": "_score", "direction": "DESC" } ] } } }
```
→ documents mentioning *canceling* / *competitor*, **ranked by relevance**:
```
_score 8.69  acct 9  "We are canceling our contract and considering a competitor."
_score 6.80  acct 8  "We are considering a competitor and considering a competitor."
```

## 3. Relevance score (`_score`)

ES computes a relevance `_score` for `MATCH`/`FUZZY` queries; the connector
surfaces it as a `_score` field on every returned document, and you can
`orderBy _score DESC` to rank by relevance (as above). Exact/range-only queries
return `_score: 0` (filter context, unscored).

## 4. Fuzzy matching / entity resolution (`FUZZY`)

Levenshtein-tolerant match (`fuzziness: AUTO`) — the primitive for **entity
resolution** and typo-tolerant search. A misspelled query still matches:

```jsonc
{ "queryConfig": { "type": "SELECT", "schema": "default", "limit": 3, "query": {
  "from": { "resource": "support_tickets", "source": "Support_ES" },
  "select": ["account_id", "body", "_score"],
  "where": [ { "column": "body", "operator": "FUZZY", "value": "cancelling competiter" } ] } } }
```
Despite the typos (*cancelling*, *competiter*), it matches "canceling … competitor".
Use the same operator to link messy entity strings (e.g. company-name variants)
before joining across sources.

## 5. Aggregations

### Terms buckets + metrics

`groupBy` → `terms` aggregation; aggregate specs → metric sub-aggregations
(`COUNT`→doc_count, `SUM/MIN/MAX/AVG`→metric aggs, `COUNT_DISTINCT`→`cardinality`).

```jsonc
{ "queryConfig": { "type": "SELECT", "schema": "default", "limit": 20, "query": {
  "from": { "resource": "support_tickets", "source": "Support_ES" },
  "where": [ { "column": "priority", "operator": "EQ", "value": "Urgent" } ],
  "groupBy": ["account_id"],
  "select": ["account_id",
    { "aggregate": "COUNT", "column": "*",    "alias": "open_urgent" },
    { "aggregate": "AVG",   "column": "csat", "alias": "avg_csat" }] } } }
```

### Percentiles

`PERCENTILE` (with `percent`) → ES `percentiles` aggregation:

```jsonc
{ "query": {
  "from": { "resource": "support_tickets", "source": "Support_ES" },
  "groupBy": ["priority"],
  "select": ["priority", { "aggregate": "PERCENTILE", "column": "csat", "percent": 95, "alias": "p95_csat" }] } }
// → [{ priority:"Urgent", p95_csat: 4.89 }, ...]
```

### Date-histogram (time series)

A `groupBy` entry `{ field, dateInterval }` → ES `date_histogram`:

```jsonc
{ "query": {
  "from": { "resource": "support_tickets", "source": "Support_ES" },
  "groupBy": [ { "field": "created_at", "dateInterval": "day" } ],
  "select": [ { "aggregate": "COUNT", "column": "*", "alias": "tickets" } ] } }
// → [{ created_at:"2026-06-12T00:00:00.000Z", tickets: 274 }, ...]
```
`dateInterval` ∈ minute · hour · day · week · month · quarter · year.

## 6. Projection, sort, pagination

```jsonc
{ "query": {
  "from": { "resource": "support_tickets", "source": "Support_ES" },
  "select": ["ticket_id", "priority"],          // → _source projection
  "orderBy": [ { "column": "ticket_id", "direction": "ASC" } ],
  "offset": 20 }, "limit": 10 }                  // → from + size (clamped to the 10k window)
```

## 7. CRUD writes

ES is a full read **and write** source via `/api/data`:

```jsonc
// create → bulk index
POST /api/data/create
{ "source": "Support_ES", "resource": "support_tickets",
  "data": { "_id": "999001", "ticket_id": 999001, "account_id": 42, "status": "Open",
            "priority": "Urgent", "csat": 2.0, "body": "escalation" } }

// update → _update_by_query (script set)
POST /api/data/update
{ "source": "Support_ES", "resource": "support_tickets",
  "where": { "ticket_id": 999001 }, "data": { "csat": 5.0 } }

// delete → _delete_by_query
POST /api/data/delete
{ "source": "Support_ES", "resource": "support_tickets", "where": { "ticket_id": 999001 } }
```

## 8. ES in cross-engine queries

An ES leg participates in federated **joins** (as a bind-join probe — the driving
source's keys are pushed as a `terms` filter) and **set operations**. Example from
the churn use case: CRM accounts (Postgres) drive `account_id IN [...]` into the ES
`support_tickets` aggregation — see
[`examples/churn-predictor/03-churn-analysis.js`](../../examples/churn-predictor/03-churn-analysis.js).

## Reading the trace

Every ES response includes the real DSL it ran:
```jsonc
"plan": { "strategy": "SINGLE_CONNECTOR", "executionMs": 38,
  "legs": [ { "source": "Support_ES", "engine": "ELASTICSEARCH", "mode": "connector",
    "operation": "aggregate", "target": "default.support_tickets",
    "query": "POST /support_tickets/_search {\"size\":0,\"query\":{...},\"aggs\":...}" } ] }
```

Next: [architecture →](04-architecture.md)
