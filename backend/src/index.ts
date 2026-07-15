import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import http from 'http';
import swaggerUi from 'swagger-ui-express';
import { pool } from './config/database';
import { AuthService } from './modules/auth/auth.service';
import { swaggerSpec } from './config/swagger';

// Route Imports
import adminRoutes from './routes/adminRoutes';
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

import morgan from 'morgan';

const app = express();
const server = http.createServer(app);
const PORT = 4000;

app.use(cors({
  origin: '*',
  methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization', 'x-tenant-id']
}));
app.use(express.json());
app.use(morgan('dev'));

// --- INDUSTRIAL SECURITY MIDDLEWARE ---
app.use((req, res, next) => {
  const authHeader = req.headers.authorization;
  if (authHeader && typeof authHeader === 'string') {
    const token = authHeader.split(' ')[1];
    if (token) {
      try {
        const user = AuthService.verifyToken(token) as any;
        if (user) {
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
app.use('/api-docs', swaggerUi.serve, swaggerUi.setup(swaggerSpec, {
  customSiteTitle: 'Zero Data Fabric API',
  swaggerOptions: { docExpansion: 'none', filter: true, tryItOutEnabled: true },
}));
// Raw OpenAPI spec for tooling / client generation.
app.get('/api-docs.json', (_req, res) => { res.json(swaggerSpec); });

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

// --- RESOURCE ROUTERS ---
app.use('/api/auth', authRoutes);
app.use('/api/admin', requireAuth, adminRoutes);
app.use('/api/queries', requireAuth, licensingMiddleware, queryRoutes);
app.use('/api/metadata', requireAuth, licensingMiddleware, metadataRoutes);
app.use('/api/analytics', requireAuth, licensingMiddleware, analyticsRoutes);
app.use('/api/data', requireAuth, licensingMiddleware, dataRoutes);
app.use('/api/triggers', requireAuth, licensingMiddleware, triggerRoutes);
app.use('/api/policies', requireAuth, policyRoutes);
app.use('/api/constraints', requireAuth, constraintRoutes);
app.use('/api/grants', requireAuth, grantRoutes);
app.use('/api/saved-analytics', requireAuth, licensingMiddleware, savedAnalyticsRoutes);
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
