# Rules & Guidelines for Queries and Manifests

This document outlines the design rules, query preparation guidelines, and schema constraints required to build secure, optimized, and correct integrations on the Zero Data Fabric.

---

## Rule 1: Select Query Enforcements

To protect data sources against unrestricted table scans, the fabric query engine strictly gates selects.

1. **Safety Shield**:
   * Every select query **MUST** declare a `where` predicate, a `limit` cap, or be a set operation. 
   * Queries omitting all three will be rejected at the router with `400 SAFETY: SELECT requires a where, a limit, or a set operation`.
2. **Alias Qualifiers**:
   * When joining tables, you **MUST** assign an `alias` (e.g. `"alias": "s"`) to each resource and qualify columns consistently (`s.id`, `d.shipment_id`).

---

## Rule 2: Update & Delete Gating

Unfiltered write mutations are blocked by the Query Coordinator.

1. **Mandatory Predicates**:
   * Every update and delete payload **MUST** include a non-empty `where` filter matching records. 
   * Empty `where` requests are rejected to prevent accidental bulk modifications of core datasets.

---

## Rule 3: Manifest Schema Specifications

1. **Primary Key Strategy**:
   * Use the **`UUID_V7`** strategy for primary keys. UUID v7 values are sorted by time, which optimizes index insertion speeds.
2. **Soft Deletions**:
   * If a table configures the `SOFT_DELETE` strategy, the target column **MUST** be defined as a nullable `TIMESTAMP` named `deleted_at`.
3. **Enums & Sequences**:
   * Column types defined as `ENUM` **MUST** declare a `ref` parameter pointing to a registered enum resource.
   * Sequences configured with `ownedBy` **MUST** target an existing table and column.

---

## Rule 4: Query Complexity & Federation Guidelines

1. **Bind-Join Optimization**:
   * When joining a fast database (e.g. Postgres) with a slow or document database (e.g. MongoDB), place the highly filtered relational table as the **driving `from` resource**, and join the MongoDB collection. 
   * This allows the coordinator to fetch a minimal set of primary keys first and pass them as a small `$in` batch to MongoDB.
2. **Set Operations Structure**:
   * All sub-queries combined inside `union`, `intersect`, or `except` blocks **MUST** project the exact same number of columns with corresponding datatypes.

---

## Rule 5: View & Materialized View Rules

1. **Concurrent Refresh Index**:
   * Any materialized view declaring `"refreshStrategy": "CONCURRENTLY"` **MUST** define at least one unique index on its columns in the `indexes` block. PostgreSQL blocks concurrent refreshes unless a unique index is present.
2. **Recursion Column Mappings**:
   * In recursive CTE view definitions (`with`), the columns projected inside the `base` select **MUST** match the names, types, and count of the columns projected inside the `unionAll` select leg.
