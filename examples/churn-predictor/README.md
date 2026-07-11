# High-Value Churn Predictor — multi-datasource analytics

A real enterprise analytics use case realized on the fabric: find high-value
Enterprise accounts at imminent risk of churning, by correlating **CRM revenue**,
**product usage decline**, and **support friction + negative sentiment** — data
that lives in four separate engines.

## The business question

> "Which Enterprise-tier accounts (ARR > $50k) renewing in the next 90 days have
> shown a >40% drop in core-feature engagement over the last 30 days, while also
> having ≥2 unresolved urgent support tickets (and negative-sentiment chatter),
> and how much ARR is at risk?"

## Datasources (all external — nothing in the fabric's own DB)

| Fabric source | Engine | Physical | Role |
|---------------|--------|----------|------|
| `CRM_Salesforce` | PostgreSQL `:5436` / `crm` | `accounts` | tier, ARR, renewal_date |
| `Prod_Postgres`  | PostgreSQL `:5436` / `prod_ops` | `orders` | purchase history |
| `Product_Logs`   | MongoDB `:27017` / `product` | `user_events` | clickstream (event_time = epoch-ms) |
| `Support_ES`     | Elasticsearch `:9200` | `support_tickets` | status/priority/CSAT + **full-text body** |

All keyed on `account_id`. The first 12 accounts are engineered to be at-risk.
> Snowflake and Zendesk from the original use case are mapped onto Postgres,
> MongoDB and Elasticsearch per the brief.

## How the "mega-query" runs on the fabric

The conceptual SQL is a 4-CTE query. The fabric executes it as federated,
pushed-down steps (see `03-churn-analysis.js`), each proven by the execution trace:

1. **Target_Accounts** — CRM (Postgres): `WHERE tier='Enterprise' AND arr>50000 AND renewal ≤ 90d` — filter pushed down.
2. **Product_Engagement** — Product_Logs (Mongo): two windowed `COUNT … GROUP BY account_id` `$group` aggregates (last-30d vs prev-30d), with the CRM account set pushed as `account_id $in […]`.
3. **Support_Friction** — Support (Elasticsearch): a terms + metric aggregation (`open Urgent tickets`, `avg CSAT`) per account.
4. **Negative_Sentiment** — Support (Elasticsearch): a **full-text `$match`** on ticket `body` for churn/competitor/outage language.
5. **Stitch + threshold** — engagement drop >40% AND ≥2 open urgent tickets → sum ARR = **revenue at risk**.

Each engine does only its own filtered/aggregated work; the fabric drives the
account set across sources and merges bounded partials — no whole-table movement.

## Elasticsearch

This example exercises ES as a first-class federated source: structured filters
(`term`/`terms`/`range`), terms+metric **aggregations**, and **full-text search**
via the `MATCH` operator (`$match` → ES `match` query; `ILIKE`/regex fallback on
SQL/Mongo). The execution trace shows the real `_search` DSL for ES legs.

## Two query interfaces (both tested)

- **AST mode** — `03-churn-analysis.js` via `/api/analytics/query`. The only mode
  that federates across engines (PG + Mongo + ES); this is the full mega-query.
- **SQL mode** — `04-churn-sql-mode.js` via `/api/queries/exec`. Native SQL
  (window functions, CTEs, `FILTER`) executed **at a single Postgres source** —
  used for the SQL-native parts (CRM target ranking, Prod purchase-value decline).
  It cross-checks that SQL and AST agree on the shared Target_Accounts step, and
  shows that a non-SQL engine (Mongo/ES) correctly refuses raw SQL (those go
  through AST).

## Run

```bash
cd examples/churn-predictor
node run-all.js --seed          # seed 4 external stores + register + analyze (AST + SQL)
# or, once seeded:
node 03-churn-analysis.js       # AST (cross-engine)
node 04-churn-sql-mode.js       # SQL (native, at source)
```

Setup manifest: [`churn-manifest.json`](churn-manifest.json) (diff/apply via
`/api/metadata`). Query syntax: [`../../developer_docs/`](../../developer_docs/).

## Security

All engine access is parameterized/structured: SQL uses bound placeholders and
sanitized identifiers; Mongo/ES filters are built as data (no string
concatenation). The CRUD/query layer rejects unsafe field names (SQL identifier
break-out, Mongo `$`-operator injection), requires a filter for update/delete, and
requires auth on every endpoint. Source credentials are never returned by the API.
