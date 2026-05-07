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
 *     MetadataTemplate:
 *       type: object
 *       properties:
 *         version: { type: string, example: "7.0" }
 *         description: { type: string, example: "Universal Data Fabric Orchestration Blueprint (The Definitive Spec)" }
 *         schemas:
 *           type: array
 *           items:
 *             type: object
 *             properties:
 *               name: { type: string, example: "enterprise_core" }
 *               sequences: { type: array, items: { type: object } }
 *               tables:
 *                 type: array
 *                 items: { $ref: '#/components/schemas/TableDefinition' }
 *               foreignTables: { type: array, items: { type: object } }
 *     TableDefinition:
 *       type: object
 *       properties:
 *         name: { type: string, example: "users" }
 *         partitioned: { type: object }
 *         columns:
 *           type: array
 *           items:
 *             type: object
 *             properties:
 *               name: { type: string }
 *               type: { type: string }
 *               masking: { type: string, enum: ["NONE", "PARTIAL", "REDACT"], example: "PARTIAL" }
 *         governance:
 *           type: object
 *           properties:
 *             ttl: { type: string, example: "7 years" }
 *             quality: { type: string }
 *     RelationshipDefinition:
 *       type: object
 *       properties:
 *         name: { type: string, example: "rel_user_to_profile_1to1" }
 *         type: { type: string, enum: ["ONE_TO_ONE", "ONE_TO_MANY", "MANY_TO_MANY"], example: "ONE_TO_ONE" }
 *         source: { type: object }
 *         target: { type: object }
 *         cardinality: { type: string, enum: ["1:1", "1:M", "M:M"], example: "1:1" }
 *
 * tags:
 *   - name: Tenants
 *     description: Industrial Isolation & Provisioning
 *   - name: Discovery
 *     description: Metadata Crawler & Catalog Management
 *   - name: Analytics
 *     description: High-Performance Query Orchestration (AST & SQL)
 *   - name: Integration
 *     description: Heterogeneous Data Source Virtualization (FDW)
 *   - name: Metadata
 *     description: Declarative Schema Governance & Migration
 *   - name: Monitoring
 *     description: Health & Forensic Audit Trails
 *   - name: Auth
 *     description: Platform Security & Identity Proxy
 *
 * /api/health:
 *   get:
 *     summary: System health and telemetry
 *     tags: [Monitoring]
 *     responses:
 *       200:
 *         description: Success
 *
 * /api/admin/tenants:
 *   post:
 *     summary: Provision a new tenant
 *     tags: [Tenants]
 *     security: [{ bearerAuth: [] }]
 *     responses:
 *       201:
 *         description: Created
 *   get:
 *     summary: List all tenants
 *     tags: [Tenants]
 *     security: [{ bearerAuth: [] }]
 *     responses:
 *       200:
 *         description: Success
 *
 * /api/queries/exec:
 *   post:
 *     summary: Execute SQL query
 *     description: Support Parameterized SQL, Recursive CTEs, and JOINs across sources.
 *     tags: [Analytics]
 *     security: [{ bearerAuth: [] }]
 *     responses:
 *       200:
 *         description: Success
 *
 * /api/analytics/query:
 *   post:
 *     summary: Execute AST dynamic query
 *     description: High-fidelity analytical engine with multi-table JOINs and aggregations.
 *     tags: [Analytics]
 *     security: [{ bearerAuth: [] }]
 *     responses:
 *       200:
 *         description: Success
 *
 * /api/metadata/template:
 *   get:
 *     summary: Download industrial metadata template
 *     tags: [Metadata]
 *     responses:
 *       200:
 *         description: Success
 *         content:
 *           application/json:
 *             schema: { $ref: '#/components/schemas/MetadataTemplate' }
 *
 * /api/metadata/diff:
 *   post:
 *     summary: Analyze schema drift (Diff)
 *     tags: [Metadata]
 *     security: [{ bearerAuth: [] }]
 *     responses:
 *       200:
 *         description: Success
 *
 * /api/metadata/migrate:
 *   post:
 *     summary: Atomic Metadata Migration
 *     tags: [Metadata]
 *     security: [{ bearerAuth: [] }]
 *     responses:
 *       200:
 *         description: Success
 *
 * /api/auth/login:
 *   post:
 *     summary: Authenticate user
 *     tags: [Auth]
 *     responses:
 *       200:
 *         description: Login successful
 *
 * /api/admin/connections:
 *   post:
 *     summary: Register data source
 *     tags: [Integration]
 *     security: [{ bearerAuth: [] }]
 *     responses:
 *       201:
 *         description: Registered
 *   get:
 *     summary: List data sources
 *     tags: [Integration]
 *     security: [{ bearerAuth: [] }]
 *     responses:
 *       200:
 *         description: Success
 *
 * /api/admin/audit-logs:
 *   get:
 *     summary: Retrieve audit logs
 *     tags: [Monitoring]
 *     security: [{ bearerAuth: [] }]
 *     responses:
 *       200:
 *         description: Success
 */
