/**
 * @module controllers/replicationController
 * @description Source→source replication control plane (`/api/replication`):
 * create/list/delete replication jobs, run them, and restore a replica back into
 * a chosen source for disaster recovery. Backed by `ReplicationService`.
 */
import { Request, Response } from 'express';
import { ReplicationService } from '../modules/replication/replication.service';
import { CopyJobEngine } from '../modules/jobs/copy_job_engine';
import { pool } from '../config/database';
import { LicensingService } from '../services/licensing.service';
import { ConnectorFactory } from '../modules/metadata/connectors/factory';
import { countRows } from '../modules/sync/copy_util';

/** Pull the per-job copy config (page size etc.) off a request body, dropping blanks. */
const copyConfig = (b: any) => {
  const c: any = {};
  if (b?.pageSize) c.pageSize = Number(b.pageSize);
  if (b?.memCeilingMb) c.memCeilingMb = Number(b.memCeilingMb);
  if (b?.maxRows) c.maxRows = Number(b.maxRows);
  return c;
};

const tenantOf = (req: Request) => {
  const u = (req as any).user;
  return u?.internal_role === 'ADMIN' && req.body?.tenantId ? req.body.tenantId : u.tenant_id;
};

/**
 * Helper to verify replication source / database limits.
 * Checks max_replication_tables, max_replication_rows, and max_replication_rows_per_table.
 * Returns { allowed: boolean, reason?: string }
 */
const verifyReplicationLimits = async (
  tenant: string,
  dataSourceName: string,
  limits: any
): Promise<{ allowed: boolean; reason?: string }> => {
  const maxTables = limits.max_replication_tables ?? -1;
  const maxRows = limits.max_replication_rows ?? -1;
  const maxRowsPerTable = limits.max_replication_rows_per_table ?? -1;

  if (maxTables === -1 && maxRows === -1 && maxRowsPerTable === -1) {
    return { allowed: true };
  }

  const srcRes = await pool.query(
    `SELECT type, config FROM public.data_sources WHERE tenant_id=$1 AND name=$2`,
    [tenant, dataSourceName]
  );
  if (srcRes.rows.length === 0) {
    return { allowed: true };
  }

  const src = srcRes.rows[0];
  const reader = ConnectorFactory.getConnector(src.type, src.config);
  
  try {
    const schemas = (await reader.discoverSchemas()).filter((s: any) => 
      !['information_schema', 'performance_schema', 'mysql', 'sys', 'admin', 'config', 'local', 'pg_catalog', 'fabric_cdc'].includes(String(s.name).toLowerCase())
    );
    
    let tableCount = 0;
    let totalRows = 0;

    for (const s of schemas) {
      const tables = (await reader.discoverTables(s.name)).filter((t: any) => 
        (t.resourceType || 'TABLE') === 'TABLE' && !/^fabric_cdc/i.test(t.name)
      );
      tableCount += tables.length;
      
      for (const t of tables) {
        const rCount = await countRows(reader, s.name, t.name);
        const finalRCount = rCount || 0;
        totalRows += finalRCount;

        if (maxRowsPerTable !== -1 && finalRCount > maxRowsPerTable) {
          return {
            allowed: false,
            reason: `Replication limit exceeded: Your plan restricts you to a maximum of ${maxRowsPerTable} rows per table. Table ${s.name}.${t.name} has ${finalRCount} rows.`
          };
        }
      }
    }

    if (maxTables !== -1 && tableCount > maxTables) {
      return {
        allowed: false,
        reason: `Replication limit exceeded: Your plan restricts you to a maximum of ${maxTables} tables. Current database has ${tableCount} tables.`
      };
    }

    if (maxRows !== -1 && totalRows > maxRows) {
      return {
        allowed: false,
        reason: `Replication limit exceeded: Your plan restricts you to a maximum of ${maxRows} rows in total. Current database has ${totalRows} rows.`
      };
    }
  } finally {
    await reader.close().catch(() => {});
  }

  return { allowed: true };
};

/** List the tenant's replication jobs. */
export const listJobs = async (req: Request, res: Response) => {
  try { res.json(await ReplicationService.list(tenantOf(req))); }
  catch (e: any) { res.status(500).json({ error: e.message }); }
};

/** Create a replication job (source→destination). */
export const createJob = async (req: Request, res: Response) => {
  try {
    const b = req.body || {};
    if (!b.name || !b.sourceName || !b.destName) return res.status(400).json({ error: 'name, sourceName and destName are required' });
    
    const tenant = tenantOf(req);

    // Check max_replications limit
    const user = (req as any).user;
    if (user && user.internal_role !== 'ADMIN') {
      const licensingCheck = await LicensingService.getTenantSubscription(tenant);
      const maxReplications = licensingCheck.limits.max_replications;
      if (maxReplications !== undefined && maxReplications !== null && maxReplications !== -1) {
        const jobs = await ReplicationService.list(tenant);
        if (jobs.length >= maxReplications) {
          return res.status(403).json({ error: `Replication limit reached: Your plan allows a maximum of ${maxReplications} replication job(s).` });
        }
      }
    }

    const job = await ReplicationService.create({
      tenantId: tenant, name: b.name, sourceName: b.sourceName, destName: b.destName,
      mode: b.mode === 'TWO_WAY' ? 'TWO_WAY' : 'ONE_WAY',
      strategy: ['INCREMENTAL', 'CDC'].includes(b.strategy) ? b.strategy : 'FULL',
      cdcColumn: b.cdcColumn, destSchema: b.destSchema, scheduleMs: b.scheduleMs,
      copyConfig: copyConfig(b),
      initialLoad: b.initialLoad === 'NONE' ? 'NONE' : 'FULL',
    });
    res.status(201).json(job);
  } catch (e: any) { res.status(/required|must be/.test(e.message) ? 400 : 500).json({ error: e.message }); }
};

/**
 * Run a replication job now — enqueues a REPLICATE copy job for the replication
 * microservice/worker and returns immediately with the run id (status QUEUED).
 */
export const runJob = async (req: Request, res: Response) => {
  try {
    const tenant = tenantOf(req);
    const id = req.params.id as string;
    
    // Check replication limits if user is not an admin
    const user = (req as any).user;
    if (user && user.internal_role !== 'ADMIN') {
      const licensingCheck = await LicensingService.getTenantSubscription(tenant);
      const jobRes = await pool.query(`SELECT * FROM fabric_system.replication_jobs WHERE tenant_id=$1 AND id=$2`, [tenant, id]);
      if (jobRes.rows.length > 0) {
        const job = jobRes.rows[0];
        const limitCheck = await verifyReplicationLimits(tenant, job.source_name, licensingCheck.limits);
        if (!limitCheck.allowed) {
          return res.status(400).json({ error: limitCheck.reason });
        }
      }
    }

    // Request body overrides the job's stored copy config. `full:true` forces a full snapshot
    // now (the on-demand "Full sync" action) regardless of the job's INCREMENTAL strategy.
    const config = { ...(await ReplicationService.copyConfigFor(tenant, id)), ...copyConfig(req.body), forceFull: !!req.body?.full };
    const run = await CopyJobEngine.enqueue(tenant, 'REPLICATE', { jobRef: id, config });
    res.status(202).json({ status: 'QUEUED', runId: run.id, run });
  } catch (e: any) { res.status(500).json({ error: e.message }); }
};

/**
 * Disaster-recovery restore — enqueues a RESTORE copy job (replica → chosen
 * source). Returns the run id (status QUEUED); the worker performs the copy.
 */
export const restoreJob = async (req: Request, res: Response) => {
  try {
    const target = req.body?.targetSource;
    if (!target) return res.status(400).json({ error: 'targetSource is required' });
    const tenant = tenantOf(req);
    const id = req.params.id as string;

    // Check replication limits on the replica destination before restore if user is not admin
    const user = (req as any).user;
    if (user && user.internal_role !== 'ADMIN') {
      const licensingCheck = await LicensingService.getTenantSubscription(tenant);
      const jobRes = await pool.query(`SELECT * FROM fabric_system.replication_jobs WHERE tenant_id=$1 AND id=$2`, [tenant, id]);
      if (jobRes.rows.length > 0) {
        const job = jobRes.rows[0];
        const limitCheck = await verifyReplicationLimits(tenant, job.dest_name, licensingCheck.limits);
        if (!limitCheck.allowed) {
          return res.status(400).json({ error: limitCheck.reason });
        }
      }
    }

    const config = { ...(await ReplicationService.copyConfigFor(tenant, id)), ...copyConfig(req.body) };
    const run = await CopyJobEngine.enqueue(tenant, 'RESTORE', { jobRef: id, targetSource: target, config });
    res.status(202).json({ status: 'QUEUED', runId: run.id, run });
  } catch (e: any) { res.status(500).json({ error: e.message }); }
};

/** List recent copy-job runs (all kinds) for the tenant. */
export const listRuns = async (req: Request, res: Response) => {
  try { res.json(await CopyJobEngine.listRuns(tenantOf(req))); }
  catch (e: any) { res.status(500).json({ error: e.message }); }
};

/** Get one copy-job run's status/result. */
export const getRun = async (req: Request, res: Response) => {
  try {
    const run = await CopyJobEngine.getRun(tenantOf(req), req.params.runId as string);
    if (!run) return res.status(404).json({ error: 'run not found' });
    res.json(run);
  } catch (e: any) { res.status(500).json({ error: e.message }); }
};

/** Request a pause of a running copy job (stops after the current batch; resumable). */
export const pauseRun = async (req: Request, res: Response) => {
  try {
    const run = await CopyJobEngine.pause(tenantOf(req), req.params.runId as string);
    if (!run) return res.status(409).json({ error: 'run not pausable (not RUNNING/QUEUED)' });
    res.json({ status: 'PAUSING', run });
  } catch (e: any) { res.status(500).json({ error: e.message }); }
};

/** Resume a paused/failed copy job — continues from its last checkpoint. */
export const resumeRun = async (req: Request, res: Response) => {
  try {
    const run = await CopyJobEngine.resume(tenantOf(req), req.params.runId as string);
    if (!run) return res.status(409).json({ error: 'run not resumable (not PAUSED/FAILED)' });
    res.json({ status: 'QUEUED', run });
  } catch (e: any) { res.status(500).json({ error: e.message }); }
};

/** Aggregated replication/copy analytics for the tenant (dashboard). */
export const analytics = async (req: Request, res: Response) => {
  try { res.json(await CopyJobEngine.analytics(tenantOf(req))); }
  catch (e: any) { res.status(500).json({ error: e.message }); }
};

/** Smart tracking preview: which key/watermark column each table would sync by. */
export const tracking = async (req: Request, res: Response) => {
  try {
    const source = (req.query.source || req.body?.source) as string;
    if (!source) return res.status(400).json({ error: 'source is required' });
    res.json(await ReplicationService.trackingPreview(tenantOf(req), source));
  } catch (e: any) { res.status(500).json({ error: e.message }); }
};

/** Delete a replication job. */
export const deleteJob = async (req: Request, res: Response) => {
  try { await ReplicationService.remove(tenantOf(req), req.params.id as string); res.json({ status: 'DELETED' }); }
  catch (e: any) { res.status(500).json({ error: e.message }); }
};
