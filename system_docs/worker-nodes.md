# Worker nodes (distributed execution)

The hub Postgres is a **Citus coordinator**. Workers are Citus nodes that store shards of distributed tables and execute the parallel sub-queries the coordinator fans out. Applications still see one database; the fabric (AST engine) emits SQL internally and Citus parallelises it.

## Manage workers
Settings > **Worker nodes** (platform admins) or `/api/admin/workers/*` (see `/api-docs/system`).

| Action | What it does |
| --- | --- |
| Add | `citus_add_node(host, port)`; the registry row is removed again if Citus cannot reach the node |
| Drain | stops placing shards on the node and starts a background rebalance that moves its shards away |
| Activate | lets the node receive shards again |
| Remove | `citus_remove_node`; refused while the node still holds shards (drain first) or is the last worker of distributed tables |
| Rebalance | background, cluster-wide shard rebalance (`citus_rebalance_start`) |
| Distribute table | `create_distributed_table` for tenant tables (`tenant_*` schemas only) |
| Sync | reconciles the registry with `pg_dist_node` (imports unknown workers, flags `DRIFT`) |

## Prerequisites
- Hub image `citusdata/citus` and the same major version on every worker.
- `wal_level=logical` on coordinator and workers for online shard moves. Without it the fabric falls back to `block_writes` (writes to a shard pause while it moves) and the UI shows a warning.
- The coordinator must be reachable from workers by name: set `COORDINATOR_HOST` / `COORDINATOR_PORT` (compose: `db`).
- Local trial: `docker compose --profile workers up -d`, then register `worker1` and `worker2` on port 5432.

## Safety rules
Host must be a hostname or IPv4 (no URL, no port, no spaces); link-local/metadata addresses are always refused; loopback only with `ALLOW_LOOPBACK_WORKERS=true`. Worker credentials are never stored (Citus uses the coordinator's connection settings). All changes are rate limited and written to `fabric_worker_events`. Developer API tokens can never call these endpoints.
