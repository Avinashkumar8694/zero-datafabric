/**
 * PhysicalSync — real SYNC / CDC replication of a remote source into the hub.
 *
 * Unlike VIRTUAL (query the source live via its connector), SYNC/CDC copy the
 * source's rows into the tenant's hub Postgres schema (`tenant_<id>_<schema>`),
 * so the planner classifies the source as `reachableInPg` and serves it as one
 * native hub SQL statement (fast local joins, no per-query round-trip to the
 * source).
 *
 *   • SYNC — one-shot (or on-demand) FULL backfill: create matching hub tables
 *     and bulk-copy every row. Re-running truncates + reloads.
 *   • CDC  — backfill + INCREMENTAL refresh: each poll pulls only rows whose
 *     watermark column (e.g. `updated_at` / `id`) advanced past the last seen
 *     value and upserts them, so the hub replica tracks the source over time.
 *     Configured per source as `config.cdc = { column, intervalMs }`.
 *
 * DDL/DML run as `fabric_admin` (the pool) since creating schemas/tables needs
 * privileges the low-priv tenant role lacks.
 */
import { pool } from '../../config/database';
import { ConnectorFactory } from '../metadata/connectors/factory';
import { canonicalType } from '../metadata/ddl_render';
import { pagedRead, withLock, heapMb, CopyOpts, CopyPaused, countRows } from './copy_util';
import { CdcCapture } from './cdc_capture';

const SYSTEM_SCHEMAS = new Set(['information_schema', 'performance_schema', 'mysql', 'sys', 'admin', 'config', 'local', 'pg_catalog', 'fabric_cdc']);
const COPY_CAP = Number(process.env.FABRIC_SYNC_MAX_ROWS) || 200000;

/** Sanitize a tenant id into the hub schema prefix, matching `toTenantSchemaName`. */
function hubSchemaFor(tenantId: string, schema: string): string {
  return `tenant_${String(tenantId).replace(/[^a-zA-Z0-9_]/g, '')}_${String(schema).replace(/[^a-zA-Z0-9_]/g, '')}`;
}
const q = (id: string) => '"' + String(id).replace(/"/g, '') + '"';

export interface SyncResult {
  source: string; engine: string; mode: 'SYNC' | 'CDC';
  tables: { schema: string; table: string; rows: number; mode: string }[];
  errors: string[];
}

export class PhysicalSync {
  /**
   * FULL backfill of a source into the hub. Creates `tenant_<id>_<schema>` hub
   * schemas + matching tables and bulk-copies every TABLE resource's rows.
   * Idempotent: existing hub tables are truncated and reloaded. For CDC sources
   * it also records the initial watermark so subsequent refreshes are incremental.
   *
   * @param tenantId tenant id.
   * @param sourceName the logical source name (must be a registered data source).
   * @returns a per-table row-count summary.
   */
  static async backfill(tenantId: string, sourceName: string, opts?: CopyOpts): Promise<SyncResult> {
    // One backfill per source at a time — a scheduler tick + a manual trigger must not
    // stack (double memory + duplicate work). Skip (don't crash/queue) if already running.
    const r = await withLock(`sync:${tenantId}:${sourceName}`, () => this._backfill(tenantId, sourceName, opts));
    return r || { source: sourceName, engine: 'UNKNOWN', mode: 'SYNC', tables: [], errors: ['skipped — a sync for this source is already in progress'] };
  }

  private static async _backfill(tenantId: string, sourceName: string, opts?: CopyOpts): Promise<SyncResult> {
    const src = await this.getSource(tenantId, sourceName);
    const mode = (src.sync_type || 'SYNC').toUpperCase() === 'CDC' ? 'CDC' : 'SYNC';
    const cdcCol: string | undefined = src.config?.cdc?.column;
    const connector: any = ConnectorFactory.getConnector(src.type, src.config);
    const result: SyncResult = { source: sourceName, engine: String(src.type).toUpperCase(), mode, tables: [], errors: [] };
    try {
      const schemas = (await connector.discoverSchemas()).filter((s: any) => !SYSTEM_SCHEMAS.has(String(s.name).toLowerCase()));
      for (const s of schemas) {
        const schemaName = s.name;
        const hubSchema = hubSchemaFor(tenantId, schemaName);
        await pool.query(`CREATE SCHEMA IF NOT EXISTS ${q(hubSchema)}`);
        // Queries run as the low-priv `fabric_user` role — grant it access to the replica.
        await this.grantTenantAccess(hubSchema);
        const tables = (await connector.discoverTables(schemaName)).filter((t: any) => (t.resourceType || 'TABLE') === 'TABLE' && !/^fabric_cdc/i.test(t.name));
        for (const t of tables) {
          try {
            const rows = await this.copyTable(connector, schemaName, t.name, hubSchema, opts);
            result.tables.push({ schema: schemaName, table: t.name, rows, mode: 'full' });
            if (mode === 'CDC' && cdcCol) await this.recordWatermark(tenantId, sourceName, hubSchema, t.name, cdcCol);
          } catch (e: any) {
            if (e instanceof CopyPaused) throw e;   // bubble up so the job goes PAUSED
            result.errors.push(`${schemaName}.${t.name}: ${e.message}`);
          }
        }
        await this.grantTenantAccess(hubSchema); // re-grant to cover the tables just created
      }
    } finally { await connector.close().catch(() => {}); }
    console.log(`[PhysicalSync] ${mode} backfill "${sourceName}": ${result.tables.reduce((n, t) => n + t.rows, 0)} rows, ${result.errors.length} error(s), heap ${heapMb()}MB`);
    return result;
  }

  /** Grant the low-priv tenant role read/write on a replica schema (queries run as `fabric_user`). */
  private static async grantTenantAccess(hubSchema: string): Promise<void> {
    try {
      await pool.query(`GRANT USAGE ON SCHEMA ${q(hubSchema)} TO fabric_user`);
      await pool.query(`GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA ${q(hubSchema)} TO fabric_user`);
      await pool.query(`ALTER DEFAULT PRIVILEGES IN SCHEMA ${q(hubSchema)} GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO fabric_user`);
    } catch { /* fabric_user role may not exist in some envs; grants are best-effort */ }
  }

  /**
   * Create the hub table from discovered columns and bulk-load all source rows —
   * bounded-memory, keyset-paged, and resumable via the job's checkpoint.
   */
  private static async copyTable(connector: any, schema: string, table: string, hubSchema: string, opts?: CopyOpts): Promise<number> {
    const cols: any[] = connector.discoverColumns ? await connector.discoverColumns(schema, table) : [];
    if (!cols.length) throw new Error('no columns discovered');
    const colDefs = cols.map((c) => `${q(c.name)} ${canonicalType(c.type)}`);
    // Carry the source PK into the replica so upserts (ON CONFLICT) and keyset resume have a key.
    const pkCols = cols.filter((c) => c.primaryKey).map((c) => c.name);
    if (pkCols.length) colDefs.push(`PRIMARY KEY (${pkCols.map(q).join(', ')})`);
    const colNames = cols.map((c) => c.name);
    const keyCol = pkCols[0];                       // keyset (concurrent-safe + resumable) only with a PK
    const pk = keyCol || colNames[0];

    const cp = opts?.checkpoint;
    let start = cp ? await cp.getStart(hubSchema, table) : undefined;
    if (start?.done) return start.rowsCopied;       // finished in a prior run → skip
    // Row-level resume + dedupe need a PK. Without one, a keyless table restarts from
    // scratch on crash (DROP+reload) rather than resuming with plain inserts that would
    // duplicate rows already in the hub replica.
    let canResume = !!start && !!keyCol;
    // Resume is FORWARD from the last committed key via upsert — no count/re-scan (a busy
    // source churns rows, so any count heuristic would false-trigger full reloads). Only
    // guard the table being entirely GONE (dropped during the crash window). Ongoing
    // updates/deletes are reconciled by CDC/INCREMENTAL or a fresh full backfill.
    if (canResume) {
      let tableExists = true;
      try { await pool.query(`SELECT 1 FROM ${q(hubSchema)}.${q(table)} LIMIT 1`); }
      catch { tableExists = false; }
      if (!tableExists) {
        console.warn(`[PhysicalSync] resume: hub replica ${hubSchema}.${table} is missing — rebuilding from scratch`);
        canResume = false;
      }
    }
    if (!canResume) {
      await pool.query(`DROP TABLE IF EXISTS ${q(hubSchema)}.${q(table)}`);
      await pool.query(`CREATE TABLE ${q(hubSchema)}.${q(table)} (${colDefs.join(', ')})`);
      start = undefined;                            // ignore stale/keyless checkpoint
    } else {
      await pool.query(`CREATE TABLE IF NOT EXISTS ${q(hubSchema)}.${q(table)} (${colDefs.join(', ')})`);
    }
    if (cp) { const total = await countRows(connector, schema, table); await cp.save(hubSchema, table, start?.cursor ?? null, start?.rowsCopied || 0, false, total ?? undefined); }
    const ctx = cp ? {
      startCursor: start?.cursor,
      priorRows: start?.rowsCopied || 0,
      onProgress: (cursor: any, rows: number) => cp.save(hubSchema, table, cursor, rows, false),
      shouldStop: () => cp.shouldStop(),
    } : undefined;
    // Resuming a keyed table upserts (idempotent on re-applied boundary rows); a fresh copy plain-inserts.
    const sink = (rows: any[]) => canResume
      ? this.bulkUpsert(hubSchema, table, colNames, pk, rows)
      : this.bulkInsert(hubSchema, table, colNames, rows);
    const res = await pagedRead(connector, schema, table, keyCol, sink, opts, ctx);
    if (cp) await cp.save(hubSchema, table, res.cursor, res.rows, true);   // mark table complete
    return res.rows;
  }

  /** Upsert a batch by PK into the hub replica (used on resumed copies for idempotency). */
  private static async bulkUpsert(hubSchema: string, table: string, colNames: string[], pk: string, rows: any[]): Promise<void> {
    const colList = colNames.map(q).join(', ');
    const upd = colNames.filter((c) => c !== pk).map((c) => `${q(c)}=EXCLUDED.${q(c)}`).join(', ');
    const conflict = upd ? `ON CONFLICT (${q(pk)}) DO UPDATE SET ${upd}` : `ON CONFLICT (${q(pk)}) DO NOTHING`;
    for (const row of rows) {
      const params: any[] = [];
      const ph = colNames.map((c) => { let v = row[c]; if (v !== null && typeof v === 'object') v = JSON.stringify(v); params.push(v === undefined ? null : v); return `$${params.length}`; });
      await pool.query(`INSERT INTO ${q(hubSchema)}.${q(table)} (${colList}) VALUES (${ph.join(', ')}) ${conflict}`, params);
    }
  }

  /** Parameterized multi-row INSERT in batches (jsonb/object values are JSON-encoded). */
  private static async bulkInsert(hubSchema: string, table: string, colNames: string[], rows: any[]): Promise<void> {
    if (!rows.length) return;
    const colList = colNames.map(q).join(', ');
    const BATCH = 500;
    for (let i = 0; i < rows.length; i += BATCH) {
      const slice = rows.slice(i, i + BATCH);
      const params: any[] = [];
      const tuples = slice.map((row) => {
        const ph = colNames.map((c) => {
          let v = row[c];
          if (v !== null && typeof v === 'object') v = JSON.stringify(v);
          params.push(v === undefined ? null : v);
          return `$${params.length}`;
        });
        return `(${ph.join(', ')})`;
      });
      await pool.query(`INSERT INTO ${q(hubSchema)}.${q(table)} (${colList}) VALUES ${tuples.join(', ')}`, params);
    }
  }

  /**
   * INCREMENTAL CDC refresh: for each synced table with a watermark column, pull
   * source rows where `column > lastWatermark`, upsert into the hub replica, and
   * advance the watermark. Requires the source to be CDC with `config.cdc.column`.
   * @param tenantId tenant id.
   * @param sourceName the logical source name.
   * @returns per-table counts of rows refreshed.
   */
  static async refreshCdc(tenantId: string, sourceName: string): Promise<SyncResult> {
    const r = await withLock(`cdc:${tenantId}:${sourceName}`, () => this._refreshCdc(tenantId, sourceName));
    return r || { source: sourceName, engine: 'UNKNOWN', mode: 'CDC', tables: [], errors: ['skipped — a refresh for this source is already in progress'] };
  }

  private static async _refreshCdc(tenantId: string, sourceName: string): Promise<SyncResult> {
    const src = await this.getSource(tenantId, sourceName);
    const cdcCol: string | undefined = src.config?.cdc?.column;
    const result: SyncResult = { source: sourceName, engine: String(src.type).toUpperCase(), mode: 'CDC', tables: [], errors: [] };
    const connector: any = ConnectorFactory.getConnector(src.type, src.config);
    try {
      const schemas = (await connector.discoverSchemas()).filter((s: any) => !SYSTEM_SCHEMAS.has(String(s.name).toLowerCase()));
      for (const s of schemas) {
        const hubSchema = hubSchemaFor(tenantId, s.name);
        const tables = (await connector.discoverTables(s.name)).filter((t: any) => (t.resourceType || 'TABLE') === 'TABLE' && !/^fabric_cdc/i.test(t.name));
        for (const t of tables) {
          try {
            const cols: any[] = await connector.discoverColumns(s.name, t.name);
            const colNames = cols.map((c) => c.name);
            const pk = cols.find((c) => c.primaryKey)?.name;
            const eng = String(src.type).toUpperCase();
            const srcMongo = ['MONGODB', 'MONGO'].includes(eng);
            const logCapable = !!pk && (['POSTGRES', 'POSTGRESQL', 'MYSQL', 'ORACLE', 'ORACLEDB'].includes(eng) || srcMongo);

            // LOG-BASED full-CRUD CDC (captures DELETEs) when the source supports capture.
            if (logCapable) {
              const posKey = `${t.name}#log`;
              if (!srcMongo) await CdcCapture.ensure(eng, connector, s.name, t.name, pk!, colNames);
              const posRaw = await this.getWatermark(tenantId, sourceName, hubSchema, posKey);
              if (posRaw == null) {
                // Baseline: the backfill already loaded the hub table — just record the current log position.
                const pos = srcMongo ? await connector.currentChangeToken(s.name, t.name) : await CdcCapture.maxSeq(eng, connector, s.name, t.name);
                await this.setWatermark(tenantId, sourceName, hubSchema, posKey, '__logpos__', srcMongo ? JSON.stringify(pos ?? null) : String(pos));
                result.tables.push({ schema: s.name, table: t.name, rows: 0, mode: 'cdc-baseline' });
                continue;
              }
              let applied = 0;
              if (srcMongo) {
                let token = JSON.parse(posRaw);
                for (;;) {
                  const { changes, token: next } = await connector.drainChanges(s.name, t.name, token, 500);
                  if (!changes.length) { if (next) await this.setWatermark(tenantId, sourceName, hubSchema, posKey, '__logpos__', JSON.stringify(next)); break; }
                  for (const c of changes) { if (c.op === 'D') await this.hubDelete(hubSchema, t.name, pk!, c.pk); else await this.upsert(hubSchema, t.name, colNames, pk!, [c.doc]); }
                  token = next; applied += changes.length; await this.setWatermark(tenantId, sourceName, hubSchema, posKey, '__logpos__', JSON.stringify(token));
                  if (changes.length < 500) break;
                }
              } else {
                let seq = Number(posRaw || 0);
                for (;;) {
                  const changes = await CdcCapture.read(eng, connector, s.name, t.name, seq, 500);
                  if (!changes.length) break;
                  for (const c of changes) { if (c.op === 'D') await this.hubDelete(hubSchema, t.name, pk!, c.pk); else await this.upsert(hubSchema, t.name, colNames, pk!, [c.doc]); seq = c.seq; }
                  applied += changes.length; await this.setWatermark(tenantId, sourceName, hubSchema, posKey, '__logpos__', String(seq));
                  if (changes.length < 500) break;
                }
                if (applied) await CdcCapture.prune(eng, connector, s.name, t.name, seq);
              }
              result.tables.push({ schema: s.name, table: t.name, rows: applied, mode: 'cdc' });
              continue;
            }

            // Fallback: watermark CDC (inserts + timestamp-updates only, no deletes).
            if (!cdcCol || !cols.some((c) => c.name === cdcCol)) continue;
            const wm = await this.getWatermark(tenantId, sourceName, hubSchema, t.name);
            const filter = wm != null ? { [cdcCol]: { $gt: wm } } : {};
            const rows: any[] = await connector.query(s.name, t.name, { filter, orderBy: [{ field: cdcCol, dir: 'ASC' }], limit: COPY_CAP });
            if (rows.length) {
              await this.upsert(hubSchema, t.name, colNames, pk || cdcCol, rows);
              const maxWm = rows.reduce((m, r) => (r[cdcCol] > m ? r[cdcCol] : m), rows[0][cdcCol]);
              await this.setWatermark(tenantId, sourceName, hubSchema, t.name, cdcCol, maxWm);
            }
            result.tables.push({ schema: s.name, table: t.name, rows: rows.length, mode: 'incremental' });
          } catch (e: any) { result.errors.push(`${s.name}.${t.name}: ${e.message}`); }
        }
      }
    } finally { await connector.close().catch(() => {}); }
    return result;
  }

  /** Apply a CDC delete to the hub replica (remove the row by primary key). */
  private static async hubDelete(hubSchema: string, table: string, pk: string, pkValue: any): Promise<void> {
    await pool.query(`DELETE FROM ${q(hubSchema)}.${q(table)} WHERE ${q(pk)}=$1`, [pkValue]);
  }

  /** Upsert rows into the hub replica keyed by `pk` (ON CONFLICT DO UPDATE). */
  private static async upsert(hubSchema: string, table: string, colNames: string[], pk: string, rows: any[]): Promise<void> {
    const colList = colNames.map(q).join(', ');
    const updates = colNames.filter((c) => c !== pk).map((c) => `${q(c)} = EXCLUDED.${q(c)}`).join(', ');
    for (const row of rows) {
      const params: any[] = [];
      const ph = colNames.map((c) => { let v = row[c]; if (v !== null && typeof v === 'object') v = JSON.stringify(v); params.push(v === undefined ? null : v); return `$${params.length}`; });
      const conflict = updates ? `ON CONFLICT (${q(pk)}) DO UPDATE SET ${updates}` : `ON CONFLICT (${q(pk)}) DO NOTHING`;
      await pool.query(`INSERT INTO ${q(hubSchema)}.${q(table)} (${colList}) VALUES (${ph.join(', ')}) ${conflict}`, params);
    }
  }

  // ---- watermark state (fabric_system.cdc_state) ----
  private static async ensureState(): Promise<void> {
    await pool.query(`CREATE SCHEMA IF NOT EXISTS fabric_system`);
    await pool.query(`CREATE TABLE IF NOT EXISTS fabric_system.cdc_state (
      tenant_id text, source_name text, hub_schema text, table_name text,
      watermark_column text, watermark_value text, updated_at timestamptz DEFAULT now(),
      PRIMARY KEY (tenant_id, source_name, hub_schema, table_name))`);
  }
  private static async recordWatermark(tenantId: string, source: string, hubSchema: string, table: string, col: string): Promise<void> {
    await this.ensureState();
    // Seed the watermark to the current MAX so the first refresh only picks up NEW rows.
    const r = await pool.query(`SELECT MAX(${q(col)})::text AS mx FROM ${q(hubSchema)}.${q(table)}`).catch(() => ({ rows: [{ mx: null }] }));
    await this.setWatermark(tenantId, source, hubSchema, table, col, r.rows[0]?.mx ?? null);
  }
  private static async getWatermark(tenantId: string, source: string, hubSchema: string, table: string): Promise<any> {
    await this.ensureState();
    const r = await pool.query(`SELECT watermark_value FROM fabric_system.cdc_state WHERE tenant_id=$1 AND source_name=$2 AND hub_schema=$3 AND table_name=$4`, [tenantId, source, hubSchema, table]);
    return r.rows[0]?.watermark_value ?? null;
  }
  private static async setWatermark(tenantId: string, source: string, hubSchema: string, table: string, col: string, value: any): Promise<void> {
    await this.ensureState();
    await pool.query(`INSERT INTO fabric_system.cdc_state (tenant_id, source_name, hub_schema, table_name, watermark_column, watermark_value, updated_at)
      VALUES ($1,$2,$3,$4,$5,$6, now())
      ON CONFLICT (tenant_id, source_name, hub_schema, table_name)
      DO UPDATE SET watermark_column=EXCLUDED.watermark_column, watermark_value=EXCLUDED.watermark_value, updated_at=now()`,
      [tenantId, source, hubSchema, table, col, value == null ? null : String(value)]);
  }

  private static async getSource(tenantId: string, sourceName: string): Promise<any> {
    const r = await pool.query(`SELECT name, type, sync_type, config FROM public.data_sources WHERE tenant_id=$1 AND name=$2`, [tenantId, sourceName]);
    if (!r.rows.length) throw new Error(`source "${sourceName}" not found for tenant "${tenantId}"`);
    return r.rows[0];
  }

  /**
   * Background poller: every `intervalMs` (default 15s) refresh each CDC source
   * incrementally. Idempotent start.
   */
  private static started = false;
  static startCdcPoller(intervalMs = Number(process.env.FABRIC_CDC_POLL_MS) || 15000): void {
    if (this.started) return;
    this.started = true;
    setInterval(async () => {
      try {
        const { rows } = await pool.query(`SELECT tenant_id, name FROM public.data_sources WHERE UPPER(sync_type)='CDC' AND status='CONNECTED'`);
        // Assign the copy work to the replication microservice rather than running it inline.
        const { CopyJobEngine } = require('../jobs/copy_job_engine');
        for (const s of rows) await CopyJobEngine.enqueue(s.tenant_id, 'CDC', { jobRef: s.name, dedupe: true }).catch(() => {});
      } catch { /* poller is best-effort */ }
    }, intervalMs).unref?.();
    console.log(`[PhysicalSync] CDC poller started (${intervalMs}ms)`);
  }

  /**
   * SCHEDULED full SYNC: SYNC sources may declare `config.sync.scheduleMs` to be
   * re-backfilled on a cron-like cadence (so a SYNC replica stays fresh without
   * CDC). This ticker checks due sources and re-runs `backfill`. State (last run)
   * lives in `fabric_system.sync_schedule`. Idempotent start.
   */
  private static schedStarted = false;
  static startSyncScheduler(tickMs = Number(process.env.FABRIC_SYNC_SCHED_TICK_MS) || 30000): void {
    if (this.schedStarted) return;
    this.schedStarted = true;
    setInterval(async () => {
      try {
        await pool.query(`CREATE SCHEMA IF NOT EXISTS fabric_system`);
        await pool.query(`CREATE TABLE IF NOT EXISTS fabric_system.sync_schedule (tenant_id text, source_name text, last_run_at timestamptz, PRIMARY KEY (tenant_id, source_name))`);
        const { rows } = await pool.query(`
          SELECT ds.tenant_id, ds.name, (ds.config->'sync'->>'scheduleMs')::bigint AS interval_ms, ss.last_run_at
          FROM public.data_sources ds
          LEFT JOIN fabric_system.sync_schedule ss ON ss.tenant_id=ds.tenant_id AND ss.source_name=ds.name
          WHERE UPPER(ds.sync_type)='SYNC' AND ds.status='CONNECTED' AND (ds.config->'sync'->>'scheduleMs') IS NOT NULL`);
        const { CopyJobEngine } = require('../jobs/copy_job_engine');
        for (const s of rows) {
          const due = !s.last_run_at || (Date.now() - new Date(s.last_run_at).getTime()) >= Number(s.interval_ms);
          if (!due) continue;
          // Assign the full re-sync to the replication microservice (deduped).
          await CopyJobEngine.enqueue(s.tenant_id, 'SYNC', { jobRef: s.name, dedupe: true }).catch(() => {});
          await pool.query(`INSERT INTO fabric_system.sync_schedule (tenant_id, source_name, last_run_at) VALUES ($1,$2, now())
            ON CONFLICT (tenant_id, source_name) DO UPDATE SET last_run_at=now()`, [s.tenant_id, s.name]);
          console.log(`[PhysicalSync] scheduled full re-sync of ${s.name} enqueued (every ${s.interval_ms}ms)`);
        }
      } catch { /* scheduler is best-effort */ }
    }, tickMs).unref?.();
    console.log(`[PhysicalSync] SYNC scheduler started (tick ${tickMs}ms)`);
  }
}
