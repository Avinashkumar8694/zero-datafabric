/**
 * Streaming configuration.
 *
 * Two independent, config-governed behaviours:
 *   1. RESPONSE streaming  — deliver results to the client as NDJSON instead of one
 *                            buffered JSON envelope (per-request `stream` flag).
 *   2. INTERNAL streaming  — when a query is a pass-through scan, pull rows from the
 *                            source with a CURSOR (pg-query-stream / Mongo cursor) in
 *                            bounded batches instead of materializing the whole result
 *                            in fabric memory. This is what makes `stream:true` actually
 *                            reduce SERVER memory + time-to-first-row.
 *
 * Env knobs (all optional; sane defaults):
 *   FABRIC_STREAM_INTERNAL   on|off   (default on)   — enable cursor-based internal streaming
 *   FABRIC_STREAM_DEFAULT    on|off   (default off)  — default per-request `stream` when unset
 *   FABRIC_STREAM_BATCH      integer  (default 500)  — cursor FETCH / Mongo batchSize
 *   FABRIC_STREAM_HIGHWATER  integer  (default 1000) — max rows buffered in the transform before backpressure
 */

const onOff = (v: string | undefined, dflt: boolean): boolean => {
  if (v == null || v === '') return dflt;
  return /^(1|true|on|yes)$/i.test(v);
};
const int = (v: string | undefined, dflt: number, min = 1, max = 100000): number => {
  const n = parseInt(String(v ?? ''), 10);
  return Number.isFinite(n) ? Math.max(min, Math.min(max, n)) : dflt;
};

export interface StreamConfig {
  /** Master switch for cursor-based INTERNAL streaming of pass-through scans. */
  internal: boolean;
  /** Default value of the per-request `stream` flag when the caller omits it. */
  defaultOn: boolean;
  /** Rows fetched per cursor round-trip (Postgres FETCH size / Mongo batchSize). */
  batch: number;
  /** Backpressure high-water mark for the cursor→NDJSON pipe. */
  highWater: number;
}

/** Read the current streaming configuration from the environment (evaluated per call so it is test-overridable). */
export function streamConfig(): StreamConfig {
  return {
    internal: onOff(process.env.FABRIC_STREAM_INTERNAL, true),
    defaultOn: onOff(process.env.FABRIC_STREAM_DEFAULT, false),
    batch: int(process.env.FABRIC_STREAM_BATCH, 500),
    highWater: int(process.env.FABRIC_STREAM_HIGHWATER, 1000),
  };
}
