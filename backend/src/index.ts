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

// Shared Global Events API
app.get('/api/events', requireAuth, metadataController.getEvents);

app.get('/health', (req, res) => res.json({ status: 'UP' }));

if (process.env.NODE_ENV !== 'test') {
  (async () => {
    try {
      await pool.query('SELECT 1');
      server.listen(PORT, '0.0.0.0', () => {
        console.log(`\x1b[32m✔ Industrial Data Fabric Orchestrator running on port ${PORT}\x1b[0m`);
        ElasticsearchMutationWorker.start();
        // eslint-disable-next-line @typescript-eslint/no-var-requires
        require('./modules/sync/physical_sync.service').PhysicalSync.startCdcPoller();
        require('./modules/sync/physical_sync.service').PhysicalSync.startSyncScheduler();
        require('./modules/replication/replication.service').ReplicationService.startScheduler();
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
