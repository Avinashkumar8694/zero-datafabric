/**
 * Response streaming for query endpoints (`stream: true`).
 *
 * When a caller opts in, query results are delivered as **NDJSON** (newline-
 * delimited JSON): one JSON object per line for each result row, followed by a
 * final trailer line `{ "__meta__": { … } }` carrying the plan / legs / rowCount
 * / warnings that the buffered `{ data, rowCount, plan, warnings }` envelope
 * normally holds. This lets a client consume rows incrementally (progressive
 * render, lower client memory, early cancel) instead of waiting for — and
 * buffering — one large JSON document.
 *
 * Scope: this is RESPONSE streaming — the engine still computes the result (so
 * the query-log/audit telemetry is captured intact), then hands rows to the
 * client as a stream. True node-to-node (intra-query) streaming is a separate
 * roadmap item (see system_docs/18). The trailer preserves the audit contract.
 */
import { Response } from 'express';
import { streamConfig } from '../../config/stream-config';
import { QueryLogService } from './query-log.service';
import { RowStream } from './stream_source';

/** Was streaming requested? Honors `body.stream`, `queryConfig.stream`, `?stream=true`, or the config default. */
export function wantsStream(req: any): boolean {
  const b = req.body || {};
  const flag = b.stream ?? b.queryConfig?.stream ?? b.config?.stream ?? req.query?.stream;
  if (flag === true || flag === 'true' || flag === 1 || flag === '1') return true;
  if (flag === false || flag === 'false' || flag === 0 || flag === '0') return false;
  return streamConfig().defaultOn; // unspecified → config default
}

/**
 * INTERNAL streaming: pipe a cursor-backed `RowStream` to the client as NDJSON,
 * row-by-row, without materializing the result in fabric memory. Measures the
 * (now bounded) heap delta + timing, writes the `{__meta__}` trailer, records the
 * query-log audit, and cancels the source cursor if the client disconnects early.
 *
 * @param req - the Express request (for the `close` abort signal).
 * @param res - the Express response.
 * @param rows - the lazy row source from `tryStream`.
 * @param logMeta - query-log metadata (tenant/user/mode/api/queryText).
 */
export async function pipeRowStream(req: any, res: Response, rows: RowStream, logMeta: any): Promise<void> {
  res.setHeader('Content-Type', 'application/x-ndjson; charset=utf-8');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('X-Fabric-Stream', 'ndjson-internal');
  const t0 = Date.now();
  const m0 = process.memoryUsage().heapUsed;
  const it = rows.iterate()[Symbol.asyncIterator]();
  let n = 0, aborted = false, error: string | null = null;
  req.on('close', () => { if (!res.writableEnded) { aborted = true; if (it.return) it.return(undefined as any).catch(() => {}); } });
  try {
    for (;;) {
      if (aborted) break;
      const { value, done } = await it.next();
      if (done) break;
      res.write(JSON.stringify(value) + '\n');
      n++;
    }
  } catch (e: any) { error = e?.message || String(e); }
  const memDeltaKb = Math.max(0, Math.round((process.memoryUsage().heapUsed - m0) / 1024));
  const tatMs = Date.now() - t0;
  const plan = {
    strategy: rows.strategy, executionMs: tatMs,
    legs: [{ source: rows.source, engine: rows.engine, mode: 'connector', operation: 'stream-scan', target: rows.source, query: rows.queryText, rowsReturned: n, ms: tatMs }],
    pushed: ['internal cursor stream (bounded batches) — result NOT materialized in fabric memory'],
  };
  if (!aborted) res.write(JSON.stringify({ __meta__: { streamed: true, internal: true, rowCount: n, strategy: rows.strategy, source: rows.source, engine: rows.engine, executionMs: tatMs, memDeltaKb, ...(error ? { error } : {}) } }) + '\n');
  res.end();
  // Best-effort audit — records the SAME telemetry as buffered queries (the memDelta here is the bounded-memory evidence).
  QueryLogService.record(logMeta, { rowCount: n, plan, warnings: [] }, { tatMs, memDeltaKb, status: error ? 'ERROR' : (aborted ? 'CANCELLED' : 'SUCCESS'), ...(error ? { error } : {}) } as any).catch(() => {});
}

/**
 * Write an NDJSON stream: each row on its own line, then a `{__meta__}` trailer.
 * Sets `Content-Type: application/x-ndjson` and relies on chunked transfer
 * (no Content-Length) so bytes flush to the client as they are written.
 *
 * @param res - the Express response (headers must not have been sent yet).
 * @param rows - the result rows to stream (each serialized as one JSON line).
 * @param meta - trailer payload (plan, legs, rowCount, warnings, strategy, …).
 */
export function streamNdjson(res: Response, rows: any[], meta: Record<string, any>): void {
  res.setHeader('Content-Type', 'application/x-ndjson; charset=utf-8');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('X-Fabric-Stream', 'ndjson');
  const list = Array.isArray(rows) ? rows : [];
  for (const row of list) res.write(JSON.stringify(row) + '\n');
  // Final trailer line — always distinguishable from data rows by the __meta__ key.
  res.write(JSON.stringify({ __meta__: { streamed: true, rowCount: meta.rowCount ?? list.length, ...meta } }) + '\n');
  res.end();
}
