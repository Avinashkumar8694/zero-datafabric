/**
 * Cross-source connector factory.
 * --------------------------------
 * Defines the `IConnector` contract every supported engine implements —
 * schema/table/column discovery, filtered query with pushdown, optional raw
 * SQL execution, and optional document-store write ops — plus one concrete
 * connector per supported engine:
 *  - `PostgresConnector` — a remote Postgres source, with catalog introspection
 *    via `pg_class`/`pg_proc`/`pg_type` and SQL pushdown via `PushdownCompiler`.
 *  - `MySQLConnector` — MySQL/MariaDB, via `SHOW`/`information_schema` and SQL pushdown.
 *  - `MongoDBConnector` — MongoDB, with schema inferred by sampling documents and
 *    pushdown compiled to either a `find` spec or a `$group` aggregation pipeline.
 *  - `SnowflakeConnector` — Snowflake via the optional `snowflake-sdk` driver
 *    (lazy-required so the build never hard-depends on it).
 *  - `ElasticsearchConnector` — Elasticsearch as a queryable federated source via
 *    `_search`/`_sql`, plus bulk write ops for the `/api/data` CRUD endpoints.
 * `ConnectorFactory.getConnector` is the single entry point used across the
 * metadata module (crawling, manifest export, live query execution) to obtain
 * the right connector instance for a data source's engine `type`.
 */
import { Pool } from 'pg';
import * as mysql from 'mysql2/promise';
import { MongoClient } from 'mongodb';
import { PushdownCompiler, CanonicalQuery } from '../../query-engine/pushdown';

/**
 * Extract the canonical query shape (select / filter / orderBy / limit / offset)
 * from a QueryConfig so it can be pushed down to a source engine.
 */
function toCanonical(config: any): CanonicalQuery {
    return {
        select: config?.select,
        filter: config?.filter,
        orderBy: config?.orderBy,
        limit: config?.limit,
        offset: config?.offset,
        groupBy: config?.groupBy,
        aggregates: config?.aggregates,
    };
}

/**
 * Common contract every engine connector implements, letting the rest of the
 * fabric (crawling, manifest export, live query execution, CRUD endpoints)
 * treat Postgres/MySQL/MongoDB/Snowflake/Elasticsearch sources uniformly.
 */
export interface IConnector {
    /** Lists the source's logical schemas/databases as `{ name, physicalName }`. */
    discoverSchemas(): Promise<any[]>;
    /** Lists tables/views/other relations in a schema as `{ name, physicalName, rowCount, resourceType }`. */
    discoverTables(schema: string): Promise<any[]>;
    /** Column-level metadata: { name, type, nullable, default, primaryKey } */
    discoverColumns?(schema: string, table: string): Promise<any[]>;
    /** Runs a canonical (pushdown-compiled) filtered/sorted/paginated query against one table/collection. */
    query(schema: string, table: string, config: any): Promise<any[]>;
    /** Execute arbitrary native SQL at the source (SQL-native engines only). */
    rawQuery?(sql: string, params?: any[]): Promise<any[]>;
    /** Document-store write ops (Mongo); relational engines use rawQuery instead. */
    insertDocs?(schema: string, table: string, docs: any[]): Promise<any>;
    updateDocs?(schema: string, table: string, filter: Record<string, any>, set: Record<string, any>): Promise<any>;
    deleteDocs?(schema: string, table: string, filter: Record<string, any>): Promise<any>;
    /** Releases any pooled/native connection held by the connector. */
    close(): Promise<void>;
}

/**
 * `IConnector` implementation for a remote Postgres data source: catalog
 * introspection via `pg_class`/`pg_proc`/`pg_type`/`information_schema`, and
 * filtered queries compiled through `PushdownCompiler` with a fallback to the
 * `public` schema if the configured schema fails.
 */
export class PostgresConnector implements IConnector {
    private pool: Pool;
    /**
     * Creates a connection pool for the given source configuration.
     * @param config Connection config: either `connectionString`, or `host`/`port`/`user`/`password|pass`/`database|dbName|db`.
     */
    constructor(config: any) {
        if (config.advanced?.dynamicOptions) {
            console.log(`[Connector] Applying dynamic options:`, JSON.stringify(config.advanced.dynamicOptions));
        }
        
        const poolConfig: any = {
            host: String(config.host || 'localhost'),
            port: Number(config.port || 5432),
            database: String(config.dbName || config.database || config.db || 'postgres'),
            user: String(config.user || 'postgres')
        };

        // Industrial Safety: Only attach password if it's a valid string
        const pass = config.pass || config.password;
        if (typeof pass === 'string' && pass.length > 0) {
            poolConfig.password = pass;
        }

        if (config.connectionString) {
            this.pool = new Pool({ connectionString: String(config.connectionString) });
        } else {
            this.pool = new Pool(poolConfig);
        }
    }

    /**
     * Lists user schemas, excluding `information_schema`/`pg_catalog` and any `pg_%` system schema.
     * @returns Rows of `{ name, physicalName }` (identical, since Postgres schema names are already physical).
     */
    async discoverSchemas(): Promise<any[]> {
        const { rows } = await this.pool.query(`
            SELECT
                schema_name as name,
                schema_name as "physicalName"
            FROM information_schema.schemata
            WHERE schema_name NOT IN ('information_schema', 'pg_catalog')
              AND schema_name NOT LIKE 'pg_%'
        `);
        return rows;
    }

    /**
     * Lists every discoverable object in a schema: tables, partitioned
     * tables, views, materialized views, foreign tables and sequences (via
     * `pg_class`), plus functions/procedures (via `pg_proc`, ignored if
     * `prokind` isn't supported pre-PG11) and enum types (via `pg_type`).
     * @param schema Physical schema name to scan.
     * @returns Combined rows of `{ name, physicalName, rowCount, resourceType }` across all object kinds.
     */
    async discoverTables(schema: string): Promise<any[]> {
        // Relations: tables, partitioned tables, views, materialized views,
        // foreign tables, and sequences — each with its object type.
        const rels = await this.pool.query(`
            SELECT c.relname AS name, c.relname AS "physicalName", GREATEST(c.reltuples, 0)::bigint AS "rowCount",
                   CASE c.relkind
                        WHEN 'r' THEN 'TABLE'
                        WHEN 'p' THEN 'TABLE'
                        WHEN 'v' THEN 'VIEW'
                        WHEN 'm' THEN 'MATERIALIZED_VIEW'
                        WHEN 'f' THEN 'FOREIGN_TABLE'
                        WHEN 'S' THEN 'SEQUENCE'
                   END AS "resourceType"
            FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
            WHERE n.nspname = $1 AND c.relkind IN ('r','p','v','m','f','S')
        `, [schema]);
        // Functions & procedures.
        const funcs = await this.pool.query(`
            SELECT p.proname AS name, p.proname AS "physicalName", 0::bigint AS "rowCount",
                   CASE p.prokind WHEN 'p' THEN 'PROCEDURE' ELSE 'FUNCTION' END AS "resourceType"
            FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
            WHERE n.nspname = $1 AND p.prokind IN ('f','p')
        `, [schema]).catch(() => ({ rows: [] })); // prokind exists on PG11+; ignore otherwise
        // Enum types.
        const enums = await this.pool.query(`
            SELECT t.typname AS name, t.typname AS "physicalName", 0::bigint AS "rowCount", 'ENUM' AS "resourceType"
            FROM pg_type t JOIN pg_namespace n ON n.oid = t.typnamespace
            WHERE n.nspname = $1 AND t.typtype = 'e'
        `, [schema]).catch(() => ({ rows: [] }));
        return [...rels.rows, ...funcs.rows, ...enums.rows];
    }

    /**
     * Foreign-key relationships within a schema (for ER diagrams).
     * @param schema Physical schema name to scan.
     * @returns Rows of `{ name, sourceTable, sourceColumn, targetTable, targetColumn }`, one per FK constraint column.
     */
    async discoverRelationships(schema: string): Promise<any[]> {
        const { rows } = await this.pool.query(`
            SELECT tc.constraint_name AS name,
                   kcu.table_name AS "sourceTable", kcu.column_name AS "sourceColumn",
                   ccu.table_name AS "targetTable", ccu.column_name AS "targetColumn"
            FROM information_schema.table_constraints tc
            JOIN information_schema.key_column_usage kcu
              ON tc.constraint_name = kcu.constraint_name AND tc.table_schema = kcu.table_schema
            JOIN information_schema.constraint_column_usage ccu
              ON ccu.constraint_name = tc.constraint_name AND ccu.table_schema = tc.table_schema
            WHERE tc.constraint_type = 'FOREIGN KEY' AND tc.table_schema = $1
        `, [schema]);
        return rows;
    }

    /**
     * Column-level metadata for a table/view/materialized view/foreign table.
     * Uses `pg_attribute` rather than `information_schema.columns` because
     * the latter omits materialized views.
     * @param schema Physical schema name.
     * @param table Physical relation name.
     * @returns Rows of `{ name, type, nullable, default, primaryKey }`, ordered by column position.
     */
    async discoverColumns(schema: string, table: string): Promise<any[]> {
        // pg_attribute covers tables, views, materialized views and foreign tables
        // (information_schema.columns omits materialized views).
        const { rows } = await this.pool.query(`
            SELECT a.attname AS name,
                   format_type(a.atttypid, a.atttypmod) AS type,
                   (NOT a.attnotnull) AS nullable,
                   pg_get_expr(ad.adbin, ad.adrelid) AS "default",
                   COALESCE((pk.conkey IS NOT NULL), false) AS "primaryKey"
            FROM pg_attribute a
            JOIN pg_class c ON c.oid = a.attrelid
            JOIN pg_namespace n ON n.oid = c.relnamespace
            LEFT JOIN pg_attrdef ad ON ad.adrelid = a.attrelid AND ad.adnum = a.attnum
            LEFT JOIN LATERAL (
                SELECT ct.conkey FROM pg_constraint ct
                WHERE ct.conrelid = a.attrelid AND ct.contype = 'p' AND a.attnum = ANY(ct.conkey) LIMIT 1
            ) pk ON true
            WHERE n.nspname = $1 AND c.relname = $2 AND a.attnum > 0 AND NOT a.attisdropped
            ORDER BY a.attnum
        `, [schema, table]);
        return rows;
    }

    /**
     * Runs a canonical (filter/projection/sort/limit/offset) query against a
     * table, compiled to parameterized SQL by `PushdownCompiler`. If the
     * query fails against the requested schema, retries once against
     * `public` before giving up (some sources register objects there
     * regardless of the nominal schema).
     * @param schema Physical schema to query.
     * @param table Physical table name.
     * @param config Canonical query config (`select`/`filter`/`orderBy`/`limit`/`offset`/`groupBy`/`aggregates`).
     * @returns The matching rows.
     * @throws Rethrows the inner error if the query also fails against `public`.
     */
    async query(schema: string, table: string, config: any): Promise<any[]> {
        const canonical = toCanonical(config);
        // Push filter / projection / sort / limit / offset down to the remote engine
        // (parameterized) instead of fetching the whole table and filtering in JS.
        const compiled = PushdownCompiler.toSql({ ...canonical, schema, table, dialect: 'postgres' });
        // INDUSTRIAL RESILIENCE: Try specified schema, fallback to public if needed
        try {
            console.log(`[PostgresConnector] Pushdown SQL: ${compiled.text}`);
            const { rows } = await this.pool.query(compiled.text, compiled.params);
            return rows;
        } catch (err: any) {
            console.warn(`[PostgresConnector] Schema "${schema}" failed, falling back to public for table "${table}"`);
            try {
                const fallback = PushdownCompiler.toSql({ ...canonical, schema: 'public', table, dialect: 'postgres' });
                const { rows } = await this.pool.query(fallback.text, fallback.params);
                return rows;
            } catch (innerErr: any) {
                console.error(`[PostgresConnector] Query failed on both "${schema}" and "public":`, innerErr.message);
                throw innerErr;
            }
        }
    }

    /**
     * Execute native SQL directly at the remote Postgres source. This is how the
     * fabric runs complex single-source analytics (window functions, recursive CTEs,
     * materialized-view reads) AT the source engine that owns the data, instead of
     * only against the hub. Sets a search_path so unqualified names resolve to the
     * caller-provided schema when supplied.
     * @param sql SQL text to execute (unqualified names resolve against whatever `search_path` is currently set — see `setSearchPath`).
     * @param params Positional parameters (`$1`, `$2`, ...) for the query; defaults to none.
     * @returns The result rows.
     * @throws Propagates any driver/query error.
     */
    async rawQuery(sql: string, params: any[] = []): Promise<any[]> {
        console.log(`[PostgresConnector] Raw SQL: ${String(sql).slice(0, 200)}`);
        const { rows } = await this.pool.query(sql, params);
        return rows;
    }

    /**
     * Sets this connection's `search_path` so subsequent unqualified `rawQuery`
     * calls resolve names against `schema` first, falling back to `public`.
     * @param schema Schema name to prepend to the search path; sanitized to a safe identifier charset.
     */
    async setSearchPath(schema: string): Promise<void> {
        const safe = String(schema).replace(/[^a-zA-Z0-9_]/g, '');
        if (safe) await this.pool.query(`SET search_path TO "${safe}", public`);
    }

    /** Closes the underlying connection pool. */
    async close() {
        await this.pool.end();
    }
}

/**
 * `IConnector` implementation for a MySQL/MariaDB data source: catalog
 * introspection via `SHOW`/`information_schema`, and filtered queries
 * compiled through `PushdownCompiler`. The underlying connection is opened
 * lazily on first use and reused for subsequent calls.
 */
export class MySQLConnector implements IConnector {
    private connection: mysql.Connection | null = null;
    private config: any;

    /**
     * Stores the connection config; the actual connection is opened lazily by `connect()`.
     * @param config Connection config: either `connectionString`, or `host`/`port`/`user`/`password|pass`/`database|dbName|db`.
     */
    constructor(config: any) {
        this.config = config;
    }

    /**
     * Returns the cached MySQL connection, opening one on first call.
     * @returns The (possibly newly created) `mysql2` connection.
     */
    private async connect() {
        if (!this.connection) {
            if (this.config.connectionString) {
                this.connection = await mysql.createConnection(this.config.connectionString);
            } else {
                this.connection = await mysql.createConnection({
                    host: this.config.host,
                    port: this.config.port,
                    user: this.config.user,
                    password: this.config.pass || this.config.password,
                    database: this.config.dbName || this.config.database || this.config.db
                });
            }
        }
        return this.connection;
    }

    /**
     * Lists databases as MySQL's logical schemas.
     * @returns Rows of `{ name, physicalName }` (both equal to the database name).
     */
    async discoverSchemas(): Promise<any[]> {
        const conn = await this.connect();
        const [rows]: any = await conn.query('SHOW DATABASES');
        return rows.map((r: any) => ({ name: r.Database, physicalName: r.Database }));
    }

    /**
     * Lists tables/views (via `SHOW FULL TABLES`, which distinguishes the
     * two) plus stored functions/procedures (via `information_schema.ROUTINES`,
     * best-effort) in a database.
     * @param schema Database name to scan; sanitized to a safe identifier charset before use in `USE`.
     * @returns Combined rows of `{ name, physicalName, rowCount: 0, resourceType }`.
     */
    async discoverTables(schema: string): Promise<any[]> {
        const conn = await this.connect();
        const safeSchema = schema.replace(/[^a-zA-Z0-9_]/g, '');
        await conn.query(`USE \`${safeSchema}\``);
        // SHOW FULL TABLES distinguishes BASE TABLE from VIEW.
        const [tables]: any = await conn.query('SHOW FULL TABLES');
        const out = tables.map((r: any) => {
            const vals = Object.values(r);
            const name = vals[0];
            const tableType = String(vals[1] || 'BASE TABLE').toUpperCase();
            return { name, physicalName: name, rowCount: 0, resourceType: tableType.includes('VIEW') ? 'VIEW' : 'TABLE' };
        });
        // Stored functions & procedures.
        try {
            const [routines]: any = await conn.query(
                'SELECT ROUTINE_NAME AS name, ROUTINE_TYPE AS type FROM information_schema.ROUTINES WHERE ROUTINE_SCHEMA = ?', [safeSchema]);
            for (const r of routines) out.push({ name: r.name, physicalName: r.name, rowCount: 0, resourceType: String(r.type).toUpperCase() === 'PROCEDURE' ? 'PROCEDURE' : 'FUNCTION' });
        } catch { /* routines optional */ }
        return out;
    }

    /**
     * Column-level metadata for a table via `information_schema.COLUMNS`.
     * @param schema Database (schema) name.
     * @param table Table name.
     * @returns Rows of `{ name, type, nullable, default, primaryKey }`, ordered by column position.
     */
    async discoverColumns(schema: string, table: string): Promise<any[]> {
        const conn = await this.connect();
        const [rows]: any = await conn.query(
            `SELECT COLUMN_NAME AS name, DATA_TYPE AS type, (IS_NULLABLE='YES') AS nullable,
                    COLUMN_DEFAULT AS \`default\`, (COLUMN_KEY='PRI') AS \`primaryKey\`
             FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ? ORDER BY ORDINAL_POSITION`,
            [schema, table]);
        return rows;
    }

    /**
     * Runs a canonical (filter/projection/sort/limit/offset) query against a
     * table, compiled to parameterized SQL by `PushdownCompiler`. Switches
     * the connection's active database to `schema` before executing.
     * @param schema Database name to query.
     * @param table Table name.
     * @param config Canonical query config (`select`/`filter`/`orderBy`/`limit`/`offset`/`groupBy`/`aggregates`).
     * @returns The matching rows.
     */
    async query(schema: string, table: string, config: any): Promise<any[]> {
        const conn = await this.connect();
        await conn.query(`USE \`${schema.replace(/[^a-zA-Z0-9_]/g, '')}\``);
        // Push filter / projection / sort / limit / offset down to MySQL (parameterized).
        const compiled = PushdownCompiler.toSql({ ...toCanonical(config), table, dialect: 'mysql' });
        console.log(`[MySQLConnector] Pushdown SQL: ${compiled.text}`);
        const [rows]: any = await conn.execute(compiled.text, compiled.params);
        return rows;
    }

    /** Closes the underlying connection, if one was ever opened. */
    async close() {
        if (this.connection) await this.connection.end();
    }
}

/**
 * `IConnector` implementation for a MongoDB data source. Schemas map to
 * Mongo databases and tables to collections; since Mongo is schemaless,
 * column metadata is inferred by sampling documents. Filtered queries are
 * pushed down either as a `find` spec or, when aggregates/grouping are
 * requested, as a `$group` aggregation pipeline (both via `PushdownCompiler`).
 * Also implements the optional document-store write ops used by the
 * `/api/data` CRUD endpoints.
 */
export class MongoDBConnector implements IConnector {
    private client: MongoClient;
    private config: any;

    /**
     * Creates a (not-yet-connected) MongoDB client from the given config.
     * @param config Connection config: `uri`/`connectionString`/`url`, or `user`/`pass`/`host`/`port` to build a `mongodb://` URL.
     */
    constructor(config: any) {
        if (config.advanced?.dynamicOptions) {
            console.log(`[Connector] Applying dynamic options to Mongo:`, JSON.stringify(config.advanced.dynamicOptions));
        }
        // Accept every config shape used across the platform (dispatcher uses `uri`,
        // examples use host/port, others use connectionString/url).
        const url = config.uri || config.connectionString || config.url
            || `mongodb://${config.user}:${config.pass}@${config.host}:${config.port}`;
        this.client = new MongoClient(url);
    }

    async discoverSchemas(): Promise<any[]> {
        await this.client.connect();
        const dbs = await this.client.db().admin().listDatabases();
        const SYSTEM_DBS = new Set(['admin', 'config', 'local']);
        return dbs.databases
            .filter((db: any) => !SYSTEM_DBS.has(db.name))
            .map((db: any) => ({ name: db.name, physicalName: db.name }));
    }

    async discoverTables(schema: string): Promise<any[]> {
        const db = this.client.db(schema);
        const collections = await db.listCollections().toArray();
        // Mongo listCollections reports type 'collection' vs 'view'.
        return collections.map(c => ({
            name: c.name,
            physicalName: c.name,
            rowCount: 0,
            resourceType: (c as any).type === 'view' ? 'VIEW' : 'TABLE',
        }));
    }

    async discoverColumns(schema: string, table: string): Promise<any[]> {
        // Mongo is schemaless — infer fields by sampling a few documents.
        await this.client.connect();
        const docs = await this.client.db(schema).collection(table).find({}).limit(20).toArray();
        const fields = new Map<string, string>();
        for (const doc of docs) {
            for (const k of Object.keys(doc)) {
                if (!fields.has(k)) { const v = (doc as any)[k]; fields.set(k, v === null ? 'null' : Array.isArray(v) ? 'array' : typeof v); }
            }
        }
        return Array.from(fields.entries()).map(([name, type]) => ({ name, type, nullable: true, default: null, primaryKey: name === '_id' }));
    }

    async query(schema: string, table: string, config: any): Promise<any[]> {
        await this.client.connect();
        const db = this.client.db(schema);
        const collection = db.collection(table);
        const canonical = toCanonical(config);

        // Aggregate / DISTINCT pushdown: a $group pipeline (groups, not rows) is used
        // when there are aggregates OR grouping columns (GROUP BY-only = DISTINCT).
        if ((canonical.aggregates && canonical.aggregates.length > 0) || (canonical.groupBy && canonical.groupBy.length > 0)) {
            const pipeline = PushdownCompiler.toMongoAggregate(canonical);
            console.log(`[MongoDBConnector] Pushdown aggregate: ${JSON.stringify(pipeline)}`);
            return await collection.aggregate(pipeline).toArray();
        }

        // Push filter / projection / sort / limit / skip down to MongoDB.
        const spec = PushdownCompiler.toMongo(canonical);
        console.log(`[MongoDBConnector] Pushdown find: ${JSON.stringify(spec.filter)} proj=${JSON.stringify(spec.projection || {})}`);

        let cursor = collection.find(spec.filter, spec.projection ? { projection: spec.projection } : {});
        if (spec.sort) cursor = cursor.sort(spec.sort);
        if (typeof spec.skip === 'number') cursor = cursor.skip(spec.skip);
        if (typeof spec.limit === 'number') cursor = cursor.limit(spec.limit);

        return await cursor.toArray();
    }

    // --- write support (used by the /api/data CRUD endpoints) ---
    async insertDocs(schema: string, table: string, docs: any[]): Promise<any> {
        await this.client.connect();
        const r = await this.client.db(schema).collection(table).insertMany(docs);
        return { insertedCount: r.insertedCount };
    }
    async updateDocs(schema: string, table: string, filter: Record<string, any>, set: Record<string, any>): Promise<any> {
        await this.client.connect();
        const match = PushdownCompiler.toMongo({ filter }).filter;
        const r = await this.client.db(schema).collection(table).updateMany(match, { $set: set });
        return { matchedCount: r.matchedCount, modifiedCount: r.modifiedCount };
    }
    async deleteDocs(schema: string, table: string, filter: Record<string, any>): Promise<any> {
        await this.client.connect();
        const match = PushdownCompiler.toMongo({ filter }).filter;
        const r = await this.client.db(schema).collection(table).deleteMany(match);
        return { deletedCount: r.deletedCount };
    }

    async close() {
        await this.client.close();
    }
}

/**
 * SnowflakeConnector — queries Snowflake as a federated source with full pushdown
 * (filter/projection/sort/limit + GROUP BY aggregates via the shared SQL compiler).
 * The `snowflake-sdk` driver is lazy-required so the build never depends on it;
 * a clear error is thrown only if a Snowflake source is actually used without it.
 */
export class SnowflakeConnector implements IConnector {
    private config: any;
    private conn: any = null;
    constructor(config: any) { this.config = config; }

    private sdk(): any {
        try { return require('snowflake-sdk'); }
        catch { throw new Error("Snowflake support requires the 'snowflake-sdk' package. Run: npm i snowflake-sdk"); }
    }

    private async connect(): Promise<any> {
        if (this.conn) return this.conn;
        const snowflake = this.sdk();
        const c = this.config;
        const connection = snowflake.createConnection({
            account: c.account,
            username: c.user || c.username,
            password: c.pass || c.password,
            warehouse: c.warehouse,
            role: c.role,
            database: c.dbName || c.database,
            schema: c.schema,
        });
        await new Promise<void>((resolve, reject) => connection.connect((err: any) => (err ? reject(err) : resolve())));
        this.conn = connection;
        return connection;
    }

    private async exec(sqlText: string, binds: any[] = []): Promise<any[]> {
        const conn = await this.connect();
        return new Promise<any[]>((resolve, reject) => {
            conn.execute({ sqlText, binds, complete: (err: any, _stmt: any, rows: any[]) => (err ? reject(err) : resolve(rows || [])) });
        });
    }

    async discoverSchemas(): Promise<any[]> {
        const rows = await this.exec(`SELECT SCHEMA_NAME AS name FROM INFORMATION_SCHEMA.SCHEMATA`);
        return rows.map((r) => ({ name: r.NAME || r.name, physicalName: r.NAME || r.name }));
    }
    async discoverTables(schema: string): Promise<any[]> {
        const tables = await this.exec(
            `SELECT TABLE_NAME AS name, TABLE_TYPE AS type FROM INFORMATION_SCHEMA.TABLES WHERE TABLE_SCHEMA = ?`, [schema]);
        const out = tables.map((r) => {
            const name = r.NAME || r.name;
            const type = String(r.TYPE || r.type || 'BASE TABLE').toUpperCase();
            return { name, physicalName: name, rowCount: 0, resourceType: type.includes('VIEW') ? 'VIEW' : 'TABLE' };
        });
        const push = (rows: any[], rt: string) => rows.forEach((r) => { const n = r.NAME || r.name; out.push({ name: n, physicalName: n, rowCount: 0, resourceType: rt }); });
        try { push(await this.exec(`SELECT SEQUENCE_NAME AS name FROM INFORMATION_SCHEMA.SEQUENCES WHERE SEQUENCE_SCHEMA = ?`, [schema]), 'SEQUENCE'); } catch { /* optional */ }
        try { push(await this.exec(`SELECT FUNCTION_NAME AS name FROM INFORMATION_SCHEMA.FUNCTIONS WHERE FUNCTION_SCHEMA = ?`, [schema]), 'FUNCTION'); } catch { /* optional */ }
        return out;
    }

    async query(schema: string, table: string, config: any): Promise<any[]> {
        const compiled = PushdownCompiler.toSql({ ...toCanonical(config), schema, table, dialect: 'snowflake' });
        console.log(`[SnowflakeConnector] Pushdown SQL: ${compiled.text}`);
        return await this.exec(compiled.text, compiled.params);
    }

    async close(): Promise<void> {
        if (this.conn) await new Promise<void>((resolve) => this.conn.destroy(() => resolve()));
        this.conn = null;
    }
}

/**
 * ElasticsearchConnector — makes ES a READABLE federated source via _search:
 * predicate/sort/projection/size pushdown as query-DSL, and GROUP BY aggregates
 * as terms + metric sub-aggregations. (The write/sink worker is separate.)
 */
export class ElasticsearchConnector implements IConnector {
    private base: string;
    private auth?: { username: string; password: string };
    constructor(config: any) {
        const host = config.host || 'localhost';
        const port = config.port || 9200;
        this.base = (config.uri || config.url || config.connectionString || `http://${host}:${port}`).replace(/\/$/, '');
        const user = config.user || config.username;
        const pass = config.pass || config.password;
        if (user) this.auth = { username: String(user), password: String(pass || '') };
    }

    private async req(method: string, path: string, body?: any, contentType = 'application/json'): Promise<any> {
        const axios = require('axios');
        const res = await axios({ method, url: `${this.base}${path}`, data: body, auth: this.auth, headers: { 'Content-Type': contentType }, timeout: 30000 });
        return res.data;
    }

    async discoverSchemas(): Promise<any[]> {
        // ES has no schemas; expose a single logical namespace.
        return [{ name: 'default', physicalName: 'default' }];
    }
    async discoverTables(_schema: string): Promise<any[]> {
        const data = await this.req('GET', `/_cat/indices?format=json`);
        return (data || [])
            .filter((i: any) => !String(i.index).startsWith('.'))
            .map((i: any) => ({ name: i.index, physicalName: i.index, rowCount: Number(i['docs.count']) || 0, resourceType: 'TABLE' }));
    }

    /** Column metadata from the index mapping (field name + ES type). */
    async discoverColumns(_schema: string, table: string): Promise<any[]> {
        const data = await this.req('GET', `/${table}/_mapping`);
        // { <index>: { mappings: { properties: { field: { type, ... } } } } }
        const idx = Object.keys(data || {})[0];
        const props = (idx && data[idx]?.mappings?.properties) || {};
        return Object.keys(props).map((name) => ({
            name, type: props[name].type || (props[name].properties ? 'object' : 'unknown'),
            nullable: true, default: null, primaryKey: false,
        }));
    }

    private buildFilter(filter: Record<string, any> = {}): any[] {
        return ElasticsearchConnector.filterClauses(filter);
    }

    /** Faithful preview of the _search body the connector would send (for the execution trace). */
    static previewBody(canonical: any, index: string): string {
        const clauses = this.filterClauses(canonical.filter || {});
        const query = clauses.length ? { bool: { filter: clauses } } : { match_all: {} };
        if (canonical.aggregates && canonical.aggregates.length > 0) {
            const groupBy = canonical.groupBy || [];
            const buckets = groupBy.map((g: any) => (g && typeof g === 'object' && g.dateInterval)
                ? `date_histogram(${g.field}/${g.dateInterval})` : `terms(${g})`).join(' → ') || '(none)';
            return `POST /${index}/_search ${JSON.stringify({ size: 0, query, aggs: `${buckets} + [${canonical.aggregates.map((a: any) => a.func).join(',')}]` })}`;
        }
        const body: any = { query };
        if (canonical.select?.length && !canonical.select.includes('*')) body._source = canonical.select;
        if (typeof canonical.limit === 'number') body.size = canonical.limit;
        return `POST /${index}/_search ${JSON.stringify(body)}`;
    }

    static filterClauses(filter: Record<string, any> = {}): any[] {
        const clauses: any[] = [];
        for (const key of Object.keys(filter)) {
            const raw = filter[key];
            // A column may carry multiple operators (e.g. a range { $gte, $lte }).
            const rawKeys = raw && typeof raw === 'object' && !Array.isArray(raw) ? Object.keys(raw) : [];
            const ops = (rawKeys.length && rawKeys.every((k) => k.startsWith('$')))
                ? rawKeys.map((op) => ({ op, val: raw[op] }))
                : [{ op: '$eq', val: raw }];
            for (const { op, val } of ops) {
                switch (op) {
                    case '$eq': clauses.push({ term: { [key]: val } }); break;
                    case '$ne': clauses.push({ bool: { must_not: { term: { [key]: val } } } }); break;
                    case '$gt': clauses.push({ range: { [key]: { gt: val } } }); break;
                    case '$gte': clauses.push({ range: { [key]: { gte: val } } }); break;
                    case '$lt': clauses.push({ range: { [key]: { lt: val } } }); break;
                    case '$lte': clauses.push({ range: { [key]: { lte: val } } }); break;
                    case '$in': clauses.push({ terms: { [key]: val } }); break;
                    case '$like': case '$ilike':
                        clauses.push({ wildcard: { [key]: { value: String(val).replace(/%/g, '*').replace(/_/g, '?'), case_insensitive: op === '$ilike' } } });
                        break;
                    case '$match': // native full-text relevance search on an analyzed field
                        clauses.push({ match: { [key]: val } });
                        break;
                    case '$fuzzy': // fuzzy / entity-resolution match (Levenshtein, fuzziness=AUTO)
                        clauses.push({ match: { [key]: { query: val, fuzziness: 'AUTO' } } });
                        break;
                    default: clauses.push({ term: { [key]: val } });
                }
            }
        }
        return clauses;
    }

    /** Split canonical filter clauses into scoring (match/fuzzy → `must`) and non-scoring (`filter`). */
    static buildQuery(filter: Record<string, any> = {}): any {
        const all = ElasticsearchConnector.filterClauses(filter);
        const must = all.filter((c) => c.match || c.fuzzy);   // full-text / fuzzy → scored
        const filt = all.filter((c) => !(c.match || c.fuzzy)); // exact / range → non-scored
        if (!must.length && !filt.length) return { match_all: {} };
        return { bool: { ...(filt.length ? { filter: filt } : {}), ...(must.length ? { must } : {}) } };
    }

    /** One ES metric sub-agg for an aggregate spec (null for COUNT → use bucket doc_count). */
    private static metricAgg(a: any): any | null {
        const field = a.column;
        switch (a.func) {
            case 'COUNT': return null;
            case 'SUM': return { sum: { field } };
            case 'MIN': return { min: { field } };
            case 'MAX': return { max: { field } };
            case 'AVG': return { avg: { field } };
            case 'COUNT_DISTINCT': return { cardinality: { field } };
            case 'PERCENTILE': return { percentiles: { field, percents: [a.percent || 95] } };
            default: return null;
        }
    }

    async query(schema: string, table: string, config: any): Promise<any[]> {
        const canonical = toCanonical(config);
        const index = table;
        const query = ElasticsearchConnector.buildQuery(canonical.filter || {});

        // Aggregate / DISTINCT pushdown: (date_histogram | terms) buckets for group cols
        // + metric sub-aggs. Fires on aggregates OR grouping columns (GROUP BY-only = DISTINCT).
        if ((canonical.aggregates && canonical.aggregates.length > 0) || (canonical.groupBy && canonical.groupBy.length > 0)) {
            const groupBy: any[] = canonical.groupBy || [];
            const aggregates: any[] = canonical.aggregates || []; // may be empty for GROUP BY-only (DISTINCT)
            const metrics: Record<string, any> = {};
            for (const a of aggregates) {
                const m = ElasticsearchConnector.metricAgg(a);
                if (m) metrics[a.alias] = m;
            }
            const countAlias = aggregates.find((a: any) => a.func === 'COUNT')?.alias;
            // Nest bucket aggs from the group columns (string → terms; {field,dateInterval} → date_histogram).
            let aggs: any = metrics;
            for (let i = groupBy.length - 1; i >= 0; i--) {
                const g = groupBy[i];
                const bucket = (g && typeof g === 'object' && g.dateInterval)
                    ? { date_histogram: { field: g.field, calendar_interval: g.dateInterval } }
                    : { terms: { field: typeof g === 'object' ? g.field : g, size: 10000 } };
                aggs = { [`g_${i}`]: { ...bucket, aggs } };
            }
            const body = { size: 0, query, aggs: groupBy.length ? aggs : metrics };
            console.log(`[ElasticsearchConnector] Pushdown aggregate on ${index}: ${JSON.stringify(body)}`);
            const data = await this.req('POST', `/${index}/_search`, body);
            return this.flattenAggs(data.aggregations || {}, groupBy, aggregates, countAlias, 0, {});
        }

        const body: any = { query };
        if (canonical.select && canonical.select.length && !canonical.select.includes('*')) body._source = canonical.select;
        if (canonical.orderBy && canonical.orderBy.length) body.sort = canonical.orderBy.map((o) => ({ [o.field]: (o.dir === 'DESC' ? 'desc' : 'asc') }));
        // Elasticsearch rejects from+size beyond index.max_result_window (default 10000).
        const MAX_ES_WINDOW = 10000;
        const from = typeof canonical.offset === 'number' ? Math.max(0, canonical.offset) : 0;
        const want = typeof canonical.limit === 'number' ? canonical.limit : 1000;
        body.size = Math.max(0, Math.min(want, MAX_ES_WINDOW - from));
        if (from) body.from = from;
        console.log(`[ElasticsearchConnector] Pushdown search on ${index}: ${JSON.stringify(body)}`);
        const data = await this.req('POST', `/${index}/_search`, body);
        // Surface the relevance _score alongside the document source (0 when unscored).
        return (data.hits?.hits || []).map((h: any) => ({ _id: h._id, _score: h._score, ...h._source }));
    }

    /**
     * Native SQL against Elasticsearch's `_sql` endpoint (SQL mode). Lets
     * /api/queries/exec run SELECT/WHERE/GROUP BY/aggregate SQL directly on ES.
     * ES SQL is a read-only subset: no JOINs; full-text via MATCH()/QUERY().
     */
    async rawQuery(sql: string): Promise<any[]> {
        console.log(`[ElasticsearchConnector] _sql: ${String(sql).slice(0, 200)}`);
        const data = await this.req('POST', `/_sql?format=json`, { query: sql });
        const cols: string[] = (data.columns || []).map((c: any) => c.name);
        return (data.rows || []).map((r: any[]) => Object.fromEntries(cols.map((c, i) => [c, r[i]])));
    }

    // --- write support (used by the /api/data CRUD endpoints) ---
    async insertDocs(_schema: string, index: string, docs: any[]): Promise<any> {
        const lines: string[] = [];
        for (const d of docs) {
            const { _id, ...src } = d;
            lines.push(JSON.stringify(_id != null ? { index: { _index: index, _id: String(_id) } } : { index: { _index: index } }));
            lines.push(JSON.stringify(src));
        }
        const res = await this.req('POST', `/_bulk?refresh=true`, lines.join('\n') + '\n', 'application/x-ndjson');
        const items = res.items || [];
        return { insertedCount: items.filter((i: any) => i.index && i.index.status < 300).length };
    }
    async updateDocs(_schema: string, index: string, filter: Record<string, any>, set: Record<string, any>): Promise<any> {
        const src = Object.keys(set).map((k) => `ctx._source["${k}"] = params["${k}"]`).join('; ');
        const body = { query: ElasticsearchConnector.buildQuery(filter), script: { source: src, params: set } };
        const res = await this.req('POST', `/${index}/_update_by_query?refresh=true`, body);
        return { modifiedCount: res.updated || 0 };
    }
    async deleteDocs(_schema: string, index: string, filter: Record<string, any>): Promise<any> {
        const res = await this.req('POST', `/${index}/_delete_by_query?refresh=true`, { query: ElasticsearchConnector.buildQuery(filter) });
        return { deletedCount: res.deleted || 0 };
    }

    /** Recursively flatten nested (terms | date_histogram) buckets into flat rows. */
    private flattenAggs(node: any, groupBy: any[], aggregates: any[], countAlias: string | undefined, depth: number, carry: Record<string, any>): any[] {
        if (depth < groupBy.length) {
            const bucketAgg = node[`g_${depth}`];
            const out: any[] = [];
            const g = groupBy[depth];
            // For a date_histogram, key the output column by the field name and use the readable key.
            const gcol = (g && typeof g === 'object') ? g.field : g;
            for (const b of bucketAgg?.buckets || []) {
                const key = b.key_as_string !== undefined ? b.key_as_string : b.key;
                out.push(...this.flattenAggs(b, groupBy, aggregates, countAlias, depth + 1, { ...carry, [gcol]: key }));
            }
            return out;
        }
        // Leaf: emit one row with group carry + metric values.
        const row: any = { ...carry };
        for (const a of aggregates) {
            if (a.func === 'COUNT') row[a.alias] = node.doc_count;
            else if (a.func === 'PERCENTILE') { const v = node[a.alias]?.values || {}; row[a.alias] = v[Object.keys(v)[0] as string]; }
            else row[a.alias] = node[a.alias]?.value;
        }
        return [row];
    }

    async close(): Promise<void> { /* stateless HTTP */ }
}

export class ConnectorFactory {
    static getConnector(type: string, config: any): IConnector {
        switch (type.toUpperCase()) {
            case 'POSTGRES':
            case 'POSTGRESQL':
                return new PostgresConnector(config);
            case 'MYSQL':
                return new MySQLConnector(config);
            case 'MONGODB':
            case 'MONGO':
                return new MongoDBConnector(config);
            case 'SNOWFLAKE':
                return new SnowflakeConnector(config);
            case 'ELASTICSEARCH':
            case 'ELASTIC':
            case 'ES':
                return new ElasticsearchConnector(config);
            default:
                throw new Error(`Unsupported connector type: ${type}`);
        }
    }
}
