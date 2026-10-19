/**
 * Same-source + cross-source foundational suite (~1035 queries): every core
 * concept over the base datasets — scans (all operators, ranges, IN, ILIKE),
 * projection, limit/offset, scalar + grouped aggregates (all funcs), HAVING,
 * DISTINCT, co-located self-join, set-ops, CTE (scan + agg), derived tables,
 * plus cross-source INNER/LEFT joins and cross-source set-ops. Each has a
 * computed oracle (see oracle.js).
 */
const O = require('./oracle');
const { SOURCES: S, remote, enrich, enrichMap, N, OPS, eqSet, eqSeq } = O;
const PG = S.PG, MONGO = S.MONGO;
const num = O.num;
const CASES = [];
const add = (cat, cross, query, check) => CASES.push({ cat, cross, query, check });

// 1) id filter scans, both orders
for (const op of Object.keys(OPS)) for (let k = 1; k <= 28; k++) for (const dir of ['ASC', 'DESC']) {
  const exp = remote.filter((r) => OPS[op](r.id, k)).map((r) => r.id).sort(num);
  if (dir === 'DESC') exp.reverse();
  add('scan/id', false, { from: { resource: 'remote_table', source: PG }, select: ['id'], where: [{ column: 'id', operator: op, value: k }], orderBy: [{ column: 'id', direction: dir }], limit: 100 }, (d) => eqSeq(d.map((r) => N(r.id)), exp));
}
// 2) value filter scans
for (const v of [100, 200]) for (const op of ['EQ', 'NE']) {
  const exp = remote.filter((r) => OPS[op](r.value, v)).map((r) => r.id).sort(num);
  add('scan/value', false, { from: { resource: 'remote_table', source: PG }, select: ['id', 'value'], where: [{ column: 'value', operator: op, value: v }], orderBy: [{ column: 'id', direction: 'ASC' }], limit: 100 }, (d) => eqSet(d.map((r) => N(r.id)), exp));
}
// 3) IN scans
for (let k = 1; k <= 20; k++) { const ids = Array.from({ length: k }, (_, i) => i + 1); add('scan/in', false, { from: { resource: 'remote_table', source: PG }, select: ['id'], where: [{ column: 'id', operator: 'IN', value: ids }], orderBy: [{ column: 'id', direction: 'ASC' }], limit: 100 }, (d) => eqSet(d.map((r) => N(r.id)), ids)); }
// 4) ILIKE
for (const [pat, keepOdd] of [['remote item 1', true], ['remote item 2', false]]) { const exp = remote.filter((r) => (r.id % 2 === 1) === keepOdd).map((r) => r.id); add('scan/ilike', false, { from: { resource: 'remote_table', source: PG }, select: ['id'], where: [{ column: 'name', operator: 'ILIKE', value: pat }], limit: 100 }, (d) => eqSet(d.map((r) => N(r.id)), exp)); }
// 5) limit/offset
for (let lim = 1; lim <= 12; lim++) for (let off = 0; off <= 5; off++) { const exp = remote.map((r) => r.id).slice(off, off + lim); add('limit/offset', false, { from: { resource: 'remote_table', source: PG }, select: ['id'], where: [{ column: 'id', operator: 'GT', value: 0 }], orderBy: [{ column: 'id', direction: 'ASC' }], limit: lim, offset: off }, (d) => eqSeq(d.map((r) => N(r.id)), exp)); }
// 6) scalar aggregates over id>k
for (let k = 0; k <= 28; k++) { const sub = remote.filter((r) => r.id > k); if (!sub.length) continue;
  for (const [fn, colm, ef] of [['COUNT', '*', () => sub.length], ['SUM', 'value', () => sub.reduce((a, r) => a + r.value, 0)], ['MIN', 'id', () => Math.min(...sub.map((r) => r.id))], ['MAX', 'id', () => Math.max(...sub.map((r) => r.id))], ['AVG', 'value', () => sub.reduce((a, r) => a + r.value, 0) / sub.length]]) {
    const exp = ef(); add('agg/scalar', false, { from: { resource: 'remote_table', source: PG }, select: [{ aggregate: fn, column: colm, alias: 'a' }], where: [{ column: 'id', operator: 'GT', value: k }] }, (d) => d.length === 1 && Math.abs(N(d[0].a) - exp) < 1e-6);
  } }
// 7) grouped aggregates by value
for (let k = 0; k <= 28; k++) { const sub = remote.filter((r) => r.id > k); const groups = [100, 200].map((v) => ({ v, rows: sub.filter((r) => r.value === v) })).filter((g) => g.rows.length);
  for (const [fn, agg] of [['COUNT', (rs) => rs.length], ['SUM', (rs) => rs.reduce((a, r) => a + r.id, 0)], ['MAX', (rs) => Math.max(...rs.map((r) => r.id))]]) {
    const colm = fn === 'COUNT' ? '*' : 'id'; const exp = groups.map((g) => [g.v, agg(g.rows)]).sort((a, b) => a[0] - b[0]);
    add('agg/group', false, { from: { resource: 'remote_table', source: PG }, select: ['value', { aggregate: fn, column: colm, alias: 'a' }], where: [{ column: 'id', operator: 'GT', value: k }], groupBy: ['value'], orderBy: [{ column: 'value', direction: 'ASC' }] }, (d) => eqSeq(d.map((r) => `${N(r.value)}:${N(r.a)}`), exp.map(([v, a]) => `${v}:${a}`)));
  } }
// 8) HAVING
for (const t of [0, 7, 13, 14, 15]) { const exp = [100, 200].filter((v) => remote.filter((r) => r.value === v).length > t).sort(num); add('agg/having', false, { from: { resource: 'remote_table', source: PG }, select: ['value', { aggregate: 'COUNT', column: '*', alias: 'n' }], groupBy: ['value'], having: [{ column: 'n', operator: 'GT', value: t }], orderBy: [{ column: 'value', direction: 'ASC' }] }, (d) => eqSeq(d.map((r) => N(r.value)), exp)); }
// 9) DISTINCT
add('distinct', false, { from: { resource: 'remote_table', source: PG }, select: ['value'], distinct: true, orderBy: [{ column: 'value', direction: 'ASC' }], limit: 10 }, (d) => eqSeq(d.map((r) => N(r.value)), [100, 200]));
// 10) co-located self-join + group
for (let k = 1; k <= 28; k++) { const sub = remote.filter((r) => r.id <= k); const exp = [100, 200].map((v) => [v, sub.filter((r) => r.value === v).length]).filter(([, n]) => n).sort((a, b) => a[0] - b[0]); add('selfjoin', false, { from: { resource: 'remote_table', source: PG, alias: 'a' }, joins: [{ type: 'INNER', resource: 'remote_table', source: PG, alias: 'b', on: { left: 'a.id', operator: 'EQ', right: 'b.id' } }], select: ['a.value', { aggregate: 'COUNT', column: '*', alias: 'n' }], where: [{ column: 'a.id', operator: 'LTE', value: k }], groupBy: ['a.value'], orderBy: [{ column: 'a.value', direction: 'ASC' }] }, (d) => eqSeq(d.map((r) => `${N(r.value)}:${N(r.n)}`), exp.map(([v, n]) => `${v}:${n}`))); }
// 11) set-ops same source
for (let s = 1; s <= 24; s++) { const A = remote.filter((r) => r.id <= s).map((r) => r.id), B = remote.filter((r) => r.id > s + 3).map((r) => r.id); const sets = { union: [...new Set([...A, ...B])], intersect: A.filter((x) => B.includes(x)), except: A.filter((x) => !B.includes(x)) };
  for (const key of ['union', 'intersect', 'except']) add(`setop/${key}`, false, { [key]: [{ from: { resource: 'remote_table', source: PG }, select: ['id'], where: [{ column: 'id', operator: 'LTE', value: s }] }, { from: { resource: 'remote_table', source: PG }, select: ['id'], where: [{ column: 'id', operator: 'GT', value: s + 3 }] }], orderBy: [{ column: 'id', direction: 'ASC' }], limit: 100 }, (d) => eqSet(d.map((r) => N(r.id)), sets[key])); }
// 12) CTE scan + agg
for (let k = 1; k <= 28; k++) { const sub = remote.filter((r) => r.id <= k);
  add('cte/scan', false, { with: [{ name: 'c', columns: ['id', 'value'], base: { from: { resource: 'remote_table', source: PG }, select: ['id', 'value'], where: [{ column: 'id', operator: 'LTE', value: k }] } }], from: { resource: 'c' }, select: ['id'], orderBy: [{ column: 'id', direction: 'ASC' }], limit: 100 }, (d) => eqSet(d.map((r) => N(r.id)), sub.map((r) => r.id)));
  add('cte/agg', false, { with: [{ name: 'c', columns: ['id', 'value'], base: { from: { resource: 'remote_table', source: PG }, select: ['id', 'value'], where: [{ column: 'id', operator: 'LTE', value: k }] } }], from: { resource: 'c' }, select: [{ aggregate: 'COUNT', column: '*', alias: 'n' }], limit: 10 }, (d) => N(d[0].n) === sub.length); }
// 13) derived table
for (let k = 1; k <= 28; k++) { const sub = remote.filter((r) => r.id <= k); add('derived', false, { from: { query: { from: { resource: 'remote_table', source: PG }, select: ['id', 'value'], where: [{ column: 'id', operator: 'LTE', value: k }] }, alias: 'sub' }, select: ['id'], orderBy: [{ column: 'id', direction: 'ASC' }], limit: 100 }, (d) => eqSet(d.map((r) => N(r.id)), sub.map((r) => r.id))); }
// 13b) compound range predicate
for (let lo = 1; lo <= 28; lo++) for (const dir of ['ASC', 'DESC']) { const hi = lo + 5; const exp = remote.filter((r) => r.id >= lo && r.id <= hi).map((r) => r.id).sort(num); if (dir === 'DESC') exp.reverse(); add('scan/range', false, { from: { resource: 'remote_table', source: PG }, select: ['id'], where: [{ column: 'id', operator: 'GTE', value: lo }, { column: 'id', operator: 'LTE', value: hi }], orderBy: [{ column: 'id', direction: dir }], limit: 100 }, (d) => eqSeq(d.map((r) => N(r.id)), exp)); }

// ===== CROSS-SOURCE (remote_table PG × enrich Mongo, sparse 2/4/6) =====
for (let k = 0; k <= 28; k++) { const exp = enrich.filter((e) => e.id > k).map((e) => e.id).sort(num); add('x/inner', true, { from: { resource: 'remote_table', source: PG, alias: 'a' }, joins: [{ type: 'INNER', resource: 'enrich', source: MONGO, alias: 'e', on: { left: 'a.id', operator: 'EQ', right: 'e.id' } }], select: ['a.id', 'e.grade'], where: [{ column: 'a.id', operator: 'GT', value: k }], limit: 100 }, (d) => eqSet(d.map((r) => N(r['a.id'])), exp) && d.every((r) => r['e.grade'] === enrichMap[N(r['a.id'])])); }
for (let k = 1; k <= 28; k++) { const sub = remote.filter((r) => r.id <= k); add('x/left', true, { from: { resource: 'remote_table', source: PG, alias: 'a' }, joins: [{ type: 'LEFT', resource: 'enrich', source: MONGO, alias: 'e', on: { left: 'a.id', operator: 'EQ', right: 'e.id' } }], select: ['a.id', 'e.grade'], where: [{ column: 'a.id', operator: 'LTE', value: k }], limit: 100 }, (d) => d.length === sub.length && d.every((r) => (r['e.grade'] ?? null) === (enrichMap[N(r['a.id'])] ?? null))); }
for (let k = 0; k <= 6; k++) { const exp = enrich.filter((e) => e.id > k).map((e) => e.grade).sort(); add('x/join-group', true, { from: { resource: 'remote_table', source: PG, alias: 'a' }, joins: [{ type: 'INNER', resource: 'enrich', source: MONGO, alias: 'e', on: { left: 'a.id', operator: 'EQ', right: 'e.id' } }], select: ['e.grade', { aggregate: 'COUNT', column: '*', alias: 'n' }], where: [{ column: 'a.id', operator: 'GT', value: k }], groupBy: ['e.grade'], orderBy: [{ column: 'e.grade', direction: 'ASC' }] }, (d) => eqSeq(d.map((r) => r.grade), exp) && d.every((r) => N(r.n) === 1)); }
add('x/join-sum', true, { from: { resource: 'remote_table', source: PG, alias: 'a' }, joins: [{ type: 'INNER', resource: 'enrich', source: MONGO, alias: 'e', on: { left: 'a.id', operator: 'EQ', right: 'e.id' } }], select: ['e.grade', { aggregate: 'SUM', column: 'a.value', alias: 's' }], where: [{ column: 'a.id', operator: 'GT', value: 0 }], groupBy: ['e.grade'], orderBy: [{ column: 'e.grade', direction: 'ASC' }] }, (d) => d.length === 3 && d.every((r) => N(r.s) === 200));
for (let k = 1; k <= 20; k++) { const A = remote.filter((r) => r.id <= k).map((r) => r.id), B = [2, 4, 6]; const sets = { union: [...new Set([...A, ...B])], intersect: A.filter((x) => B.includes(x)), except: A.filter((x) => !B.includes(x)) };
  for (const key of ['union', 'intersect', 'except']) add(`x/setop-${key}`, true, { [key]: [{ from: { resource: 'remote_table', source: PG }, select: ['id'], where: [{ column: 'id', operator: 'LTE', value: k }] }, { from: { resource: 'enrich', source: MONGO }, select: ['id'], where: [{ column: 'id', operator: 'GT', value: 0 }] }], limit: 100 }, (d) => eqSet(d.map((r) => N(r.id)), sets[key])); }
for (let lim = 1; lim <= 3; lim++) { const exp = [2, 4, 6].slice(0, lim); add('x/inner-limit', true, { from: { resource: 'remote_table', source: PG, alias: 'a' }, joins: [{ type: 'INNER', resource: 'enrich', source: MONGO, alias: 'e', on: { left: 'a.id', operator: 'EQ', right: 'e.id' } }], select: ['a.id', 'e.grade'], where: [{ column: 'a.id', operator: 'GT', value: 0 }], orderBy: [{ column: 'a.id', direction: 'ASC' }], limit: lim }, (d) => eqSeq(d.map((r) => N(r['a.id'])), exp)); }

module.exports = CASES;
if (require.main === module) { (async () => { const { results, strat } = await O.runCases(CASES); O.report('SAME-SOURCE + CROSS-SOURCE (foundational)', CASES, results, strat); })(); }
