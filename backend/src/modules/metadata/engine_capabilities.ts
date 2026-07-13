/**
 * Engine capability registry.
 * ----------------------------
 * Maps each supported database engine type to a capability matrix describing
 * which DDL/DML features the engine supports natively. Consumed by `DiffEngine`
 * to decide whether to emit native DDL, fabric-level compensation actions, or
 * hub-hosted fallbacks — instead of hardcoding `if (targetSource !== 'Fabric_Hub_Postgres')`.
 *
 * When an engine does NOT support a feature natively (e.g. MongoDB has no sequences),
 * the diff engine emits a fabric compensation action (e.g. `REGISTER_FABRIC_SEQUENCE`)
 * so the `FabricWriteGenerators` / `FabricSequenceService` can provide the equivalent
 * capability at write-time.
 *
 * The `resolveEngineType` helper looks up the engine type from `public.data_sources`
 * by source name + tenant, with a fast-path for the well-known hub name.
 */
import { pool } from '../../config/database';

/** Discriminator for supported database engine types. */
export type EngineType = 'POSTGRES' | 'MYSQL' | 'MONGODB' | 'ELASTICSEARCH' | 'ORACLE' | 'SNOWFLAKE';

/**
 * Capability descriptor for a single engine type. Each boolean flag indicates
 * whether the engine supports that DDL/DML feature natively (i.e. the transpiler
 * can emit engine-native syntax for it). When `false`, the diff engine should
 * emit a fabric compensation action instead of silently skipping.
 */
export interface EngineCapability {
    /** Engine supports `CREATE SEQUENCE` (Postgres, Oracle) or equivalent. */
    supportsSequences: boolean;
    /** Engine supports `CREATE FUNCTION` / `CREATE PROCEDURE`. */
    supportsFunctions: boolean;
    /** Engine supports `CREATE VIEW`. */
    supportsViews: boolean;
    /** Engine supports `CREATE MATERIALIZED VIEW`. */
    supportsMaterializedViews: boolean;
    /** Engine supports `CREATE TYPE ... AS ENUM` (Postgres-only). */
    supportsEnums: boolean;
    /** Engine supports `CREATE SCHEMA` / `CREATE DATABASE`. */
    supportsSchemas: boolean;
    /** Engine supports `CREATE TRIGGER`. */
    supportsTriggers: boolean;
    /** Engine supports Row-Level Security (`ALTER TABLE ... ENABLE ROW LEVEL SECURITY`). */
    supportsRLS: boolean;
    /** Engine exposes `information_schema` or equivalent for catalog introspection. */
    catalogIntrospection: boolean;
    /**
     * How the engine emulates auto-incrementing IDs when native `CREATE SEQUENCE` is absent:
     *  - `null`             — native sequences available (Postgres, Oracle).
     *  - `'AUTO_INCREMENT'` — MySQL-style column attribute.
     *  - `'IDENTITY'`       — Snowflake AUTOINCREMENT / IDENTITY.
     *  - `'FABRIC'`         — No native support; use `FabricSequenceService` at write-time.
     */
    sequenceEmulation: 'AUTO_INCREMENT' | 'IDENTITY' | 'FABRIC' | null;
}

/**
 * Static capability matrix for all supported engine types.
 * This is the single source of truth for what each engine can do natively.
 */
export const ENGINE_CAPABILITIES: Record<EngineType, EngineCapability> = {
    POSTGRES: {
        supportsSequences: true,
        supportsFunctions: true,
        supportsViews: true,
        supportsMaterializedViews: true,
        supportsEnums: true,
        supportsSchemas: true,
        supportsTriggers: true,
        supportsRLS: true,
        catalogIntrospection: true,
        sequenceEmulation: null,
    },
    MYSQL: {
        supportsSequences: false,
        supportsFunctions: true,
        supportsViews: true,
        supportsMaterializedViews: false,
        supportsEnums: false,
        supportsSchemas: true,
        supportsTriggers: true,
        supportsRLS: false,
        catalogIntrospection: true,
        sequenceEmulation: 'AUTO_INCREMENT',
    },
    ORACLE: {
        supportsSequences: true,
        supportsFunctions: true,
        supportsViews: true,
        supportsMaterializedViews: true,
        supportsEnums: false,
        supportsSchemas: true,
        supportsTriggers: true,
        supportsRLS: true,
        catalogIntrospection: true,
        sequenceEmulation: null,
    },
    MONGODB: {
        supportsSequences: false,
        supportsFunctions: false,
        supportsViews: false,
        supportsMaterializedViews: false,
        supportsEnums: false,
        supportsSchemas: false,
        supportsTriggers: false,
        supportsRLS: false,
        catalogIntrospection: false,
        sequenceEmulation: 'FABRIC',
    },
    ELASTICSEARCH: {
        supportsSequences: false,
        supportsFunctions: false,
        supportsViews: false,
        supportsMaterializedViews: false,
        supportsEnums: false,
        supportsSchemas: false,
        supportsTriggers: false,
        supportsRLS: false,
        catalogIntrospection: false,
        sequenceEmulation: 'FABRIC',
    },
    SNOWFLAKE: {
        supportsSequences: true,
        supportsFunctions: true,
        supportsViews: true,
        supportsMaterializedViews: false,
        supportsEnums: false,
        supportsSchemas: true,
        supportsTriggers: false,
        supportsRLS: false,
        catalogIntrospection: true,
        sequenceEmulation: 'IDENTITY',
    },
};

/**
 * Engine capability resolver. Provides helpers to look up an engine's
 * capabilities from its registered source name.
 * @class
 * @hideconstructor
 */
export class EngineCapabilityRegistry {
    /**
     * Resolve the engine type for a given data source name.
     * Fast-paths the well-known hub name (`Fabric_Hub_Postgres`) without a DB query.
     * For all other sources, queries `public.data_sources` to find the registered engine type.
     * @param tenantId Tenant scope.
     * @param sourceName Registered data source name (e.g. `'Fabric_Hub_Postgres'`, `'Sales_Mongo'`).
     * @returns The engine type enum value.
     * @throws {Error} If the source is not registered for the tenant.
     */
    static async resolveEngineType(tenantId: string, sourceName: string): Promise<EngineType> {
        // Fast-path: the hub is always Postgres
        if (sourceName === 'Fabric_Hub_Postgres') return 'POSTGRES';

        const { rows } = await pool.query(
            'SELECT type FROM public.data_sources WHERE name = $1 AND tenant_id = $2',
            [sourceName, tenantId]
        );

        if (rows.length === 0) {
            throw new Error(`EngineCapabilityRegistry: Source '${sourceName}' not found for tenant '${tenantId}'`);
        }

        const engineType = (rows[0].type as string).toUpperCase() as EngineType;

        if (!ENGINE_CAPABILITIES[engineType]) {
            throw new Error(`EngineCapabilityRegistry: Unsupported engine type '${engineType}' for source '${sourceName}'`);
        }

        return engineType;
    }

    /**
     * Get the capability descriptor for a given engine type.
     * @param engineType The engine type to look up.
     * @returns The capability descriptor.
     */
    static getCapabilities(engineType: EngineType): EngineCapability {
        return ENGINE_CAPABILITIES[engineType];
    }

    /**
     * Resolve engine type AND capabilities in one call.
     * @param tenantId Tenant scope.
     * @param sourceName Registered data source name.
     * @returns Tuple of `[engineType, capabilities]`.
     */
    static async resolve(tenantId: string, sourceName: string): Promise<{ engineType: EngineType; caps: EngineCapability }> {
        const engineType = await this.resolveEngineType(tenantId, sourceName);
        return { engineType, caps: ENGINE_CAPABILITIES[engineType] };
    }
}
