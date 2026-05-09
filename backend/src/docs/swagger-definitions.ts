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
 *     MetadataManifest:
 *       type: object
 *       required: [version, schemas]
 *       properties:
 *         version: { type: string, example: "4.0" }
 *         namespace: { type: string, example: "Global_Supply_Chain" }
 *         targetSource: { type: string, example: "Fabric_Hub_Postgres" }
 *         consistencyMode: { type: string, enum: [SAGA, STRONG], example: "SAGA" }
 *         downstream:
 *           type: array
 *           items: { $ref: '#/components/schemas/DownstreamTarget' }
 *         extensions:
 *           type: array
 *           items: { type: string, example: "uuid-ossp" }
 *         relationships:
 *           type: array
 *           items: { $ref: '#/components/schemas/RelationshipDefinition' }
 *       example:
 *         version: "4.0"
 *         namespace: "Global_Supply_Chain"
 *         consistencyMode: "SAGA"
 *         downstream:
 *           - type: "ELASTICSEARCH"
 *             enabled: true
 *             fallback: "PRIMARY_SQL"
 *           - type: "SNOWFLAKE"
 *             enabled: true
 *             strategy: "CDC"
 *         extensions: ["uuid-ossp", "pg_stat_statements"]
 *         schemas:
 *           - name: "GSC_Core"
 *             resources:
 *               - type: "TABLE"
 *                 name: "shipments"
 *                 columns:
 *                   - { name: "id", type: "uuid", strategy: "UUID_V7", pk: true }
 *                   - { name: "status", type: "varchar", default: "PENDING" }
 *               - type: "VIEW"
 *                 name: "active_orders"
 *                 query:
 *                   select: ["*"]
 *                   from: { resource: "orders" }
 *                   where: [{ column: "status", op: "=", value: "ACTIVE" }]
 *
 *     DownstreamTarget:
 *       type: object
 *       properties:
 *         type: { type: string, enum: [ELASTICSEARCH, SNOWFLAKE] }
 *         enabled: { type: boolean }
 *         fallback: { type: string, enum: [PRIMARY_SQL, FAIL_FAST, STALE_CACHE], description: "Resiliency plan for ELASTICSEARCH" }
 *         strategy: { type: string, enum: [CDC, BATCH_UPSERT, FULL_RELOAD], description: "Replication strategy for SNOWFLAKE" }
 *
 *     SchemaDefinition:
 *       type: object
 *       properties:
 *         name: { type: string }
 *         resources: { type: array, items: { $ref: '#/components/schemas/ResourceDefinition' } }
 *
 *     ResourceDefinition:
 *       type: object
 *       properties:
 *         type: { type: string, enum: [ENUM, SEQUENCE, TABLE, VIEW, MATERIALIZED_VIEW, FUNCTION, PROCEDURE] }
 *         name: { type: string }
 *
 *     RelationshipDefinition:
 *       type: object
 *       properties:
 *         name: { type: string }
 *         cardinality: { type: string, enum: ["1:1", "1:M", "M:N"] }
 *         bridge: { type: string, description: "Bridge table for M:N" }
 *         from: { type: object }
 *         to: { type: object }
 *
 *     ColumnDefinition:
 *       type: object
 *       properties:
 *         name: { type: string, example: "id" }
 *         type: { type: string, example: "uuid" }
 *         pk: { type: boolean, example: true }
 *         strategy: { type: string, enum: [UUID_V7, IDENTITY_ALWAYS, LEGACY_SERIAL, FUNCTIONAL] }
 *         generated: { type: string, description: "SQL expression for virtual columns" }
 *
 *     QueryAST:
 *       type: object
 *       description: Universal Query Syntax for Virtualized Views. Supports complex joins across federated sources.
 *       properties:
 *         select:
 *           type: array
 *           items: { type: string, example: "id", description: "List of columns or '*' for all" }
 *         from:
 *           type: object
 *           required: [resource]
 *           properties:
 *             resource: { type: string, example: "shipments" }
 *             source: { type: string, example: "Fabric_Hub_Postgres" }
 *         joins:
 *           type: array
 *           items:
 *             type: object
 *             properties:
 *               resource: { type: string, example: "users" }
 *               on: { type: string, example: "shipments.user_id = users.id" }
 *               type: { type: string, enum: [LEFT, INNER, RIGHT], default: "LEFT" }
 *         where:
 *           type: array
 *           items:
 *             type: object
 *             properties:
 *               column: { type: string, example: "status" }
 *               op: { type: string, enum: ["=", "!=", ">", "<", "LIKE", "ILIKE"], default: "=" }
 *               value: { type: string, example: "DELIVERED" }
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
 *     summary: Analyze Schema Drift (JSON or File)
 *     description: Performs a deep structural analysis between the provided Industrial Blueprint (JSON or Uploaded File) and the live database state.
 *     tags: [Metadata]
 *     security: [{ bearerAuth: [] }]
 *     requestBody:
 *       content:
 *         application/json:
 *           schema: { $ref: '#/components/schemas/MetadataManifest' }
 *         multipart/form-data:
 *           schema:
 *             type: object
 *             properties:
 *               file:
 *                 type: string
 *                 format: binary
 *                 description: Industrial Metadata Manifest file (JSON format)
 *     responses:
 *       200:
 *         description: Success (Plan Ready)
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 status: { type: string, example: "PLAN_READY" }
 *                 summary: { type: object, example: { total: 17, highRisk: 0 } }
 *                 changes:
 *                   type: array
 *                   items: { type: object }
 *             example:
 *               status: "PLAN_READY"
 *               summary: { total: 17, highRisk: 0 }
 *               changes:
 *                 - action: "CREATE_SCHEMA"
 *                   name: "Global_Supply_Chain"
 *                 - action: "PROVISION_EXTENSIONS"
 *                   extensions: ["uuid-ossp"]
 *                 - action: "CREATE_TABLE"
 *                   name: "shipments"
 *                   risk: "LOW"
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
 *     summary: Declarative Schema Apply (JSON or File)
 *     tags: [Metadata]
 *     description: Reconciles the database state with the provided Industrial Blueprint (JSON or Uploaded File).
 *     security: [{ bearerAuth: [] }]
 *     requestBody:
 *       content:
 *         application/json:
 *           schema: { $ref: '#/components/schemas/MetadataManifest' }
 *         multipart/form-data:
 *           schema:
 *             type: object
 *             properties:
 *               file:
 *                 type: string
 *                 format: binary
 *                 description: Industrial Metadata Manifest file (JSON format)
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
 *             example:
 *               status: "APPLIED"
 *               appliedCount: 17
 *               results:
 *                 - action: "CREATE_SCHEMA"
 *                   status: "SUCCESS"
 *                 - action: "CREATE_TABLE"
 *                   name: "shipments"
 *                   status: "SUCCESS"
 */
