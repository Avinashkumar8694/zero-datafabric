/**
 * @swagger
 * components:
 *   securitySchemes:
 *     bearerAuth:
 *       type: http
 *       scheme: bearer
 *       bearerFormat: JWT
 *   schemas:
 *     ErrorResponse:
 *       type: object
 *       properties:
 *         error: { type: string, example: "Invalid Request" }
 *     Tenant:
 *       type: object
 *       properties:
 *         id: { type: string }
 *         name: { type: string }
 *         status: { type: string }
 *         created_at: { type: string, format: "date-time" }
 *     DataSource:
 *       type: object
 *       properties:
 *         id: { type: string }
 *         name: { type: string }
 *         status: { type: string }
 *     MetadataRecord:
 *       type: object
 *       properties:
 *         table_name: { type: string }
 *         column_name: { type: string }
 *         data_type: { type: string }
 *     QueryResponse:
 *       type: object
 *       properties:
 *         data:
 *           type: array
 *           items: { type: object }
 *     AsyncJobResponse:
 *       type: object
 *       properties:
 *         jobId: { type: string }
 *         status: { type: string, enum: ["PENDING", "RUNNING", "COMPLETED", "FAILED"] }
 *     LoginResponse:
 *       type: object
 *       properties:
 *         token: { type: string }
 *         user:
 *           type: object
 *           properties:
 *             username: { type: string }
 *             role: { type: string }
 *             tenant_id: { type: string }
 *
 * tags:
 *   - name: Tenants
 *     description: Industrial Isolation & Provisioning
 *   - name: Discovery
 *     description: Metadata Crawler & Catalog Management
 *   - name: Analytics
 *     description: High-Performance Query Orchestration
 *   - name: Integration
 *     description: Heterogeneous Data Source Virtualization
 *   - name: Metadata
 *     description: Declarative Schema Governance
 *   - name: Monitoring
 *     description: Health & Forensic Audit Trails
 *   - name: Auth
 *     description: Platform Security & Identity Proxy
 *
 * /api/health:
 *   get:
 *     summary: Extended health check and telemetry
 *     tags: [Monitoring]
 *     responses:
 *       200:
 *         description: Success
 *
 * /api/auth/login:
 *   post:
 *     summary: Authenticate identity and return JWT
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
 *         description: Login successful
 *         content:
 *           application/json:
 *             schema: { $ref: '#/components/schemas/LoginResponse' }
 *
 * /api/auth/token:
 *   post:
 *     summary: Generate tenant-scoped session token
 *     tags: [Auth]
 *     security: [{ bearerAuth: [] }]
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
 *         description: Scoped token generated
 *
 * /api/admin/tenants:
 *   get:
 *     summary: List all tenants (Admin only)
 *     tags: [Tenants]
 *     security: [{ bearerAuth: [] }]
 *     responses:
 *       200:
 *         description: Success
 *   post:
 *     summary: Provision a new tenant environment (Admin only)
 *     tags: [Tenants]
 *     security: [{ bearerAuth: [] }]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [id, name]
 *             properties:
 *               id: { type: string, example: "tenant_B" }
 *               name: { type: string, example: "New Tenant" }
 *     responses:
 *       201:
 *         description: Created
 *
 * /api/admin/tenants/{id}:
 *   delete:
 *     summary: De-provision a tenant and its schemas (Admin only)
 *     tags: [Tenants]
 *     security: [{ bearerAuth: [] }]
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: string }
 *     responses:
 *       200:
 *         description: De-provisioning successful
 *
 * /api/admin/audit-logs:
 *   get:
 *     summary: Retrieve forensic audit trails (Admin only)
 *     tags: [Monitoring]
 *     security: [{ bearerAuth: [] }]
 *     responses:
 *       200:
 *         description: Success
 *
 * /api/admin/catalog:
 *   get:
 *     summary: List virtualized metadata catalog (Admin only)
 *     tags: [Discovery]
 *     security: [{ bearerAuth: [] }]
 *     responses:
 *       200:
 *         description: Success
 *
 * /api/metadata/crawl:
 *   post:
 *     summary: Trigger automated metadata discovery (Admin only)
 *     tags: [Discovery]
 *     security: [{ bearerAuth: [] }]
 *     requestBody:
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               tenantId: { type: string }
 *     responses:
 *       200:
 *         description: Crawl initiated
 *
 * /api/metadata/tables/{name}:
 *   get:
 *     summary: Get granular metadata for a specific table
 *     tags: [Discovery]
 *     security: [{ bearerAuth: [] }]
 *     parameters:
 *       - in: path
 *         name: name
 *         required: true
 *         schema: { type: string }
 *     responses:
 *       200:
 *         description: Success
 *
 * /api/admin/connections:
 *   get:
 *     summary: List active data source connections (Admin only)
 *     tags: [Integration]
 *     security: [{ bearerAuth: [] }]
 *     responses:
 *       200:
 *         description: Success
 *   post:
 *     summary: Register a new data source integration (Admin only)
 *     tags: [Integration]
 *     security: [{ bearerAuth: [] }]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [name, config]
 *             properties:
 *               name: { type: string }
 *               config:
 *                 type: object
 *                 required: [host, port, dbName, user, pass, syncType]
 *                 properties:
 *                   host: { type: string }
 *                   port: { type: integer }
 *                   dbName: { type: string }
 *                   user: { type: string }
 *                   pass: { type: string }
 *                   syncType: { type: string, enum: ["VIRTUAL", "CDC"] }
 *     responses:
 *       201:
 *         description: Registered
 *
 * /api/admin/connections/{id}:
 *   delete:
 *     summary: Safely remove a data source integration (Admin only)
 *     tags: [Integration]
 *     security: [{ bearerAuth: [] }]
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: string }
 *     responses:
 *       200:
 *         description: Success
 *
 * /api/queries/exec:
 *   post:
 *     summary: Execute raw SQL orchestration
 *     tags: [Analytics]
 *     security: [{ bearerAuth: [] }]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [sql]
 *             properties:
 *               sql: { type: string }
 *               async: { type: boolean, default: false }
 *     responses:
 *       200:
 *         description: Success (Sync)
 *       202:
 *         description: Job Accepted (Async)
 *
 * /api/queries/jobs/{id}:
 *   get:
 *     summary: Retrieve background SQL job status
 *     tags: [Analytics]
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: string }
 *     responses:
 *       200:
 *         description: Success
 *
 * /api/analytics/query:
 *   post:
 *     summary: Execute AST orchestrated query with filters
 *     tags: [Analytics]
 *     security: [{ bearerAuth: [] }]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [queryConfig]
 *             properties:
 *               queryConfig: { type: object }
 *     responses:
 *       200:
 *         description: Success
 *
 * /api/analytics/query-async:
 *   post:
 *     summary: Initiate background analytics job via AST
 *     tags: [Analytics]
 *     security: [{ bearerAuth: [] }]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [queryConfig]
 *             properties:
 *               queryConfig: { type: object }
 *     responses:
 *       202:
 *         description: Job Accepted
 *
 * /api/analytics/jobs/{jobId}:
 *   get:
 *     summary: Check status of an analytics background job
 *     tags: [Analytics]
 *     security: [{ bearerAuth: [] }]
 *     parameters:
 *       - in: path
 *         name: jobId
 *         required: true
 *         schema: { type: string }
 *     responses:
 *       200:
 *         description: Success
 *
 * /api/analytics/refresh-view:
 *   post:
 *     summary: Refresh a materialized view integration
 *     tags: [Analytics]
 *     security: [{ bearerAuth: [] }]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [viewName]
 *             properties:
 *               viewName: { type: string }
 *               concurrent: { type: boolean, default: false }
 *     responses:
 *       202:
 *         description: Refresh initiated
 *
 * /api/admin/users:
 *   get:
 *     summary: List all management identities (Admin only)
 *     tags: [Monitoring]
 *     security: [{ bearerAuth: [] }]
 *     responses:
 *       200:
 *         description: Success
 *
 * /api/metadata/template:
 *   get:
 *     summary: Download industrial orchestration template
 *     tags: [Metadata]
 *     responses:
 *       200:
 *         description: Success
 *
 * /api/metadata/diff:
 *   post:
 *     summary: Analyze Schema Drift (Idempotent)
 *     tags: [Metadata]
 *     security: [{ bearerAuth: [] }]
 *     requestBody:
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               schema: { type: object }
 *         multipart/form-data:
 *           schema:
 *             type: object
 *             properties:
 *               file:
 *                 type: string
 *                 format: binary
 *     responses:
 *       200:
 *         description: Success
 *
 * /api/metadata/migrate:
 *   post:
 *     summary: Apply atomic schema migrations
 *     tags: [Metadata]
 *     security: [{ bearerAuth: [] }]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [migrationPlan]
 *             properties:
 *               migrationPlan: { type: array, items: { type: object } }
 *     responses:
 *       200:
 *         description: Migration successful
 *
 * /api/metadata/apply:
 *   post:
 *     summary: Declarative Schema Apply (Orchestration)
 *     tags: [Metadata]
 *     description: Automatically diffs a target manifest against the live environment and applies all necessary migrations in a single transaction.
 *     security: [{ bearerAuth: [] }]
 *     requestBody:
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               schema:
 *                 type: object
 *                 description: Target metadata manifest (template format)
 *         multipart/form-data:
 *           schema:
 *             type: object
 *             properties:
 *               file:
 *                 type: string
 *                 format: binary
 *     responses:
 *       200:
 *         description: Successful orchestration
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 plan:
 *                   type: array
 *                   description: The calculated migration plan
 *                 results:
 *                   type: array
 *                   description: Execution results per step
 */
