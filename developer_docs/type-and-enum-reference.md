# Types & Enums Reference Sheets

This document catalogs every allowable data type, query operator, index abstraction, and database driver enum recognized by the Zero Data Fabric.

---

## 1. Column Datatypes

Use these string keys inside the `type` property of columns within your metadata manifests:

| Type Key | Mapping Target (Postgres) | Mapping Target (MySQL) | Details |
|:---|:---|:---|:---|
| **`UUID`** | `UUID` (128-bit) | `BINARY(16)` | Best for primary identifiers. Generates v4 or v7 keys. |
| **`BIGINT`** | `INT8` (64-bit integer) | `BIGINT` | Large integers, sequence sequences, or counters. |
| **`SERIAL`** | `SERIAL` (32-bit auto-increment) | `INT AUTO_INCREMENT` | Simple auto-incrementing serial values. |
| **`STRING`** | `VARCHAR` or `TEXT` | `VARCHAR` or `TEXT` | Strings. Accepts optional `length` parameter. |
| **`NUMERIC`** | `NUMERIC(p,s)` | `DECIMAL(p,s)` | Exact precision decimals (ideal for financial records). |
| **`TIMESTAMP`** | `TIMESTAMP WITH TIME ZONE` | `DATETIME(6)` | Precise datetime points. Supports `NOW()` defaults. |
| **`JSONB`** | `JSONB` | `JSON` | Semi-structured JSON trees. Supports GIN indexing. |
| **`BOOLEAN`** | `BOOLEAN` | `TINYINT(1)` | Relational boolean status flags (`true` or `false`). |
| **`ENUM`** | User-defined custom domain | `VARCHAR` / `ENUM` | Restricted choice lists. Requires a `ref` definition. |

---

## 2. Key Generation & Column Strategies

Strategies configure automatic key generation and logical storage structures inside tables:

* **`UUID_V7`** (Column: `UUID`)
  * Generates time-ordered UUIDs (version 7). Provides superior B-Tree indexing sorting performance over random UUID v4 keys.
* **`IDENTITY_ALWAYS`** (Column: `BIGINT`)
  * Maps to PostgreSQL `GENERATED ALWAYS AS IDENTITY`. Enforces sequence generator restrictions during writes.
* **`LEGACY_SERIAL`** (Column: `SERIAL`)
  * Fallback to native auto-increment integer sequences.
* **`FUNCTIONAL`** (Column: `STRING` / `BIGINT`)
  * Automatically populates the field value by evaluating a custom database function (e.g. `default: "generate_custom_id(region)"`).
* **`SOFT_DELETE`** (Column: `TIMESTAMP`)
  * Declares a logical soft-delete column. The engine automatically filters out records where this timestamp is populated, except when queried with explicit deletion overrides.

---

## 3. Predicate Operators

Configure these operators inside AST query filters under the `where[].operator` field:

| Operator Key | Dialect Translation (SQL) | Equivalent (MongoDB) | Example Input |
|:---|:---|:---|:---|
| **`EQ`** | `=` | `$eq` | `{"operator": "EQ", "value": "ACTIVE"}` |
| **`NE`** | `!=` or `<>` | `$ne` | `{"operator": "NE", "value": "DRAFT"}` |
| **`GT`** | `>` | `$gt` | `{"operator": "GT", "value": 50}` |
| **`GTE`** | `>=` | `$gte` | `{"operator": "GTE", "value": 1000}` |
| **`LT`** | `<` | `$lt` | `{"operator": "LT", "value": 200}` |
| **`LTE`** | `<=` | `$lte` | `{"operator": "LTE", "value": 5.5}` |
| **`LIKE`** | `LIKE` | N/A | `{"operator": "LIKE", "value": "Shipment_%"}` |
| **`ILIKE`** | `ILIKE` (Case-insensitive) | N/A | `{"operator": "ILIKE", "value": "%urgent%"}` |
| **`IN`** | `IN (...)` | `$in` | `{"operator": "IN", "value": ["A", "B"]}` |
| **`IS_NULL`** | `IS NULL` | `$eq: null` | `{"operator": "IS_NULL"}` (omit value) |
| **`IS_NOT_NULL`** | `IS NOT NULL` | `$ne: null` | `{"operator": "IS_NOT_NULL"}` (omit value) |

---

## 4. Index Abstractions

Define these index types within manifest columns to scale search query routing:

* **`BTREE`**
  * Default tree indexing method. Best for equality (`EQ`) and range comparisons (`GT`, `LT`).
* **`GIN`** (Generalized Inverted Index)
  * Designed for indexing composite variables, arrays, and JSONB fields. Highly effective for text searching.
* **`BRIN`** (Block Range Index)
  * Ideal for extremely large tables sorted linearly by timestamp or integer ID. Groups blocks to save memory.
* **`GIST`** (Generalized Search Tree)
  * Essential for geometric data coordinates or range overlap checking constraints.

---

## 5. Supported Datasource Engines

Register these drivers inside connection maps to wire external systems into the fabric:

* **`postgres`** — PostgreSQL & Citus database clusters (Primary Hub driver).
* **`mysql`** — MySQL & MariaDB relational endpoints.
* **`oracle`** — Oracle Enterprise Databases.
* **`snowflake`** — Snowflake Cloud Data Warehouses.
* **`mongodb`** — MongoDB Document Collections.
* **`elasticsearch`** — Elasticsearch Search Clusters.
