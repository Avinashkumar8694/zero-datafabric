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
 *               source: { type: string, example: An_Lab, description: 'Datasource name; omit for the hub.' }
 *               schema: { type: string, example: an_lab }
 *               resource: { type: string, example: employees }
 *               columns: { type: array, items: { type: string }, example: [id, name, dept_id] }
 *               where: { type: object, example: { dept_id: 10, salary: { $gt: 200 } } }
 *               orderBy: { type: array, items: { type: object }, example: [{ column: salary, direction: DESC }] }
 *               limit: { type: integer, example: 25 }
 *               offset: { type: integer, example: 0 }
 *           examples:
 *             simple: { summary: Equality filter, value: { source: An_Lab, schema: an_lab, resource: employees, columns: [id, name, dept_id], where: { dept_id: 10 }, limit: 5 } }
 *             operators: { summary: Operator filter + sort, value: { source: An_Lab, schema: an_lab, resource: employees, where: { salary: { $gt: 200 } }, orderBy: [{ column: salary, direction: DESC }], limit: 5 } }
 *             mongo: { summary: Another collection (departments), value: { source: An_Lab, schema: an_lab, resource: departments, where: { id: 10 }, limit: 5 } }
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
 *               source: { type: string, example: An_Lab }
 *               schema: { type: string, example: an_lab }
 *               resource: { type: string, example: employees }
 *               data:
 *                 description: A single object or an array of objects.
 *                 oneOf: [{ type: object }, { type: array, items: { type: object } }]
 *           examples:
 *             single: { summary: Single row, value: { source: An_Lab, schema: an_lab, resource: employees, data: { id: 9001, name: New Hire, manager_id: 2, dept_id: 10, salary: 120 } } }
 *             batch: { summary: Batch insert, value: { source: An_Lab, schema: an_lab, resource: employees, data: [{ id: 9002, name: Hire B, manager_id: 2, dept_id: 10, salary: 110 }, { id: 9003, name: Hire C, manager_id: 3, dept_id: 20, salary: 115 }] } }
 *             mongo: { summary: Another collection (departments), value: { source: An_Lab, schema: an_lab, resource: departments, data: { id: 90, name: Research } } }
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
 *               source: { type: string, example: An_Lab }
 *               schema: { type: string, example: an_lab }
 *               resource: { type: string, example: employees }
 *               where: { type: object, example: { id: 9001 } }
 *               data: { type: object, example: { salary: 150, dept_id: 20 } }
 *           example: { source: An_Lab, schema: an_lab, resource: employees, where: { id: 9001 }, data: { salary: 150 } }
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
 *               source: { type: string, example: An_Lab }
 *               schema: { type: string, example: an_lab }
 *               resource: { type: string, example: employees }
 *               where: { type: object, example: { id: 9001 } }
 *           example: { source: An_Lab, schema: an_lab, resource: employees, where: { id: 9001 } }
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
