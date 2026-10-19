/**
 * tracking — smart selection of the columns a copy uses to track progress and change.
 *
 * A copy needs two column roles, and a table may expose several candidates:
 *   • **keyCol** — a stable, unique, orderable column used for keyset paging + resume
 *     cursor + dedupe (upsert). Best = the primary key.
 *   • **watermarkCol** — a monotonically-advancing column used by INCREMENTAL/CDC to
 *     detect *changed* rows (`col > lastSeen`). Best = an "updated/modified" timestamp
 *     (captures inserts AND updates); next best = an auto-increment id (captures inserts
 *     only); otherwise none (the table can only be FULL-reloaded).
 *
 * `analyzeTracking` inspects discovered columns (name + type + primaryKey) and picks both,
 * with a human-readable reason — so the fabric can auto-configure incremental sync and the
 * UI can show "tracking by updated_at (inserts+updates)".
 */

export interface ColumnMeta { name: string; type?: string; primaryKey?: boolean; nullable?: boolean; }

export interface TrackingPlan {
  keyCol?: string | undefined;                 // for keyset paging / resume / dedupe
  watermarkCol?: string | undefined;           // for INCREMENTAL/CDC change detection
  watermarkKind: 'timestamp' | 'sequence' | 'none';
  captures: 'inserts+updates' | 'inserts' | 'none';
  candidates: { key: string[]; watermark: string[] };
  reason: string;
}

const isTimestampType = (t?: string) => /(timestamp|datetime|date|time)/i.test(String(t || ''));
const isNumericType = (t?: string) => /(int|serial|number|numeric|decimal|bigint|long|float|double)/i.test(String(t || ''));
// Names that strongly imply an update-tracking timestamp (captures updates, not just inserts).
const UPDATE_NAME = /(updated|modified|changed|mtime|last[_-]?(update|modified|change|seen)|_at$|timestamp|ts)/i;
// Names that imply an insert/creation marker or a surrogate id.
const ID_NAME = /(^id$|_id$|^pk$|seq|sequence|rowid|version)/i;
const CREATE_NAME = /(created|inserted|added|ctime|_date$)/i;

/**
 * Analyze a table's columns and choose the best key + watermark columns for tracking.
 * @param cols discovered columns (`{name,type,primaryKey}`), e.g. from a connector's `discoverColumns`.
 * @param preferred optional caller hints (`{keyCol?, watermarkCol?}`) that win if present in `cols`.
 */
export function analyzeTracking(cols: ColumnMeta[], preferred?: { keyCol?: string; watermarkCol?: string }): TrackingPlan {
  const names = new Set(cols.map((c) => c.name));
  const byName = (n?: string) => (n && names.has(n) ? n : undefined);

  // ---- keyCol: PK > id-named unique > id-named > first column ----
  const pks = cols.filter((c) => c.primaryKey).map((c) => c.name);
  const idNamed = cols.filter((c) => ID_NAME.test(c.name)).map((c) => c.name);
  const keyCol = byName(preferred?.keyCol) || pks[0] || idNamed[0] || cols[0]?.name;

  // ---- watermark candidates, scored ----
  // 1) update-named timestamps (best — captures updates)
  const updateTs = cols.filter((c) => isTimestampType(c.type) && UPDATE_NAME.test(c.name)).map((c) => c.name);
  // 2) any timestamp (created-named or otherwise — mostly captures inserts, some updates)
  const anyTs = cols.filter((c) => isTimestampType(c.type)).map((c) => c.name);
  const createTs = anyTs.filter((n) => CREATE_NAME.test(n));
  // 3) monotonic numeric id / sequence (captures inserts only)
  const numericId = cols.filter((c) => isNumericType(c.type) && (c.primaryKey || ID_NAME.test(c.name))).map((c) => c.name);

  const watermarkCandidates = [...new Set([...updateTs, ...anyTs, ...numericId])];

  let watermarkCol: string | undefined;
  let watermarkKind: TrackingPlan['watermarkKind'] = 'none';
  let captures: TrackingPlan['captures'] = 'none';
  let reason: string;

  const pref = byName(preferred?.watermarkCol);
  if (pref) {
    watermarkCol = pref;
    watermarkKind = isTimestampType(cols.find((c) => c.name === pref)?.type) ? 'timestamp' : 'sequence';
    captures = watermarkKind === 'timestamp' ? 'inserts+updates' : 'inserts';
    reason = `using caller-specified watermark "${pref}"`;
  } else if (updateTs.length) {
    watermarkCol = updateTs[0]; watermarkKind = 'timestamp'; captures = 'inserts+updates';
    reason = `chose update-timestamp "${watermarkCol}" → captures inserts AND updates`;
  } else if (createTs.length) {
    watermarkCol = createTs[0]; watermarkKind = 'timestamp'; captures = 'inserts';
    reason = `no update-timestamp; chose creation-timestamp "${watermarkCol}" → captures inserts (updates need a FULL run)`;
  } else if (anyTs.length) {
    watermarkCol = anyTs[0]; watermarkKind = 'timestamp'; captures = 'inserts+updates';
    reason = `chose timestamp "${watermarkCol}" → assumed to advance on change`;
  } else if (numericId.length) {
    watermarkCol = numericId[0]; watermarkKind = 'sequence'; captures = 'inserts';
    reason = `no timestamp; chose auto-increment id "${watermarkCol}" → captures new inserts only (updates/deletes need a FULL run)`;
  } else {
    reason = `no monotonic column found → this table can only be FULL-reloaded (no incremental tracking)`;
  }

  return {
    keyCol, watermarkCol, watermarkKind, captures,
    candidates: { key: [...new Set([...pks, ...idNamed])], watermark: watermarkCandidates },
    reason,
  };
}
