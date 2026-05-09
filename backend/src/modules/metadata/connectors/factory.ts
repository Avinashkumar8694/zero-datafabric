import { Pool } from 'pg';
import * as mysql from 'mysql2/promise';
import { MongoClient } from 'mongodb';

export interface IConnector {
    discoverSchemas(): Promise<any[]>;
    discoverTables(schema: string): Promise<any[]>;
    query(schema: string, table: string, config: any): Promise<any[]>;
    close(): Promise<void>;
}

export class PostgresConnector implements IConnector {
    private pool: Pool;
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

    async discoverSchemas(): Promise<any[]> {
        const { rows } = await this.pool.query(`
            SELECT 
                schema_name as name,
                schema_name as "physicalName"
            FROM information_schema.schemata 
            WHERE schema_name NOT IN ('information_schema', 'pg_catalog')
        `);
        return rows;
    }

    async discoverTables(schema: string): Promise<any[]> {
        const { rows } = await this.pool.query(`
            SELECT 
                c.relname as name, 
                c.reltuples::bigint as "rowCount",
                c.relname as "physicalName"
            FROM pg_class c
            JOIN pg_namespace n ON n.oid = c.relnamespace
            WHERE n.nspname = $1 AND c.relkind = 'r'
        `, [schema]);
        return rows;
    }

    async query(schema: string, table: string, config: any): Promise<any[]> {
        // INDUSTRIAL RESILIENCE: Try specified schema, fallback to public if needed
        try {
            let sql = `SELECT * FROM "${schema}"."${table}"`;
            if (config.limit) sql += ` LIMIT ${config.limit}`;
            const { rows } = await this.pool.query(sql);
            return rows;
        } catch (err: any) {
            console.warn(`[PostgresConnector] Schema "${schema}" failed, falling back to public for table "${table}"`);
            try {
                let sql = `SELECT * FROM "public"."${table}"`;
                if (config.limit) sql += ` LIMIT ${config.limit}`;
                const { rows } = await this.pool.query(sql);
                return rows;
            } catch (innerErr: any) {
                console.error(`[PostgresConnector] Query failed on both "${schema}" and "public":`, innerErr.message);
                throw innerErr;
            }
        }
    }

    async close() {
        await this.pool.end();
    }
}

export class MySQLConnector implements IConnector {
    private connection: mysql.Connection | null = null;
    private config: any;

    constructor(config: any) {
        this.config = config;
    }

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

    async discoverSchemas(): Promise<any[]> {
        const conn = await this.connect();
        const [rows]: any = await conn.query('SHOW DATABASES');
        return rows.map((r: any) => ({ name: r.Database, physicalName: r.Database }));
    }

    async discoverTables(schema: string): Promise<any[]> {
        const conn = await this.connect();
        await conn.query(`USE \`${schema}\``);
        const [rows]: any = await conn.query('SHOW TABLES');
        return rows.map((r: any) => ({ 
            name: Object.values(r)[0], 
            physicalName: Object.values(r)[0],
            rowCount: 0 
        }));
    }

    async query(schema: string, table: string, config: any): Promise<any[]> {
        const conn = await this.connect();
        await conn.query(`USE \`${schema}\``);
        let sql = `SELECT * FROM \`${table}\``;
        if (config.limit) sql += ` LIMIT ${config.limit}`;
        const [rows]: any = await conn.query(sql);
        return rows;
    }

    async close() {
        if (this.connection) await this.connection.end();
    }
}

export class MongoDBConnector implements IConnector {
    private client: MongoClient;
    private config: any;

    constructor(config: any) {
        if (config.advanced?.dynamicOptions) {
            console.log(`[Connector] Applying dynamic options to Mongo:`, JSON.stringify(config.advanced.dynamicOptions));
        }
        const url = config.connectionString || config.url || `mongodb://${config.user}:${config.pass}@${config.host}:${config.port}`;
        this.client = new MongoClient(url);
    }

    async discoverSchemas(): Promise<any[]> {
        await this.client.connect();
        const dbs = await this.client.db().admin().listDatabases();
        return dbs.databases.map(db => ({ name: db.name, physicalName: db.name }));
    }

    async discoverTables(schema: string): Promise<any[]> {
        const db = this.client.db(schema);
        const collections = await db.listCollections().toArray();
        return collections.map(c => ({ 
            name: c.name, 
            physicalName: c.name,
            rowCount: 0 
        }));
    }

    async query(schema: string, table: string, config: any): Promise<any[]> {
        await this.client.connect();
        const db = this.client.db(schema);
        const collection = db.collection(table);
        
        // Map QueryConfig (SQL-like) to Mongo Find
        const filter = this.mapFilterToMongo(config.filter || {});
        let cursor = collection.find(filter);
        
        if (config.limit) cursor = cursor.limit(config.limit);
        if (config.offset) cursor = cursor.skip(config.offset);
        
        return await cursor.toArray();
    }

    private mapFilterToMongo(filter: any): any {
        const mongoFilter: any = {};
        for (const key of Object.keys(filter)) {
            const val = filter[key];
            if (typeof val === 'object' && val !== null) {
                // Handle operators $eq, $gt, $lt etc.
                const opStr = Object.keys(val)[0] || '$eq';
                const mOp = opStr.replace('$', '$'); 
                mongoFilter[key] = { [mOp]: (val as any)[opStr] };
            } else {
                mongoFilter[key] = val;
            }
        }
        return mongoFilter;
    }

    async close() {
        await this.client.close();
    }
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
            default:
                throw new Error(`Unsupported connector type: ${type}`);
        }
    }
}
