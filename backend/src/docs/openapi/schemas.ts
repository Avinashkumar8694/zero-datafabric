/**
 * Component schemas for both OpenAPI documents. Starts from the carried-over base schemas
 * (schemas.base.ts), removes every SQL-era field (`raw-sql` legs, `SQL` saved-analytic mode ...)
 * and adds the new schemas (Error, tokens, workers, replication, plans ...).
 */
import { baseSchemas } from './schemas.base';
import { tenancySchemas } from './schemas.tenancy';

/* eslint-disable @typescript-eslint/no-explicit-any */
const ref = (name: string) => ({ $ref: `#/components/schemas/${name}` });
const str = (example?: any, description?: string, extra: any = {}) => ({ type: 'string', ...(example !== undefined ? { example } : {}), ...(description ? { description } : {}), ...extra });
const int = (example?: any, description?: string, extra: any = {}) => ({ type: 'integer', ...(example !== undefined ? { example } : {}), ...(description ? { description } : {}), ...extra });
const dt = (description?: string, extra: any = {}) => ({ type: 'string', format: 'date-time', ...(description ? { description } : {}), ...extra });
const arr = (items: any, extra: any = {}) => ({ type: 'array', items, ...extra });

const b: Record<string, any> = JSON.parse(JSON.stringify(baseSchemas));

/* ---- SQL-era clean-ups on carried-over schemas ---- */
b.LegTrace.properties.operation.description = 'scan | aggregate | join-driving | bind-join | partial-aggregate | union-leg | create | update | delete';
b.QueryPlan.properties.strategy.enum = ['SINGLE_LOCAL', 'SINGLE_CONNECTOR', 'CROSS_ENGINE', 'SINGLE_CONNECTOR_WRITE'];
b.QueryLog.properties.mode.description = 'SELECT_AST | CALL | RECURSIVE | CRUD_CREATE | CRUD_UPDATE | CRUD_DELETE | FETCH | SEQUENCE | SAVED_ANALYTIC | ...';
b.QueryLog.properties.api.example = '/api/analytics/query';
delete b.QueryLog.properties.query_text.example;
b.QueryLog.properties.query_text.description = 'JSON of the AST / request body that was executed.';

b.SavedAnalytic.description =
  'A reusable, parameterized analytic. The AST in `config` may reference declared variables with `{{name}}` tokens. (Raw-SQL analytics are no longer supported.)';
b.SavedAnalytic.properties.mode = { type: 'string', enum: ['AST'], example: 'AST' };
delete b.SavedAnalytic.properties.sql;
b.SavedAnalytic.properties.source = str('Fabric_Hub_Postgres', 'Default source for the AST.');

b.MaskRule.properties.strategy = { type: 'string', enum: ['REDACT', 'NULL', 'HASH', 'PARTIAL'], example: 'PARTIAL' };

b.AstQuery.properties.where.items.properties.operator.enum = ['EQ', 'NE', 'GT', 'GTE', 'LT', 'LTE', 'LIKE', 'ILIKE', 'IN', 'IS_NULL', 'IS_NOT_NULL'];
b.QueryConfig.properties.type = { type: 'string', enum: ['SELECT', 'CALL'], example: 'SELECT', description: '`SELECT` runs the `query` AST; `CALL` invokes a provisioned function/procedure (`function`/`procedure` + `args`).' };
b.QueryConfig.properties.stream = { type: 'boolean', default: false, description: 'Stream rows as NDJSON (use with `Accept: application/x-ndjson`).' };
b.QueryConfig.required = ['type'];
b.QueryConfig.description = 'Engine-agnostic query configuration. Only structured AST is accepted - never SQL strings.';
b.QueryConfig.example = {
  type: 'SELECT',
  schema: 'an_lab',
  limit: 10,
  query: { from: { resource: 'employees', source: 'An_Lab' }, select: ['id', 'name', 'dept_id'], where: [{ column: 'dept_id', operator: 'EQ', value: 10 }] },
};

b.MetadataManifest.properties.schemas = arr(ref('SchemaDefinition'));
b.SchemaDefinition.properties.resources = arr(ref('ResourceDefinition'));
b.ResourceDefinition.properties.columns = arr(ref('ColumnDefinition'));
b.ResourceDefinition.additionalProperties = true;

b.AsyncJobResponse.properties.status.enum = ['PENDING', 'RUNNING', 'COMPLETED', 'FAILED'];

export const schemas: Record<string, any> = {
  ...b,
  ...tenancySchemas,

  /* ---------------- errors ---------------- */
  Error: {
    type: 'object',
    required: ['error'],
    description:
      'Standard error body returned for every non-2xx response. `code` is a stable machine-readable identifier (legacy endpoints may omit it; always branch on HTTP status first).',
    properties: {
      error: str('Token is missing required scope: data:write', 'Human readable message.'),
      code: str('SCOPE_REQUIRED', 'Stable error code, e.g. SQL_NOT_SUPPORTED, VALIDATION_ERROR, UNAUTHENTICATED, INVALID_TOKEN, TOKEN_REVOKED, TOKEN_EXPIRED, SCOPE_REQUIRED, TOKEN_NOT_ALLOWED, TENANT_SUSPENDED, TOKEN_FROM_TOKEN, INVALID_SCOPE, TOKEN_NOT_FOUND, NOT_FOUND, CONFLICT, RATE_LIMITED, CITUS_UNAVAILABLE, WORKER_HAS_SHARDS, DUPLICATE_WORKER, INVALID_WORKER.'),
    },
  },

  /* ---------------- auth ---------------- */
  LoginRequest: {
    type: 'object',
    required: ['username', 'password'],
    properties: { username: str('alice'), password: str('s3cret!', undefined, { format: 'password' }), timezone: str('Asia/Kolkata', 'Optional IANA timezone stored on the user.') },
  },
  LoginResponse: {
    type: 'object',
    properties: {
      token: str('eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...', 'Session JWT (1 hour).'),
      user: { type: 'object', properties: { id: str('b1c2d3e4-...'), username: str('alice'), tenant_id: str('tenant_A') } },
    },
  },
  TokenExchangeRequest: { type: 'object', required: ['tenantId'], properties: { tenantId: str('tenant_B', 'Tenant to scope the new JWT to (must be owned by the caller unless ADMIN).') } },
  TokenExchangeResponse: { type: 'object', properties: { token: str('eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...', 'New JWT scoped to the requested tenant.') } },

  /* ---------------- developer tokens ---------------- */
  DeveloperScope: { type: 'string', enum: ['query:read', 'data:read', 'data:write', 'metadata:read', 'metadata:write', 'triggers:read', 'triggers:write'], example: 'query:read' },
  DeveloperScopes: { type: 'object', properties: { scopes: arr(ref('DeveloperScope')) } },
  CreateDeveloperTokenRequest: {
    type: 'object',
    required: ['name', 'scopes'],
    properties: {
      name: str('etl-pipeline', 'Human-friendly label.'),
      scopes: arr(ref('DeveloperScope'), { minItems: 1, uniqueItems: true }),
      expiresInDays: int(90, 'Lifetime in days (1-365). Default 90.', { minimum: 1, maximum: 365, default: 90 }),
    },
  },
  DeveloperToken: {
    type: 'object',
    description: 'Token metadata. The secret is never returned after creation.',
    properties: {
      id: str('7c9e6679-7425-40de-944b-e07fc1f90ae7', undefined, { format: 'uuid' }),
      name: str('etl-pipeline'),
      prefix: str('a1b2c3d4', 'Public prefix (the `<prefix>` in `dft_<prefix>_<secret>`), safe to display.'),
      scopes: arr(ref('DeveloperScope')),
      expiresAt: dt('Expiry timestamp.', { nullable: true }),
      lastUsedAt: dt('Last successful use.', { nullable: true }),
      revokedAt: dt('Set when the token has been revoked.', { nullable: true }),
      createdAt: dt(),
    },
  },
  CreatedDeveloperToken: {
    type: 'object',
    description: 'Response to token creation. `token` is the only time the full secret is shown.',
    properties: {
      id: str('7c9e6679-7425-40de-944b-e07fc1f90ae7', undefined, { format: 'uuid' }),
      name: str('etl-pipeline'),
      prefix: str('a1b2c3d4'),
      scopes: arr(ref('DeveloperScope')),
      expiresAt: dt('Expiry timestamp.'),
      createdAt: dt(),
      token: str('dft_a1b2c3d4_9f8e7d6c5b4a39281706f5e4d3c2b1a0', 'Full token `dft_<prefix>_<secret>`. Shown once - store it now.'),
    },
  },

  /* ---------------- data CRUD ---------------- */
  DataWhere: {
    type: 'object',
    description: 'Filter: `{ "col": value }` for equality, or `{ "col": { "$op": value } }` with `$eq $ne $gt $gte $lt $lte $like $ilike $in`.',
    additionalProperties: true,
    example: { dept_id: 10, salary: { $gt: 200 } },
  },
  DataFetchRequest: {
    type: 'object',
    required: ['resource'],
    properties: {
      source: str('An_Lab', 'Data source name; omit for the hub.'),
      schema: str('an_lab'),
      resource: str('employees', 'Table / collection / index.'),
      columns: arr({ type: 'string' }, { example: ['id', 'name', 'dept_id'] }),
      where: ref('DataWhere'),
      orderBy: arr({ type: 'object', properties: { column: str('salary'), direction: { type: 'string', enum: ['ASC', 'DESC'] } } }),
      limit: int(25),
      offset: int(0),
    },
  },
  DataCreateRequest: {
    type: 'object',
    required: ['resource', 'data'],
    properties: {
      source: str('An_Lab'),
      schema: str('an_lab'),
      resource: str('employees'),
      data: { description: 'One row object or an array of row objects.', oneOf: [{ type: 'object', additionalProperties: true }, arr({ type: 'object', additionalProperties: true })] },
      generate: { type: 'object', additionalProperties: true, description: 'Write-time generators for engines without column defaults, e.g. `{ "id": "UUID_V7" }`.', example: { id: 'UUID_V7' } },
    },
  },
  DataUpdateRequest: {
    type: 'object',
    required: ['resource', 'where', 'data'],
    properties: {
      source: str('An_Lab'),
      schema: str('an_lab'),
      resource: str('employees'),
      where: ref('DataWhere'),
      data: { type: 'object', additionalProperties: true, example: { salary: 150 } },
      generate: { type: 'object', additionalProperties: true },
    },
  },
  DataDeleteRequest: {
    type: 'object',
    required: ['resource', 'where'],
    properties: { source: str('An_Lab'), schema: str('an_lab'), resource: str('employees'), where: ref('DataWhere') },
  },
  DataCallRequest: {
    type: 'object',
    properties: { schema: str('public'), function: str('calc_ltv'), procedure: str('rebuild_index'), args: arr({}, { example: [42, 'EU'] }) },
  },
  SequenceRequest: {
    type: 'object',
    required: ['name'],
    properties: { name: str('order_id_seq'), start: int(1000), increment: int(1), count: int(5, 'Reserve this many values at once.') },
  },
  SequenceResponse: {
    type: 'object',
    properties: { name: str('order_id_seq'), value: int(1005), values: arr({ type: 'integer' }, { example: [1001, 1002, 1003, 1004, 1005] }) },
  },

  /* ---------------- query engine ---------------- */
  AnalyticsQueryRequest: {
    type: 'object',
    required: ['queryConfig'],
    properties: { queryConfig: ref('QueryConfig') },
  },
  EngineQueryRequest: {
    description: 'A QueryConfig directly as the body, or wrapped as `{ "config": QueryConfig }`.',
    oneOf: [ref('QueryConfig'), { type: 'object', required: ['config'], properties: { config: ref('QueryConfig') } }],
  },
  TranspileRequest: {
    description: 'A `QueryConfig` (or `{ config: QueryConfig }`). Never executes anything.',
    oneOf: [ref('QueryConfig'), { type: 'object', required: ['config'], properties: { config: ref('QueryConfig') } }],
  },
  TranspileResponse: {
    type: 'object',
    properties: {
      sql: str('SELECT "id", "name", "dept_id" FROM "tenant_t1_an_lab"."employees" WHERE "dept_id" = 10 LIMIT 10;', 'Preview only - this text is never executed by the platform.'),
      note: str('RECURSIVE_IN_FABRIC', 'Present for recursive queries (no single SQL form).'),
      error: str(undefined, 'Present (with HTTP 200) when the AST could not be transpiled; `sql` then holds a commented message.'),
    },
  },
  JobStatus: {
    type: 'object',
    properties: {
      jobId: str('0b9e1a3c-6f1c-4a9b-8f6e-1d5d6c1d2a77'),
      status: { type: 'string', enum: ['PENDING', 'RUNNING', 'COMPLETED', 'FAILED', 'NOT_FOUND'], example: 'COMPLETED' },
      result: { description: 'Result envelope when COMPLETED.', allOf: [ref('QueryEnvelope')] },
      error: str(undefined, 'Failure message when FAILED.', { nullable: true }),
    },
  },
  RefreshViewRequest: {
    type: 'object',
    required: ['viewName'],
    properties: { viewName: str('mv_revenue_by_region'), schema: str('default', undefined, { default: 'default' }), concurrent: { type: 'boolean', default: true } },
  },
  RefreshViewResponse: { type: 'object', properties: { status: str('accepted'), message: str('View refresh initiated in background'), jobId: str('0b9e1a3c-6f1c-4a9b-8f6e-1d5d6c1d2a77') } },
  NdjsonStream: { type: 'string', description: 'Newline-delimited JSON: one row object per line, then a final `{"__meta__": {rowCount, strategy, plan, warnings}}` line.', example: '{"id":1,"name":"Asha","dept_id":10}\n{"id":2,"name":"Ravi","dept_id":10}\n{"__meta__":{"rowCount":2,"strategy":"SINGLE_CONNECTOR"}}\n' },

  /* ---------------- saved analytics ---------------- */
  SavedAnalyticRunRequest: { type: 'object', properties: { variables: { type: 'object', additionalProperties: true, example: { dept: 20 } } } },
  SavedAnalyticDeleted: { type: 'object', properties: { status: str('DELETED'), id: str('b1c2d3e4-...') } },

  /* ---------------- metadata ---------------- */
  CatalogSource: { type: 'object', additionalProperties: true, properties: { id: str('src_1'), name: str('Retail_Core'), type: str('postgres'), status: str('CONNECTED') } },
  CatalogColumn: { type: 'object', additionalProperties: true, properties: { name: str('id'), type: str('uuid'), nullable: { type: 'boolean' }, isPrimaryKey: { type: 'boolean' } } },
  MetadataDiffResult: {
    type: 'object',
    properties: {
      status: str('PLAN_READY'),
      summary: { type: 'object', additionalProperties: true, example: { total: 17, highRisk: 0 } },
      changes: arr({ type: 'object', additionalProperties: true }),
    },
  },
  MetadataApplyResult: {
    type: 'object',
    properties: { plan: arr({ type: 'object', additionalProperties: true }), results: arr({ type: 'object', additionalProperties: true }) },
  },
  MigrationRequest: { type: 'object', required: ['migrationPlan'], properties: { migrationPlan: arr({ type: 'object', additionalProperties: true }, { example: [{ op: 'ADD_COLUMN', schema: 'public', table: 'orders', column: { name: 'notes', type: 'text' } }] }) } },
  QueuedRun: {
    type: 'object',
    properties: { status: str('QUEUED'), runId: str('run_8f2a...'), run: { type: 'object', additionalProperties: true, description: 'Copy-job run record.' } },
  },
  CrawlRequest: { type: 'object', properties: { tenantId: str('tenant_A', 'ADMIN only: crawl another tenant. Ignored for other callers.') } },
  SyncRequest: {
    type: 'object',
    required: ['source'],
    properties: {
      source: str('Retail_Core', 'Registered data source to replicate into the hub.'),
      mode: { type: 'string', enum: ['full', 'cdc'], default: 'full' },
      tenantId: str(undefined, 'ADMIN only.'),
      pageSize: int(5000),
      memCeilingMb: int(256),
      maxRows: int(1000000),
    },
  },
  DownstreamToggleRequest: { type: 'object', required: ['targetType'], properties: { targetType: { type: 'string', enum: ['ELASTICSEARCH', 'SNOWFLAKE'], example: 'ELASTICSEARCH' }, enabled: { type: 'boolean', example: true } } },

  /* ---------------- replication ---------------- */
  ReplicationJob: {
    type: 'object',
    properties: {
      id: str('rep_01'),
      name: str('retail-to-dr'),
      sourceName: str('Retail_Core'),
      destName: str('DR_Postgres'),
      mode: { type: 'string', enum: ['ONE_WAY', 'TWO_WAY'] },
      strategy: { type: 'string', enum: ['FULL', 'INCREMENTAL', 'CDC'] },
      cdcColumn: str('updated_at', undefined, { nullable: true }),
      destSchema: str('replica', undefined, { nullable: true }),
      scheduleMs: int(3600000, undefined, { nullable: true }),
      status: str('ACTIVE'),
      createdAt: dt(),
    },
  },
  CreateReplicationJobRequest: {
    type: 'object',
    required: ['name', 'sourceName', 'destName'],
    properties: {
      name: str('retail-to-dr'),
      sourceName: str('Retail_Core'),
      destName: str('DR_Postgres'),
      mode: { type: 'string', enum: ['ONE_WAY', 'TWO_WAY'], default: 'ONE_WAY' },
      strategy: { type: 'string', enum: ['FULL', 'INCREMENTAL', 'CDC'], default: 'FULL' },
      cdcColumn: str('updated_at'),
      destSchema: str('replica'),
      scheduleMs: int(3600000),
      initialLoad: { type: 'string', enum: ['FULL', 'NONE'], default: 'FULL' },
      pageSize: int(5000),
      memCeilingMb: int(256),
      maxRows: int(1000000),
      tenantId: str(undefined, 'ADMIN only.'),
    },
  },
  ReplicationRunRequest: { type: 'object', properties: { full: { type: 'boolean', description: 'Force a full snapshot now.' }, pageSize: int(5000), memCeilingMb: int(256), maxRows: int(1000000) } },
  ReplicationRestoreRequest: { type: 'object', required: ['targetSource'], properties: { targetSource: str('Retail_Core', 'Source that receives the restored data.'), pageSize: int(5000), memCeilingMb: int(256), maxRows: int(1000000) } },
  CopyRun: { type: 'object', additionalProperties: true, description: 'Copy-job run record.', properties: { id: str('run_8f2a...'), type: str('REPLICATE'), status: str('RUNNING'), jobRef: str('rep_01'), startedAt: dt(), finishedAt: dt(undefined, { nullable: true }) } },
  RunControlResponse: { type: 'object', properties: { status: { type: 'string', example: 'PAUSING' }, run: ref('CopyRun') } },
  Deleted: { type: 'object', properties: { status: str('DELETED') } },

  /* ---------------- admin ---------------- */
  CreateTenantRequest: { type: 'object', required: ['id', 'name'], properties: { id: str('tenant_B'), name: str('New Tenant') } },
  UpdateTenantRequest: { type: 'object', properties: { name: str('Acme Corp (renamed)'), status: { type: 'string', enum: ['ACTIVE', 'SUSPENDED'], example: 'SUSPENDED' } } },
  TenantDeleted: { type: 'object', properties: { status: str('DELETED'), id: str('tenant_A') } },
  CreateConnectionRequest: {
    type: 'object',
    required: ['name', 'config'],
    properties: {
      name: str('Retail_Core'),
      config: {
        type: 'object',
        required: ['host', 'port', 'dbName', 'user', 'pass', 'syncType'],
        properties: {
          type: str('postgres', 'Connector type (postgres, mysql, oracle, mongodb, elasticsearch...).'),
          host: str('db.internal'),
          port: int(5432),
          dbName: str('retail'),
          user: str('fabric_reader'),
          pass: str('********', undefined, { format: 'password' }),
          syncType: { type: 'string', enum: ['VIRTUAL', 'CDC'], example: 'VIRTUAL' },
        },
      },
    },
  },
  ConnectionStatusRequest: { type: 'object', required: ['sourceId', 'status'], properties: { sourceId: str('src_1'), status: { type: 'string', enum: ['CONNECTED', 'DISCONNECTED'], example: 'DISCONNECTED' } } },
  Connection: {
    type: 'object',
    additionalProperties: true,
    properties: { id: str('src_1'), name: str('Retail_Core'), type: str('postgres'), status: str('CONNECTED'), live_status: { type: 'string', enum: ['LIVE', 'OFFLINE', 'UNREACHABLE', 'UNKNOWN'], example: 'LIVE' } },
  },
  PlatformUser: { type: 'object', properties: { id: str('b1c2d3e4-...'), username: str('alice'), tenant_id: str('tenant_A'), role: str('ANALYST'), timezone: str('Asia/Kolkata', undefined, { nullable: true }), created_at: dt() } },
  CreateUserRequest: { type: 'object', required: ['username', 'password', 'tenantId', 'role'], properties: { username: str('alice'), password: str('s3cret!', undefined, { format: 'password' }), tenantId: str('tenant_A'), role: str('ANALYST', 'USER | ANALYST | ADMIN ...') } },
  UpdateUserRequest: { type: 'object', properties: { username: str('alice'), password: str(undefined, undefined, { format: 'password' }), tenantId: str('tenant_A'), role: str('ANALYST') } },
  DashboardStats: { type: 'object', properties: { tenants: int(3), connections: int(5), audits: int(128, 'Audit events in the last 24 hours.') } },
  CatalogSummaryRow: { type: 'object', properties: { schema_name: str('tenant_A_public'), table_name: str('orders'), row_count: int(1200), last_crawled_at: dt() } },
  NotificationChannel: {
    type: 'object',
    properties: {
      id: str('c0a8...'),
      channelType: { type: 'string', enum: ['WEBHOOK', 'SLACK', 'EMAIL', 'TELEGRAM'], example: 'SLACK' },
      name: str('ops-alerts'),
      config: { type: 'object', additionalProperties: true, example: { url: 'https://hooks.example.com/notify' } },
      isDefault: { type: 'boolean' },
      status: str('ACTIVE'),
    },
  },
  UpsertNotificationChannelRequest: {
    type: 'object',
    required: ['channelType', 'name', 'config'],
    properties: {
      channelType: { type: 'string', enum: ['WEBHOOK', 'SLACK', 'EMAIL', 'TELEGRAM'], example: 'WEBHOOK' },
      name: str('ops-alerts'),
      config: { type: 'object', additionalProperties: true, example: { url: 'https://hooks.example.com/notify' } },
      isDefault: { type: 'boolean', default: false },
      status: str('ACTIVE', undefined, { default: 'ACTIVE' }),
    },
  },
  TestNotificationRequest: { type: 'object', required: ['channelType'], properties: { channelType: str('WEBHOOK'), name: str('ops-alerts'), sample: { type: 'object', additionalProperties: true, description: 'Channel-specific fields merged into the test payload.' } } },
  TestNotificationResponse: { type: 'object', properties: { status: str('ENQUEUED'), jobId: str('job_42') } },

  /* ---------------- workers (Citus) ---------------- */
  WorkerHealth: {
    type: 'object',
    properties: { status: { type: 'string', enum: ['UP', 'DOWN'], example: 'UP' }, latencyMs: int(4), checkedAt: dt() },
  },
  Worker: {
    type: 'object',
    properties: {
      id: str('7c9e6679-7425-40de-944b-e07fc1f90ae7', undefined, { format: 'uuid' }),
      name: str('worker1'),
      host: str('worker1.internal'),
      port: int(5432),
      status: { type: 'string', enum: ['ACTIVE', 'DRAINING', 'INACTIVE', 'DOWN', 'DRIFT'], example: 'ACTIVE', description: '`DRIFT` = registry and `pg_dist_node` disagree; run `POST /api/admin/workers/sync`.' },
      shouldHaveShards: { type: 'boolean', example: true },
      labels: { type: 'object', additionalProperties: true, example: { zone: 'ap-south-1a', tier: 'compute' } },
      citusNodeId: int(2, undefined, { nullable: true }),
      shardCount: int(32),
      lastHealth: { allOf: [ref('WorkerHealth')], nullable: true },
      createdAt: dt(),
      updatedAt: dt(),
    },
  },
  CreateWorkerRequest: {
    type: 'object',
    required: ['name', 'host', 'port'],
    properties: {
      name: str('worker1'),
      host: str('worker1.internal'),
      port: int(5432),
      shouldHaveShards: { type: 'boolean', default: true },
      labels: { type: 'object', additionalProperties: true, example: { zone: 'ap-south-1a' } },
    },
  },
  UpdateWorkerRequest: {
    type: 'object',
    properties: { name: str('worker1-renamed'), shouldHaveShards: { type: 'boolean', example: false }, labels: { type: 'object', additionalProperties: true } },
  },
  WorkerHealthResult: {
    type: 'object',
    required: ['status', 'latencyMs', 'checkedAt'],
    properties: { status: { type: 'string', enum: ['UP', 'DOWN'] }, latencyMs: int(4), checkedAt: dt(), error: str('connection refused', 'Present when status is DOWN.') },
  },
  WorkerHealthResultWithId: {
    type: 'object',
    required: ['id', 'status', 'latencyMs', 'checkedAt'],
    properties: { id: str('7c9e6679-7425-40de-944b-e07fc1f90ae7', undefined, { format: 'uuid' }), status: { type: 'string', enum: ['UP', 'DOWN'] }, latencyMs: int(4), checkedAt: dt(), error: str('connection refused', 'Present when status is DOWN.') },
  },
  WorkerEvent: {
    type: 'object',
    properties: {
      id: str('c4f3...'),
      workerId: str('7c9e6679-7425-40de-944b-e07fc1f90ae7', undefined, { nullable: true }),
      action: str('DRAIN', 'ADD | ACTIVATE | DRAIN | REMOVE | REBALANCE | HEALTH | SYNC | DISTRIBUTE ...'),
      actor: str('admin'),
      detail: { type: 'object', additionalProperties: true, nullable: true },
      createdAt: dt(),
    },
  },
  WorkerListResponse: {
    type: 'object',
    properties: {
      citus: {
        type: 'object',
        properties: {
          available: { type: 'boolean', description: 'Is the `citus` extension installed on this hub?' },
          version: str('13.0-1', undefined, { nullable: true }),
          isCoordinator: { type: 'boolean' },
        },
      },
      summary: {
        type: 'object',
        properties: { total: int(3), active: int(2), draining: int(1), down: int(0), shards: int(96) },
      },
      workers: arr(ref('Worker')),
    },
  },
  RebalanceRequest: {
    type: 'object',
    properties: { drainOnly: { type: 'boolean', default: false, description: 'Only move shards off nodes that are draining (`citus_rebalance_start` with drain_only) instead of fully rebalancing.' } },
  },
  RebalanceAccepted: { type: 'object', properties: { jobId: str('42', 'Citus rebalance job id.'), status: str('scheduled') } },
  DrainAccepted: {
    type: 'object',
    properties: {
      worker: ref('Worker'),
      rebalance: { type: 'object', nullable: true, properties: { jobId: str('42'), status: str('scheduled') }, description: 'Rebalance job started to move shards off the node; null when none was started.' },
      rebalanceError: str(undefined, 'Why the rebalance could not be started (the node is still marked DRAINING).', { nullable: true }),
    },
  },
  RebalanceStatus: {
    type: 'object',
    additionalProperties: true,
    properties: { running: { type: 'boolean' }, status: str('running'), jobs: arr({ type: 'object', additionalProperties: true }) },
  },
  DistributedTable: {
    type: 'object',
    properties: {
      schema: str('tenant_t1'),
      table: str('orders'),
      type: str('distributed', 'distributed | reference | local ...'),
      distributionColumn: str('tenant_id', undefined, { nullable: true }),
      shardCount: int(32),
      sizeBytes: int(104857600),
      colocationId: int(1, undefined, { nullable: true }),
    },
  },
  DistributeTableRequest: { type: 'object', required: ['schema', 'table', 'column'], properties: { schema: str('tenant_t1', 'Must start with `tenant_`.'), table: str('orders'), column: str('tenant_id', 'Distribution column.') } },
  DistributeTableResponse: { type: 'object', properties: { schema: str('tenant_t1'), table: str('orders'), column: str('tenant_id'), status: str('DISTRIBUTED') } },
  WorkerSyncResult: { type: 'object', additionalProperties: true, properties: { status: str('SYNCED') } },

  /* ---------------- plans / subscriptions / settings / health ---------------- */
  Plan: {
    type: 'object',
    properties: {
      id: str('plan_trial'),
      name: str('trial'),
      price_monthly: { type: 'number', example: 0 },
      limits: { type: 'object', additionalProperties: true, example: { max_tenants: 1, max_connections: 2, max_triggers: 3, requests_per_minute: 60 } },
      features: { type: 'object', additionalProperties: true, example: { trial_period_days: 7 } },
      description: str('For growing teams', undefined, { nullable: true }),
      is_default: { type: 'boolean' },
      is_custom: { type: 'boolean', description: '"By arrangement" plan: not selectable by workspaces, a plan request is sent instead.' },
      status: { type: 'string', enum: ['active', 'disabled', 'hidden', 'upcoming', 'inactive'], example: 'active', description: '`inactive` is the legacy `/api/plans` value; the plan catalogue uses active | disabled | hidden | upcoming.' },
      contact_config: { type: 'object', nullable: true, additionalProperties: true, description: 'Contact-us details for custom plans.' },
      max_tenants: { type: 'integer', example: -1, description: 'Workspaces one owner may hold on this plan (-1 = unlimited).' },
      created_at: dt(),
    },
  },
  PlanInput: {
    type: 'object',
    required: ['name'],
    properties: {
      name: str('pro'),
      price_monthly: { type: 'number', example: 49 },
      limits: { type: 'object', additionalProperties: true },
      features: { type: 'object', additionalProperties: true },
      is_default: { type: 'boolean' },
      is_custom: { type: 'boolean' },
      status: { type: 'string', enum: ['active', 'inactive'], default: 'active' },
    },
  },
  PlanDeleted: { type: 'object', properties: { success: { type: 'boolean', example: true }, message: str('Plan deleted') } },
  Subscription: {
    type: 'object',
    additionalProperties: true,
    properties: {
      id: str('sub_01'),
      user_id: str('b1c2d3e4-...'),
      plan_id: str('plan_trial'),
      plan_name: str('trial'),
      status: str('active'),
      start_date: dt(),
      end_date: dt(undefined, { nullable: true }),
      limits: { type: 'object', additionalProperties: true },
      features: { type: 'object', additionalProperties: true },
      is_trial_expired: { type: 'boolean' },
      next_data_reset_at: dt(undefined, { nullable: true }),
    },
  },
  SubscriptionInput: { type: 'object', required: ['plan_id'], properties: { plan_id: str('plan_pro'), status: str('active'), end_date: dt(), snapshot: { type: 'object', additionalProperties: true } } },
  PlanLimits: { type: 'object', properties: { limits: { type: 'object', additionalProperties: true }, features: { type: 'object', additionalProperties: true } } },
  LoginSettingsPublic: {
    type: 'object',
    properties: {
      selfhost: { type: 'boolean' },
      title: str('Data Fabric'),
      logo_url: str(''),
      bg_color: str('#04060f'),
      allow_password_login: { type: 'boolean' },
      sso_enabled: { type: 'boolean' },
      oidc_issuer: str('https://ids.fabrixly.com'),
      oidc_client_id: str('zero-datafabric'),
    },
  },
  LoginSettingsInput: {
    type: 'object',
    properties: {
      title: str('Acme Data'),
      logo_url: str('https://cdn.example.com/logo.svg'),
      bg_color: str('#04060f'),
      allow_password_login: { type: 'boolean' },
      sso_enabled: { type: 'boolean' },
      oidc_issuer: str('https://ids.example.com'),
      oidc_client_id: str('zero-datafabric'),
      oidc_client_secret: str(undefined, 'Never returned by the public endpoint.', { format: 'password' }),
    },
  },
  LoginSettingsRaw: { type: 'object', additionalProperties: true, description: 'Full stored login configuration including the OIDC client secret.' },
  HealthResponse: {
    type: 'object',
    properties: {
      status: { type: 'string', enum: ['HEALTHY', 'UNHEALTHY'], example: 'HEALTHY' },
      uptime: str('12h 30m'),
      database: {
        type: 'object',
        properties: { latency: str('5ms'), pool: { type: 'object', properties: { total: int(10), idle: int(8), waiting: int(0) } } },
      },
    },
  },
  UpStatus: { type: 'object', properties: { status: str('UP') } },
  TimezoneRequest: { type: 'object', required: ['timezone'], properties: { timezone: str('Asia/Kolkata', 'IANA timezone name.') } },
  MessageResponse: { type: 'object', properties: { message: str('Timezone updated successfully') } },
  DeveloperDocsList: { type: 'array', items: { type: 'object', additionalProperties: true, properties: { label: str('Getting Started'), docs: arr({ type: 'object', properties: { id: str('README.md'), title: str('Developer Getting Started') } }) } } },
  DeveloperDoc: { type: 'object', additionalProperties: true, properties: { id: str('README.md'), title: str('Developer Getting Started'), html: str('<h1>...</h1>') } },
  GlobalEvent: { type: 'object', additionalProperties: true, properties: { id: str('evt_1'), type: str('SCHEMA_APPLIED'), message: str('Manifest v7 applied'), created_at: dt() } },
  AuditLog: {
    type: 'object',
    additionalProperties: true,
    properties: { id: str('1024'), tenant_id: str('tenant_A'), user_name: str('alice'), action: { type: 'string', enum: ['INSERT', 'UPDATE', 'DELETE'] }, table_name: str('orders'), changed_at: dt() },
  },
};
