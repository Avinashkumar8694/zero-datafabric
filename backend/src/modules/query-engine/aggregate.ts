/**
 * Aggregate decomposition for multi-source federation.
 * -----------------------------------------------------
 * Implements the "partial-aggregate split" that lets GROUP BY / aggregates run
 * across many sources WITHOUT fetching every row into the fabric:
 *
 *   - Each source computes a PARTIAL aggregate (GROUP BY g..., COUNT/SUM/MIN/MAX)
 *     and returns only #groups rows.
 *   - The fabric MERGES the partials into the final result.
 *
 * Decomposition rules:
 *   COUNT(*)/COUNT(c) -> partial COUNT -> final SUM(partial)
 *   SUM(c)            -> partial SUM   -> final SUM
 *   MIN/MAX(c)        -> partial MIN/MAX -> final MIN/MAX
 *   AVG(c)            -> partial SUM(c)+COUNT(c) -> final ΣSUM/ΣCOUNT
 *   COUNT(DISTINCT c) -> partial GROUP BY (g,c) distinct keys -> merge distinct set, count
 */

import { AggregateSpec, AggFunc, GroupBy } from './pushdown';

export interface AggregatePlan {
  groupCols: GroupBy[];
  aggregates: AggregateSpec[]; // as requested by the user
}

const AGG_FUNCS = new Set(['COUNT', 'SUM', 'MIN', 'MAX', 'AVG']);

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
 * Output column name for a group entry (date-bucket entries key by their field).
 * @param g a plain grouping column, or a `(field, dateInterval)` date bucket.
 * @returns the field name the group value is keyed under in a result row.
 */
function gName(g: GroupBy): string {
  return typeof g === 'object' && g ? g.field : (g as string);
}

/**
 * Parse an AST/QueryConfig `select` into grouping columns + aggregate specs.
 * Handles object specs `(aggregate, column, alias)` and string specs like
 * `count(*)`, `SUM(amount)`, `avg(price) as p`. Plain (non-aggregate) columns
 * found in an aggregate query are treated as implicit GROUP BY columns.
 * @param select the query's select list (object aggregate specs and/or plain/aggregate strings), if any.
 * @param groupBy explicit GROUP BY columns (plain fields or date buckets), if any.
 * @returns `null` when the select carries no aggregate AND no groupBy was given
 *   (i.e. this isn't an aggregate query); otherwise the parsed
 *   `(groupCols, aggregates)` plan with de-duplicated group columns.
 */
export function parseAggregates(select: any[] | undefined, groupBy: GroupBy[] | undefined): AggregatePlan | null {
  if (!Array.isArray(select) || select.length === 0) {
    return groupBy && groupBy.length ? { groupCols: [...groupBy], aggregates: [] } : null;
  }

  const groupCols: GroupBy[] = [...(groupBy || [])];
  const aggregates: AggregateSpec[] = [];
  let sawAggregate = false;

  for (const c of select) {
    if (c && typeof c === 'object' && c.aggregate) {
      sawAggregate = true;
      const func = String(c.aggregate).toUpperCase();
      const isDistinct = !!c.distinct || func === 'COUNT_DISTINCT';
      const col = c.column && c.column !== '*' ? base(c.column) : null;
      aggregates.push({
        func: (isDistinct ? 'COUNT_DISTINCT' : func) as AggFunc,
        column: col,
        alias: c.alias || `${func.toLowerCase()}_${col || 'all'}`,
        ...(c.percent !== undefined ? { percent: Number(c.percent) } : {}),
      });
      continue;
    }
    if (typeof c === 'string') {
      const m = c.match(/^\s*(count|sum|min|max|avg)\s*\(\s*(distinct\s+)?([\w.*]+)\s*\)\s*(?:as\s+([\w]+))?\s*$/i);
      if (m) {
        sawAggregate = true;
        const func = m[1]!.toUpperCase();
        const distinct = !!m[2];
        const colRaw = m[3]!;
        const col = colRaw === '*' ? null : base(colRaw);
        aggregates.push({
          func: (distinct ? 'COUNT_DISTINCT' : func) as AggFunc,
          column: col,
          alias: m[4] || `${func.toLowerCase()}_${col || 'all'}`,
        });
        continue;
      }
      // a plain column in an aggregate query is a grouping column
      if (c !== '*') groupCols.push(base(c));
    }
  }

  if (!sawAggregate && (!groupBy || groupBy.length === 0)) return null;
  // de-dup group columns preserving order (date-bucket entries keyed by JSON)
  const seen = new Set<string>();
  const dedupGroup = groupCols.filter((g) => {
    const k = typeof g === 'object' ? JSON.stringify(g) : g;
    return seen.has(k) ? false : (seen.add(k), true);
  });
  return { groupCols: dedupGroup, aggregates };
}

/**
 * The partial aggregates each source must compute so the fabric can merge them.
 * AVG is expanded to a hidden SUM + COUNT pair (the mean can't be summed
 * across sources directly — the running sum and count can, and are divided
 * back into a mean by (@link mergePartials)). Every other function's partial
 * form matches its final form (COUNT/SUM/MIN/MAX/COUNT_DISTINCT).
 * @param plan the user-requested aggregate plan (grouping columns + aggregates).
 * @returns the `(groupBy, aggregates)` spec to push down to each source.
 */
export function partialSpec(plan: AggregatePlan): { groupBy: GroupBy[]; aggregates: AggregateSpec[] } {
  const aggregates: AggregateSpec[] = [];
  for (const a of plan.aggregates) {
    if (a.func === 'AVG') {
      aggregates.push({ func: 'SUM', column: a.column, alias: `__sum__${a.alias}` });
      aggregates.push({ func: 'COUNT', column: a.column, alias: `__cnt__${a.alias}` });
    } else {
      aggregates.push({ ...a });
    }
  }
  return { groupBy: plan.groupCols, aggregates };
}

/**
 * Coerce a value to a finite number, defaulting to 0.
 * @param v the value to coerce (already a number, or something `parseFloat` can read).
 * @returns the numeric value, or `0` if it isn't finite/parseable.
 */
function numeric(v: any): number {
  const n = typeof v === 'number' ? v : parseFloat(v);
  return Number.isFinite(n) ? n : 0;
}

/**
 * Merge partial-group rows (already grouped per source) into the final result.
 * Re-groups the combined partials by their group-column values (a source's
 * groups may overlap another's, e.g. the same customer split across two
 * shards) and folds each source's partial values into a running accumulator:
 * COUNT/SUM sum, MIN/MAX min/max, AVG accumulates the hidden `__sum__`/`__cnt__`
 * pair and divides at the end. `distinctSets` accumulates COUNT(DISTINCT)
 * values as sets keyed by group+alias when a source returned the raw distinct
 * values (`__set__<alias>`); otherwise per-source distinct counts are summed
 * as an upper-bound approximation (exact cross-source distinct counting needs
 * the raw values).
 * @param rows partial-aggregate rows collected from every source (see (@link partialSpec)).
 * @param plan the user-requested aggregate plan (grouping columns + aggregates)
 *   used to determine merge semantics per aggregate function.
 * @returns one row per distinct group, with final aggregate values under their aliases.
 */
export function mergePartials(rows: any[], plan: AggregatePlan): any[] {
  const groups = new Map<string, any>();
  // For COUNT(DISTINCT), we need the raw values. When pushed as an aggregate the
  // source already returns a count (Mongo $addToSet size / SQL COUNT DISTINCT), so
  // per-source distinct counts are summed as an upper bound; exactness across
  // sources is handled by the raw-distinct path (see below).
  const distinctAliases = new Set(plan.aggregates.filter((a) => a.func === 'COUNT_DISTINCT').map((a) => a.alias));
  const distinctSets = new Map<string, Set<any>>();

  const keyOf = (row: any) => JSON.stringify(plan.groupCols.map((g) => row[gName(g)] ?? row[base(gName(g))] ?? null));

  for (const row of rows) {
    const k = keyOf(row);
    let acc = groups.get(k);
    if (!acc) {
      acc = {};
      for (const g of plan.groupCols) { const n = gName(g); acc[n] = row[n] ?? row[base(n)] ?? null; }
      groups.set(k, acc);
    }
    for (const a of plan.aggregates) {
      if (a.func === 'AVG') {
        acc[`__sum__${a.alias}`] = numeric(acc[`__sum__${a.alias}`]) + numeric(row[`__sum__${a.alias}`]);
        acc[`__cnt__${a.alias}`] = numeric(acc[`__cnt__${a.alias}`]) + numeric(row[`__cnt__${a.alias}`]);
      } else if (a.func === 'COUNT' || a.func === 'SUM' || a.func === 'COUNT_DISTINCT') {
        // COUNT/SUM merge by summation. COUNT_DISTINCT summed as an approximation
        // unless a raw distinct set is provided via row[`__set__${alias}`].
        if (a.func === 'COUNT_DISTINCT' && Array.isArray(row[`__set__${a.alias}`])) {
          if (!distinctSets.has(k + a.alias)) distinctSets.set(k + a.alias, new Set());
          for (const v of row[`__set__${a.alias}`]) distinctSets.get(k + a.alias)!.add(v);
        } else {
          acc[a.alias] = numeric(acc[a.alias]) + numeric(row[a.alias]);
        }
      } else if (a.func === 'MIN') {
        acc[a.alias] = acc[a.alias] === undefined ? row[a.alias] : Math.min(numeric(acc[a.alias]), numeric(row[a.alias]));
      } else if (a.func === 'MAX') {
        acc[a.alias] = acc[a.alias] === undefined ? row[a.alias] : Math.max(numeric(acc[a.alias]), numeric(row[a.alias]));
      }
    }
  }

  const out: any[] = [];
  for (const [k, acc] of groups) {
    for (const a of plan.aggregates) {
      if (a.func === 'AVG') {
        const s = numeric(acc[`__sum__${a.alias}`]);
        const c = numeric(acc[`__cnt__${a.alias}`]);
        acc[a.alias] = c > 0 ? s / c : null;
        delete acc[`__sum__${a.alias}`];
        delete acc[`__cnt__${a.alias}`];
      } else if (a.func === 'COUNT_DISTINCT' && distinctSets.has(k + a.alias)) {
        acc[a.alias] = distinctSets.get(k + a.alias)!.size;
      }
    }
    out.push(acc);
  }
  return out;
}

/**
 * Read a column from a row tolerating alias-qualified keys (o.amount ~ amount).
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

/**
 * Aggregate RAW rows directly (used after a cross-engine join, where rows are not
 * pre-aggregated, and after in-fabric recursive traversal). Computes final
 * COUNT/SUM/MIN/MAX/AVG/COUNT(DISTINCT) per group in a single pass, keeping a
 * running per-group state (sums/counts/min/max/distinct sets) rather than the
 * two-phase partial+merge approach (@link mergePartials) uses — appropriate
 * here because the rows are already local (post-join or post-traversal), so
 * there's no per-source partial to push down.
 * @param rows raw (unaggregated) rows to group and aggregate.
 * @param plan the user-requested aggregate plan (grouping columns + aggregates).
 * @returns one row per distinct group, with final aggregate values under their aliases.
 */
export function aggregateRaw(rows: any[], plan: AggregatePlan): any[] {
  const groups = new Map<string, any>();
  const state = new Map<string, any>(); // per-group running state (sums, counts, distinct sets)

  const keyOf = (row: any) => JSON.stringify(plan.groupCols.map((g) => readCol(row, gName(g)) ?? null));

  for (const row of rows) {
    const k = keyOf(row);
    let acc = groups.get(k);
    let st = state.get(k);
    if (!acc) {
      acc = {};
      for (const g of plan.groupCols) { const n = gName(g); acc[n] = readCol(row, n) ?? null; }
      groups.set(k, acc);
      st = {};
      state.set(k, st);
    }
    for (const a of plan.aggregates) {
      const v = a.column ? readCol(row, a.column) : 1;
      const key = a.alias;
      if (a.func === 'COUNT') { if (a.column == null || (v !== undefined && v !== null)) st[key] = (st[key] || 0) + 1; }
      else if (a.func === 'SUM') st[key] = (st[key] || 0) + numeric(v);
      else if (a.func === 'MIN') st[key] = st[key] === undefined ? numeric(v) : Math.min(st[key], numeric(v));
      else if (a.func === 'MAX') st[key] = st[key] === undefined ? numeric(v) : Math.max(st[key], numeric(v));
      else if (a.func === 'AVG') { st[`${key}__s`] = (st[`${key}__s`] || 0) + numeric(v); st[`${key}__c`] = (st[`${key}__c`] || 0) + 1; }
      else if (a.func === 'COUNT_DISTINCT') { (st[key] ||= new Set()).add(v); }
    }
  }

  const out: any[] = [];
  for (const [k, acc] of groups) {
    const st = state.get(k);
    for (const a of plan.aggregates) {
      if (a.func === 'AVG') { const c = st[`${a.alias}__c`] || 0; acc[a.alias] = c > 0 ? st[`${a.alias}__s`] / c : null; }
      else if (a.func === 'COUNT_DISTINCT') acc[a.alias] = (st[a.alias] as Set<any>)?.size || 0;
      else acc[a.alias] = st[a.alias] ?? (a.func === 'COUNT' ? 0 : null);
    }
    out.push(acc);
  }
  return out;
}

/**
 * True when a query requests grouping/aggregation.
 * @param select the query's select list.
 * @param groupBy explicit GROUP BY columns, if any.
 * @returns whether (@link parseAggregates) would produce a non-null plan.
 */
export function isAggregateQuery(select: any[] | undefined, groupBy: string[] | undefined): boolean {
  return parseAggregates(select, groupBy) !== null;
}

/** The aggregate function names recognized when parsing a select list. */
export { AGG_FUNCS };
