/**
 * Capability Compensation Engine (query-side).
 * --------------------------------------------
 * The fabric's own engine for query features a source cannot do natively. The
 * principle mirrors how a SQL database layers window/sort logic ON TOP of a scan:
 *
 *   1. PUSH DOWN everything the source CAN do (filter / projection) so we pull the
 *      smallest bounded result set possible.
 *   2. COMPENSATE in-fabric for what it CAN'T — computed over that bounded result,
 *      never by fetching whole tables.
 *
 * This module implements WINDOW FUNCTIONS (ROW_NUMBER / RANK / DENSE_RANK / LAG /
 * LEAD and running SUM/AVG/COUNT/MIN/MAX OVER (PARTITION BY … ORDER BY …)) so that
 * MongoDB, Elasticsearch — any engine — gets consistent window semantics even
 * though they can't express them.
 *
 * Complexity: O(n log n) per window over the pulled rows `n` (a partition sort);
 * `n` is bounded by the federation row cap, so memory/CPU stay bounded.
 */

export interface WindowSpec {
  /** RANK | DENSE_RANK | ROW_NUMBER | LAG | LEAD | SUM | AVG | COUNT | MIN | MAX */
  fn: string;
  column?: string | null;
  partitionBy: string[];
  orderBy: { column: string; direction: 'ASC' | 'DESC' }[];
  alias: string;
  offset?: number; // for LAG / LEAD (default 1)
}

const RANKING = new Set(['RANK', 'DENSE_RANK', 'ROW_NUMBER']);
const NAV = new Set(['LAG', 'LEAD']);
const RUNNING = new Set(['SUM', 'AVG', 'COUNT', 'MIN', 'MAX']);

/**
 * Last segment of a possibly-qualified column path (alias.col -> col).
 * @param path a plain or `alias.column` qualified path.
 * @returns the unqualified column name.
 */
function base(path: string): string {
  const s = String(path || '');
  return s.includes('.') ? s.split('.').pop()! : s;
}
/**
 * Read a column tolerating alias-qualified keys (o.amount ~ amount).
 * @param row the source row (may be `null`/`undefined`).
 * @param name the column name to read, plain or `alias.column` qualified.
 * @returns the value found under `name`, its base (unqualified) name, or the
 *   first key whose base matches; `undefined` if none match or `row` is nullish.
 */
function readCol(row: any, name: string): any {
  if (row == null) return undefined;
  if (name in row) return row[name];
  const b = base(name);
  if (b in row) return row[b];
  const hit = Object.keys(row).find((k) => base(k) === b);
  return hit ? row[hit] : undefined;
}
/** Coerce a value to a finite number, defaulting to 0 (for SUM/AVG/MIN/MAX window frames). */
const num = (v: any) => { const n = typeof v === 'number' ? v : parseFloat(v); return Number.isFinite(n) ? n : 0; };

/**
 * Extract window specs from an AST `select` list (entries carrying a `window` field).
 * @param select the query's select list; non-array input yields no windows.
 * @returns the parsed {@link WindowSpec} list, in select order.
 */
export function extractWindows(select: any[] | undefined): WindowSpec[] {
  if (!Array.isArray(select)) return [];
  const out: WindowSpec[] = [];
  for (const c of select) {
    if (c && typeof c === 'object' && c.window) {
      out.push({
        fn: String(c.window).toUpperCase(),
        column: c.column ? base(c.column) : null,
        partitionBy: (c.partitionBy || []).map(base),
        orderBy: (c.orderBy || []).map((o: any) => ({ column: base(o.column), direction: o.direction === 'DESC' ? 'DESC' : 'ASC' })),
        alias: c.alias || `${String(c.window).toLowerCase()}`,
        ...(typeof c.offset === 'number' ? { offset: c.offset } : {}),
      });
    }
  }
  return out;
}

/**
 * Columns the base fetch must return so windows can be computed (plain select cols + all window-referenced cols).
 * Called before the base query runs (see `executeQuery`'s WINDOW branch in
 * query-engine.service.ts) so the fetch projects everything a window needs
 * (its own column plus every PARTITION BY/ORDER BY column) even if the final
 * projection wouldn't otherwise include them.
 * @param select the query's select list (plain columns and/or window specs).
 * @returns the de-duplicated column names to fetch, or `[]` to mean "fetch all
 *   columns" (when the select includes `*`).
 */
export function windowBaseColumns(select: any[]): string[] {
  const cols = new Set<string>();
  let star = false;
  for (const c of select) {
    if (c === '*') { star = true; continue; }
    if (typeof c === 'string') { cols.add(base(c)); continue; }
    if (c && typeof c === 'object' && c.window) {
      if (c.column) cols.add(base(c.column));
      for (const p of c.partitionBy || []) cols.add(base(p));
      for (const o of c.orderBy || []) cols.add(base(o.column));
    } else if (c && c.column) cols.add(base(c.column));
  }
  return star ? [] : [...cols]; // [] → fetch all columns
}

/**
 * Compute the grouping key for a row's window partition.
 * @param row the row to key.
 * @param cols the PARTITION BY columns.
 * @returns a stable string key (JSON of the column values) shared by rows in the same partition.
 */
function partitionKey(row: any, cols: string[]): string {
  return JSON.stringify(cols.map((c) => readCol(row, c) ?? null));
}
/**
 * Build a row comparator implementing a window's ORDER BY (multi-column, ASC/DESC).
 * @param orderBy ordered list of `{ column, direction }` sort keys.
 * @returns a comparator suitable for `Array.prototype.sort`.
 */
function comparator(orderBy: { column: string; direction: 'ASC' | 'DESC' }[]) {
  return (a: any, b: any) => {
    for (const o of orderBy) {
      const av = readCol(a, o.column), bv = readCol(b, o.column);
      if (av < bv) return o.direction === 'DESC' ? 1 : -1;
      if (av > bv) return o.direction === 'DESC' ? -1 : 1;
    }
    return 0;
  };
}

/**
 * Compute each window spec in-fabric and attach its alias to every row.
 * For each spec: (1) partitions rows by `partitionBy` into groups, (2) sorts
 * each partition per `orderBy`, then (3) computes the function over the
 * ordered partition — ranking functions (RANK/DENSE_RANK/ROW_NUMBER) track
 * ties via a changing order-key; navigation functions (LAG/LEAD) index
 * relative to the current row by `offset`; running aggregates (SUM/AVG/COUNT/
 * MIN/MAX) accumulate over an unbounded-preceding-to-current frame, matching
 * SQL's default framing when ORDER BY is present. Mutates and returns the same
 * row objects (multiple specs progressively add more alias fields).
 * @param rows the bounded base rows fetched via the normal pushdown path.
 * @param specs the window specs to compute (see {@link extractWindows}).
 * @returns the same `rows` array, each row annotated with every spec's alias.
 */
export function applyWindows(rows: any[], specs: WindowSpec[]): any[] {
  for (const spec of specs) {
    // 1. Partition
    const parts = new Map<string, any[]>();
    for (const r of rows) {
      const k = partitionKey(r, spec.partitionBy);
      (parts.get(k) || parts.set(k, []).get(k)!).push(r);
    }
    // 2. Per-partition: order, then compute the function
    for (const part of parts.values()) {
      if (spec.orderBy.length) part.sort(comparator(spec.orderBy));

      if (RANKING.has(spec.fn)) {
        let rank = 0, dense = 0, prevKey: string | null = null;
        part.forEach((r, i) => {
          const key = JSON.stringify(spec.orderBy.map((o) => readCol(r, o.column) ?? null));
          if (key !== prevKey) { dense++; rank = i + 1; prevKey = key; }
          r[spec.alias] = spec.fn === 'ROW_NUMBER' ? i + 1 : spec.fn === 'DENSE_RANK' ? dense : rank;
        });
      } else if (NAV.has(spec.fn)) {
        const off = spec.offset ?? 1;
        part.forEach((r, i) => {
          const j = spec.fn === 'LAG' ? i - off : i + off;
          r[spec.alias] = (j >= 0 && j < part.length) ? readCol(part[j], spec.column || '') ?? null : null;
        });
      } else if (RUNNING.has(spec.fn)) {
        // Running frame: unbounded preceding → current row (SQL default with ORDER BY).
        let sum = 0, cnt = 0, mn: number | null = null, mx: number | null = null;
        part.forEach((r) => {
          const v = spec.column ? num(readCol(r, spec.column)) : 1;
          const present = spec.column ? (readCol(r, spec.column) != null) : true;
          if (present) { sum += v; cnt++; mn = mn === null ? v : Math.min(mn, v); mx = mx === null ? v : Math.max(mx, v); }
          r[spec.alias] =
            spec.fn === 'SUM' ? sum :
            spec.fn === 'COUNT' ? cnt :
            spec.fn === 'AVG' ? (cnt ? sum / cnt : null) :
            spec.fn === 'MIN' ? mn : mx;
        });
      }
    }
  }
  return rows;
}

/**
 * True when the select carries any window spec.
 * @param select the query's select list.
 * @returns whether {@link extractWindows} would return a non-empty list.
 */
export function hasWindows(select: any[] | undefined): boolean {
  return extractWindows(select).length > 0;
}

/**
 * Project rows to the final select: plain columns + window aliases (drops helper cols).
 * Runs after {@link applyWindows} to trim the base-fetch columns (which may
 * include extra PARTITION BY/ORDER BY columns pulled in by
 * {@link windowBaseColumns} but not requested in the final output) down to
 * exactly what the caller asked for.
 * @param rows rows already annotated by {@link applyWindows}.
 * @param select the query's select list (plain columns and/or window specs); `*` passes rows through unchanged.
 * @returns new row objects containing only the requested columns/aliases.
 */
export function projectWithWindows(rows: any[], select: any[]): any[] {
  const cols: string[] = [];
  for (const c of select) {
    if (c === '*') return rows;
    if (typeof c === 'string') cols.push(base(c));
    else if (c && c.window) cols.push(c.alias);
    else if (c && c.column) cols.push(c.alias || base(c.column));
  }
  return rows.map((r) => { const o: any = {}; for (const c of cols) o[c] = readCol(r, c); return o; });
}
