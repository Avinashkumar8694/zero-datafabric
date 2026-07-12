/**
 * CopyJobEngine — the durable job queue + worker for heavy copy work (physical
 * SYNC, CDC refresh, source→source REPLICATE, and disaster-recovery RESTORE).
 *
 * The fabric control plane does NOT run these copies inline. It ENQUEUES a job
 * row (`fabric_system.copy_jobs`); a worker — runnable **as a standalone
 * microservice** (the top-level `replication-engine/` project) or embedded
 * in-process — claims queued jobs with `FOR UPDATE SKIP LOCKED` (safe across many
 * workers), executes them, records the result, and retries up to `max_attempts`.
 *
 * Durability / no data loss:
 *   • **Row-level checkpoints** (`fabric_system.copy_checkpoints`) persist each
 *     table's resume cursor + rows-copied after every committed batch. On a
 *     crash/restart the copy resumes mid-table from the last checkpoint (via the
 *     keyset cursor in `copy_util`), re-applying at most one boundary batch
 *     idempotently (upsert) — nothing already committed is lost or duplicated.
 *   • **Heartbeat + crash-reclaim**: a running job stamps `heartbeat_at` each
 *     batch; a job stuck RUNNING with a stale heartbeat (worker died) is
 *     reclaimed to QUEUED and resumes from its checkpoints.
 *   • **Pause / resume**: a `control` flag (RUN/PAUSE) is probed between batches;
 *     PAUSE → the copy stops cleanly (checkpoints kept) and the job goes PAUSED;
 *     resume re-queues it to continue from where it left off.
 *   • **Live progress**: each checkpoint recomputes rows-copied / rows-total /
 *     %-complete / tables-done on the job row for the analytics view.
 *
 * Each job carries its own **config** (`pageSize`, `memCeilingMb`, `maxRows`).
 */
import { pool } from '../../config/database';
import { PhysicalSync } from '../sync/physical_sync.service';
import { ReplicationService } from '../replication/replication.service';
import { heapMb, CheckpointProvider, CopyPaused } from '../sync/copy_util';
import { invalidateTenant } from '../../config/cache';

export type CopyJobKind = 'SYNC' | 'CDC' | 'REPLICATE' | 'RESTORE';

/** A job whose RUNNING heartbeat is older than this (ms) is treated as crashed and reclaimed. */
const STALE_MS = Number(process.env.FABRIC_COPY_STALE_MS) || 60000;

export class CopyJobEngine {
  private static running = false;

  /** Create the queue + checkpoint tables (idempotent), and add newer columns. */
  static async ensureTable(): Promise<void> {
    await pool.query(`CREATE SCHEMA IF NOT EXISTS fabric_system`);
    await pool.query(`CREATE TABLE IF NOT EXISTS fabric_system.copy_jobs (
      id uuid DEFAULT gen_random_uuid() PRIMARY KEY,
      tenant_id text NOT NULL,
      kind text NOT NULL,                 -- SYNC | CDC | REPLICATE | RESTORE
      job_ref text NOT NULL,              -- source name (SYNC/CDC) or replication job id (REPLICATE/RESTORE)
      target_source text,                 -- RESTORE target
      config jsonb DEFAULT '{}'::jsonb,   -- { pageSize, memCeilingMb, maxRows }
      status text DEFAULT 'QUEUED',       -- QUEUED | RUNNING | PAUSED | COMPLETED | FAILED
      control text DEFAULT 'RUN',         -- RUN | PAUSE  (pause request flag)
      attempts int DEFAULT 0, max_attempts int DEFAULT 3,
      claimed_by text, result jsonb, error text,
      rows_copied bigint DEFAULT 0, rows_total bigint DEFAULT 0, progress_pct numeric DEFAULT 0,
      tables_done int DEFAULT 0, tables_total int DEFAULT 0,
      started_at timestamptz, finished_at timestamptz, heartbeat_at timestamptz,
      created_at timestamptz DEFAULT now(), updated_at timestamptz DEFAULT now())`);
    // Additive columns for upgrades of an existing table.
    for (const col of [
      "control text DEFAULT 'RUN'", 'rows_copied bigint DEFAULT 0', 'rows_total bigint DEFAULT 0',
      'progress_pct numeric DEFAULT 0', 'tables_done int DEFAULT 0', 'tables_total int DEFAULT 0',
      'started_at timestamptz', 'finished_at timestamptz', 'heartbeat_at timestamptz',
    ]) {
      await pool.query(`ALTER TABLE fabric_system.copy_jobs ADD COLUMN IF NOT EXISTS ${col}`);
    }
    await pool.query(`CREATE TABLE IF NOT EXISTS fabric_system.copy_checkpoints (
      job_id uuid NOT NULL, schema_name text NOT NULL, table_name text NOT NULL,
      cursor_value text, rows_copied bigint DEFAULT 0, total_rows bigint,
      done boolean DEFAULT false, updated_at timestamptz DEFAULT now(),
      PRIMARY KEY (job_id, schema_name, table_name))`);
  }

  /**
   * Enqueue a copy job for the worker to pick up.
   * @param opts.dedupe when true, skip if an active (QUEUED/RUNNING/PAUSED) job for
   *   the same tenant+kind+job_ref already exists — used by schedulers/pollers.
   * @returns the queued (or existing active) job row — its id is the "run id".
   */
  static async enqueue(tenantId: string, kind: CopyJobKind, opts: { jobRef: string; targetSource?: string; config?: any; dedupe?: boolean }): Promise<any> {
    await this.ensureTable();
    if (opts.dedupe) {
      const { rows } = await pool.query(
        `SELECT * FROM fabric_system.copy_jobs WHERE tenant_id=$1 AND kind=$2 AND job_ref=$3 AND status IN ('QUEUED','RUNNING','PAUSED') ORDER BY created_at DESC LIMIT 1`,
        [tenantId, kind, opts.jobRef]);
      if (rows[0]) return rows[0];
    }
    const { rows } = await pool.query(
      `INSERT INTO fabric_system.copy_jobs (tenant_id, kind, job_ref, target_source, config, status, control)
       VALUES ($1,$2,$3,$4,$5,'QUEUED','RUN') RETURNING *`,
      [tenantId, kind, opts.jobRef, opts.targetSource || null, JSON.stringify(opts.config || {})]);
    return rows[0];
  }

  static async listRuns(tenantId: string, limit = 50): Promise<any[]> {
    await this.ensureTable();
    return (await pool.query(`SELECT * FROM fabric_system.copy_jobs WHERE tenant_id=$1 ORDER BY created_at DESC LIMIT $2`, [tenantId, limit])).rows;
  }
  static async getRun(tenantId: string, id: string): Promise<any> {
    return (await pool.query(`SELECT * FROM fabric_system.copy_jobs WHERE tenant_id=$1 AND id=$2`, [tenantId, id])).rows[0] || null;
  }

  /** Request a pause of a RUNNING/QUEUED job; the worker stops after the current batch. */
  static async pause(tenantId: string, id: string): Promise<any> {
    const { rows } = await pool.query(
      `UPDATE fabric_system.copy_jobs SET control='PAUSE', updated_at=now() WHERE tenant_id=$1 AND id=$2 AND status IN ('RUNNING','QUEUED') RETURNING *`, [tenantId, id]);
    return rows[0] || null;
  }
  /** Resume a PAUSED (or FAILED) job — re-queue it to continue from its checkpoints. */
  static async resume(tenantId: string, id: string): Promise<any> {
    const { rows } = await pool.query(
      `UPDATE fabric_system.copy_jobs SET status='QUEUED', control='RUN', error=NULL, updated_at=now() WHERE tenant_id=$1 AND id=$2 AND status IN ('PAUSED','FAILED') RETURNING *`, [tenantId, id]);
    return rows[0] || null;
  }

  /** Aggregated analytics across a tenant's copy jobs (for the Replication dashboard). */
  static async analytics(tenantId: string): Promise<any> {
    await this.ensureTable();
    const { rows } = await pool.query(`
      SELECT status, COUNT(*)::int AS n, COALESCE(SUM(rows_copied),0)::bigint AS rows FROM fabric_system.copy_jobs
      WHERE tenant_id=$1 GROUP BY status`, [tenantId]);
    const byStatus: any = {}; let totalRows = 0;
    for (const r of rows) { byStatus[r.status] = { jobs: r.n, rows: Number(r.rows) }; totalRows += Number(r.rows); }
    const completed = byStatus.COMPLETED?.jobs || 0;
    const failed = byStatus.FAILED?.jobs || 0;
    const successRate = (completed + failed) ? Math.round((completed / (completed + failed)) * 100) : null;
    // Active jobs with live % + throughput + ETA.
    const active = (await pool.query(`
      SELECT id, kind, job_ref, target_source, status, rows_copied, rows_total, progress_pct, tables_done, tables_total,
        started_at, heartbeat_at,
        CASE WHEN started_at IS NOT NULL AND rows_copied>0
             THEN round(rows_copied / GREATEST(EXTRACT(EPOCH FROM (COALESCE(finished_at, now()) - started_at)),1))::bigint END AS throughput_rps
      FROM fabric_system.copy_jobs WHERE tenant_id=$1 AND status IN ('RUNNING','QUEUED','PAUSED') ORDER BY created_at DESC`, [tenantId])).rows;
    for (const a of active) {
      const rps = Number(a.throughput_rps || 0);
      const remaining = Math.max(0, Number(a.rows_total || 0) - Number(a.rows_copied || 0));
      a.eta_seconds = rps > 0 && a.status === 'RUNNING' ? Math.round(remaining / rps) : null;
    }
    return { byStatus, totalRowsCopied: totalRows, successRate, active };
  }

  /** Build a durable checkpoint provider bound to a job id. */
  private static checkpointProvider(jobId: string): CheckpointProvider {
    return {
      async getStart(schema, table) {
        const { rows } = await pool.query(
          `SELECT cursor_value, rows_copied, done FROM fabric_system.copy_checkpoints WHERE job_id=$1 AND schema_name=$2 AND table_name=$3`,
          [jobId, schema, table]);
        if (!rows[0]) return undefined;
        let cursor: any = rows[0].cursor_value;
        // Cursor is stored as text; coerce back to a number ONLY for short integer PKs.
        // Long digit strings (>15) are left as strings so we never clobber a 24-char
        // all-digit ObjectId or a bigint beyond safe-integer precision.
        if (cursor !== null && cursor !== undefined && /^-?\d{1,15}$/.test(String(cursor))) cursor = Number(cursor);
        return { cursor, rowsCopied: Number(rows[0].rows_copied || 0), done: !!rows[0].done };
      },
      async save(schema, table, cursor, rowsCopied, done, total) {
        await pool.query(`
          INSERT INTO fabric_system.copy_checkpoints (job_id, schema_name, table_name, cursor_value, rows_copied, total_rows, done, updated_at)
          VALUES ($1,$2,$3,$4,$5,$6,$7, now())
          ON CONFLICT (job_id, schema_name, table_name) DO UPDATE SET
            cursor_value=EXCLUDED.cursor_value, rows_copied=EXCLUDED.rows_copied,
            total_rows=COALESCE(EXCLUDED.total_rows, fabric_system.copy_checkpoints.total_rows),
            done=EXCLUDED.done, updated_at=now()`,
          [jobId, schema, table, cursor === null || cursor === undefined ? null : String(cursor), rowsCopied, total ?? null, done]);
        // Roll the per-table checkpoints up onto the job row (live progress + heartbeat).
        await pool.query(`
          UPDATE fabric_system.copy_jobs j SET
            rows_copied = agg.rows, rows_total = agg.total,
            tables_done = agg.done, tables_total = agg.cnt,
            progress_pct = CASE WHEN agg.total>0 THEN round((agg.rows::numeric/agg.total)*100,1)
                                WHEN agg.cnt>0 THEN round((agg.done::numeric/agg.cnt)*100,1) ELSE 0 END,
            heartbeat_at = now(), updated_at = now()
          FROM (SELECT COALESCE(SUM(rows_copied),0)::bigint AS rows, COALESCE(SUM(total_rows),0)::bigint AS total,
                       COUNT(*) FILTER (WHERE done)::int AS done, COUNT(*)::int AS cnt
                FROM fabric_system.copy_checkpoints WHERE job_id=$1) agg
          WHERE j.id=$1`, [jobId]);
      },
      async shouldStop() {
        const { rows } = await pool.query(`SELECT control FROM fabric_system.copy_jobs WHERE id=$1`, [jobId]);
        return rows[0]?.control === 'PAUSE';
      },
    };
  }

  /** Claim the oldest QUEUED job atomically (safe for concurrent workers). */
  private static async claim(workerId: string): Promise<any | null> {
    const { rows } = await pool.query(`
      UPDATE fabric_system.copy_jobs SET status='RUNNING', control='RUN', attempts=attempts+1, claimed_by=$1,
        started_at=COALESCE(started_at, now()), heartbeat_at=now(), updated_at=now()
      WHERE id = (SELECT id FROM fabric_system.copy_jobs WHERE status='QUEUED' ORDER BY created_at FOR UPDATE SKIP LOCKED LIMIT 1)
      RETURNING *`, [workerId]);
    return rows[0] || null;
  }

  /** Requeue jobs stuck RUNNING with a stale heartbeat (their worker died) → they resume from checkpoints. */
  static async reclaimStale(): Promise<number> {
    const { rowCount } = await pool.query(
      `UPDATE fabric_system.copy_jobs SET status='QUEUED', updated_at=now()
       WHERE status='RUNNING' AND heartbeat_at IS NOT NULL AND heartbeat_at < now() - ($1 || ' milliseconds')::interval`,
      [String(STALE_MS)]);
    if (rowCount) console.log(`[CopyJobEngine] reclaimed ${rowCount} stale RUNNING job(s) → QUEUED (will resume from checkpoint)`);
    return rowCount || 0;
  }

  /** Dispatch a claimed job to the right executor by kind, honoring its per-job config + checkpoints. */
  private static async execute(job: any): Promise<any> {
    const cfg = job.config || {};
    const copyOpts = { batchSize: cfg.pageSize, memCeilingMb: cfg.memCeilingMb, maxRows: cfg.maxRows, checkpoint: this.checkpointProvider(job.id) };
    switch (job.kind) {
      case 'SYNC': return PhysicalSync.backfill(job.tenant_id, job.job_ref, copyOpts);
      case 'CDC': return PhysicalSync.refreshCdc(job.tenant_id, job.job_ref);
      case 'REPLICATE': return ReplicationService.run(job.tenant_id, job.job_ref, false, undefined, copyOpts, !!cfg.forceFull);
      case 'RESTORE': return ReplicationService.run(job.tenant_id, job.job_ref, true, job.target_source, copyOpts, !!cfg.forceFull);
      default: throw new Error(`unknown copy-job kind "${job.kind}"`);
    }
  }

  /** Claim + run + record ONE job. Returns the job id processed, or null if the queue was empty. */
  static async processOne(workerId = 'worker'): Promise<string | null> {
    await this.ensureTable();
    const job = await this.claim(workerId);
    if (!job) return null;
    try {
      const result = await this.execute(job);
      const failed = Array.isArray(result?.errors) && result.errors.length > 0;
      await pool.query(`UPDATE fabric_system.copy_jobs SET status=$1, result=$2, error=$3, finished_at=now(), progress_pct=CASE WHEN $1='COMPLETED' THEN 100 ELSE progress_pct END, updated_at=now() WHERE id=$4`,
        [failed ? 'FAILED' : 'COMPLETED', JSON.stringify(result), failed ? (result.errors || []).join('; ') : null, job.id]);
      if (!failed && (job.kind === 'SYNC' || job.kind === 'CDC')) invalidateTenant(job.tenant_id).catch(() => {});
      console.log(`[CopyJobEngine] ${job.kind} ${job.job_ref} → ${failed ? 'FAILED' : 'COMPLETED'} (heap ${heapMb()}MB)`);
    } catch (e: any) {
      if (e instanceof CopyPaused || e?.name === 'CopyPaused') {
        // Clean pause — keep checkpoints, mark PAUSED (resume continues from here).
        await pool.query(`UPDATE fabric_system.copy_jobs SET status='PAUSED', updated_at=now() WHERE id=$1`, [job.id]);
        console.log(`[CopyJobEngine] ${job.kind} ${job.job_ref} → PAUSED (resumable)`);
        return job.id;
      }
      const retry = job.attempts < job.max_attempts;
      await pool.query(`UPDATE fabric_system.copy_jobs SET status=$1, error=$2, finished_at=CASE WHEN $1='FAILED' THEN now() ELSE finished_at END, updated_at=now() WHERE id=$3`,
        [retry ? 'QUEUED' : 'FAILED', e.message, job.id]);
      console.warn(`[CopyJobEngine] ${job.kind} ${job.job_ref} error (attempt ${job.attempts}/${job.max_attempts}): ${e.message}${retry ? ' — will retry' : ''}`);
    }
    return job.id;
  }

  /**
   * Start the polling worker loop. Runs embedded in the API process by default;
   * set `REPLICATION_ENGINE_EXTERNAL=true` to disable the embedded worker when a
   * dedicated microservice runs instead. Also reclaims stale (crashed) jobs on
   * start and each tick. Idempotent.
   */
  static startWorker(pollMs = Number(process.env.FABRIC_COPY_POLL_MS) || 2000, workerId = process.env.WORKER_ID || `pid-${process.pid}`): void {
    if (this.running) return;
    this.running = true;
    this.reclaimStale().catch(() => {});   // recover jobs orphaned by a previous crash
    const tick = async () => {
      try {
        await this.reclaimStale();
        let n = 0; while (await this.processOne(workerId) && n++ < 5) { /* drain up to 5/tick */ }
      } catch { /* best-effort; never crash the loop */ }
    };
    setInterval(tick, pollMs).unref?.();
    console.log(`[CopyJobEngine] worker started (poll ${pollMs}ms, id ${workerId})`);
  }
}
