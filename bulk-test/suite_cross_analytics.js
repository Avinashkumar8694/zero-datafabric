/**
 * Cross-datasource analytics suite: 1000+ generated queries that all span >1
 * physical engine (PG × Mongo × MySQL), covering every analytics concept —
 * joins (INNER/LEFT), multi-key group-by, all aggregates, HAVING, top-N,
 * order/offset/limit, DISTINCT, set-ops, 3-way joins, window functions, and the
 * guarded nested-cross-engine case. Each has a computed oracle (see oracle.js).
 */
const O = require('./oracle');
const { SOURCES: S, remote, dim, metrics, enrich, enrichMap, rd, rm, rdm, N, OPS, eqSet, eqSeq, read, groupAgg } = O;
const CASES = [];
const add = (cat, query, check, expectErr) => CASES.push({ cat, cross: true, query, check, expectErr });

const T = (res, src, alias) => ({ resource: res, source: src, alias });
const joinTo = (type, res, src, alias, left, right) => ({ type, resource: res, source: src, alias, on: { left, operator: 'EQ', right } });
// group-key checker: build grade→aggval map from fabric rows, compare to oracle
const checkGroup = (data, gkey, oracleRows, alias) => {
  const fab = new Map(data.map((r) => [String(read(r, gkey)), N(read(r, alias))]));
  if (fab.size !== oracleRows.length) return false;
  return oracleRows.every((o) => { const v = fab.get(String(o.key)); return v !== undefined && Math.abs(v - o[alias]) < 1e-6; });
};

// A) PG × Mongo(dim) INNER — id predicate, select id
for (const op of Object.keys(OPS)) for (let k = 1; k <= 28; k++) {
  const exp = rd.filter((r) => OPS[op](r.id, k)).map((r) => r.id);
  add('inner/pg-mongo',
    { from: T('remote_table', S.PG, 'r'), joins: [joinTo('INNER', 'dim', S.MONGO, 'd', 'r.id', 'd.id')], select: ['r.id', 'd.grade'], where: [{ column: 'r.id', operator: op, value: k }], limit: 100 },
    (d) => eqSet(d.map((x) => N(read(x, 'r.id'))), exp) && d.every((x) => read(x, 'd.grade') === dim[N(read(x, 'r.id')) - 1].grade));
}
// B) PG × MySQL(metrics) INNER — id predicate, verify category+score
for (const op of Object.keys(OPS)) for (let k = 1; k <= 28; k++) {
  const exp = rm.filter((r) => OPS[op](r.id, k)).map((r) => r.id);
  add('inner/pg-mysql',
    { from: T('remote_table', S.PG, 'r'), joins: [joinTo('INNER', 'metrics', S.MYSQL, 'm', 'r.id', 'm.id')], select: ['r.id', 'm.category', 'm.score'], where: [{ column: 'r.id', operator: op, value: k }], limit: 100 },
    (d) => eqSet(d.map((x) => N(read(x, 'r.id'))), exp) && d.every((x) => { const id = N(read(x, 'r.id')); return read(x, 'm.category') === metrics[id - 1].category && N(read(x, 'm.score')) === metrics[id - 1].score; }));
}
// C) PG LEFT JOIN Mongo(enrich, sparse 2/4/6) — unmatched rows kept
for (let k = 1; k <= 28; k++) {
  const kept = remote.filter((r) => r.id <= k);
  add('left/pg-mongo',
    { from: T('remote_table', S.PG, 'r'), joins: [joinTo('LEFT', 'enrich', S.MONGO, 'e', 'r.id', 'e.id')], select: ['r.id', 'e.grade'], where: [{ column: 'r.id', operator: 'LTE', value: k }], limit: 100 },
    (d) => d.length === kept.length && d.every((x) => (read(x, 'e.grade') ?? null) === (enrichMap[N(read(x, 'r.id'))] ?? null)));
}
// D) GROUP BY grade (rd) — every aggregate, filtered id>k
const AGGS_RD = [['COUNT', 'value', 'n'], ['SUM', 'value', 's'], ['SUM', 'qty', 's'], ['AVG', 'qty', 'a'], ['MIN', 'id', 'mn'], ['MAX', 'id', 'mx']];
const QCOL = { value: 'r.value', qty: 'd.qty', id: 'r.id', score: 'm.score' };
for (const [fn, col, alias] of AGGS_RD) for (let k = 0; k <= 28; k++) {
  const rows = rd.filter((r) => r.id > k); if (!rows.length) continue;
  const oracle = groupAgg(rows, 'grade', [{ fn, col, alias }]);
  add('group/grade',
    { from: T('remote_table', S.PG, 'r'), joins: [joinTo('INNER', 'dim', S.MONGO, 'd', 'r.id', 'd.id')], select: ['d.grade', { aggregate: fn, column: QCOL[col], alias }], where: [{ column: 'r.id', operator: 'GT', value: k }], groupBy: ['d.grade'], orderBy: [{ column: 'd.grade', direction: 'ASC' }] },
    (d) => checkGroup(d, 'd.grade', oracle, alias));
}
// E) GROUP BY region (rd)
for (const [fn, col, alias] of AGGS_RD) for (let k = 0; k <= 28; k++) {
  const rows = rd.filter((r) => r.id > k); if (!rows.length) continue;
  const oracle = groupAgg(rows, 'region', [{ fn, col, alias }]);
  add('group/region',
    { from: T('remote_table', S.PG, 'r'), joins: [joinTo('INNER', 'dim', S.MONGO, 'd', 'r.id', 'd.id')], select: ['d.region', { aggregate: fn, column: QCOL[col], alias }], where: [{ column: 'r.id', operator: 'GT', value: k }], groupBy: ['d.region'], orderBy: [{ column: 'd.region', direction: 'ASC' }] },
    (d) => checkGroup(d, 'd.region', oracle, alias));
}
// F) GROUP BY category (rm, MySQL)
for (const [fn, col, alias] of [['COUNT', 'score', 'n'], ['SUM', 'score', 's'], ['AVG', 'score', 'a'], ['MAX', 'id', 'mx']]) for (let k = 0; k <= 28; k++) {
  const rows = rm.filter((r) => r.id > k); if (!rows.length) continue;
  const oracle = groupAgg(rows, 'category', [{ fn, col, alias }]);
  add('group/category',
    { from: T('remote_table', S.PG, 'r'), joins: [joinTo('INNER', 'metrics', S.MYSQL, 'm', 'r.id', 'm.id')], select: ['m.category', { aggregate: fn, column: QCOL[col] || ('m.' + col), alias }], where: [{ column: 'r.id', operator: 'GT', value: k }], groupBy: ['m.category'], orderBy: [{ column: 'm.category', direction: 'ASC' }] },
    (d) => checkGroup(d, 'm.category', oracle, alias));
}
// G) HAVING on grade count
for (const t of [0, 5, 8, 9, 10]) for (const dir of ['ASC', 'DESC']) {
  const exp = groupAgg(rd, 'grade', [{ fn: 'COUNT', col: 'id', alias: 'n' }]).filter((g) => g.n > t).map((g) => g.key).sort();
  add('having',
    { from: T('remote_table', S.PG, 'r'), joins: [joinTo('INNER', 'dim', S.MONGO, 'd', 'r.id', 'd.id')], select: ['d.grade', { aggregate: 'COUNT', column: '*', alias: 'n' }], where: [{ column: 'r.id', operator: 'GT', value: 0 }], groupBy: ['d.grade'], having: [{ column: 'n', operator: 'GT', value: t }], orderBy: [{ column: 'd.grade', direction: dir }] },
    (d) => eqSet(d.map((x) => read(x, 'd.grade')).map((g) => GRADEIDX(g)), exp.map(GRADEIDX)));
}
function GRADEIDX(g) { return ['bronze', 'gold', 'silver'].indexOf(g); }
// H) top-N per group: order by COUNT desc, limit L
for (let L = 1; L <= 3; L++) {
  const counts = groupAgg(rd, 'grade', [{ fn: 'COUNT', col: 'id', alias: 'n' }]).map((g) => g.n).sort((a, b) => b - a).slice(0, L);
  add('topN',
    { from: T('remote_table', S.PG, 'r'), joins: [joinTo('INNER', 'dim', S.MONGO, 'd', 'r.id', 'd.id')], select: ['d.grade', { aggregate: 'COUNT', column: '*', alias: 'n' }], where: [{ column: 'r.id', operator: 'GT', value: 0 }], groupBy: ['d.grade'], orderBy: [{ column: 'n', direction: 'DESC' }], limit: L },
    (d) => eqSeq(d.map((x) => N(read(x, 'n'))), counts));
}
// I) group + order by group key + OFFSET + LIMIT
for (let off = 0; off <= 2; off++) for (let lim = 1; lim <= 3; lim++) {
  const keys = groupAgg(rd, 'grade', [{ fn: 'COUNT', col: 'id', alias: 'n' }]).map((g) => g.key).sort().slice(off, off + lim);
  add('group/paged',
    { from: T('remote_table', S.PG, 'r'), joins: [joinTo('INNER', 'dim', S.MONGO, 'd', 'r.id', 'd.id')], select: ['d.grade', { aggregate: 'COUNT', column: '*', alias: 'n' }], where: [{ column: 'r.id', operator: 'GT', value: 0 }], groupBy: ['d.grade'], orderBy: [{ column: 'd.grade', direction: 'ASC' }], limit: lim, offset: off },
    (d) => eqSeq(d.map((x) => read(x, 'd.grade')), keys));
}
// J) DISTINCT over join
for (const [col, uniq] of [['d.grade', ['bronze', 'gold', 'silver']], ['d.region', ['EAST', 'WEST']], ['m.category', ['A', 'B', 'C', 'D']]]) {
  const src = col.startsWith('m') ? ['metrics', S.MYSQL, 'm'] : ['dim', S.MONGO, 'd'];
  add('distinct',
    { from: T('remote_table', S.PG, 'r'), joins: [joinTo('INNER', src[0], src[1], src[2], 'r.id', src[2] + '.id')], select: [col], distinct: true, where: [{ column: 'r.id', operator: 'GT', value: 0 }], orderBy: [{ column: col, direction: 'ASC' }], limit: 20 },
    (d) => eqSeq(d.map((x) => read(x, col)).sort(), uniq));
}
// K) cross-source SET-OPS: remote(id<=k) OP enrich(all)  and  remote(id<=k) OP metrics(id>j)
for (let k = 1; k <= 20; k++) {
  const A = remote.filter((r) => r.id <= k).map((r) => r.id), B = [2, 4, 6];
  const sets = { union: [...new Set([...A, ...B])], intersect: A.filter((x) => B.includes(x)), except: A.filter((x) => !B.includes(x)) };
  for (const key of ['union', 'intersect', 'except']) {
    add(`setop/${key}`,
      { [key]: [{ from: T('remote_table', S.PG), select: ['id'], where: [{ column: 'id', operator: 'LTE', value: k }] }, { from: T('enrich', S.MONGO), select: ['id'], where: [{ column: 'id', operator: 'GT', value: 0 }] }], limit: 100 },
      (d) => eqSet(d.map((x) => N(x.id)), sets[key]));
  }
}
for (let k = 1; k <= 15; k++) {
  const A = remote.filter((r) => r.id <= k).map((r) => r.id), B = metrics.filter((m) => m.id > 20).map((m) => m.id);
  const sets = { union: [...new Set([...A, ...B])], intersect: A.filter((x) => B.includes(x)), except: A.filter((x) => !B.includes(x)) };
  for (const key of ['union', 'intersect', 'except']) {
    add(`setop-my/${key}`,
      { [key]: [{ from: T('remote_table', S.PG), select: ['id'], where: [{ column: 'id', operator: 'LTE', value: k }] }, { from: T('metrics', S.MYSQL), select: ['id'], where: [{ column: 'id', operator: 'GT', value: 20 }] }], limit: 100 },
      (d) => eqSet(d.map((x) => N(x.id)), sets[key]));
  }
}
// L) 3-WAY join PG × Mongo × MySQL — id predicate
for (let k = 0; k <= 28; k++) {
  const exp = rdm.filter((r) => r.id > k).map((r) => r.id);
  add('threeway',
    { from: T('remote_table', S.PG, 'r'), joins: [joinTo('INNER', 'dim', S.MONGO, 'd', 'r.id', 'd.id'), joinTo('INNER', 'metrics', S.MYSQL, 'm', 'r.id', 'm.id')], select: ['r.id', 'd.grade', 'm.category'], where: [{ column: 'r.id', operator: 'GT', value: k }], limit: 100 },
    (d) => eqSet(d.map((x) => N(read(x, 'r.id'))), exp) && d.every((x) => { const id = N(read(x, 'r.id')); return read(x, 'd.grade') === dim[id - 1].grade && read(x, 'm.category') === metrics[id - 1].category; }));
}
// M) 3-way join → GROUP BY grade → COUNT + SUM(score)
for (let k = 0; k <= 20; k++) {
  const rows = rdm.filter((r) => r.id > k); if (!rows.length) continue;
  const oracle = groupAgg(rows, 'grade', [{ fn: 'SUM', col: 'score', alias: 's' }]);
  add('threeway/group',
    { from: T('remote_table', S.PG, 'r'), joins: [joinTo('INNER', 'dim', S.MONGO, 'd', 'r.id', 'd.id'), joinTo('INNER', 'metrics', S.MYSQL, 'm', 'r.id', 'm.id')], select: ['d.grade', { aggregate: 'SUM', column: 'm.score', alias: 's' }], where: [{ column: 'r.id', operator: 'GT', value: k }], groupBy: ['d.grade'], orderBy: [{ column: 'd.grade', direction: 'ASC' }] },
    (d) => checkGroup(d, 'd.grade', oracle, 's'));
}
// N) WINDOW functions over a cross-source join (compensation path)
for (let k = 18; k <= 27; k++) {
  const rows = rd.filter((r) => r.id > k).sort((a, b) => a.qty - b.qty);
  add('window/rownum',
    { from: T('remote_table', S.PG, 'r'), joins: [joinTo('INNER', 'dim', S.MONGO, 'd', 'r.id', 'd.id')], select: ['r.id', { window: 'ROW_NUMBER', orderBy: [{ column: 'd.qty', direction: 'ASC' }], alias: 'rn' }], where: [{ column: 'r.id', operator: 'GT', value: k }], limit: 100 },
    (d) => d.length === rows.length && eqSeq(d.map((x) => N(read(x, 'rn'))).sort((a, b) => a - b), rows.map((_, i) => i + 1)));
}
// O) multi-aggregate in one query (COUNT + SUM(value) + AVG(qty)) grouped by grade
for (let k = 0; k <= 28; k++) {
  const rows = rd.filter((r) => r.id > k); if (!rows.length) continue;
  const oracle = groupAgg(rows, 'grade', [{ fn: 'COUNT', col: 'id', alias: 'n' }, { fn: 'SUM', col: 'value', alias: 's' }, { fn: 'AVG', col: 'qty', alias: 'a' }]);
  add('multi-agg',
    { from: T('remote_table', S.PG, 'r'), joins: [joinTo('INNER', 'dim', S.MONGO, 'd', 'r.id', 'd.id')], select: ['d.grade', { aggregate: 'COUNT', column: '*', alias: 'n' }, { aggregate: 'SUM', column: 'r.value', alias: 's' }, { aggregate: 'AVG', column: 'd.qty', alias: 'a' }], where: [{ column: 'r.id', operator: 'GT', value: k }], groupBy: ['d.grade'], orderBy: [{ column: 'd.grade', direction: 'ASC' }] },
    (d) => checkGroup(d, 'd.grade', oracle, 'n') && checkGroup(d, 'd.grade', oracle, 's') && checkGroup(d, 'd.grade', oracle, 'a'));
}
// P) multi-predicate cross (value=100 AND join) → group grade COUNT
for (let k = 0; k <= 20; k++) {
  const rows = rd.filter((r) => r.value === 100 && r.id > k); if (!rows.length) continue;
  const oracle = groupAgg(rows, 'grade', [{ fn: 'COUNT', col: 'id', alias: 'n' }]);
  add('multi-pred',
    { from: T('remote_table', S.PG, 'r'), joins: [joinTo('INNER', 'dim', S.MONGO, 'd', 'r.id', 'd.id')], select: ['d.grade', { aggregate: 'COUNT', column: '*', alias: 'n' }], where: [{ column: 'r.value', operator: 'EQ', value: 100 }, { column: 'r.id', operator: 'GT', value: k }], groupBy: ['d.grade'], orderBy: [{ column: 'd.grade', direction: 'ASC' }] },
    (d) => checkGroup(d, 'd.grade', oracle, 'n'));
}
// Q) nested cross-engine (CTE / derived) → must be a CLEAR guarded error
add('nested-x/cte',
  { with: [{ name: 'lo', columns: ['id'], base: { from: T('remote_table', S.PG), select: ['id'], where: [{ column: 'id', operator: 'LTE', value: 6 }] } }], from: { resource: 'lo', alias: 'l' }, joins: [joinTo('INNER', 'dim', S.MONGO, 'd', 'l.id', 'd.id')], select: ['l.id', 'd.grade'], limit: 10 },
  null, /spans multiple engines is not supported/);

module.exports = CASES;

if (require.main === module) {
  (async () => {
    const { results, strat } = await O.runCases(CASES);
    O.report('CROSS-DATASOURCE ANALYTICS', CASES, results, strat);
  })();
}
