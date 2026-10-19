/**
 * LEG ANALYSIS for the 20 real-world examples: for each query, assert the
 * EXPECTED execution strategy + leg shape, and print the ACTUAL query pushed to
 * each source — to confirm the fabric planned/executed it the right way
 * (predicate + projection + aggregate pushdown, correct join operator, no naked
 * full-table scans), not merely that the rows were correct.
 *
 * Run: cd backend && NODE_PATH=./node_modules node ../bulk-test/analyze_legs.js
 */
const O = require('./oracle');
const { EX } = require('./examples_ast_sql.js');

// Per-example expectation: strategy family + leg count + a leg predicate.
// legs entry: { source, engine, operation, query, params, rowsReturned, mode }
const hasPushdown = (q) => !!q && /\bWHERE\b|\bGROUP BY\b|\bJOIN\b|\bWITH\b| IN \(|DISTINCT|aggregate|aggs|\$group|"filter"|percentile|ROW_NUMBER|RANK|FETCH|LIMIT|SELECT (?!\* FROM)/i.test(q);
const CROSS_OPS = new Set(['broadcast-build', 'bind-join', 'bind-join-batch', 'join-driving', 'join-probe', 'union-leg', 'intersect-leg', 'except-leg', 'partial-aggregate']);

const EXPECT = {
  1: { strat: 'SINGLE_CONNECTOR', legs: 1, note: 'PG aggregate: GROUP BY + status filter pushed', chk: (L) => /GROUP BY/i.test(L[0].query) && /status/i.test(L[0].query) },
  2: { strat: 'SINGLE_CONNECTOR', legs: 1, note: 'PG scan: ORDER BY + LIMIT pushed', chk: (L) => /ORDER BY/i.test(L[0].query) && /LIMIT/i.test(L[0].query) },
  3: { strat: 'SINGLE_CONNECTOR+WINDOW', legs: 1, note: 'window computed in-fabric over pushed base rows', chk: (L) => true },
  4: { strat: 'SINGLE_CONNECTOR+WINDOW', legs: 1, note: 'RANK/PARTITION in-fabric; product filter pushed', chk: (L) => /product_id/i.test(L[0].query) },
  5: { strat: 'SINGLE_CONNECTOR', legs: 1, note: 'PERCENTILE pushed to Postgres', chk: (L) => /percentile/i.test(L[0].query) },
  6: { strat: 'SINGLE_CONNECTOR', legs: 1, note: 'co-located WITH (CTE) as one native SQL', chk: (L) => /WITH/i.test(L[0].query) && L[0].operation === 'colocated-pushdown' },
  7: { strat: 'CROSS_ENGINE', legs: 2, note: 'non-equi join → nested-loop (no bind)', chk: (L) => L.length === 2 },
  8: { strat: 'SINGLE_CONNECTOR', legs: 1, note: 'DISTINCT pushed (GROUP BY / DISTINCT)', chk: (L) => /DISTINCT|GROUP BY/i.test(L[0].query) && /status/i.test(L[0].query) },
  9: { strat: 'SINGLE_CONNECTOR', legs: 1, note: 'Mongo $group aggregate pushed', chk: (L) => L[0].engine === 'MONGODB' },
  10: { strat: 'SINGLE_CONNECTOR', legs: 1, note: 'MySQL GROUP BY + AVG pushed', chk: (L) => L[0].engine === 'MYSQL' && /GROUP BY/i.test(L[0].query) },
  11: { strat: 'CROSS_ENGINE', legs: 2, note: 'PG×MySQL; PG leg has status filter + projection', chk: (L) => L.some((l) => /status/i.test(l.query)) },
  12: { strat: 'CROSS_ENGINE', legs: 2, note: 'PG×Mongo; filter + projection pushed each leg', chk: (L) => L.some((l) => /status/i.test(l.query)) },
  13: { strat: 'CROSS_ENGINE', legs: 2, note: 'PG×Mongo AVG group in-fabric on joined rows', chk: (L) => L.length === 2 },
  14: { strat: 'CROSS_ENGINE', legs: 2, note: 'PG×Mongo RFM multi-aggregate', chk: (L) => L.some((l) => /status/i.test(l.query)) },
  15: { strat: 'CROSS_ENGINE', legs: 3, note: '3-way: driving + 2 bind-joins (IN keys)', chk: (L) => L.length === 3 && L.filter((l) => l.operation === 'bind-join').length >= 1 },
  16: { strat: 'CROSS_ENGINE', legs: 2, note: 'PG×Mongo HAVING in-fabric', chk: (L) => L.length === 2 },
  17: { strat: 'CROSS_ENGINE', legs: 2, note: 'PG×Mongo cohort group', chk: (L) => L.length === 2 },
  18: { strat: 'CROSS_ENGINE', legs: 2, note: 'cross-engine INTERSECT legs', chk: (L) => L.every((l) => l.operation === 'intersect-leg') },
  19: { strat: 'SINGLE_CONNECTOR', legs: 1, note: 'ES aggs pushed', chk: (L) => L[0].engine === 'ELASTICSEARCH' || L[0].engine === 'ES' },
  20: { strat: 'CROSS_ENGINE', legs: 2, note: 'PG×ES join (driving + bind)', chk: (L) => L.length === 2 && L.some((l) => (l.engine || '').startsWith('EL') || l.engine === 'ES') },
  21: { strat: 'SINGLE_CONNECTOR', legs: 1, note: 'co-located CTE + filter-on-aggregate as one native SQL', chk: (L) => L[0].operation === 'colocated-pushdown' && /WITH/i.test(L[0].query) },
  22: { strat: 'SINGLE_CONNECTOR', legs: 1, note: 'co-located CTE + COUNT(DISTINCT)', chk: (L) => L[0].operation === 'colocated-pushdown' && /DISTINCT/i.test(L[0].query) },
  23: { strat: 'SINGLE_CONNECTOR', legs: 1, note: 'co-located nested CTE chain (hv → m)', chk: (L) => L[0].operation === 'colocated-pushdown' && /WITH/i.test(L[0].query) },
};

(async () => {
  let ok = 0, bad = 0;
  for (const e of EX) {
    const res = await O.call(e.ast);
    const p = res.plan || {};
    const legs = p.legs || [];
    const ex = EXPECT[e.n] || {};
    const stratOK = !ex.strat || p.strategy === ex.strat;
    const legCntOK = ex.legs == null || legs.length === ex.legs;
    const noNakedScan = legs.every((l) => l.mode !== 'connector' || hasPushdown(l.query));
    const crossOpsOK = p.strategy !== 'CROSS_ENGINE' || legs.every((l) => CROSS_OPS.has(l.operation));
    const chkOK = !ex.chk || (() => { try { return ex.chk(legs); } catch { return false; } })();
    const verdict = stratOK && legCntOK && noNakedScan && crossOpsOK && chkOK;
    if (verdict) ok++; else bad++;

    console.log(`\n#${e.n} ${e.title}  [${e.engines}]`);
    console.log(`   strategy: ${p.strategy}  (expected ${ex.strat || '?'})  ${stratOK ? '✓' : '✗'}   legs: ${legs.length}${ex.legs != null ? '/' + ex.legs : ''} ${legCntOK ? '✓' : '✗'}`);
    console.log(`   expectation: ${ex.note || '-'}`);
    for (const l of legs) {
      const q = String(l.query || '').replace(/\s+/g, ' ').trim();
      console.log(`     • ${l.source} [${l.engine}] ${l.operation} rows=${l.rowsReturned}${l.params && l.params.length ? ' params=' + JSON.stringify(l.params).slice(0, 40) : ''}`);
      console.log(`         ${q.slice(0, 150)}`);
    }
    console.log(`   VERDICT: ${verdict ? 'LEGS OK ✓' : 'REVIEW ✗'}${!noNakedScan ? ' (naked scan!)' : ''}${!crossOpsOK ? ' (unexpected op)' : ''}${!chkOK ? ' (shape check failed)' : ''}`);
  }
  console.log(`\n================  LEG ANALYSIS: ${ok}/${EX.length} correct  ================`);
})();
