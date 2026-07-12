/**
 * copy_util — bounded-memory, crash-safe, resumable row copying for SYNC / CDC /
 * replication.
 *
 * The naive "read the whole table into an array, then insert" pattern can exhaust
 * heap and crash the process on a large source. These helpers instead:
 *   • **page** through the source in fixed batches (memory ≈ one batch, not the
 *     whole table), via each connector's existing `query({limit,...})`;
 *   • **keyset-paginate** (WHERE key > lastKey ORDER BY key) instead of OFFSET
 *     when a key column is available — this is *stable under concurrent
 *     inserts/deletes* (OFFSET can skip or duplicate rows when the source
 *     changes mid-copy) AND the `lastKey` doubles as a **resume checkpoint**;
 *   • **guard memory** — sample heap between batches and, if it crosses a
 *     configurable ceiling, try GC and otherwise ABORT the copy with a clear
 *     error (caught per-table) rather than letting the process OOM;
 *   • enforce a hard row cap so a runaway/looping read can't spin forever;
 *   • support **pause** (a `shouldStop` probe checked between batches) and
 *     **resume** (a `startKey` to continue from a persisted checkpoint), so a
 *     killed/paused copy loses no committed progress.
 *
 * Env: FABRIC_COPY_BATCH (rows/page, default 1000), FABRIC_COPY_MEM_CEILING_MB
 * (heap ceiling, default 1024), FABRIC_COPY_MAX_ROWS (hard cap, default 5,000,000).
 */

export const COPY_BATCH = Number(process.env.FABRIC_COPY_BATCH) || 1000;
const MEM_CEILING_MB = Number(process.env.FABRIC_COPY_MEM_CEILING_MB) || 1024;
const HARD_MAX_ROWS = Number(process.env.FABRIC_COPY_MAX_ROWS) || 5_000_000;

/** Per-copy config overrides (from a job's config); each falls back to the env default. */
export interface CopyOpts {
  batchSize?: number;
  memCeilingMb?: number;
  maxRows?: number;
  /** Optional durable checkpoint/pause provider (supplied by the job engine). */
  checkpoint?: CheckpointProvider;
}
export const resolveOpts = (o?: CopyOpts) => ({
  batchSize: o?.batchSize && o.batchSize > 0 ? o.batchSize : COPY_BATCH,
  memCeilingMb: o?.memCeilingMb && o.memCeilingMb > 0 ? o.memCeilingMb : MEM_CEILING_MB,
  maxRows: o?.maxRows && o.maxRows > 0 ? o.maxRows : HARD_MAX_ROWS,
});

/**
 * Durable per-table checkpoint + pause control, implemented by the job engine
 * and threaded into a copy so it survives a crash/restart. Kept as an interface
 * here so `copy_util` stays free of any DB/engine dependency.
 */
export interface CheckpointProvider {
  /**
   * Resume state for a table from a prior (possibly interrupted) run: the cursor
   * to continue from, rows already copied, and whether it already finished
   * (`done` → the caller skips it). `undefined` → start fresh.
   */
  getStart(schema: string, table: string): Promise<{ cursor: any; rowsCopied: number; done: boolean } | undefined>;
  /**
   * Persist progress after a committed batch. `done` marks the table complete;
   * `total` (optional) seeds/updates the table's estimated row count for % math.
   */
  save(schema: string, table: string, cursor: any, rowsCopied: number, done: boolean, total?: number): Promise<void>;
  /** True if the job was asked to pause/cancel (checked between batches). */
  shouldStop(): Promise<boolean>;
}

/** Per-call copy context: resume cursor, progress sink, pause probe. */
export interface CopyCtx {
  /** Resume cursor: last key (keyset mode) or starting offset (offset mode). */
  startCursor?: any;
  /** Rows already copied before this call (for resumed runs) — added to totals/progress. */
  priorRows?: number;
  /** Invoked after each committed batch with the new cursor + cumulative rows. */
  onProgress?: (cursor: any, rowsCopied: number) => Promise<void> | void;
  /** Probed between batches; when it returns true the copy stops (paused/cancelled). */
  shouldStop?: () => Promise<boolean> | boolean;
}

/** Thrown when a copy stops early because the job was paused/cancelled. */
export class CopyPaused extends Error {
  constructor(msg = 'copy paused') { super(msg); this.name = 'CopyPaused'; }
}

/**
 * Sample heap and keep the copy inside a memory budget. Tries `global.gc()` (when
 * the process was started with `--expose-gc`); if heap is still over the ceiling,
 * throws so the caller aborts THIS copy gracefully instead of OOM-crashing.
 * @param label context for the error message.
 * @param ceilingMb optional per-job ceiling (defaults to the env ceiling).
 */
export function memGuard(label: string, ceilingMb = MEM_CEILING_MB): void {
  const heapUsedMb = process.memoryUsage().heapUsed / 1048576;
  if (heapUsedMb <= ceilingMb) return;
  const g = (global as any).gc;
  if (typeof g === 'function') { try { g(); } catch { /* ignore */ } }
  const afterMb = process.memoryUsage().heapUsed / 1048576;
  if (afterMb > ceilingMb) {
    throw new Error(`memory ceiling exceeded during ${label} (${Math.round(afterMb)}MB > ${ceilingMb}MB) — copy aborted to prevent OOM. Lower the job's pageSize, add a filter, or raise its memCeilingMb.`);
  }
}

/** Current heap in MB (for telemetry/logging). */
export function heapMb(): number { return Math.round(process.memoryUsage().heapUsed / 1048576); }

/**
 * Best-effort row count of a source table via a pushed-down COUNT(*) aggregate —
 * used to seed the "% completion" denominator. Returns null if the source can't
 * answer (progress then falls back to a tables-done fraction).
 */
export async function countRows(reader: any, schema: string, table: string): Promise<number | null> {
  try {
    const r = await reader.query(schema, table, { aggregates: [{ func: 'COUNT', alias: '__cnt' }] });
    const row = Array.isArray(r) ? r[0] : null;
    if (!row) return 0;
    const v = row.__cnt ?? row.cnt ?? row.count ?? row.COUNT ?? Object.values(row)[0];
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  } catch { return null; }
}

/** Result of a paged copy: rows read this call, final cursor, and whether it stopped early. */
export interface PagedResult { rows: number; cursor: any; stopped: boolean; }

/**
 * Page through a source table in bounded batches, invoking `onBatch` for each.
 * Memory stays ≈ one batch.
 *
 * When `keyCol` is a **unique key** (a PK), paging is *keyset* (WHERE key >
 * lastKey ORDER BY key ASC): stable under concurrent writes and resumable from
 * `ctx.startCursor`. Without a unique key, it falls back to OFFSET paging (memory
 * still bounded, but not concurrency-safe — documented caveat).
 *
 * Stops on a short page, the hard row cap, a memory abort, or a pause request.
 * @param reader a connector exposing `query(schema, table, canonical)`.
 * @param schema source schema/db.
 * @param table source table/collection.
 * @param keyCol unique key column for keyset paging (undefined → OFFSET fallback).
 * @param onBatch async sink invoked with each batch of rows.
 * @param opts batch/memory/row-cap overrides.
 * @param ctx resume cursor + progress sink + pause probe.
 * @returns `{ rows, cursor, stopped }`.
 */
export async function pagedRead(
  reader: any, schema: string, table: string, keyCol: string | undefined,
  onBatch: (rows: any[]) => Promise<void>, opts?: CopyOpts, ctx?: CopyCtx,
): Promise<PagedResult> {
  const { batchSize, memCeilingMb, maxRows } = resolveOpts(opts);
  const keyset = !!keyCol;
  let total = ctx?.priorRows || 0;
  // Resume cursor: last key (keyset) or offset (fallback).
  let lastKey: any = keyset ? (ctx?.startCursor ?? undefined) : undefined;
  let offset: number = keyset ? 0 : Number(ctx?.startCursor || 0);

  for (;;) {
    if (ctx?.shouldStop && (await ctx.shouldStop())) {
      throw new CopyPaused(`copy of ${schema}.${table} paused`);
    }
    memGuard(`read ${schema}.${table}`, memCeilingMb);

    const canonical: any = { limit: batchSize };
    if (keyset) {
      canonical.orderBy = [{ field: keyCol, dir: 'ASC' }];
      if (lastKey !== undefined && lastKey !== null) canonical.filter = { [keyCol!]: { $gt: lastKey } };
    } else {
      canonical.offset = offset;
    }

    const rows: any[] = await reader.query(schema, table, canonical);
    if (!rows || rows.length === 0) break;
    await onBatch(rows);
    total += rows.length;

    // Advance the cursor.
    if (keyset) lastKey = rows[rows.length - 1][keyCol!];
    else offset += rows.length;
    const cursor = keyset ? lastKey : offset;

    if (ctx?.onProgress) await ctx.onProgress(cursor, total);

    if (rows.length < batchSize) return { rows: total, cursor, stopped: false }; // last page
    if (total >= maxRows) throw new Error(`row cap ${maxRows} reached copying ${schema}.${table}; aborting (raise the job's maxRows if intentional).`);
  }
  return { rows: total, cursor: keyset ? lastKey : offset, stopped: false };
}

/**
 * In-memory concurrency lock so a long copy and a scheduler/manual trigger can't
 * run the SAME job/source at once (which would double memory and duplicate work).
 */
const running = new Set<string>();
/** Run `fn` under a key-scoped lock; if the key is already running, skip and return null. */
export async function withLock<T>(key: string, fn: () => Promise<T>): Promise<T | null> {
  if (running.has(key)) return null;
  running.add(key);
  try { return await fn(); } finally { running.delete(key); }
}
