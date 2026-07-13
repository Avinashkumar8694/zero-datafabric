/**
 * Heterogeneous write dispatcher.
 * --------------------------------
 * Executes a batch of already-compiled provisioning commands (SQL strings for
 * relational engines, or op descriptors for Mongo) against a REMOTE data
 * source registered in `public.data_sources` — i.e. any target other than the
 * local Fabric Hub Postgres, which the orchestrator executes directly inside
 * its own transaction. Used by `MetadataOrchestrator.apply` for best-effort
 * (SAGA-style) remote provisioning: a failure here degrades that resource's
 * deploy status but does not roll back the Hub's local Postgres changes.
 */
import { Client } from 'pg';
import { MongoClient } from 'mongodb';
import { pool } from '../../config/database';

/**
 * Looks up a tenant's registered data source and dispatches a batch of
 * commands to the matching engine driver.
 * @class
 * @hideconstructor
 */
export class HeterogeneousDispatcher {
    /**
     * Dispatches a batch of provisioning commands to a tenant's registered
     * remote data source, opening a short-lived native connection for the
     * matching engine (Postgres, MySQL, or MongoDB) and closing it afterward.
     * @param tenantId Tenant scope used to resolve the data source.
     * @param targetSourceName Name of the data source, as registered in `public.data_sources`.
     * @param commands For SQL engines: an array of SQL statement strings. For MongoDB: an array of op descriptors (`(action, name/collection, keys?, options?)`). For Elasticsearch: an array of index op descriptors.
     * @throws {Error} If no data source named `targetSourceName` is registered for the tenant, or if its engine `type` is unsupported.
     */
    static async execute(tenantId: string, targetSourceName: string, commands: any[]): Promise<void> {
        console.log(`[Dispatcher] Dispatching ${commands.length} commands to source: ${targetSourceName}`);

        // 1. Get Source Configuration
        const { rows } = await pool.query('SELECT type, config FROM public.data_sources WHERE name = $1 AND tenant_id = $2', [targetSourceName, tenantId]);
        if (rows.length === 0) {
            throw new Error(`Industrial Dispatch Error: Source '${targetSourceName}' not found for tenant '${tenantId}'`);
        }

        const { type, config } = rows[0];
        const normalizedType = this.normalizeEngineType(type);

        switch (normalizedType) {
            case 'POSTGRES':       await this.executePostgres(config, commands); break;
            case 'MYSQL':          await this.executeMysql(config, commands); break;
            case 'MONGODB':        await this.executeMongo(config, commands); break;
            case 'ORACLE':         await this.executeOracle(config, commands); break;
            case 'SNOWFLAKE':      await this.executeSnowflake(config, commands); break;
            case 'ELASTICSEARCH':  await this.executeElasticsearch(config, commands); break;
            default:
                throw new Error(`Industrial Dispatch Error: Engine '${type}' not supported for direct orchestration.`);
        }
    }

    /**
     * Normalizes engine type strings, handling aliases used in data_sources table.
     */
    private static normalizeEngineType(type: string): string {
        const t = String(type).toUpperCase();
        if (t === 'POSTGRESQL') return 'POSTGRES';
        if (t === 'MONGO') return 'MONGODB';
        if (t === 'ELASTIC' || t === 'ES') return 'ELASTICSEARCH';
        if (t === 'ORACLEDB') return 'ORACLE';
        return t;
    }

    /**
     * Opens a short-lived MySQL connection and executes each SQL statement in
     * order, always closing the connection afterward.
     * @param config Data source connection config (`connectionString`, or `host`/`port`/`user`/`password|pass`/`database|dbName`).
     * @param sqls SQL statements to execute sequentially.
     * @throws Propagates any connection or query error from the MySQL driver.
     */
    private static async executeMysql(config: any, sqls: string[]) {
        const mysql = require('mysql2/promise');
        const conn = config.connectionString
            ? await mysql.createConnection(config.connectionString)
            : await mysql.createConnection({
                host: config.host, port: config.port, user: config.user,
                password: config.password || config.pass,
                database: config.database || config.dbName,
            });
        try {
            for (const sql of sqls) {
                console.log(`[Dispatcher:MySQL] Executing: ${sql}`);
                await conn.query(sql);
            }
        } finally {
            await conn.end();
        }
    }

    /**
     * Opens a short-lived `pg` client connection to a remote Postgres source
     * and executes each SQL statement in order. Applies local-dev password
     * fallbacks for known seeded users (`fabric_admin`/`remote_admin`) when a
     * source config omits its password.
     * @param config Data source connection config (`host`, `port`, `database`/`dbName`, `user`, `password`/`pass`).
     * @param sqls SQL statements to execute sequentially.
     * @throws Propagates any connection or query error from the `pg` driver.
     */
    private static async executePostgres(config: any, sqls: string[]) {
        // Docker Networking Bridge: If backend is local and DB is in container
        let targetHost = config.host;
        let targetPort = config.port;

        if ((config.host === 'localhost' || config.host === '127.0.0.1') && config.port === 5436) {
            // No-op for direct client if running on host, but if running in docker we'd need bridge.
            // Since backend is local, we use local host/port.
        }

        const clientConfig: any = {
            host: targetHost,
            port: targetPort,
            database: String(config.database || config.dbName || 'postgres'),
            user: String(config.user || 'postgres'),
            connectionTimeoutMillis: 5000
        };

        // Industrial Safety + Local Dev Resilience:
        // Some seeded source configs may omit password while docker-compose uses known defaults.
        let pass = config.password || config.pass;
        if ((typeof pass !== 'string' || pass.length === 0) && config.user === 'fabric_admin') {
            pass = 'fabric_password';
        }
        if ((typeof pass !== 'string' || pass.length === 0) && config.user === 'remote_admin') {
            pass = 'remote_password';
        }
        if (typeof pass === 'string' && pass.length > 0) {
            clientConfig.password = pass;
        }

        const client = new Client(clientConfig);

        try {
            await client.connect();
            for (const sql of sqls) {
                console.log(`[Dispatcher:Postgres] Executing: ${sql}`);
                await client.query(sql);
            }
        } finally {
            await client.end();
        }
    }

    /**
     * Opens a short-lived MongoDB client and executes each op descriptor in
     * order (`createCollection`, `dropCollection`, `createIndex`), tolerating
     * "already exists" / "already dropped" races so re-application stays
     * idempotent.
     * @param config Data source connection config (`uri`, or `user`/`pass`/`host`/`port`/`dbName`).
     * @param ops Op descriptors: `(action: 'createCollection'|'dropCollection', name)` or `(action: 'createIndex', collection, keys, options)`.
     * @throws Propagates any connection error, or a collection-creation error other than "NamespaceExists" (code 48).
     */
    private static async executeMongo(config: any, ops: any[]) {
        const url = config.uri || `mongodb://${config.user}:${config.pass}@${config.host}:${config.port}/${config.dbName}?authSource=admin`;
        const client = new MongoClient(url, { connectTimeoutMS: 5000 });

        try {
            await client.connect();
            const db = client.db(config.dbName || 'admin');
            for (const op of ops) {
                console.log(`[Dispatcher:Mongo] Executing: ${op.action} on ${op.name || op.collection}`);
                switch (op.action) {
                    case 'createCollection':
                        await db.createCollection(op.name).catch(e => {
                            if (e.code !== 48) throw e; // 48 is 'NamespaceExists'
                        });
                        break;
                    case 'dropCollection':
                        await db.collection(op.name).drop().catch(() => {}); // Ignore if not exists
                        break;
                    case 'createIndex':
                        await db.collection(op.collection).createIndex(op.keys, op.options);
                        break;
                }
            }
        } finally {
            await client.close();
        }
    }

    /**
     * Opens a short-lived Oracle connection and executes each SQL statement,
     * committing at the end and closing the connection.
     */
    private static async executeOracle(config: any, sqls: string[]) {
        const oracledb = require('oracledb');
        oracledb.outFormat = oracledb.OUT_FORMAT_OBJECT;
        const svc = config.serviceName || config.service || config.dbName || config.database || config.sid || 'FREEPDB1';
        const connectString = config.connectString || config.connectionString || `${config.host || 'localhost'}:${config.port || 1521}/${svc}`;
        const conn = await oracledb.getConnection({
            user: config.user || config.username,
            password: config.password || config.pass,
            connectString,
        });
        try {
            for (const sql of sqls) {
                console.log(`[Dispatcher:Oracle] Executing: ${sql}`);
                await conn.execute(sql);
            }
            await conn.commit();
        } finally {
            await conn.close();
        }
    }

    /**
     * Opens a short-lived Snowflake connection and executes each SQL statement,
     * destroying the connection at the end.
     */
    private static async executeSnowflake(config: any, sqls: string[]) {
        const snowflake = require('snowflake-sdk');
        const connection = snowflake.createConnection({
            account: config.account,
            username: config.user || config.username,
            password: config.password || config.pass,
            warehouse: config.warehouse,
            role: config.role,
            database: config.dbName || config.database,
            schema: config.schema,
        });
        await new Promise<void>((resolve, reject) => connection.connect((err: any) => (err ? reject(err) : resolve())));
        try {
            for (const sql of sqls) {
                console.log(`[Dispatcher:Snowflake] Executing: ${sql}`);
                await new Promise<void>((resolve, reject) => {
                    connection.execute({
                        sqlText: sql,
                        complete: (err: any) => (err ? reject(err) : resolve())
                    });
                });
            }
        } finally {
            await new Promise<void>((resolve) => connection.destroy(() => resolve()));
        }
    }

    /**
     * Uses axios to issue HTTP requests against the Elasticsearch REST API to
     * provision indices and index mappings.
     */
    private static async executeElasticsearch(config: any, ops: any[]) {
        const axios = require('axios');
        const host = config.host || 'localhost';
        const port = config.port || 9200;
        const base = (config.uri || config.url || config.connectionString || `http://${host}:${port}`).replace(/\/$/, '');
        const user = config.user || config.username;
        const pass = config.pass || config.password;
        const auth = user ? { username: String(user), password: String(pass || '') } : undefined;

        for (const op of ops) {
            console.log(`[Dispatcher:ES] Executing: ${op.action} on ${op.name}`);
            if (op.action === 'createIndex') {
                try {
                    await axios({
                        method: 'PUT',
                        url: `${base}/${op.name}`,
                        data: { mappings: op.mappings },
                        auth,
                        headers: { 'Content-Type': 'application/json' },
                        timeout: 10000
                    });
                } catch (e: any) {
                    if (e.response && e.response.status === 400 && e.response.data?.error?.type === 'resource_already_exists_exception') {
                        // Already exists: safe to tolerate for idempotency
                    } else {
                        throw e;
                    }
                }
            } else if (op.action === 'dropIndex' || op.action === 'dropCollection') {
                try {
                    await axios({
                        method: 'DELETE',
                        url: `${base}/${op.name}`,
                        auth,
                        timeout: 10000
                    });
                } catch (e: any) {
                    if (e.response && e.response.status === 404) {
                        // Not found: safe to ignore
                    } else {
                        throw e;
                    }
                }
            }
        }
    }
}
