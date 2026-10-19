/** Citus worker node management (`/api/admin/workers/*`). Platform ADMIN JWT session only. System spec only. */
import { OpDef, ex, jsonBody, pp, q, ref, refArray } from './shared';

const TAG = 'Admin: Workers (Citus)';
const WID = '7c9e6679-7425-40de-944b-e07fc1f90ae7';

const worker = {
  id: WID,
  name: 'worker1',
  host: 'worker1.internal',
  port: 5432,
  status: 'ACTIVE',
  shouldHaveShards: true,
  labels: { zone: 'ap-south-1a' },
  citusNodeId: 2,
  shardCount: 32,
  lastHealth: { status: 'UP', latencyMs: 4, checkedAt: '2026-10-19T09:00:00.000Z' },
  createdAt: '2026-10-01T10:00:00.000Z',
  updatedAt: '2026-10-19T09:00:00.000Z',
};

/** Shared defaults: platform ADMIN session, no tenant header. */
const base = { tag: TAG, auth: 'session' as const, platformAdmin: true, tenantHeader: false };
const rateLimited = { description: 'More than 30 worker mutations in a minute for this admin.', code: 'RATE_LIMITED', message: 'Too many worker changes, slow down' };
const idParam = [pp('id', 'Worker id (uuid) from `GET /api/admin/workers`.', WID)];
const citusDown = { description: 'Citus is not available on this hub (extension missing or not the coordinator).', code: 'CITUS_UNAVAILABLE', message: 'Citus extension is not installed or this node is not the coordinator' };

const rawWorkerOps: OpDef[] = [
  {
    ...base,
    method: 'get',
    path: '/api/admin/workers',
    summary: 'List worker nodes and cluster summary',
    description:
      'Returns the worker registry joined with live `pg_dist_node` data, a Citus capability probe and shard summary. Works without Citus (the registry stays readable and `citus.available` is `false`).',
    responses: {
      '200': {
        description: 'Capability probe, summary counters and workers.',
        schema: ref('WorkerListResponse'),
        example: { citus: { available: true, version: '13.0-1', isCoordinator: true }, summary: { total: 2, active: 2, draining: 0, down: 0, shards: 64 }, workers: [worker] },
      },
    },
  },
  {
    ...base,
    method: 'post',
    path: '/api/admin/workers',
    summary: 'Register a worker node',
    description:
      'Adds a node to the Citus cluster (`citus_add_node`) and records it in the registry. The node must be reachable from the coordinator. `name` and `host:port` must be unique.',
    body: jsonBody(ref('CreateWorkerRequest'), {
      basic: ex('Add a worker that receives shards', { name: 'worker1', host: 'worker1.internal', port: 5432 }),
      standby: ex('Add without shards (activate later)', { name: 'worker3', host: 'worker3.internal', port: 5432, shouldHaveShards: false, labels: { zone: 'ap-south-1b', tier: 'compute' } }),
    }),
    responses: { '201': { description: 'Worker registered.', schema: ref('Worker'), example: worker } },
    errors: {
      '400': { description: 'Invalid name/host/port.', code: 'INVALID_WORKER', message: 'port must be an integer between 1 and 65535' },
      '409': { description: 'Citus unavailable, or a worker with the same name or host:port already exists.', codes: ['CITUS_UNAVAILABLE', 'DUPLICATE_WORKER'], message: 'A worker with host worker1.internal:5432 already exists' },
      '502': { description: 'The coordinator could not reach the worker node.', code: 'WORKER_UNREACHABLE', message: 'could not connect to worker1.internal:5432' },
    },
  },
  {
    ...base,
    method: 'post',
    path: '/api/admin/workers/rebalance',
    summary: 'Start a shard rebalance',
    description:
      'Schedules a Citus shard rebalance across ACTIVE workers and returns immediately (202). Poll `GET /api/admin/workers/rebalance/status`. With `drainOnly: true` only shards on DRAINING nodes are moved.',
    body: jsonBody(ref('RebalanceRequest'), { all: ex('Full rebalance', {}), drainOnly: ex('Only move shards off draining nodes', { drainOnly: true }) }, undefined, false),
    responses: { '202': { description: 'Rebalance scheduled.', schema: ref('RebalanceAccepted'), example: { jobId: '42', status: 'scheduled' } } },
    errors: {
      '409': { description: 'Citus unavailable, a rebalance is already running, no ACTIVE workers, or the rebalance failed to start.', codes: ['CITUS_UNAVAILABLE', 'REBALANCE_RUNNING', 'NO_WORKERS', 'REBALANCE_FAILED'], message: 'A rebalance is already running' },
    },
  },
  {
    ...base,
    method: 'get',
    path: '/api/admin/workers/rebalance/status',
    summary: 'Rebalance progress',
    description: 'Status of the current / most recent shard rebalance (`citus_rebalance_status`).',
    responses: { '200': { description: 'Rebalance status.', schema: ref('RebalanceStatus'), example: { running: true, status: 'running', jobs: [{ job_id: 42, state: 'running', details: { progress: 0.35 } }] } } },
  },
  {
    ...base,
    method: 'get',
    path: '/api/admin/workers/tables',
    summary: 'List distributed tables',
    description: 'Tables known to Citus (`citus_tables`): distribution column, shard count, size and colocation group.',
    responses: {
      '200': {
        description: 'Distributed / reference tables.',
        schema: refArray('DistributedTable'),
        example: [{ schema: 'tenant_t1', table: 'orders', type: 'distributed', distributionColumn: 'tenant_id', shardCount: 32, sizeBytes: 104857600, colocationId: 1 }],
      },
    },
  },
  {
    ...base,
    method: 'post',
    path: '/api/admin/workers/tables/distribute',
    summary: 'Distribute a table across workers',
    description: 'Runs `create_distributed_table` for a tenant schema table. `schema` must start with `tenant_`.',
    body: jsonBody(ref('DistributeTableRequest'), { orders: ex('Distribute orders by tenant', { schema: 'tenant_t1', table: 'orders', column: 'tenant_id' }) }),
    responses: { '201': { description: 'Table distributed.', schema: ref('DistributeTableResponse'), example: { schema: 'tenant_t1', table: 'orders', column: 'tenant_id', status: 'DISTRIBUTED' } } },
    errors: {
      '400': { description: 'Bad identifiers or the distribution call failed.', codes: ['INVALID_TABLE', 'DISTRIBUTE_FAILED'], message: 'schema must start with tenant_' },
      '404': { description: 'The table does not exist.', code: 'TABLE_NOT_FOUND', message: 'Table tenant_t1.orders not found' },
      '409': { description: 'Citus unavailable, the table is already distributed, or there are no ACTIVE workers.', codes: ['CITUS_UNAVAILABLE', 'ALREADY_DISTRIBUTED', 'NO_WORKERS'], message: 'Table is already distributed' },
    },
  },
  {
    ...base,
    method: 'post',
    path: '/api/admin/workers/sync',
    summary: 'Re-sync registry with pg_dist_node',
    description: 'Reconciles the worker registry with Citus metadata: nodes missing from the registry are imported, vanished nodes are marked `DRIFT`/`DOWN`.',
    responses: { '200': { description: 'Sync finished.', schema: ref('WorkerSyncResult'), example: { status: 'SYNCED', added: 0, drifted: 0 } } },
    errors: { '409': { description: 'Citus unavailable.', code: 'CITUS_UNAVAILABLE', message: 'Citus extension is not installed or this node is not the coordinator' } },
  },
  {
    ...base,
    method: 'post',
    path: '/api/admin/workers/health',
    summary: 'Probe all workers',
    description: 'Runs a health probe against every registered worker and stores the result in `lastHealth`.',
    responses: {
      '200': {
        description: 'One result per worker.',
        schema: refArray('WorkerHealthResultWithId'),
        example: [{ id: WID, status: 'UP', latencyMs: 4, checkedAt: '2026-10-19T09:00:00.000Z' }, { id: '0b9e1a3c-6f1c-4a9b-8f6e-1d5d6c1d2a77', status: 'DOWN', latencyMs: 3000, checkedAt: '2026-10-19T09:00:00.000Z', error: 'connection refused' }],
      },
    },
  },
  {
    ...base,
    method: 'get',
    path: '/api/admin/workers/events',
    summary: 'Worker lifecycle audit events',
    description: 'Most recent worker-management events (add, drain, remove, rebalance, ...), newest first.',
    params: [q('limit', 'Maximum events to return.', { type: 'integer', minimum: 1, maximum: 500, default: 50 }, 50)],
    responses: {
      '200': {
        description: 'Events.',
        schema: refArray('WorkerEvent'),
        example: [{ id: 'c4f3a1', workerId: WID, action: 'DRAIN', actor: 'admin', detail: { rebalanceJobId: '42' }, createdAt: '2026-10-19T09:05:00.000Z' }],
      },
    },
  },
  {
    ...base,
    method: 'get',
    path: '/api/admin/workers/{id}',
    summary: 'Get a worker node',
    description: 'One registry entry enriched with its live Citus state.',
    params: idParam,
    responses: { '200': { description: 'The worker.', schema: ref('Worker'), example: worker } },
  },
  {
    ...base,
    method: 'patch',
    path: '/api/admin/workers/{id}',
    summary: 'Update a worker node',
    description: 'Rename the worker, change its labels, or toggle `shouldHaveShards` (`citus_set_node_property`).',
    params: idParam,
    body: jsonBody(ref('UpdateWorkerRequest'), { rename: ex('Rename and relabel', { name: 'worker1-renamed', labels: { tier: 'compute' } }), stopShards: ex('Stop placing new shards', { shouldHaveShards: false }) }),
    responses: { '200': { description: 'Updated worker.', schema: ref('Worker'), example: { ...worker, name: 'worker1-renamed' } } },
    errors: {
      '400': { description: 'Invalid field.', code: 'INVALID_WORKER', message: 'name must not be empty' },
      '409': { description: 'Citus unavailable or the new name is taken.', codes: ['CITUS_UNAVAILABLE', 'DUPLICATE_WORKER'], message: 'A worker named worker1-renamed already exists' },
    },
  },
  {
    ...base,
    method: 'post',
    path: '/api/admin/workers/{id}/activate',
    summary: 'Activate a worker',
    description: 'Sets `shouldhaveshards = true` so new shards (and rebalances) can land on the node and marks it `ACTIVE`.',
    params: idParam,
    responses: { '200': { description: 'Activated worker.', schema: ref('Worker'), example: worker } },
    errors: { '409': { description: 'Citus unavailable.', code: 'CITUS_UNAVAILABLE', message: 'Citus extension is not installed or this node is not the coordinator' } },
  },
  {
    ...base,
    method: 'post',
    path: '/api/admin/workers/{id}/drain',
    summary: 'Drain a worker',
    description:
      'Marks the node `DRAINING` (`shouldhaveshards = false`) and schedules a rebalance that moves its shards to other ACTIVE workers. If the rebalance cannot start the node stays DRAINING and `rebalanceError` explains why. Remove the node once `shardCount` reaches 0.',
    params: idParam,
    responses: {
      '202': {
        description: 'Drain started.',
        schema: ref('DrainAccepted'),
        example: { worker: { ...worker, status: 'DRAINING', shouldHaveShards: false }, rebalance: { jobId: '42', status: 'scheduled' }, rebalanceError: null },
      },
    },
    errors: { '409': { description: 'Citus unavailable or no other ACTIVE worker to receive shards.', codes: ['CITUS_UNAVAILABLE', 'NO_WORKERS'], message: 'No other active workers to drain onto' } },
  },
  {
    ...base,
    method: 'post',
    path: '/api/admin/workers/{id}/health',
    summary: 'Probe one worker',
    description: 'Runs a health probe against the worker and stores the result in `lastHealth`.',
    params: idParam,
    responses: { '200': { description: 'Probe result.', schema: ref('WorkerHealthResult'), example: { status: 'UP', latencyMs: 4, checkedAt: '2026-10-19T09:00:00.000Z' } } },
  },
  {
    ...base,
    method: 'delete',
    path: '/api/admin/workers/{id}',
    summary: 'Remove a worker node',
    description: 'Removes the node (`citus_remove_node`) and its registry row. Refused while the node still holds shards (drain it first) and for the last remaining worker.',
    params: idParam,
    responses: { '204': { description: 'Worker removed. No body.' } },
    errors: { '409': { description: 'Citus unavailable, the node still holds shards, or it is the last worker.', codes: ['CITUS_UNAVAILABLE', 'WORKER_HAS_SHARDS', 'LAST_WORKER'], message: 'Worker still holds 32 shards; drain it first' } },
  },
];

/** Mutating calls are limited to 30/minute/admin by the server. */
export const workerOps: OpDef[] = rawWorkerOps.map((o) => (o.method === 'get' ? o : { ...o, errors: { ...o.errors, '429': rateLimited } }));

export const workerTags = [
  {
    name: TAG,
    description:
      'Manage the Citus compute tier behind the hub: register / activate / drain / remove worker nodes, rebalance shards, distribute tables and probe health. **Platform ADMIN JWT session only** (API tokens receive 403). Without Citus the registry stays readable and mutating calls answer `409 CITUS_UNAVAILABLE`.',
  },
];
