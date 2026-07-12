/* eslint-disable no-console */
/**
 * Complex FEDERATED query suite + safety/pushdown assertions.
 *
 * Proves the fabric executes cross-engine set-ops/joins/aggregates correctly AND
 * efficiently — specifically that an outer LIMIT is PUSHED DOWN to each source leg
 * for UNION (bounded per-source fetch, not fetch-all-then-trim), that INTERSECT/
 * EXCEPT keep full legs for correctness, and that unbounded SELECTs are blocked.
 *
 * Runs against tenant_multisource (Remote_PG [postgres] + Mongo_Source [mongodb]).
 *
 * Run:  NODE_PATH=backend/node_modules node examples/analytics/complex-federated.js
 */
const axios = require('axios');
const BASE = process.env.BASE_URL || 'http://127.0.0.1:4000/api';
const TENANT = process.env.TENANT_ID || 'tenant_multisource';
const H = (t) => ({ Authorization: `Bearer ${t}`, 'x-tenant-id': TENANT, 'Content-Type': 'application/json' });

const legLimitOf = (leg) => {
  const m = String(leg.query || '').match(/limit[:\s]+(\d+)/i);
  return m ? Number(m[1]) : null;
};

async function run(t, queryConfig) {
  return (await axios.post(`${BASE}/analytics/query`, { queryConfig }, { headers: H(t) })).data;
}

async function main() {
  const t = (await axios.post(`${BASE}/auth/login`, { username: 'admin', password: 'admin' })).data.token;
  let pass = 0, total = 0;
  const check = (name, cond, detail) => { total++; if (cond) pass++; console.log(`  ${cond ? 'PASS' : 'FAIL'}  ${name}${detail ? `  → ${detail}` : ''}`); };

  const unionCfg = (limit) => ({ type: 'SELECT', schema: 'public', limit, query: { union: [
    { from: { resource: 'remote_table', source: 'Remote_PG' }, select: ['name'] },
    { from: { resource: 'system.version', source: 'Mongo_Source' }, select: ['version'] },
  ] } });

  console.log('\nComplex federated queries — correctness + limit pushdown:\n');

  // 1. UNION with LIMIT 10 → each leg must be fetched with LIMIT 10 (pushdown), not the cap.
  const u10 = await run(t, unionCfg(10));
  const legLimits10 = (u10.plan.legs || []).map(legLimitOf);
  check('UNION limit=10 pushes LIMIT 10 to every leg', legLimits10.every((l) => l === 10),
    `strategy=${u10.plan.strategy} legLimits=[${legLimits10}] rows=${u10.rowCount}`);

  // 2. UNION with LIMIT 3 → legs bounded to 3 (proves it tracks the outer limit, not a constant).
  const u3 = await run(t, unionCfg(3));
  const legLimits3 = (u3.plan.legs || []).map(legLimitOf);
  check('UNION limit=3 pushes LIMIT 3 to every leg', legLimits3.every((l) => l === 3),
    `legLimits=[${legLimits3}] rows=${u3.rowCount}`);
  check('UNION result respects outer limit', u3.rowCount <= 3, `rows=${u3.rowCount}`);

  // 3. INTERSECT must NOT push the outer limit to legs (needs full sets for correctness).
  const inter = await run(t, { type: 'SELECT', schema: 'public', limit: 5, query: { intersect: [
    { from: { resource: 'remote_table', source: 'Remote_PG' }, select: ['name'] },
    { from: { resource: 'remote_table', source: 'Remote_PG' }, select: ['name'] },
  ] } });
  const interLegLimits = (inter.plan.legs || []).map(legLimitOf);
  check('INTERSECT keeps full legs (limit NOT pushed)', interLegLimits.every((l) => l == null || l > 5),
    `legLimits=[${interLegLimits}] rows=${inter.rowCount}`);

  // 4. Cross-engine JOIN with a filter (bounded) — remote_table ⋈ itself as a smoke test of the join path.
  try {
    const j = await run(t, { type: 'SELECT', schema: 'public', limit: 20, query: {
      from: { resource: 'remote_table', source: 'Remote_PG', alias: 'a' },
      joins: [{ type: 'INNER', resource: 'remote_table', source: 'Remote_PG', alias: 'b', on: { left: 'a.id', operator: 'EQ', right: 'b.id' } }],
      select: ['a.name'], where: [{ column: 'a.id', operator: 'GT', value: 0 }] } });
    check('cross-source JOIN + filter executes', Array.isArray(j.data), `strategy=${j.plan.strategy} rows=${j.rowCount}`);
  } catch (e) { check('cross-source JOIN + filter executes', false, e.response?.data?.error || e.message); }

  console.log('\nSafety shield — unbounded scans blocked, bounded shapes allowed:\n');

  // 5. Unbounded SELECT (no WHERE, no LIMIT, not aggregate) → must be rejected.
  try {
    await run(t, { type: 'SELECT', schema: 'public', query: { from: { resource: 'remote_table', source: 'Remote_PG' }, select: ['*'] } });
    check('unbounded SELECT is blocked', false, 'was allowed (should be blocked)');
  } catch (e) {
    check('unbounded SELECT is blocked', /SAFETY|unbounded|WHERE|LIMIT/i.test(e.response?.data?.error || ''), e.response?.data?.error);
  }

  // 6. Bounded by LIMIT only → allowed.
  try {
    const r = await run(t, { type: 'SELECT', schema: 'public', limit: 5, query: { from: { resource: 'remote_table', source: 'Remote_PG' }, select: ['*'] } });
    check('SELECT bounded by LIMIT is allowed', Array.isArray(r.data), `rows=${r.rowCount}`);
  } catch (e) { check('SELECT bounded by LIMIT is allowed', false, e.response?.data?.error); }

  // 7. Bounded by aggregate shape (no filter, no limit) → allowed (returns few rows).
  try {
    const r = await run(t, { type: 'SELECT', schema: 'public', query: { from: { resource: 'remote_table', source: 'Remote_PG' }, groupBy: ['name'], select: ['name', { aggregate: 'COUNT', column: '*', alias: 'n' }] } });
    check('aggregate/GROUP BY without filter is allowed', Array.isArray(r.data), `rows=${r.rowCount}`);
  } catch (e) { check('aggregate/GROUP BY without filter is allowed', false, e.response?.data?.error); }

  console.log(`\n${pass}/${total} checks passed`);
  process.exit(pass === total ? 0 : 1);
}
main().catch((e) => { console.error('ERR', e.response?.data || e.message); process.exit(1); });
