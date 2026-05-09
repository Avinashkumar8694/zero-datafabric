import { TriggerDefinition } from './triggers/trigger.types';

export { TriggerDefinition };

export type ResourceType = 'ENUM' | 'SEQUENCE' | 'TABLE' | 'VIEW' | 'MATERIALIZED_VIEW' | 'FUNCTION' | 'PROCEDURE';

export interface EnumDefinition {
    type: 'ENUM';
    name: string;
    values: string[];
}

export interface SequenceDefinition {
    type: 'SEQUENCE';
    name: string;
    start?: number;
    increment?: number;
    minValue?: number;
    maxValue?: number;
    cache?: number;
    ownedBy?: { table: string; column: string };
    strategy?: 'PROCEDURAL' | 'NATIVE';
    generator?: string;
}

export interface ColumnDefinition {
    name: string;
    type: string;
    length?: number;
    primaryKey?: boolean;
    unique?: boolean;
    default?: string;
    strategy?: 'UUID_V7' | 'IDENTITY_ALWAYS' | 'LEGACY_SERIAL' | 'FUNCTIONAL' | 'SOFT_DELETE';
    generated?: string;
    stored?: boolean;
    nullable?: boolean;
    index?: { type: 'Btree' | 'GIN' | 'BRIN' | 'GIST'; unique?: boolean };
    comment?: string;
    ref?: string;
    collation?: string;
}

export interface ConstraintDefinition {
    name: string;
    type: 'CHECK' | 'EXCLUDE' | 'FOREIGN_KEY';
    expression?: string;
    using?: string;
    columns?: { name: string; operator: string }[];
}

export interface TableDefinition {
    type: 'TABLE';
    name: string;
    comment?: string;
    version?: string;
    partitionBy?: { type: 'RANGE' | 'LIST'; column: string };
    identity?: { type: 'PRIMARY_KEY'; columns: string[] };
    maintenance?: { autovacuum_enabled?: boolean; fillfactor?: number };
    columns: ColumnDefinition[];
    constraints?: ConstraintDefinition[];
    triggers?: TriggerDefinition[];
    security?: {
        enable_rls?: boolean;
        masking?: { column: string; roles: string[]; expression: string }[];
        policies?: { name: string; roles?: string[]; using: string }[];
        grants?: { role: string; roles?: string[]; privileges: string[] }[];
    };
}

export interface QueryAST {
    with?: { name: string; columns: string[]; base: any; unionAll?: any }[];
    select?: any[];
    from: { resource: string; alias?: string; source?: string };
    joins?: { type: 'INNER' | 'LEFT' | 'RIGHT'; resource: string; alias?: string; on: { left: string; operator: string; right: string } }[];
    where?: any[];
    groupBy?: string[];
    orderBy?: { column: string; direction: 'ASC' | 'DESC' }[];
    union?: any[];
    intersect?: any[];
    except?: any[];
}

export interface ViewDefinition {
    type: 'VIEW' | 'MATERIALIZED_VIEW';
    name: string;
    query: QueryAST;
    recursive?: boolean;
    materialized?: boolean;
    refreshStrategy?: 'STANDARD' | 'CONCURRENTLY' | 'INCREMENTAL';
    refreshInterval?: string;
    indexes?: { columns: string[]; unique?: boolean }[];
    federationStrategy?: 'VIRTUAL' | 'NATIVE';
}

export interface FunctionDefinition {
    type: 'FUNCTION' | 'PROCEDURE';
    name: string;
    arguments?: { name: string; type: string; mode?: 'IN' | 'OUT' | 'INOUT' }[];
    returnType?: string;
    body: string;
}

export type ResourceDefinition = EnumDefinition | SequenceDefinition | TableDefinition | ViewDefinition | FunctionDefinition;

export interface RelationshipDefinition {
    name: string;
    cardinality: '1:1' | '1:M' | 'M:N';
    bridge?: string;
    from: { source?: string; resource: string; field: string };
    to: { source?: string; resource: string; field: string };
}

export interface SchemaDefinition {
    name: string;
    resources: ResourceDefinition[];
    targetSource?: string;
}

export interface MetadataManifest {
    version: string;
    namespace?: string;
    targetSource?: string;
    consistencyMode?: 'SAGA' | 'STRONG';
    downstream?: { type: string; enabled: boolean; strategy?: string; fallback?: string }[];
    extensions?: string[];
    schemas: SchemaDefinition[];
    relationships?: RelationshipDefinition[];
}
