/**
 * OpenAPI annotations for the simple CRUD façade (/api/data/*) and the metadata
 * orchestration endpoints (diff / apply / export). Scanned by swagger-jsdoc.
 *
 * @swagger
 * tags:
 *   - name: Data
 *     description: >
 *       Simple REST-style CRUD over federated sources. Each endpoint takes an
 *       ergonomic JSON body {{ source?, schema?, resource, where?, data?, ... }}.
 *       `fetch` reads through the full planner/federation path {cross-source +
 *       pushdown + trace}. `create`/`update`/`delete` run at the owning source —
 *       remote Postgres via parameterized SQL, MongoDB via native document ops.
 *       `update` and `delete` require a `where` (unrestricted mutations are blocked).
 *   - name: Metadata Orchestration
 *     description: Diff / apply declarative manifests and export the live catalog as a manifest.
 *
 * /api/data/fetch:
 *   post:
 *     summary: Read rows from a resource (any source)
 *     tags: [Data]
 *     description: >
 *       Reads a single resource. `where` accepts `(col: value)` (equality) or
 *       `{col: { $op: value }}` with $eq $ne $gt $gte $lt $lte $like $ilike $in.
 *       Runs through the planner so it works on hub, remote Postgres, or Mongo, with
 *       predicate/projection/sort/limit pushed to the source. Response includes the
 *       execution trace.
 *     security: [{ bearerAuth: [] }]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [resource]
 *             properties:
 *               source: { type: string, example: Retail_Core, description: 'Datasource name; omit for the hub.' }
 *               schema: { type: string, example: public }
 *               resource: { type: string, example: customers }
 *               columns: { type: array, items: { type: string }, example: [id, name, region] }
 *               where: { type: object, example: { region: EU, lifetime_value: { $gt: 45000 } } }
 *               orderBy: { type: array, items: { type: object }, example: [{ column: lifetime_value, direction: DESC }] }
 *               limit: { type: integer, example: 25 }
 *               offset: { type: integer, example: 0 }
 *           examples:
 *             simple: { summary: Equality filter, value: { source: Retail_Core, resource: customers, columns: [id, name, region], where: { region: EU }, limit: 3 } }
 *             operators: { summary: Operator filter + sort, value: { source: Retail_Core, resource: customers, where: { lifetime_value: { $gt: 45000 } }, orderBy: [{ column: lifetime_value, direction: DESC }], limit: 3 } }
 *             mongo: { summary: Mongo source, value: { source: Web_Analytics, resource: web_events, where: { event_type: checkout }, limit: 5 } }
 *     responses:
 *       200:
 *         description: Result rows + execution plan/trace
 *         content:
 *           application/json:
 *             schema: { $ref: '#/components/schemas/QueryEnvelope' }
 *
 * /api/data/create:
 *   post:
 *     summary: Insert one or many rows
 *     tags: [Data]
 *     description: 'Insert a row (object) or rows (array) into a resource. Remote Postgres → parameterized INSERT … RETURNING *; MongoDB → insertMany.'
 *     security: [{ bearerAuth: [] }]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [resource, data]
 *             properties:
 *               source: { type: string, example: Retail_Core }
 *               schema: { type: string, example: public }
 *               resource: { type: string, example: customers }
 *               data:
 *                 description: A single object or an array of objects.
 *                 oneOf: [{ type: object }, { type: array, items: { type: object } }]
 *           examples:
 *             single: { summary: Single row, value: { source: Retail_Core, resource: customers, data: { id: 900001, name: Acme, region: NA, segment: SMB, signup_date: '2026-01-01', lifetime_value: 100 } } }
 *             batch: { summary: Batch insert, value: { source: Retail_Core, resource: customers, data: [{ id: 900002, name: B, region: EU, segment: GOV, signup_date: '2026-01-02', lifetime_value: 200 }] } }
 *             mongo: { summary: Mongo document, value: { source: Web_Analytics, resource: web_events, data: { event_id: 900001, customer_id: 1, event_type: checkout, revenue: 42 } } }
 *     responses:
 *       200:
 *         description: Insert result + plan/trace
 *         content:
 *           application/json:
 *             schema: { $ref: '#/components/schemas/WriteEnvelope' }
 *       400: { description: 'Missing resource/data', content: { application/json: { schema: { $ref: '#/components/schemas/ErrorResponse' } } } }
 *
 * /api/data/update:
 *   post:
 *     summary: Update rows matching a filter (where required)
 *     tags: [Data]
 *     description: 'Sets `data` fields on rows matching `where`. A `where` is REQUIRED. Remote Postgres → UPDATE … WHERE … RETURNING *; MongoDB → updateMany($set).'
 *     security: [{ bearerAuth: [] }]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [resource, where, data]
 *             properties:
 *               source: { type: string, example: Retail_Core }
 *               schema: { type: string }
 *               resource: { type: string, example: customers }
 *               where: { type: object, example: { id: 900001 } }
 *               data: { type: object, example: { lifetime_value: 9999, segment: ENTERPRISE } }
 *           example: { source: Retail_Core, resource: customers, where: { id: 900001 }, data: { lifetime_value: 9999 } }
 *     responses:
 *       200: { description: 'Update result + plan/trace', content: { application/json: { schema: { $ref: '#/components/schemas/WriteEnvelope' } } } }
 *       400: { description: 'Missing where (safety) / data', content: { application/json: { schema: { $ref: '#/components/schemas/ErrorResponse' } } } }
 *
 * /api/data/delete:
 *   post:
 *     summary: Delete rows matching a filter (where required)
 *     tags: [Data]
 *     description: 'Deletes rows matching `where`. A `where` is REQUIRED. Remote Postgres → DELETE … WHERE … RETURNING *; MongoDB → deleteMany.'
 *     security: [{ bearerAuth: [] }]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [resource, where]
 *             properties:
 *               source: { type: string, example: Web_Analytics }
 *               schema: { type: string }
 *               resource: { type: string, example: web_events }
 *               where: { type: object, example: { event_id: 900001 } }
 *           example: { source: Web_Analytics, resource: web_events, where: { event_id: 900001 } }
 *     responses:
 *       200: { description: 'Delete result + plan/trace', content: { application/json: { schema: { $ref: '#/components/schemas/WriteEnvelope' } } } }
 *       400: { description: 'Missing where (safety)', content: { application/json: { schema: { $ref: '#/components/schemas/ErrorResponse' } } } }
 *
 * /api/metadata/diff:
 *   post:
 *     summary: Diff a manifest against the live catalog (dry run)
 *     tags: [Metadata Orchestration]
 *     description: 'Upload a manifest (.json) as multipart form field `file`. Returns the ordered orchestration plan (CREATE_SCHEMA / CREATE_TABLE / CREATE_ENUM / PROVISION_RELATIONSHIP / …) without executing anything.'
 *     security: [{ bearerAuth: [] }]
 *     requestBody:
 *       required: true
 *       content:
 *         multipart/form-data:
 *           schema:
 *             type: object
 *             properties:
 *               file: { type: string, format: binary, description: 'Manifest JSON file.' }
 *     responses:
 *       200:
 *         description: Planned operations
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 changes: { type: array, items: { type: object }, example: [{ action: CREATE_SCHEMA, target: HR_Example }, { action: CREATE_TABLE, table: employees }] }
 *
 * /api/metadata/apply:
 *   post:
 *     summary: Apply a manifest (orchestrate DDL across sources)
 *     tags: [Metadata Orchestration]
 *     description: 'Upload a manifest as multipart field `file`. Executes the plan on the tenant''s managed schemas and dispatches to external sources under SAGA consistency (non-fatal external legs are marked DEGRADED, not aborted).'
 *     security: [{ bearerAuth: [] }]
 *     requestBody:
 *       required: true
 *       content:
 *         multipart/form-data:
 *           schema:
 *             type: object
 *             properties:
 *               file: { type: string, format: binary }
 *     responses:
 *       200:
 *         description: Per-operation results
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 results: { type: array, items: { type: object }, example: [{ action: CREATE_TABLE, target: employees, status: SUCCESS }] }
 *
 * /api/metadata/export:
 *   get:
 *     summary: Export the live catalog as a re-applicable manifest
 *     tags: [Metadata Orchestration]
 *     description: >
 *       Reverse of apply. Exports the current schemas, tables (with columns) and
 *       relationships as a datafabric manifest. Omit `source` for a multi-source
 *       manifest; pass `source` to export a single self-contained source {a
 *       `warnings` array flags any resource that depends on another datasource}.
 *     security: [{ bearerAuth: [] }]
 *     parameters:
 *       - in: query
 *         name: source
 *         required: false
 *         schema: { type: string }
 *         description: Export just this datasource.
 *     responses:
 *       200:
 *         description: A manifest document
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 version: { type: string, example: 1.0-export }
 *                 namespace: { type: string }
 *                 targetSource: { type: string }
 *                 schemas: { type: array, items: { type: object } }
 *                 relationships: { type: array, items: { type: object } }
 *                 warnings: { type: array, items: { type: string } }
 */
export {};
