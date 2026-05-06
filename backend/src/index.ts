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
// EventService.init(server);

app.use(cors({ origin: '*', methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'] }));
app.use(express.json());

// Industrial Grade Security Middleware
app.use((req, res, next) => {
  const authHeader = req.headers.authorization;
  if (authHeader && typeof authHeader === 'string') {
    const token = authHeader.split(' ')[1];
    if (token) {
      try {
        const user = AuthService.verifyToken(token);
        if (user) {
          console.log(`[Security] Valid Token for: ${(user as any).username}`);
          (req as any).user = user;
        } else {
          console.warn(`[Security] Token verification failed for token: ${token.substring(0, 10)}...`);
        }
      } catch (e: any) {
        console.error(`[Security] JWT Error: ${e.message}`);
      }
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

// Swagger Documentation
app.use('/api-docs', swaggerUi.serve, swaggerUi.setup(swaggerSpec));

/**
 * @swagger
 * components:
 *   schemas:
 *     Tenant:
 *       type: object
 *       properties:
 *         id: { type: string, example: "tenant_A" }
 *         name: { type: string, example: "Acme Corp" }
 *         status: { type: string, example: "ACTIVE" }
 *     DataSource:
 *       type: object
 *       properties:
 *         id: { type: string }
 *         name: { type: string, example: "Inventory_DB" }
 *         type: { type: string, example: "postgres" }
 *         config:
 *           type: object
 *           properties:
 *             host: { type: string }
 *             port: { type: number }
 *             dbName: { type: string }
 *     AuditLog:
 *       type: object
 *       properties:
 *         id: { type: string }
 *         tenant_id: { type: string }
 *         user_name: { type: string }
 *         action: { type: string, enum: [INSERT, UPDATE, DELETE] }
 *         table_name: { type: string }
 *         new_data: { type: object }
 */

// Industrial Grade Modular Routes
app.use('/api/analytics', (req, res, next) => {
    if (!(req as any).user) return res.status(401).json({ error: 'Authentication required for analytics' });
    next();
}, analyticsRoutes);

/**
 * @swagger
 * /api/admin/tenants:
 *   post:
 *     summary: Provision a new isolated tenant
 *     tags: [Tenants]
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [id, name]
 *             properties:
 *               id: { type: string, example: "acme_corp" }
 *               name: { type: string, example: "Acme Corporation" }
 *     responses:
 *       201:
 *         description: Tenant successfully provisioned
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Tenant'
 *       401:
 *         description: Unauthorized
 */
app.post('/api/admin/tenants', requireAdmin, async (req, res) => {
  try {
    const { id, name } = req.body;
    const result = await TenantService.createTenant(id, name);
    res.status(201).json(result);
  } catch (err: any) {
    console.error(`[API Error] ${req.method} ${req.url}: ${err.message}`);
    res.status(500).json({ error: err.message });
  }
});

app.put('/api/admin/tenants/:id', requireAdmin, async (req, res) => {
  const { id } = req.params;
  const { name, status } = req.body;
  try {
    await pool.query('UPDATE public.tenants SET name = $1, status = $2 WHERE id = $3', [name, status, id]);
    res.json({ status: 'UPDATED' });
  } catch (err: any) {
    console.error(`[API Error] ${req.method} ${req.url}: ${err.message}`);
    res.status(500).json({ error: err.message });
  }
});

/**
 * @swagger
 * /api/admin/users:
 *   get:
 *     summary: List all users (Admin only)
 *     tags: [Auth]
 *     security: [{ bearerAuth: [] }]
 *     responses:
 *       200:
 *         description: List of users
 */
app.get('/api/admin/tenants', requireAdmin, async (req, res) => {
  try {
    const { rows } = await pool.query('SELECT * FROM public.tenants ORDER BY created_at DESC');
    res.setHeader('Cache-Control', 'no-store');
    res.json(rows);
  } catch (err: any) {
    console.error(`[API Error] ${req.method} ${req.url}: ${err.message}`);
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/admin/audit-logs', requireAdmin, async (req, res) => {
  try {
    const { rows } = await pool.query('SELECT * FROM public.audit_logs ORDER BY changed_at DESC LIMIT 50');
    res.setHeader('Cache-Control', 'no-store');
    res.json(rows);
  } catch (err: any) {
    console.error(`[API Error] ${req.method} ${req.url}: ${err.message}`);
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/admin/catalog', requireAdmin, async (req, res) => {
  try {
    const { rows } = await pool.query('SELECT * FROM public.metadata_catalog ORDER BY schema_name ASC');
    res.setHeader('Cache-Control', 'no-store');
    res.json(rows);
  } catch (err: any) {
    console.error(`[API Error] ${req.method} ${req.url}: ${err.message}`);
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/admin/users', requireAdmin, async (req, res) => {
  try {
    const { rows } = await pool.query('SELECT id, username, tenant_id, role, status FROM public.users');
    res.setHeader('Cache-Control', 'no-store');
    res.json(rows);
  } catch (err: any) {
    console.error(`[API Error] ${req.method} ${req.url}: ${err.message}`);
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/admin/users', requireAdmin, async (req, res) => {
  const { username, password, tenantId, role } = req.body;
  try {
    const passwordHash = await bcrypt.hash(password, 10);
    const { rows } = await pool.query(
      'INSERT INTO public.users (username, password_hash, tenant_id, role) VALUES ($1, $2, $3, $4) RETURNING id, username',
      [username, passwordHash, tenantId, role || 'USER']
    );
    res.status(201).json(rows[0]);
  } catch (err: any) {
    console.error(`[API Error] ${req.method} ${req.url}: ${err.message}`);
    res.status(500).json({ error: err.message });
  }
});

app.put('/api/admin/users/:id', requireAdmin, async (req, res) => {
  const { id } = req.params;
  const { username, password, tenantId, role } = req.body;
  try {
    let query = 'UPDATE public.users SET username = $1, tenant_id = $2, role = $3';
    let params: any[] = [username, tenantId, role];
    
    if (password) {
      const passwordHash = await bcrypt.hash(password, 10);
      query += ', password_hash = $4 WHERE id = $5';
      params.push(passwordHash, id);
    } else {
      query += ' WHERE id = $4';
      params.push(id);
    }
    
    await pool.query(query, params);
    res.json({ status: 'UPDATED' });
  } catch (err: any) {
    console.error(`[API Error] ${req.method} ${req.url}: ${err.message}`);
    res.status(500).json({ error: err.message });
  }
});

/**
 * @swagger
 * /api/admin/users/{id}:
 *   delete:
 *     summary: Delete a user
 *     tags: [Auth]
 *     security: [{ bearerAuth: [] }]
 */
app.delete('/api/admin/users/:id', async (req, res) => {
  const userContext = (req as any).user;
  if (!userContext || userContext.internal_role !== 'ADMIN') {
    return res.status(403).json({ error: 'Access Denied: Administrator role required' });
  }

  const { id } = req.params;
  try {
    await pool.query('DELETE FROM public.users WHERE id = $1', [id]);
    res.json({ status: 'DELETED' });
  } catch (err: any) {
    console.error(`[API Error] ${req.method} ${req.url}: ${err.message}`);
    res.status(500).json({ error: err.message });
  }
});

/**
 * @swagger
 * /api/auth/login:
 *   post:
 *     summary: Authenticate and get a management token
 *     tags: [Auth]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [username, password]
 *             properties:
 *               username: { type: string, example: "admin" }
 *               password: { type: string, example: "admin" }
 *     responses:
 *       200:
 *         description: Authentication successful
 */
app.post('/api/auth/login', async (req, res) => {
  const { username, password } = req.body;
  
  try {
    const result = await AuthService.login(username, password);
    if (result) {
      return res.json(result);
    }
    res.status(401).json({ error: 'Invalid credentials' });
  } catch (err: any) {
    console.error(`[API Error] ${req.method} ${req.url}: ${err.message}`);
    res.status(500).json({ error: err.message });
  }
});

/**
 * @swagger
 * /api/auth/token:
 *   post:
 *     summary: Generate an identity-aware JWT token
 *     tags: [Auth]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [tenantId]
 *             properties:
 *               tenantId: { type: string, example: "tenant_A" }
 *     responses:
 *       200:
 *         description: JWT Token generated
 */
app.post('/api/auth/token', (req, res) => {
  const user = (req as any).user; 
  if (!user) return res.status(401).json({ error: 'Authentication required to generate/switch tokens' });

  const { tenantId } = req.body;
  
  // If no user context, we still allow but with defaults (or we can reject)
  const username = user?.username || 'unknown';
  const role = user?.role || 'fabric_user';
  
  const token = AuthService.generateToken(tenantId, role, username);
  res.json({ token });
});

/**
 * @swagger
 * /api/admin/connections:
 *   post:
 *     summary: Register and virtualize a remote data source
 *     tags: [Integration]
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [tenantId, name, config]
 *             properties:
 *               tenantId: { type: string, example: "tenant_A" }
 *               name: { type: string, example: "InventoryDB" }
 *               config:
 *                 type: object
 *                 properties:
 *                   host: { type: string, example: "localhost" }
 *                   port: { type: number, example: 5432 }
 *                   dbName: { type: string, example: "postgres" }
 *                   user: { type: string, example: "postgres" }
 *                   pass: { type: string, example: "postgres" }
 *     responses:
 *       201:
 *         description: Source virtualized and cataloged
 */
/**
 * @swagger
 * /api/queries/exec:
 *   post:
 *     summary: Execute a synchronous SQL query across the fabric
 *     tags: [Analytics]
 *     security: [{ bearerAuth: [] }]
 */
app.post('/api/queries/exec', async (req, res) => {
  const user = (req as any).user;
  if (!user) return res.status(401).json({ error: 'Authentication required' });

  try {
    // Industrial Lifecycle Check: Block suspended tenants
    const { rows: tenantInfo } = await pool.query('SELECT status FROM public.tenants WHERE id = $1', [user.tenant_id]);
    if (tenantInfo.length > 0 && tenantInfo[0].status === 'SUSPENDED') {
        return res.status(403).json({ error: 'Tenant account is suspended. Queries disabled.' });
    }

    const { sql, async: isAsync } = req.body;
    const { QueryEngineService } = require('./modules/query-engine/query-engine.service');

    if (isAsync) {
        const jobId = QueryEngineService.executeAsyncRawSql(user.tenant_id, user.username || 'unknown', sql);
        return res.status(202).json({ queryId: jobId, status: 'ACCEPTED' });
    } else {
        const results = await QueryEngineService.executeRawSql(user.tenant_id, user.username || 'unknown', sql);
        return res.json({ results });
    }
  } catch (err: any) {
    console.error(`[API Error] ${req.method} ${req.url}: ${err.message}`);
    res.status(500).json({ error: err.message });
  }
});

/**
 * @swagger
 * /api/queries/status/{queryId}:
 *   get:
 *     summary: Poll status of an asynchronous query
 *     tags: [Analytics]
 */
app.get('/api/queries/status/:queryId', (req, res) => {
    const { QueryEngineService } = require('./modules/query-engine/query-engine.service');
    const status = QueryEngineService.getJobStatus(req.params.queryId);
    res.json(status);
});

app.post('/api/admin/connections', requireAdmin, async (req, res) => {
  try {
    const user = (req as any).user;
    const { tenantId: bodyTenantId, name, config } = req.body;
    // Industrial Hardening: Derive tenantId from session context
    const tenantId = user.tenant_id;
    
    // Strict Identity Verification
    if (bodyTenantId && bodyTenantId !== tenantId) {
       return res.status(403).json({ error: 'Identity Mismatch: Cannot provision for another tenant' });
    }

    const userContext = { 
      tenantId: user.tenant_id, 
      username: user.username || 'unknown' 
    };
    
    const result = await IntegrationService.registerPostgresSource(tenantId, name, config, userContext);
    const status = result.status === 'RE-INTEGRATED' ? 200 : 201;
    res.status(status).json(result);
  } catch (err: any) {
    console.error(`[Integration Error] ${err.message}`);
    res.status(500).json({ error: err.message });
  }
});

/**
 * @swagger
 * /api/admin/connections:
 *   get:
 *     summary: List all active connections for the current tenant
 *     tags: [Integration]
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: List of data sources
 *         content:
 *           application/json:
 *             schema:
 *               type: array
 *               items:
 *                 $ref: '#/components/schemas/DataSource'
 */
app.get('/api/admin/connections', requireAdmin, async (req, res) => {
  try {
    const userContext = (req as any).user;
    
    const result = await queryWithContext('SELECT * FROM public.data_sources', [], { 
      tenantId: userContext.tenant_id, 
      username: userContext.username || 'unknown' 
    });
    
    res.setHeader('Cache-Control', 'no-store');
    res.json(result.rows);
  } catch (err: any) {
    console.error(`[API Error] ${req.method} ${req.url}: ${err.message}`);
    res.status(500).json({ error: err.message });
  }
});

/**
 * @swagger
 * /api/admin/connections/{id}:
 *   delete:
 *     summary: Remove a virtualized source and cleanup FDW
 *     tags: [Integration]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: string }
 *     responses:
 *       200:
 *         description: Source removed
 */
app.delete('/api/admin/connections/:id', requireAdmin, async (req, res) => {
  try {
    const result = await IntegrationService.removeSource(req.params.id as string);
    res.json(result);
  } catch (err: any) {
    console.error(`[API Error] ${req.method} ${req.url}: ${err.message}`);
    res.status(500).json({ error: err.message });
  }
});

app.delete('/api/admin/tenants/:id', async (req, res) => {
  try {
    const result = await TenantService.deleteTenant(req.params.id as string);
    res.json(result);
  } catch (err: any) {
    console.error(`[API Error] ${req.method} ${req.url}: ${err.message}`);
    res.status(500).json({ error: err.message });
  }
});

/**
 * @swagger
 * /api/catalog/search:
 *   get:
 *     summary: Discover metadata across the fabric
 *     tags: [Discovery]
 *     responses:
 *       200:
 *         description: Search active
 */
app.get('/api/catalog/search', async (req, res) => {
  res.json({ message: 'Catalog search is active via PostgREST on port 3000' });
});

app.get('/health', (req, res) => res.json({ status: 'UP' }));

if (process.env.NODE_ENV !== 'test') {
  (async () => {
    try {
      console.log('[Startup] Verifying Database Connectivity...');
      const result = await pool.query('SELECT NOW()');
      console.log(`[Startup] Database Healthy: ${result.rows[0].now}`);
      
      server.listen(PORT, '0.0.0.0', () => {
        console.log(`Modular Data Fabric Orchestrator running on port ${PORT}`);
      });
    } catch (err: any) {
      console.error(`[FATAL] Database Connectivity Failed: ${err.message}`);
      process.exit(1);
    }
  })();
}
