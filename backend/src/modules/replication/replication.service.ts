/**
 * ReplicationService — source→source data replication (separate from the fabric's
 * own inbound SYNC/CDC, which copies a source into the hub for query processing).
 *
 * A **replication job** copies data from one registered data source (any engine)
 * into another registered data source (the destination — currently PostgreSQL,
 * "replicate anything as Postgres"). It is ONE-WAY today (TWO_WAY is modelled but
 * deferred). Strategies mirror the fabric's:
 *   • FULL        — copy every row (DROP+CREATE the destination table, reload).
 *   • INCREMENTAL — copy only rows past a watermark column, upsert by PK.
 *
 * Disaster recovery: `restore(job, targetSource)` runs the job in REVERSE — it
 * reads the destination (the replica) and writes it back into a chosen source,
 * so a replica can rehydrate a failed/wiped primary.
 *
 * Jobs live in `fabric_system.replication_jobs`; a scheduler runs those with a
 * `schedule_ms`. Reads use the source connector; writes use the destination
 * connector (Postgres `rawQuery` for DDL/DML).
 */
import { pool } from '../../config/database';
import { ConnectorFactory } from '../metadata/connectors/factory';
import { canonicalType } from '../metadata/ddl_render';
import { pagedRead, withLock, heapMb, CopyOpts, CopyPaused, countRows, resolveOpts } from '../sync/copy_util';
import { analyzeTracking } from '../sync/tracking';
import { CdcCapture } from '../sync/cdc_capture';
import { CdcKafka } from '../sync/cdc_kafka';
import { DestOps, DestKind, destKindOf } from './dest_ops';

const SYSTEM_SCHEMAS = new Set(['information_schema', 'performance_schema', 'mysql', 'sys', 'admin', 'config', 'local', 'pg_catalog', 'fabric_cdc']);
const CAP = Number(process.env.FABRIC_REPL_MAX_ROWS) || 200000;
const q = (id: string) => '"' + String(id).replace(/"/g, '') + '"';

export interface ReplicationJob {
  id?: string; tenantId: string; name: string;
  sourceName: string; destName: string;
  mode: 'ONE_WAY' | 'TWO_WAY';
  strategy: 'FULL' | 'INCREMENTAL' | 'CDC';
  cdcColumn?: string | null;
  destSchema?: string;
  scheduleMs?: number | null;
  /** Per-job copy tuning stored with the job and applied on every run (page size etc.). */
  copyConfig?: { pageSize?: number; memCeilingMb?: number; maxRows?: number };
  /**
   * For an INCREMENTAL job, what the FIRST run does:
   *   • 'FULL' (default) — snapshot all existing rows, then track deltas.
   *   • 'NONE'           — copy nothing; baseline the watermark to "now" and capture only
   *                        NEW/changed rows from this point on. (Full load stays available
   *                        on demand via the "Full sync" action.)
   */
  initialLoad?: 'FULL' | 'NONE';
}

export class ReplicationService {
  private static async ensureTable(): Promise<void> {
    await pool.query(`CREATE SCHEMA IF NOT EXISTS fabric_system`);
    await pool.query(`CREATE TABLE IF NOT EXISTS fabric_system.replication_jobs (
      id uuid DEFAULT gen_random_uuid() PRIMARY KEY,
      tenant_id text NOT NULL, name text NOT NULL,
      source_name text NOT NULL, dest_name text NOT NULL,
      mode text DEFAULT 'ONE_WAY', strategy text DEFAULT 'FULL',
      cdc_column text, dest_schema text DEFAULT 'public',
      schedule_ms bigint, last_run_at timestamptz, last_status text, last_detail jsonb,
      copy_config jsonb DEFAULT '{}'::jsonb,
      initial_load text DEFAULT 'FULL',
      created_at timestamptz DEFAULT now())`);
    await pool.query(`ALTER TABLE fabric_system.replication_jobs ADD COLUMN IF NOT EXISTS copy_config jsonb DEFAULT '{}'::jsonb`);
    await pool.query(`ALTER TABLE fabric_system.replication_jobs ADD COLUMN IF NOT EXISTS initial_load text DEFAULT 'FULL'`);
    await pool.query(`CREATE TABLE IF NOT EXISTS fabric_system.replication_watermark (
      job_id uuid, table_name text, watermark_value text, PRIMARY KEY (job_id, table_name))`);
  }

  /** Create a replication job. */
  static async create(job: ReplicationJob): Promise<any> {
    await this.ensureTable();
    const { rows } = await pool.query(
      `INSERT INTO fabric_system.replication_jobs (tenant_id, name, source_name, dest_name, mode, strategy, cdc_column, dest_schema, schedule_ms, copy_config, initial_load)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING *`,
      [job.tenantId, job.name, job.sourceName, job.destName, job.mode || 'ONE_WAY', job.strategy || 'FULL', job.cdcColumn || null, job.destSchema || null, job.scheduleMs || null, JSON.stringify(job.copyConfig || {}), job.initialLoad === 'NONE' ? 'NONE' : 'FULL']);
    return rows[0];
  }

  /**
   * Smart tracking analysis for a source: for each table, report the chosen key + watermark
   * columns and what an incremental sync would capture. Powers the "how will it track?"
   * preview and auto-configuration.
   */
  static async trackingPreview(tenantId: string, sourceName: string): Promise<any[]> {
    const src = await this.getSource(tenantId, sourceName);
    const conn: any = ConnectorFactory.getConnector(src.type, src.config);
    const out: any[] = [];
    try {
      const schemas = (await conn.discoverSchemas()).filter((s: any) => !SYSTEM_SCHEMAS.has(String(s.name).toLowerCase()));
      for (const s of schemas) {
        const tables = (await conn.discoverTables(s.name)).filter((t: any) => (t.resourceType || 'TABLE') === 'TABLE' && !/^fabric_cdc/i.test(t.name));
        for (const t of tables) {
          const cols = conn.discoverColumns ? await conn.discoverColumns(s.name, t.name) : [];
          const plan = analyzeTracking(cols);
          out.push({ schema: s.name, table: t.name, ...plan });
        }
      }
    } finally { await conn.close().catch(() => {}); }
    return out;
  }

  /** The per-job copy config (page size etc.) stored on the job, or `{}`. */
  static async copyConfigFor(tenantId: string, id: string): Promise<any> {
    const { rows } = await pool.query(`SELECT copy_config FROM fabric_system.replication_jobs WHERE tenant_id=$1 AND id=$2`, [tenantId, id]);
    return rows[0]?.copy_config || {};
  }

  /** List a tenant's replication jobs. */
  static async list(tenantId: string): Promise<any[]> {
    await this.ensureTable();
    return (await pool.query(`SELECT * FROM fabric_system.replication_jobs WHERE tenant_id=$1 ORDER BY created_at DESC`, [tenantId])).rows;
  }

  /** Delete a replication job. */
  static async remove(tenantId: string, id: string): Promise<void> {
    await pool.query(`DELETE FROM fabric_system.replication_jobs WHERE tenant_id=$1 AND id=$2`, [tenantId, id]);
  }

  private static async getJob(tenantId: string, id: string): Promise<any> {
    const { rows } = await pool.query(`SELECT * FROM fabric_system.replication_jobs WHERE tenant_id=$1 AND id=$2`, [tenantId, id]);
    if (!rows.length) throw new Error('replication job not found');
    return rows[0];
  }
  private static async getSource(tenantId: string, name: string): Promise<any> {
    const { rows } = await pool.query(`SELECT name, type, config FROM public.data_sources WHERE tenant_id=$1 AND name=$2`, [tenantId, name]);
    if (!rows.length) throw new Error(`data source "${name}" not found`);
    return rows[0];
  }

  /**
   * Run a replication job: copy every TABLE from the source into the destination.
   * @param tenantId tenant id.
   * @param id job id.
   * @param reverse when true, swap source/destination (used by `restore`).
   * @param overrideDest optional destination-source override (DR restore target).
   */
  static async run(tenantId: string, id: string, reverse = false, overrideDest?: string, opts?: CopyOpts, forceFull = false): Promise<any> {
    // Serialize runs of the same job/direction so a scheduler + manual trigger don't stack.
    const r = await withLock(`repl:${tenantId}:${id}:${reverse ? 'restore' : 'run'}`, () => this._run(tenantId, id, reverse, overrideDest, opts, forceFull));
    return r || { status: 'SKIPPED', error: 'a run for this job is already in progress' };
  }

  private static async _run(tenantId: string, id: string, reverse = false, overrideDest?: string, opts?: CopyOpts, forceFull = false): Promise<any> {
    await this.ensureTable();
    const job = await this.getJob(tenantId, id);
    const fromName = reverse ? job.dest_name : job.source_name;
    const toName = reverse ? (overrideDest || job.source_name) : job.dest_name;
    const from = await this.getSource(tenantId, fromName);
    const to = await this.getSource(tenantId, toName);
    const destEngine = String(to.type).toUpperCase();
    const fromEngine = String(from.type).toUpperCase();
    const destKind = destKindOf(destEngine);
    // Supported destinations: ES (query accelerator) + PG/MySQL/Mongo/Oracle (same-engine DR replica).
    if (!destKind) throw new Error(`destination "${toName}" (${to.type}) is not a supported replication target yet — use PostgreSQL, MySQL, MongoDB, Oracle (same-engine DR) or Elasticsearch (query accelerator).`);

    const reader: any = ConnectorFactory.getConnector(from.type, from.config);
    const writer: any = ConnectorFactory.getConnector(to.type, to.config);
    const destSchema = job.dest_schema || 'public';
    const strategy = String(job.strategy || 'FULL').toUpperCase();
    const result: any = { job: job.name, direction: reverse ? 'RESTORE' : 'REPLICATE', from: fromName, to: toName, destSchema, strategy, dest: destKind, tables: [], errors: [] };
    try {
      // Handshake the destination first so an unreachable target fails cleanly — engine-specific.
      if (destKind === 'ES') { try { await writer.ping(); } catch (e: any) { throw new Error(`destination "${toName}" handshake failed: ${e.message}`); } }
      else if (destKind === 'MONGO') { try { await writer.discoverSchemas(); } catch (e: any) { throw new Error(`destination "${toName}" handshake failed: ${e.message}`); } }
      else { const probe = destKind === 'ORACLE' ? 'SELECT 1 FROM dual' : 'SELECT 1';
             try { await writer.rawQuery(probe); } catch (e: any) { throw new Error(`destination "${toName}" handshake failed: ${e.message}`); }
             if (destKind === 'PG') await writer.rawQuery(`CREATE SCHEMA IF NOT EXISTS ${q(destSchema)}`); }
      const schemas = (await reader.discoverSchemas()).filter((s: any) => !SYSTEM_SCHEMAS.has(String(s.name).toLowerCase()));
      const multiSchema = schemas.length > 1;
      for (const s of schemas) {
        // Preserve the source's schema/db structure in the destination (full, faithful replica):
        //  • multi-schema source (e.g. Postgres) → MIRROR each source schema by name;
        //  • single-schema source (MySQL/Mongo one DB) → use the optional dest_schema override, else mirror.
        // dest_schema is thus an OPTIONAL single-schema override, not a flatten-everything target.
        const targetSchema = (multiSchema || !job.dest_schema) ? s.name : job.dest_schema;
        if (destKind === 'PG') await writer.rawQuery(`CREATE SCHEMA IF NOT EXISTS ${q(targetSchema)}`);
        const tables = (await reader.discoverTables(s.name)).filter((t: any) => (t.resourceType || 'TABLE') === 'TABLE' && !/^fabric_cdc/i.test(t.name));
        for (const t of tables) {
          try {
            let n: number;
            if (strategy === 'CDC' && !forceFull) {
              // Unified CDC: capture per source engine → apply full CRUD (incl. deletes) to ANY dest.
              n = await this.cdcRun(reader, fromEngine, destKind as DestKind, writer, s.name, t.name, targetSchema, job, opts);
            } else if (destKind === 'ES') n = await this.copyTableEs(reader, writer, s.name, t.name, targetSchema, strategy, job, opts, forceFull, fromEngine);
            else if (destKind === 'MONGO') n = await this.copyTableMongo(reader, writer, s.name, t.name, targetSchema, strategy, job, opts, forceFull);
            else if (destKind === 'MYSQL') n = await this.copyTableMySql(reader, writer, s.name, t.name, targetSchema, strategy, job, opts, forceFull);
            else if (destKind === 'ORACLE') n = await this.copyTableGeneric('ORACLE', reader, writer, s.name, t.name, targetSchema, strategy, job, opts, forceFull);
            else n = await this.copyTable(reader, writer, s.name, t.name, targetSchema, strategy, job, opts, forceFull);
            const label = destKind === 'ES' ? this.esIndex(targetSchema, t.name) : `${targetSchema}.${t.name}`;
            result.tables.push({ table: label, rows: n, mode: strategy.toLowerCase() });
          } catch (e: any) {
            if (e instanceof CopyPaused) throw e;   // bubble up so the job goes PAUSED (not a table error)
            result.errors.push(`${s.name}.${t.name}: ${e.message}`);
          }
        }
      }
    } finally { await reader.close().catch(() => {}); await writer.close().catch(() => {}); }

    const status = result.errors.length ? 'PARTIAL' : 'SUCCESS';
    result.heapMb = heapMb();
    await pool.query(`UPDATE fabric_system.replication_jobs SET last_run_at=now(), last_status=$1, last_detail=$2 WHERE id=$3`,
      [status, JSON.stringify(result), id]);
    result.status = status;
    console.log(`[Replication] ${result.direction} "${job.name}" ${result.from}→${result.to}: ${result.tables.reduce((n: number, t: any) => n + t.rows, 0)} rows, ${result.errors.length} error(s), heap ${result.heapMb}MB`);
    return result;
  }

  /** ES index name for a replicated table (ES requires lowercase, restricted charset). */
  private static esIndex(destSchema: string, table: string): string {
    return `${destSchema}_${table}`.toLowerCase().replace(/[^a-z0-9_]/g, '_').replace(/^_+/, '');
  }

  /**
   * Copy one table into an Elasticsearch destination — bulk-index each row as a document
   * whose `_id` is the source primary key (so re-indexing UPSERTS, never duplicates),
   * keyset-paged + checkpoint-resumable like the Postgres path.
   *   • FULL        — drop the index first (clean reload), then keyset-reindex all rows.
   *   • INCREMENTAL — index only rows past the watermark (auto-detected if unconfigured),
   *                   upserting by `_id`; advances the watermark.
   * This is what powers both "replicate a DB into ES" and "sync a DB into ES so the fabric
   * can serve fast search/aggregations from the ES copy".
   */
  private static async copyTableEs(reader: any, writer: any, schema: string, table: string, destSchema: string, strategy: string, job: any, opts?: CopyOpts, forceFull = false, fromEngine = ''): Promise<number> {
    const cols: any[] = reader.discoverColumns ? await reader.discoverColumns(schema, table) : [];
    if (!cols.length) throw new Error('no columns discovered');
    const plan = analyzeTracking(cols, { watermarkCol: job.cdc_column });
    const keyCol = plan.keyCol;
    const colNames = cols.map((c) => c.name);
    const index = this.esIndex(destSchema, table);
    const toDocs = (rows: any[]) => rows.map((r) => (keyCol != null ? { _id: String(r[keyCol]), ...r } : { ...r }));

    // INCREMENTAL DELTA: once a watermark exists, index only rows past it, upsert by _id.
    const incremental = strategy === 'INCREMENTAL' && !!plan.watermarkCol;
    const wmCol = plan.watermarkCol;
    if (incremental && !forceFull) {
      const wm = await this.getWatermark(job.id, index);
      if (wm != null) {
        const rows: any[] = await reader.query(schema, table, { filter: { [wmCol!]: { $gt: wm } }, orderBy: [{ field: wmCol!, dir: 'ASC' }], limit: CAP });
        if (rows.length) {
          await writer.insertDocs(destSchema, index, toDocs(rows));
          await this.setWatermark(job.id, index, rows.reduce((m, r) => (r[wmCol!] > m ? r[wmCol!] : m), rows[0][wmCol!]));
        }
        return rows.length;
      }
      // First run with initialLoad='NONE' → baseline the watermark to "now" and copy NOTHING;
      // only new/changed rows flow in from the next run.
      if (String(job.initial_load).toUpperCase() === 'NONE') {
        await this.recordMaxWatermark(reader, schema, table, wmCol!, job.id, index);
        return 0;
      }
      // else initialLoad='FULL' → fall through to the keyset-paged snapshot, then set watermark.
    }

    // FULL: keyset-paged reindex, resumable. Also the initial snapshot for INCREMENTAL's first run.
    const cp = opts?.checkpoint;
    let start = cp ? await cp.getStart(destSchema, table) : undefined;
    if (start?.done) return start.rowsCopied;
    const canResume = !!start && !!keyCol;
    if (!canResume) { await writer.dropIndex(index); start = undefined; }   // clean reload
    if (cp) { const total = await countRows(reader, schema, table); await cp.save(destSchema, table, start?.cursor ?? null, start?.rowsCopied || 0, false, total ?? undefined); }
    const ctx = cp ? {
      startCursor: start?.cursor, priorRows: start?.rowsCopied || 0,
      onProgress: (cursor: any, rows: number) => cp.save(destSchema, table, cursor, rows, false),
      shouldStop: () => cp.shouldStop(),
    } : undefined;
    const res = await pagedRead(reader, schema, table, keyCol, (rows) => writer.insertDocs(destSchema, index, toDocs(rows)).then(() => {}), opts, ctx);
    if (cp) await cp.save(destSchema, table, res.cursor, res.rows, true);
    if (incremental) await this.recordMaxWatermark(reader, schema, table, wmCol!, job.id, index);  // watermark keyed by ES index
    return res.rows;
  }

  /**
   * Unified CDC → ANY destination. Captures changes natively per **source** engine
   * (PostgreSQL/MySQL/Oracle = trigger+outbox; MongoDB = change streams) and applies full
   * row-level CRUD (INSERT/UPDATE → upsert, DELETE → delete) to ANY **destination** engine
   * via `DestOps` (PG/MySQL/Oracle/Mongo/ES). First run snapshots + baselines the log
   * position; later runs drain and apply, persisting position after each batch (crash-safe,
   * idempotent). For an ES destination with `FABRIC_CDC_VIA_KAFKA=true` (SQL source), deltas
   * are published to Kafka and applied by the long-lived consumer instead.
   */
  private static async cdcRun(reader: any, fromEngine: string, destKind: DestKind, writer: any, srcSchema: string, table: string, targetSchema: string, job: any, opts?: CopyOpts): Promise<number> {
    const cols: any[] = reader.discoverColumns ? await reader.discoverColumns(srcSchema, table) : [];
    if (!cols.length) throw new Error('no columns discovered');
    const pkCols = cols.filter((c) => c.primaryKey).map((c) => c.name);
    const keyCol = pkCols[0];
    if (!keyCol) throw new Error(`CDC requires a primary key on ${srcSchema}.${table}`);
    const colNames = cols.map((c) => c.name);
    const isEs = destKind === 'ES';
    const opsSchema = targetSchema;
    const opsTable = isEs ? this.esIndex(targetSchema, table) : table;         // ES: index name
    const posKey = `cdcpos:${destKind}:${opsTable}`;
    const { batchSize } = resolveOpts(opts);
    const srcMongo = ['MONGODB', 'MONGO'].includes(String(fromEngine).toUpperCase());
    if (!srcMongo) await CdcCapture.ensure(fromEngine, reader, srcSchema, table, keyCol, colNames);   // install trigger+outbox

    const posRaw = await this.getWatermark(job.id, posKey);
    if (posRaw == null) {
      // SNAPSHOT: mark the current log position, reindex/reload current rows, baseline the position.
      const pos = srcMongo ? await reader.currentChangeToken(srcSchema, table) : await CdcCapture.maxSeq(fromEngine, reader, srcSchema, table);
      await DestOps.ensure(destKind, writer, opsSchema, opsTable, cols, pkCols, true);
      const res = await pagedRead(reader, srcSchema, table, keyCol, (rows) => DestOps.upsert(destKind, writer, opsSchema, opsTable, colNames, keyCol, rows), opts);
      await this.setWatermark(job.id, posKey, srcMongo ? JSON.stringify(pos ?? null) : String(pos));
      if (isEs && process.env.FABRIC_CDC_VIA_KAFKA === 'true' && !srcMongo) await CdcKafka.baseline(job.tenant_id, job.source_name, srcSchema, table, Number(pos) || 0);
      console.log(`[Replication] CDC snapshot ${srcSchema}.${table} → ${destKind}:${opsTable}: ${res.rows} rows`);
      return res.rows;
    }

    // ES + Kafka (SQL source): publish deltas to Kafka; the consumer applies. Otherwise apply directly.
    if (isEs && process.env.FABRIC_CDC_VIA_KAFKA === 'true' && !srcMongo) {
      return await CdcKafka.produce(fromEngine, reader, job.tenant_id, job.source_name, srcSchema, table);
    }

    let applied = 0;
    if (srcMongo) {
      let token = JSON.parse(posRaw);
      for (;;) {
        const { changes, token: next } = await reader.drainChanges(srcSchema, table, token, batchSize);
        if (!changes.length) { if (next) await this.setWatermark(job.id, posKey, JSON.stringify(next)); break; }
        for (const c of changes) {
          if (c.op === 'D') await DestOps.del(destKind, writer, opsSchema, opsTable, keyCol, c.pk);
          else await DestOps.upsert(destKind, writer, opsSchema, opsTable, colNames, keyCol, [c.doc]);
        }
        token = next; applied += changes.length; await this.setWatermark(job.id, posKey, JSON.stringify(token));
        if (changes.length < batchSize) break;
      }
    } else {
      let seq = Number(posRaw || 0);
      for (;;) {
        const changes = await CdcCapture.read(fromEngine, reader, srcSchema, table, seq, batchSize);
        if (!changes.length) break;
        for (const c of changes) {
          if (c.op === 'D') await DestOps.del(destKind, writer, opsSchema, opsTable, keyCol, c.pk);
          else await DestOps.upsert(destKind, writer, opsSchema, opsTable, colNames, keyCol, [c.doc]);
          seq = c.seq;
        }
        applied += changes.length; await this.setWatermark(job.id, posKey, String(seq));
        if (changes.length < batchSize) break;
      }
      if (applied) await CdcCapture.prune(fromEngine, reader, srcSchema, table, seq);
    }
    if (applied) console.log(`[Replication] CDC ${srcSchema}.${table} → ${destKind}:${opsTable}: applied ${applied} change(s) incl. deletes`);
    return applied;
  }

  /**
   * Generic FULL/INCREMENTAL copy to any `DestOps`-supported engine (used for Oracle dest;
   * PG/MySQL/Mongo/ES keep their specialized paths). Keyset-paged, resumable, idempotent upsert.
   */
  private static async copyTableGeneric(kind: DestKind, reader: any, writer: any, schema: string, table: string, destSchema: string, strategy: string, job: any, opts?: CopyOpts, forceFull = false): Promise<number> {
    const cols: any[] = reader.discoverColumns ? await reader.discoverColumns(schema, table) : [];
    if (!cols.length) throw new Error('no columns discovered');
    const pkCols = cols.filter((c) => c.primaryKey).map((c) => c.name);
    const colNames = cols.map((c) => c.name);
    const keyCol = pkCols[0];
    const wmKey = `${kind}:${destSchema}.${table}`;
    const wmCol = job.cdc_column || analyzeTracking(cols).watermarkCol;

    if (strategy === 'INCREMENTAL' && wmCol && cols.some((c) => c.name === wmCol) && !forceFull) {
      await DestOps.ensure(kind, writer, destSchema, table, cols, pkCols, false);
      const wm = await this.getWatermark(job.id, wmKey);
      if (wm != null) {
        const rows: any[] = await reader.query(schema, table, { filter: { [wmCol]: { $gt: wm } }, orderBy: [{ field: wmCol, dir: 'ASC' }], limit: CAP });
        if (rows.length) { await DestOps.upsert(kind, writer, destSchema, table, colNames, keyCol || wmCol, rows); await this.setWatermark(job.id, wmKey, rows.reduce((m, r) => (r[wmCol] > m ? r[wmCol] : m), rows[0][wmCol])); }
        return rows.length;
      }
      if (String(job.initial_load).toUpperCase() === 'NONE') { await this.recordMaxWatermark(reader, schema, table, wmCol, job.id, wmKey); return 0; }
    }

    const cp = opts?.checkpoint;
    let start = cp ? await cp.getStart(destSchema, table) : undefined;
    if (start?.done) return start.rowsCopied;
    const canResume = !!start && !!keyCol;
    await DestOps.ensure(kind, writer, destSchema, table, cols, pkCols, !canResume);
    if (!canResume) start = undefined;
    if (cp) { const total = await countRows(reader, schema, table); await cp.save(destSchema, table, start?.cursor ?? null, start?.rowsCopied || 0, false, total ?? undefined); }
    const ctx = cp ? { startCursor: start?.cursor, priorRows: start?.rowsCopied || 0, onProgress: (c: any, r: number) => cp.save(destSchema, table, c, r, false), shouldStop: () => cp.shouldStop() } : undefined;
    const res = await pagedRead(reader, schema, table, keyCol, (rows) => DestOps.upsert(kind, writer, destSchema, table, colNames, keyCol || colNames[0], rows), opts, ctx);
    if (cp) await cp.save(destSchema, table, res.cursor, res.rows, true);
    if (strategy === 'INCREMENTAL' && wmCol) await this.recordMaxWatermark(reader, schema, table, wmCol, job.id, wmKey);
    return res.rows;
  }

  /**
   * Copy one table into a **MongoDB destination** (same-engine DR replica, or any source →
   * Mongo). Schemaless: no DDL — each row becomes a document whose `_id` is the source PK
   * (upsert by `_id` → idempotent, no dupes on resume/incremental).
   */
  private static async copyTableMongo(reader: any, writer: any, schema: string, table: string, destDb: string, strategy: string, job: any, opts?: CopyOpts, forceFull = false): Promise<number> {
    const cols: any[] = reader.discoverColumns ? await reader.discoverColumns(schema, table) : [];
    const pkCols = cols.filter((c) => c.primaryKey).map((c) => c.name);
    const keyCol = pkCols[0] || (cols[0]?.name);
    const wmKey = `${destDb}.${table}`;
    const toDoc = (r: any) => (keyCol != null ? { _id: r[keyCol], ...r } : { ...r });
    const wmCol = job.cdc_column || analyzeTracking(cols).watermarkCol;

    if (strategy === 'INCREMENTAL' && wmCol && cols.some((c) => c.name === wmCol) && !forceFull) {
      const wm = await this.getWatermark(job.id, wmKey);
      if (wm != null) {
        const rows: any[] = await reader.query(schema, table, { filter: { [wmCol]: { $gt: wm } }, orderBy: [{ field: wmCol, dir: 'ASC' }], limit: CAP });
        if (rows.length) { await writer.upsertDocs(destDb, table, rows.map(toDoc)); await this.setWatermark(job.id, wmKey, rows.reduce((m, r) => (r[wmCol] > m ? r[wmCol] : m), rows[0][wmCol])); }
        return rows.length;
      }
      if (String(job.initial_load).toUpperCase() === 'NONE') { await this.recordMaxWatermark(reader, schema, table, wmCol, job.id, wmKey); return 0; }
    }

    // FULL (also INCREMENTAL first-run snapshot): keyset-paged upsert, resumable.
    const cp = opts?.checkpoint;
    let start = cp ? await cp.getStart(destDb, table) : undefined;
    if (start?.done) return start.rowsCopied;
    const canResume = !!start && !!pkCols[0];
    if (!canResume) { await writer.clearCollection(destDb, table); start = undefined; }   // clean slate
    if (cp) { const total = await countRows(reader, schema, table); await cp.save(destDb, table, start?.cursor ?? null, start?.rowsCopied || 0, false, total ?? undefined); }
    const ctx = cp ? { startCursor: start?.cursor, priorRows: start?.rowsCopied || 0, onProgress: (c: any, r: number) => cp.save(destDb, table, c, r, false), shouldStop: () => cp.shouldStop() } : undefined;
    const res = await pagedRead(reader, schema, table, pkCols[0], (rows) => writer.upsertDocs(destDb, table, rows.map(toDoc)).then(() => {}), opts, ctx);
    if (cp) await cp.save(destDb, table, res.cursor, res.rows, true);
    if (strategy === 'INCREMENTAL' && wmCol) await this.recordMaxWatermark(reader, schema, table, wmCol, job.id, wmKey);
    return res.rows;
  }

  /** Map a fabric-canonical type to a MySQL column type (PK text cols become VARCHAR so they're indexable). */
  private static mysqlType(canonical: string, isPk: boolean): string {
    const t = String(canonical).toUpperCase();
    if (/BIGINT/.test(t)) return 'BIGINT';
    if (/SMALLINT/.test(t)) return 'SMALLINT';
    if (/INT/.test(t)) return 'INT';
    if (/NUMERIC|DECIMAL|DOUBLE|REAL|FLOAT/.test(t)) return 'DOUBLE';
    if (/BOOL/.test(t)) return 'TINYINT(1)';
    if (/TIMESTAMP|DATETIME/.test(t)) return 'DATETIME';
    if (/DATE/.test(t)) return 'DATE';
    if (/JSON/.test(t)) return 'JSON';
    if (/BYTEA|BLOB|BINARY/.test(t)) return 'BLOB';
    if (/UUID/.test(t)) return 'CHAR(36)';
    return isPk ? 'VARCHAR(255)' : 'TEXT';    // TEXT can't be a PK in MySQL without a prefix length
  }

  /** Copy one table into a **MySQL destination** (same-engine DR replica, or any source → MySQL). */
  private static async copyTableMySql(reader: any, writer: any, schema: string, table: string, destDb: string, strategy: string, job: any, opts?: CopyOpts, forceFull = false): Promise<number> {
    const cols: any[] = reader.discoverColumns ? await reader.discoverColumns(schema, table) : [];
    if (!cols.length) throw new Error('no columns discovered');
    const pkCols = cols.filter((c) => c.primaryKey).map((c) => c.name);
    const colNames = cols.map((c) => c.name);
    const bq = (id: string) => '`' + String(id).replace(/`/g, '') + '`';
    const db = bq(destDb.replace(/[^a-zA-Z0-9_]/g, '_'));
    const colDefs = cols.map((c) => `${bq(c.name)} ${this.mysqlType(canonicalType(c.type), pkCols.includes(c.name))}`);
    const pkClause = pkCols.length ? `, PRIMARY KEY (${pkCols.map(bq).join(', ')})` : '';
    const keyCol = pkCols[0];
    const wmKey = `${destDb}.${table}`;
    const wmCol = job.cdc_column || analyzeTracking(cols).watermarkCol;
    await writer.rawQuery(`CREATE DATABASE IF NOT EXISTS ${db}`);
    const upsertBatch = async (rows: any[]) => {
      if (!rows.length) return;
      const upd = colNames.filter((c) => !pkCols.includes(c)).map((c) => `${bq(c)}=VALUES(${bq(c)})`).join(', ');
      for (let i = 0; i < rows.length; i += 500) {
        const slice = rows.slice(i, i + 500); const params: any[] = [];
        const tuples = slice.map((row) => `(${colNames.map((c) => { let v = row[c]; if (v !== null && typeof v === 'object') v = JSON.stringify(v); params.push(v === undefined ? null : v); return '?'; }).join(', ')})`);
        await writer.rawQuery(`INSERT INTO ${db}.${bq(table)} (${colNames.map(bq).join(', ')}) VALUES ${tuples.join(', ')}${upd ? ` ON DUPLICATE KEY UPDATE ${upd}` : ''}`, params);
      }
    };

    if (strategy === 'INCREMENTAL' && wmCol && cols.some((c) => c.name === wmCol) && !forceFull) {
      await writer.rawQuery(`CREATE TABLE IF NOT EXISTS ${db}.${bq(table)} (${colDefs.join(', ')}${pkClause})`);
      const wm = await this.getWatermark(job.id, wmKey);
      if (wm != null) {
        const rows: any[] = await reader.query(schema, table, { filter: { [wmCol]: { $gt: wm } }, orderBy: [{ field: wmCol, dir: 'ASC' }], limit: CAP });
        await upsertBatch(rows);
        if (rows.length) await this.setWatermark(job.id, wmKey, rows.reduce((m, r) => (r[wmCol] > m ? r[wmCol] : m), rows[0][wmCol]));
        return rows.length;
      }
      if (String(job.initial_load).toUpperCase() === 'NONE') { await this.recordMaxWatermark(reader, schema, table, wmCol, job.id, wmKey); return 0; }
    }

    // FULL (also INCREMENTAL first-run): keyset-paged, resumable.
    const cp = opts?.checkpoint;
    let start = cp ? await cp.getStart(destDb, table) : undefined;
    if (start?.done) return start.rowsCopied;
    const canResume = !!start && !!keyCol;
    if (!canResume) { await writer.rawQuery(`DROP TABLE IF EXISTS ${db}.${bq(table)}`); await writer.rawQuery(`CREATE TABLE ${db}.${bq(table)} (${colDefs.join(', ')}${pkClause})`); start = undefined; }
    else await writer.rawQuery(`CREATE TABLE IF NOT EXISTS ${db}.${bq(table)} (${colDefs.join(', ')}${pkClause})`);
    if (cp) { const total = await countRows(reader, schema, table); await cp.save(destDb, table, start?.cursor ?? null, start?.rowsCopied || 0, false, total ?? undefined); }
    const ctx = cp ? { startCursor: start?.cursor, priorRows: start?.rowsCopied || 0, onProgress: (c: any, r: number) => cp.save(destDb, table, c, r, false), shouldStop: () => cp.shouldStop() } : undefined;
    const res = await pagedRead(reader, schema, table, keyCol, upsertBatch, opts, ctx);   // upsert = idempotent on resume
    if (cp) await cp.save(destDb, table, res.cursor, res.rows, true);
    if (strategy === 'INCREMENTAL' && wmCol) await this.recordMaxWatermark(reader, schema, table, wmCol, job.id, wmKey);
    return res.rows;
  }

  /** Copy one table reader→writer (FULL: drop+reload; INCREMENTAL: watermark upsert). */
  private static async copyTable(reader: any, writer: any, schema: string, table: string, destSchema: string, strategy: string, job: any, opts?: CopyOpts, forceFull = false): Promise<number> {
    const cols: any[] = reader.discoverColumns ? await reader.discoverColumns(schema, table) : [];
    if (!cols.length) throw new Error('no columns discovered');
    const pkCols = cols.filter((c) => c.primaryKey).map((c) => c.name);
    const colDefs = cols.map((c) => `${q(c.name)} ${canonicalType(c.type)}`);
    const colNames = cols.map((c) => c.name);
    // Watermark column: use the configured one, else let the analyzer pick smartly.
    const wmCol = job.cdc_column || analyzeTracking(cols).watermarkCol;

    const incremental = strategy === 'INCREMENTAL' && !!wmCol && cols.some((c) => c.name === wmCol);
    if (incremental && !forceFull) {
      const wm = await this.getWatermark(job.id, table);
      if (wm != null) {
        // DELTA run: upsert only rows past the watermark (bounded — deltas are small).
        const pkClause = pkCols.length ? `, PRIMARY KEY (${pkCols.map(q).join(', ')})` : '';
        await writer.rawQuery(`CREATE TABLE IF NOT EXISTS ${q(destSchema)}.${q(table)} (${colDefs.join(', ')}${pkClause})`);
        const rows: any[] = await reader.query(schema, table, { filter: { [wmCol!]: { $gt: wm } }, orderBy: [{ field: wmCol!, dir: 'ASC' }], limit: CAP });
        const pk = pkCols[0] || wmCol!;
        for (const row of rows) await this.upsert(writer, destSchema, table, colNames, pk, row);
        if (rows.length) await this.setWatermark(job.id, table, rows.reduce((m, r) => (r[wmCol!] > m ? r[wmCol!] : m), rows[0][wmCol!]));
        return rows.length;
      }
      // First run with initialLoad='NONE' → baseline the watermark to "now", copy NOTHING;
      // only new/changed rows flow in from the next run.
      if (String(job.initial_load).toUpperCase() === 'NONE') {
        const pkClause = pkCols.length ? `, PRIMARY KEY (${pkCols.map(q).join(', ')})` : '';
        await writer.rawQuery(`CREATE TABLE IF NOT EXISTS ${q(destSchema)}.${q(table)} (${colDefs.join(', ')}${pkClause})`);
        await this.recordMaxWatermark(reader, schema, table, wmCol!, job.id);
        return 0;
      }
      // else initialLoad='FULL' → fall through to the keyset-paged FULL snapshot (bounded,
      // resumable — safe for very large tables), then record the high-water mark.
    }

    // FULL: bounded-memory paged bulk load, resumable via checkpoint. Also the initial
    // snapshot for an INCREMENTAL job's first run.
    const cp = opts?.checkpoint;
    let start = cp ? await cp.getStart(destSchema, table) : undefined;
    if (start?.done) return start.rowsCopied;          // finished in a prior run → skip
    const keyCol = pkCols[0];                          // keyset (concurrent-safe + resumable) only with a PK
    const pkClause = pkCols.length ? `, PRIMARY KEY (${pkCols.map(q).join(', ')})` : '';
    // Row-level resume + dedupe REQUIRE a primary key. Without one we can neither
    // position deterministically nor upsert, so a keyless table always restarts from
    // scratch (table-level resume: DROP+reload) — never a mid-way plain-insert that
    // would DUPLICATE rows already in the replica.
    let canResume = !!start && !!keyCol;
    // Resume is FORWARD from the last committed key via upsert — we do NOT re-scan or
    // count the replica (a busy production source churns rows, so any count heuristic
    // would false-trigger a costly full reload on every resume). The only stale-checkpoint
    // case we guard is the table being entirely GONE (dropped during the crash window);
    // then resume-from-cursor would silently lose pre-cursor rows, so we rebuild it.
    // Ongoing external updates/deletes are reconciled by INCREMENTAL/CDC or a fresh FULL
    // run (a new run id ⇒ clean rebuild), not by re-loading on resume.
    if (canResume) {
      let tableExists = true;
      try { await writer.rawQuery(`SELECT 1 FROM ${q(destSchema)}.${q(table)} LIMIT 1`); }
      catch { tableExists = false; }
      if (!tableExists) {
        console.warn(`[Replication] resume: replica ${destSchema}.${table} is missing — rebuilding from scratch`);
        canResume = false;
      }
    }
    if (!canResume) {
      await writer.rawQuery(`DROP TABLE IF EXISTS ${q(destSchema)}.${q(table)}`);
      await writer.rawQuery(`CREATE TABLE ${q(destSchema)}.${q(table)} (${colDefs.join(', ')}${pkClause})`);
      start = undefined;                               // ignore stale/keyless checkpoint
    } else {
      await writer.rawQuery(`CREATE TABLE IF NOT EXISTS ${q(destSchema)}.${q(table)} (${colDefs.join(', ')}${pkClause})`);
    }
    const pk = keyCol || colNames[0];
    if (cp) { const total = await countRows(reader, schema, table); await cp.save(destSchema, table, start?.cursor ?? null, start?.rowsCopied || 0, false, total ?? undefined); }
    const ctx = cp ? {
      startCursor: start?.cursor,
      priorRows: start?.rowsCopied || 0,
      onProgress: (cursor: any, rows: number) => cp.save(destSchema, table, cursor, rows, false),
      shouldStop: () => cp.shouldStop(),
    } : undefined;
    // Resuming a keyed table upserts (PK conflict → update) so a re-applied boundary batch
    // is idempotent; a fresh copy plain-inserts into the freshly created empty table.
    const sink = (rows: any[]) => canResume
      ? this.bulkUpsert(writer, destSchema, table, colNames, pk, rows)
      : this.bulkInsert(writer, destSchema, table, colNames, rows);
    const res = await pagedRead(reader, schema, table, keyCol, sink, opts, ctx);
    if (cp) await cp.save(destSchema, table, res.cursor, res.rows, true);   // mark table complete
    // If this was an INCREMENTAL job's first run (initial snapshot), record the high-water
    // mark so every subsequent scheduled run copies ONLY new/changed rows.
    if (incremental) await this.recordMaxWatermark(reader, schema, table, wmCol!, job.id);
    return res.rows;
  }

  /** Upsert a batch of rows by PK (used on resumed FULL copies for idempotency). */
  private static async bulkUpsert(writer: any, destSchema: string, table: string, colNames: string[], pk: string, rows: any[]): Promise<void> {
    for (const row of rows) await this.upsert(writer, destSchema, table, colNames, pk, row);
  }

  private static async bulkInsert(writer: any, destSchema: string, table: string, colNames: string[], rows: any[]): Promise<void> {
    if (!rows.length) return;
    const colList = colNames.map(q).join(', ');
    const BATCH = 500;
    for (let i = 0; i < rows.length; i += BATCH) {
      const slice = rows.slice(i, i + BATCH);
      const params: any[] = [];
      const tuples = slice.map((row) => `(${colNames.map((c) => { let v = row[c]; if (v !== null && typeof v === 'object') v = JSON.stringify(v); params.push(v === undefined ? null : v); return `$${params.length}`; }).join(', ')})`);
      await writer.rawQuery(`INSERT INTO ${q(destSchema)}.${q(table)} (${colList}) VALUES ${tuples.join(', ')}`, params);
    }
  }
  private static async upsert(writer: any, destSchema: string, table: string, colNames: string[], pk: string, row: any): Promise<void> {
    const colList = colNames.map(q).join(', ');
    const params: any[] = [];
    const ph = colNames.map((c) => { let v = row[c]; if (v !== null && typeof v === 'object') v = JSON.stringify(v); params.push(v === undefined ? null : v); return `$${params.length}`; });
    const upd = colNames.filter((c) => c !== pk).map((c) => `${q(c)}=EXCLUDED.${q(c)}`).join(', ');
    const conflict = upd ? `ON CONFLICT (${q(pk)}) DO UPDATE SET ${upd}` : `ON CONFLICT (${q(pk)}) DO NOTHING`;
    await writer.rawQuery(`INSERT INTO ${q(destSchema)}.${q(table)} (${colList}) VALUES (${ph.join(', ')}) ${conflict}`, params);
  }

  /** Read the source's current MAX(watermark) and record it, so the next incremental run is a pure delta. */
  private static async recordMaxWatermark(reader: any, schema: string, table: string, wmCol: string, jobId: string, wmKey?: string): Promise<void> {
    try {
      const maxRow: any[] = await reader.query(schema, table, { select: [wmCol], orderBy: [{ field: wmCol, dir: 'DESC' }], limit: 1 });
      const v = maxRow?.[0]?.[wmCol];
      if (v != null) await this.setWatermark(jobId, wmKey || table, v);
    } catch { /* best-effort; a missing watermark just means the next run re-snapshots */ }
  }

  private static async getWatermark(jobId: string, table: string): Promise<any> {
    const r = await pool.query(`SELECT watermark_value FROM fabric_system.replication_watermark WHERE job_id=$1 AND table_name=$2`, [jobId, table]);
    return r.rows[0]?.watermark_value ?? null;
  }
  private static async setWatermark(jobId: string, table: string, value: any): Promise<void> {
    await pool.query(`INSERT INTO fabric_system.replication_watermark (job_id, table_name, watermark_value) VALUES ($1,$2,$3)
      ON CONFLICT (job_id, table_name) DO UPDATE SET watermark_value=EXCLUDED.watermark_value`, [jobId, table, value == null ? null : String(value)]);
  }

  /** Disaster recovery: replay the replica back into a chosen source (reverse copy). */
  static async restore(tenantId: string, id: string, targetSource: string): Promise<any> {
    return this.run(tenantId, id, true, targetSource);
  }

  /** Scheduler: run replication jobs whose `schedule_ms` is due. Idempotent start. */
  private static started = false;
  static startScheduler(tickMs = Number(process.env.FABRIC_REPL_TICK_MS) || 30000): void {
    if (this.started) return;
    this.started = true;
    setInterval(async () => {
      try {
        await this.ensureTable();
        const { rows } = await pool.query(`SELECT id, tenant_id, last_run_at, schedule_ms FROM fabric_system.replication_jobs WHERE schedule_ms IS NOT NULL`);
        // Assign due replication runs to the replication microservice (deduped).
        const { CopyJobEngine } = require('../jobs/copy_job_engine');
        for (const j of rows) {
          const due = !j.last_run_at || (Date.now() - new Date(j.last_run_at).getTime()) >= Number(j.schedule_ms);
          if (due) await CopyJobEngine.enqueue(j.tenant_id, 'REPLICATE', { jobRef: j.id, dedupe: true }).catch(() => {});
        }
      } catch { /* best-effort */ }
    }, tickMs).unref?.();
    console.log(`[Replication] scheduler started (tick ${tickMs}ms)`);
  }

  private static cdcConsumersStarted = false;
  /**
   * Start the long-lived Kafka CDC consumers (one per CDC→ES job): each drains its source's
   * change topic and applies I/U→upsert, D→delete to the ES index, committing the Kafka
   * offset only after apply (at-least-once + idempotent = no loss on restart). No-op unless
   * FABRIC_CDC_VIA_KAFKA=true. Idempotent.
   */
  static async startCdcConsumers(): Promise<void> {
    if (this.cdcConsumersStarted || process.env.FABRIC_CDC_VIA_KAFKA !== 'true') return;
    this.cdcConsumersStarted = true;
    try {
      await this.ensureTable();
      const { rows } = await pool.query(
        `SELECT j.id, j.tenant_id, j.source_name, j.dest_name, j.dest_schema, ds.type AS dest_type, ds.config AS dest_config
         FROM fabric_system.replication_jobs j JOIN public.data_sources ds ON ds.tenant_id=j.tenant_id AND ds.name=j.dest_name
         WHERE j.strategy='CDC' AND UPPER(ds.type) IN ('ELASTICSEARCH','ELASTIC','ES')`);
      for (const j of rows) {
        const writer: any = ConnectorFactory.getConnector(j.dest_type, j.dest_config);
        const destSchema = j.dest_schema || 'public';
        await CdcKafka.startEsConsumer(j.tenant_id, j.source_name, `fabric-cdc-es-${j.id}`, async (ev) => {
          const index = this.esIndex(destSchema, ev.table);
          if (ev.op === 'D') await writer.deleteDoc(index, ev.pk);
          else await writer.insertDocs(destSchema, index, [{ _id: ev.pk, ...ev.doc }]);
        });
      }
      if (rows.length) console.log(`[Replication] started ${rows.length} Kafka CDC→ES consumer(s)`);
    } catch (e: any) { console.warn(`[Replication] CDC consumer startup skipped: ${e.message}`); }
  }
}
