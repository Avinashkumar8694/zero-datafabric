import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import { pool, queryWithContext } from './config/database';
import { TenantService } from './modules/tenant/tenant.service';
import { IntegrationService } from './modules/integration/integration.service';
import { AuthService } from './modules/auth/auth.service';
import { MetadataService } from './modules/metadata/metadata.service';
import { EventService } from './modules/events/event.service';
import analyticsRoutes from './routes/analyticsRoutes';
import swaggerUi from 'swagger-ui-express';
import bcrypt from 'bcrypt';
import { swaggerSpec } from './config/swagger';
import http from 'http';

const app = express();
export { app };
const server = http.createServer(app);

app.use(cors({ origin: '*', methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'] }));
app.use(express.json());

// Industrial Grade Security Middleware
app.use((req, res, next) => {
  const authHeader = req.headers.authorization;
  if (authHeader && typeof authHeader === 'string') {
    const token = authHeader.split(' ')[1];
    if (token) {
      try {
        const user = AuthService.verifyToken(token) as any;
        if (user) {
          console.log(`[Security] Verified user: ${user.username}, Role: ${user.internal_role}`);
          const tenantOverride = req.headers['x-tenant-id'];
          if (user.internal_role === 'ADMIN' && tenantOverride && typeof tenantOverride === 'string') {
            user.tenant_id = tenantOverride;
          }
          (req as any).user = user;
        } else {
          console.warn(`[Security] Token verification failed for token: ${token.substring(0, 10)}...`);
        }
      } catch (e: any) {
        console.error(`[Security] JWT Error: ${e.message}`);
      }
    } else {
      console.warn(`[Security] No token found in Authorization header`);
    }
  }
  next();
});

const requireAdmin = (req: express.Request, res: express.Response, next: express.NextFunction) => {
  const user = (req as any).user;
  if (!user) return res.status(401).json({ error: 'Authentication required' });
  if (user.internal_role !== 'ADMIN') return res.status(403).json({ error: 'Access Denied: Administrator role required' });
  next();
};

const PORT = 4000;

app.use('/api-docs', swaggerUi.serve, swaggerUi.setup(swaggerSpec));

app.get('/api/health', async (req, res) => {
  const uptime = process.uptime();
  try {
    const start = Date.now();
    await pool.query('SELECT 1');
    const latency = Date.now() - start;
    res.json({
      status: 'HEALTHY',
      uptime: `${Math.floor(uptime / 3600)}h ${Math.floor((uptime % 3600) / 60)}m`,
      database: { latency: `${latency}ms`, pool: { total: pool.totalCount, idle: pool.idleCount, waiting: pool.waitingCount } }
    });
  } catch (err) {
    res.status(503).json({ status: 'UNHEALTHY', error: 'Database Unreachable' });
  }
});

app.post('/api/admin/tenants', requireAdmin, async (req, res) => {
  try {
    const { id, name } = req.body;
    const result = await TenantService.createTenant(id, name);
    res.status(201).json(result);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/admin/tenants', requireAdmin, async (req, res) => {
  try {
    const { rows } = await pool.query('SELECT * FROM public.tenants ORDER BY created_at DESC');
    res.json(rows);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

app.delete('/api/admin/tenants/:id', requireAdmin, async (req, res) => {
    try {
        const result = await TenantService.deleteTenant(req.params.id as string);
        res.json(result);
    } catch (err: any) {
        res.status(500).json({ error: err.message });
    }
});

app.get('/api/admin/audit-logs', requireAdmin, async (req, res) => {
  try {
    const { rows } = await pool.query('SELECT * FROM public.audit_logs ORDER BY changed_at DESC LIMIT 50');
    res.json(rows);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/admin/catalog', requireAdmin, async (req, res) => {
  try {
    const userContext = (req as any).user;
    const { rows } = await queryWithContext('SELECT * FROM public.metadata_catalog ORDER BY schema_name ASC', [], {
      tenantId: userContext.tenant_id,
      username: userContext.username || 'unknown'
    });
    res.json(rows);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/metadata/crawl', async (req, res) => {
    try {
        const user = (req as any).user;
        const tenantId = user?.internal_role === 'ADMIN' ? req.body.tenantId : user?.tenant_id;
        if (!tenantId) return res.status(400).json({ error: 'tenantId is required' });
        const { MetadataService } = require('./modules/metadata/metadata.service');
        const result = await MetadataService.crawlTenant(tenantId);
        res.json(result);
    } catch (err: any) {
        res.status(500).json({ error: err.message });
    }
});

// --- Metadata Orchestration ---
app.get('/api/metadata/template', (req, res) => {
    const { MetadataService } = require('./modules/metadata/metadata.service');
    res.json(MetadataService.getTemplate());
});

app.post('/api/metadata/diff', async (req, res) => {
    try {
        const user = (req as any).user;
        if (!user) return res.status(401).json({ error: 'Authentication required' });
        const { MetadataService } = require('./modules/metadata/metadata.service');
        const diff = await MetadataService.diffMetadata(user.tenant_id, req.body);
        res.json(diff);
    } catch (err: any) {
        res.status(500).json({ error: err.message });
    }
});

app.post('/api/metadata/migrate', async (req, res) => {
    try {
        const user = (req as any).user;
        if (!user) return res.status(401).json({ error: 'Authentication required' });
        const { migrationPlan } = req.body;
        const { MetadataService } = require('./modules/metadata/metadata.service');
        const results = await MetadataService.migrateMetadata(user.tenant_id, migrationPlan);
        res.json(results);
    } catch (err: any) {
        res.status(500).json({ error: err.message });
    }
});

app.post('/api/queries/exec', async (req, res) => {
  const user = (req as any).user;
  if (!user) return res.status(401).json({ error: 'Authentication required' });
  try {
    const { sql, params = [], async: isAsync } = req.body;
    const { QueryEngineService } = require('./modules/query-engine/query-engine.service');
    if (isAsync) {
        const jobId = QueryEngineService.executeAsyncRawSql(user.tenant_id, user.username || 'unknown', sql, params);
        return res.status(202).json({ queryId: jobId, status: 'ACCEPTED' });
    } else {
        const results = await QueryEngineService.executeRawSql(user.tenant_id, user.username || 'unknown', sql, params);
        return res.json({ results });
    }
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/queries/jobs/:id', async (req, res) => {
    try {
        const { QueryEngineService } = require('./modules/query-engine/query-engine.service');
        const job = QueryEngineService.getJobStatus(req.params.id as string);
        if (job.status === 'NOT_FOUND') return res.status(404).json(job);
        res.json(job);
    } catch (err: any) {
        res.status(500).json({ error: err.message });
    }
});

app.post('/api/admin/connections', requireAdmin, async (req, res) => {
  try {
    const user = (req as any).user;
    const { name, config } = req.body;
    const result = await IntegrationService.registerPostgresSource(user.tenant_id, name, config, { tenantId: user.tenant_id, username: user.username });
    res.status(201).json(result);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/admin/connections', requireAdmin, async (req, res) => {
  try {
    const user = (req as any).user;
    const result = await queryWithContext('SELECT * FROM public.data_sources', [], { tenantId: user.tenant_id, username: user.username });
    res.json(result.rows);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

app.delete('/api/admin/connections/:id', requireAdmin, async (req, res) => {
    try {
        const result = await IntegrationService.removeSource(req.params.id as string);
        res.json(result);
    } catch (err: any) {
        res.status(500).json({ error: err.message });
    }
});

app.get('/api/admin/users', requireAdmin, async (req, res) => {
    try {
        const { rows } = await pool.query('SELECT id, username, tenant_id, role, status FROM public.users');
        res.json(rows);
    } catch (err: any) {
        res.status(500).json({ error: err.message });
    }
});

/**
 * @swagger
 * /api/auth/login:
 *   post:
 *     summary: Authenticate user
 *     description: "Authorized: ANY. Validates management credentials and returns a secure JWT token for platform orchestration."
 *     tags: [Auth]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               username: { type: string, example: "admin" }
 *               password: { type: string, example: "admin" }
 *     responses:
 *       200:
 *         description: Login successful
 *       401:
 *         description: Invalid credentials
 */
app.post('/api/auth/login', async (req, res) => {
  const { username, password } = req.body;
  try {
    const result = await AuthService.login(username, password);
    if (result) return res.json(result);
    res.status(401).json({ error: 'Invalid credentials' });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/auth/token', (req, res) => {
  const user = (req as any).user; 
  if (!user) return res.status(401).json({ error: 'Authentication required' });
  const { tenantId } = req.body;
  const token = AuthService.generateToken(tenantId, user.role || 'fabric_user', user.username || 'unknown');
  res.json({ token });
});

// Modular Routes
app.use('/api/analytics', (req, res, next) => {
    if (!(req as any).user) return res.status(401).json({ error: 'Authentication required' });
    next();
}, analyticsRoutes);

app.get('/health', (req, res) => res.json({ status: 'UP' }));

if (process.env.NODE_ENV !== 'test') {
  (async () => {
    try {
      await pool.query('SELECT 1');
      server.listen(PORT, '0.0.0.0', () => {
        console.log(`Modular Data Fabric Orchestrator running on port ${PORT}`);
      });
    } catch (err: any) {
      console.error(`[FATAL] Database Connectivity Failed: ${err.message}`);
      process.exit(1);
    }
  })();
}
