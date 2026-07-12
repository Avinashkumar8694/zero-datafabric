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
 *   put:
 *     summary: Update a tenant's name and/or lifecycle status (Admin only)
 *     tags: [Tenants]
 *     description: >
 *       Updates the mutable fields of a tenant. Setting `status` to `SUSPENDED`
 *       causes all subsequent query/data requests for that tenant to be rejected
 *       {403} until it is reactivated. PUT and PATCH are equivalent here.
 *     security: [{ bearerAuth: [] }]
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: string }
 *         example: tenant_A
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               name: { type: string, example: "Acme Corp (renamed)" }
 *               status: { type: string, enum: [ACTIVE, SUSPENDED], example: SUSPENDED }
 *     responses:
 *       200:
 *         description: Updated tenant record
 *         content:
 *           application/json:
 *             schema: { $ref: '#/components/schemas/Tenant' }
 *       401: { description: Not authenticated, content: { application/json: { schema: { $ref: '#/components/schemas/ErrorResponse' }, example: { error: "Authentication required" } } } }
 *       403: { description: Caller is not an ADMIN, content: { application/json: { schema: { $ref: '#/components/schemas/ErrorResponse' }, example: { error: "Admin privileges required" } } } }
 *       500: { description: Server error, content: { application/json: { schema: { $ref: '#/components/schemas/ErrorResponse' } } } }
 *   patch:
 *     summary: Partially update a tenant (Admin only)
 *     tags: [Tenants]
 *     description: Alias of PUT — updates `name` and/or `status`.
 *     security: [{ bearerAuth: [] }]
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: string }
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               name: { type: string }
 *               status: { type: string, enum: [ACTIVE, SUSPENDED] }
 *     responses:
 *       200: { description: Updated tenant record, content: { application/json: { schema: { $ref: '#/components/schemas/Tenant' } } } }
 *       401: { description: Not authenticated, content: { application/json: { schema: { $ref: '#/components/schemas/ErrorResponse' } } } }
 *       403: { description: Caller is not an ADMIN, content: { application/json: { schema: { $ref: '#/components/schemas/ErrorResponse' } } } }
 *       500: { description: Server error, content: { application/json: { schema: { $ref: '#/components/schemas/ErrorResponse' } } } }
 *   delete:
 *     summary: De-provision a tenant and its schemas (Admin only)
 *     tags: [Tenants]
 *     description: 'Destructive: drops the tenant''s managed schemas/records. Requires ADMIN.'
 *     security: [{ bearerAuth: [] }]
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: string }
 *     responses:
 *       200:
 *         description: De-provisioning successful
 *         content:
 *           application/json:
 *             schema: { type: object, properties: { status: { type: string, example: DELETED }, id: { type: string, example: tenant_A } } }
 *       401: { description: Not authenticated, content: { application/json: { schema: { $ref: '#/components/schemas/ErrorResponse' } } } }
 *       403: { description: Caller is not an ADMIN, content: { application/json: { schema: { $ref: '#/components/schemas/ErrorResponse' } } } }
 *       500: { description: Server error, content: { application/json: { schema: { $ref: '#/components/schemas/ErrorResponse' } } } }
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
 *         description: Registered (new source)
 *       200:
 *         description: Re-integrated (an existing source with the same name was reconnected)
 *       400: { description: 'Missing name/config', content: { application/json: { schema: { $ref: '#/components/schemas/ErrorResponse' }, example: { error: "name and config are required" } } } }
 *       401: { description: Not authenticated, content: { application/json: { schema: { $ref: '#/components/schemas/ErrorResponse' } } } }
 *       403: { description: Caller is not an ADMIN, content: { application/json: { schema: { $ref: '#/components/schemas/ErrorResponse' } } } }
 *       500: { description: Registration failed, content: { application/json: { schema: { $ref: '#/components/schemas/ErrorResponse' } } } }
 *   patch:
 *     summary: Change a data source's connection status (Admin only)
 *     tags: [Integration]
 *     description: >
 *       Connect or disconnect a registered source without deleting it {e.g. set to
 *       DISCONNECTED to take it offline}. Invalidates the tenant metadata cache.
 *     security: [{ bearerAuth: [] }]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [sourceId, status]
 *             properties:
 *               sourceId: { type: string, example: src_1 }
 *               status: { type: string, enum: [CONNECTED, DISCONNECTED], example: DISCONNECTED }
 *     responses:
 *       200: { description: Status changed }
 *       400: { description: 'Missing sourceId/status', content: { application/json: { schema: { $ref: '#/components/schemas/ErrorResponse' }, example: { error: "sourceId and status are required" } } } }
 *       401: { description: Not authenticated, content: { application/json: { schema: { $ref: '#/components/schemas/ErrorResponse' } } } }
 *       403: { description: Caller is not an ADMIN, content: { application/json: { schema: { $ref: '#/components/schemas/ErrorResponse' } } } }
 *       500: { description: Server error, content: { application/json: { schema: { $ref: '#/components/schemas/ErrorResponse' } } } }
 *
 * /api/admin/connections/{id}:
 *   delete:
 *     summary: Safely remove a data source integration (Admin only)
 *     tags: [Integration]
 *     description: Removes the source registration and busts the tenant metadata cache.
 *     security: [{ bearerAuth: [] }]
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: string }
 *     responses:
 *       200:
 *         description: Removed
 *       400: { description: 'Missing source id', content: { application/json: { schema: { $ref: '#/components/schemas/ErrorResponse' } } } }
 *       401: { description: Not authenticated, content: { application/json: { schema: { $ref: '#/components/schemas/ErrorResponse' } } } }
 *       403: { description: Caller is not an ADMIN, content: { application/json: { schema: { $ref: '#/components/schemas/ErrorResponse' } } } }
 *       500: { description: Server error, content: { application/json: { schema: { $ref: '#/components/schemas/ErrorResponse' } } } }
 *
 * /api/queries/exec:
 *   post:
 *     summary: Execute native SQL (optionally at a named source)
 *     tags: [Analytics]
 *     description: >
 *       Runs raw SQL. Without `source` it executes on the fabric hub. With `source`
 *       set to a datasource name, the SQL is executed **at that external engine**
 *       — this is how you run complex single-source analytics the AST layer does not
 *       model: **window functions, recursive CTEs, and materialized-view reads**.
 *       `schema` sets the search_path at the source. Set `async:true` to run as a
 *       background job (returns a job id). The response includes the same
 *       `plan.legs` execution trace as federated queries.
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
 *               source: { type: string, description: 'Datasource to run at; omit for the hub.' }
 *               schema: { type: string, description: 'search_path at the source.' }
 *               params: { type: array, items: {} }
 *               async: { type: boolean, default: false }
 *           examples:
 *             rawSqlHub:
 *               summary: Raw SQL on hub
 *               value:
 *                 sql: "SELECT now() AS server_time, current_user AS db_role"
 *             sqlAtSource:
 *               summary: SQL at a source (hub Postgres)
 *               value:
 *                 source: Fabric_Hub_Postgres
 *                 sql: "SELECT now() AS server_time, current_user AS db_role"
 *             windowFunction:
 *               summary: Window function (RANK)
 *               value:
 *                 sql: "SELECT region, amount, RANK() OVER (PARTITION BY region ORDER BY amount DESC) AS rnk FROM (VALUES ('EU',300),('EU',150),('NA',200)) AS t(region, amount)"
 *             recursiveCte:
 *               summary: Recursive CTE (generate a series)
 *               value:
 *                 sql: "WITH RECURSIVE nums(n) AS (SELECT 1 UNION ALL SELECT n+1 FROM nums WHERE n < 5) SELECT n FROM nums"
 *     responses:
 *       200:
 *         description: Result rows + execution plan/trace
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 results: { type: array, items: { type: object } }
 *                 data: { type: array, items: { type: object } }
 *                 rowCount: { type: integer }
 *                 plan: { $ref: '#/components/schemas/QueryPlan' }
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
 *     summary: Execute a structured AST query (the primary query interface)
 *     tags: [Analytics]
 *     description: >
 *       Runs an engine-agnostic query described by an AST. The planner decides how
 *       to execute it: a single source is pushed down {filter / projection / sort /
 *       limit / GROUP-BY aggregate}; a query spanning multiple sources is federated
 *       {per-source pushdown + bind-join for joins, partial-aggregate merge for
 *       aggregates, in-fabric merge for UNION/INTERSECT/EXCEPT}. The response
 *       includes `plan.legs` showing exactly which engine ran what and how many rows
 *       it returned. A SELECT must carry a `where`, a `limit`, or be a set-op.
 *     security: [{ bearerAuth: [] }]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [queryConfig]
 *             properties:
 *               queryConfig: { $ref: '#/components/schemas/QueryConfig' }
 *           examples:
 *             astFilter:
 *               summary: AST — filter + projection pushdown (single source)
 *               value:
 *                 queryConfig:
 *                   type: SELECT
 *                   schema: an_lab
 *                   limit: 10
 *                   query:
 *                     from: { resource: employees, source: An_Lab }
 *                     select: [id, name, dept_id]
 *                     where: [{ column: dept_id, operator: EQ, value: 10 }]
 *             astAggregate:
 *               summary: AST — aggregate + GROUP BY pushed to the source
 *               value:
 *                 queryConfig:
 *                   type: SELECT
 *                   schema: an_lab
 *                   limit: 10
 *                   query:
 *                     from: { resource: employees, source: An_Lab }
 *                     groupBy: [dept_id]
 *                     select: [dept_id, { aggregate: COUNT, column: '*', alias: n }]
 *             astRecursive:
 *               summary: AST — recursive hierarchy traversal (connect-by)
 *               value:
 *                 queryConfig:
 *                   type: SELECT
 *                   schema: an_lab
 *                   query:
 *                     recursive:
 *                       source: An_Lab
 *                       resource: employees
 *                       connectBy: { parent: manager_id, child: id }
 *                       anchor: [{ column: manager_id, operator: IS_NULL }]
 *                       select: [id, name, manager_id]
 *                       maxDepth: 10
 *             callFunction:
 *               summary: CALL (function-as-a-service)
 *               value:
 *                 queryConfig:
 *                   type: CALL
 *                   function: current_user_id
 *     responses:
 *       200:
 *         description: Result rows + execution plan/trace
 *         content:
 *           application/json:
 *             schema: { $ref: '#/components/schemas/QueryEnvelope' }
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
 *           examples:
 *             astFilter:
 *               summary: AST — filter + projection (single source)
 *               value:
 *                 queryConfig:
 *                   type: SELECT
 *                   schema: an_lab
 *                   limit: 10
 *                   query:
 *                     from: { resource: employees, source: An_Lab }
 *                     select: [id, name, dept_id]
 *                     where: [{ column: dept_id, operator: EQ, value: 10 }]
 *             astAggregate:
 *               summary: AST — aggregate + GROUP BY
 *               value:
 *                 queryConfig:
 *                   type: SELECT
 *                   schema: an_lab
 *                   limit: 10
 *                   query:
 *                     from: { resource: employees, source: An_Lab }
 *                     groupBy: [dept_id]
 *                     select: [dept_id, { aggregate: COUNT, column: '*', alias: n }]
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
 *         content:
 *           application/json:
 *             schema:
 *               type: array
 *               items:
 *                 type: object
 *                 properties:
 *                   id: { type: string }
 *                   username: { type: string, example: alice }
 *                   tenant_id: { type: string, example: tenant_A }
 *                   role: { type: string, example: ANALYST }
 *                   status: { type: string, example: ACTIVE }
 *       401: { description: Not authenticated, content: { application/json: { schema: { $ref: '#/components/schemas/ErrorResponse' } } } }
 *       403: { description: Caller is not an ADMIN, content: { application/json: { schema: { $ref: '#/components/schemas/ErrorResponse' } } } }
 *       500: { description: Server error, content: { application/json: { schema: { $ref: '#/components/schemas/ErrorResponse' } } } }
 *   post:
 *     summary: Create a management identity (Admin only)
 *     tags: [Monitoring]
 *     description: Creates a user credential scoped to a tenant with a fabric role.
 *     security: [{ bearerAuth: [] }]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [username, password, tenantId, role]
 *             properties:
 *               username: { type: string, example: alice }
 *               password: { type: string, example: "s3cret!" }
 *               tenantId: { type: string, example: tenant_A }
 *               role: { type: string, example: ANALYST }
 *     responses:
 *       201: { description: Created }
 *       401: { description: Not authenticated, content: { application/json: { schema: { $ref: '#/components/schemas/ErrorResponse' } } } }
 *       403: { description: Caller is not an ADMIN, content: { application/json: { schema: { $ref: '#/components/schemas/ErrorResponse' } } } }
 *       500: { description: Creation failed (e.g. duplicate username), content: { application/json: { schema: { $ref: '#/components/schemas/ErrorResponse' } } } }
 *
 * /api/admin/users/{id}:
 *   put:
 *     summary: Update a management identity (Admin only)
 *     tags: [Monitoring]
 *     description: 'Updates a user. Any subset of fields may be sent; a non-empty `password` resets the credential.'
 *     security: [{ bearerAuth: [] }]
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: string }
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               username: { type: string }
 *               password: { type: string }
 *               tenantId: { type: string }
 *               role: { type: string }
 *     responses:
 *       200: { description: Updated }
 *       401: { description: Not authenticated, content: { application/json: { schema: { $ref: '#/components/schemas/ErrorResponse' } } } }
 *       403: { description: Caller is not an ADMIN, content: { application/json: { schema: { $ref: '#/components/schemas/ErrorResponse' } } } }
 *       500: { description: Server error, content: { application/json: { schema: { $ref: '#/components/schemas/ErrorResponse' } } } }
 *   delete:
 *     summary: Delete a management identity (Admin only)
 *     tags: [Monitoring]
 *     security: [{ bearerAuth: [] }]
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: string }
 *     responses:
 *       200: { description: Deleted }
 *       401: { description: Not authenticated, content: { application/json: { schema: { $ref: '#/components/schemas/ErrorResponse' } } } }
 *       403: { description: Caller is not an ADMIN, content: { application/json: { schema: { $ref: '#/components/schemas/ErrorResponse' } } } }
 *       500: { description: Server error, content: { application/json: { schema: { $ref: '#/components/schemas/ErrorResponse' } } } }
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

/**
 * @swagger
 * components:
 *   schemas:
 *     AnalyticVariable:
 *       type: object
 *       description: A declared, typed input for a saved analytic, bound into the query via a `{{name}}` placeholder.
 *       required: [name, type]
 *       properties:
 *         name: { type: string, example: region }
 *         type: { type: string, enum: [string, number, boolean], example: string }
 *         label: { type: string, example: "Region" }
 *         required: { type: boolean, example: true }
 *         default: { description: Default value if the caller omits it }
 *     SavedAnalytic:
 *       type: object
 *       description: >
 *         A reusable, parameterized analytic. `mode: AST` carries a full queryConfig
 *         in `config`; `mode: SQL` carries a raw `sql` string (optionally at `source`).
 *         Either body may reference declared variables with `{{name}}` tokens.
 *       required: [name, mode]
 *       properties:
 *         id: { type: string, format: uuid, readOnly: true }
 *         name: { type: string, example: "Revenue by region" }
 *         description: { type: string, example: "Total revenue grouped by region, filtered by segment" }
 *         mode: { type: string, enum: [AST, SQL], example: AST }
 *         config: { $ref: '#/components/schemas/QueryConfig' }
 *         sql: { type: string, description: "SQL mode only.", example: "SELECT now() AS server_time, current_user AS db_role" }
 *         source: { type: string, example: Fabric_Hub_Postgres }
 *         variables: { type: array, items: { $ref: '#/components/schemas/AnalyticVariable' } }
 *         run_count: { type: integer, readOnly: true, example: 12 }
 *         last_run_at: { type: string, format: date-time, readOnly: true }
 *     PolicyClause:
 *       type: object
 *       description: "A row-filter predicate. `value` is a literal, an array (for IN), or a session reference like ( session: 'tenant_id' )."
 *       properties:
 *         column: { type: string, example: region }
 *         operator: { type: string, enum: [EQ, NEQ, GT, GTE, LT, LTE, IN, LIKE, IS_NULL, IS_NOT_NULL], example: EQ }
 *         value: { example: { session: region } }
 *     MaskRule:
 *       type: object
 *       description: A column-masking rule applied post-fetch for the targeted roles.
 *       properties:
 *         column: { type: string, example: email }
 *         roles: { type: array, items: { type: string }, description: "Roles to mask for; omit = everyone.", example: [ANALYST] }
 *         strategy: { type: string, enum: [REDACT, NULL, HASH, PARTIAL], example: PARTIAL }
 *     Policy:
 *       type: object
 *       description: Engine-agnostic access policy (row filter + column masking) enforced by the fabric on non-RLS engines.
 *       required: [name, schema, table]
 *       properties:
 *         id: { type: string, readOnly: true }
 *         name: { type: string, example: "eu_analyst_rows" }
 *         schema: { type: string, example: public }
 *         table: { type: string, example: customers }
 *         roles: { type: array, items: { type: string }, description: "Roles this row policy restricts; omit = all roles.", example: [ANALYST] }
 *         rowFilter: { type: array, items: { $ref: '#/components/schemas/PolicyClause' } }
 *         masking: { type: array, items: { $ref: '#/components/schemas/MaskRule' } }
 *     ConstraintColumn:
 *       type: object
 *       properties:
 *         name: { type: string, example: status }
 *         notNull: { type: boolean, example: true }
 *         unique: { type: boolean, example: false }
 *         enum: { type: array, items: { type: string }, example: [PENDING, SHIPPED, DELIVERED] }
 *         fk: { type: object, properties: { source: { type: string }, schema: { type: string }, table: { type: string }, column: { type: string } } }
 *     CheckRule:
 *       type: object
 *       properties:
 *         name: { type: string, example: amount_positive }
 *         column: { type: string, example: total_amount }
 *         op: { type: string, enum: [REGEX, GT, GTE, LT, LTE, EQ, NEQ, IN, LEN_LTE, NOT_NULL], example: GT }
 *         value: { example: 0 }
 *     ConstraintSpec:
 *       type: object
 *       description: Engine-agnostic constraints (NOT NULL / UNIQUE / ENUM / CHECK / FK) validated in-fabric before writes to non-SQL engines.
 *       required: [schema, table]
 *       properties:
 *         id: { type: string, readOnly: true }
 *         schema: { type: string, example: public }
 *         table: { type: string, example: orders }
 *         columns: { type: array, items: { $ref: '#/components/schemas/ConstraintColumn' } }
 *         checks: { type: array, items: { $ref: '#/components/schemas/CheckRule' } }
 *     GrantRule:
 *       type: object
 *       properties:
 *         role: { type: string, example: ANALYST }
 *         privileges: { type: array, items: { type: string, enum: [SELECT, INSERT, UPDATE, DELETE] }, example: [SELECT] }
 *     Grant:
 *       type: object
 *       description: Engine-agnostic table privileges enforced by the fabric on non-SQL engines (default-allow when no grants declared; ADMIN always passes).
 *       required: [schema, table, grants]
 *       properties:
 *         id: { type: string, readOnly: true }
 *         schema: { type: string, example: public }
 *         table: { type: string, example: customers }
 *         grants: { type: array, items: { $ref: '#/components/schemas/GrantRule' } }
 *     TriggerDefinition:
 *       type: object
 *       description: >
 *         The trigger body. A row-based trigger fires on `event` (INSERT/UPDATE/DELETE)
 *         and requires schemaName+tableName; a scheduled trigger supplies `schedule`
 *         instead. `execute.type` selects the action a durable job runs.
 *       properties:
 *         event: { type: string, enum: [INSERT, UPDATE, DELETE], example: INSERT }
 *         timing: { type: string, enum: [BEFORE, AFTER], example: AFTER }
 *         schedule: { type: object, properties: { type: { type: string, example: INTERVAL }, every: { type: string, example: "5m" } } }
 *         execute:
 *           type: object
 *           required: [type]
 *           properties:
 *             type: { type: string, enum: [AUDIT, WEBHOOK, EMAIL, TELEGRAM, FUNCTION, EXCEPTION], example: WEBHOOK }
 *             url: { type: string, example: "https://hooks.example.com/orders" }
 *             when: { type: object, description: "Optional guard ( left, operator, right ) for FUNCTION/EXCEPTION." }
 *             message: { type: string }
 *     Trigger:
 *       type: object
 *       required: [triggerName, definition]
 *       properties:
 *         id: { type: string, readOnly: true }
 *         triggerName: { type: string, example: "notify_new_order" }
 *         schemaName: { type: string, example: public, description: "Required for row-based triggers." }
 *         tableName: { type: string, example: orders, description: "Required for row-based triggers." }
 *         definition: { $ref: '#/components/schemas/TriggerDefinition' }
 *         status: { type: string, readOnly: true, enum: [ACTIVE, PENDING_DEPLOY, PENDING_DELETE, CANCELLED], example: ACTIVE }
 *         lastDeployedAt: { type: string, format: date-time, readOnly: true }
 *         updatedAt: { type: string, format: date-time, readOnly: true }
 *     TriggerJob:
 *       type: object
 *       properties:
 *         id: { type: string }
 *         triggerId: { type: string, nullable: true }
 *         jobType: { type: string, example: EXECUTE_TRIGGER_ACTION }
 *         status: { type: string, enum: [PENDING, RUNNING, SUCCESS, FAILED, CANCELLED], example: PENDING }
 *         attempts: { type: integer, example: 0 }
 *         maxAttempts: { type: integer, example: 3 }
 *         runAt: { type: string, format: date-time }
 *         lastError: { type: string, nullable: true }
 *         createdAt: { type: string, format: date-time }
 *     TriggerLog:
 *       type: object
 *       properties:
 *         id: { type: string }
 *         triggerId: { type: string }
 *         triggerName: { type: string }
 *         schemaName: { type: string }
 *         tableName: { type: string }
 *         eventType: { type: string, nullable: true }
 *         action: { type: string, example: TRIGGER_UPSERT }
 *         status: { type: string, example: SUCCESS }
 *         detail: { type: object }
 *         createdAt: { type: string, format: date-time }
 *     QueryLog:
 *       type: object
 *       description: One captured query execution (audit trail of the query engine).
 *       properties:
 *         id: { type: string }
 *         tenant_id: { type: string }
 *         username: { type: string }
 *         role: { type: string }
 *         mode: { type: string, example: SELECT_AST, description: "SELECT_AST | SELECT_SQL | SQL_ON_SOURCE | CALL | RECURSIVE | CRUD_CREATE | CRUD_UPDATE | CRUD_DELETE | FETCH | SEQUENCE | SAVED_ANALYTIC | ..." }
 *         api: { type: string, example: /api/analytics/query }
 *         source: { type: string, nullable: true, example: An_Lab }
 *         status: { type: string, enum: [SUCCESS, ERROR], example: SUCCESS }
 *         query_text: { type: string }
 *         row_count: { type: integer, example: 42 }
 *         duration_ms: { type: integer, example: 18 }
 *         error: { type: string, nullable: true }
 *         created_at: { type: string, format: date-time }
 *
 * tags:
 *   - name: Data
 *     description: Simple REST-style CRUD over federated sources
 *   - name: Security & Policies
 *     description: Engine-agnostic access policies, constraints and grants enforced across engines
 *   - name: Automation
 *     description: Triggers, scheduled actions and durable job queue
 *   - name: Saved Analytics
 *     description: Reusable, parameterized saved queries (define once, run many)
 *   - name: Governance
 *     description: Query execution audit trail and change events
 */

/**
 * @swagger
 * /api/data/sequence:
 *   post:
 *     summary: Allocate the next value(s) from a fabric sequence
 *     tags: [Data]
 *     description: >
 *       Postgres-style nextval() available to ANY engine — e.g. to give MongoDB
 *       inserts consistent sequential IDs. Optionally reserve a contiguous block
 *       with `count` (returns the range).
 *     security: [{ bearerAuth: [] }]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [name]
 *             properties:
 *               name: { type: string, example: order_id_seq }
 *               start: { type: integer, example: 1000 }
 *               increment: { type: integer, example: 1 }
 *               count: { type: integer, description: "Reserve this many values at once.", example: 5 }
 *           example: { name: order_id_seq, count: 5 }
 *     responses:
 *       200: { description: Allocated value(s), content: { application/json: { schema: { type: object, properties: { name: { type: string }, value: { type: integer, example: 1005 }, values: { type: array, items: { type: integer } } } } } } }
 *       400: { description: 'Missing name', content: { application/json: { schema: { $ref: '#/components/schemas/ErrorResponse' }, example: { error: "name is required" } } } }
 *       401: { description: Not authenticated, content: { application/json: { schema: { $ref: '#/components/schemas/ErrorResponse' } } } }
 *       403: { description: 'Tenant suspended / access denied', content: { application/json: { schema: { $ref: '#/components/schemas/ErrorResponse' } } } }
 *       500: { description: Server error, content: { application/json: { schema: { $ref: '#/components/schemas/ErrorResponse' } } } }
 *
 * /api/data/call:
 *   post:
 *     summary: Invoke a provisioned function or stored procedure
 *     tags: [Data]
 *     description: >
 *       Fabric function-as-a-service. Runs a provisioned FUNCTION (`SELECT fn(...)`)
 *       or PROCEDURE (`CALL proc(...)`) at the owning source. Provide exactly one of
 *       `function` or `procedure`.
 *     security: [{ bearerAuth: [] }]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               schema: { type: string, example: public }
 *               function: { type: string, example: calc_ltv }
 *               procedure: { type: string, example: rebuild_index }
 *               args: { type: array, items: {}, example: [42, "EU"] }
 *           example: { schema: public, function: calc_ltv, args: [42] }
 *     responses:
 *       200: { description: Result + plan/trace, content: { application/json: { schema: { $ref: '#/components/schemas/QueryEnvelope' } } } }
 *       400: { description: 'Validation error (e.g. function not found / unsupported)', content: { application/json: { schema: { $ref: '#/components/schemas/ErrorResponse' } } } }
 *       401: { description: Not authenticated, content: { application/json: { schema: { $ref: '#/components/schemas/ErrorResponse' } } } }
 *       403: { description: 'Tenant suspended / access denied', content: { application/json: { schema: { $ref: '#/components/schemas/ErrorResponse' } } } }
 *       500: { description: Server error, content: { application/json: { schema: { $ref: '#/components/schemas/ErrorResponse' } } } }
 *
 * /api/queries/engine:
 *   post:
 *     summary: Execute a structured AST query (raw engine passthrough)
 *     tags: [Analytics]
 *     description: >
 *       Runs a queryConfig directly through the query engine {accepts the config as
 *       the body, or wrapped in `(config: ...)`}. Same execution semantics as
 *       `/api/analytics/query` but without the log-capture wrapper.
 *     security: [{ bearerAuth: [] }]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema: { $ref: '#/components/schemas/QueryConfig' }
 *     responses:
 *       200: { description: Result rows + execution plan/trace, content: { application/json: { schema: { $ref: '#/components/schemas/QueryEnvelope' } } } }
 *       401: { description: Not authenticated, content: { application/json: { schema: { $ref: '#/components/schemas/ErrorResponse' } } } }
 *       403: { description: 'Tenant suspended', content: { application/json: { schema: { $ref: '#/components/schemas/ErrorResponse' } } } }
 *       500: { description: Execution failed, content: { application/json: { schema: { $ref: '#/components/schemas/ErrorResponse' } } } }
 *
 * /api/queries/native:
 *   post:
 *     summary: Execute raw SQL against the hub (or a named source)
 *     tags: [Analytics]
 *     description: >
 *       Runs raw SQL directly. Without `source` (or with `Fabric_Hub_Postgres`) it
 *       runs on the fabric hub; with a named `source` it is routed to that source's
 *       connector. `schema` sets the search_path at the source. This endpoint is
 *       always synchronous (use `/api/queries/exec` for async).
 *     security: [{ bearerAuth: [] }]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [sql]
 *             properties:
 *               sql: { type: string, example: "SELECT 1 AS one, 2 AS two" }
 *               source: { type: string, example: Fabric_Hub_Postgres }
 *               schema: { type: string, example: public }
 *           examples:
 *             rawSqlHub:
 *               summary: Raw SQL on hub
 *               value:
 *                 sql: "SELECT 1 AS one, 2 AS two"
 *             sqlAtSource:
 *               summary: SQL at a source (hub Postgres)
 *               value:
 *                 source: Fabric_Hub_Postgres
 *                 sql: "SELECT NOW() AS ts"
 *     responses:
 *       200: { description: Result rows, content: { application/json: { schema: { type: object, properties: { results: { type: array, items: { type: object } }, rowCount: { type: integer } } } } } }
 *       401: { description: Not authenticated, content: { application/json: { schema: { $ref: '#/components/schemas/ErrorResponse' } } } }
 *       403: { description: 'Tenant suspended', content: { application/json: { schema: { $ref: '#/components/schemas/ErrorResponse' } } } }
 *       500: { description: SQL error, content: { application/json: { schema: { $ref: '#/components/schemas/ErrorResponse' } } } }
 *
 * /api/queries/transpile:
 *   post:
 *     summary: Preview the SQL the fabric would generate for an AST (no execution)
 *     tags: [Analytics]
 *     description: >
 *       Powers the "see SQL" mode in the AST builder. Accepts `(config)` {a
 *       queryConfig} or a bare AST `(query)` and returns `(sql)`. Never fails
 *       hard — if it cannot transpile, it returns 200 with a commented SQL string
 *       and an `error` field. Recursive queries return a note (they run in-fabric).
 *     security: [{ bearerAuth: [] }]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               config: { $ref: '#/components/schemas/QueryConfig' }
 *           examples:
 *             astFilter:
 *               summary: AST — filter + projection
 *               value:
 *                 config:
 *                   type: SELECT
 *                   schema: an_lab
 *                   limit: 10
 *                   query:
 *                     from: { resource: employees, source: An_Lab }
 *                     select: [id, name, dept_id]
 *                     where: [{ column: dept_id, operator: EQ, value: 10 }]
 *             astAggregate:
 *               summary: AST — aggregate + GROUP BY
 *               value:
 *                 config:
 *                   type: SELECT
 *                   schema: an_lab
 *                   limit: 10
 *                   query:
 *                     from: { resource: employees, source: An_Lab }
 *                     select: [dept_id, { aggregate: COUNT, column: '*', alias: n }]
 *                     groupBy: [dept_id]
 *     responses:
 *       200:
 *         description: Generated SQL (or a note if it could not transpile)
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 sql: { type: string, example: 'SELECT "id", "name", "region" FROM "public"."customers" WHERE "region" = ''EU'' LIMIT 25;' }
 *                 note: { type: string, example: RECURSIVE_IN_FABRIC }
 *                 error: { type: string }
 *       401: { description: Not authenticated, content: { application/json: { schema: { $ref: '#/components/schemas/ErrorResponse' } } } }
 *
 * /api/queries/status/{id}:
 *   get:
 *     summary: Retrieve background SQL job status
 *     tags: [Analytics]
 *     description: Alias of GET /api/queries/jobs/{id} — polls an async raw-SQL job.
 *     security: [{ bearerAuth: [] }]
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: string }
 *     responses:
 *       200: { description: Job status, content: { application/json: { schema: { $ref: '#/components/schemas/AsyncJobResponse' } } } }
 *       401: { description: Not authenticated, content: { application/json: { schema: { $ref: '#/components/schemas/ErrorResponse' } } } }
 *       403: { description: 'Tenant suspended', content: { application/json: { schema: { $ref: '#/components/schemas/ErrorResponse' } } } }
 *       404: { description: Job not found, content: { application/json: { schema: { type: object, properties: { status: { type: string, example: NOT_FOUND } } } } } }
 *       500: { description: Server error, content: { application/json: { schema: { $ref: '#/components/schemas/ErrorResponse' } } } }
 *
 * /api/analytics/query/status/{jobId}:
 *   get:
 *     summary: Check status of an analytics background job
 *     tags: [Analytics]
 *     description: Alias of GET /api/analytics/jobs/{jobId}.
 *     security: [{ bearerAuth: [] }]
 *     parameters:
 *       - in: path
 *         name: jobId
 *         required: true
 *         schema: { type: string }
 *     responses:
 *       200: { description: Job status, content: { application/json: { schema: { $ref: '#/components/schemas/AsyncJobResponse' } } } }
 *       401: { description: Not authenticated, content: { application/json: { schema: { $ref: '#/components/schemas/ErrorResponse' } } } }
 *       404: { description: Job not found, content: { application/json: { schema: { type: object, properties: { status: { type: string, example: NOT_FOUND } } } } } }
 *       500: { description: Server error, content: { application/json: { schema: { $ref: '#/components/schemas/ErrorResponse' } } } }
 */

/**
 * @swagger
 * /api/metadata/sources:
 *   get:
 *     summary: List registered data sources for the tenant
 *     tags: [Discovery]
 *     security: [{ bearerAuth: [] }]
 *     responses:
 *       200: { description: Sources, content: { application/json: { schema: { type: array, items: { $ref: '#/components/schemas/DataSource' } } } } }
 *       401: { description: Not authenticated, content: { application/json: { schema: { $ref: '#/components/schemas/ErrorResponse' } } } }
 *       500: { description: Server error, content: { application/json: { schema: { $ref: '#/components/schemas/ErrorResponse' } } } }
 *
 * /api/metadata/schemas:
 *   get:
 *     summary: List catalog schemas for a source
 *     tags: [Discovery]
 *     security: [{ bearerAuth: [] }]
 *     parameters:
 *       - in: query
 *         name: sourceId
 *         required: true
 *         schema: { type: string }
 *         description: Data source id to list schemas for.
 *     responses:
 *       200: { description: Schemas, content: { application/json: { schema: { type: array, items: { type: object, properties: { schemaId: { type: string }, name: { type: string }, physicalName: { type: string } } } } } } }
 *       400: { description: 'Missing sourceId', content: { application/json: { schema: { $ref: '#/components/schemas/ErrorResponse' }, example: { error: "sourceId is required" } } } }
 *       401: { description: Not authenticated, content: { application/json: { schema: { $ref: '#/components/schemas/ErrorResponse' } } } }
 *       500: { description: Server error, content: { application/json: { schema: { $ref: '#/components/schemas/ErrorResponse' } } } }
 *
 * /api/metadata/tables:
 *   get:
 *     summary: List catalog tables/resources for a schema
 *     tags: [Discovery]
 *     security: [{ bearerAuth: [] }]
 *     parameters:
 *       - in: query
 *         name: schemaId
 *         required: true
 *         schema: { type: string }
 *     responses:
 *       200: { description: Tables, content: { application/json: { schema: { type: array, items: { type: object, properties: { tableId: { type: string }, name: { type: string }, physicalName: { type: string }, rowCount: { type: integer }, resourceType: { type: string } } } } } } }
 *       400: { description: 'Missing schemaId', content: { application/json: { schema: { $ref: '#/components/schemas/ErrorResponse' }, example: { error: "schemaId is required" } } } }
 *       401: { description: Not authenticated, content: { application/json: { schema: { $ref: '#/components/schemas/ErrorResponse' } } } }
 *       500: { description: Server error, content: { application/json: { schema: { $ref: '#/components/schemas/ErrorResponse' } } } }
 *
 * /api/metadata/resource/{id}:
 *   get:
 *     summary: Get full details for a catalog resource
 *     tags: [Discovery]
 *     description: Returns physical name, resource type, definition SQL/AST, row count and owning source for a catalog table id.
 *     security: [{ bearerAuth: [] }]
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: string }
 *     responses:
 *       200:
 *         description: Resource detail
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 tableId: { type: string }
 *                 name: { type: string }
 *                 physicalName: { type: string }
 *                 resourceType: { type: string }
 *                 definitionSql: { type: string, nullable: true }
 *                 definitionAst: { type: object, nullable: true }
 *                 rowCount: { type: integer }
 *                 sourceType: { type: string }
 *                 sourceName: { type: string }
 *       401: { description: Not authenticated, content: { application/json: { schema: { $ref: '#/components/schemas/ErrorResponse' } } } }
 *       404: { description: Resource not found, content: { application/json: { schema: { $ref: '#/components/schemas/ErrorResponse' }, example: { error: "Resource not found" } } } }
 *       500: { description: Server error, content: { application/json: { schema: { $ref: '#/components/schemas/ErrorResponse' } } } }
 *
 * /api/metadata/columns:
 *   get:
 *     summary: Get column-level metadata for a resource
 *     tags: [Discovery]
 *     description: >
 *       Prefers the manifest's definition AST (rich: PK/strategy/constraints) and
 *       falls back to LIVE discovery from the real source. Pass `tableId`, or a
 *       `source`+`resource` pair to resolve it.
 *     security: [{ bearerAuth: [] }]
 *     parameters:
 *       - in: query
 *         name: tableId
 *         required: false
 *         schema: { type: string }
 *       - in: query
 *         name: source
 *         required: false
 *         schema: { type: string }
 *         description: With `resource`, resolves the tableId.
 *       - in: query
 *         name: resource
 *         required: false
 *         schema: { type: string }
 *     responses:
 *       200:
 *         description: Columns (with the source of truth)
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 source: { type: string, enum: [manifest, live], example: manifest }
 *                 columns: { type: array, items: { $ref: '#/components/schemas/ColumnDefinition' } }
 *                 constraints: { type: array, items: { type: object } }
 *       400: { description: 'Missing tableId (or source+resource)', content: { application/json: { schema: { $ref: '#/components/schemas/ErrorResponse' } } } }
 *       401: { description: Not authenticated, content: { application/json: { schema: { $ref: '#/components/schemas/ErrorResponse' } } } }
 *       404: { description: Resource not found, content: { application/json: { schema: { $ref: '#/components/schemas/ErrorResponse' } } } }
 *       500: { description: Server error, content: { application/json: { schema: { $ref: '#/components/schemas/ErrorResponse' } } } }
 *
 * /api/metadata/relationships:
 *   get:
 *     summary: List relationships (FKs / manifest relationships) for ER diagrams
 *     tags: [Discovery]
 *     security: [{ bearerAuth: [] }]
 *     parameters:
 *       - in: query
 *         name: schema
 *         required: false
 *         schema: { type: string }
 *         description: Filter to relationships touching this schema.
 *     responses:
 *       200:
 *         description: Relationships
 *         content:
 *           application/json:
 *             schema:
 *               type: array
 *               items:
 *                 type: object
 *                 properties:
 *                   name: { type: string }
 *                   sourceSchema: { type: string }
 *                   sourceTable: { type: string }
 *                   sourceColumn: { type: string }
 *                   targetSchema: { type: string }
 *                   targetTable: { type: string }
 *                   targetColumn: { type: string }
 *                   cardinality: { type: string, example: "1:M" }
 *       401: { description: Not authenticated, content: { application/json: { schema: { $ref: '#/components/schemas/ErrorResponse' } } } }
 *       500: { description: Server error, content: { application/json: { schema: { $ref: '#/components/schemas/ErrorResponse' } } } }
 *
 * /api/metadata/preview:
 *   get:
 *     summary: Preview sample rows from a catalog resource
 *     tags: [Discovery]
 *     description: Runs a bounded SELECT * {default 50 rows} via the query engine and returns a flat row array.
 *     security: [{ bearerAuth: [] }]
 *     parameters:
 *       - in: query
 *         name: tableId
 *         required: true
 *         schema: { type: string }
 *       - in: query
 *         name: limit
 *         required: false
 *         schema: { type: integer, default: 50 }
 *     responses:
 *       200: { description: Sample rows, content: { application/json: { schema: { type: array, items: { type: object } } } } }
 *       400: { description: 'Missing tableId', content: { application/json: { schema: { $ref: '#/components/schemas/ErrorResponse' }, example: { error: "tableId is required" } } } }
 *       401: { description: Not authenticated, content: { application/json: { schema: { $ref: '#/components/schemas/ErrorResponse' } } } }
 *       500: { description: Server error, content: { application/json: { schema: { $ref: '#/components/schemas/ErrorResponse' } } } }
 *
 * /api/metadata/export:
 *   get:
 *     summary: Export the live catalog as a re-applicable manifest
 *     tags: [Metadata]
 *     description: >
 *       Reverse of apply. Exports schemas, tables (with columns) and relationships
 *       as a datafabric manifest (served as a file download). Omit `source` for a
 *       multi-source manifest; pass `source` to export a single self-contained
 *       source (a `warnings` array flags cross-source dependencies).
 *     security: [{ bearerAuth: [] }]
 *     parameters:
 *       - in: query
 *         name: source
 *         required: false
 *         schema: { type: string }
 *     responses:
 *       200: { description: A manifest document (Content-Disposition attachment), content: { application/json: { schema: { $ref: '#/components/schemas/MetadataManifest' } } } }
 *       401: { description: Not authenticated, content: { application/json: { schema: { $ref: '#/components/schemas/ErrorResponse' } } } }
 *       500: { description: Server error, content: { application/json: { schema: { $ref: '#/components/schemas/ErrorResponse' } } } }
 *
 * /api/metadata/history:
 *   get:
 *     summary: List applied schema-orchestration versions (for rollback)
 *     tags: [Metadata]
 *     security: [{ bearerAuth: [] }]
 *     responses:
 *       200: { description: Version history, content: { application/json: { schema: { type: array, items: { type: object, properties: { id: { type: string }, appliedAt: { type: string, format: date-time }, summary: { type: object } } } } } } }
 *       401: { description: Not authenticated, content: { application/json: { schema: { $ref: '#/components/schemas/ErrorResponse' } } } }
 *       500: { description: Server error, content: { application/json: { schema: { $ref: '#/components/schemas/ErrorResponse' } } } }
 *
 * /api/metadata/rollback/{id}:
 *   post:
 *     summary: Roll the catalog back to a prior orchestration version
 *     tags: [Metadata]
 *     description: 'Re-applies the manifest captured at version (id). Destructive relative to the current state.'
 *     security: [{ bearerAuth: [] }]
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: string }
 *         description: Version id from /api/metadata/history.
 *     responses:
 *       200: { description: Rollback result, content: { application/json: { schema: { type: object } } } }
 *       401: { description: Not authenticated, content: { application/json: { schema: { $ref: '#/components/schemas/ErrorResponse' } } } }
 *       500: { description: Rollback failed, content: { application/json: { schema: { $ref: '#/components/schemas/ErrorResponse' } } } }
 *
 * /api/metadata/downstream:
 *   get:
 *     summary: Get status of downstream search/analytics targets
 *     tags: [Metadata]
 *     description: 'Always surfaces the canonical targets (ELASTICSEARCH, SNOWFLAKE) with live registry state + whether a connection exists.'
 *     security: [{ bearerAuth: [] }]
 *     responses:
 *       200:
 *         description: Downstream targets
 *         content:
 *           application/json:
 *             schema:
 *               type: array
 *               items:
 *                 type: object
 *                 properties:
 *                   target_type: { type: string, example: ELASTICSEARCH }
 *                   status: { type: string, enum: [ACTIVE, DISABLED, AVAILABLE, NOT_CONFIGURED], example: AVAILABLE }
 *                   config: { type: object }
 *                   connected: { type: boolean }
 *                   updated_at: { type: string, format: date-time, nullable: true }
 *       401: { description: Not authenticated, content: { application/json: { schema: { $ref: '#/components/schemas/ErrorResponse' } } } }
 *       500: { description: Server error, content: { application/json: { schema: { $ref: '#/components/schemas/ErrorResponse' } } } }
 *
 * /api/metadata/downstream/toggle:
 *   post:
 *     summary: Enable or disable a downstream target
 *     tags: [Metadata]
 *     description: >
 *       Upserts the downstream registry so a target can be enabled/disabled even
 *       with no manifest. If a manifest exists, the toggle is reflected in it and
 *       re-orchestrated (best-effort).
 *     security: [{ bearerAuth: [] }]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [targetType]
 *             properties:
 *               targetType: { type: string, enum: [ELASTICSEARCH, SNOWFLAKE], example: ELASTICSEARCH }
 *               enabled: { type: boolean, example: true }
 *     responses:
 *       200: { description: Toggled, content: { application/json: { schema: { type: object, properties: { status: { type: string, example: SUCCESS }, targetType: { type: string }, enabled: { type: boolean } } } } } }
 *       400: { description: 'Missing targetType', content: { application/json: { schema: { $ref: '#/components/schemas/ErrorResponse' }, example: { error: "targetType is required" } } } }
 *       401: { description: Not authenticated, content: { application/json: { schema: { $ref: '#/components/schemas/ErrorResponse' } } } }
 *       500: { description: Server error, content: { application/json: { schema: { $ref: '#/components/schemas/ErrorResponse' } } } }
 */

/**
 * @swagger
 * /api/policies:
 *   get:
 *     summary: List access policies for the tenant
 *     tags: [Security & Policies]
 *     security: [{ bearerAuth: [] }]
 *     responses:
 *       200: { description: Policies, content: { application/json: { schema: { type: array, items: { $ref: '#/components/schemas/Policy' } } } } }
 *       401: { description: Not authenticated, content: { application/json: { schema: { $ref: '#/components/schemas/ErrorResponse' } } } }
 *       500: { description: Server error, content: { application/json: { schema: { $ref: '#/components/schemas/ErrorResponse' } } } }
 *   post:
 *     summary: Create or update an access policy
 *     tags: [Security & Policies]
 *     description: 'Upserts by name. A policy must carry at least a rowFilter or a masking rule.'
 *     security: [{ bearerAuth: [] }]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema: { $ref: '#/components/schemas/Policy' }
 *           example:
 *             name: eng_analyst_rows
 *             schema: an_lab
 *             table: employees
 *             roles: [ANALYST]
 *             rowFilter: [{ column: dept_id, operator: EQ, value: 10 }]
 *             masking: [{ column: salary, roles: [ANALYST], strategy: REDACT }]
 *     responses:
 *       201: { description: Policy saved, content: { application/json: { schema: { $ref: '#/components/schemas/Policy' } } } }
 *       400: { description: 'Validation error', content: { application/json: { schema: { $ref: '#/components/schemas/ErrorResponse' }, examples: { fields: { value: { error: "name, schema and table are required" } }, rule: { value: { error: "a policy needs at least a rowFilter or masking rule" } } } } } }
 *       401: { description: Not authenticated, content: { application/json: { schema: { $ref: '#/components/schemas/ErrorResponse' } } } }
 *       500: { description: Server error, content: { application/json: { schema: { $ref: '#/components/schemas/ErrorResponse' } } } }
 *
 * /api/policies/{id}:
 *   delete:
 *     summary: Delete an access policy
 *     tags: [Security & Policies]
 *     security: [{ bearerAuth: [] }]
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: string }
 *     responses:
 *       200: { description: Deleted, content: { application/json: { schema: { type: object, properties: { status: { type: string, example: DELETED }, id: { type: string } } } } } }
 *       401: { description: Not authenticated, content: { application/json: { schema: { $ref: '#/components/schemas/ErrorResponse' } } } }
 *       404: { description: Policy not found, content: { application/json: { schema: { $ref: '#/components/schemas/ErrorResponse' }, example: { error: "policy not found" } } } }
 *       500: { description: Server error, content: { application/json: { schema: { $ref: '#/components/schemas/ErrorResponse' } } } }
 *
 * /api/constraints:
 *   get:
 *     summary: List engine-agnostic constraints for the tenant
 *     tags: [Security & Policies]
 *     security: [{ bearerAuth: [] }]
 *     responses:
 *       200: { description: Constraints, content: { application/json: { schema: { type: array, items: { $ref: '#/components/schemas/ConstraintSpec' } } } } }
 *       401: { description: Not authenticated, content: { application/json: { schema: { $ref: '#/components/schemas/ErrorResponse' } } } }
 *       500: { description: Server error, content: { application/json: { schema: { $ref: '#/components/schemas/ErrorResponse' } } } }
 *   post:
 *     summary: Create or update constraints for a table
 *     tags: [Security & Policies]
 *     description: 'Upserts constraints for (schema, table). Provide at least one column rule or check.'
 *     security: [{ bearerAuth: [] }]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema: { $ref: '#/components/schemas/ConstraintSpec' }
 *           example:
 *             schema: an_lab
 *             table: employees
 *             columns: [{ name: name, notNull: true }, { name: dept_id, notNull: true }]
 *             checks: [{ name: salary_positive, column: salary, op: GT, value: 0 }]
 *     responses:
 *       201: { description: Constraints saved, content: { application/json: { schema: { $ref: '#/components/schemas/ConstraintSpec' } } } }
 *       400: { description: 'Validation error', content: { application/json: { schema: { $ref: '#/components/schemas/ErrorResponse' }, examples: { fields: { value: { error: "schema and table are required" } }, empty: { value: { error: "provide at least one column rule or check" } } } } } }
 *       401: { description: Not authenticated, content: { application/json: { schema: { $ref: '#/components/schemas/ErrorResponse' } } } }
 *       500: { description: Server error, content: { application/json: { schema: { $ref: '#/components/schemas/ErrorResponse' } } } }
 *
 * /api/grants:
 *   get:
 *     summary: List engine-agnostic table grants for the tenant
 *     tags: [Security & Policies]
 *     security: [{ bearerAuth: [] }]
 *     responses:
 *       200: { description: Grants, content: { application/json: { schema: { type: array, items: { $ref: '#/components/schemas/Grant' } } } } }
 *       401: { description: Not authenticated, content: { application/json: { schema: { $ref: '#/components/schemas/ErrorResponse' } } } }
 *       500: { description: Server error, content: { application/json: { schema: { $ref: '#/components/schemas/ErrorResponse' } } } }
 *   post:
 *     summary: Create or update grants for a table
 *     tags: [Security & Policies]
 *     description: 'Upserts privileges for (schema, table). Enforcement is default-allow until grants are declared; ADMIN always passes.'
 *     security: [{ bearerAuth: [] }]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema: { $ref: '#/components/schemas/Grant' }
 *           example:
 *             schema: an_lab
 *             table: employees
 *             grants: [{ role: ANALYST, privileges: [SELECT] }, { role: EDITOR, privileges: [SELECT, INSERT, UPDATE] }]
 *     responses:
 *       201: { description: Grants saved, content: { application/json: { schema: { $ref: '#/components/schemas/Grant' } } } }
 *       400: { description: 'Validation error', content: { application/json: { schema: { $ref: '#/components/schemas/ErrorResponse' }, example: { error: "schema, table and a non-empty grants[] are required" } } } }
 *       401: { description: Not authenticated, content: { application/json: { schema: { $ref: '#/components/schemas/ErrorResponse' } } } }
 *       500: { description: Server error, content: { application/json: { schema: { $ref: '#/components/schemas/ErrorResponse' } } } }
 */

/**
 * @swagger
 * /api/saved-analytics:
 *   get:
 *     summary: List saved analytics for the tenant
 *     tags: [Saved Analytics]
 *     security: [{ bearerAuth: [] }]
 *     responses:
 *       200: { description: Saved analytics, content: { application/json: { schema: { type: array, items: { $ref: '#/components/schemas/SavedAnalytic' } } } } }
 *       401: { description: Not authenticated, content: { application/json: { schema: { $ref: '#/components/schemas/ErrorResponse' } } } }
 *       500: { description: Server error, content: { application/json: { schema: { $ref: '#/components/schemas/ErrorResponse' } } } }
 *   post:
 *     summary: Create a saved analytic
 *     tags: [Saved Analytics]
 *     description: 'AST mode requires `config`; SQL mode requires `sql`. Declared `variables` are bound via `{{name}}` at run time.'
 *     security: [{ bearerAuth: [] }]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema: { $ref: '#/components/schemas/SavedAnalytic' }
 *           examples:
 *             astMode:
 *               summary: AST mode (queryConfig in `config`)
 *               value:
 *                 name: headcount_by_dept
 *                 description: Headcount per department
 *                 mode: AST
 *                 config:
 *                   type: SELECT
 *                   schema: an_lab
 *                   limit: 10
 *                   query:
 *                     from: { resource: employees, source: An_Lab }
 *                     select: ['*']
 *                     where: [{ column: dept_id, operator: EQ, value: "{{dept}}" }]
 *                 variables: [{ name: dept, type: number, default: 10 }]
 *             sqlMode:
 *               summary: SQL mode (`sql` is top-level, not inside config)
 *               value:
 *                 name: server_time
 *                 description: Hub server time
 *                 mode: SQL
 *                 sql: "SELECT now() AS server_time"
 *                 variables: []
 *     responses:
 *       201: { description: Created, content: { application/json: { schema: { $ref: '#/components/schemas/SavedAnalytic' } } } }
 *       400: { description: 'Validation error (name required / mode body missing)', content: { application/json: { schema: { $ref: '#/components/schemas/ErrorResponse' }, example: { error: "name is required" } } } }
 *       401: { description: Not authenticated, content: { application/json: { schema: { $ref: '#/components/schemas/ErrorResponse' } } } }
 *       500: { description: Server error, content: { application/json: { schema: { $ref: '#/components/schemas/ErrorResponse' } } } }
 *
 * /api/saved-analytics/top:
 *   get:
 *     summary: List the most-run saved analytics
 *     tags: [Saved Analytics]
 *     security: [{ bearerAuth: [] }]
 *     parameters:
 *       - in: query
 *         name: limit
 *         required: false
 *         schema: { type: integer, default: 8 }
 *     responses:
 *       200: { description: Top analytics by run count, content: { application/json: { schema: { type: array, items: { $ref: '#/components/schemas/SavedAnalytic' } } } } }
 *       401: { description: Not authenticated, content: { application/json: { schema: { $ref: '#/components/schemas/ErrorResponse' } } } }
 *       500: { description: Server error, content: { application/json: { schema: { $ref: '#/components/schemas/ErrorResponse' } } } }
 *
 * /api/saved-analytics/{id}:
 *   get:
 *     summary: Get one saved analytic
 *     tags: [Saved Analytics]
 *     security: [{ bearerAuth: [] }]
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: string }
 *     responses:
 *       200: { description: The analytic, content: { application/json: { schema: { $ref: '#/components/schemas/SavedAnalytic' } } } }
 *       401: { description: Not authenticated, content: { application/json: { schema: { $ref: '#/components/schemas/ErrorResponse' } } } }
 *       404: { description: Not found, content: { application/json: { schema: { $ref: '#/components/schemas/ErrorResponse' }, example: { error: "analytic not found" } } } }
 *       500: { description: Server error, content: { application/json: { schema: { $ref: '#/components/schemas/ErrorResponse' } } } }
 *   delete:
 *     summary: Delete a saved analytic
 *     tags: [Saved Analytics]
 *     security: [{ bearerAuth: [] }]
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: string }
 *     responses:
 *       200: { description: Deleted, content: { application/json: { schema: { type: object, properties: { status: { type: string, example: DELETED }, id: { type: string } } } } } }
 *       401: { description: Not authenticated, content: { application/json: { schema: { $ref: '#/components/schemas/ErrorResponse' } } } }
 *       404: { description: Not found, content: { application/json: { schema: { $ref: '#/components/schemas/ErrorResponse' }, example: { error: "analytic not found" } } } }
 *       500: { description: Server error, content: { application/json: { schema: { $ref: '#/components/schemas/ErrorResponse' } } } }
 *
 * /api/saved-analytics/{id}/run:
 *   post:
 *     summary: Run a saved analytic with variable values
 *     tags: [Saved Analytics]
 *     description: >
 *       Executes the analytic, binding the supplied variable values into its query.
 *       Body may be `{variables: {...}}` or a bare `(...)` of name→value. The run
 *       is captured in the query log; the response is the standard query envelope.
 *     security: [{ bearerAuth: [] }]
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: string }
 *     requestBody:
 *       required: false
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               variables: { type: object, additionalProperties: true }
 *           example: { variables: { dept: 20 } }
 *     responses:
 *       200: { description: Result rows + execution plan/trace, content: { application/json: { schema: { $ref: '#/components/schemas/QueryEnvelope' } } } }
 *       400: { description: 'Missing required variable', content: { application/json: { schema: { $ref: '#/components/schemas/ErrorResponse' }, example: { error: "missing required variable: segment" } } } }
 *       401: { description: Not authenticated, content: { application/json: { schema: { $ref: '#/components/schemas/ErrorResponse' } } } }
 *       404: { description: Analytic not found, content: { application/json: { schema: { $ref: '#/components/schemas/ErrorResponse' } } } }
 *       500: { description: Execution failed, content: { application/json: { schema: { $ref: '#/components/schemas/ErrorResponse' } } } }
 *
 * /api/query-logs:
 *   get:
 *     summary: List recent query executions (audit trail)
 *     tags: [Governance]
 *     security: [{ bearerAuth: [] }]
 *     parameters:
 *       - in: query
 *         name: limit
 *         required: false
 *         schema: { type: integer, default: 200 }
 *       - in: query
 *         name: status
 *         required: false
 *         schema: { type: string, enum: [SUCCESS, ERROR] }
 *       - in: query
 *         name: mode
 *         required: false
 *         schema: { type: string }
 *         description: Filter by execution mode (e.g. SELECT_AST, SQL_ON_SOURCE, CRUD_CREATE).
 *     responses:
 *       200: { description: Query logs, content: { application/json: { schema: { type: array, items: { $ref: '#/components/schemas/QueryLog' } } } } }
 *       401: { description: Not authenticated, content: { application/json: { schema: { $ref: '#/components/schemas/ErrorResponse' } } } }
 *       500: { description: Server error, content: { application/json: { schema: { $ref: '#/components/schemas/ErrorResponse' } } } }
 *
 * /api/query-logs/{id}:
 *   get:
 *     summary: Get a single query-log entry in full
 *     tags: [Governance]
 *     security: [{ bearerAuth: [] }]
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: string }
 *     responses:
 *       200: { description: The log entry, content: { application/json: { schema: { $ref: '#/components/schemas/QueryLog' } } } }
 *       401: { description: Not authenticated, content: { application/json: { schema: { $ref: '#/components/schemas/ErrorResponse' } } } }
 *       404: { description: Not found, content: { application/json: { schema: { $ref: '#/components/schemas/ErrorResponse' }, example: { error: "query log not found" } } } }
 *       500: { description: Server error, content: { application/json: { schema: { $ref: '#/components/schemas/ErrorResponse' } } } }
 *
 * /api/events:
 *   get:
 *     summary: Recent data-change events for the tenant
 *     tags: [Governance]
 *     description: Returns the 10 most recent audit-log rows (INSERT/UPDATE/DELETE) as change events for dashboards.
 *     security: [{ bearerAuth: [] }]
 *     responses:
 *       200:
 *         description: Recent events
 *         content:
 *           application/json:
 *             schema:
 *               type: array
 *               items:
 *                 type: object
 *                 properties:
 *                   id: { type: string }
 *                   action: { type: string, enum: [INSERT, UPDATE, DELETE] }
 *                   tableName: { type: string }
 *                   createdAt: { type: string, format: date-time }
 *                   details: { type: object }
 *       401: { description: Not authenticated, content: { application/json: { schema: { $ref: '#/components/schemas/ErrorResponse' } } } }
 *       500: { description: Server error, content: { application/json: { schema: { $ref: '#/components/schemas/ErrorResponse' } } } }
 */

/**
 * @swagger
 * /api/triggers:
 *   get:
 *     summary: List triggers for the tenant
 *     tags: [Automation]
 *     security: [{ bearerAuth: [] }]
 *     responses:
 *       200: { description: Triggers, content: { application/json: { schema: { type: array, items: { $ref: '#/components/schemas/Trigger' } } } } }
 *       401: { description: Not authenticated, content: { application/json: { schema: { $ref: '#/components/schemas/ErrorResponse' } } } }
 *       500: { description: Server error, content: { application/json: { schema: { $ref: '#/components/schemas/ErrorResponse' } } } }
 *   post:
 *     summary: Create (or upsert) a trigger
 *     tags: [Automation]
 *     description: >
 *       Registers a trigger. Row-based triggers require `definition.event` plus
 *       schemaName+tableName; scheduled triggers supply `definition.schedule`
 *       instead. `definition.execute.type` is always required.
 *     security: [{ bearerAuth: [] }]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema: { $ref: '#/components/schemas/Trigger' }
 *           example:
 *             triggerName: notify_new_employee
 *             schemaName: an_lab
 *             tableName: employees
 *             definition:
 *               event: INSERT
 *               timing: AFTER
 *               execute: { type: WEBHOOK, url: "https://hooks.example.com/employees" }
 *     responses:
 *       201: { description: Created, content: { application/json: { schema: { $ref: '#/components/schemas/Trigger' } } } }
 *       400: { description: 'Validation error', content: { application/json: { schema: { $ref: '#/components/schemas/ErrorResponse' }, examples: { fields: { value: { error: "triggerName and definition are required" } }, exec: { value: { error: "definition.execute.type is required" } }, event: { value: { error: "definition.event is required for row-based triggers" } } } } } }
 *       401: { description: Not authenticated, content: { application/json: { schema: { $ref: '#/components/schemas/ErrorResponse' } } } }
 *
 * /api/triggers/{id}:
 *   put:
 *     summary: Update a trigger
 *     tags: [Automation]
 *     security: [{ bearerAuth: [] }]
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: string }
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema: { $ref: '#/components/schemas/Trigger' }
 *     responses:
 *       200: { description: Updated, content: { application/json: { schema: { $ref: '#/components/schemas/Trigger' } } } }
 *       400: { description: 'Validation error / trigger not found', content: { application/json: { schema: { $ref: '#/components/schemas/ErrorResponse' }, examples: { id: { value: { error: "id is required" } }, missing: { value: { error: "Trigger not found" } } } } } }
 *       401: { description: Not authenticated, content: { application/json: { schema: { $ref: '#/components/schemas/ErrorResponse' } } } }
 *   delete:
 *     summary: Delete a trigger (marks PENDING_DELETE and undeploys)
 *     tags: [Automation]
 *     security: [{ bearerAuth: [] }]
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: string }
 *     responses:
 *       200: { description: Enqueued for deletion, content: { application/json: { schema: { type: object, properties: { status: { type: string, example: SUCCESS } } } } } }
 *       400: { description: 'Missing id / trigger not found', content: { application/json: { schema: { $ref: '#/components/schemas/ErrorResponse' } } } }
 *       401: { description: Not authenticated, content: { application/json: { schema: { $ref: '#/components/schemas/ErrorResponse' } } } }
 *
 * /api/triggers/{id}/deploy:
 *   post:
 *     summary: Deploy a trigger (enqueue a deploy job)
 *     tags: [Automation]
 *     description: Marks the trigger PENDING_DEPLOY and enqueues a durable job that installs it at the source.
 *     security: [{ bearerAuth: [] }]
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: string }
 *     responses:
 *       200: { description: Enqueued, content: { application/json: { schema: { type: object, properties: { status: { type: string, example: ENQUEUED }, jobId: { type: string } } } } } }
 *       400: { description: 'Missing id / deploy error', content: { application/json: { schema: { $ref: '#/components/schemas/ErrorResponse' } } } }
 *       401: { description: Not authenticated, content: { application/json: { schema: { $ref: '#/components/schemas/ErrorResponse' } } } }
 *
 * /api/triggers/logs/list:
 *   get:
 *     summary: List trigger activity logs
 *     tags: [Automation]
 *     security: [{ bearerAuth: [] }]
 *     parameters:
 *       - in: query
 *         name: triggerId
 *         required: false
 *         schema: { type: string }
 *       - in: query
 *         name: limit
 *         required: false
 *         schema: { type: integer, default: 50 }
 *       - in: query
 *         name: offset
 *         required: false
 *         schema: { type: integer, default: 0 }
 *     responses:
 *       200: { description: Trigger logs, content: { application/json: { schema: { type: array, items: { $ref: '#/components/schemas/TriggerLog' } } } } }
 *       401: { description: Not authenticated, content: { application/json: { schema: { $ref: '#/components/schemas/ErrorResponse' } } } }
 *       500: { description: Server error, content: { application/json: { schema: { $ref: '#/components/schemas/ErrorResponse' } } } }
 *
 * /api/triggers/jobs/list:
 *   get:
 *     summary: List durable trigger jobs (execution queue)
 *     tags: [Automation]
 *     security: [{ bearerAuth: [] }]
 *     responses:
 *       200: { description: Trigger jobs, content: { application/json: { schema: { type: array, items: { $ref: '#/components/schemas/TriggerJob' } } } } }
 *       401: { description: Not authenticated, content: { application/json: { schema: { $ref: '#/components/schemas/ErrorResponse' } } } }
 *       500: { description: Server error, content: { application/json: { schema: { $ref: '#/components/schemas/ErrorResponse' } } } }
 *
 * /api/triggers/jobs/{id}/retry:
 *   post:
 *     summary: Retry a failed trigger job
 *     tags: [Automation]
 *     description: Resets the job to PENDING with run_at=NOW so the worker picks it up again.
 *     security: [{ bearerAuth: [] }]
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: string }
 *     responses:
 *       200: { description: Re-enqueued, content: { application/json: { schema: { type: object, properties: { status: { type: string, example: ENQUEUED }, jobId: { type: string } } } } } }
 *       400: { description: 'Missing id / retry error', content: { application/json: { schema: { $ref: '#/components/schemas/ErrorResponse' } } } }
 *       401: { description: Not authenticated, content: { application/json: { schema: { $ref: '#/components/schemas/ErrorResponse' } } } }
 *
 * /api/admin/stats:
 *   get:
 *     summary: Platform dashboard counters (Admin only)
 *     tags: [Monitoring]
 *     description: Returns counts of tenants, connections and audit events in the last 24h.
 *     security: [{ bearerAuth: [] }]
 *     responses:
 *       200: { description: Counters, content: { application/json: { schema: { type: object, properties: { tenants: { type: integer, example: 3 }, connections: { type: integer, example: 5 }, audits: { type: integer, example: 128 } } } } } }
 *       401: { description: Not authenticated, content: { application/json: { schema: { $ref: '#/components/schemas/ErrorResponse' } } } }
 *       403: { description: Caller is not an ADMIN, content: { application/json: { schema: { $ref: '#/components/schemas/ErrorResponse' } } } }
 *       500: { description: Server error, content: { application/json: { schema: { $ref: '#/components/schemas/ErrorResponse' } } } }
 *
 * /api/admin/notification-channels:
 *   get:
 *     summary: List notification channels (Admin only)
 *     tags: [Monitoring]
 *     security: [{ bearerAuth: [] }]
 *     responses:
 *       200:
 *         description: Channels
 *         content:
 *           application/json:
 *             schema:
 *               type: array
 *               items:
 *                 type: object
 *                 properties:
 *                   id: { type: string }
 *                   channelType: { type: string, example: SLACK }
 *                   name: { type: string, example: ops-alerts }
 *                   config: { type: object }
 *                   isDefault: { type: boolean }
 *                   status: { type: string, example: ACTIVE }
 *                   updatedAt: { type: string, format: date-time }
 *       401: { description: Not authenticated, content: { application/json: { schema: { $ref: '#/components/schemas/ErrorResponse' } } } }
 *       403: { description: Caller is not an ADMIN, content: { application/json: { schema: { $ref: '#/components/schemas/ErrorResponse' } } } }
 *       500: { description: Server error, content: { application/json: { schema: { $ref: '#/components/schemas/ErrorResponse' } } } }
 *   post:
 *     summary: Create or update a notification channel (Admin only)
 *     tags: [Monitoring]
 *     description: 'Upserts by (channelType, name). Setting isDefault=true clears the default flag on other channels of the same type.'
 *     security: [{ bearerAuth: [] }]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [channelType, name, config]
 *             properties:
 *               channelType: { type: string, example: WEBHOOK }
 *               name: { type: string, example: ops-alerts }
 *               config: { type: object, example: { url: "https://hooks.example.com/notify" } }
 *               isDefault: { type: boolean, default: false }
 *               status: { type: string, default: ACTIVE }
 *     responses:
 *       200: { description: Saved channel }
 *       400: { description: 'Missing channelType/name/config', content: { application/json: { schema: { $ref: '#/components/schemas/ErrorResponse' }, example: { error: "channelType, name, config required" } } } }
 *       401: { description: Not authenticated, content: { application/json: { schema: { $ref: '#/components/schemas/ErrorResponse' } } } }
 *       403: { description: Caller is not an ADMIN, content: { application/json: { schema: { $ref: '#/components/schemas/ErrorResponse' } } } }
 *       500: { description: Server error, content: { application/json: { schema: { $ref: '#/components/schemas/ErrorResponse' } } } }
 *
 * /api/admin/notification-channels/{id}:
 *   delete:
 *     summary: Delete a notification channel (Admin only)
 *     tags: [Monitoring]
 *     security: [{ bearerAuth: [] }]
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: string }
 *     responses:
 *       200: { description: Deleted, content: { application/json: { schema: { type: object, properties: { status: { type: string, example: SUCCESS } } } } } }
 *       401: { description: Not authenticated, content: { application/json: { schema: { $ref: '#/components/schemas/ErrorResponse' } } } }
 *       403: { description: Caller is not an ADMIN, content: { application/json: { schema: { $ref: '#/components/schemas/ErrorResponse' } } } }
 *       500: { description: Server error, content: { application/json: { schema: { $ref: '#/components/schemas/ErrorResponse' } } } }
 *
 * /api/admin/notification-channels/test:
 *   post:
 *     summary: Enqueue a test notification (Admin only)
 *     tags: [Monitoring]
 *     description: Enqueues a synthetic trigger job that exercises a channel end-to-end.
 *     security: [{ bearerAuth: [] }]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [channelType]
 *             properties:
 *               channelType: { type: string, example: WEBHOOK }
 *               name: { type: string, example: ops-alerts }
 *               sample: { type: object, description: 'Channel-specific fields merged into the test payload.' }
 *     responses:
 *       200: { description: Enqueued, content: { application/json: { schema: { type: object, properties: { status: { type: string, example: ENQUEUED }, jobId: { type: string } } } } } }
 *       400: { description: 'Missing channelType', content: { application/json: { schema: { $ref: '#/components/schemas/ErrorResponse' }, example: { error: "channelType required" } } } }
 *       401: { description: Not authenticated, content: { application/json: { schema: { $ref: '#/components/schemas/ErrorResponse' } } } }
 *       403: { description: Caller is not an ADMIN, content: { application/json: { schema: { $ref: '#/components/schemas/ErrorResponse' } } } }
 *       500: { description: Server error, content: { application/json: { schema: { $ref: '#/components/schemas/ErrorResponse' } } } }
 */
