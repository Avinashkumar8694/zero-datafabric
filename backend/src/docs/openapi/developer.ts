/**
 * Developer (integrator) operations + the developer OpenAPI document.
 * The system document re-uses every operation exported here (see system.ts).
 */
import { AUTH_GUIDE, OpDef, TagDef, TagGroup, buildSpec, ex, jsonBody, pp, q, ref, refArray, Json } from './shared';
import { tokenOps, tokenTags } from './tokens';
import { workspaceReadOps, workspaceTagsForDeveloper } from './tenancy';

/* ---------------- tag names ---------------- */
const T = {
  auth: 'Authentication',
  data: 'Data (CRUD)',
  engine: 'Query Engine (AST)',
  analytics: 'Analytics',
  saved: 'Saved Analytics',
  catalog: 'Metadata & Catalog',
  orchestration: 'Metadata Orchestration',
  governance: 'Governance',
  triggers: 'Triggers',
  replication: 'Replication',
  logs: 'Query Logs',
  events: 'Events',
};

/* ---------------- shared example payloads ---------------- */
const filterQuery = {
  type: 'SELECT',
  schema: 'an_lab',
  limit: 10,
  query: { from: { resource: 'employees', source: 'An_Lab' }, select: ['id', 'name', 'dept_id'], where: [{ column: 'dept_id', operator: 'EQ', value: 10 }] },
};
const aggregateQuery = {
  type: 'SELECT',
  schema: 'an_lab',
  limit: 10,
  query: { from: { resource: 'employees', source: 'An_Lab' }, groupBy: ['dept_id'], select: ['dept_id', { aggregate: 'COUNT', column: '*', alias: 'n' }] },
};
const joinQuery = {
  type: 'SELECT',
  limit: 50,
  query: {
    from: { resource: 'orders', source: 'Retail_Core', alias: 'o' },
    select: ['o.id', 'o.region', 'w.last_seen'],
    joins: [{ type: 'INNER', resource: 'web_events', source: 'Web_Analytics', alias: 'w', on: { left: 'o.customer_id', operator: 'EQ', right: 'w.customer_id' } }],
    where: [{ column: 'o.status', operator: 'EQ', value: 'SHIPPED' }],
  },
};
const recursiveQuery = {
  type: 'SELECT',
  schema: 'an_lab',
  query: { recursive: { source: 'An_Lab', resource: 'employees', connectBy: { parent: 'manager_id', child: 'id' }, anchor: [{ column: 'manager_id', operator: 'IS_NULL' }], select: ['id', 'name', 'manager_id'], maxDepth: 10 } },
};
const callQuery = { type: 'CALL', function: 'current_user_id' };

const envelope = {
  data: [{ id: 1, name: 'Asha', dept_id: 10 }],
  rowCount: 1,
  warnings: [],
  plan: {
    strategy: 'SINGLE_CONNECTOR',
    executionMs: 12,
    rowsScannedAcrossSources: 1,
    pushed: ['filter', 'projection', 'limit'],
    legs: [{ source: 'An_Lab', engine: 'POSTGRES', mode: 'connector', operation: 'scan', target: 'an_lab.employees', query: 'SELECT "id","name","dept_id" FROM "an_lab"."employees" WHERE "dept_id" = $1 LIMIT 10', params: [10], rowsReturned: 1, ms: 9 }],
  },
};
const writeEnvelope = { status: 'SUCCESS', rowCount: 1, returning: [{ id: 9001, name: 'New Hire', dept_id: 10 }], plan: { strategy: 'SINGLE_CONNECTOR_WRITE', executionMs: 8, legs: [] } };
const jobId = '0b9e1a3c-6f1c-4a9b-8f6e-1d5d6c1d2a77';
const anyObjArray: Json = { type: 'array', items: { type: 'object', additionalProperties: true } };
const anyObj: Json = { type: 'object', additionalProperties: true };

/** Operations behind the licensing middleware reachable by developer tokens. */
const lic = { licensed: true } as const;
const sess = { auth: 'session' as const };

/* ================================================================== */
/* Operations                                                          */
/* ================================================================== */

const authOps: OpDef[] = [
  {
    method: 'post',
    path: '/api/auth/login',
    tag: T.auth,
    summary: 'Log in and obtain a session JWT',
    description: 'Exchanges username/password for a signed JWT (1 hour). Use it as `Authorization: Bearer <jwt>`, or use it once to mint a long-lived developer token via `POST /api/developer/tokens`.',
    auth: 'public',
    body: jsonBody(ref('LoginRequest'), { basic: ex('Username and password', { username: 'alice', password: 's3cret!' }), withTz: ex('Store the user timezone', { username: 'alice', password: 's3cret!', timezone: 'Asia/Kolkata' }) }),
    responses: { '200': { description: 'Login successful.', schema: ref('LoginResponse'), example: { token: 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...', user: { id: 'b1c2d3e4-5f60-4718-9a0b-1c2d3e4f5a6b', username: 'alice', tenant_id: 'tenant_A' } } } },
    errors: { '401': { description: 'Invalid credentials.', code: 'INVALID_CREDENTIALS', message: 'Invalid credentials' } },
  },
  {
    method: 'post',
    path: '/api/auth/token',
    tag: T.auth,
    summary: 'Exchange the session for a tenant-scoped JWT',
    description: 'Issues a new JWT bound to `tenantId`. Non-admin users may only switch to tenants they own. Requires a JWT session (developer tokens are tenant-bound and cannot switch).',
    auth: 'session',
    tenantHeader: false,
    body: jsonBody(ref('TokenExchangeRequest'), { switch: ex('Switch to another owned tenant', { tenantId: 'tenant_B' }) }),
    responses: { '200': { description: 'Scoped token generated.', schema: ref('TokenExchangeResponse'), example: { token: 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...' } } },
    errors: { '403': 'Caller does not own the requested tenant.' },
  },
  ...tokenOps,
];

const dataParams = { actAs: true, region: true, rejectsSql: true, ...lic } as const;

const dataOps: OpDef[] = [
  {
    method: 'post',
    path: '/api/data/fetch',
    tag: T.data,
    summary: 'Read rows from a resource (any source)',
    description:
      'Reads one resource through the planner, with predicate / projection / sort / limit pushed down to the source (Postgres, MySQL, Oracle, MongoDB, Elasticsearch). `where` accepts `{col: value}` (equality) or `{col: {$op: value}}` with `$eq $ne $gt $gte $lt $lte $like $ilike $in`. The response carries the execution `plan`/legs trace. **Token scope:** API tokens need `data:read` for this read-only call.',
    scopes: ['data:write'],
    ...dataParams,
    body: jsonBody(ref('DataFetchRequest'), {
      simple: ex('Equality filter', { source: 'An_Lab', schema: 'an_lab', resource: 'employees', columns: ['id', 'name', 'dept_id'], where: { dept_id: 10 }, limit: 5 }),
      operators: ex('Operator filter + sort', { source: 'An_Lab', schema: 'an_lab', resource: 'employees', where: { salary: { $gt: 200 } }, orderBy: [{ column: 'salary', direction: 'DESC' }], limit: 5 }),
      mongo: ex('A MongoDB collection', { source: 'An_Lab', schema: 'an_lab', resource: 'departments', where: { id: 10 }, limit: 5 }),
    }),
    responses: { '200': { description: 'Rows plus execution plan.', schema: ref('QueryEnvelope'), example: envelope } },
  },
  {
    method: 'post',
    path: '/api/data/create',
    tag: T.data,
    summary: 'Insert one or many rows',
    description: 'Inserts a row (object) or rows (array). Constraints, grants (INSERT) and policies are enforced in-fabric. `generate` declares write-time value generators (e.g. `UUID_V7`) for engines without column defaults.',
    scopes: ['data:write'],
    ...dataParams,
    body: jsonBody(ref('DataCreateRequest'), {
      single: ex('Single row', { source: 'An_Lab', schema: 'an_lab', resource: 'employees', data: { id: 9001, name: 'New Hire', manager_id: 2, dept_id: 10, salary: 120 } }),
      batch: ex('Batch insert', { source: 'An_Lab', schema: 'an_lab', resource: 'employees', data: [{ id: 9002, name: 'Hire B', dept_id: 10, salary: 110 }, { id: 9003, name: 'Hire C', dept_id: 20, salary: 115 }] }),
      generated: ex('Generated id', { source: 'An_Lab', schema: 'an_lab', resource: 'employees', data: { name: 'Hire D', dept_id: 10 }, generate: { id: 'UUID_V7' } }),
    }),
    responses: { '200': { description: 'Created rows (`returning`) and plan.', schema: ref('WriteEnvelope'), example: writeEnvelope } },
    errors: { '400': { description: 'Validation / constraint violation / SQL key in body.', codes: ['VALIDATION_ERROR', 'CONSTRAINT_VIOLATION', 'SQL_NOT_SUPPORTED'], message: 'CONSTRAINT VIOLATION: salary must be > 0' } },
  },
  {
    method: 'post',
    path: '/api/data/update',
    tag: T.data,
    summary: 'Update rows matching a filter',
    description: 'Sets `data` fields on rows matching `where`. A non-empty `where` is **required** - unrestricted updates are blocked (`400`). UPDATE grant and constraints are enforced.',
    scopes: ['data:write'],
    ...dataParams,
    body: jsonBody(ref('DataUpdateRequest'), {
      byId: ex('Update one row', { source: 'An_Lab', schema: 'an_lab', resource: 'employees', where: { id: 9001 }, data: { salary: 150, dept_id: 20 } }),
      byRange: ex('Update by operator filter', { source: 'An_Lab', schema: 'an_lab', resource: 'employees', where: { salary: { $lt: 100 } }, data: { band: 'JUNIOR' } }),
    }),
    responses: { '200': { description: 'Update result and plan.', schema: ref('WriteEnvelope'), example: { ...writeEnvelope, returning: [{ id: 9001, salary: 150, dept_id: 20 }] } } },
  },
  {
    method: 'post',
    path: '/api/data/delete',
    tag: T.data,
    summary: 'Delete rows matching a filter',
    description: 'Deletes rows matching `where`. A non-empty `where` is **required**. DELETE grant is enforced.',
    scopes: ['data:write'],
    ...dataParams,
    body: jsonBody(ref('DataDeleteRequest'), { byId: ex('Delete one row', { source: 'An_Lab', schema: 'an_lab', resource: 'employees', where: { id: 9001 } }) }),
    responses: { '200': { description: 'Delete result and plan.', schema: ref('WriteEnvelope'), example: writeEnvelope } },
  },
  {
    method: 'post',
    path: '/api/data/call',
    tag: T.data,
    summary: 'Invoke a provisioned function or procedure',
    description: 'Function-as-a-service: calls a function (`SELECT fn(...)`) or procedure (`CALL ...`) previously provisioned through a manifest. Equivalent to an AST `{ "type": "CALL" }` config.',
    scopes: ['data:write'],
    ...dataParams,
    body: jsonBody(ref('DataCallRequest'), {
      fn: ex('Call a function', { schema: 'public', function: 'calc_ltv', args: [42] }),
      proc: ex('Call a procedure', { schema: 'public', procedure: 'rebuild_index', args: [] }),
    }),
    responses: { '200': { description: 'Result and plan.', schema: ref('QueryEnvelope'), example: { ...envelope, data: [{ calc_ltv: 1830.5 }] } } },
  },
  {
    method: 'post',
    path: '/api/data/sequence',
    tag: T.data,
    summary: 'Allocate sequence value(s)',
    description: 'Postgres-style `nextval()` for any engine - e.g. consistent sequential ids for MongoDB inserts. Use `count` to reserve a block.',
    scopes: ['data:write'],
    ...dataParams,
    body: jsonBody(ref('SequenceRequest'), { one: ex('Next value', { name: 'order_id_seq' }), block: ex('Reserve 5', { name: 'order_id_seq', count: 5 }) }),
    responses: { '200': { description: 'Allocated value(s).', schema: ref('SequenceResponse'), example: { name: 'order_id_seq', value: 1005, values: [1001, 1002, 1003, 1004, 1005] } } },
  },
];

const engineOps: OpDef[] = [
  {
    method: 'post',
    path: '/api/queries/engine',
    tag: T.engine,
    summary: 'Execute an AST QueryConfig',
    description:
      'Runs a `QueryConfig` through the federation engine. Send the config as the body, or wrapped as `{ "config": {...} }`. A single source gets full pushdown; multi-source queries are federated (per-source pushdown + bind-join, partial-aggregate merge, in-fabric UNION/INTERSECT/EXCEPT). `plan.legs` proves what ran where. **There is no SQL execution endpoint** - `/api/queries/exec` and `/api/queries/native` were removed.',
    scopes: ['query:read'],
    actAs: true,
    region: true,
    rejectsSql: true,
    ...lic,
    body: jsonBody(ref('EngineQueryRequest'), {
      filter: ex('Filter + projection', filterQuery),
      aggregate: ex('GROUP BY aggregate', aggregateQuery),
      crossSourceJoin: ex('Cross-source join', joinQuery),
      recursive: ex('Recursive hierarchy', recursiveQuery),
      call: ex('Call a function', callQuery),
      wrapped: ex('Wrapped in config', { config: filterQuery }),
    }),
    responses: { '200': { description: 'Rows plus execution plan.', schema: ref('QueryEnvelope'), example: envelope } },
    errors: { '403': { description: 'Tenant suspended, scope missing, or role lacks SELECT grant.', code: 'SCOPE_REQUIRED', message: 'Token is missing required scope: query:read' } },
  },
  {
    method: 'post',
    path: '/api/queries/transpile',
    tag: T.engine,
    summary: 'Preview the SQL an AST compiles to',
    description: 'Powers the "see SQL" mode of the AST builder. Returns the SQL **text** the engine would generate; nothing is executed. Never fails hard: when an AST cannot be transpiled it answers 200 with a commented `sql` and an `error` field. Recursive queries return `note: RECURSIVE_IN_FABRIC`.',
    scopes: ['query:read'],
    rejectsSql: true,
    ...lic,
    body: jsonBody(ref('TranspileRequest'), { filter: ex('Filter', { config: filterQuery }), aggregate: ex('Aggregate', { config: aggregateQuery }) }),
    responses: { '200': { description: 'SQL preview.', schema: ref('TranspileResponse'), example: { sql: 'SELECT "id", "name", "dept_id" FROM "tenant_t1_an_lab"."employees" WHERE "dept_id" = 10 LIMIT 10;' } } },
  },
  ...(['/api/queries/jobs/{id}', '/api/queries/status/{id}'] as const).map(
    (path, i): OpDef => ({
      method: 'get',
      path,
      tag: T.engine,
      summary: i === 0 ? 'Poll an async query job' : 'Poll an async query job (alias)',
      description: `Returns the state of a background job started by \`POST /api/analytics/query-async\`. ${i === 1 ? 'Alias of `/api/queries/jobs/{id}`. ' : ''}Poll until \`status\` is \`COMPLETED\` (then \`result\` holds the envelope) or \`FAILED\`.`,
      scopes: ['query:read'],
      ...lic,
      params: [pp('id', 'Job id returned as `jobId` by the async submit call.', jobId)],
      responses: { '200': { description: 'Job state.', schema: ref('JobStatus'), example: { jobId, status: 'COMPLETED', result: envelope } } },
      errors: { '404': { description: 'Unknown job id.', code: 'NOT_FOUND', message: 'NOT_FOUND' } },
    }),
  ),
];

const analyticsOps: OpDef[] = [
  {
    method: 'post',
    path: '/api/analytics/query',
    tag: T.analytics,
    summary: 'Run an AST query (primary query interface)',
    description:
      'Executes an engine-agnostic AST and records it in the query log. A SELECT must carry a `where`, a `limit`, or be a set-operation. Send `"stream": true` (or `?stream=true`) with `Accept: application/x-ndjson` to receive rows as NDJSON followed by a `{"__meta__": ...}` trailer carrying plan/rowCount/warnings.',
    scopes: ['query:read'],
    actAs: true,
    region: true,
    ndjson: true,
    rejectsSql: true,
    ...lic,
    params: [q('stream', 'Alternative to `"stream": true` in the body.', { type: 'boolean' }, true)],
    body: jsonBody(ref('AnalyticsQueryRequest'), {
      filter: ex('AST filter', { queryConfig: filterQuery }),
      aggregate: ex('AST aggregate', { queryConfig: aggregateQuery }),
      join: ex('Cross-source join', { queryConfig: joinQuery }),
      recursive: ex('Recursive', { queryConfig: recursiveQuery }),
      call: ex('Function call', { queryConfig: callQuery }),
      stream: ex('Stream as NDJSON', { queryConfig: { ...filterQuery, stream: true } }),
    }),
    responses: {
      '200': { description: 'Buffered JSON envelope, or NDJSON when streaming was requested.', schema: ref('QueryEnvelope'), example: envelope },
    },
    errors: {},
  },
  {
    method: 'post',
    path: '/api/analytics/query-async',
    tag: T.analytics,
    summary: 'Submit an AST query as a background job',
    description: 'Queues the query and returns a `jobId` immediately (202). Poll `GET /api/analytics/jobs/{jobId}`.',
    scopes: ['query:read'],
    rejectsSql: true,
    ...lic,
    body: jsonBody(ref('AnalyticsQueryRequest'), { filter: ex('AST filter', { queryConfig: filterQuery }), aggregate: ex('AST aggregate', { queryConfig: aggregateQuery }) }),
    responses: { '202': { description: 'Job accepted.', schema: ref('AsyncJobResponse'), example: { jobId, status: 'PENDING' } } },
  },
  ...(['/api/analytics/jobs/{jobId}', '/api/analytics/query/status/{jobId}'] as const).map(
    (path, i): OpDef => ({
      method: 'get',
      path,
      tag: T.analytics,
      summary: i === 0 ? 'Poll an analytics job' : 'Poll an analytics job (alias)',
      description: `Status of a job created by \`POST /api/analytics/query-async\`.${i === 1 ? ' Alias of `/api/analytics/jobs/{jobId}`.' : ''}`,
      scopes: ['query:read'],
      ...lic,
      params: [pp('jobId', 'Job id.', jobId)],
      responses: { '200': { description: 'Job state.', schema: ref('JobStatus'), example: { jobId, status: 'RUNNING' } } },
      errors: { '404': { description: 'Unknown job id.', code: 'NOT_FOUND', message: 'NOT_FOUND' } },
    }),
  ),
  {
    method: 'post',
    path: '/api/analytics/refresh-view',
    tag: T.analytics,
    summary: 'Refresh a materialized view',
    description: 'Starts a (concurrent) `REFRESH MATERIALIZED VIEW` in the background and returns 202.',
    scopes: ['query:read'],
    ...lic,
    body: jsonBody(ref('RefreshViewRequest'), { mv: ex('Concurrent refresh', { viewName: 'mv_revenue_by_region', schema: 'an_lab', concurrent: true }) }),
    responses: { '202': { description: 'Refresh started.', schema: ref('RefreshViewResponse'), example: { status: 'accepted', message: 'View refresh initiated in background', jobId } } },
  },
];

const savedBodyExamples = {
  revenue: ex('Parameterized AST', {
    name: 'Employees by department',
    description: 'Employees of one department',
    mode: 'AST',
    variables: [{ name: 'dept', type: 'number', label: 'Department', required: true }],
    config: { type: 'SELECT', schema: 'an_lab', limit: 100, query: { from: { resource: 'employees', source: 'An_Lab' }, select: ['id', 'name'], where: [{ column: 'dept_id', operator: 'EQ', value: '{{dept}}' }] } },
  }),
};
const savedOps: OpDef[] = [
  {
    method: 'get',
    path: '/api/saved-analytics',
    tag: T.saved,
    summary: 'List saved analytics',
    description: 'Saved, parameterized AST analytics defined for the tenant.',
    scopes: ['query:read'],
    ...lic,
    responses: { '200': { description: 'Saved analytics.', schema: refArray('SavedAnalytic'), example: [{ id: jobId, name: 'Employees by department', mode: 'AST', run_count: 12, variables: [{ name: 'dept', type: 'number' }] }] } },
  },
  {
    method: 'get',
    path: '/api/saved-analytics/top',
    tag: T.saved,
    summary: 'Most used saved analytics',
    description: 'Top analytics by usage, for shortcut lists.',
    scopes: ['query:read'],
    ...lic,
    params: [q('limit', 'Maximum number of items.', { type: 'integer', default: 8 }, 8)],
    responses: { '200': { description: 'Top saved analytics.', schema: refArray('SavedAnalytic'), example: [] } },
  },
  {
    method: 'post',
    path: '/api/saved-analytics',
    tag: T.saved,
    summary: 'Create a saved analytic',
    description: 'Stores an AST with `{{variable}}` placeholders. Raw-SQL analytics are not supported.',
    scopes: ['query:read'],
    rejectsSql: true,
    ...lic,
    body: jsonBody(ref('SavedAnalytic'), savedBodyExamples),
    responses: { '201': { description: 'Created.', schema: ref('SavedAnalytic'), example: { id: jobId, name: 'Employees by department', mode: 'AST', run_count: 0 } } },
  },
  {
    method: 'get',
    path: '/api/saved-analytics/{id}',
    tag: T.saved,
    summary: 'Get a saved analytic',
    description: 'Fetch one definition by id.',
    scopes: ['query:read'],
    ...lic,
    params: [pp('id', 'Saved analytic id.', jobId)],
    responses: { '200': { description: 'The analytic.', schema: ref('SavedAnalytic'), example: { id: jobId, name: 'Employees by department', mode: 'AST' } } },
  },
  {
    method: 'delete',
    path: '/api/saved-analytics/{id}',
    tag: T.saved,
    summary: 'Delete a saved analytic',
    description: 'Removes the definition.',
    scopes: ['query:read'],
    ...lic,
    params: [pp('id', 'Saved analytic id.', jobId)],
    responses: { '200': { description: 'Deleted.', schema: ref('SavedAnalyticDeleted'), example: { status: 'DELETED', id: jobId } } },
  },
  {
    method: 'post',
    path: '/api/saved-analytics/{id}/run',
    tag: T.saved,
    summary: 'Run a saved analytic',
    description: 'Binds `variables` into the stored AST and executes it. Declared required variables must be supplied (`400` otherwise). The run is captured in the query log with mode `SAVED_ANALYTIC`.',
    scopes: ['query:read'],
    actAs: true,
    region: true,
    ...lic,
    params: [pp('id', 'Saved analytic id.', jobId)],
    body: jsonBody(ref('SavedAnalyticRunRequest'), { dept: ex('Bind dept=20', { variables: { dept: 20 } }) }, undefined, false),
    responses: { '200': { description: 'Rows plus plan.', schema: ref('QueryEnvelope'), example: envelope } },
  },
];

const catalogOps: OpDef[] = ([
  { method: 'get', path: '/api/metadata/sources', summary: 'List data sources', description: 'Registered data sources visible to the tenant.', resp: { description: 'Sources.', schema: refArray('CatalogSource'), example: [{ id: 'src_1', name: 'Retail_Core', type: 'postgres', status: 'CONNECTED' }] } },
  { method: 'get', path: '/api/metadata/schemas', summary: 'List schemas of a source', description: 'Schemas discovered under a source.', params: [q('sourceId', 'Source id.', undefined, 'src_1', true)], resp: { description: 'Schemas.', schema: anyObjArray, example: [{ id: 'sch_1', name: 'public' }] } },
  { method: 'get', path: '/api/metadata/tables', summary: 'List tables of a schema', description: 'Tables / views / collections under a schema.', params: [q('schemaId', 'Schema id.', undefined, 'sch_1', true)], resp: { description: 'Tables.', schema: anyObjArray, example: [{ id: 'tbl_1', name: 'orders', type: 'TABLE' }] } },
  { method: 'get', path: '/api/metadata/resource/{id}', summary: 'Get catalog resource details', description: 'Full details (columns, keys, row counts, relationships) for one catalog resource.', params: [pp('id', 'Catalog resource id.', 'tbl_1')], resp: { description: 'Resource details.', schema: anyObj, example: { id: 'tbl_1', name: 'orders', columns: [{ name: 'id', type: 'uuid' }] } } },
  { method: 'get', path: '/api/metadata/columns', summary: 'List columns of a resource', description: 'Column metadata by `tableId`, or by `source` + `resource`.', params: [q('tableId', 'Catalog table id.'), q('source', 'Source name (with `resource`).'), q('resource', 'Resource name (with `source`).')], resp: { description: 'Columns.', schema: refArray('CatalogColumn'), example: [{ name: 'id', type: 'uuid', isPrimaryKey: true }] }, errors: { '400': { description: 'Neither `tableId` nor `source`+`resource` supplied.', code: 'VALIDATION_ERROR', message: 'tableId (or source+resource) is required' } } },
  { method: 'get', path: '/api/metadata/relationships', summary: 'List relationships (ER diagram)', description: 'Foreign keys and manifest-declared relationships, optionally for one schema.', params: [q('schema', 'Schema name filter.')], resp: { description: 'Relationships.', schema: anyObjArray, example: [{ name: 'orders_customer', cardinality: '1:M' }] } },
  { method: 'get', path: '/api/metadata/preview', summary: 'Preview sample rows', description: 'First rows of a resource.', params: [q('tableId', 'Catalog table id.', undefined, 'tbl_1', true), q('limit', 'Rows to return.', { type: 'integer', default: 50 }, 50)], resp: { description: 'Sample rows.', schema: anyObj, example: { rows: [{ id: 1 }] } } },
  { method: 'get', path: '/api/metadata/tables/{name}', summary: 'Legacy table lookup by name', description: 'Column list + description for a table name.', params: [pp('name', 'Table name.', 'orders')], resp: { description: 'Table details.', schema: anyObj, example: { name: 'orders', columns: [] } } },
  { method: 'get', path: '/api/metadata/template', summary: 'Blank manifest template', description: 'A starter `MetadataManifest` to edit and apply.', resp: { description: 'Manifest template.', schema: ref('MetadataManifest') } },
  { method: 'get', path: '/api/metadata/export', summary: 'Export the live catalog as a manifest', description: 'Reverse-engineers the current catalog into a manifest (optionally for one source).', params: [q('source', 'Source name filter.')], resp: { description: 'Manifest.', schema: ref('MetadataManifest') } },
  { method: 'get', path: '/api/metadata/history', summary: 'Manifest apply history', description: 'Versions applied via `/api/metadata/apply`, usable with rollback.', resp: { description: 'History.', schema: anyObjArray, example: [{ id: 'ver_7', applied_at: '2026-10-19T08:00:00.000Z', applied_by: 'alice' }] } },
  { method: 'get', path: '/api/metadata/downstream', summary: 'Downstream sync target status', description: 'State of Elasticsearch / Snowflake downstream targets.', resp: { description: 'Targets.', schema: anyObjArray, example: [{ type: 'ELASTICSEARCH', enabled: true }] } },
] as any[]).map(
  (o): OpDef => ({
    method: 'get',
    path: o.path,
    tag: T.catalog,
    summary: o.summary,
    description: o.description,
    scopes: ['metadata:read'],
    ...lic,
    ...(o.params ? { params: o.params } : {}),
    responses: { '200': o.resp },
    ...(o.errors ? { errors: o.errors } : {}),
  }),
);

const manifestExample = {
  version: '4.0',
  namespace: 'Global_Supply_Chain',
  consistencyMode: 'SAGA',
  schemas: [{ name: 'GSC_Core', resources: [{ type: 'TABLE', name: 'shipments', columns: [{ name: 'id', type: 'uuid', strategy: 'UUID_V7', pk: true }, { name: 'status', type: 'varchar', default: 'PENDING' }] }] }],
};
const manifestBody = (what: string) => ({
  description: `Manifest as a JSON body, or as a \`multipart/form-data\` file upload in field \`file\`. ${what}`,
  schema: { type: 'object', properties: { file: { type: 'string', format: 'binary', description: 'Manifest JSON file.' } } } as Json,
  examples: {},
  multipart: true,
  alsoJson: { schema: ref('MetadataManifest'), examples: { shipments: ex('Provision a shipments table', manifestExample) } },
});

const orchestrationOps: OpDef[] = [
  {
    method: 'post',
    path: '/api/metadata/crawl',
    tag: T.orchestration,
    summary: 'Crawl sources into the catalog',
    description: 'Discovers schemas/tables/columns of the tenant\'s connected sources. Platform ADMIN may pass `tenantId` to crawl another tenant.',
    scopes: ['metadata:write'],
    ...lic,
    body: jsonBody(ref('CrawlRequest'), { own: ex('Crawl my tenant', {}) }, undefined, false),
    responses: { '200': { description: 'Crawl initiated.', schema: anyObj, example: { status: 'CRAWL_STARTED' } } },
  },
  {
    method: 'post',
    path: '/api/metadata/sync',
    tag: T.orchestration,
    summary: 'Replicate a source into the hub',
    description: 'Queues a SYNC (full) or CDC copy job that replicates a registered source into the hub. Returns the run id; poll `GET /api/replication/runs/{runId}`.',
    scopes: ['metadata:write'],
    ...lic,
    body: jsonBody(ref('SyncRequest'), { full: ex('Full sync', { source: 'Retail_Core', mode: 'full' }), cdc: ex('Change-data-capture', { source: 'Retail_Core', mode: 'cdc', pageSize: 5000 }) }),
    responses: { '202': { description: 'Run queued.', schema: ref('QueuedRun'), example: { status: 'QUEUED', runId: 'run_8f2a', run: { id: 'run_8f2a', type: 'SYNC', status: 'QUEUED' } } } },
  },
  {
    method: 'post',
    path: '/api/metadata/diff',
    tag: T.orchestration,
    summary: 'Diff a manifest against live state (dry run)',
    description: 'Computes the migration plan without changing anything: operations, risk summary and drift.',
    scopes: ['metadata:write'],
    ...lic,
    body: manifestBody('Dry run - nothing is applied.'),
    responses: { '200': { description: 'Planned operations.', schema: ref('MetadataDiffResult'), example: { status: 'PLAN_READY', summary: { total: 3, highRisk: 0 }, changes: [{ op: 'CREATE_TABLE', schema: 'GSC_Core', resource: 'shipments' }] } } },
  },
  {
    method: 'post',
    path: '/api/metadata/apply',
    tag: T.orchestration,
    summary: 'Apply a manifest (provision DDL across sources)',
    description: 'Orchestrates DDL across the targeted sources and records a version. High-risk (destructive) operations are refused unless `?force=true`. Plan limits (e.g. maximum tables) apply.',
    scopes: ['metadata:write'],
    ...lic,
    params: [q('force', 'Allow destructive / high-risk operations.', { type: 'boolean', default: false }, false)],
    body: manifestBody('Applies the plan.'),
    responses: { '200': { description: 'Per-operation results.', schema: ref('MetadataApplyResult'), example: { plan: [{ op: 'CREATE_TABLE' }], results: [{ op: 'CREATE_TABLE', status: 'SUCCESS' }] } } },
    errors: { '400': { description: 'Invalid manifest, plan limit exceeded, or high-risk changes without `force`.', code: 'VALIDATION_ERROR', message: 'Table limit exceeded. Your plan restricts you to a maximum of 5 tables.' } },
  },
  {
    method: 'post',
    path: '/api/metadata/migrate',
    tag: T.orchestration,
    summary: 'Apply an ad-hoc migration plan',
    description: 'Executes an explicit list of migration operations atomically (no manifest).',
    scopes: ['metadata:write'],
    ...lic,
    body: jsonBody(ref('MigrationRequest'), { addColumn: ex('Add a column', { migrationPlan: [{ op: 'ADD_COLUMN', schema: 'public', table: 'orders', column: { name: 'notes', type: 'text' } }] }) }),
    responses: { '200': { description: 'Migration successful.', schema: anyObj, example: { status: 'SUCCESS' } } },
  },
  {
    method: 'post',
    path: '/api/metadata/rollback/{id}',
    tag: T.orchestration,
    summary: 'Roll back to a prior manifest version',
    description: 'Re-applies the manifest captured at version `id`. Destructive relative to the current state.',
    scopes: ['metadata:write'],
    ...lic,
    params: [pp('id', 'Version id from `GET /api/metadata/history`.', 'ver_7')],
    responses: { '200': { description: 'Rolled back.', schema: anyObj, example: { status: 'ROLLED_BACK', version: 'ver_7' } } },
  },
  {
    method: 'post',
    path: '/api/metadata/downstream/toggle',
    tag: T.orchestration,
    summary: 'Enable / disable a downstream target',
    description: 'Turns Elasticsearch or Snowflake downstream sync on or off for the tenant.',
    scopes: ['metadata:write'],
    ...lic,
    body: jsonBody(ref('DownstreamToggleRequest'), { enableEs: ex('Enable Elasticsearch', { targetType: 'ELASTICSEARCH', enabled: true }) }),
    responses: { '200': { description: 'Updated state.', schema: anyObj, example: { targetType: 'ELASTICSEARCH', enabled: true } } },
  },
];

const governanceOps: OpDef[] = [
  { method: 'get', path: '/api/policies', tag: T.governance, summary: 'List access policies', description: 'Row-filter and column-masking policies enforced by the fabric on non-RLS engines.', responses: { '200': { description: 'Policies.', schema: refArray('Policy'), example: [{ id: 'pol_1', name: 'eu_analyst_rows', schema: 'public', table: 'customers', roles: ['ANALYST'], rowFilter: [{ column: 'region', operator: 'EQ', value: { session: 'region' } }] }] } }, ...sess },
  {
    method: 'post',
    path: '/api/policies',
    tag: T.governance,
    summary: 'Create or replace an access policy',
    description: 'Upserts a policy for a schema/table. At least one `rowFilter` or `masking` rule is required.',
    responses: { '201': { description: 'Policy stored.', schema: ref('Policy'), example: { id: 'pol_1', name: 'eu_analyst_rows', schema: 'public', table: 'customers' } } },
    body: jsonBody(ref('Policy'), {
      rowFilter: ex('Region row filter', { name: 'eu_analyst_rows', schema: 'public', table: 'customers', roles: ['ANALYST'], rowFilter: [{ column: 'region', operator: 'EQ', value: { session: 'region' } }] }),
      masking: ex('Mask email', { name: 'mask_email', schema: 'public', table: 'customers', masking: [{ column: 'email', roles: ['ANALYST'], strategy: 'PARTIAL' }] }),
    }),
    errors: { '400': { description: 'Missing name/schema/table or no rule.', code: 'VALIDATION_ERROR', message: 'a policy needs at least a rowFilter or masking rule' } },
    ...sess,
  },
  { method: 'delete', path: '/api/policies/{id}', tag: T.governance, summary: 'Delete an access policy', description: 'Removes a policy.', params: [pp('id', 'Policy id.', 'pol_1')], responses: { '200': { description: 'Deleted.', schema: ref('Deleted'), example: { status: 'DELETED' } } }, ...sess },
  { method: 'get', path: '/api/constraints', tag: T.governance, summary: 'List constraints', description: 'Engine-agnostic NOT NULL / UNIQUE / ENUM / CHECK / FK constraints validated before writes.', responses: { '200': { description: 'Constraint specs.', schema: refArray('ConstraintSpec'), example: [] } }, ...sess },
  {
    method: 'post',
    path: '/api/constraints',
    tag: T.governance,
    summary: 'Create or replace constraints for a table',
    description: 'Upserts the constraint spec of a schema/table. Provide at least one column rule or check.',
    body: jsonBody(ref('ConstraintSpec'), { orders: ex('Orders constraints', { schema: 'public', table: 'orders', columns: [{ name: 'status', notNull: true, enum: ['PENDING', 'SHIPPED', 'DELIVERED'] }], checks: [{ name: 'amount_positive', column: 'total_amount', op: 'GT', value: 0 }] }) }),
    responses: { '201': { description: 'Stored.', schema: ref('ConstraintSpec'), example: { schema: 'public', table: 'orders' } } },
    errors: { '400': { description: 'Missing schema/table or no rule.', code: 'VALIDATION_ERROR', message: 'provide at least one column rule or check' } },
    ...sess,
  },
  { method: 'get', path: '/api/grants', tag: T.governance, summary: 'List table grants', description: 'Role privileges (SELECT/INSERT/UPDATE/DELETE) enforced by the fabric on non-SQL engines.', responses: { '200': { description: 'Grants.', schema: refArray('Grant'), example: [] } }, ...sess },
  {
    method: 'post',
    path: '/api/grants',
    tag: T.governance,
    summary: 'Create or replace grants for a table',
    description: 'Upserts the privileges of a schema/table. With no grants declared the table is default-allow; ADMIN always passes.',
    body: jsonBody(ref('Grant'), { analyst: ex('Read-only analyst', { schema: 'public', table: 'customers', grants: [{ role: 'ANALYST', privileges: ['SELECT'] }] }) }),
    responses: { '201': { description: 'Stored.', schema: ref('Grant'), example: { schema: 'public', table: 'customers', grants: [{ role: 'ANALYST', privileges: ['SELECT'] }] } } },
    errors: { '400': { description: 'Missing schema/table/grants.', code: 'VALIDATION_ERROR', message: 'schema, table and a non-empty grants[] are required' } },
    ...sess,
  },
];

const triggerExample = { triggerName: 'notify_new_employee', schemaName: 'an_lab', tableName: 'employees', definition: { event: 'INSERT', timing: 'AFTER', execute: { type: 'WEBHOOK', url: 'https://hooks.example.com/employees' } } };
const triggerOps: OpDef[] = [
  { method: 'get', path: '/api/triggers', tag: T.triggers, summary: 'List triggers', description: 'Triggers defined for the tenant.', scopes: ['triggers:read'], ...lic, responses: { '200': { description: 'Triggers.', schema: refArray('Trigger'), example: [{ id: 'trg_1', ...triggerExample, status: 'ACTIVE' }] } } },
  {
    method: 'post',
    path: '/api/triggers',
    tag: T.triggers,
    summary: 'Create (or upsert) a trigger',
    description: 'Row-based triggers need `schemaName` + `tableName` + `definition.event`; scheduled triggers supply `definition.schedule`. Actions: `AUDIT WEBHOOK EMAIL TELEGRAM FUNCTION EXCEPTION`. The trigger is stored as `PENDING_DEPLOY` until deployed.',
    scopes: ['triggers:write'],
    ...lic,
    body: jsonBody(ref('Trigger'), {
      webhook: ex('Webhook on insert', triggerExample),
      scheduled: ex('Scheduled audit', { triggerName: 'nightly_audit', definition: { schedule: { type: 'INTERVAL', every: '24h' }, execute: { type: 'AUDIT' } } }),
    }),
    responses: { '201': { description: 'Created.', schema: ref('Trigger'), example: { id: 'trg_1', ...triggerExample, status: 'PENDING_DEPLOY' } } },
    errors: { '400': { description: 'Validation error or plan trigger limit exceeded.', code: 'VALIDATION_ERROR', message: 'Trigger limit exceeded. Your plan restricts you to a maximum of 3 triggers.' } },
  },
  {
    method: 'put',
    path: '/api/triggers/{id}',
    tag: T.triggers,
    summary: 'Update a trigger',
    description: 'Replaces the trigger definition; redeploy afterwards.',
    scopes: ['triggers:write'],
    ...lic,
    params: [pp('id', 'Trigger id.', 'trg_1')],
    body: jsonBody(ref('Trigger'), { webhook: ex('Change URL', triggerExample) }),
    responses: { '200': { description: 'Updated.', schema: ref('Trigger'), example: { id: 'trg_1', ...triggerExample, status: 'PENDING_DEPLOY' } } },
    errors: { '400': 'Validation error.' },
  },
  { method: 'delete', path: '/api/triggers/{id}', tag: T.triggers, summary: 'Delete a trigger', description: 'Marks the trigger for deletion and removes it from the source on next deploy cycle.', scopes: ['triggers:write'], ...lic, params: [pp('id', 'Trigger id.', 'trg_1')], responses: { '200': { description: 'Deleted / scheduled for deletion.', schema: anyObj, example: { status: 'DELETED', id: 'trg_1' } } }, errors: { '400': 'Validation error.' } },
  { method: 'post', path: '/api/triggers/{id}/deploy', tag: T.triggers, summary: 'Deploy (activate) a trigger', description: 'Installs the trigger on the source and sets it `ACTIVE`.', scopes: ['triggers:write'], ...lic, params: [pp('id', 'Trigger id.', 'trg_1')], responses: { '200': { description: 'Deployed.', schema: ref('Trigger'), example: { id: 'trg_1', status: 'ACTIVE' } } }, errors: { '400': 'Validation / deployment error.' } },
  { method: 'get', path: '/api/triggers/logs/list', tag: T.triggers, summary: 'Trigger execution logs', description: 'Execution and lifecycle log entries, newest first.', scopes: ['triggers:read'], ...lic, params: [q('triggerId', 'Filter by trigger id.'), q('limit', 'Page size.', { type: 'integer', default: 50 }, 50), q('offset', 'Offset.', { type: 'integer', default: 0 }, 0)], responses: { '200': { description: 'Logs.', schema: refArray('TriggerLog'), example: [] } } },
  { method: 'get', path: '/api/triggers/jobs/list', tag: T.triggers, summary: 'Async trigger job queue', description: 'Durable jobs that run trigger actions (webhook/email/...).', scopes: ['triggers:read'], ...lic, responses: { '200': { description: 'Jobs.', schema: refArray('TriggerJob'), example: [] } } },
  { method: 'post', path: '/api/triggers/jobs/{id}/retry', tag: T.triggers, summary: 'Retry a failed trigger job', description: 'Re-queues a FAILED job.', scopes: ['triggers:write'], ...lic, params: [pp('id', 'Job id.', 'job_1')], responses: { '200': { description: 'Re-queued.', schema: ref('TriggerJob'), example: { id: 'job_1', status: 'PENDING', attempts: 0 } } }, errors: { '400': 'Job not retryable.' } },
];

const replicationReadOps: OpDef[] = ([
  { method: 'get', path: '/api/replication', tag: T.replication, summary: 'List replication jobs', description: 'Source-to-source replication jobs of the tenant.', responses: { '200': { description: 'Jobs.', schema: refArray('ReplicationJob'), example: [] } } },
  { method: 'get', path: '/api/replication/analytics', tag: T.replication, summary: 'Copy-job analytics', description: 'Aggregate statistics over copy-job runs (rows copied, durations, failure rate).', responses: { '200': { description: 'Analytics.', schema: anyObj, example: { runs: 12, rowsCopied: 1200000 } } } },
  { method: 'get', path: '/api/replication/tracking', tag: T.replication, summary: 'Smart tracking preview', description: 'Detects which tables of a source support INCREMENTAL / CDC tracking and the suggested column.', params: [q('source', 'Source name.', undefined, 'Retail_Core', true)], responses: { '200': { description: 'Tracking preview.', schema: anyObj, example: { tables: [{ table: 'orders', strategy: 'INCREMENTAL', column: 'updated_at' }] } } } },
  { method: 'get', path: '/api/replication/runs', tag: T.replication, summary: 'List copy-job runs', description: 'Recent SYNC / CDC / REPLICATE / RESTORE runs.', responses: { '200': { description: 'Runs.', schema: refArray('CopyRun'), example: [] } } },
  { method: 'get', path: '/api/replication/runs/{runId}', tag: T.replication, summary: 'Get a run', description: 'Status and result of one run.', params: [pp('runId', 'Run id.', 'run_8f2a')], responses: { '200': { description: 'The run.', schema: ref('CopyRun'), example: { id: 'run_8f2a', type: 'REPLICATE', status: 'RUNNING' } } } },
] as OpDef[]).map((o) => ({ ...o, ...sess, ...lic }) as OpDef);

const logOps: OpDef[] = [
  {
    method: 'get',
    path: '/api/query-logs',
    tag: T.logs,
    summary: 'List recent query executions',
    description: 'Audit trail of AST queries, CRUD calls and saved-analytic runs captured by the query engine.',
    scopes: ['query:read'],
    params: [q('limit', 'Maximum rows (default 200).', { type: 'integer', default: 200 }, 50), q('status', 'Filter by outcome.', { type: 'string', enum: ['SUCCESS', 'ERROR'] }), q('mode', 'Filter by mode, e.g. `SELECT_AST`, `CRUD_CREATE`.', { type: 'string' }, 'SELECT_AST')],
    responses: { '200': { description: 'Query logs.', schema: refArray('QueryLog'), example: [{ id: 'q_1', tenant_id: 'tenant_A', username: 'alice', role: 'ANALYST', mode: 'SELECT_AST', api: '/api/analytics/query', source: 'An_Lab', status: 'SUCCESS', row_count: 42, duration_ms: 18, created_at: '2026-10-19T09:00:00.000Z' }] } },
  },
  {
    method: 'get',
    path: '/api/query-logs/{id}',
    tag: T.logs,
    summary: 'Get one query log entry',
    description: 'Full entry including the executed AST (`query_text`) and error text.',
    scopes: ['query:read'],
    params: [pp('id', 'Query log id.', 'q_1')],
    responses: { '200': { description: 'Entry.', schema: ref('QueryLog'), example: { id: 'q_1', mode: 'SELECT_AST', status: 'SUCCESS' } } },
  },
];

const eventOps: OpDef[] = [
  { method: 'get', path: '/api/events', tag: T.events, summary: 'Shared platform events', description: 'Global event feed (schema applied, sync finished, trigger fired ...).', ...sess, responses: { '200': { description: 'Events.', schema: refArray('GlobalEvent'), example: [] } } },
];

/* ================================================================== */
/* Developer document                                                  */
/* ================================================================== */

export const developerOps: OpDef[] = [
  ...authOps,
  ...dataOps,
  ...engineOps,
  ...analyticsOps,
  ...savedOps,
  ...catalogOps,
  ...orchestrationOps,
  ...governanceOps,
  ...triggerOps,
  ...replicationReadOps,
  ...logOps,
  ...eventOps,
  ...workspaceReadOps,
];

export const developerTags: TagDef[] = [
  { name: T.auth, description: 'Log in, obtain a JWT, switch tenant. Developer tokens are minted under **Developer Tokens**.' },
  ...tokenTags,
  { name: T.data, description: 'Simple REST-style CRUD over any connected engine. Constraints, grants and policies are enforced in-fabric. Updates/deletes require a `where`. Raw SQL is rejected (`SQL_NOT_SUPPORTED`).' },
  { name: T.engine, description: 'Execute engine-agnostic AST `QueryConfig`s (`/engine`), preview the SQL an AST compiles to (`/transpile`, never executes) and poll async jobs. AST only - the SQL execution endpoints were removed.' },
  { name: T.analytics, description: 'Primary analytics interface: sync (optionally NDJSON-streamed) and async AST queries, job polling, materialized-view refresh.' },
  { name: T.saved, description: 'Reusable parameterized AST analytics with `{{variable}}` bindings.' },
  { name: T.catalog, description: 'Read-only catalog browsing: sources, schemas, tables, columns, relationships, previews, manifest history and downstream status.' },
  { name: T.orchestration, description: 'Declarative metadata lifecycle: crawl, sync, diff, apply, migrate, rollback and downstream toggles.' },
  { name: T.governance, description: 'Engine-agnostic access policies (row filters + masking), constraints and grants. JWT session only.' },
  { name: T.triggers, description: 'Event triggers (webhook, email, Telegram, function, audit, exception), deployment, execution logs and the durable job queue.' },
  { name: T.replication, description: 'Read APIs for source-to-source replication jobs and copy-job runs (JWT session). Mutating replication calls are in the system document.' },
  { name: T.logs, description: 'Audit trail of every query/CRUD execution.' },
  { name: T.events, description: 'Shared global event feed.' },
  ...workspaceTagsForDeveloper,
];

export const developerTagGroups: TagGroup[] = [
  { name: 'Getting started', tags: [T.auth, 'Developer Tokens'] },
  { name: 'Data & queries', tags: [T.data, T.engine, T.analytics, T.saved, T.logs] },
  { name: 'Metadata & governance', tags: [T.catalog, T.orchestration, T.governance] },
  { name: 'Automation & replication', tags: [T.triggers, T.replication, T.events] },
  { name: 'Workspace & limits', tags: ['Workspace'] },
];

export const developerSpec: Json = buildSpec({
  title: 'Zero Data Fabric - Developer API',
  version: '2.0.0',
  description:
    'Integrator-facing API of the Zero Data Fabric: federated **AST queries**, CRUD, analytics, metadata/manifests, governance and triggers across Postgres, MySQL, Oracle, MongoDB and Elasticsearch behind a Citus-backed hub.\n\n' +
    'The platform-wide operator view (admin, tenants, workers, plans, settings, health) is published separately as the **System API** at `/api-docs/system`.\n' +
    AUTH_GUIDE,
  ops: developerOps,
  tags: developerTags,
  tagGroups: developerTagGroups,
});
