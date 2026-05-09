import { Client } from 'pg';
import { MongoClient } from 'mongodb';
import { pool } from '../../config/database';

export class HeterogeneousDispatcher {
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
        } else if (type === 'MONGODB') {
            await this.executeMongo(config, commands);
        } else {
            throw new Error(`Industrial Dispatch Error: Engine '${type}' not supported for direct orchestration yet.`);
        }
    }

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
