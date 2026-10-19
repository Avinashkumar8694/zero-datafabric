/**
 * @module modules/workers/worker-node.service
 * @description Worker-node management for distributed execution. The hub
 * Postgres is the Citus *coordinator*; workers are Citus nodes that hold shards
 * and run the parallel sub-queries the coordinator fans out. This service keeps
 * a registry (`public.fabric_worker_nodes`) in step with Citus metadata
 * (`pg_dist_node`) and wraps the Citus management UDFs behind validated,
 * audited, admin-only operations.
 *
 * Security: every value that reaches SQL is a bound parameter or a
 * `format('%I')`-quoted identifier validated against a strict allow-list; hosts
 * are validated (no URLs, no link-local/metadata addresses, loopback only when
 * explicitly allowed). Worker credentials are never stored: Citus uses the
 * coordinator's own connection settings (`citus.node_conninfo`, `pg_hba`).
 */

import { pool } from '../../config/database';
import { LimitsResolver, LimitError } from '../tenancy/limits.resolver';

/** Licence gate shared by add/distribute/rebalance: distributed execution must be licensed. */
async function requireLicensedDistribution() {
  try { await LimitsResolver.assertLicenceFeature('distributed_execution_enabled'); }
  catch (e) { if (e instanceof LimitError) throw new WorkerError(e.status, e.code, e.message); throw e; }
}

export class WorkerError extends Error {
  constructor(public status: number, public code: string, message: string) { super(message); }
}

export type WorkerStatus = 'PENDING' | 'ACTIVE' | 'INACTIVE' | 'DRAINING' | 'DOWN' | 'DRIFT' | 'FAILED';

const NAME_RE = /^[a-z][a-z0-9-]{1,61}[a-z0-9]$/;
const HOST_RE = /^(?=.{1,253}$)([A-Za-z0-9]([A-Za-z0-9-]{0,61}[A-Za-z0-9])?)(\.[A-Za-z0-9]([A-Za-z0-9-]{0,61}[A-Za-z0-9])?)*$/;
const IDENT_RE = /^[A-Za-z_][A-Za-z0-9_]{0,62}$/;
const BLOCKED_HOSTS = new Set(['metadata.google.internal', 'metadata', 'instance-data', '0.0.0.0']);
const MAX_LABELS = 20;

const env = (k: string) => (process.env[k] || '').toLowerCase();

/** Validate a worker host: hostname or IPv4 only. Blocks link-local / metadata (SSRF) and, unless allowed, loopback. */
export function validateHost(raw: unknown): string {
  if (typeof raw !== 'string') throw new WorkerError(400, 'INVALID_WORKER', 'host must be a string');
  const host = raw.trim().toLowerCase();
  if (!host || !HOST_RE.test(host)) throw new WorkerError(400, 'INVALID_WORKER', 'host must be a plain hostname or IPv4 address (no scheme, port, path or spaces)');
  if (BLOCKED_HOSTS.has(host)) throw new WorkerError(400, 'INVALID_WORKER', 'host is not allowed');
  const m = host.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (m) {
    const o = m.slice(1).map(Number) as [number, number, number, number];
    if (o.some(n => n > 255)) throw new WorkerError(400, 'INVALID_WORKER', 'host is not a valid IPv4 address');
    if (o[0] === 169 && o[1] === 254) throw new WorkerError(400, 'INVALID_WORKER', 'link-local addresses are not allowed');
    if (o[0] === 0 || o[0] >= 224) throw new WorkerError(400, 'INVALID_WORKER', 'host is not a routable address');
    if (o[0] === 127 && env('ALLOW_LOOPBACK_WORKERS') !== 'true') throw new WorkerError(400, 'INVALID_WORKER', 'loopback addresses are not allowed (set ALLOW_LOOPBACK_WORKERS=true for development)');
  } else if (host === 'localhost' && env('ALLOW_LOOPBACK_WORKERS') !== 'true') {
    throw new WorkerError(400, 'INVALID_WORKER', 'localhost is not allowed (set ALLOW_LOOPBACK_WORKERS=true for development)');
  }
  return host;
}

export function validatePort(raw: unknown): number {
  const n = typeof raw === 'string' && /^\d+$/.test(raw) ? Number(raw) : raw;
  if (typeof n !== 'number' || !Number.isInteger(n) || n < 1 || n > 65535) throw new WorkerError(400, 'INVALID_WORKER', 'port must be an integer between 1 and 65535');
  return n;
}

export function validateName(raw: unknown): string {
  if (typeof raw !== 'string' || !NAME_RE.test(raw.trim().toLowerCase())) throw new WorkerError(400, 'INVALID_WORKER', 'name must be 3-63 chars: lowercase letters, digits and hyphens, starting with a letter');
  return raw.trim().toLowerCase();
}

export function validateLabels(raw: unknown): Record<string, string> {
  if (raw === undefined || raw === null) return {};
  if (typeof raw !== 'object' || Array.isArray(raw)) throw new WorkerError(400, 'INVALID_WORKER', 'labels must be an object of string values');
  const entries = Object.entries(raw as Record<string, unknown>);
  if (entries.length > MAX_LABELS) throw new WorkerError(400, 'INVALID_WORKER', `at most ${MAX_LABELS} labels`);
  const out: Record<string, string> = {};
  for (const [k, v] of entries) {
    if (!/^[A-Za-z0-9_.-]{1,63}$/.test(k) || typeof v !== 'string' || v.length > 255) throw new WorkerError(400, 'INVALID_WORKER', 'label keys must match [A-Za-z0-9_.-]{1,63} and values be strings up to 255 chars');
    out[k] = v;
  }
  return out;
}

/** Strip connection-string user names from Citus error text. */
const clean = (m: string) => String(m).replace(/[\w.-]+@(?=[\w.-]+:\d+)/g, '');

const COORD_HOST = () => process.env.COORDINATOR_HOST || '';
const COORD_PORT = () => Number(process.env.COORDINATOR_PORT || 5432);

export interface CitusInfo { available: boolean; version: string | null; isCoordinator: boolean }

export class WorkerNodeService {
  /** Is the Citus extension installed in this database, and is this node the coordinator? */
  static async citusInfo(): Promise<CitusInfo> {
    try {
      const { rows } = await pool.query("SELECT extversion FROM pg_extension WHERE extname = 'citus'");
      if (!rows.length) return { available: false, version: null, isCoordinator: false };
      let isCoordinator = true;
      try {
        const r = await pool.query('SELECT citus_is_coordinator() AS c, (SELECT count(*) FROM pg_dist_node) AS n');
        isCoordinator = !!r.rows[0].c || Number(r.rows[0].n) === 0;
      } catch { /* older Citus: treat as coordinator */ }
      return { available: true, version: rows[0].extversion, isCoordinator };
    } catch {
      return { available: false, version: null, isCoordinator: false };
    }
  }

  private static async requireCitus(): Promise<CitusInfo> {
    const info = await this.citusInfo();
    if (!info.available) throw new WorkerError(409, 'CITUS_UNAVAILABLE', 'The Citus extension is not installed on the hub database, so worker nodes cannot be managed. Run the hub on a citusdata/citus image.');
    if (!info.isCoordinator) throw new WorkerError(409, 'CITUS_UNAVAILABLE', 'This database is a Citus worker, not the coordinator. Point the fabric at the coordinator.');
    return info;
  }

  private static async audit(workerId: string | null, action: string, actor: string, detail: object = {}) {
    try {
      await pool.query('INSERT INTO public.fabric_worker_events (worker_id, action, actor, detail) VALUES ($1,$2,$3,$4)', [workerId, action, actor, JSON.stringify(detail)]);
    } catch (e: any) { console.error('[Workers] audit failed:', e.message); }
  }

  /** Live Citus view: placements per node + pg_dist_node flags, keyed by host:port. */
  private static async liveNodes(): Promise<Map<string, any>> {
    const map = new Map<string, any>();
    try {
      const { rows } = await pool.query(`
        SELECT n.nodeid, n.nodename, n.nodeport, n.isactive, n.shouldhaveshards,
               COALESCE((SELECT count(*) FROM pg_dist_shard_placement p WHERE p.nodename = n.nodename AND p.nodeport = n.nodeport), 0)::int AS shards
        FROM pg_dist_node n WHERE n.noderole = 'primary' AND n.groupid <> 0`);
      for (const r of rows) map.set(`${r.nodename}:${r.nodeport}`, r);
    } catch { /* no citus */ }
    return map;
  }

  private static shape(row: any, live?: any) {
    let status: WorkerStatus = row.status;
    const registered = !!live;
    if (['ACTIVE', 'INACTIVE', 'DRAINING', 'DOWN', 'DRIFT'].includes(status)) {
      if (!registered) status = 'DRIFT';
      else if (!live.isactive || row.last_health_status === 'DOWN') status = 'DOWN';
      else if (!live.shouldhaveshards) status = live.shards > 0 ? 'DRAINING' : 'INACTIVE';
      else status = 'ACTIVE';
    }
    return {
      id: row.id, name: row.name, host: row.host, port: row.port, status,
      shouldHaveShards: live ? !!live.shouldhaveshards : row.should_have_shards,
      labels: row.labels || {}, citusNodeId: live?.nodeid ?? row.citus_node_id ?? null,
      shardCount: live?.shards ?? 0,
      lastHealth: row.last_health_at ? { status: row.last_health_status, latencyMs: row.last_health_latency_ms, checkedAt: row.last_health_at } : null,
      lastError: row.last_error || null,
      createdAt: row.created_at, updatedAt: row.updated_at,
    };
  }

  static async list() {
    const [citus, live, { rows }] = await Promise.all([this.citusInfo(), this.liveNodes(), pool.query('SELECT * FROM public.fabric_worker_nodes ORDER BY created_at')]);
    const workers = rows.map(r => this.shape(r, live.get(`${r.host}:${r.port}`)));
    const summary = {
      total: workers.length,
      active: workers.filter(w => w.status === 'ACTIVE').length,
      draining: workers.filter(w => w.status === 'DRAINING').length,
      down: workers.filter(w => w.status === 'DOWN' || w.status === 'DRIFT').length,
      shards: workers.reduce((s, w) => s + w.shardCount, 0),
    };
    const warnings: string[] = [];
    if (citus.available && workers.length && !(await this.logicalReplicationReady())) warnings.push('wal_level is not "logical" on every node: shard moves will use block_writes (writes to a shard pause while it moves). Set wal_level=logical on the coordinator and workers for online rebalancing.');
    return { citus, summary, warnings, workers };
  }

  private static async getRow(id: string) {
    if (!/^[0-9a-f-]{36}$/i.test(id)) throw new WorkerError(404, 'WORKER_NOT_FOUND', 'worker not found');
    const { rows } = await pool.query('SELECT * FROM public.fabric_worker_nodes WHERE id = $1', [id]);
    if (!rows.length) throw new WorkerError(404, 'WORKER_NOT_FOUND', 'worker not found');
    return rows[0];
  }

  static async get(id: string) {
    const row = await this.getRow(id);
    const live = await this.liveNodes();
    return this.shape(row, live.get(`${row.host}:${row.port}`));
  }

  static async add(input: any, actor: string) {
    const name = validateName(input?.name);
    const host = validateHost(input?.host);
    const port = validatePort(input?.port ?? 5432);
    const labels = validateLabels(input?.labels);
    const shouldHaveShards = input?.shouldHaveShards === undefined ? true : input.shouldHaveShards === true;
    if (input?.shouldHaveShards !== undefined && typeof input.shouldHaveShards !== 'boolean') throw new WorkerError(400, 'INVALID_WORKER', 'shouldHaveShards must be boolean');
    if (COORD_HOST() && host === COORD_HOST().toLowerCase() && port === COORD_PORT()) throw new WorkerError(400, 'INVALID_WORKER', 'the coordinator cannot be registered as a worker');
    await this.requireCitus();
    await requireLicensedDistribution();
    {
      const n = (await pool.query('SELECT count(*)::int AS n FROM public.fabric_worker_nodes')).rows[0].n;
      try { await LimitsResolver.assertLicenceWithin('max_workers', n, 'Worker node'); }
      catch (e) { if (e instanceof LimitError) throw new WorkerError(e.status, e.code, e.message); throw e; }
    }

    let id: string;
    try {
      const ins = await pool.query(
        `INSERT INTO public.fabric_worker_nodes (name, host, port, labels, should_have_shards, created_by, status)
         VALUES ($1,$2,$3,$4,$5,$6,'PENDING') RETURNING id`, [name, host, port, JSON.stringify(labels), shouldHaveShards, actor]);
      id = ins.rows[0].id;
    } catch (e: any) {
      if (e.code === '23505') throw new WorkerError(409, 'DUPLICATE_WORKER', 'a worker with this name or host:port is already registered');
      throw e;
    }
    try {
      const client = await pool.connect();
      try {
        await client.query("SET statement_timeout = '60s'");
        const known = await client.query('SELECT count(*)::int AS n FROM pg_dist_node');
        if (known.rows[0].n === 0 && COORD_HOST()) await client.query('SELECT citus_set_coordinator_host($1, $2)', [COORD_HOST(), COORD_PORT()]);
        const r = await client.query('SELECT citus_add_node($1, $2) AS node_id', [host, port]);
        if (!shouldHaveShards) await client.query("SELECT citus_set_node_property($1, $2, 'shouldhaveshards', false)", [host, port]);
        await client.query('RESET statement_timeout');
        await pool.query(`UPDATE public.fabric_worker_nodes SET citus_node_id=$2, status=$3, last_error=NULL, updated_at=NOW() WHERE id=$1`, [id, r.rows[0].node_id, shouldHaveShards ? 'ACTIVE' : 'INACTIVE']);
      } finally { client.release(); }
    } catch (e: any) {
      await pool.query('DELETE FROM public.fabric_worker_nodes WHERE id = $1', [id]); // compensate: no half-registered rows
      await this.audit(null, 'ADD_FAILED', actor, { name, host, port, error: e.message });
      throw new WorkerError(502, 'WORKER_UNREACHABLE', `Citus could not add ${host}:${port}: ${clean(e.message)}`);
    }
    await this.audit(id, 'ADD', actor, { name, host, port, shouldHaveShards });
    return this.get(id);
  }

  static async update(id: string, patch: any, actor: string) {
    const row = await this.getRow(id);
    const sets: string[] = []; const vals: any[] = [id];
    if (patch.name !== undefined) { vals.push(validateName(patch.name)); sets.push(`name=$${vals.length}`); }
    if (patch.labels !== undefined) { vals.push(JSON.stringify(validateLabels(patch.labels))); sets.push(`labels=$${vals.length}`); }
    if (patch.shouldHaveShards !== undefined) {
      if (typeof patch.shouldHaveShards !== 'boolean') throw new WorkerError(400, 'INVALID_WORKER', 'shouldHaveShards must be boolean');
      await this.setShards(row, patch.shouldHaveShards);
    }
    if (sets.length) {
      try { await pool.query(`UPDATE public.fabric_worker_nodes SET ${sets.join(', ')}, updated_at=NOW() WHERE id=$1`, vals); }
      catch (e: any) { if (e.code === '23505') throw new WorkerError(409, 'DUPLICATE_WORKER', 'name already in use'); throw e; }
    }
    if (!sets.length && patch.shouldHaveShards === undefined) throw new WorkerError(400, 'INVALID_WORKER', 'nothing to update');
    await this.audit(id, 'UPDATE', actor, patch);
    return this.get(id);
  }

  private static async setShards(row: any, value: boolean) {
    await this.requireCitus();
    const live = (await this.liveNodes()).get(`${row.host}:${row.port}`);
    if (!live) throw new WorkerError(409, 'WORKER_DRIFT', 'worker is not in Citus metadata; run sync first');
    await pool.query("SELECT citus_set_node_property($1, $2, 'shouldhaveshards', $3)", [row.host, row.port, value]);
    await pool.query('UPDATE public.fabric_worker_nodes SET should_have_shards=$2, status=$3, updated_at=NOW() WHERE id=$1', [row.id, value, value ? 'ACTIVE' : (live.shards > 0 ? 'DRAINING' : 'INACTIVE')]);
  }

  static async activate(id: string, actor: string) {
    const row = await this.getRow(id);
    await this.setShards(row, true);
    await this.audit(id, 'ACTIVATE', actor);
    return this.get(id);
  }

  /** Stop placing shards on the node and move its existing shards away (background rebalance, drain-only). Idempotent. */
  static async drain(id: string, actor: string) {
    const row = await this.getRow(id);
    await this.setShards(row, false);
    const live = (await this.liveNodes()).get(`${row.host}:${row.port}`);
    let job: any = null;
    let rebalanceError: string | null = null;
    if (live && live.shards > 0) { try { job = await this.startRebalance({ drainOnly: true }, actor); } catch (e: any) { rebalanceError = e.message; } }
    await this.audit(id, 'DRAIN', actor, { shards: live?.shards ?? 0, job, rebalanceError });
    return { worker: await this.get(id), rebalance: job, rebalanceError };
  }

  static async remove(id: string, actor: string) {
    const row = await this.getRow(id);
    const info = await this.citusInfo();
    const live = info.available ? (await this.liveNodes()).get(`${row.host}:${row.port}`) : undefined;
    if (live && live.shards > 0) throw new WorkerError(409, 'WORKER_HAS_SHARDS', `worker still holds ${live.shards} shard placements; drain it and wait for the rebalance to finish first`);
    if (live) {
      const others = [...(await this.liveNodes()).values()].filter(n => !(n.nodename === row.host && n.nodeport === row.port));
      const { rows: t } = await pool.query('SELECT count(*)::int AS n FROM citus_tables WHERE citus_table_type = \'distributed\'').catch(() => ({ rows: [{ n: 0 }] }));
      if (!others.length && t[0].n > 0) throw new WorkerError(409, 'LAST_WORKER', 'cannot remove the last worker while distributed tables exist');
      await this.requireCitus();
      await pool.query('SELECT citus_remove_node($1, $2)', [row.host, row.port]);
    }
    await pool.query('DELETE FROM public.fabric_worker_nodes WHERE id = $1', [id]);
    await this.audit(id, 'REMOVE', actor, { name: row.name, host: row.host, port: row.port });
  }

  /** Probe all workers through the coordinator (no direct connections from the API process). */
  static async health(id?: string) {
    await this.requireCitus();
    const t0 = Date.now();
    let results: any[] = [];
    try {
      const c = await pool.connect();
      try {
        await c.query("SET statement_timeout = '4s'");
        results = (await c.query("SELECT nodename, nodeport, success FROM run_command_on_workers('SELECT 1')")).rows;
        await c.query('RESET statement_timeout');
      } finally { c.release(); }
    } catch { /* all treated as down below */ }
    const latency = Date.now() - t0;
    const { rows } = await pool.query('SELECT id, host, port FROM public.fabric_worker_nodes' + (id ? ' WHERE id = $1' : ''), id ? [id] : []);
    const out: any[] = [];
    for (const w of rows) {
      const r = results.find(x => x.nodename === w.host && Number(x.nodeport) === w.port);
      const status = r && r.success ? 'UP' : 'DOWN';
      await pool.query('UPDATE public.fabric_worker_nodes SET last_health_status=$2, last_health_latency_ms=$3, last_health_at=NOW(), updated_at=NOW() WHERE id=$1', [w.id, status, latency]);
      out.push({ id: w.id, status, latencyMs: latency, checkedAt: new Date().toISOString(), ...(status === 'DOWN' ? { error: r ? 'worker query failed' : 'worker not reachable from coordinator' } : {}) });
    }
    if (id && !out.length) throw new WorkerError(404, 'WORKER_NOT_FOUND', 'worker not found');
    return id ? out[0] : out;
  }

  /** Reconcile registry <-> pg_dist_node. Unknown Citus workers are imported; missing ones flagged DRIFT. */
  static async sync(actor: string) {
    await this.requireCitus();
    const live = await this.liveNodes();
    const { rows } = await pool.query('SELECT * FROM public.fabric_worker_nodes');
    let imported = 0, drift = 0;
    for (const n of live.values()) {
      if (!rows.find(r => r.host === n.nodename && r.port === n.nodeport)) {
        const name = `worker-${n.nodeid}`;
        await pool.query(`INSERT INTO public.fabric_worker_nodes (name, host, port, status, should_have_shards, citus_node_id, created_by)
                          VALUES ($1,$2,$3,$4,$5,$6,$7) ON CONFLICT DO NOTHING`, [name, n.nodename, n.nodeport, n.shouldhaveshards ? 'ACTIVE' : 'INACTIVE', n.shouldhaveshards, n.nodeid, `sync:${actor}`]);
        imported++;
      }
    }
    for (const r of rows) {
      const l = live.get(`${r.host}:${r.port}`);
      if (!l && r.status !== 'PENDING') { await pool.query("UPDATE public.fabric_worker_nodes SET status='DRIFT', updated_at=NOW() WHERE id=$1", [r.id]); drift++; }
      else if (l) await pool.query('UPDATE public.fabric_worker_nodes SET citus_node_id=$2, should_have_shards=$3, updated_at=NOW() WHERE id=$1', [r.id, l.nodeid, l.shouldhaveshards]);
    }
    await this.audit(null, 'SYNC', actor, { imported, drift });
    return { imported, drift };
  }

  /** Start a background, cluster-wide Citus rebalance (optionally drain-only: only move shards off nodes that no longer accept them). */
  static async startRebalance(opts: { drainOnly?: boolean } = {}, actor = 'system') {
    await this.requireCitus();
    if (opts.drainOnly !== undefined && typeof opts.drainOnly !== 'boolean') throw new WorkerError(400, 'INVALID_REBALANCE', 'drainOnly must be boolean');
    const running = await this.rebalanceStatus();
    if (running.some((j: any) => ['scheduled', 'running'].includes(String(j.state)))) throw new WorkerError(409, 'REBALANCE_RUNNING', 'a rebalance is already running');
    const nodes = await this.liveNodes();
    if (![...nodes.values()].some(n => n.shouldhaveshards && n.isactive) && !opts.drainOnly) throw new WorkerError(409, 'NO_WORKERS', 'no active worker nodes to rebalance across');
    const mode = (await this.logicalReplicationReady()) ? 'auto' : 'block_writes';
    try {
      const r = await pool.query(
        'SELECT citus_rebalance_start(drain_only => $1, shard_transfer_mode => $2::citus.shard_transfer_mode) AS job_id', [!!opts.drainOnly, mode]);
      const jobId = r.rows[0].job_id;
      await this.audit(null, 'REBALANCE', actor, { drainOnly: !!opts.drainOnly, jobId, transferMode: mode });
      return { jobId: String(jobId), status: 'scheduled', transferMode: mode };
    } catch (e: any) {
      throw new WorkerError(409, 'REBALANCE_FAILED', clean(e.message));
    }
  }

  /** True when coordinator and every worker run wal_level=logical (online shard moves). Otherwise moves use block_writes. */
  static async logicalReplicationReady(): Promise<boolean> {
    try {
      const c = await pool.query('SHOW wal_level');
      if (c.rows[0].wal_level !== 'logical') return false;
      const w = await pool.query("SELECT result FROM run_command_on_workers('SHOW wal_level')");
      return w.rows.every(r => r.result === 'logical');
    } catch { return false; }
  }

  static async rebalanceStatus() {
    const info = await this.citusInfo();
    if (!info.available) return [];
    try {
      const { rows } = await pool.query('SELECT job_id::text, state::text, job_type::text, description, started_at, finished_at, details FROM citus_rebalance_status()');
      return rows.map(r => ({ jobId: r.job_id, state: r.state, type: r.job_type, description: r.description, startedAt: r.started_at, finishedAt: r.finished_at, details: r.details }));
    } catch { return []; }
  }

  static async tables() {
    const info = await this.citusInfo();
    if (!info.available) return [];
    const { rows } = await pool.query(`
      SELECT n.nspname AS schema, c.relname AS "table", t.citus_table_type AS type, t.distribution_column, t.colocation_id, t.shard_count, pg_size_bytes(t.table_size) AS size_bytes
      FROM citus_tables t JOIN pg_class c ON c.oid = t.table_name JOIN pg_namespace n ON n.oid = c.relnamespace
      ORDER BY n.nspname, c.relname`);
    return rows.map(r => ({ schema: r.schema, table: r.table, type: r.type, distributionColumn: r.distribution_column, colocationId: r.colocation_id, shardCount: Number(r.shard_count), sizeBytes: Number(r.size_bytes) }));
  }

  /** Distribute a tenant table across workers. Platform (`public`) and system schemas are refused. */
  static async distribute(input: any, actor: string) {
    const { schema, table, column } = input || {};
    for (const [k, v] of Object.entries({ schema, table, column })) {
      if (typeof v !== 'string' || !IDENT_RE.test(v)) throw new WorkerError(400, 'INVALID_TABLE', `${k} must be a valid identifier`);
    }
    if (!/^tenant_/.test(schema)) throw new WorkerError(400, 'INVALID_TABLE', 'only tenant schemas (tenant_*) can be distributed; platform and system schemas are protected');
    await this.requireCitus();
    await requireLicensedDistribution();
    const r = await pool.query("SELECT to_regclass(format('%I.%I', $1::text, $2::text))::text AS rel, (SELECT relkind::text FROM pg_class WHERE oid = to_regclass(format('%I.%I', $1::text, $2::text))) AS kind", [schema, table]);
    if (!r.rows[0].rel) throw new WorkerError(404, 'TABLE_NOT_FOUND', 'table not found');
    if (r.rows[0].kind !== 'r' && r.rows[0].kind !== 'p') throw new WorkerError(400, 'INVALID_TABLE', 'only ordinary or partitioned tables can be distributed (not foreign tables or views)');
    const col = await pool.query('SELECT 1 FROM information_schema.columns WHERE table_schema=$1 AND table_name=$2 AND column_name=$3', [schema, table, column]);
    if (!col.rows.length) throw new WorkerError(400, 'INVALID_TABLE', 'distribution column does not exist on the table');
    const dup = await pool.query('SELECT 1 FROM citus_tables WHERE table_name = $1::regclass', [r.rows[0].rel]);
    if (dup.rows.length) throw new WorkerError(409, 'ALREADY_DISTRIBUTED', 'table is already distributed');
    const nodes = await this.liveNodes();
    if (![...nodes.values()].some(n => n.shouldhaveshards && n.isactive)) throw new WorkerError(409, 'NO_WORKERS', 'add at least one active worker before distributing tables');
    try {
      await pool.query('SELECT create_distributed_table($1::regclass, $2)', [r.rows[0].rel, column]);
    } catch (e: any) { throw new WorkerError(400, 'DISTRIBUTE_FAILED', e.message); }
    await this.audit(null, 'DISTRIBUTE', actor, { schema, table, column });
    return { schema, table, column, status: 'DISTRIBUTED' };
  }

  static async events(limit = 50) {
    const { rows } = await pool.query('SELECT id, worker_id AS "workerId", action, actor, detail, created_at AS "createdAt" FROM public.fabric_worker_events ORDER BY id DESC LIMIT $1', [Math.min(Math.max(limit, 1), 200)]);
    return rows;
  }
}
