/**
 * Metadata manifest type system (v4.0 spec).
 * ------------------------------------------
 * Defines the shape of a `MetadataManifest` — the declarative, version-controlled
 * document that describes a tenant's logical data fabric: schemas, resources
 * (enums, sequences, tables, views, functions/procedures), cross-resource
 * relationships, downstream sync targets (Elasticsearch/Snowflake) and required
 * Postgres extensions.
 *
 * These are pure structural types (no behavior). They are consumed across the
 * metadata module by:
 *  - `ManifestParser` — parses raw manifest JSON/Markdown into these shapes.
 *  - `DiffEngine` — compares a manifest against live catalog state to produce diffs.
 *  - `Transpiler` / `QueryTranspiler` — compile resources and query ASTs to SQL/Mongo ops.
 *  - `MetadataOrchestrator` — orchestrates plan/apply/rollback of a manifest.
 *  - `connectors/factory.ts` — the engine connectors that provision/query physical stores.
 */
export type TriggerEventType = 
    'BEFORE_INSERT' | 'AFTER_INSERT' | 
    'BEFORE_UPDATE' | 'AFTER_UPDATE' | 
    'BEFORE_DELETE' | 'AFTER_DELETE' | 
    'INSTEAD_OF_INSERT' | 'INSTEAD_OF_UPDATE' | 'INSTEAD_OF_DELETE';

export type TriggerExecuteType = 'FUNCTION' | 'WEBHOOK' | 'EXCEPTION' | 'AUDIT' | 'EMAIL' | 'TELEGRAM';

export interface TriggerDefinition {
    name: string;
    event: TriggerEventType;
    condition?: any;
    execute: {
        type: TriggerExecuteType;
        name?: string;
        url?: string;
        method?: string;
        payload?: any;
        params?: any;
        headers?: Record<string, string>;
        auth?: {
            type: 'NONE' | 'BASIC' | 'BEARER' | 'OIDC';
            username?: string;
            password?: string;
            token?: string;
            tokenEndpoint?: string;
            clientId?: string;
            clientSecret?: string;
            scope?: string;
            audience?: string;
        };
        message?: string;
        when?: any;
    };
    schedule?: {
        type: 'FIXED' | 'RELATIVE' | 'CRON';
        cron?: string;
        every?: number;
        column?: string;
        relativeColumn?: string;
        after?: number;
        unit?: 'SECOND' | 'MINUTE' | 'HOUR' | 'DAY' | 'MONTH';
        maxAttempts?: number;
    };
    autoDrop?: {
        when: any;
        message?: string;
    };
    scope?: 'ROW' | 'STATEMENT';
}

/** Discriminator for the kind of physical/logical object a manifest resource declares. */
export type ResourceType = 'ENUM' | 'SEQUENCE' | 'TABLE' | 'VIEW' | 'MATERIALIZED_VIEW' | 'FUNCTION' | 'PROCEDURE';

/** A Postgres-native enumerated type (`CREATE TYPE ... AS ENUM`). */
export interface EnumDefinition {
    type: 'ENUM';
    /** Enum type name (unqualified; schema-qualified at transpile time). */
    name: string;
    /** Ordered set of allowed label values. */
    values: string[];
}

/** A numeric sequence generator, either a native Postgres `SEQUENCE` or a procedural (function-backed) generator. */
export interface SequenceDefinition {
    type: 'SEQUENCE';
    /** Sequence name (unqualified). */
    name: string;
    /** First value produced (`START WITH`). Defaults to 1 if omitted. */
    start?: number;
    /** Step between successive values (`INCREMENT BY`). Defaults to 1 if omitted. */
    increment?: number;
    minValue?: number;
    maxValue?: number;
    /** Number of values pre-allocated per session (`CACHE`) for concurrency throughput. */
    cache?: number;
    /** Optional column this sequence is logically owned by (for documentation/tooling; not enforced as `OWNED BY`). */
    ownedBy?: { table: string; column: string };
    /** 'PROCEDURAL' delegates value generation to `generator` (e.g. a tenant-aware id function) instead of a native Postgres sequence; 'NATIVE' (default) uses `CREATE SEQUENCE`. */
    strategy?: 'PROCEDURAL' | 'NATIVE';
    /** SQL expression invoked to produce the next value when `strategy` is 'PROCEDURAL'. */
    generator?: string;
}

/** A single column within a `TableDefinition`. */
export interface ColumnDefinition {
    name: string;
    /** Logical/portable type name (e.g. `STRING`, `UUID`, `TIMESTAMP`); normalized to the engine-native type at transpile time. */
    type: string;
    length?: number;
    primaryKey?: boolean;
    unique?: boolean;
    /** Literal or SQL expression default (e.g. `NOW()`, `'PENDING'`); ignored when `strategy` already implies a default. */
    default?: string;
    /**
     * Column value-generation strategy:
     *  - `UUID_V7` — time-ordered UUID via `gen_random_uuid()`-based default.
     *  - `IDENTITY_ALWAYS` — `GENERATED ALWAYS AS IDENTITY`.
     *  - `LEGACY_SERIAL` — classic `SERIAL` column.
     *  - `FUNCTIONAL` — value computed by a per-column BEFORE INSERT trigger calling `default` as an expression.
     *  - `SOFT_DELETE` — marks the column as the soft-delete timestamp (documentation/tooling hint).
     */
    strategy?: 'UUID_V7' | 'IDENTITY_ALWAYS' | 'LEGACY_SERIAL' | 'FUNCTIONAL' | 'SOFT_DELETE';
    /** Expression for a generated column (`GENERATED ALWAYS AS (...) STORED`). */
    generated?: string;
    stored?: boolean;
    nullable?: boolean;
    /** Secondary index to create on this column, with the storage/access method and uniqueness. */
    index?: { type: 'Btree' | 'GIN' | 'BRIN' | 'GIST'; unique?: boolean };
    comment?: string;
    /** For `type: 'ENUM'` columns, the name of the `EnumDefinition` this column references. */
    ref?: string;
    collation?: string;
}

/** A table-level constraint: CHECK, EXCLUDE (GiST-backed), or FOREIGN_KEY. */
export interface ConstraintDefinition {
    name: string;
    type: 'CHECK' | 'EXCLUDE' | 'FOREIGN_KEY';
    /** Boolean SQL expression for `CHECK` constraints. */
    expression?: string;
    /** Index access method for `EXCLUDE` constraints (e.g. `GIST`). */
    using?: string;
    /** Column/operator pairs for `EXCLUDE` constraints (e.g. `{ name: 'region', operator: '=' }`). */
    columns?: { name: string; operator: string }[];
}

/** A physical table resource, including its columns, constraints, triggers, maintenance and security policy. */
export interface TableDefinition {
    type: 'TABLE';
    name: string;
    comment?: string;
    /** Free-form schema version tag for the table (documentation/tooling only). */
    version?: string;
    /** Declarative partitioning (`PARTITION BY RANGE|LIST (column)`). */
    partitionBy?: { type: 'RANGE' | 'LIST'; column: string };
    /** Composite/explicit primary key declared separately from per-column `primaryKey` flags. */
    identity?: { type: 'PRIMARY_KEY'; columns: string[] };
    /** Storage/maintenance tuning applied via `ALTER TABLE ... SET (...)`. */
    maintenance?: { autovacuum_enabled?: boolean; fillfactor?: number };
    columns: ColumnDefinition[];
    constraints?: ConstraintDefinition[];
    triggers?: TriggerDefinition[];
    /** Row-level security, masking, RLS policies, grants and engine-agnostic access policies for this table. */
    security?: {
        enable_rls?: boolean;
        masking?: { column: string; roles: string[]; expression: string }[];
        policies?: { name: string; roles?: string[]; using: string }[];
        grants?: { role: string; roles?: string[]; privileges: string[] }[];
        /**
         * Engine-agnostic access policies enforced by the fabric Policy Engine on
         * non-RLS engines (Mongo/ES/remote): each carries a structured row predicate
         * and/or column masking. `using` (above) stays Postgres-native RLS.
         */
        accessPolicies?: {
            name: string;
            roles?: string[];
            rowFilter?: { column: string; operator: string; value?: any }[];
            masking?: { column: string; roles?: string[]; strategy: 'REDACT' | 'NULL' | 'HASH' | 'PARTIAL' }[];
        }[];
    };
}

/**
 * Engine-agnostic query AST consumed by `QueryTranspiler.toSql` (and, for views
 * targeting Mongo/ES sources, by the pushdown compiler). Supports CTEs
 * (including recursive `UNION ALL` legs), joins, window functions, aggregates,
 * full-text search predicates and set operations (UNION/INTERSECT/EXCEPT).
 */
export interface QueryAST {
    /** Common Table Expressions; `unionAll` on an entry makes it a recursive CTE leg. */
    with?: { name: string; columns: string[]; base: any; unionAll?: any }[];
    /** Projected columns/expressions; omitted or empty selects `*`. */
    select?: any[];
    /** Primary FROM target; `source` names a remote data source for federated queries. */
    from: { resource: string; alias?: string; source?: string };
    joins?: { type: 'INNER' | 'LEFT' | 'RIGHT'; resource: string; alias?: string; on: { left: string; operator: string; right: string } }[];
    /** ANDed predicate list. */
    where?: any[];
    groupBy?: string[];
    orderBy?: { column: string; direction: 'ASC' | 'DESC' }[];
    /** Set operations: each is a list of sibling `QueryAST`s combined with UNION/INTERSECT/EXCEPT. */
    union?: any[];
    intersect?: any[];
    except?: any[];
}

/** A logical or materialized view resource, backed by a `QueryAST`. */
export interface ViewDefinition {
    type: 'VIEW' | 'MATERIALIZED_VIEW';
    name: string;
    query: QueryAST;
    /** Marks the view's query as a recursive CTE (documentation/tooling hint; the recursive keyword is emitted whenever `query.with` is present). */
    recursive?: boolean;
    /** True (or `type: 'MATERIALIZED_VIEW'`) creates a `MATERIALIZED VIEW` instead of a plain view. */
    materialized?: boolean;
    /** Refresh mode for materialized views (`CONCURRENTLY` requires a unique index). */
    refreshStrategy?: 'STANDARD' | 'CONCURRENTLY' | 'INCREMENTAL';
    /** Human-readable refresh cadence (documentation/tooling; not enforced by the transpiler). */
    refreshInterval?: string;
    /** Indexes to create on a materialized view's result set. */
    indexes?: { columns: string[]; unique?: boolean }[];
    /** 'VIRTUAL' registers the view logically in the Fabric query engine without emitting a physical `CREATE VIEW` (used for cross-source federated views). */
    federationStrategy?: 'VIRTUAL' | 'NATIVE';
}

/** A stored function or procedure resource. */
export interface FunctionDefinition {
    type: 'FUNCTION' | 'PROCEDURE';
    name: string;
    arguments?: { name: string; type: string; mode?: 'IN' | 'OUT' | 'INOUT' }[];
    /** PL/pgSQL return type; omitted for procedures or void functions. */
    returnType?: string;
    /** Function/procedure body; auto-wrapped in `BEGIN...END` by the transpiler if not already present. */
    body: string;
}

/** Union of every resource kind that can appear in a `SchemaDefinition.resources` array. */
export type ResourceDefinition = EnumDefinition | SequenceDefinition | TableDefinition | ViewDefinition | FunctionDefinition;

/** A declared relationship between two resources, optionally spanning different data sources. */
export interface RelationshipDefinition {
    name: string;
    /** '1:1'/'1:M' emit a FOREIGN KEY on the child side; 'M:N' emits (or federates) a bridge table named by `bridge`. */
    cardinality: '1:1' | '1:M' | 'M:N';
    /** Bridge/junction table name, required when `cardinality` is 'M:N'. */
    bridge?: string;
    /** Parent side of the relationship; `source` names a remote data source when the parent lives outside the target schema. */
    from: { source?: string; resource: string; field: string };
    /** Child side of the relationship (holds the foreign key for 1:1/1:M). */
    to: { source?: string; resource: string; field: string };
}

/** One logical schema (namespace) within a manifest, mapped to a physical `tenant_{id}_{name}` schema at apply time. */
export interface SchemaDefinition {
    name: string;
    resources: ResourceDefinition[];
    /** Data source this schema's resources are provisioned against; falls back to `MetadataManifest.targetSource`, then 'Fabric_Hub_Postgres'. */
    targetSource?: string;
}

/**
 * Root document describing a tenant's declarative data fabric — the unit
 * accepted by `MetadataOrchestrator.plan`/`apply` and produced by
 * `MetadataService.exportManifest`.
 */
export interface MetadataManifest {
    /** Manifest schema/spec version tag (e.g. "4.0"); required by `MetadataOrchestrator.validateManifest`. */
    version: string;
    namespace?: string;
    /** Default data source for schemas/resources that don't specify their own `targetSource`. */
    targetSource?: string;
    /** Cross-engine write consistency mode: 'SAGA' (best-effort, compensating) vs 'STRONG' (not yet fully enforced). */
    consistencyMode?: 'SAGA' | 'STRONG';
    /** Downstream sync targets (e.g. Elasticsearch, Snowflake) reconciled by `DownstreamService.provision`. */
    downstream?: { type: string; enabled: boolean; strategy?: string; fallback?: string }[];
    /** Postgres extensions required by this manifest (e.g. `uuid-ossp`, `pgcrypto`). */
    extensions?: string[];
    schemas: SchemaDefinition[];
    relationships?: RelationshipDefinition[];
}
