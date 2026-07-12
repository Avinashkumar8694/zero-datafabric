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
     * @param commands For SQL engines: an array of SQL statement strings. For MongoDB: an array of op descriptors (`{ action, name/collection, keys?, options? }`).
     * @throws {Error} If no data source named `targetSourceName` is registered for the tenant, or if its engine `type` is not one of POSTGRES/MYSQL/MONGODB.
     */
    static async execute(tenantId: string, targetSourceName: string, commands: any[]): Promise<void> {
        console.log(`[Dispatcher] Dispatching ${commands.length} commands to source: ${targetSourceName}`);

        // 1. Get Source Configuration
        const { rows } = await pool.query('SELECT type, config FROM public.data_sources WHERE name = $1 AND tenant_id = $2', [targetSourceName, tenantId]);
        if (rows.length === 0) {
            throw new Error(`Industrial Dispatch Error: Source '${targetSourceName}' not found for tenant '${tenantId}'`);
        }

        const { type, config } = rows[0];

        if (type === 'POSTGRES') {
            await this.executePostgres(config, commands);
        } else if (type === 'MYSQL') {
            await this.executeMysql(config, commands);
        } else if (type === 'MONGODB') {
            await this.executeMongo(config, commands);
        } else {
            throw new Error(`Industrial Dispatch Error: Engine '${type}' not supported for direct orchestration yet.`);
        }
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
     * @param ops Op descriptors: `{ action: 'createCollection'|'dropCollection', name }` or `{ action: 'createIndex', collection, keys, options }`.
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
}
