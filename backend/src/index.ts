import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import http from 'http';
import { mountApiDocs } from './docs/mountDocs';
import { pool } from './config/database';
import { AuthService } from './modules/auth/auth.service';

// Route Imports
import adminRoutes from './routes/adminRoutes';
import { astOnly } from './middleware/astOnly.middleware';
import workerRoutes from './routes/workerRoutes';
import systemRoutes from './routes/systemRoutes';
import workspaceRoutes from './routes/workspaceRoutes';
import { workspaceGuard } from './modules/tenancy/workspace.guard';
import developerTokenRoutes from './routes/developerTokenRoutes';
import { ApiTokenService, TokenError, requiredScope } from './modules/auth/api-token.service';
import authRoutes from './routes/authRoutes';
import queryRoutes from './routes/queryRoutes';
import metadataRoutes from './routes/metadataRoutes';
import analyticsRoutes from './routes/analyticsRoutes';
import triggerRoutes from './routes/triggerRoutes';
import policyRoutes from './routes/policyRoutes';
import constraintRoutes from './routes/constraintRoutes';
import grantRoutes from './routes/grantRoutes';
import savedAnalyticsRoutes from './routes/savedAnalyticsRoutes';
import queryLogRoutes from './routes/queryLogRoutes';
import replicationRoutes from './routes/replicationRoutes';
import dataRoutes from './routes/dataRoutes';
import developerDocsRoutes from './routes/developerDocsRoutes';
import planRoutes from './routes/planRoutes';
import subscriptionRoutes from './routes/subscriptionRoutes';
import tenantRoutes from './routes/tenantRoutes';
import settingsRoutes from './routes/settingsRoutes';
import * as metadataController from './controllers/metadataController';
import { ElasticsearchMutationWorker } from './modules/metadata/es_mutation_worker';
import { initCache } from './config/cache';
import { licensingMiddleware } from './middleware/licensing.middleware';
import { LicenseValidationService } from './utils/licensing';
import { MongoDBConnector, PostgresConnector } from './modules/metadata/connectors/factory';
import morgan from 'morgan';

const app = express();
const server = http.createServer(app);
const PORT = Number(process.env.PORT) || 4000;

app.use(cors({
  origin: '*',
  methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization', 'x-api-key', 'x-tenant-id', 'x-act-as-role', 'x-region', 'Accept']
}));
app.use(express.json());
app.use(morgan('dev'));

// --- INDUSTRIAL SECURITY MIDDLEWARE ---
app.use(async (req, res, next) => {
  const authHeader = req.headers.authorization;
  const apiKeyHeader = req.headers['x-api-key'];
  const bearer = typeof authHeader === 'string' ? authHeader.split(' ')[1] : undefined;
  const presentedApiToken = typeof apiKeyHeader === 'string' ? apiKeyHeader : (bearer && bearer.startsWith('dft_') ? bearer : undefined);

  // Developer API token (x-api-key or Bearer dft_...). Scoped, never ADMIN, never honours x-tenant-id / x-act-as-role.
  if (presentedApiToken) {
    try {
      const user = await ApiTokenService.authenticate(presentedApiToken);
      const scope = requiredScope(req.method, req.path, req.body);
      if (!scope) return res.status(403).json({ error: 'API tokens cannot access this endpoint', code: 'TOKEN_NOT_ALLOWED' });
      if (!user.scopes.includes(scope)) return res.status(403).json({ error: `API token is missing the required scope: ${scope}`, code: 'SCOPE_REQUIRED' });
      delete req.headers['x-act-as-role'];
      (req as any).user = user;
      return next();
    } catch (e: any) {
      if (e instanceof TokenError) return res.status(e.status).json({ error: e.message, code: e.code });
      return res.status(500).json({ error: 'Internal error', code: 'INTERNAL' });
    }
  }

  if (bearer) {
    try {
      const user = AuthService.verifyToken(bearer) as any;
      if (user) {
        user.original_tenant_id = user.tenant_id;
        const tenantOverride = req.headers['x-tenant-id'];
        if (user.internal_role === 'ADMIN' && tenantOverride && typeof tenantOverride === 'string') {
          user.tenant_id = tenantOverride;
        }
        (req as any).user = user;
        console.log(`[Security] Authenticated user: ${user.username}, Tenant: ${user.tenant_id}`);
      }
    } catch (e: any) {
      console.error(`[Security] JWT Error: ${e.message}`);
    }
  }
  next();
});

const requireAuth = (req: express.Request, res: express.Response, next: express.NextFunction) => {
    if (!(req as any).user) return res.status(401).json({ error: 'Authentication required' });
    next();
};

const requireAdmin = (req: express.Request, res: express.Response, next: express.NextFunction) => {
    const user = (req as any).user;
    if (!user) return res.status(401).json({ error: 'Authentication required' });
    if (user.internal_role !== 'ADMIN') return res.status(403).json({ error: 'Admin privileges required' });
    next();
};

// --- BASE ROUTES ---
// OpenAPI docs: /api-docs (landing), /api-docs/developer(.json), /api-docs/system(.json)
mountApiDocs(app);

app.get('/api/health', async (req, res) => {
  const uptime = process.uptime();
  try {
    const start = Date.now();
    await pool.query('SELECT 1');
    const latency = Date.now() - start;
    res.json({
      status: 'HEALTHY',
      uptime: `${Math.floor(uptime / 3600)}h ${Math.floor((uptime % 3600) / 60)}m`,
      database: { 
        latency: `${latency}ms`, 
        pool: { 
          total: pool.totalCount, 
          idle: pool.idleCount, 
          waiting: pool.waitingCount 
        } 
      }
    });
  } catch (err) {
    res.status(503).json({ status: 'UNHEALTHY', error: 'Database Unreachable' });
  }
});

app.get('/api/metrics', async (req, res) => {
  const uptime = process.uptime();
  const mem = process.memoryUsage();
  
  let citusActive = 0;
  let activeWorkers = 0;
  try {
    const citusCheck = await pool.query(`SELECT 1 FROM pg_extension WHERE extname = 'citus'`);
    if (citusCheck.rows.length > 0) citusActive = 1;
    const workersCheck = await pool.query(`SELECT count(*)::int as cnt FROM public.fabric_worker_nodes WHERE status = 'ACTIVE'`).catch(() => ({ rows: [{ cnt: 0 }] }));
    activeWorkers = workersCheck.rows[0]?.cnt || 0;
  } catch {}

  const mongoPoolStats = MongoDBConnector.getPoolStats();
  const remotePgStats = PostgresConnector.getPoolStats();

  if (req.query.format === 'json' || req.headers.accept?.includes('application/json')) {
    return res.json({
      uptime_seconds: uptime,
      memory: {
        heap_used_bytes: mem.heapUsed,
        heap_total_bytes: mem.heapTotal,
        rss_bytes: mem.rss,
        external_bytes: mem.external
      },
      postgres_hub: {
        total: pool.totalCount,
        idle: pool.idleCount,
        waiting: pool.waitingCount
      },
      remote_postgres: remotePgStats,
      mongodb: mongoPoolStats,
      citus: {
        active: citusActive === 1,
        active_workers: activeWorkers
      }
    });
  }

  // Prometheus text exposition format (version 0.0.4)
  const metrics = [
    '# HELP datafabric_up Whether the Data Fabric server is up and accepting connections',
    '# TYPE datafabric_up gauge',
    'datafabric_up 1',
    '',
    '# HELP datafabric_uptime_seconds Number of seconds the process has been running',
    '# TYPE datafabric_uptime_seconds counter',
    `datafabric_uptime_seconds ${uptime.toFixed(2)}`,
    '',
    '# HELP datafabric_process_memory_heap_used_bytes Heap memory in use by V8 engine',
    '# TYPE datafabric_process_memory_heap_used_bytes gauge',
    `datafabric_process_memory_heap_used_bytes ${mem.heapUsed}`,
    '',
    '# HELP datafabric_process_memory_heap_total_bytes Total allocated heap memory by V8 engine',
    '# TYPE datafabric_process_memory_heap_total_bytes gauge',
    `datafabric_process_memory_heap_total_bytes ${mem.heapTotal}`,
    '',
    '# HELP datafabric_process_memory_rss_bytes Resident Set Size memory',
    '# TYPE datafabric_process_memory_rss_bytes gauge',
    `datafabric_process_memory_rss_bytes ${mem.rss}`,
    '',
    '# HELP datafabric_postgres_hub_pool_total Total connections in Hub PostgreSQL pool',
    '# TYPE datafabric_postgres_hub_pool_total gauge',
    `datafabric_postgres_hub_pool_total ${pool.totalCount}`,
    '',
    '# HELP datafabric_postgres_hub_pool_idle Idle connections in Hub PostgreSQL pool',
    '# TYPE datafabric_postgres_hub_pool_idle gauge',
    `datafabric_postgres_hub_pool_idle ${pool.idleCount}`,
    '',
    '# HELP datafabric_postgres_hub_pool_waiting Waiting requests in Hub PostgreSQL pool',
    '# TYPE datafabric_postgres_hub_pool_waiting gauge',
    `datafabric_postgres_hub_pool_waiting ${pool.waitingCount}`,
    '',
    '# HELP datafabric_postgres_remote_pools_count Number of cached remote PostgreSQL pools',
    '# TYPE datafabric_postgres_remote_pools_count gauge',
    `datafabric_postgres_remote_pools_count ${remotePgStats.poolCount}`,
    '',
    '# HELP datafabric_postgres_remote_pool_total Total connections in remote PostgreSQL pools',
    '# TYPE datafabric_postgres_remote_pool_total gauge',
    `datafabric_postgres_remote_pool_total ${remotePgStats.totalCount}`,
    '',
    '# HELP datafabric_mongodb_pools_count Number of cached MongoDB connection clients',
    '# TYPE datafabric_mongodb_pools_count gauge',
    `datafabric_mongodb_pools_count ${mongoPoolStats.poolCount}`,
    '',
    '# HELP datafabric_citus_coordinator_active Whether Citus coordinator extension is active',
    '# TYPE datafabric_citus_coordinator_active gauge',
    `datafabric_citus_coordinator_active ${citusActive}`,
    '',
    '# HELP datafabric_citus_active_workers Number of active distributed Citus worker nodes registered',
    '# TYPE datafabric_citus_active_workers gauge',
    `datafabric_citus_active_workers ${activeWorkers}`,
    ''
  ].join('\n');

  res.setHeader('Content-Type', 'text/plain; version=0.0.4; charset=utf-8');
  res.send(metrics);
});

// --- RESOURCE ROUTERS ---
app.use('/api', workspaceGuard);
app.use('/api/auth', authRoutes);
app.use('/api/system', requireAuth, systemRoutes);
app.use('/api/workspace', requireAuth, workspaceRoutes);
app.use('/api/admin/workers', requireAuth, workerRoutes);
app.use('/api/admin', requireAuth, adminRoutes);
app.use('/api/developer/tokens', requireAuth, developerTokenRoutes);
app.use('/api/queries', requireAuth, astOnly, licensingMiddleware, queryRoutes);
app.use('/api/metadata', requireAuth, licensingMiddleware, metadataRoutes);
app.use('/api/analytics', requireAuth, astOnly, licensingMiddleware, analyticsRoutes);
app.use('/api/data', requireAuth, astOnly, licensingMiddleware, dataRoutes);
app.use('/api/triggers', requireAuth, licensingMiddleware, triggerRoutes);
app.use('/api/policies', requireAuth, policyRoutes);
app.use('/api/constraints', requireAuth, constraintRoutes);
app.use('/api/grants', requireAuth, grantRoutes);
app.use('/api/saved-analytics', requireAuth, astOnly, licensingMiddleware, savedAnalyticsRoutes);
app.use('/api/query-logs', requireAuth, queryLogRoutes);
app.use('/api/replication', requireAuth, licensingMiddleware, replicationRoutes);
app.use('/api/developer-docs', developerDocsRoutes);
app.use('/api/plans', planRoutes);
app.use('/api/subscriptions', subscriptionRoutes);
app.use('/api/tenants', requireAuth, tenantRoutes);
app.use('/api/settings', settingsRoutes);

// Shared Global Events API
app.get('/api/events', requireAuth, metadataController.getEvents);

app.get('/health', (req, res) => res.json({ status: 'UP' }));

if (process.env.NODE_ENV !== 'test') {
  (async () => {
    try {
      await pool.query('SELECT 1');
      
      // Ensure database columns exist for timezone and cleanup support
      await pool.query('ALTER TABLE public.users ADD COLUMN IF NOT EXISTS timezone VARCHAR(100)');
      await pool.query('ALTER TABLE public.subscriptions ADD COLUMN IF NOT EXISTS last_cleanup_at TIMESTAMP');

      // Ensure global settings table and default custom login configurations exist
      await pool.query(`
        CREATE TABLE IF NOT EXISTS public.settings (
          key VARCHAR(100) PRIMARY KEY,
          value JSONB
        )
      `);
      await pool.query(`
        INSERT INTO public.settings (key, value)
        VALUES ('custom_login', '{
          "title": "Data Fabric",
          "logo_url": "",
          "bg_color": "#04060f",
          "allow_password_login": true,
          "sso_enabled": true,
          "oidc_issuer": "https://ids.fabrixly.com",
          "oidc_client_id": "zero-datafabric",
          "oidc_client_secret": "super-secret-key-fabric"
        }'::jsonb)
        ON CONFLICT (key) DO NOTHING
      `);
      await pool.query(`
        INSERT INTO public.settings (key, value)
        VALUES ('license_key', '{
          "license_key": "eyJhbGciOiJSUzI1NiIsInR5cCI6IkpXVCJ9.eyJsaWNlbnNlZSI6Ik9yZ2FuaXphdGlvbiBBIiwibmFtZSI6IkIyQi1GYWJyaXhseS1JRFMiLCJpc3N1ZWRBdCI6IjIwMjYtMDctMTJUMDk6NDA6MDAuMDAwWiIsImV4cGlyZXNBdCI6IjIwMzEtMTItMTJUMDk6NDA6MDAuMDAwWiIsInNlbGZIb3N0ZWQiOnRydWUsInByb2R1Y3QiOiJpZGVudGl0eS1zZXJ2ZXIiLCJsaW1pdHMiOnsibWF1Ijo1MDAsIm1heF9vcmdhbml6YXRpb25zIjo1LCJtYXhfY2xpZW50cyI6MjAsIm1heF9yb2xlcyI6NTAsImRhdGFfcmV0ZW50aW9uX2RheXMiOjcsIm0ybV90b2tlbl9saW1pdCI6MjAwMH0sImZlYXR1cmVzIjp7InBhc3N3b3JkbGVzc19lbmFibGVkIjp0cnVlLCJtYWdpY19saW5rX2VuYWJsZWQiOnRydWUsIm9tb2JpbGVfYXV0aF9lbmFibGVkIjp0cnVlLCJzb2NpYWxfbG9naW4vZW5hYmxlZCI6dHJ1ZSwic29jaWFsX2xvZ2luIjp0cnVlLCJlbnRlcnByaXNlX3Nzb19lbmFibGVkIjp0cnVlLCJjdXN0b21fZG9tYWluX2VuYWJsZWQiOnRydWUsInJlbW92ZV9icmFuZGluZyI6dHJ1ZSwiY3VzdG9tX2JyYW5kaW5nIjp0cnVlLCJjdXN0b21fZW1haWxfdGVtcGxhdGVzIjp0cnVlLCJhZHZhbmNlZF9jc3MiOnRydWUsIm1mYV9lbmFibGVkIjp0cnVlLCJtZmFfZW5mb3JjZWQiOnRydWUsImF1ZGl0X2xvZ3NfZW5hYmxlZCI6dHJ1ZSwibTJtX2VuYWJsZWQiOnRydWUsImNhbGxiYWNrX3ZhbGlkYXRpb25fZW5hYmxlZCI6dHJ1ZSwiYWxsb3dlZF9zb2NpYWxfcHJvdmlkZXJzIjpbIioiLCJnb29nbGUiLCJnaXRodWIiLCJmYWNlYm9vayIsIm1pY3Jvc29mdCIsImFwcGxlIiwia2V5Y2xvYWsiXSwiYWxsb3dlZF9tZmFfbWV0aG9kcyI6WyIqIiwidG90cCIsInBhc3NrZXkiLCJzbXMtb3RwIiwiZW1haWwtb3RwIiwiYmFja3VwLWNvZGUiXX0sIm1heF9pbnN0YWxsYXRpb25zIjoxLCJ2YWxpZGF0aW9uX3VybCI6Imh0dHA6Ly9sb2NhbGhvc3Q6MzAwNS9hcGkvbGljZW5zZXMvdmFsaWRhdGUiLCJpYXQiOjE3ODM4NDkzNjR9.X4O_dVbnVJmAHW2vvcs7VEX9pkASVoIbGScI_umtdYUljyeLt18IlSzaqyqjGWhNBqw7cc7fmRa_3blg4EV3ttn9ZPcISPPUDpHInPOY8tkQF8hjrEg9WaO95gmBtkhdRbPNGeORgrj0Ptynx_HhlWaIWrpbVD95FhQDlPL8nQE5DZPrTTzcluBxDhEOe5RcT6tlkSbZzJuwXoedDxj2iVVzxu3hp7OnFc7r-2qrlBXjx9TIXdtUB8khem61y2p7Z3A_ys96Gxnn35d8j90Ns70C1iu1avalUNGNYiZH1mI3j7BrV_kDsWsikW5g8z9dOqm7sD4hXbqHJHo5yxFdJQ\"\n        }'::jsonb)\n        ON CONFLICT (key) DO NOTHING\n      `);

      // Ensure instance_id exists in settings (stable across restarts)
      const settingsRow = await pool.query(`
        INSERT INTO public.settings (key, value)
        VALUES ('instance_id', to_jsonb(gen_random_uuid()::text))
        ON CONFLICT (key) DO NOTHING
        RETURNING value
      `);
      const instanceIdRow = await pool.query(
        "SELECT value FROM public.settings WHERE key = 'instance_id'"
      );
      const instanceId: string = instanceIdRow.rows[0]?.value?.replace ? instanceIdRow.rows[0].value.replace(/"/g, '') : instanceIdRow.rows[0]?.value || require('crypto').randomUUID();


      // ── Start License Validation Daemon BEFORE opening server port (mirrors IDS) ──
      // Runs first tick immediately (awaited), then every 24 hours via setInterval.
      const licenseValidationService = new LicenseValidationService();
      await licenseValidationService.start(
        instanceId,
        // getLicenseKey: ENV takes priority, then settings table
        async () => {
          if (process.env.LICENSE_KEY) return process.env.LICENSE_KEY;
          const r = await pool.query("SELECT value FROM public.settings WHERE key = 'license_key'");
          return r.rows[0]?.value?.license_key || '';
        },
        // onStatusChange: persist validation state to DB after every tick (mirrors IDS SystemSettings)
        async (status, errorMessage, lastSuccessAt) => {
          try {
            await pool.query(
              `INSERT INTO public.settings (key, value)
               VALUES ('license_validation', jsonb_build_object(
                 'status', $1::text,
                 'error_message', $2::text,
                 'last_successful_validation_at', $3::text,
                 'updated_at', now()::text
               ))
               ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`,
              [status, errorMessage ?? null, lastSuccessAt?.toISOString() ?? null]
            );
          } catch (e) {
            // Non-fatal — don't crash if DB write fails
          }
        }
      );

      server.listen(PORT, '0.0.0.0', () => {
        console.log(`\x1b[32m✔ Industrial Data Fabric Orchestrator running on port ${PORT}\x1b[0m`);
        ElasticsearchMutationWorker.start();
        // eslint-disable-next-line @typescript-eslint/no-var-requires
        require('./modules/sync/physical_sync.service').PhysicalSync.startCdcPoller();
        require('./modules/sync/physical_sync.service').PhysicalSync.startSyncScheduler();
        require('./modules/replication/replication.service').ReplicationService.startScheduler();
        // Start timezone-aware hourly data cleanup scheduler
        require('./services/cleanup.service').CleanupService.startCleanupScheduler();

        // Embedded copy-job worker. Set REPLICATION_ENGINE_EXTERNAL=true to disable
        // it and run the dedicated `npm run start:replication-engine` microservice instead.
        if (process.env.REPLICATION_ENGINE_EXTERNAL !== 'true') {
          require('./modules/jobs/copy_job_engine').CopyJobEngine.startWorker();
          // Kafka CDC→ES consumers (no-op unless FABRIC_CDC_VIA_KAFKA=true).
          require('./modules/replication/replication.service').ReplicationService.startCdcConsumers().catch(() => {});
        }
        initCache();
      });
    } catch (err: any) {
      console.error(`\x1b[31m[FATAL] Database Connectivity Failed: ${err.message}\x1b[0m`);
      process.exit(1);
    }
  })();
}

export { app };
