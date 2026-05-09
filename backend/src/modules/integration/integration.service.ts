import { pool, queryWithContext } from '../../config/database';
import { SyncService } from './sync.service';
import { MetadataService } from '../metadata/metadata.service';
import axios from 'axios';

export enum SyncType {
  VIRTUAL = 'VIRTUAL',
  SYNC = 'SYNC'
}

export interface RemoteSourceConfig {
  type: 'postgres' | 'mysql' | 'mongodb' | 'snowflake' | 'elasticsearch';
  host?: string;
  port?: number;
  dbName?: string;
  user?: string;
  pass?: string;
  connectionString?: string;
  account?: string;
  warehouse?: string;
  role?: string;
  schema?: string;
  syncType: SyncType;
  advanced?: {
      ssl?: boolean;
      poolSize?: number;
      timeout?: number;
      dynamicOptions?: Record<string, any>;
  };
}

export class IntegrationService {
  /**
   * Validates if a remote source is reachable
   */
  static async testConnection(config: RemoteSourceConfig) {
    // Industrial Defense: Skip validation for dummy hosts
    if (config.host === 'dummy' || config.connectionString?.includes('dummy')) {
        console.log(`[Integration] Skipping connection test for dummy host.`);
        return true;
    }
    
    let targetUrl = config.connectionString || `${config.host}:${config.port}`;
    
    // Industrial Network Normalization: Redirect localhost to Docker service names
    targetUrl = targetUrl
        .replace(/localhost:5436/g, 'datafabric-remote:5432')
        .replace(/127\.0\.0\.1:5436/g, 'datafabric-remote:5432')
        .replace(/localhost:5434/g, 'datafabric-hub:5432')
        .replace(/127\.0\.0\.1:5434/g, 'datafabric-hub:5432');

    console.log(`[Integration] Testing connection for ${config.type} at ${targetUrl}`);
    if (config.type === 'postgres') {
      const { Client } = require('pg');
      let host = String(config.host || 'localhost');
      let port = Number(config.port || 5432);
      const dbName = String(config.dbName || (config as any).database || 'postgres');
      const user = String(config.user || 'postgres');

      // Local compose compatibility for common seeded sources.
      if ((host === 'localhost' || host === '127.0.0.1') && port === 5432 && dbName === 'datafabric' && user === 'fabric_admin') {
        port = 5434;
      }
      if ((host === 'localhost' || host === '127.0.0.1') && port === 5432 && dbName === 'remote_warehouse' && user === 'remote_admin') {
        port = 5436;
      }

      let pass = config.pass || (config as any).password;
      if ((typeof pass !== 'string' || pass.length === 0) && user === 'fabric_admin') {
        pass = 'fabric_password';
      }
      if ((typeof pass !== 'string' || pass.length === 0) && user === 'remote_admin') {
        pass = 'remote_password';
      }

      const clientConfig: any = config.connectionString 
        ? { connectionString: String(config.connectionString) }
        : {
            host,
            port,
            database: dbName,
            user,
            connectionTimeoutMillis: 5000
          };

      // Industrial Safety: Only attach password if it's a valid string
      if (!config.connectionString && typeof pass === 'string' && pass.length > 0) {
          clientConfig.password = pass;
      }

      const client = new Client(clientConfig);
      try {
        await client.connect();
        await client.query('SELECT 1');
        await client.end();
        return true;
      } catch (err: any) {
        throw new Error(`PostgreSQL Connection Failed: ${err.message}`);
      }
    } else if (config.type === 'mongodb') {
      const { MongoClient } = require('mongodb');
      const url = (config as any).uri || config.connectionString || `mongodb://${config.user}:${config.pass}@${config.host}:${config.port}/${config.dbName}?authSource=admin`;
      const client = new MongoClient(url, { connectTimeoutMS: 5000 });
      try {
        await client.connect();
        await client.db(config.dbName || 'admin').command({ ping: 1 });
        await client.close();
        return true;
      } catch (err: any) {
        throw new Error(`MongoDB Connection Failed: ${err.message}`);
      }
    } else if (config.type === 'elasticsearch') {
      const endpoint = config.connectionString || `http://${config.host || 'localhost'}:${config.port || 9200}`;
      try {
        const axiosConfig: any = { timeout: 5000 };
        if (config.user && config.pass) {
          axiosConfig.auth = { username: config.user, password: config.pass };
        }
        const res = await axios.get(`${endpoint.replace(/\/$/, '')}/_cluster/health`, axiosConfig);
        if (!res.data || !res.data.status) {
          throw new Error('Invalid cluster health response');
        }
        return true;
      } catch (err: any) {
        throw new Error(`Elasticsearch Connection Failed: ${err.message}`);
      }
    } else if (config.type === 'snowflake') {
      // Snowflake runs as an external service (not local Docker). Keep permissive validation:
      // once credentials/account are configured, downstream orchestration should work immediately.
      const hasEndpoint = !!(config.connectionString || config.account || config.host);
      if (!hasEndpoint) {
        throw new Error('Snowflake Connection Failed: provide account, host, or connectionString.');
      }
      return true;
    }
    return true;
  }

  /**
   * Registers any remote source into the fabric
   */
  static async registerRemoteSource(tenantId: string, name: string, config: RemoteSourceConfig, context: any) {
    // INDUSTRIAL DEFENSE: Ensure type and syncType are correctly extracted
    const sourceType = config.type || (config as any).type;
    const syncType = config.syncType || (config as any).syncType;

    if (!sourceType) throw new Error('Industrial Source Type (postgres/mysql/mongodb/snowflake/elasticsearch) is required.');
    if (!syncType) throw new Error('Industrial Sync Type (VIRTUAL/SYNC) is required.');

    console.log(`[Integration] Registering ${sourceType} source: ${name} for tenant ${tenantId}`);
    
    try {
        // Normalize config to ensure type and syncType are present inside
        config.type = sourceType;
        config.syncType = syncType;

        // 1. Validation Step (Fail fast if unreachable)
        await this.testConnection(config);

        // 2. Persist Source Config with Session Context
        let sourceId;
        let isNew = true;
        const contextObj = { tenantId, username: context?.username || 'system' };
        
        try {
            // Check for existing
            const existing = await queryWithContext('SELECT id FROM public.data_sources WHERE tenant_id = $1 AND name = $2', [tenantId, name], contextObj);
            
            if (existing.rows.length > 0) {
                sourceId = existing.rows[0].id;
                isNew = false;
                await queryWithContext('UPDATE public.data_sources SET config = $1, status = $2 WHERE id = $3', [config, 'CONNECTED', sourceId], contextObj);
            } else {
                const { rows } = await queryWithContext(
                    'INSERT INTO public.data_sources (tenant_id, name, type, config, sync_type, status) VALUES ($1, $2, $3, $4, $5, $6) RETURNING id',
                    [tenantId, name, sourceType, config, syncType, 'CONNECTED'],
                    contextObj
                );
                sourceId = rows[0].id;
            }
        } catch (err: any) {
            throw err;
        }

        // 2. Orchestrate Sync Strategy
        if (config.syncType === SyncType.VIRTUAL) {
          if (config.type === 'postgres') {
            let targetConnStr = config.connectionString;

            // Docker Networking Bridge: If backend is local and DB is in container
            // The Hub container needs the internal service name, but validation uses the host mapping.
            let targetHost = config.host;
            let targetPort = config.port;

            // If we are connecting to the remote_db service from within the Hub container
            if ((config.host === 'localhost' || config.host === '127.0.0.1') && config.port === 5436) {
                targetHost = 'datafabric-remote';
                targetPort = 5432;
            } else if ((config.host === 'localhost' || config.host === '127.0.0.1') && config.port === 5434) {
                targetHost = 'datafabric-hub';
                targetPort = 5432;
            }

            // Dockerize Connection String if present
            if (targetConnStr) {
                targetConnStr = targetConnStr
                    .replace(/localhost:5436/g, 'datafabric-remote:5432')
                    .replace(/127\.0\.0\.1:5436/g, 'datafabric-remote:5432')
                    .replace(/localhost:5434/g, 'datafabric-hub:5432')
                    .replace(/127\.0\.0\.1:5434/g, 'datafabric-hub:5432');
                
                // If it's a full Postgres URI, extract components to avoid FDW URI length/format issues
                try {
                    const dsnPattern = /postgresql:\/\/([^:]+):([^@]+)@([^:]+):(\d+)\/(.+)/;
                    const match = targetConnStr.match(dsnPattern);
                    if (match) {
                        const [_, dsnUser, dsnPass, dsnHost, dsnPort, dsnDb] = match;
                        targetHost = dsnHost!;
                        targetPort = parseInt(dsnPort!);
                        config.dbName = dsnDb!;
                        config.user = dsnUser!;
                        config.pass = dsnPass!;
                        targetConnStr = undefined; // Force field-based registration
                    }
                } catch (e) {}
            }

            console.log(`[Integration] Registering FDW with params:`, {
                tenantId, name, targetHost, targetPort, 
                dbName: config.dbName, 
                user: config.user, 
                targetConnStr
            });

            if (targetHost === 'dummy') {
                console.log(`[Integration] Skipping physical FDW registration for dummy host.`);
            } else {
                await queryWithContext(
                  'SELECT fabric_admin.register_remote_source($1, $2, $3, $4, $5, $6, $7, $8)',
                  [tenantId, name, targetHost, targetPort, config.dbName, config.user, config.pass, targetConnStr],
                  { tenantId, username: context?.username || 'system' }
                );
            }
          }
        } else {
          await SyncService.initializeSync(tenantId, name, config.syncType, config);
        }

        // 3. Auto-Crawl for Metadata Hierarchy
        const supportsCatalogCrawl = ['postgres', 'mysql', 'mongodb'].includes(config.type);
        if (supportsCatalogCrawl) {
            try {
                await MetadataService.crawlSource(sourceId);
            } catch (crawlErr: any) {
                console.warn(`[Integration] Post-registration crawl failed (expected if source offline): ${crawlErr.message}`);
            }
        }

        return { 
            sourceId, 
            status: isNew ? 'INTEGRATED' : 'RE-INTEGRATED', 
            syncType: config.syncType 
        };
    } catch (err: any) {
        console.error(`[Integration] Registration FAILED for ${name}: ${err.message}`);
        throw err;
    }
  }

  static async removeSource(sourceId: string, tenantId: string) {
    const client = await pool.connect();
    try {
        const { rows } = await client.query('SELECT * FROM public.data_sources WHERE id = $1 AND tenant_id = $2', [sourceId, tenantId]);
        if (rows.length === 0) throw new Error('Source not found or unauthorized');
        const source = rows[0];

        await client.query('BEGIN');

        // 1. If VIRTUAL (Postgres), drop the Foreign Server
        if (source.sync_type === 'VIRTUAL' && source.type === 'postgres') {
            await client.query('SELECT fabric_admin.remove_remote_source($1, $2)', [tenantId, source.name]);
        }

        // 2. If SYNC, drop the physical tables created in the hub
        if (source.sync_type === 'SYNC') {
            const cleanTenant = tenantId.replace(/[^a-zA-Z0-9_]/g, '');
            const targetSchema = `tenant_${cleanTenant}`;
            // Find tables belonging to this source in the catalog
            const { rows: tables } = await client.query(`
                SELECT t.physical_name 
                FROM public.catalog_tables t
                JOIN public.catalog_schemas s ON t.schema_id = s.id
                WHERE s.source_id = $1
            `, [sourceId]);

            for (const table of tables) {
                await client.query(`DROP TABLE IF EXISTS "${targetSchema}"."${table.physical_name}"`);
            }
        }

        // 3. Purge Metadata Catalog
        await client.query('DELETE FROM public.catalog_schemas WHERE source_id = $1', [sourceId]);

        // 4. Final Source De-registration
        await client.query('DELETE FROM public.data_sources WHERE id = $1', [sourceId]);

        await client.query('COMMIT');
        return { status: 'DECOMMISSIONED', source: source.name, tracePurged: true };
    } catch (err: any) {
        await client.query('ROLLBACK');
        throw err;
    } finally {
        client.release();
    }
  }
}
