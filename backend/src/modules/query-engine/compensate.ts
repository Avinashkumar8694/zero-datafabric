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

function base(path: string): string {
  const s = String(path || '');
  return s.includes('.') ? s.split('.').pop()! : s;
}
/** read a column tolerating alias-qualified keys (o.amount ~ amount) */
function readCol(row: any, name: string): any {
  if (row == null) return undefined;
  if (name in row) return row[name];
  const b = base(name);
  if (b in row) return row[b];
  const hit = Object.keys(row).find((k) => base(k) === b);
  return hit ? row[hit] : undefined;
}
const num = (v: any) => { const n = typeof v === 'number' ? v : parseFloat(v); return Number.isFinite(n) ? n : 0; };

/** Extract window specs from an AST `select` list (entries carrying a `window` field). */
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

/** Columns the base fetch must return so windows can be computed (plain select cols + all window-referenced cols). */
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

function partitionKey(row: any, cols: string[]): string {
  return JSON.stringify(cols.map((c) => readCol(row, c) ?? null));
}
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
 * Mutates and returns the same row objects.
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

/** True when the select carries any window spec. */
export function hasWindows(select: any[] | undefined): boolean {
  return extractWindows(select).length > 0;
}

/** Project rows to the final select: plain columns + window aliases (drops helper cols). */
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
