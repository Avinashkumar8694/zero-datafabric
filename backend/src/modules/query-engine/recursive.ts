/**
 * RecursiveExecutor — in-fabric iterative traversal for recursive queries over
 * ANY engine (Postgres, Mongo, Elasticsearch, remote warehouses).
 *
 * Postgres does `WITH RECURSIVE` natively, but a hierarchy whose rows live in
 * MongoDB or Elasticsearch cannot use it. The fabric compensates by walking the
 * hierarchy level by level, exactly the way `$graphLookup` or a hand-written BFS
 * would — but each level is a normal fabric query, so predicate pushdown AND the
 * Policy Engine apply automatically at every step:
 *
 *   1. Seed   — fetch the anchor rows (e.g. roots: `manager_id IS NULL`, or an
 *               explicit `startWith` filter).
 *   2. Expand — for the current frontier, collect the parent keys and fetch the
 *               next level with a single bind-join `child_key IN (…)` (pushed to
 *               the source — not a full scan), tagging each row with its depth.
 *   3. Repeat — until no new rows, or `maxDepth` is reached.
 *
 * A `seen` set on the node key guards against cycles and diamond re-visits, and
 * `maxDepth` + a total-row cap bound the work. The result is the transitive
 * closure with a `depth` (and optional materialised `path`).
 */

export interface RecursiveSpec {
  /** Logical source + resource holding the hierarchy (any engine). */
  source?: string;
  resource: string;
  /** Columns to project (must include the connect-by keys). */
  select?: string[];
  /** connect-by: child.<child> = parent.<parent>. */
  connectBy: { parent: string; child: string };
  /** Seed/anchor predicate (roots). Defaults to `<parent> IS_NULL`. */
  anchor?: { column: string; operator: string; value?: any }[];
  /** Optional explicit seed filter (overrides anchor when present). */
  startWith?: { column: string; operator: string; value?: any }[];
  /** direction: 'down' (default) walks children; 'up' walks ancestors. */
  direction?: 'down' | 'up';
  maxDepth?: number;
  /** cap on total rows returned across all levels. */
  maxRows?: number;
  /** materialise a breadcrumb path array of this column at each node. */
  pathColumn?: string;
}

export interface RecursiveResult {
  rows: any[];
  levels: number;
  trace: { depth: number; frontier: number; fetched: number; added: number; ms: number }[];
  truncatedByDepth: boolean;
  truncatedByRows: boolean;
}

/** A level fetch: run a single-source query with the given WHERE and return rows. */
export type LevelFetch = (where: { column: string; operator: string; value?: any }[]) => Promise<any[]>;

/**
 * In-fabric BFS-style traversal engine for recursive/hierarchical queries over
 * any engine. See the file-level overview for why this exists (no
 * `WITH RECURSIVE` equivalent on Mongo/ES) and the seed→expand→repeat algorithm.
 */
export class RecursiveExecutor {
  /**
   * Run a level-by-level traversal of a hierarchy (any engine) using the
   * supplied `fetch` callback for each level's query.
   *
   * Algorithm:
   *   1. **Seed** — fetch anchor/root rows using `spec.startWith` if given,
   *      else `spec.anchor`, else the default `<parent-column> IS_NULL`
   *      (depth 0). Rows are deduped by `connectBy.child` (the node identity)
   *      as they're added, guarding against a malformed hierarchy re-seeding
   *      the same node.
   *   2. **Expand** — for the current frontier, collect the distinct
   *      "frontier key" values (the column the NEXT level's rows will be
   *      matched against: `connectBy.child` walking down, `connectBy.parent`
   *      walking up) and issue ONE `fetch` call with `nextFilterCol IN (keys)`
   *      — a single bind-join per level, never a full scan. Each fetched row
   *      that hasn't been `seen` before (cycle/diamond guard) is tagged with
   *      its `depth` and (if `pathColumn` is set) a breadcrumb `path` built
   *      from its resolved parent's path.
   *   3. **Repeat** step 2 until a level yields no new frontier, `maxDepth` is
   *      reached (clamped to 1–100, default 25), or the total row cap
   *      (`maxRows`, clamped to 1–200000, default 50000) is hit.
   *
   * Because `fetch` is just "run a normal fabric query for this WHERE",
   * predicate pushdown and the Policy Engine apply automatically at every
   * level — this traversal never bypasses either.
   * @param spec the traversal spec: connect-by keys, direction, seed predicate, depth/row caps, optional path column.
   * @param fetch callback that runs a single-source query for a given WHERE and returns its rows.
   * @returns `{ rows, levels, trace, truncatedByDepth, truncatedByRows }` — the
   *   transitive closure (each row annotated with `depth` and optionally
   *   `path`), how many levels ran, a per-level timing/count trace, and
   *   whether depth or row caps cut the traversal short.
   */
  static async run(spec: RecursiveSpec, fetch: LevelFetch): Promise<RecursiveResult> {
    const maxDepth = Math.max(1, Math.min(Number(spec.maxDepth) || 25, 100));
    const maxRows = Math.max(1, Math.min(Number(spec.maxRows) || 50000, 200000));
    const down = (spec.direction || 'down') !== 'up';
    // Walking down: match children whose <child> key equals a parent's <parent>… no —
    // child.<parent-col> points AT the parent's <child-col>. Concretely for an org tree
    // (child.manager_id = parent.id): connectBy = { parent:'manager_id', child:'id' }.
    // Down: nextFilterCol = parent (manager_id), frontierKeyCol = child (id).
    // Up:   nextFilterCol = child (id),          frontierKeyCol = parent (manager_id).
    const nextFilterCol = down ? spec.connectBy.parent : spec.connectBy.child;
    const frontierKeyCol = down ? spec.connectBy.child : spec.connectBy.parent;

    const nodeKey = spec.connectBy.child; // identity of a node (for the cycle guard)
    const seen = new Set<any>();
    const out: any[] = [];
    const trace: RecursiveResult['trace'] = [];
    let truncatedByDepth = false;
    let truncatedByRows = false;

    const tag = (rows: any[], depth: number, parent?: any) =>
      rows.map((r) => {
        const path = spec.pathColumn
          ? [...((parent && parent.__path) || []), r[spec.pathColumn]]
          : undefined;
        return { ...r, __depth: depth, ...(path ? { __path: path } : {}) };
      });

    // ---- Level 0: seed / anchor ----
    const seedWhere = spec.startWith?.length
      ? spec.startWith
      : (spec.anchor?.length ? spec.anchor : [{ column: spec.connectBy.parent, operator: 'IS_NULL' }]);
    let t0 = 0; { const s = timer(); const seed = tag(await fetch(seedWhere), 0);
      for (const r of seed) { if (!seen.has(r[nodeKey])) { seen.add(r[nodeKey]); out.push(r); } }
      t0 = s(); trace.push({ depth: 0, frontier: 0, fetched: seed.length, added: seed.length, ms: t0 });
      var frontier = seed;
    }

    // ---- Levels 1..maxDepth: expand ----
    for (let depth = 1; depth <= maxDepth; depth++) {
      if (!frontier.length) break;
      if (depth === maxDepth) { /* one last level allowed, then flag if it fills */ }
      const keys = Array.from(new Set(frontier.map((r) => r[frontierKeyCol]).filter((v) => v !== null && v !== undefined)));
      if (!keys.length) break;
      const s = timer();
      const fetched = await fetch([{ column: nextFilterCol, operator: 'IN', value: keys }]);
      // Map fetched children under their parent so path/breadcrumbs chain correctly.
      const parentByKey = new Map(frontier.map((r) => [r[frontierKeyCol], r]));
      const next: any[] = [];
      for (const child of fetched) {
        const k = child[nodeKey];
        if (seen.has(k)) continue; // cycle / diamond guard
        seen.add(k);
        const parent = parentByKey.get(child[nextFilterCol]);
        const tagged = tag([child], depth, parent)[0];
        next.push(tagged);
        out.push(tagged);
        if (out.length >= maxRows) { truncatedByRows = true; break; }
      }
      trace.push({ depth, frontier: frontier.length, fetched: fetched.length, added: next.length, ms: s() });
      if (truncatedByRows) break;
      frontier = next;
      if (depth === maxDepth && next.length) truncatedByDepth = true;
    }

    // Normalise the internal fields to public `depth` / `path`.
    const rows = out.map((r) => {
      const { __depth, __path, ...rest } = r;
      const norm: any = { ...rest, depth: __depth };
      if (spec.pathColumn && __path) norm.path = __path;
      return norm;
    });

    return { rows, levels: trace.length, trace, truncatedByDepth, truncatedByRows };
  }
}

/**
 * Start a high-resolution stopwatch.
 * @returns a function that, when called, returns elapsed milliseconds since `timer()` was invoked.
 */
function timer(): () => number {
  const start = process.hrtime.bigint();
  return () => Number((process.hrtime.bigint() - start) / 1000000n);
}
