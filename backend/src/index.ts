import express from 'express';
import cors from 'cors';
import { TenantService } from './modules/tenant/tenant.service';
import { IntegrationService } from './modules/integration/integration.service';
import { AuthService } from './modules/auth/auth.service';
import { MetadataService } from './modules/metadata/metadata.service';
import { EventService } from './modules/events/event.service';
import analyticsRoutes from './routes/analyticsRoutes';
import swaggerUi from 'swagger-ui-express';
import { swaggerSpec } from './config/swagger';
import http from 'http';

const app = express();
export { app };
const server = http.createServer(app);
// EventService.init(server);

app.use(cors());
app.use(express.json());

const PORT = 4000;

// Swagger Documentation
app.use('/api-docs', swaggerUi.serve, swaggerUi.setup(swaggerSpec));

// Mount Modules
app.use('/api/analytics', analyticsRoutes);

// Industrial Grade Modular Routes

// 1. Tenant Management
app.post('/api/admin/tenants', async (req, res) => {
  try {
    const { id, name } = req.body;
    const result = await TenantService.createTenant(id, name);
    res.status(201).json(result);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// 2. Auth / Token Generation
app.post('/api/auth/token', (req, res) => {
  const { tenantId } = req.body;
  const token = AuthService.generateToken(tenantId);
  res.json({ token });
});

// 3. Integration / FDW
app.post('/api/admin/connections', async (req, res) => {
  try {
    const { tenantId, name, config } = req.body;
    const result = await IntegrationService.registerPostgresSource(tenantId, name, config);
    
    // Auto-trigger crawl after registration (Mocked)
    console.log(`[Metadata] Crawling metadata for ${tenantId}...`);
    
    res.status(201).json(result);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

app.delete('/api/admin/connections/:id', async (req, res) => {
  try {
    const result = await IntegrationService.removeSource(req.params.id);
    res.json(result);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

app.delete('/api/admin/tenants/:id', async (req, res) => {
  try {
    const result = await TenantService.deleteTenant(req.params.id);
    res.json(result);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// 4. Metadata Search
app.get('/api/catalog/search', async (req, res) => {
  // PostgREST handles this usually, but we can add orchestrator-level search if needed
  res.json({ message: 'Catalog search is active via PostgREST on port 3000' });
});

app.get('/health', (req, res) => res.json({ status: 'UP' }));

if (process.env.NODE_ENV !== 'test') {
  server.listen(PORT, () => {
    console.log(`Modular Data Fabric Orchestrator running on port ${PORT}`);
  });
}
